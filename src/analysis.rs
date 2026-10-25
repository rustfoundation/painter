use crate::{Error, Roots, db::Db};
use llvm_ir_analysis::{ModuleAnalysis, llvm_ir::Module};
use rayon::prelude::*;
use rustc_demangle::demangle;

use crates_index::Crate;
use std::{io::Write, path::Path, sync::Arc};

/// Callee crates that are never recorded as invocations: the standard library family and
/// compiler/runtime intrinsics.
const BLOCKED_CRATES: &[&str] = &["core", "std", "alloc"];

/// Determine the crate a demangled Rust symbol belongs to: the first identifier that is
/// immediately followed by `::`. Handles trait-impl paths such as
/// `<serde::de::X as core::fmt::Display>::fmt` (gives `serde`) and
/// `<&T as serde::Serialize>::serialize` (gives `serde`). Returns `None` for symbols without a
/// path (e.g. `__rust_alloc`, `llvm.memcpy.p0.i64`).
#[must_use]
pub fn crate_of(demangled: &str) -> Option<&str> {
    let bytes = demangled.as_bytes();
    let mut start = None;
    for (i, &b) in bytes.iter().enumerate() {
        let is_ident = b.is_ascii_alphanumeric() || b == b'_';
        match (start, is_ident) {
            (None, true) => start = Some(i),
            (Some(st), false) => {
                if bytes[i..].starts_with(b"::") {
                    return Some(&demangled[st..i]);
                }
                start = None;
            }
            _ => {}
        }
    }
    None
}

/// Whether a demangled callee should be recorded as a cross-crate invocation.
#[must_use]
pub fn callee_crate(demangled: &str) -> Option<&str> {
    if demangled.starts_with("llvm.") || demangled.starts_with("__rust") {
        return None;
    }
    let c = crate_of(demangled)?;
    if BLOCKED_CRATES.contains(&c) {
        None
    } else {
        Some(c)
    }
}

/// Bitcode modules [`export_crate_db`] parses at once. Parsing is CPU and memory heavy (a large
/// crate's module takes gigabytes) and runs off the async runtime: parsed inline it stalled
/// every other export in the same `join_all`, and Neo4j drops a connection that does not
/// finish authenticating within 30 s.
static PARSE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Above this many `_` in a path segment, [`crate_name_candidates`] stops enumerating every
/// `-`/`_` spelling and only tries all-`_` and all-`-`.
const MAX_SEPARATOR_VARIANTS: usize = 6;

/// Crate names that a crate's path segment in a demangled symbol (`ident`) can stand for.
/// Rust writes the crate `foo-bar` as `foo_bar`, and crates.io treats `-` and `_` as the same
/// in names, so every `_` may be either. `ident` itself comes first.
#[must_use]
pub fn crate_name_candidates(ident: &str) -> Vec<String> {
    let seps: Vec<usize> = ident.match_indices('_').map(|(i, _)| i).collect();
    if seps.is_empty() {
        return vec![ident.to_string()];
    }
    if seps.len() > MAX_SEPARATOR_VARIANTS {
        return vec![ident.to_string(), ident.replace('_', "-")];
    }
    (0..1u32 << seps.len())
        .map(|mask| {
            ident
                .char_indices()
                .map(|(at, c)| match seps.iter().position(|&s| s == at) {
                    Some(bit) if mask & (1 << bit) != 0 => '-',
                    _ => c,
                })
                .collect()
        })
        .collect()
}

/// The first of `ident`'s [`crate_name_candidates`] that is in `existing`.
#[must_use]
pub fn resolve_crate_name<S: std::hash::BuildHasher>(
    ident: &str,
    existing: &std::collections::HashSet<String, S>,
) -> Option<String> {
    crate_name_candidates(ident)
        .into_iter()
        .find(|c| existing.contains(c))
}

/// Extract all function calls/invocations within a bytecode file. Returns a `Vec<(String,String)>`
/// of (caller, callee) demangled function names.
///
/// # Panics
/// This function will panic if iterating the `Roots::bytecode_root` fails.
///
/// This function will panic if an LLVM parsing error occurs while parsing the bytecode.
/// # Errors
/// TODO: Failure cases currently panic and should be moved to errors.
#[allow(clippy::unnecessary_wraps)]
pub fn extract_calls<P: AsRef<Path>>(crate_bc_dir: P) -> Result<Vec<(String, String)>, Error> {
    let mut calls = Vec::<(String, String)>::new();

    for bc_entry in std::fs::read_dir(crate_bc_dir.as_ref())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some() && e.path().extension().unwrap() == "bc")
    {
        let bc_path = bc_entry.path();

        let module = Module::from_bc_path(&bc_path)
            .map_err(Error::LLVMError)
            .unwrap();
        let analysis = ModuleAnalysis::new(&module);

        let graph = analysis.call_graph();
        graph
            .inner()
            .all_edges()
            .for_each(|(src_raw, dst_raw, ())| {
                let src = format!("{:#}", demangle(src_raw));
                let dst = format!("{:#}", demangle(dst_raw));

                if callee_crate(&dst).is_some() {
                    calls.push((src, dst));
                }
            });
    }

    Ok(calls)
}

/// Extracts all calls within a  single crates bytecode. Then, perform database insertions of each
/// call into the database.
///
/// # Panics
/// This function panics if extracting the filename of a crates full name from its path fails,
/// or if parsing the bitcode panics.
///
/// # Errors
/// Returns `painter::analysis::Error` on failure of database insertion.
#[allow(clippy::needless_pass_by_value)]
pub async fn export_crate_db<P: AsRef<Path>>(crate_bc_dir: P, db: Arc<Db>) -> Result<(), Error> {
    let calls = {
        let _slot = PARSE_SLOTS
            .acquire()
            .await
            .expect("semaphore is never closed");
        let dir = crate_bc_dir.as_ref().to_path_buf();
        tokio::task::spawn_blocking(move || extract_calls(dir))
            .await
            .expect("bitcode parsing panicked")?
    };
    let crate_fullname = crate_bc_dir.as_ref().file_name().unwrap().to_str().unwrap();

    let (crate_name, crate_version) = crate::crate_fs::split_full_name(crate_fullname)
        .ok_or_else(|| Error::CrateNameError(crate_fullname.to_string()))?;

    // A re-import replaces the version's whole call graph: `insert_calls` deletes the existing
    // `(:Fn)` nodes and creates the new ones.
    if db.has_call_graph(crate_name, crate_version).await? {
        log::info!("{crate_fullname}: replacing existing call graph");
    }

    log::trace!("Importing: {crate_name}");

    // `extract_calls` only keeps callees with a recordable crate.
    let rows: Vec<(String, String, String)> = calls
        .into_iter()
        .filter_map(|(caller, callee)| {
            let dst = callee_crate(&callee)?.to_string();
            Some((caller, callee, dst))
        })
        .collect();

    // Map each callee crate as written in Rust paths (`num_traits`) to its `(Crate)` node's
    // name (`num-traits`). Calls into names that match no crate are dropped below.
    let idents: std::collections::BTreeSet<&str> = rows.iter().map(|r| r.2.as_str()).collect();
    let candidates: Vec<String> = idents
        .iter()
        .flat_map(|i| crate_name_candidates(i))
        .collect();
    let existing = db.existing_crate_names(&candidates).await?;
    let resolved: std::collections::HashMap<String, String> = idents
        .iter()
        .filter_map(|i| Some((i.to_string(), resolve_crate_name(i, &existing)?)))
        .collect();
    let raw = rows.len();
    let calls =
        crate::db::collapse_calls(rows.into_iter().filter_map(|(caller, callee, ident)| {
            Some((caller, callee, resolved.get(&ident)?.clone()))
        }));

    db.insert_calls((crate_name, crate_version), &calls).await?;
    log::debug!("{crate_fullname}: {} distinct calls", calls.len());
    // The batch import driver (`docker/entry.sh`) matches this exact line.
    log::info!("{crate_fullname}: imported {raw} invocations");

    Ok(())
}

/// Iterate across all crates in the bytecode root, and call `export_crate_db`
///
/// # Panics
/// This function panics if there are permissions issues reading the bytecode root directory.
/// # Errors
/// Returns `painter::analysis::Error` on failure.
pub async fn export_all_db<P: AsRef<Path>>(bc_root: P, db: Arc<Db>) -> Result<(), Error> {
    let dirs: Vec<_> = std::fs::read_dir(&bc_root)
        .unwrap()
        .filter_map(Result::ok)
        // Dot-dirs are not crate versions (e.g. compile's staging dir).
        .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.'))
        .collect();

    let mut failures = 0usize;
    for chunk in crate::chunked(dirs.iter(), 16) {
        let tasks: Vec<_> = chunk
            .iter()
            .map(|c| export_crate_db(c.path(), db.clone()))
            .collect();

        for (dir, result) in chunk.iter().zip(futures::future::join_all(tasks).await) {
            if let Err(e) = result {
                failures += 1;
                log::error!("{}: export failed: {}", dir.path().display(), e);
            }
        }
    }

    if failures > 0 {
        log::error!("{failures} crate version(s) failed to export");
    }

    Ok(())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CountUnsafeEntry {
    pub safe: u32,
    pub unsafe_: u32,
}
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CountUnsafeResult {
    pub functions: CountUnsafeEntry,
    pub exprs: CountUnsafeEntry,
    pub item_impls: CountUnsafeEntry,
    pub item_traits: CountUnsafeEntry,
    pub methods: CountUnsafeEntry,
}
impl CountUnsafeResult {
    #[must_use]
    pub fn has_unsafe(&self) -> bool {
        self.functions.unsafe_ > 0
            || self.exprs.unsafe_ > 0
            || self.item_impls.unsafe_ > 0
            || self.item_traits.unsafe_ > 0
            || self.methods.unsafe_ > 0
    }

    #[must_use]
    pub fn total_unsafe(&self) -> u32 {
        self.functions.unsafe_
            + self.exprs.unsafe_
            + self.item_impls.unsafe_
            + self.item_traits.unsafe_
            + self.methods.unsafe_
    }
}

/// Extract every version of `c` from the compressed root into the sources root, run
/// `count-unsafe` over it, and store the totals on the `Version` node.
///
/// # Panics
/// Panics if a `.crate` file cannot be opened, `count-unsafe` cannot be spawned, or its output
/// is not the expected JSON.
///
/// # Errors
/// Currently infallible; database failures are logged per version.
pub async fn count_unsafe_crate_extract(c: Crate, roots: Roots, db: Arc<Db>) -> Result<(), Error> {
    let compressed_root = &roots.compressed_root;
    let sources_root = &roots.sources_root;

    for v in c.versions() {
        let crate_fullname = format!("{}-{}", v.name(), v.version());
        let crate_path = compressed_root.join(format!("{crate_fullname}.crate"));

        // Lets work off the tgz for now, since we cant extract
        // TODO: this needs to be unified to a file driver
        if std::fs::metadata(&crate_path).is_ok() {
            let extracted_path = sources_root.join(&crate_fullname);
            let tar_gz = std::fs::File::open(&crate_path).unwrap();
            let tar = flate2::read::GzDecoder::new(tar_gz);
            let mut archive = tar::Archive::new(tar);
            if archive.unpack(sources_root).is_ok() {
                log::trace!("Extracted {crate_fullname}");

                // Run our count
                let output = std::process::Command::new("count-unsafe")
                    .args([&extracted_path])
                    .output()
                    .unwrap();
                if output.status.success() {
                    let raw_json = std::str::from_utf8(&output.stdout).unwrap();
                    log::trace!("{raw_json}");

                    let unsafe_result: CountUnsafeResult = serde_json::from_str(raw_json).unwrap();
                    if unsafe_result.has_unsafe() {
                        log::debug!("{crate_fullname} unsafe");
                        if let Err(e) = db.set_unsafe(v.name(), v.version(), &unsafe_result).await {
                            log::error!("set_unsafe failed for {crate_fullname}: {e}");
                        }
                    }

                    // Finally delete
                    //std::fs::remove_dir_all(extracted_path).unwrap();
                    log::trace!("Deleted {crate_fullname}");
                }
            }
        }
    }
    Ok(())
}
/// Run `count-unsafe` over every already-extracted version of `c` in the sources root and store
/// the totals on the `Version` node. Versions without an extracted directory are skipped.
///
/// # Panics
/// Panics if `count-unsafe` cannot be spawned or its output is not the expected JSON.
///
/// # Errors
/// Currently infallible; database failures are logged per version.
pub async fn count_unsafe_crate(c: Crate, roots: Roots, db: Arc<Db>) -> Result<(), Error> {
    let sources_root = &roots.sources_root;

    for v in c.versions() {
        let crate_fullname = format!("{}-{}", v.name(), v.version());
        let crate_path = sources_root.join(&crate_fullname);

        // Lets work off the tgz for now, since we cant extract
        // TODO: this needs to be unified to a file driver
        if std::fs::metadata(&crate_path).is_ok() {
            // Run our count
            let output = std::process::Command::new("count-unsafe")
                .args([&crate_path])
                .output()
                .unwrap();
            if output.status.success() {
                let raw_json = std::str::from_utf8(&output.stdout).unwrap();
                log::trace!("{raw_json}");

                let unsafe_result: CountUnsafeResult = serde_json::from_str(raw_json).unwrap();
                if unsafe_result.has_unsafe() {
                    log::debug!("{crate_fullname} unsafe");
                    if let Err(e) = db.set_unsafe(v.name(), v.version(), &unsafe_result).await {
                        log::error!("set_unsafe failed for {crate_fullname}: {e}");
                    }
                }
            }
        }
    }
    Ok(())
}

/// Run [`count_unsafe_crate`] over every crate in the index, 128 crates at a time.
///
/// # Errors
/// Returns `Error::IndexError` if the index cannot be opened.
pub async fn count_unsafe(roots: &Roots, db: Arc<Db>) -> Result<(), Error> {
    let index = crate::index::open_index().map_err(crate::index::Error::from)?;

    let iter = crate::chunked(index.crates(), 128);
    for chunk in iter {
        let tasks: Vec<_> = chunk
            .into_iter()
            .map(|c| count_unsafe_crate(c, roots.clone(), db.clone()))
            .collect();

        futures::future::join_all(tasks).await;
    }

    Ok(())
}

#[allow(dead_code)]
fn export_crate_csv<P: AsRef<Path>>(crate_bc_dir: P) -> Result<(), Error> {
    let calls = extract_calls(&crate_bc_dir)?;
    let crate_fullname = crate_bc_dir.as_ref().file_name().unwrap().to_str().unwrap();

    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(crate_bc_dir.as_ref().join("calls.csv"))
            .unwrap();

        for (src, dst) in &calls {
            writeln!(file, "{crate_fullname},{src},{dst}").unwrap();
        }
    }

    Ok(())
}

#[allow(dead_code)]
fn export_all_csv<P: AsRef<Path>>(bc_root: P) -> Result<(), Error> {
    let dirs: Vec<_> = std::fs::read_dir(&bc_root)?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .collect();

    dirs.par_iter().for_each(|crate_bc_dir| {
        export_crate_csv(crate_bc_dir.path()).unwrap();
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_data() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test_data")
    }

    #[test]
    fn crate_name_candidates_swap_every_separator() {
        assert_eq!(crate_name_candidates("serde"), ["serde"]);
        assert_eq!(
            crate_name_candidates("num_traits"),
            ["num_traits", "num-traits"]
        );
        let mut many = crate_name_candidates("a_b_c");
        assert_eq!(many[0], "a_b_c");
        many.sort();
        assert_eq!(many, ["a-b-c", "a-b_c", "a_b-c", "a_b_c"]);
        // Too many separators to enumerate: only the two uniform spellings.
        assert_eq!(
            crate_name_candidates("a_b_c_d_e_f_g_h"),
            ["a_b_c_d_e_f_g_h", "a-b-c-d-e-f-g-h"]
        );
    }

    #[test]
    fn resolve_crate_name_prefers_an_exact_match() {
        let existing: std::collections::HashSet<String> =
            ["num-traits", "candle-core", "foo_bar", "foo-bar", "serde"]
                .into_iter()
                .map(String::from)
                .collect();
        assert_eq!(
            resolve_crate_name("num_traits", &existing).as_deref(),
            Some("num-traits")
        );
        assert_eq!(
            resolve_crate_name("candle_core", &existing).as_deref(),
            Some("candle-core")
        );
        assert_eq!(
            resolve_crate_name("foo_bar", &existing).as_deref(),
            Some("foo_bar")
        );
        assert_eq!(
            resolve_crate_name("serde", &existing).as_deref(),
            Some("serde")
        );
        assert_eq!(resolve_crate_name("std_detect", &existing), None);
    }

    #[test]
    fn extract_calls_reads_checked_in_bitcode() {
        let calls = extract_calls(test_data()).unwrap();
        assert!(!calls.is_empty(), "no call edges in test_data/*.bc");
        for (caller, callee) in &calls {
            assert_ne!(caller, "");
            assert!(
                callee_crate(callee).is_some(),
                "std/core/intrinsic callee leaked through the filter: {callee}"
            );
        }
        // The serde fixture calls into serde itself; demangled names must be legible paths.
        assert!(calls.iter().any(|(_, callee)| callee.starts_with("serde::")
            || callee.contains(" as serde::")
            || callee.contains("<serde::")));
    }

    #[test]
    fn extract_calls_on_an_empty_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("notes.txt"), "not bitcode").unwrap();
        assert_eq!(
            extract_calls(tmp.path()).unwrap(),
            Vec::<(String, String)>::new()
        );
    }

    #[test]
    fn count_unsafe_result_parses_tool_output_and_sums() {
        let json = r#"{
            "functions": {"safe": 10, "unsafe_": 1},
            "exprs": {"safe": 100, "unsafe_": 2},
            "item_impls": {"safe": 5, "unsafe_": 0},
            "item_traits": {"safe": 1, "unsafe_": 0},
            "methods": {"safe": 20, "unsafe_": 3}
        }"#;
        let r: CountUnsafeResult = serde_json::from_str(json).unwrap();
        assert!(r.has_unsafe());
        assert_eq!(r.total_unsafe(), 6);

        let safe: CountUnsafeResult = serde_json::from_str(
            r#"{"functions":{"safe":1,"unsafe_":0},"exprs":{"safe":1,"unsafe_":0},
                "item_impls":{"safe":0,"unsafe_":0},"item_traits":{"safe":0,"unsafe_":0},
                "methods":{"safe":0,"unsafe_":0}}"#,
        )
        .unwrap();
        assert!(!safe.has_unsafe());
        assert_eq!(safe.total_unsafe(), 0);
    }

    #[test]
    fn export_crate_csv_writes_one_row_per_call() {
        // Copy the fixture so the CSV lands in a scratch dir named like a crate version.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("serde-1.0.0");
        std::fs::create_dir(&dir).unwrap();
        for e in std::fs::read_dir(test_data())
            .unwrap()
            .filter_map(Result::ok)
        {
            if e.path().extension().is_some_and(|x| x == "bc") {
                std::fs::copy(e.path(), dir.join(e.file_name())).unwrap();
            }
        }
        export_crate_csv(&dir).unwrap();
        let csv = std::fs::read_to_string(dir.join("calls.csv")).unwrap();
        let calls = extract_calls(&dir).unwrap();
        assert_eq!(csv.lines().count(), calls.len());
        assert!(csv.lines().all(|l| l.starts_with("serde-1.0.0,")));
    }

    #[test]
    fn crate_of_handles_plain_and_trait_impl_paths() {
        assert_eq!(
            crate_of("serde::de::Deserialize::deserialize"),
            Some("serde")
        );
        assert_eq!(
            crate_of("<serde::de::WithDecimalPoint as core::fmt::Display>::fmt"),
            Some("serde")
        );
        assert_eq!(
            crate_of("<&T as serde::Serialize>::serialize"),
            Some("serde")
        );
        assert_eq!(crate_of("<[u8] as core::fmt::Debug>::fmt"), Some("core"));
        assert_eq!(crate_of("alloc::vec::Vec<T>::push"), Some("alloc"));
        assert_eq!(crate_of("__rust_alloc"), None);
        assert_eq!(crate_of("llvm.memcpy.p0.i64"), None);
    }

    #[test]
    fn callee_crate_blocks_std_family_and_intrinsics() {
        assert_eq!(callee_crate("core::fmt::Write::write_char"), None);
        assert_eq!(callee_crate("std::io::Write::write"), None);
        assert_eq!(
            callee_crate("<alloc::string::String as core::fmt::Write>::write_str"),
            None
        );
        assert_eq!(callee_crate("llvm.memset.p0.i64"), None);
        assert_eq!(callee_crate("__rust_dealloc"), None);
        assert_eq!(
            callee_crate("serde_json::ser::to_string"),
            Some("serde_json")
        );
        assert_eq!(
            callee_crate("<T as serde::Serialize>::serialize"),
            Some("serde")
        );
    }
}
