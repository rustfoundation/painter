#![feature(string_remove_matches)]

use clap::{Parser, Subcommand, ValueHint};
use rayon::prelude::*;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use thiserror::Error;
use walkdir::WalkDir;

pub mod depends;
pub mod graph;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(short = 's', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub source_dir: PathBuf,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    CompileAll {
        #[arg(short = 'b', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        bytecode_dir: PathBuf,
    },
    CleanAll,
    Analyze {
        #[arg(short = 'b', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        bytecode_dir: PathBuf,
    },
    ToJson {
        #[arg(short = 'b', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        bytecode_dir: PathBuf,
    },
}

#[derive(Error, Debug)]
pub enum CompileError {
    #[error("{0}")]
    IoError(#[from] std::io::Error),
    #[error("CrateNameError")]
    CrateNameError(String),
    #[error("CompileFailed")]
    CompileFailed,
    #[error("CleanFailure")]
    CleanFailure(std::process::Output),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CrateSource {
    name: String,
    version: String,
    path: PathBuf,
}

pub type CrateCollection = HashMap<String, CrateSource>;

pub fn get_crate_sources<P: AsRef<Path>>(
    source_dir: &P,
) -> Result<HashMap<String, CrateSource>, CompileError> {
    let mut sources = HashMap::new();

    for e in std::fs::read_dir(source_dir.as_ref())?.filter_map(|e| e.ok()) {
        if e.metadata().unwrap().is_dir() {
            let path = e.path();
            let full_name = path
                .file_name()
                .ok_or(CompileError::CrateNameError(path.display().to_string()))?
                .to_string_lossy()
                .to_string();
            let (name, version) = full_name
                .rsplit_once('-')
                .ok_or(CompileError::CrateNameError(full_name.clone()))?;

            let crate_info = CrateSource {
                name: name.to_string(),
                version: version.to_string(),
                path,
            };

            sources.insert(full_name, crate_info);
        }
    }

    Ok(sources)
}

pub fn clean_one(path: &Path) -> Result<(), CompileError> {
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
        Err(CompileError::CleanFailure(output))
    }
}

pub fn clean_all(sources: &CrateCollection) -> Vec<(&str, Result<(), CompileError>)> {
    sources
        .par_iter()
        .map(|(name, info)| (name.as_ref(), clean_one(&info.path)))
        .collect()
}

pub fn compile_all<'a>(
    sources: &'a CrateCollection,
    bytecode_dir: &Path,
) -> Vec<(&'a str, Result<(), CompileError>)> {
    sources
        .par_iter()
        .map(|(name, info)| {
            //// opt -enable-new-pm=0 -dot-callgraph
            // cargo rustc --release -- -g --emit=llvm-bc
            let output = std::process::Command::new("cargo")
                .args([
                    "+1.60",
                    "rustc",
                    "--release",
                    "--",
                    "-g",
                    "--emit=llvm-bc",
                    "-C",
                    "lto=off",
                ])
                .current_dir(&info.path)
                .output()
                .unwrap();

            log::debug!("Compiled: {} with result: {:?}", name, output);

            let result = if output.status.success() {
                let target_dir = bytecode_dir.join(Path::new(&name));
                std::fs::create_dir(&target_dir);

                WalkDir::new(&info.path)
                    .into_iter()
                    .filter_map(|e| e.ok())
                    .filter(|e| {
                        e.path().extension().is_some() && e.path().extension().unwrap() == "bc"
                    })
                    .for_each(|e| {
                        std::fs::copy(
                            e.path(),
                            target_dir.join(Path::new(e.path().file_name().unwrap())),
                        )
                        .unwrap();
                    });

                Ok(())
            } else {
                Err(CompileError::CleanFailure(output))
            };

            clean_one(&info.path).unwrap();

            (name.as_ref(), result)
        })
        .collect()
}

pub fn analyze_all<'a>(
    sources: &'a CrateCollection,
    bytecode_dir: &Path,
) -> Vec<(&'a str, Result<(), CompileError>)> {
    let dirs: Vec<_> = std::fs::read_dir(&bytecode_dir)
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
            //// opt -enable-new-pm=0 -dot-callgraph
            let output = std::process::Command::new("opt")
                .arg("-enable-new-pm=0")
                .arg("-dot-callgraph")
                .arg(bc_entry.path())
                .current_dir(crate_bc_dir.path())
                .output()
                .unwrap();
        }
    });

    vec![]
}

pub fn to_json<'a>(
    sources: &'a CrateCollection,
    bytecode_dir: &Path,
) -> Vec<(&'a str, Result<(), CompileError>)> {
    use petgraph::visit::EdgeRef;

    let dirs: Vec<_> = std::fs::read_dir(&bytecode_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.path().to_path_buf())
        .collect();

    dirs.par_iter().for_each(|crate_bc_dir| {
        let crate_full_name = crate_bc_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();

        let (crate_name, crate_version) = crate_full_name.rsplit_once("-").unwrap();

        let json_crate = json::object! {
            ty: "crate",
            name: crate_name,
            version: crate_version,
        };
        let mut json_nodes = vec![];
        let mut json_edges = vec![];

        for dot_path in std::fs::read_dir(crate_bc_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some() && e.path().extension().unwrap() == "dot")
        {
            if let Ok(graph) = graph::from_dot_file(dot_path.path()) {
                graph.node_weights().for_each(|n| {
                    json_nodes.push(json::object! {
                        ty: "function",
                        "crate": crate_name,
                        "crate_version": crate_version,
                        "name": n.clone()
                    });
                });

                graph.edge_references().for_each(|e| {
                    json_edges.push(json::object! {
                        ty: "call",
                        "crate": crate_name,
                        "crate_version": crate_version,
                        "caller": graph[e.source()].clone(),
                        "callee": graph[e.target()].clone(),
                    })
                });
            } else {
                println!("! FAILED {}", dot_path.path().display());
            }
        }

        std::fs::write(
            crate_bc_dir.join("crate.json"),
            json::stringify_pretty(json_crate, 4),
        )
        .unwrap();
        std::fs::write(
            crate_bc_dir.join("functions.json"),
            json::stringify_pretty(json_nodes, 4),
        )
        .unwrap();
        std::fs::write(
            crate_bc_dir.join("edges.json"),
            json::stringify_pretty(json_edges, 4),
        )
        .unwrap();
    });

    vec![]
}

#[tokio::main]
async fn main() -> Result<(), CompileError> {
    env_logger::init();

    let args = Args::parse();
    log::trace!("{:?}", args);

    let sources = get_crate_sources(&args.source_dir)?;
    let results = match args.command {
        Command::Analyze { bytecode_dir } => analyze_all(&sources, &bytecode_dir),

        Command::CompileAll { bytecode_dir } => compile_all(&sources, &bytecode_dir),
        Command::CleanAll => clean_all(&sources),

        Command::ToJson { bytecode_dir } => to_json(&sources, &bytecode_dir),
    };
    let failures: Vec<_> = results
        .into_iter()
        .filter(|(name, result)| result.is_err())
        .collect();

    failures
        .iter()
        .for_each(|(name, failure)| println!("failed - {}", name));

    Ok(())
}
