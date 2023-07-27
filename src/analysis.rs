use crate::db::Db;
use crate::Error;
use llvm_ir::Module;
use llvm_ir_analysis::ModuleAnalysis;
use rayon::prelude::*;
use rustc_demangle::demangle;

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
