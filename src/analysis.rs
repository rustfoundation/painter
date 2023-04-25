use super::CrateSource;
use crate::Error;
use llvm_ir::Module;
use llvm_ir_analysis::ModuleAnalysis;
use rayon::prelude::*;
use rustc_demangle::demangle;

use std::{
    collections::HashMap,
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

pub fn export_all_neo4j<P: AsRef<Path>>(bc_root: P) -> Result<(), Error> {
    let mut function_id = Arc::new(AtomicU64::new(0));

    let mut functions = Arc::new(Mutex::new(HashMap::<String, (u64, u64)>::new()));
    let mut calls = Arc::new(Mutex::new(Vec::<(u64, u64)>::new()));

    let dirs: Vec<_> = std::fs::read_dir(&bc_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();

    dirs.par_iter().for_each(|crate_bc_dir| {
        for bc_entry in std::fs::read_dir(crate_bc_dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some() && e.path().extension().unwrap() == "bc")
        {
            let bc_path = bc_entry.path();
            let crate_fullname = bc_path.file_name().unwrap().to_str().unwrap();

            let module = Module::from_bc_path(&bc_path)
                .map_err(|s| Error::LLVMError(s))
                .unwrap();
            let analysis = ModuleAnalysis::new(&module);

            let graph = analysis.call_graph();
            graph.inner().nodes().for_each(|node| {
                functions
                    .lock()
                    .unwrap()
                    .entry(format!("{:#}", demangle(node)))
                    .or_insert_with(|| (function_id.fetch_add(1, Ordering::Relaxed), 0));
            });
            graph.inner().all_edges().for_each(|(src, dst, _)| {
                let (src_id, dst_id) = {
                    let mut f = functions.lock().unwrap();
                    let (src_id, _) = *f
                        .entry(format!("{:#}", demangle(src)))
                        .or_insert_with(|| (function_id.fetch_add(1, Ordering::Relaxed), 0));
                    let (dst_id, _) = *f
                        .entry(format!("{:#}", demangle(dst)))
                        .or_insert_with(|| (function_id.fetch_add(1, Ordering::Relaxed), 0));

                    (src_id, dst_id)
                };

                calls.lock().unwrap().push((src_id, dst_id));
            });
        }
    });

    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(bc_root.as_ref().join("functions.csv"))
            .unwrap();

        functions
            .lock()
            .unwrap()
            .iter()
            .for_each(|(name, (id, _))| {
                writeln!(file, "f{},{}", id, name);
            });
    }

    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(bc_root.as_ref().join("calls.csv"))
            .unwrap();

        calls
            .lock()
            .unwrap()
            .iter()
            .enumerate()
            .for_each(|(i, (src, dst))| {
                writeln!(file, "i{},f{},f{}", i, src, dst);
            });
    }

    Ok(())
}
