#![deny(clippy::all, clippy::pedantic)]

use clap::{Parser, Subcommand};
use libpainter::{
    analysis, check, compile,
    db::Db,
    ecosystems::EcosystemsClient,
    index,
    rules::{BuildEverything, BuildRules, EcosystemsRules, NamedCrates},
    Error, Roots,
};
use rayon::prelude::*;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

/// Top level arguments
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// The command stage to execute.
    #[command(subcommand)]
    command: Command,
}

/// Clap argument object for specifying the root paths to be used for this work session.
/// See [`libpainter::Roots`] for the meaning of each directory.
#[derive(clap::Args, Debug, Clone)]
#[allow(clippy::struct_field_names)] // mirrors `libpainter::Roots`
struct RootsArgs {
    /// Root directory containing the extracted sources tree.
    #[arg(short = 's', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub sources_root: PathBuf,
    /// Root directory containing bytecodes, matching the name-version layout of the source tree.
    /// Can be the same root path to output bytecode artifacts into the source tree.
    #[arg(short = 'b', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub bytecodes_root: Option<PathBuf>,
    /// Root directory containing the compressed `.crate` files.
    #[arg(short = 'c', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
    pub compressed_root: PathBuf,
}

impl From<RootsArgs> for Roots {
    fn from(args: RootsArgs) -> Self {
        Self {
            sources_root: args.sources_root,
            bytecodes_root: args.bytecodes_root,
            compressed_root: args.compressed_root,
        }
    }
}

/// Build-rule selection. With no `--top-*` flag and no `--only`, every crate in the index is a
/// candidate. `--top-*` flags combine as a union. `--newer-than` filters versions by publish
/// date (from ecosyste.ms). See `libpainter::rules::BuildRules` to supply custom policies.
#[derive(clap::Args, Debug, Clone)]
struct RulesArgs {
    /// Consider every non-yanked version, not just the highest.
    #[arg(long)]
    all_versions: bool,
    /// Restrict to these crate names (repeatable). Combines with `--top-*` as a union.
    #[arg(long = "only", value_name = "CRATE")]
    only: Vec<String>,
    /// Top N crates by total downloads (ecosyste.ms).
    #[arg(long, value_name = "N")]
    top_downloads: Option<usize>,
    /// Top N crates by number of dependent packages (ecosyste.ms).
    #[arg(long, value_name = "N")]
    top_reverse_deps: Option<usize>,
    /// Every crate of the top N maintainers by total downloads (ecosyste.ms, full scan).
    #[arg(long, value_name = "N")]
    top_maintainers: Option<usize>,
    /// Only versions published after this date (YYYY-MM-DD or RFC 3339), via ecosyste.ms.
    #[arg(long, value_name = "DATE")]
    newer_than: Option<String>,
    /// ecosyste.ms API base URL.
    #[arg(long, value_name = "URL", default_value = libpainter::ecosystems::DEFAULT_BASE_URL)]
    ecosystems_url: String,
}

impl RulesArgs {
    fn into_rules(self) -> Result<Box<dyn BuildRules>, Error> {
        let uses_ecosystems = self.top_downloads.is_some()
            || self.top_reverse_deps.is_some()
            || self.top_maintainers.is_some()
            || self.newer_than.is_some();
        if !uses_ecosystems {
            if !self.only.is_empty() {
                return Ok(Box::new(NamedCrates {
                    names: self.only,
                    all_versions: self.all_versions,
                }));
            }
            return Ok(Box::new(BuildEverything {
                all_versions: self.all_versions,
            }));
        }

        let newer_than = self
            .newer_than
            .as_deref()
            .map(EcosystemsRules::parse_date)
            .transpose()?;

        Ok(Box::new(EcosystemsRules {
            client: EcosystemsClient::new(&self.ecosystems_url),
            crates: self.only,
            top_downloads: self.top_downloads,
            top_reverse_dependencies: self.top_reverse_deps,
            top_maintainers: self.top_maintainers,
            newer_than,
            all_versions: self.all_versions,
        }))
    }
}

/// Neo4j connection parameters shared by every database-touching stage.
#[derive(clap::Args, Debug, Clone)]
struct DbArgs {
    /// Bolt URI of the neo4j server, e.g. `bolt://127.0.0.1:7687`.
    #[arg(short = 'd')]
    host: String,
    #[arg(short = 'u')]
    username: String,
    #[arg(short = 'p')]
    password: String,
}

impl DbArgs {
    async fn connect(self) -> Result<Arc<Db>, Error> {
        Ok(Arc::new(
            Db::connect(self.host, self.username, self.password).await?,
        ))
    }
}

/// Command stages of painter to execute.
#[derive(Subcommand, Debug)]
enum Command {
    /// Compile a single crate from the source tree.
    Compile {
        /// The full name and version of the crate to compile (`<name>-<version>`). Must match the
        /// `.crate` filename in the compressed root.
        #[arg(value_name = "NAME-VERSION")]
        crate_fullname: String,
        /// rustup toolchain to compile with (`cargo +<toolchain>`).
        #[arg(long, default_value = compile::DEFAULT_TOOLCHAIN)]
        toolchain: String,
        #[command(flatten)]
        roots: RootsArgs,
    },
    /// Compile crates selected by the build rules (default: every crate in the index).
    CompileAll {
        /// Skip crate versions that already have a bytecode directory.
        #[arg(long, short = 'u', default_value = "true")]
        update_only: bool,
        /// rustup toolchain to compile with (`cargo +<toolchain>`).
        #[arg(long, default_value = compile::DEFAULT_TOOLCHAIN)]
        toolchain: String,
        /// Compile at most N crates at a time (default: one per CPU).
        #[arg(long, short = 'j', value_name = "N", value_parser = clap::value_parser!(u64).range(1..))]
        jobs: Option<u64>,
        #[command(flatten)]
        rules: RulesArgs,
        #[command(flatten)]
        roots: RootsArgs,
    },
    /// Compare the index against the bytecode root and the database: how many selected crate
    /// versions have bytecode, a `(Version)` node, and exported `INVOKES` edges.
    CompileCheck {
        /// List every version that is missing bytecode, a database node, or both.
        #[arg(long, short = 'v')]
        verbose: bool,
        #[command(flatten)]
        db: DbArgs,
        #[command(flatten)]
        rules: RulesArgs,
        #[command(flatten)]
        roots: RootsArgs,
    },
    /// Print the crate versions the build rules would select, without compiling.
    Plan {
        #[command(flatten)]
        rules: RulesArgs,
    },
    /// Idempotently import (or refresh) the named crates and all their versions from the index.
    ImportCrates {
        #[command(flatten)]
        db: DbArgs,
        /// Crate names to import.
        #[arg(value_name = "CRATE", required = true)]
        names: Vec<String>,
    },
    /// Export all crates with built bytecode to the neo4j database
    ExportAllNeo4j {
        #[command(flatten)]
        db: DbArgs,
        #[command(flatten)]
        roots: RootsArgs,
    },
    /// List index versions that fail lenient semver parsing.
    SemverCheck,
    /// Populate an empty database with every crate and version in the index.
    /// Import every crate and version from the index. Safe to re-run: existing versions are
    /// skipped, so an interrupted run resumes where it left off.
    CreateFreshDb {
        #[command(flatten)]
        db: DbArgs,
        /// Import only these crates (repeatable); default is the whole index.
        #[arg(long = "only", value_name = "CRATE")]
        only: Vec<String>,
    },
    /// Report versions present in the index but missing from the database.
    UpdateDb {
        #[command(flatten)]
        db: DbArgs,
    },
    /// Flag the highest version of every crate with `latest = true`.
    SetLatestVersions {
        #[command(flatten)]
        db: DbArgs,
    },
    /// Run `count-unsafe` over every crate source and store the totals.
    CountUnsafe {
        #[command(flatten)]
        roots: RootsArgs,
        #[command(flatten)]
        db: DbArgs,
    },
}

#[tokio::main(flavor = "multi_thread", worker_threads = 32)]
#[allow(clippy::too_many_lines)] // one arm per subcommand
async fn main() -> Result<(), Error> {
    env_logger::init();

    let args = Args::parse();
    log::trace!("{args:?}");

    match args.command {
        Command::CreateFreshDb { db, only } => {
            index::create_fresh_db(db.connect().await?, &only).await?;
        }
        Command::UpdateDb { db } => {
            index::update_missing_versions(db.connect().await?).await?;
        }
        Command::SetLatestVersions { db } => {
            index::set_latest_versions(db.connect().await?).await?;
        }
        Command::ImportCrates { db, names } => {
            index::import_crates(&names, db.connect().await?).await?;
        }
        Command::Compile {
            crate_fullname,
            toolchain,
            roots,
        } => {
            let roots = Roots::from(roots);
            let bc_root = roots.bytecodes_root()?.clone();
            let mut fs = roots.crate_fs()?;
            let entry = libpainter::crate_fs::CrateEntry::new(&crate_fullname)?;
            let src_path = fs.open_entry(entry.clone())?.path().to_path_buf();
            compile::compile_crate(entry.name(), entry.version(), src_path, bc_root, &toolchain)?;
        }
        Command::CompileAll {
            update_only,
            toolchain,
            jobs,
            rules,
            roots,
        } => {
            let roots = Roots::from(roots);
            let bc_root = roots.bytecodes_root()?.clone();
            let opts = compile::CompileOptions {
                update_only,
                toolchain,
                jobs: jobs.map(|j| usize::try_from(j).unwrap_or(usize::MAX)),
                ..compile::CompileOptions::default()
            };
            let rules = rules.into_rules()?;
            compile::compile_all(roots.crate_fs()?, bc_root, opts, rules.as_ref()).await?;
        }
        Command::CompileCheck {
            verbose,
            db,
            rules,
            roots,
        } => {
            let roots = Roots::from(roots);
            let bc_root = roots.bytecodes_root()?.clone();
            let rules = rules.into_rules()?;
            let opts = compile::CompileOptions::default();
            let report = check::compile_check(
                rules.as_ref(),
                opts.rules_concurrency,
                &bc_root,
                db.connect().await?,
            )
            .await?;
            print!("{}", report.render_summary());
            if verbose {
                println!();
                print!("{}", report.render_missing());
            }
        }
        Command::Plan { rules } => {
            let rules = rules.into_rules()?;
            let opts = compile::CompileOptions::default();
            for (name, version) in compile::plan(rules.as_ref(), opts.rules_concurrency).await? {
                println!("{name}-{version}");
            }
        }
        Command::CountUnsafe { roots, db } => {
            analysis::count_unsafe(&Roots::from(roots), db.connect().await?).await?;
        }
        Command::ExportAllNeo4j { db, roots } => {
            let roots = Roots::from(roots);
            analysis::export_all_db(roots.bytecodes_root()?, db.connect().await?).await?;
        }
        Command::SemverCheck => {
            let index = index::open_index().map_err(libpainter::index::Error::from)?;
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
