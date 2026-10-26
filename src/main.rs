#![deny(clippy::all, clippy::pedantic)]

use clap::{Parser, Subcommand, builder::TypedValueParser as _};
use libpainter::{
    Error, Roots, analysis, check, compile,
    db::Db,
    ecosystems::EcosystemsClient,
    index, metadata, migrate,
    rules::{BuildEverything, BuildRules, EcosystemsRules, NamedCrates},
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
#[allow(clippy::struct_field_names)]
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
    /// Password (also `$NEO4J_PASSWORD`). Prefer `--password-file`, which keeps it out of the
    /// process list and `docker inspect`.
    #[arg(short = 'p', env = "NEO4J_PASSWORD", hide_env_values = true)]
    password: Option<String>,
    /// Read the password from this file (also `$NEO4J_PASSWORD_FILE`); a trailing newline is
    /// ignored.
    #[arg(
        long,
        value_name = "FILE",
        env = "NEO4J_PASSWORD_FILE",
        conflicts_with = "password"
    )]
    password_file: Option<PathBuf>,
}

impl DbArgs {
    fn password(&self) -> Result<String, Error> {
        match (&self.password, &self.password_file) {
            (Some(p), _) => Ok(p.clone()),
            (None, Some(f)) => Ok(std::fs::read_to_string(f)?
                .trim_end_matches(['\r', '\n'])
                .to_string()),
            (None, None) => Err(Error::MissingPassword),
        }
    }

    async fn connect(self) -> Result<Arc<Db>, Error> {
        let password = self.password()?;
        Ok(Arc::new(
            Db::connect(self.host, self.username, password).await?,
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
    /// versions have bytecode, a `(Version)` node, and an exported call graph.
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
        /// Also load registry facts (publishers, owners, dates, downloads, ...) for these crates
        /// from this extracted crates.io database dump (the `registry` metadata job).
        #[arg(long, value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        cratesio_dump: Option<PathBuf>,
    },
    /// Stream the whole database into `neo4j-admin database import` CSV files, converting the
    /// old `INVOKES` call edges to the `HAS_FN`/`CALLS`/`Symbol` schema. Only reads the database.
    ExportForImport {
        #[command(flatten)]
        db: DbArgs,
        /// Directory for the CSV files (created if missing).
        #[arg(long)]
        out: PathBuf,
        /// Where the import process will see `--out`, for the printed `neo4j-admin` command.
        #[arg(long, default_value = "/import")]
        import_dir: String,
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
        /// Afterwards load registry facts (publishers, owners, dates, downloads, ...) from this
        /// extracted crates.io database dump (the `registry` metadata job).
        #[arg(long, value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        cratesio_dump: Option<PathBuf>,
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
    /// Compute per-version metadata straight from the `.crate` tarballs and upsert it on the
    /// `Version` nodes: unsafe-code counts (`unsafe`), build scripts (`build`), vendored
    /// C/C++ (`native`), and per-file line changes against the previous version (`diff`);
    /// plus, from a crates.io database dump, publishers, owners, dates, and downloads
    /// (`registry`, needs `--cratesio-dump`).
    /// Resumes: each job skips versions it already wrote unless `--rescan`.
    GenerateMetadata {
        /// Root directory containing the compressed `.crate` files.
        #[arg(short = 'c', value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        compressed_root: PathBuf,
        #[command(flatten)]
        db: DbArgs,
        /// Worker threads (default: a quarter of the CPUs).
        #[arg(short = 'j', long)]
        threads: Option<usize>,
        /// Run only these jobs (repeatable or comma-separated, e.g. `--job diff` to populate one
        /// new job in isolation). Versions are only read when a selected job is pending for them.
        /// Default: all.
        #[arg(
            long = "job",
            value_name = "JOB",
            value_delimiter = ',',
            value_parser = clap::builder::PossibleValuesParser::new(metadata::Job::ALL.map(metadata::Job::name))
                .map(|s| s.parse::<metadata::Job>().expect("listed as a possible value")),
        )]
        jobs: Vec<metadata::Job>,
        /// Only these crates (repeatable).
        #[arg(long, value_name = "CRATE")]
        only: Vec<String>,
        /// Only versions flagged `latest`.
        #[arg(long)]
        latest_only: bool,
        /// Rerun the selected jobs where they are already current.
        #[arg(long)]
        rescan: bool,
        /// Extracted crates.io database dump (`db-dump.tar.gz` from static.crates.io) for the
        /// `registry` job; without it that job is skipped.
        #[arg(long, value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        cratesio_dump: Option<PathBuf>,
    },
}

#[tokio::main(flavor = "multi_thread", worker_threads = 32)]
#[allow(clippy::too_many_lines)]
async fn main() -> Result<(), Error> {
    env_logger::init();

    let args = Args::parse();
    log::trace!("{args:?}");

    match args.command {
        Command::CreateFreshDb {
            db,
            only,
            cratesio_dump,
        } => {
            let db = db.connect().await?;
            index::create_fresh_db(db.clone(), &only).await?;
            if let Some(dump) = cratesio_dump {
                metadata::import_registry(db, dump, only).await?;
            }
        }
        Command::UpdateDb { db } => {
            index::update_missing_versions(db.connect().await?).await?;
        }
        Command::SetLatestVersions { db } => {
            index::set_latest_versions(db.connect().await?).await?;
        }
        Command::ImportCrates {
            db,
            names,
            cratesio_dump,
        } => {
            let db = db.connect().await?;
            index::import_crates(&names, db.clone()).await?;
            if let Some(dump) = cratesio_dump {
                metadata::import_registry(db, dump, names).await?;
            }
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
        Command::GenerateMetadata {
            compressed_root,
            db,
            threads,
            jobs,
            only,
            latest_only,
            rescan,
            cratesio_dump,
        } => {
            let opts = metadata::Options {
                cratesio_dump,
                threads,
                jobs,
                only,
                latest_only,
                rescan,
                ..metadata::Options::default()
            };
            metadata::generate_metadata(compressed_root, db.connect().await?, opts).await?;
        }
        Command::ExportForImport {
            db,
            out,
            import_dir,
        } => {
            let password = db.password()?;
            let summary =
                migrate::export_for_import(&db.host, &db.username, &password, &out).await?;
            println!("{summary:#?}");
            println!(
                "\nneo4j-admin database import full neo4j --overwrite-destination \\\n    --multiline-fields=true --skip-bad-relationships=false \\\n    {}",
                migrate::import_args(&import_dir).join(" \\\n    ")
            );
            println!("\nThen create the schema:\n{}", migrate::SCHEMA_CYPHER);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Args {
        Args::try_parse_from(std::iter::once("painter").chain(args.iter().copied())).unwrap()
    }

    const DB: [&str; 6] = ["-d", "bolt://127.0.0.1:7687", "-u", "neo4j", "-p", "pw"];
    const ROOTS: [&str; 6] = ["-s", "/src", "-c", "/crates", "-b", "/bc"];

    #[test]
    fn roots_args_convert_to_roots() {
        let args = parse(&[&["compile-check"][..], &DB, &ROOTS].concat());
        let Command::CompileCheck {
            roots, verbose, db, ..
        } = args.command
        else {
            panic!("wrong command")
        };
        assert!(!verbose);
        assert_eq!(db.host, "bolt://127.0.0.1:7687");
        let roots = Roots::from(roots);
        assert_eq!(roots.sources_root, PathBuf::from("/src"));
        assert_eq!(roots.compressed_root, PathBuf::from("/crates"));
        assert_eq!(roots.bytecodes_root, Some(PathBuf::from("/bc")));
    }

    #[test]
    fn compile_all_jobs_flag() {
        let args = parse(
            &[
                &["compile-all", "-j", "4", "--toolchain", "1.96.1"][..],
                &ROOTS,
            ]
            .concat(),
        );
        let Command::CompileAll {
            jobs,
            toolchain,
            update_only,
            ..
        } = args.command
        else {
            panic!("wrong command")
        };
        assert_eq!(jobs, Some(4));
        assert_eq!(toolchain, "1.96.1");
        assert!(update_only);

        let args = parse(&[&["compile-all"][..], &ROOTS].concat());
        let Command::CompileAll {
            jobs, toolchain, ..
        } = args.command
        else {
            panic!("wrong command")
        };
        assert_eq!(jobs, None);
        assert_eq!(toolchain, compile::DEFAULT_TOOLCHAIN);

        let zero = [&["compile-all", "-j", "0"][..], &ROOTS].concat();
        assert!(Args::try_parse_from(std::iter::once("painter").chain(zero)).is_err());
    }

    #[test]
    fn generate_metadata_job_flag() {
        let jobs = |extra: &[&str]| {
            let args = parse(&[&["generate-metadata", "-c", "/crates"][..], &DB, extra].concat());
            let Command::GenerateMetadata { jobs, .. } = args.command else {
                panic!("wrong command")
            };
            jobs
        };
        assert_eq!(jobs(&[]), vec![]);
        assert_eq!(jobs(&["--job", "diff"]), vec![metadata::Job::Diff]);
        assert_eq!(
            jobs(&["--job", "build,native", "--job", "unsafe"]),
            vec![
                metadata::Job::Build,
                metadata::Job::Native,
                metadata::Job::Unsafe
            ]
        );
        let bad = [
            &["generate-metadata", "-c", "/crates", "--job", "nope"][..],
            &DB,
        ]
        .concat();
        let err = Args::try_parse_from(std::iter::once("painter").chain(bad)).unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::InvalidValue);
    }

    #[test]
    fn db_password_from_flag_or_file() {
        let args = parse(&[&["set-latest-versions"][..], &DB].concat());
        let Command::SetLatestVersions { db } = args.command else {
            panic!("wrong command")
        };
        assert_eq!(db.password().unwrap(), "pw");

        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), "s3cret\n").unwrap();
        let file = tmp.path().to_str().unwrap();
        let args = parse(&[
            "set-latest-versions",
            "-d",
            "bolt://x",
            "-u",
            "neo4j",
            "--password-file",
            file,
        ]);
        let Command::SetLatestVersions { db } = args.command else {
            panic!("wrong command")
        };
        assert_eq!(db.password().unwrap(), "s3cret", "trailing newline dropped");

        let both = [
            "set-latest-versions",
            "-d",
            "x",
            "-u",
            "u",
            "-p",
            "a",
            "--password-file",
            file,
        ];
        assert!(Args::try_parse_from(std::iter::once("painter").chain(both)).is_err());
    }

    #[test]
    fn bytecodes_root_is_optional_at_parse_time() {
        let args = parse(&["compile", "serde-1.0.0", "-s", "/src", "-c", "/crates"]);
        let Command::Compile {
            roots,
            crate_fullname,
            ..
        } = args.command
        else {
            panic!("wrong command")
        };
        assert_eq!(crate_fullname, "serde-1.0.0");
        assert!(matches!(
            Roots::from(roots).bytecodes_root(),
            Err(Error::MissingBytecodesPath)
        ));
    }

    #[tokio::test]
    async fn rules_args_pick_the_right_policy() {
        let rules = |extra: &[&str]| {
            let args = parse(&[&["plan"][..], extra].concat());
            let Command::Plan { rules } = args.command else {
                panic!("wrong command")
            };
            rules
        };

        let r = rules(&[]).into_rules().unwrap();
        assert_eq!(r.candidate_crates().await.unwrap(), None);

        let r = rules(&["--only", "serde", "--only", "tokio"])
            .into_rules()
            .unwrap();
        assert_eq!(
            r.candidate_crates().await.unwrap(),
            Some(vec!["serde".to_string(), "tokio".to_string()])
        );

        // With --only, candidate_crates needs no network even under ecosyste.ms rules.
        let r = rules(&["--only", "serde", "--newer-than", "2024-01-01"])
            .into_rules()
            .unwrap();
        assert_eq!(
            r.candidate_crates().await.unwrap(),
            Some(vec!["serde".to_string()])
        );
        assert!(matches!(
            rules(&["--newer-than", "someday"]).into_rules(),
            Err(Error::RulesError(_))
        ));
    }

    #[test]
    fn rules_args_parse_numeric_selectors() {
        let args = parse(&[
            "plan",
            "--top-downloads",
            "10",
            "--top-reverse-deps",
            "20",
            "--top-maintainers",
            "3",
            "--all-versions",
        ]);
        let Command::Plan { rules } = args.command else {
            panic!("wrong command")
        };
        assert_eq!(rules.top_downloads, Some(10));
        assert_eq!(rules.top_reverse_deps, Some(20));
        assert_eq!(rules.top_maintainers, Some(3));
        assert!(rules.all_versions);
        assert_eq!(
            rules.ecosystems_url,
            libpainter::ecosystems::DEFAULT_BASE_URL
        );
    }

    #[test]
    fn import_crates_requires_a_name() {
        let none = [&["import-crates"][..], &DB].concat();
        assert!(Args::try_parse_from(std::iter::once("painter").chain(none)).is_err());
        let args = parse(&[&["import-crates"][..], &DB, &["serde"]].concat());
        assert!(matches!(args.command, Command::ImportCrates { names, .. } if names == ["serde"]));
    }
}
