#![allow(clippy::module_name_repetitions)]

use crate::crate_fs::{CrateEntry, CrateFs};
use crate::index::open_index;
use crate::rules::BuildRules;
use crates_index::Crate;
use std::{path::Path, sync::Mutex};
use walkdir::WalkDir;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    ///
    #[error("IO Error: {0}")]
    IoError(#[from] std::io::Error),
    ///
    #[error("Crate compilation failed:\n{0}")]
    CompileFailed(String),
    ///
    #[error("Clean stage failed")]
    CleanFailure(std::process::Output),
    ///
    #[error("LLVM IR failure: {0}")]
    LLVMError(String),
    ///
    #[error("Indexing Error: {0}")]
    IndexError(#[from] crates_index::Error),
    ///
    #[error("Indexing Error: {0}")]
    CrateFsError(#[from] crate::crate_fs::Error),
    ///
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
        std::fs::create_dir_all(&output_dir)?;

        // If the compile succeeded, search for emitted .bc files of bytecode and copy them over
        // to the Roots::bytecode_root directory.
        WalkDir::new(src_path.as_ref())
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some() && e.path().extension().unwrap() == "bc")
            .for_each(|e| {
                let dst = output_dir.join(Path::new(e.path().file_name().unwrap()));
                if dst.exists() {
                    std::fs::remove_file(&dst).unwrap();
                }
                std::fs::copy(e.path(), &dst).unwrap();
            });

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
}

impl Default for CompileOptions {
    fn default() -> Self {
        Self {
            update_only: true,
            toolchain: DEFAULT_TOOLCHAIN.to_string(),
            rules_concurrency: 16,
        }
    }
}

/// Toolchain used when none is specified.
pub const DEFAULT_TOOLCHAIN: &str = "1.67";

/// Compile one version of a crate: extract it through `fs`, build, and copy bitcode into
/// `bc_root`. Failures are logged, not returned, so a bad crate never stops the sweep.
fn compile_version(
    name: &str,
    version: &str,
    fs: &Mutex<CrateFs>,
    bc_root: &Path,
    opts: &CompileOptions,
) {
    let fullname = format!("{name}-{version}");

    if opts.update_only && bc_root.join(&fullname).exists() {
        log::info!("{fullname} bytecode exists, skipping..");
        return;
    }

    let src_path = {
        let mut lock = fs.lock().unwrap();
        match lock.open_entry(CrateEntry::from_parts(name, version)) {
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
}

/// Ask `rules` which versions of each crate to build, with bounded concurrency. Rule failures
/// for an individual crate are logged and that crate is skipped.
async fn select_work<I>(
    crates: I,
    rules: &dyn BuildRules,
    concurrency: usize,
) -> Vec<(String, String)>
where
    I: Iterator<Item = Crate>,
{
    let mut work = Vec::new();
    for chunk in crate::chunked(crates, concurrency.max(1)) {
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

/// Build the list of `(name, version)` pairs that `rules` selects from the index.
///
/// # Errors
/// Returns `Error::IndexError` if the crates.io index cannot be opened, or `Error::RulesError`
/// if the rules cannot produce their candidate set.
pub async fn plan(rules: &dyn BuildRules, concurrency: usize) -> Result<Vec<(String, String)>, Error> {
    let index = open_index()?;

    let work = if let Some(names) = rules.candidate_crates().await? {
        log::info!("rules selected {} candidate crates", names.len());
        let crates = names.iter().filter_map(|name| {
            let c = index.crate_(name);
            if c.is_none() {
                // Expected with ecosyste.ms data: it keeps records of crates deleted from crates.io.
                log::warn!("Crate not found in index, skipping: {name}");
            }
            c
        });
        select_work(crates, rules, concurrency).await
    } else {
        log::info!("rules apply to every crate in the index");
        select_work(index.crates(), rules, concurrency).await
    };

    log::info!("planned {} crate versions to build", work.len());
    Ok(work)
}

/// Compile every crate version that `rules` selects, in parallel, extracting sources through
/// `fs` on demand.
///
/// # Errors
/// Returns `Error::IndexError` if the crates.io index cannot be opened, or `Error::RulesError`
/// if the rules fail. Individual crate build failures are logged and skipped.
pub async fn compile_all<P: AsRef<Path> + Send + Sync>(
    fs: CrateFs,
    bc_root: P,
    opts: CompileOptions,
    rules: &dyn BuildRules,
) -> Result<(), Error> {
    use rayon::iter::{IntoParallelIterator, ParallelIterator};

    let work = plan(rules, opts.rules_concurrency).await?;

    let fs = Mutex::new(fs);
    let bc_root = bc_root.as_ref();
    work.into_par_iter().for_each(|(name, version)| {
        compile_version(&name, &version, &fs, bc_root, &opts);
    });

    Ok(())
}
