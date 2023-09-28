use crate::{db::Db, Error, Roots};
use llvm_ir_analysis::{llvm_ir::Module, ModuleAnalysis};
use rayon::prelude::*;
use rustc_demangle::demangle;

use crates_index::Crate;
use std::{io::Write, path::Path, sync::Arc};

const BLOCKED_STRINGS: &[&str] = &["llvm.", "__rust", "rt::", "std::", "core::", "alloc::"];

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
        graph.inner().all_edges().for_each(|(src_raw, dst_raw, _)| {
            let src = format!("{:#}", demangle(src_raw));
            let dst = format!("{:#}", demangle(dst_raw));

            if !BLOCKED_STRINGS
                .iter()
                .any(|s| src.contains(*s) || dst.contains(*s))
            {
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
/// This function panics if extracting the filename of a crates full name from its path fails.
///
/// # Errors
/// Returns `painter::analysis::Error` on failure of database insertion.
#[allow(clippy::needless_pass_by_value)]
pub async fn export_crate_db<P: AsRef<Path>>(crate_bc_dir: P, db: Arc<Db>) -> Result<(), Error> {
    let calls = extract_calls(&crate_bc_dir)?;
    let crate_fullname = crate_bc_dir.as_ref().file_name().unwrap().to_str().unwrap();

    let (crate_name, crate_version) = crate_fullname.rsplit_once('-').unwrap();
    log::trace!("Importing: {}", crate_name);

    for (caller, callee) in &calls {
        let dst_crate = callee.split_once("::").unwrap_or(("NONE", "")).0;
        db.insert_invoke(caller, callee, (crate_name, crate_version), dst_crate)
            .await?;
    }

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
        .filter(|e| e.path().is_dir())
        .collect();

    for crate_bc_dir in dirs {
        export_crate_db(crate_bc_dir.path(), db.clone()).await?;
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

pub(crate) async fn count_unsafe_crate(c: Crate, roots: Roots, db: Arc<Db>) -> Result<(), Error> {
    let compressed_root = &roots.compressed_root;
    let sources_root = &roots.sources_root;

    for v in c.versions() {
        let crate_fullname = format!("{}-{}", v.name(), v.version());
        let crate_path = compressed_root.join(format!("{}.crate", &crate_fullname));

        // Lets work off the tgz for now, since we cant extract
        // TODO: this needs to be unified to a file driver
        if std::fs::metadata(&crate_path).is_ok() {
            let extracted_path = sources_root.join(&crate_fullname);
            let tar_gz = std::fs::File::open(&crate_path).unwrap();
            let tar = flate2::read::GzDecoder::new(tar_gz);
            let mut archive = tar::Archive::new(tar);
            if archive.unpack(sources_root).is_ok() {
                log::trace!("Extracted {}", &crate_fullname);

                // Run our count
                let output = std::process::Command::new("count-unsafe")
                    .args([&extracted_path])
                    .output()
                    .unwrap();
                if output.status.success() {
                    let raw_json = std::str::from_utf8(&output.stdout).unwrap();
                    log::trace!("{}", &raw_json);

                    let unsafe_result: CountUnsafeResult = serde_json::from_str(raw_json).unwrap();
                    if unsafe_result.has_unsafe() {
                        log::debug!("{} unsafe", &crate_fullname);
                        db.set_unsafe(v.name(), v.version(), &unsafe_result).await;
                        //.unwrap();
                    }

                    // Finally delete
                    std::fs::remove_dir_all(extracted_path).unwrap();
                    log::trace!("Deleted {}", &crate_fullname);
                }
            }
        }
    }
    Ok(())
}

pub(crate) async fn count_unsafe(roots: &Roots, db: Arc<Db>) -> Result<(), Error> {
    let index = crates_index::Index::new_cargo_default().map_err(crate::index::Error::from)?;

    let iter = index.crates().array_chunks::<128>();
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
            .open(crate_bc_dir.as_ref().join("calls.csv"))
            .unwrap();

        calls.iter().enumerate().for_each(|(_, (src, dst))| {
            writeln!(file, "{crate_fullname},{src},{dst}").unwrap();
        });
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
