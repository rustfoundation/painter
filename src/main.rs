#![feature(string_remove_matches)]

use clap::{Parser, Subcommand, ValueHint};
use rayon::prelude::*;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

pub mod analysis;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("{0}")]
    IoError(#[from] std::io::Error),
    #[error("CrateNameError")]
    CrateNameError(String),
    #[error("CompileFailed")]
    CompileFailed,
    #[error("CleanFailure")]
    CleanFailure(std::process::Output),
    #[error("{0}")]
    LLVMError(String),
}

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(short = 's', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub sources_root: PathBuf,

    #[arg(short = 'b', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub bytecodes_root: PathBuf,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    Compile {
        #[arg(short = 'c')]
        crate_fullname: String,
    },
    CompileAll,
    ExportAllNeo4j,
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
) -> Result<HashMap<String, CrateSource>, Error> {
    let mut sources = HashMap::new();

    for e in std::fs::read_dir(source_dir.as_ref())?.filter_map(|e| e.ok()) {
        if e.metadata().unwrap().is_dir() {
            let path = e.path();
            let full_name = path
                .file_name()
                .ok_or(Error::CrateNameError(path.display().to_string()))?
                .to_string_lossy()
                .to_string();
            let (name, version) = full_name
                .rsplit_once('-')
                .ok_or(Error::CrateNameError(full_name.clone()))?;

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

fn compile_crate<P: AsRef<Path>>(target: &CrateSource, bc_root: P) -> Result<PathBuf, Error> {
    let fullname = format!("{}-{}", &target.name, &target.version);
    let output_dir = bc_root.as_ref().join(&fullname);

    log::debug!("Compiling: {} @ {}", &fullname, output_dir.display());

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
        .current_dir(&target.path)
        .output()
        .unwrap();

    log::trace!("Compiled: {} with result: {:?}", fullname, output);

    let result = if output.status.success() {
        std::fs::create_dir(&output_dir);

        WalkDir::new(&target.path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some() && e.path().extension().unwrap() == "bc")
            .for_each(|e| {
                std::fs::copy(
                    e.path(),
                    output_dir.join(Path::new(e.path().file_name().unwrap())),
                )
                .unwrap();
            });

        Ok(output_dir)
    } else {
        Err(Error::CompileFailed)
    };

    clean(&target.path)?;

    result
}

fn compile_all<P: AsRef<Path> + Send + Sync>(
    sources: &CrateCollection,
    bc_root: P,
) -> Result<(), Error> {
    sources.par_iter().for_each(|(name, info)| {
        compile_crate(info, bc_root.as_ref());
    });

    Ok(())
}

#[smol_potat::main]
async fn main() -> Result<(), Error> {
    env_logger::init();

    let args = Args::parse();
    log::trace!("{:?}", args);

    let sources = get_crate_sources(&args.sources_root)?;
    log::trace!("Extracted valid sources, n={}", sources.len());

    match args.command {
        Command::Compile { crate_fullname } => {
            compile_crate(&sources[&crate_fullname], &args.bytecodes_root)?;
        }
        Command::CompileAll => {
            compile_all(&sources, &args.bytecodes_root)?;
        }
        Command::ExportAllNeo4j => {
            analysis::export_all_neo4j(&args.bytecodes_root);
        }
    }

    Ok(())
}
