//! Unsafe-code metrics for every crate version, counted straight from the `.crate` tarballs.
//!
//! The counts are the ones `cargo-geiger` and the `count-unsafe` tool produce: each `.rs` file
//! is parsed with `syn` and visited by [`geiger`], which tallies functions, expressions,
//! `impl`s, traits, and methods as safe or unsafe (tests included). `count-unsafe` sums those
//! over a directory tree; this module sums them over the entries of a tarball instead, so a
//! crate is scanned without ever being unpacked to disk, and a hostile archive cannot place
//! files anywhere.
//!
//! Besides the counters, a scan records how much source was looked at (`rs_files`, `rs_lines`,
//! `rs_bytes`), how many files could not be counted (`rs_files_failed`: unparsable, not UTF-8,
//! or over [`ScanOptions::max_file_bytes`]), how many files carry `#![forbid(unsafe_code)]`
//! and whether the crate root does, and whether the crate has a build script. Everything is
//! stored on the `(Version)` node by [`count_unsafe`]; see [`db::Db::set_unsafe_batch`] for the
//! property names. Zero counts are stored too, so a crate with no `unsafe` can be told apart
//! from one that was never scanned.
use crate::crate_fs::CrateEntry;
use crate::db::Db;
use cargo_geiger_serde::CounterBlock;
use geiger::IncludeTests;
use rayon::prelude::*;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("IO Error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Database Error: {0}")]
    Db(#[from] crate::db::Error),
    #[error("no .crate file for {0} under the compressed root")]
    MissingTarball(String),
    #[error("scanner panicked: {0}")]
    Panic(String),
    #[error("could not build the scan thread pool: {0}")]
    Pool(#[from] rayon::ThreadPoolBuildError),
}

/// Name and version of the scanner whose counts are stored, written to `Version.unsafe_scanner`.
/// A later scanner version may count differently; keep in step with `geiger` in `Cargo.lock`.
pub const SCANNER: &str = "geiger 0.5.0";

/// Stack size of the scan threads: `syn` recurses per nesting level, and generated code nests
/// deeply.
const SCAN_STACK_BYTES: usize = 128 << 20;

/// Versions written to Neo4j per transaction.
const WRITE_BATCH: usize = 1_000;

/// Outcomes buffered between the scan threads and the database writer.
const CHANNEL_DEPTH: usize = 4_096;

/// What a scan of one crate version found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnsafeMetrics {
    /// geiger's counters summed over every parsed `.rs` file.
    pub counters: CounterBlock,
    /// `.rs` files that were parsed and counted.
    pub rs_files: u64,
    /// `.rs` files skipped: not valid UTF-8, not parsable by `syn`, or too large.
    pub rs_files_failed: u64,
    /// Lines in the parsed files.
    pub rs_lines: u64,
    /// Bytes in the parsed files.
    pub rs_bytes: u64,
    /// Parsed files that carry `#![forbid(unsafe_code)]`.
    pub rs_forbid_files: u64,
    /// Whether the crate root (`[lib] path`, else `src/lib.rs`, else `src/main.rs`) carries
    /// `#![forbid(unsafe_code)]`, which forbids unsafe code in the whole crate. `None` when no
    /// root file was parsed.
    pub forbids_unsafe: Option<bool>,
    /// The manifest names a build script (`package.build`), or `build.rs` exists.
    pub has_build_script: bool,
}

impl UnsafeMetrics {
    /// Every unsafe count summed, as stored in `unsafe_total`.
    #[must_use]
    pub fn total_unsafe(&self) -> u64 {
        let c = &self.counters;
        c.functions.unsafe_
            + c.exprs.unsafe_
            + c.item_impls.unsafe_
            + c.item_traits.unsafe_
            + c.methods.unsafe_
    }
}

/// The result for one crate version, ready to store.
#[derive(Debug, Clone)]
pub struct ScanOutcome {
    pub name: String,
    pub version: String,
    /// `Err` holds the reason the crate could not be scanned at all (no tarball, unreadable
    /// archive, panic); per-file problems are counted in `rs_files_failed` instead.
    pub result: Result<UnsafeMetrics, String>,
}

/// How [`count_unsafe`] selects and scans versions.
#[derive(Debug, Clone)]
pub struct ScanOptions {
    /// Scan threads. `None` uses a quarter of the CPUs (at least one), since the scan usually
    /// runs next to a compile sweep.
    pub jobs: Option<usize>,
    /// Only these crates (every selected version of them); empty means every crate.
    pub only: Vec<String>,
    /// Only versions flagged `latest`.
    pub latest_only: bool,
    /// Scan versions that already have results too. Without it, a run scans the versions never
    /// scanned plus those whose last scan failed (`unsafe_error`), so it resumes where it left off.
    pub rescan: bool,
    /// `.rs` files larger than this are not read; they count as failed.
    pub max_file_bytes: u64,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            jobs: None,
            only: Vec::new(),
            latest_only: false,
            rescan: false,
            max_file_bytes: 64 << 20,
        }
    }
}

/// Totals of one [`count_unsafe`] run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    /// Versions selected for scanning.
    pub selected: u64,
    /// Versions scanned and stored with metrics.
    pub scanned: u64,
    /// Versions stored with an `unsafe_error` instead.
    pub errors: u64,
    /// Scanned versions with any unsafe count above zero.
    pub with_unsafe: u64,
    /// `.rs` files parsed, over all scanned versions.
    pub rs_files: u64,
    /// `.rs` files that could not be counted.
    pub rs_files_failed: u64,
}

/// Count unsafe code in one `.rs` source: geiger's scan, tests included, exactly as
/// `count-unsafe` runs it.
///
/// # Errors
/// Returns the `syn` error if the source does not parse.
pub fn scan_source(src: &str) -> Result<geiger::RsFileMetrics, syn::Error> {
    geiger::find_unsafe_in_string(src, IncludeTests::Yes)
}

/// Manifest facts a scan needs: the build-script setting and the library root.
#[derive(Debug, Default, PartialEq, Eq)]
struct Manifest {
    /// `Some(true)`: `package.build` names a script; `Some(false)`: `build = false`; `None`:
    /// not stated (then `build.rs` decides).
    build: Option<bool>,
    /// `[lib] path`, relative to the crate root, if stated.
    lib_path: Option<String>,
}

fn parse_manifest(text: &str) -> Manifest {
    let Ok(value) = toml::from_str::<toml::Value>(text) else {
        return Manifest::default();
    };
    let build = match value.get("package").and_then(|p| p.get("build")) {
        Some(toml::Value::String(_)) => Some(true),
        Some(toml::Value::Boolean(b)) => Some(*b),
        _ => None,
    };
    let lib_path = value
        .get("lib")
        .and_then(|l| l.get("path"))
        .and_then(toml::Value::as_str)
        .map(str::to_string);
    Manifest { build, lib_path }
}

/// Count unsafe code in every `.rs` entry of a gzipped `.crate` tarball read from `gz`, without
/// writing anything to disk. Only regular files are read; a file larger than `max_file_bytes`
/// is not read at all. Paths are taken relative to the archive's single top-level directory
/// (`<name>-<version>/`).
///
/// # Errors
/// Returns `Error::Io` if the archive cannot be decompressed or walked. Problems inside single
/// files are counted in `rs_files_failed`, not returned.
pub fn scan_tarball<R: Read>(gz: R, max_file_bytes: u64) -> Result<UnsafeMetrics, Error> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(gz));
    let mut metrics = UnsafeMetrics::default();
    // `#![forbid(unsafe_code)]` per parsed file, keyed by root-relative path, to pick the crate
    // root's value once the manifest has been seen (entries come in any order).
    let mut forbids: HashMap<String, bool> = HashMap::new();
    let mut manifest = Manifest::default();
    let mut has_build_rs = false;

    for entry in archive.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let rel = {
            let path = entry.path()?;
            let mut components = path.components();
            components.next(); // the `<name>-<version>` directory
            components.as_path().to_string_lossy().into_owned()
        };
        if rel == "Cargo.toml" {
            let mut text = String::new();
            if entry.read_to_string(&mut text).is_ok() {
                manifest = parse_manifest(&text);
            }
            continue;
        }
        if rel == "build.rs" {
            has_build_rs = true;
        }
        // The same test `count-unsafe` applies while walking a directory (case-sensitive).
        if Path::new(&rel).extension().is_none_or(|e| e != "rs") {
            continue;
        }
        if entry.size() > max_file_bytes {
            metrics.rs_files_failed += 1;
            continue;
        }
        let mut bytes = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or(0));
        entry.read_to_end(&mut bytes)?;
        let Ok(src) = String::from_utf8(bytes) else {
            metrics.rs_files_failed += 1;
            continue;
        };
        match scan_source(&src) {
            Ok(file) => {
                metrics.counters += file.counters;
                metrics.rs_files += 1;
                metrics.rs_lines += src.lines().count() as u64;
                metrics.rs_bytes += src.len() as u64;
                if file.forbids_unsafe {
                    metrics.rs_forbid_files += 1;
                }
                forbids.insert(rel, file.forbids_unsafe);
            }
            Err(_) => metrics.rs_files_failed += 1,
        }
    }

    metrics.has_build_script = manifest.build.unwrap_or(has_build_rs);
    let lib_root = manifest
        .lib_path
        .unwrap_or_else(|| "src/lib.rs".to_string());
    metrics.forbids_unsafe = forbids
        .get(&lib_root)
        .or_else(|| forbids.get("src/main.rs"))
        .copied();
    Ok(metrics)
}

/// Scan one crate version from the compressed root (any of its [`CrateEntry::candidate_paths`]
/// layouts).
///
/// # Errors
/// `Error::MissingTarball` if no `.crate` file exists, otherwise what [`scan_tarball`] returns.
pub fn scan_crate(
    entry: &CrateEntry,
    crates_dir: &Path,
    max_file_bytes: u64,
) -> Result<UnsafeMetrics, Error> {
    let path = entry
        .candidate_paths(crates_dir)
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| Error::MissingTarball(entry.full_name()))?;
    scan_tarball(std::fs::File::open(path)?, max_file_bytes)
}

/// [`scan_crate`] as a storable outcome: errors and panics become the `Err` string.
fn scan_outcome(name: &str, version: &str, crates_dir: &Path, max_file_bytes: u64) -> ScanOutcome {
    let entry = CrateEntry::from_parts(name, version);
    let scanned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        scan_crate(&entry, crates_dir, max_file_bytes)
    }));
    let result = match scanned {
        Ok(Ok(metrics)) => Ok(metrics),
        Ok(Err(e)) => Err(e.to_string()),
        Err(payload) => {
            let msg = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(ToString::to_string))
                .unwrap_or_else(|| "unknown panic".to_string());
            Err(Error::Panic(msg).to_string())
        }
    };
    ScanOutcome {
        name: name.to_string(),
        version: version.to_string(),
        result,
    }
}

fn default_jobs() -> usize {
    std::thread::available_parallelism().map_or(1, |n| (n.get() / 4).max(1))
}

/// Scan the versions [`ScanOptions`] selects and store the results on their `(Version)` nodes.
///
/// The work list comes from the database (`Db::unsafe_work_list`), so only versions that
/// exist as nodes are scanned and a rerun resumes. Scanning runs on a dedicated thread pool
/// with [`SCAN_STACK_BYTES`] stacks; results stream to a writer that stores them
/// [`WRITE_BATCH`] versions per transaction. A database failure stops the run; everything
/// stored before it stays.
///
/// # Errors
/// Database and thread-pool errors. Per-crate problems are stored as `unsafe_error` instead.
///
/// # Panics
/// Panics if the scan pool itself panics outside a crate scan (those are caught per crate).
pub async fn count_unsafe(
    crates_dir: PathBuf,
    db: Arc<Db>,
    opts: ScanOptions,
) -> Result<Summary, Error> {
    let work = db
        .unsafe_work_list(&opts.only, opts.latest_only, opts.rescan)
        .await?;
    let mut summary = Summary {
        selected: work.len() as u64,
        ..Summary::default()
    };
    let jobs = opts.jobs.unwrap_or_else(default_jobs);
    log::info!(
        "count-unsafe: {} versions to scan on {jobs} threads ({SCANNER})",
        work.len()
    );

    let (tx, mut rx) = tokio::sync::mpsc::channel::<ScanOutcome>(CHANNEL_DEPTH);
    let max_file_bytes = opts.max_file_bytes;
    let scanner = tokio::task::spawn_blocking(move || -> Result<(), Error> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(jobs)
            .stack_size(SCAN_STACK_BYTES)
            .thread_name(|i| format!("unsafe-scan-{i}"))
            .build()?;
        pool.install(|| {
            // A closed channel means the writer gave up; stop scheduling scans.
            work.into_par_iter().try_for_each(|(name, version)| {
                tx.blocking_send(scan_outcome(&name, &version, &crates_dir, max_file_bytes))
                    .map_err(|_| ())
            })
        })
        .ok();
        Ok(())
    });

    let started = std::time::Instant::now();
    let mut batch = Vec::with_capacity(WRITE_BATCH);
    let mut done = 0u64;
    while let Some(outcome) = rx.recv().await {
        match &outcome.result {
            Ok(m) => {
                summary.scanned += 1;
                summary.rs_files += m.rs_files;
                summary.rs_files_failed += m.rs_files_failed;
                if m.total_unsafe() > 0 {
                    summary.with_unsafe += 1;
                }
            }
            Err(e) => {
                summary.errors += 1;
                log::debug!("{}-{}: {e}", outcome.name, outcome.version);
            }
        }
        batch.push(outcome);
        if batch.len() >= WRITE_BATCH {
            db.set_unsafe_batch(&batch).await?;
            done += batch.len() as u64;
            batch.clear();
            if done.is_multiple_of(10 * WRITE_BATCH as u64) {
                let per_min = f64::from(u32::try_from(done).unwrap_or(u32::MAX))
                    / started.elapsed().as_secs_f64().max(1.0)
                    * 60.0;
                log::info!(
                    "count-unsafe: {done} of {} versions stored ({per_min:.0}/min), {} with unsafe, {} unreadable",
                    summary.selected,
                    summary.with_unsafe,
                    summary.errors
                );
            }
        }
    }
    if !batch.is_empty() {
        db.set_unsafe_batch(&batch).await?;
    }
    scanner.await.expect("scan pool panicked")?;
    log::info!("count-unsafe: {summary:?}");
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a gzipped tarball of `<root>/<path>` entries in memory.
    fn tarball(root: &str, files: &[(&str, &[u8])], symlink: Option<(&str, &str)>) -> Vec<u8> {
        let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);
        for (path, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, format!("{root}/{path}"), *data)
                .unwrap();
        }
        if let Some((path, target)) = symlink {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_cksum();
            tar.append_link(&mut header, format!("{root}/{path}"), target)
                .unwrap();
        }
        let mut gz = tar.into_inner().unwrap();
        gz.flush().unwrap();
        gz.finish().unwrap()
    }

    const LIB: &str = "#![forbid(unsafe_code)]\npub fn add(a: u32, b: u32) -> u32 { a + b }\n\
                       pub struct S;\nimpl S { pub fn m(&self) -> u32 { add(1, 2) } }\n";
    const UNSAFE: &str = "pub unsafe fn raw(p: *const u8) -> u8 { *p }\n\
                          pub fn call() -> u8 { unsafe { raw(std::ptr::null()) } }\n\
                          pub struct T;\nunsafe impl Send for T {}\n";
    const MANIFEST: &str =
        "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nbuild = \"build.rs\"\n";

    #[test]
    fn scan_tarball_sums_geiger_over_rs_entries_and_counts_failures() {
        let big = "x".repeat(2_000);
        let files: &[(&str, &[u8])] = &[
            ("Cargo.toml", MANIFEST.as_bytes()),
            ("build.rs", b"fn main() {}\n"),
            ("src/lib.rs", LIB.as_bytes()),
            ("src/other.rs", UNSAFE.as_bytes()),
            ("src/bad.rs", b"fn (\n"),
            ("src/binary.rs", b"fn f() {}\n\xff\xfe"),
            ("src/huge.rs", big.as_bytes()),
            ("README.md", b"unsafe { not rust }"),
        ];
        let data = tarball("demo-0.1.0", files, Some(("src/link.rs", "other.rs")));
        let m = scan_tarball(&data[..], 1_000).unwrap();

        let expected = scan_source("fn main() {}\n").unwrap().counters
            + scan_source(LIB).unwrap().counters
            + scan_source(UNSAFE).unwrap().counters;
        assert_eq!(m.counters, expected);
        assert_eq!(m.rs_files, 3, "build.rs, lib.rs, other.rs");
        assert_eq!(m.rs_files_failed, 3, "bad.rs, binary.rs, huge.rs");
        assert_eq!(
            m.rs_lines,
            1 + LIB.lines().count() as u64 + UNSAFE.lines().count() as u64
        );
        assert_eq!(m.rs_bytes, (13 + LIB.len() + UNSAFE.len()) as u64);
        assert_eq!(m.rs_forbid_files, 1);
        assert_eq!(m.forbids_unsafe, Some(true), "src/lib.rs is the root");
        assert!(m.has_build_script);
        assert!(m.total_unsafe() > 0);
        assert_eq!(m.counters.functions.unsafe_, 1);
        assert_eq!(m.counters.item_impls.unsafe_, 1);
    }

    #[test]
    fn scan_tarball_follows_lib_path_and_build_setting() {
        let files: &[(&str, &[u8])] = &[
            (
                "Cargo.toml",
                b"[package]\nname = \"demo\"\nversion = \"0.1.0\"\nbuild = false\n\n[lib]\npath = \"src/root.rs\"\n",
            ),
            ("build.rs", b"fn main() {}\n"),
            ("src/root.rs", b"pub fn f() {}\n"),
            ("src/lib.rs", LIB.as_bytes()),
        ];
        let m = scan_tarball(&tarball("demo-0.1.0", files, None)[..], 1 << 20).unwrap();
        assert_eq!(
            m.forbids_unsafe,
            Some(false),
            "[lib] path wins over src/lib.rs"
        );
        assert!(
            !m.has_build_script,
            "build = false even though build.rs exists"
        );

        let files: &[(&str, &[u8])] = &[
            (
                "Cargo.toml",
                b"[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
            ),
            ("build.rs", b"fn main() {}\n"),
            ("src/main.rs", b"#![forbid(unsafe_code)]\nfn main() {}\n"),
        ];
        let m = scan_tarball(&tarball("demo-0.1.0", files, None)[..], 1 << 20).unwrap();
        assert_eq!(
            m.forbids_unsafe,
            Some(true),
            "src/main.rs when there is no lib"
        );
        assert!(m.has_build_script, "build.rs present and build not stated");

        let files: &[(&str, &[u8])] = &[("tests/t.rs", b"fn t() {}\n")];
        let m = scan_tarball(&tarball("demo-0.1.0", files, None)[..], 1 << 20).unwrap();
        assert_eq!(m.forbids_unsafe, None, "no root file parsed");
        assert!(!m.has_build_script);
        assert_eq!(m.rs_files, 1);
    }

    #[test]
    fn scan_tarball_rejects_garbage() {
        assert!(matches!(
            scan_tarball(&b"not a tarball"[..], 1 << 20),
            Err(Error::Io(_))
        ));
    }

    #[test]
    fn scan_crate_finds_sharded_tarballs_and_reports_missing_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let crates = tmp.path().join("crates");
        let entry = CrateEntry::from_parts("demo", "0.1.0");
        let sharded = &entry.candidate_paths(&crates)[0];
        std::fs::create_dir_all(sharded.parent().unwrap()).unwrap();
        let files: &[(&str, &[u8])] = &[("src/lib.rs", UNSAFE.as_bytes())];
        std::fs::write(sharded, tarball("demo-0.1.0", files, None)).unwrap();

        let m = scan_crate(&entry, &crates, 1 << 20).unwrap();
        assert_eq!(m.rs_files, 1);
        assert_eq!(m.counters.functions.unsafe_, 1);

        let missing = CrateEntry::from_parts("nope", "1.0.0");
        assert!(matches!(
            scan_crate(&missing, &crates, 1 << 20),
            Err(Error::MissingTarball(_))
        ));
        let outcome = scan_outcome("nope", "1.0.0", &crates, 1 << 20);
        assert!(outcome.result.unwrap_err().contains("nope-1.0.0"));
    }

    #[test]
    fn parse_manifest_reads_build_and_lib_path() {
        assert_eq!(parse_manifest("garbage ["), Manifest::default());
        let m = parse_manifest("[package]\nbuild = \"b.rs\"\n[lib]\npath = \"x.rs\"\n");
        assert_eq!(
            m,
            Manifest {
                build: Some(true),
                lib_path: Some("x.rs".into())
            }
        );
    }
}
