#![deny(clippy::all, clippy::pedantic)]
#![feature(string_remove_matches)]
#![feature(iter_array_chunks)]

use clap::{Parser, Subcommand, ValueHint};
use db::Db;
use rayon::prelude::*;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use walkdir::WalkDir;

pub mod analysis;
pub mod db;
pub mod index;

/// Top error type returned during any stage of analysis from compile to data import.
#[derive(thiserror::Error, Debug)]
pub enum Error {
    ///
    #[error("IO Error: {0}")]
    IoError(#[from] std::io::Error),
    #[error(
        "Crate name contained invalid characters or did not match the NAME-VER format. Name: {0}"
    )]
    ///
    CrateNameError(String),
    ///
    #[error("Crate compilation failed")]
    CompileFailed,
    ///
    #[error("Clean stage failed")]
    CleanFailure(std::process::Output),
    ///
    #[error("LLVM IR failure: {0}")]
    LLVMError(String),
    ///
    #[error("Database Error: {0}")]
    DbError(#[from] db::Error),
    ///
    #[error("Indexing Error: {0}")]
    IndexError(#[from] index::Error),
}

/// Top level arguments
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// The command stage to execute.
    #[command(subcommand)]
    command: Command,
}

#[derive(clap::Args, Debug)]
struct Roots {
    /// Root directory containing the extracted sources tree.
    #[arg(short = 's', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub sources_root: PathBuf,
    /// Root directory containing bytecodes, matching the name-version layout of the source tree.
    /// Can be the same root path to output bytecode artifacts into the source tree.
    #[arg(short = 'b', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub bytecodes_root: PathBuf,
}

impl Roots {
    fn get_crate_sources(&self) -> Result<HashMap<String, CrateSource>, Error> {
        let sources = get_crate_sources(&self.sources_root)?;
        log::trace!("Extracted valid sources, n={}", sources.len());

        Ok(sources)
    }
}

/// Command stages of painter to execute.
#[derive(Subcommand, Debug)]
enum Command {
    /// Compile a single crate from the source tree.
    Compile {
        /// The full name and version of the crate to compile. Must match folder name in source tree.
        #[arg(short = 'c')]
        crate_fullname: String,
        #[command(flatten)]
        roots: Roots,
    },
    /// Compile all crates found within the source tree.
    CompileAll {
        #[command(flatten)]
        roots: Roots,
    },
    /// Export all crates with built bytecode to the neo4j database
    ExportAllNeo4j {
        #[arg(short = 's')]
        server: String,
        #[arg(short = 'u')]
        username: String,
        #[arg(short = 'p')]
        password: String,
        #[command(flatten)]
        roots: Roots,
    },
    SemverCheck,

    // Database operations
    CreateFreshDb {
        #[arg(short = 's')]
        server: String,
        #[arg(short = 'u')]
        username: String,
        #[arg(short = 'p')]
        password: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CrateSource {
    name: String,
    version: String,
    path: PathBuf,
}

pub type CrateCollection = HashMap<String, CrateSource>;

///
/// # Panics
/// asdf
/// # Errors
/// asdf
pub fn get_crate_sources<P: AsRef<Path>>(
    source_dir: &P,
) -> Result<HashMap<String, CrateSource>, Error> {
    let mut sources = HashMap::new();

    for e in std::fs::read_dir(source_dir.as_ref())?.filter_map(Result::ok) {
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

///
/// # Panics
/// asdf
/// # Errors
/// asdf
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
            .filter_map(Result::ok)
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

fn compile_all<P: AsRef<Path> + Send + Sync>(sources: &CrateCollection, bc_root: P) {
    sources.par_iter().for_each(|(name, info)| {
        compile_crate(info, bc_root.as_ref());
    });
}

#[smol_potat::main]
async fn main() -> Result<(), Error> {
    env_logger::init();

    let args = Args::parse();
    log::trace!("{:?}", args);

    match args.command {
        Command::CreateFreshDb {
            server,
            username,
            password,
        } => {
            let db = Arc::new(Db::connect(server, username, password).await?);
            index::create_fresh_db(db).await?;
        }
        Command::Compile {
            crate_fullname,
            roots,
        } => {
            let sources = roots.get_crate_sources()?;
            compile_crate(&sources[&crate_fullname], &roots.bytecodes_root)?;
        }
        Command::CompileAll { roots } => {
            compile_all(&roots.get_crate_sources()?, &roots.bytecodes_root);
        }
        Command::ExportAllNeo4j {
            server,
            username,
            password,
            roots,
        } => {
            let db = Arc::new(Db::connect(server, username, password).await?);
            analysis::export_all_db(&roots.bytecodes_root, db).await?;
        }
        Command::SemverCheck => {
            use std::sync::{Arc, Mutex};

            let index = crates_index::Index::new_cargo_default().unwrap();
            let mut invalid_versions = Arc::new(Mutex::new(std::collections::HashSet::new()));

            index
                .crates_parallel()
                .filter_map(Result::ok)
                .for_each(|c| {
                    c.versions().iter().for_each(|v| {
                        if let Err(e) = lenient_semver::parse(v.version()) {
                            invalid_versions
                                .lock()
                                .unwrap()
                                .insert(v.version().to_string());
                        }
                    });
                });
            println!("invalid versions: {:?}", invalid_versions.lock().unwrap());
        }
    }

    Ok(())
}
