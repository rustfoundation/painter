use super::CrateSource;
use crate::Error;
use llvm_ir::Module;
use llvm_ir_analysis::ModuleAnalysis;
use rayon::prelude::*;
use rustc_demangle::demangle;

use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

const BLOCKED_STRINGS: &'static [&str] = &["llvm.", "__rust", "rt::", "std::", "core::", "alloc::"];

pub fn extract_target_crate_from_invoke(invoke: &str) -> Option<String> {
    //let path = syn::parse_str::<syn::TypePath>(invoke)?;
    //println!("{:?}", path);

    todo!()
}

pub fn export_crate_db<P: AsRef<Path>>(crate_bc_dir: P) -> Result<(), Error> {
    Ok(())
}

pub fn export_crate_csv<P: AsRef<Path>>(crate_bc_dir: P) -> Result<(), Error> {
    let mut calls = Vec::<(String, String)>::new();
    let crate_fullname = crate_bc_dir.as_ref().file_name().unwrap().to_str().unwrap();

    for bc_entry in std::fs::read_dir(crate_bc_dir.as_ref())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some() && e.path().extension().unwrap() == "bc")
    {
        let bc_path = bc_entry.path();

        let module = Module::from_bc_path(&bc_path)
            .map_err(|s| Error::LLVMError(s))
            .unwrap();
        let analysis = ModuleAnalysis::new(&module);

        let graph = analysis.call_graph();
        graph.inner().all_edges().for_each(|(src_raw, dst_raw, _)| {
            let src = format!("{:#}", demangle(src_raw));
            let dst = format!("{:#}", demangle(dst_raw));

            if BLOCKED_STRINGS
                .iter()
                .find(|s| src.contains(**s) || dst.contains(**s))
                .is_none()
            {
                calls.push((src, dst));
            }
        });
    }

    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(crate_bc_dir.as_ref().join("calls.csv"))
            .unwrap();

        calls.iter().enumerate().for_each(|(_, (src, dst))| {
            writeln!(file, "{},{},{}", crate_fullname, src, dst);
        });
    }

    Ok(())
}

pub fn export_all_csv<P: AsRef<Path>>(bc_root: P) -> Result<(), Error> {
    let dirs: Vec<_> = std::fs::read_dir(&bc_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();

    dirs.par_iter().for_each(|crate_bc_dir| {
        export_crate_csv(crate_bc_dir.path());
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    pub fn extract_path() {
        let c = extract_target_crate_from_invoke("<testcrate::asdf<T> as SomeTrait>::Associated")
            .unwrap();
    }
}
