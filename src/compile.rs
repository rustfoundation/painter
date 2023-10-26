#![allow(clippy::module_name_repetitions)]

use crate::crate_fs::{CrateCache, CrateEntry, CrateFs};
use crates_index::{Crate, Index};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use walkdir::WalkDir;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    ///
    #[error("IO Error: {0}")]
    IoError(#[from] std::io::Error),
    ///
    #[error("Crate compilation failed")]
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
pub fn clean(path: &Path) -> Result<(), Error> {
    // cargo rustc --release -- -g --emit=llvm-bc
    let output = std::process::Command::new("cargo")
        .arg("+1.60")
        .arg("clean")
        .current_dir(path)
        .output()
        .unwrap();

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
fn compile_crate<P: AsRef<Path>>(
    name: &str,
    version: &str,
    src_path: P,
    bc_root: P,
) -> Result<(), Error> {
    let fullname = format!("{}-{}", &name, version);
    let output_dir = bc_root.as_ref().join(&fullname);

    log::debug!("Compiling: {} @ {}", &fullname, output_dir.display());

    // Build the crate with rustc, emitting llvm-bc. We also disable LTO to prevent some inlining
    // to gain better cross-crate function call introspection.
    // TODO: We should further limit optimizations and inlining to get an even better picture.
    let output = std::process::Command::new("cargo")
        .args([
            "+1.67",
            "rustc",
            "--release",
            "--lib",
            "--",
            "-g",
            "--emit=llvm-bc",
            "-C",
            "lto=off",
        ])
        .current_dir(src_path.as_ref())
        .output()
        .unwrap();

    log::trace!("Compiled: {} with result: {:?}", fullname, output);

    if output.status.success() {
        std::fs::create_dir(&output_dir);

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
    } else {
        return Err(Error::CompileFailed(format!(
            "{}\n-----------\n{}",
            std::str::from_utf8(&output.stdout).unwrap(),
            std::str::from_utf8(&output.stderr).unwrap()
        )));
    };

    // clean(&cache.path())?;

    Ok(())
}

/// Walks the entire `Roots::sources_root` and attempts to compile all crates in parallel.
pub async fn compile_all<P: AsRef<Path> + Send + Sync>(
    mut fs: CrateFs,
    bc_root: P,
) -> Result<(), Error> {
    use rayon::iter::ParallelIterator;

    // iterate the dir of crates and iterate them via the FS cache
    let index = Index::new_cargo_default()?;

    let fs = Arc::new(Mutex::new(fs));

    let do_crate = |c: Crate, fs: Arc<Mutex<CrateFs>>, bc_root: PathBuf| {
        log::trace!("enter: {}", c.name());
        //for v in c.versions() {
        // TODO: currently latest only
        let v = c.latest_version();

        let fullname = format!("{}-{}", c.name(), v.version());
        log::trace!("Opening: {}", fullname);

        let cache = {
            let mut lock = fs.lock().unwrap();
            if let Ok(entry) = lock.open(&fullname) {
                entry.path().to_path_buf()
            } else {
                log::error!("Opening failed on {}", fullname);
                return;
            }
        };

        if let Err(e) = compile_crate(c.name(), v.version(), &cache, &bc_root) {
            log::error!("{:?}", e);
        }
        //}
    };

    index
        .crates_parallel()
        .filter_map(|c| c.ok())
        .for_each(|c| {
            do_crate(c, fs.clone(), bc_root.as_ref().to_path_buf());
        });

    Ok(())
}
