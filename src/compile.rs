#![allow(clippy::module_name_repetitions)]

use crate::crate_fs::{CrateEntry, CrateFs};
use crate::index::open_index;
use crate::rules::BuildRules;
use crates_index::Crate;
use rayon::prelude::*;
use std::{path::Path, sync::Mutex};
use walkdir::WalkDir;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    /// Filesystem failure while copying bitcode.
    #[error("IO Error: {0}")]
    IoError(#[from] std::io::Error),
    /// `cargo rustc` exited non-zero; carries its stderr.
    #[error("Crate compilation failed:\n{0}")]
    CompileFailed(String),
    /// `cargo clean` exited non-zero.
    #[error("Clean stage failed")]
    CleanFailure(std::process::Output),
    /// The bounded compile pool could not be built.
    #[error("Thread pool error: {0}")]
    ThreadPool(#[from] rayon::ThreadPoolBuildError),
    /// Bitcode could not be parsed.
    #[error("LLVM IR failure: {0}")]
    LLVMError(String),
    /// The crates.io index could not be opened or walked.
    #[error("Indexing Error: {0}")]
    IndexError(#[from] crates_index::Error),
    /// Crate extraction or lookup failure.
    #[error("Crate FS Error: {0}")]
    CrateFsError(#[from] crate::crate_fs::Error),
    /// Build-rule resolution failure.
    #[error("Build rules error: {0}")]
    RulesError(#[from] crate::rules::Error),
}

/// Executes a cargo clean within the crates sources directory. This is executed within the
/// `Roots::sources_root` directory inside a given crates version folder.
///
/// # Panics
/// This function will panic if executing `cargo` or `rustc` fails due to OS process execution problems.
/// It will not panic on failure of the command itself.
/// # Errors
/// returns an instance of `Error::CleanFailure`, containing the output of stdout and stderr from the
/// execution.
pub fn clean(path: &Path, toolchain: &str) -> Result<(), Error> {
    let output = std::process::Command::new("cargo")
        .arg(format!("+{toolchain}"))
        .arg("clean")
        .current_dir(path)
        .output()
        .unwrap();

    // The target dir may already be gone; that is not an error.
    let _ = std::fs::remove_dir_all(path.join("target"));

    if output.status.success() {
        Ok(())
    } else {
        Err(Error::CleanFailure(output))
    }
}

/// Directory under the bytecode root where [`compile_crate`] assembles a version's bitcode before
/// renaming it into place. Dot-prefixed so bytecode scans and exports skip it.
pub const STAGING_DIR: &str = ".painter-staging";

/// Cargo `--config` override that builds every dependency at `opt-level=0`. Only the crate under
/// analysis emits bitcode, so optimizing its dependencies is wasted work. `"*"` does not match
/// workspace members, so the analyzed crate keeps the release profile; generic and `#[inline]`
/// code from dependencies is codegened inside it and is optimized as before.
pub const DEPS_OPT_LEVEL: &str = r#"profile.release.package."*".opt-level=0"#;

/// Executes a cargo rustc  within the crates sources directory. This is executed within the
/// `Roots::sources_root` directory inside a given crates version folder.
///
/// # Panics
/// This function will panic if executing `cargo` or `rustc` fails due to OS process execution problems.
/// It will not panic on failure of the command itself.
///
/// This function will panic if the stdout or stderr from `rustc` fails to UTF-8 decode.
///
/// # Errors
/// returns an instance of `Error::CompileFailed`, containing the output of stdout and stderr from the
/// execution.
pub fn compile_crate<PS: AsRef<Path>, PC: AsRef<Path>>(
    name: &str,
    version: &str,
    src_path: PS,
    bc_root: PC,
    toolchain: &str,
) -> Result<(), Error> {
    let fullname = format!("{name}-{version}");
    let output_dir = bc_root.as_ref().join(&fullname);

    log::info!("Compiling: {} @ {}", fullname, output_dir.display());

    // Build the crate with rustc, emitting llvm-bc. We also disable LTO to prevent some inlining
    // to gain better cross-crate function call introspection.
    // TODO: We should further limit optimizations and inlining to get an even better picture.
    let output = std::process::Command::new("cargo")
        .arg(format!("+{toolchain}"))
        .args([
            "--config",
            DEPS_OPT_LEVEL,
            "rustc",
            "--release",
            "--lib",
            "--",
            "-g",
            "--emit=llvm-bc",
            "-C",
            "lto=off",
            // Crates published years ago often `#![deny(...)]` lints that newer compilers now
            // fire; cap them to warnings exactly as cargo does for registry dependencies.
            "--cap-lints=warn",
        ])
        .current_dir(src_path.as_ref())
        .output()
        .unwrap();

    log::trace!("Compiled: {fullname} with result: {output:?}");

    if output.status.success() {
        // Copy the emitted .bc files into a staging dir and rename it into place, so a
        // `<name>-<version>` dir in the bytecode root is always complete: an interrupted copy
        // never looks like a finished build to update-only or to a concurrent exporter.
        let staging = bc_root.as_ref().join(STAGING_DIR).join(&fullname);
        if staging.exists() {
            std::fs::remove_dir_all(&staging)?;
        }
        std::fs::create_dir_all(&staging)?;

        let mut copied = 0usize;
        for e in WalkDir::new(src_path.as_ref())
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "bc"))
        {
            std::fs::copy(e.path(), staging.join(e.file_name()))?;
            copied += 1;
        }

        if output_dir.exists() {
            std::fs::remove_dir_all(&output_dir)?;
        }
        std::fs::rename(&staging, &output_dir)?;
        log::info!("Compiled: {fullname}, {copied} bitcode file(s)");

        clean(src_path.as_ref(), toolchain)?;
    } else {
        // Best effort clean; the compile failure is the error worth reporting.
        if let Err(e) = clean(src_path.as_ref(), toolchain) {
            log::warn!("{fullname}: clean after failed compile also failed: {e}");
        }

        // Keep only the tail of stderr: rustc output for a broken crate can run to megabytes.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(40).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        return Err(Error::CompileFailed(tail.join("\n")));
    }

    Ok(())
}

/// Options controlling [`compile_all`].
#[derive(Debug, Clone)]
pub struct CompileOptions {
    /// Skip crate versions that already have a bytecode directory.
    pub update_only: bool,
    /// rustup toolchain name passed as `cargo +<toolchain>`.
    pub toolchain: String,
    /// How many crates to resolve through the rules concurrently (bounds requests to external
    /// data sources such as ecosyste.ms).
    pub rules_concurrency: usize,
    /// How many crates to compile at once. `None` uses one per CPU. Each compile is itself a
    /// `cargo` process that may spawn several `rustc` jobs for dependencies.
    pub jobs: Option<usize>,
}

impl Default for CompileOptions {
    fn default() -> Self {
        Self {
            update_only: true,
            toolchain: DEFAULT_TOOLCHAIN.to_string(),
            rules_concurrency: 16,
            jobs: None,
        }
    }
}

/// Toolchain used when none is specified.
pub const DEFAULT_TOOLCHAIN: &str = "1.67";

/// Compile one version of a crate: extract it through `fs`, build, and copy bitcode into
/// `bc_root`. Failures are logged, not returned, so a bad crate never stops the sweep. The
/// extraction is deleted afterwards, including one left behind by an interrupted earlier run,
/// so the sources root only holds the crates currently being built.
fn compile_version(
    name: &str,
    version: &str,
    fs: &Mutex<CrateFs>,
    bc_root: &Path,
    opts: &CompileOptions,
) {
    let fullname = format!("{name}-{version}");
    let entry = CrateEntry::from_parts(name, version);
    let purge = |entry: &CrateEntry| {
        if let Err(e) = fs.lock().unwrap().purge(entry) {
            log::warn!("{fullname}: removing extracted sources failed: {e}");
        }
    };

    if opts.update_only && bc_root.join(&fullname).exists() {
        log::info!("{fullname} bytecode exists, skipping..");
        // Sources left behind by an interrupted earlier run.
        purge(&entry);
        return;
    }

    let src_path = {
        let mut lock = fs.lock().unwrap();
        match lock.open_entry(entry.clone()) {
            Ok(entry) => entry.path().to_path_buf(),
            Err(e) => {
                log::error!("Opening failed on {fullname}: {e}");
                return;
            }
        }
    };

    if let Err(e) = compile_crate(name, version, &src_path, bc_root, &opts.toolchain) {
        log::error!("{fullname} failed: {e}");
    }
    purge(&entry);
}

/// Ask `rules` which versions of each crate to build, with bounded concurrency. Rule failures
/// for an individual crate are logged and that crate is skipped.
async fn select_work(
    mut crates: tokio::sync::mpsc::Receiver<Crate>,
    rules: &dyn BuildRules,
    concurrency: usize,
) -> Vec<(String, String)> {
    let concurrency = concurrency.max(1);
    let mut work = Vec::new();
    let mut chunk = Vec::with_capacity(concurrency);
    loop {
        chunk.clear();
        if crates.recv_many(&mut chunk, concurrency).await == 0 {
            break;
        }
        let tasks = chunk.iter().map(|c| rules.select_versions(c));
        for (c, selected) in chunk.iter().zip(futures::future::join_all(tasks).await) {
            match selected {
                Ok(versions) => work.extend(
                    versions
                        .into_iter()
                        .map(|v| (c.name().to_string(), v.version().to_string())),
                ),
                Err(e) => log::error!("rules failed for {}: {e}", c.name()),
            }
        }
    }
    work
}

/// How many parsed index entries may be queued between the index walk and the rules.
const PLAN_QUEUE: usize = 4096;

/// Build the list of `(name, version)` pairs that `rules` selects from the index.
///
/// # Panics
/// Panics if the index walk task panics.
///
/// # Errors
/// Returns `Error::IndexError` if the crates.io index cannot be opened, or `Error::RulesError`
/// if the rules cannot produce their candidate set.
pub async fn plan(
    rules: &dyn BuildRules,
    concurrency: usize,
) -> Result<Vec<(String, String)>, Error> {
    let index = open_index()?;
    let (tx, rx) = tokio::sync::mpsc::channel(PLAN_QUEUE);

    // The index walk parses git blobs and is CPU bound; run it on rayon (one repository handle
    // per worker) and stream crates to the rules through a bounded channel.
    let walker = if let Some(names) = rules.candidate_crates().await? {
        log::info!("rules selected {} candidate crates", names.len());
        tokio::task::spawn_blocking(move || {
            for name in names {
                match index.crate_(&name) {
                    Some(c) => {
                        if tx.blocking_send(c).is_err() {
                            return;
                        }
                    }
                    // Expected with ecosyste.ms data: it keeps records of crates deleted from
                    // crates.io.
                    None => log::warn!("Crate not found in index, skipping: {name}"),
                }
            }
        })
    } else {
        log::info!("rules apply to every crate in the index");
        tokio::task::spawn_blocking(move || {
            index.crates_parallel().for_each(|c| match c {
                Ok(c) => {
                    // The receiver only goes away when the consumer gave up; nothing to do.
                    let _ = tx.blocking_send(c);
                }
                Err(e) => log::error!("index walk failed: {e}"),
            });
        })
    };

    let work = select_work(rx, rules, concurrency).await;
    walker.await.expect("index walk task panicked");

    log::info!("planned {} crate versions to build", work.len());
    Ok(work)
}

/// Compile every crate version that `rules` selects, in parallel, extracting sources through
/// `fs` on demand.
///
/// # Errors
/// Returns `Error::IndexError` if the crates.io index cannot be opened, `Error::RulesError`
/// if the rules fail, or `Error::ThreadPool` if the compile pool cannot be created. Individual
/// crate build failures are logged and skipped.
pub async fn compile_all<P: AsRef<Path> + Send + Sync>(
    fs: CrateFs,
    bc_root: P,
    opts: CompileOptions,
    rules: &dyn BuildRules,
) -> Result<(), Error> {
    use rayon::iter::{IntoParallelIterator, ParallelIterator};

    let work = plan(rules, opts.rules_concurrency).await?;

    // Half-copied bitcode from an interrupted earlier run.
    let staging = bc_root.as_ref().join(STAGING_DIR);
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }

    // A dedicated pool so `jobs` bounds the number of concurrent `cargo` processes regardless
    // of how many threads the global rayon pool has.
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(opts.jobs.unwrap_or(0))
        .build()?;
    log::info!(
        "compiling {} crate versions, {} at a time",
        work.len(),
        pool.current_num_threads()
    );

    let fs = Mutex::new(fs);
    let bc_root = bc_root.as_ref();
    pool.install(|| {
        work.into_par_iter().for_each(|(name, version)| {
            compile_version(&name, &version, &fs, bc_root, &opts);
        });
    });

    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;

    /// Environment variable overriding the toolchain used by tests that really invoke cargo.
    pub const TEST_TOOLCHAIN_ENV: &str = "PAINTER_TEST_TOOLCHAIN";

    /// Toolchain used by tests that really invoke cargo. Its LLVM must not be newer than the
    /// LLVM `llvm-ir` links against or the emitted bitcode is unreadable (e.g. Rust 1.99 ships
    /// LLVM 23, which LLVM 22 rejects with "Invalid record"). 1.96.1 ships LLVM 22.
    pub fn test_toolchain() -> String {
        std::env::var(TEST_TOOLCHAIN_ENV).unwrap_or_else(|_| "1.96.1".to_string())
    }

    /// Write a minimal library crate `<name>-<version>` under `root` with one cross-function
    /// call that survives optimisation, and return its directory.
    pub fn write_fixture_crate(root: &Path, name: &str, version: &str) -> std::path::PathBuf {
        let dir = root.join(format!("{name}-{version}"));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            format!(
                "[package]\nname = \"{name}\"\nversion = \"{version}\"\nedition = \"2021\"\n\n[lib]\n"
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("src/lib.rs"),
            "#[inline(never)]\npub fn callee(x: u32) -> u32 { x.wrapping_mul(3) }\n\
             pub fn caller(x: u32) -> u32 { callee(x) + 1 }\n",
        )
        .unwrap();
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{test_toolchain, write_fixture_crate};
    use super::*;
    use crate::crate_fs::CrateFsConfig;

    #[test]
    fn default_options() {
        let o = CompileOptions::default();
        assert!(o.update_only);
        assert_eq!(o.toolchain, DEFAULT_TOOLCHAIN);
        assert_eq!(o.rules_concurrency, 16);
        assert_eq!(o.jobs, None);
    }

    /// `compile_all`'s per-version step deletes the extraction after building, and deletes a
    /// stale one when it skips an already-built version.
    #[test]
    fn compile_version_removes_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let crates = tmp.path().join("crates");
        let sources = tmp.path().join("sources");
        let bc_root = tmp.path().join("bc");
        std::fs::create_dir_all(&crates).unwrap();
        std::fs::create_dir_all(&sources).unwrap();

        // Pack the fixture as crates/painter_fixture-0.1.0.crate.
        let staging = tmp.path().join("staging");
        let dir = write_fixture_crate(&staging, "painter_fixture", "0.1.0");
        let gz = flate2::write::GzEncoder::new(
            std::fs::File::create(crates.join("painter_fixture-0.1.0.crate")).unwrap(),
            flate2::Compression::fast(),
        );
        let mut tar = tar::Builder::new(gz);
        tar.append_dir_all("painter_fixture-0.1.0", &dir).unwrap();
        tar.into_inner().unwrap().finish().unwrap();

        let fs = Mutex::new(CrateFs::new(CrateFsConfig::with_paths(&crates, &sources)).unwrap());
        let opts = CompileOptions {
            toolchain: test_toolchain(),
            ..CompileOptions::default()
        };
        compile_version("painter_fixture", "0.1.0", &fs, &bc_root, &opts);
        assert!(bc_root.join("painter_fixture-0.1.0").is_dir());
        let extracted = sources.join("painter_fixture-0.1.0");
        assert!(!extracted.exists(), "sources survived the build");

        // A stale extraction of the now-built version, as an interrupted run leaves behind.
        std::fs::create_dir_all(extracted.join("src")).unwrap();
        compile_version("painter_fixture", "0.1.0", &fs, &bc_root, &opts);
        assert!(
            !extracted.exists(),
            "stale sources of a built version survived"
        );
    }

    #[test]
    fn compile_crate_emits_bitcode_and_cleans_up() {
        let tmp = tempfile::tempdir().unwrap();
        let src = write_fixture_crate(tmp.path(), "painter_fixture", "0.1.0");
        let bc_root = tmp.path().join("bc");

        compile_crate(
            "painter_fixture",
            "0.1.0",
            &src,
            &bc_root,
            &test_toolchain(),
        )
        .unwrap();

        let out = bc_root.join("painter_fixture-0.1.0");
        let bcs: Vec<_> = std::fs::read_dir(&out)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "bc"))
            .collect();
        assert!(!bcs.is_empty(), "no .bc copied into {}", out.display());
        assert!(!src.join("target").exists(), "cargo clean did not run");
        let staging = bc_root.join(STAGING_DIR);
        assert_eq!(
            std::fs::read_dir(&staging).unwrap().count(),
            0,
            "staging dir not renamed into place"
        );

        // The bitcode is readable by the linked LLVM and contains the intra-crate call.
        let calls = crate::analysis::extract_calls(&out).unwrap();
        assert!(
            calls
                .iter()
                .any(|(src, dst)| src.contains("caller") && dst.contains("callee")),
            "caller->callee edge missing from {calls:?}"
        );
    }

    #[test]
    fn compile_crate_reports_build_failures() {
        let tmp = tempfile::tempdir().unwrap();
        let src = write_fixture_crate(tmp.path(), "broken", "0.1.0");
        std::fs::write(src.join("src/lib.rs"), "pub fn nope() -> u32 { \"str\" }\n").unwrap();
        let bc_root = tmp.path().join("bc");

        let err = compile_crate("broken", "0.1.0", &src, &bc_root, &test_toolchain()).unwrap_err();
        assert!(matches!(err, Error::CompileFailed(_)), "{err}");
        assert!(
            !bc_root.join("broken-0.1.0").exists(),
            "no output dir on failure"
        );
    }

    #[test]
    fn clean_fails_outside_a_cargo_project() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(matches!(
            clean(tmp.path(), &test_toolchain()),
            Err(Error::CleanFailure(_))
        ));
    }
}
