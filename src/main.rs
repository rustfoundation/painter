#![deny(clippy::all, clippy::pedantic)]
#![allow(clippy::enum_variant_names)]
#![feature(string_remove_matches)]
#![feature(iter_array_chunks)]
mod analysis;
mod compile;
mod crate_fs;
mod db;
mod index;

use clap::{Parser, Subcommand};
use crate_fs::{CrateFs, CrateFsConfig};
use db::Db;
use rayon::prelude::*;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

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
    #[error("LLVM IR failure: {0}")]
    LLVMError(String),
    ///
    #[error("Database Error: {0}")]
    DbError(#[from] db::Error),
    ///
    #[error("Indexing Error: {0}")]
    IndexError(#[from] index::Error),
    ///
    #[error("Indexing Error: {0}")]
    CrateFsError(#[from] crate_fs::Error),
    ///
    #[error("MissingCompressedPath")]
    MissingCompressedPath,
    ///
    #[error("MissingExtractedSourcesPath")]
    MissingExtractedSourcesPath,
}

/// Top level arguments
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// The command stage to execute.
    #[command(subcommand)]
    command: Command,
}

/// Clap argument object for specifying the root paths to be used for this work session.
/// These folders are as follows:
/// `sources_root`: A location that all crate sources to be analyzed have been extracted to in the format of
/// `sources_root/<name>-<version>`
/// `bytecodes_root`: A location that all bytecodes will be emitted via `rustc`, distributed in folders
/// in the format of `sources_root/<name>-<version>`
#[derive(clap::Args, Debug, Clone)]
struct Roots {
    /// Root directory containing the extracted sources tree.
    #[arg(short = 's', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub sources_root: PathBuf,
    /// Root directory containing bytecodes, matching the name-version layout of the source tree.
    /// Can be the same root path to output bytecode artifacts into the source tree.
    #[arg(short = 'b', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub bytecodes_root: Option<PathBuf>,

    #[arg(short = 'c', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub compressed_root: PathBuf,
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
        #[arg(short = 'd')]
        host: String,
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
        #[arg(short = 'd')]
        host: String,
        #[arg(short = 'u')]
        username: String,
        #[arg(short = 'p')]
        password: String,
    },
    // Database operations
    UpdateDb {
        #[arg(short = 'd')]
        host: String,
        #[arg(short = 'u')]
        username: String,
        #[arg(short = 'p')]
        password: String,
    },
    // Database operations
    SetLatestVersions {
        #[arg(short = 'd')]
        host: String,
        #[arg(short = 'u')]
        username: String,
        #[arg(short = 'p')]
        password: String,
    },
    CountUnsafe {
        #[command(flatten)]
        roots: Roots,
        #[arg(short = 'd')]
        host: String,
        #[arg(short = 'u')]
        username: String,
        #[arg(short = 'p')]
        password: String,
    },
}

/// Container object for storing the information of a given crate.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CrateSource {
    /// The crates name
    name: String,
    /// The crates semver version in `String` format.
    version: String,
    /// The fully qualified path the crate source was discovered and is located.
    path: PathBuf,
}

fn cratefs_from_roots(roots: &Roots) -> Result<CrateFs, Error> {
    // Queue up the caching FS
    Ok(CrateFs::new(CrateFsConfig::with_paths(
        roots.compressed_root.clone(),
        roots.sources_root.clone(),
    ))?)
}

#[tokio::main(flavor = "multi_thread", worker_threads = 32)]
async fn main() -> Result<(), Error> {
    env_logger::init();

    let args = Args::parse();
    log::trace!("{:?}", args);

    match args.command {
        Command::CreateFreshDb {
            host,
            username,
            password,
        } => {
            let db = Arc::new(Db::connect(host, username, password).await?);
            index::create_fresh_db(db).await?;
        }
        Command::UpdateDb {
            host,
            username,
            password,
        } => {
            let db = Arc::new(Db::connect(host, username, password).await?);
            //index::update_missing_crates(db.clone()).await?;
            index::update_missing_versions(db.clone()).await?;
        }
        Command::SetLatestVersions {
            host,
            username,
            password,
        } => {
            let db = Arc::new(Db::connect(host, username, password).await?);
            //index::update_missing_crates(db.clone()).await?;
            index::set_latest_versions(db.clone()).await?;
        }
        Command::Compile {
            crate_fullname,
            roots,
        } => {
            // let sources = roots.get_crate_sources()?;
            //compile_crate(&sources[&crate_fullname], roots.bytecodes_root.unwrap())?;
        }
        Command::CompileAll { roots } => {
            compile::compile_all(cratefs_from_roots(&roots)?, roots.bytecodes_root.unwrap())
                .await
                .unwrap();
        }
        Command::CountUnsafe {
            roots,
            host,
            username,
            password,
        } => {
            let db = Arc::new(Db::connect(host, username, password).await?);
            analysis::count_unsafe(&roots, db).await?;
        }
        Command::ExportAllNeo4j {
            host,
            username,
            password,
            roots,
        } => {
            let db = Arc::new(Db::connect(host, username, password).await?);
            analysis::export_all_db(&roots.bytecodes_root.unwrap(), db).await?;
        }
        Command::SemverCheck => {
            let index = crates_index::Index::new_cargo_default().unwrap();
            let invalid_versions = Arc::new(Mutex::new(std::collections::HashSet::new()));

            index
                .crates_parallel()
                .filter_map(Result::ok)
                .for_each(|c| {
                    c.versions().iter().for_each(|v| {
                        if lenient_semver::parse(v.version()).is_err() {
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
