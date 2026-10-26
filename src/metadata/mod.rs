//! `generate-metadata`: per-version facts computed from the `.crate` tarballs and upserted on
//! the `(Version)` nodes.
//!
//! The driver ([`generate_metadata`]) parallelizes across crates. For each crate it walks the
//! versions in semver order, reads each needed tarball once into memory ([`SourceTree`]), and
//! hands the tree to every pending job: [`unsafety`] (geiger's unsafe counters), [`build`]
//! (build script), [`native`] (vendored C/C++), and [`diff`] (per-file line changes against the
//! previous version, which the walk keeps in memory). Results stream to a writer that upserts
//! them [`WRITE_BATCH`] versions per transaction and per job.
//!
//! Resumable and duplicate-free: every job writes a done-marker (its revision string) on the
//! version in the same transaction as its data, and every property is `SET`, so a rewrite
//! replaces rather than adds. On start the driver reads all markers ([`Db::metadata_work_list`])
//! and only runs a job where its marker differs from the job's current revision, or, for
//! `diff`, where the stored `diff_base` is no longer the version's predecessor (a newly
//! published backport can slot in between). Stopping, killing, or pausing the run loses at most
//! the in-flight batch, which the next run redoes. A version whose tarball cannot be read gets
//! `meta_error` (and `unsafe_error`) and keeps its other jobs pending, so they are retried.
//!
//! The [`registry`] job is different: it reads no tarballs but a crates.io database dump
//! ([`Options::cratesio_dump`]), and runs as its own phase before the tarball jobs. Without a
//! dump it is skipped unless selected explicitly (`--job registry`), which is an error.
pub mod build;
pub mod diff;
pub mod native;
pub mod registry;
pub mod source;
pub mod unsafety;

use crate::crate_fs::CrateEntry;
use crate::db::{Db, MetaState};
use rayon::prelude::*;
pub use source::SourceTree;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Database Error: {0}")]
    Db(#[from] crate::db::Error),
    #[error("could not build the worker thread pool: {0}")]
    Pool(#[from] rayon::ThreadPoolBuildError),
    #[error("unknown metadata job `{0}` (known: unsafe, build, native, diff, registry)")]
    UnknownJob(String),
    #[error("the registry job needs a crates.io dump (--cratesio-dump DIR)")]
    MissingDump,
    #[error(transparent)]
    Registry(#[from] registry::Error),
}

/// Versions written to Neo4j per transaction (per job).
pub const WRITE_BATCH: usize = 1_000;

/// Changed-file entries per `diff` write transaction; a batch is cut early when exceeded.
const DIFF_ENTRIES_PER_TX: usize = 50_000;

/// Stack size of the worker threads: `syn` recurses per nesting level, and generated code nests
/// deeply.
const WORKER_STACK_BYTES: usize = 128 << 20;

/// Results buffered between the workers and the database writer.
const CHANNEL_DEPTH: usize = 4_096;

/// One metadata job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Job {
    Unsafe,
    Build,
    Native,
    Diff,
    /// crates.io registry facts from a database dump (no tarball).
    Registry,
}

impl Job {
    /// Every job, in run order.
    pub const ALL: [Job; 5] = [
        Job::Unsafe,
        Job::Build,
        Job::Native,
        Job::Diff,
        Job::Registry,
    ];

    /// The job's name on the command line.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Job::Unsafe => "unsafe",
            Job::Build => "build",
            Job::Native => "native",
            Job::Diff => "diff",
            Job::Registry => "registry",
        }
    }

    /// The revision string a version carries once this job has written it.
    #[must_use]
    pub fn revision(self) -> &'static str {
        match self {
            Job::Unsafe => unsafety::SCANNER,
            Job::Build => build::REVISION,
            Job::Native => native::REVISION,
            Job::Diff => diff::REVISION,
            Job::Registry => registry::REVISION,
        }
    }
}

impl std::str::FromStr for Job {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self, Error> {
        Job::ALL
            .into_iter()
            .find(|j| j.name() == s)
            .ok_or_else(|| Error::UnknownJob(s.to_string()))
    }
}

/// Which jobs one version needs (one flag per job, not a state machine).
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pending {
    pub unsafe_: bool,
    pub build: bool,
    pub native: bool,
    pub diff: bool,
}

impl Pending {
    /// No job is pending.
    #[must_use]
    pub fn is_empty(self) -> bool {
        !(self.unsafe_ || self.build || self.native || self.diff)
    }
}

/// How [`generate_metadata`] selects versions and runs.
#[derive(Debug, Clone)]
pub struct Options {
    /// Worker threads. `None` uses a quarter of the CPUs (at least one), since the run usually
    /// shares the machine with a compile sweep.
    pub threads: Option<usize>,
    /// Jobs to run; empty means all of them.
    pub jobs: Vec<Job>,
    /// Only these crates; empty means every crate.
    pub only: Vec<String>,
    /// Only versions flagged `latest` (a `diff` still reads their predecessors).
    pub latest_only: bool,
    /// Rerun the selected jobs even where their markers are current.
    pub rescan: bool,
    /// Files larger than this are listed but not loaded (unsafe counts them as failed, diff as
    /// binary).
    pub max_file_bytes: u64,
    /// Extracted crates.io database dump for the `registry` job.
    pub cratesio_dump: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            threads: None,
            jobs: Vec::new(),
            only: Vec::new(),
            latest_only: false,
            rescan: false,
            max_file_bytes: 64 << 20,
            cratesio_dump: None,
        }
    }
}

impl Options {
    fn runs(&self, job: Job) -> bool {
        self.jobs.is_empty() || self.jobs.contains(&job)
    }
}

/// A crate's versions in semver order, with their stored markers.
#[derive(Debug, Clone)]
pub struct CrateWork {
    pub name: String,
    pub versions: Vec<MetaState>,
}

/// Group a work list by crate and sort each crate's versions by semver (unparsable versions,
/// which the import never creates, last and by string).
#[must_use]
pub fn group_by_crate(states: Vec<MetaState>) -> Vec<CrateWork> {
    let mut by_crate: HashMap<String, Vec<MetaState>> = HashMap::new();
    for s in states {
        by_crate.entry(s.name.clone()).or_default().push(s);
    }
    let mut out: Vec<CrateWork> = by_crate
        .into_iter()
        .map(|(name, mut versions)| {
            versions.sort_by_cached_key(|v| {
                let semver = crate::db::parse_semver(&v.version).ok();
                (semver.is_none(), semver, v.version.clone())
            });
            CrateWork { name, versions }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// What each of a crate's versions (in the given order) still needs.
#[must_use]
pub fn plan(work: &CrateWork, opts: &Options) -> Vec<Pending> {
    let stale = |marker: &Option<String>, job: Job| {
        opts.rescan || marker.as_deref() != Some(job.revision())
    };
    work.versions
        .iter()
        .enumerate()
        .map(|(i, v)| {
            if opts.latest_only && !v.latest {
                return Pending::default();
            }
            let predecessor = i.checked_sub(1).map(|p| work.versions[p].version.as_str());
            Pending {
                unsafe_: opts.runs(Job::Unsafe)
                    && (stale(&v.unsafe_scanner, Job::Unsafe) || v.unsafe_error),
                build: opts.runs(Job::Build) && stale(&v.meta_build, Job::Build),
                native: opts.runs(Job::Native) && stale(&v.meta_native, Job::Native),
                diff: opts.runs(Job::Diff)
                    && (stale(&v.meta_diff, Job::Diff) || v.diff_base.as_deref() != predecessor),
            }
        })
        .collect()
}

/// Everything computed for one version; `None` fields were not pending (or not computable).
#[derive(Debug, Clone, Default)]
pub struct VersionMeta {
    pub name: String,
    pub version: String,
    pub unsafe_: Option<Result<unsafety::UnsafeMetrics, String>>,
    pub build: Option<build::BuildInfo>,
    pub native: Option<native::NativeInfo>,
    pub diff: Option<diff::DiffInfo>,
    /// Why the tarball could not be read; `Some("")` clears an earlier error.
    pub error: Option<String>,
}

/// Totals of one run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    pub crates: u64,
    pub versions: u64,
    /// Versions with at least one pending job.
    pub pending: u64,
    /// Versions written (any job).
    pub written: u64,
    /// Versions whose tarball could not be read.
    pub errors: u64,
    pub unsafe_: u64,
    pub build: u64,
    pub native: u64,
    pub diff: u64,
    /// The `registry` phase, if it ran.
    pub registry: Option<registry::Summary>,
}

fn load(
    name: &str,
    version: &str,
    crates_dir: &Path,
    max_file_bytes: u64,
) -> Result<SourceTree, String> {
    let entry = CrateEntry::from_parts(name, version);
    let path = entry
        .candidate_paths(crates_dir)
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            format!(
                "no .crate file for {} under the compressed root",
                entry.full_name()
            )
        })?;
    let file = std::fs::File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    SourceTree::from_tarball(file, max_file_bytes).map_err(|e| format!("{}: {e}", path.display()))
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(ToString::to_string))
        .unwrap_or_else(|| "unknown panic".to_string())
}

/// Run the pending jobs of one crate, version by version in order, and send each version's
/// results. Only the tarballs a pending job needs are read: a version's own, and its
/// predecessor's when its `diff` is pending.
pub fn process_crate(
    work: &CrateWork,
    pending: &[Pending],
    crates_dir: &Path,
    max_file_bytes: u64,
    mut send: impl FnMut(VersionMeta),
) {
    let mut prev: Option<(&str, Result<SourceTree, String>)> = None;
    for (i, v) in work.versions.iter().enumerate() {
        let wanted = pending[i];
        let next_diff = pending.get(i + 1).is_some_and(|p| p.diff);
        if wanted.is_empty() && !next_diff {
            prev = None;
            continue;
        }
        let tree =
            std::panic::catch_unwind(|| load(&work.name, &v.version, crates_dir, max_file_bytes))
                .unwrap_or_else(|p| {
                    Err(format!(
                        "reading the tarball panicked: {}",
                        panic_message(&*p)
                    ))
                });
        if !wanted.is_empty() {
            let mut meta = VersionMeta {
                name: work.name.clone(),
                version: v.version.clone(),
                ..VersionMeta::default()
            };
            match &tree {
                Err(e) => {
                    meta.error = Some(e.clone());
                    if wanted.unsafe_ {
                        meta.unsafe_ = Some(Err(e.clone()));
                    }
                }
                Ok(tree) => {
                    let base: Option<Option<(&str, &SourceTree)>> = match (i, &prev) {
                        (0, _) => Some(None),
                        (_, Some((pv, Ok(pt)))) => Some(Some((*pv, pt))),
                        // Predecessor unreadable: leave the diff pending.
                        _ => None,
                    };
                    let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        (
                            wanted.unsafe_.then(|| unsafety::scan(tree)),
                            wanted.build.then(|| build::scan(tree)),
                            wanted.native.then(|| native::scan(tree)),
                            if wanted.diff {
                                base.map(|b| diff::diff(b, tree))
                            } else {
                                None
                            },
                        )
                    }));
                    match ran {
                        Ok((unsafe_res, build_res, native_res, diff_res)) => {
                            meta.unsafe_ = unsafe_res.map(Ok);
                            meta.build = build_res;
                            meta.native = native_res;
                            meta.diff = diff_res;
                            meta.error = Some(String::new());
                        }
                        Err(p) => {
                            let msg = format!("metadata job panicked: {}", panic_message(&*p));
                            if wanted.unsafe_ {
                                meta.unsafe_ = Some(Err(msg.clone()));
                            }
                            meta.error = Some(msg);
                        }
                    }
                }
            }
            send(meta);
        }
        prev = Some((&v.version, tree));
    }
}

fn default_threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| (n.get() / 4).max(1))
}

/// Upsert one batch of results, job by job.
async fn write_batch(db: &Db, batch: &[VersionMeta]) -> Result<(), Error> {
    let unsafe_: Vec<_> = batch
        .iter()
        .filter_map(|m| Some((m.name.as_str(), m.version.as_str(), m.unsafe_.as_ref()?)))
        .collect();
    db.set_unsafe_batch(&unsafe_).await?;
    let builds: Vec<_> = batch
        .iter()
        .filter_map(|m| Some((m.name.as_str(), m.version.as_str(), m.build.as_ref()?)))
        .collect();
    db.set_build_batch(&builds).await?;
    let natives: Vec<_> = batch
        .iter()
        .filter_map(|m| Some((m.name.as_str(), m.version.as_str(), m.native.as_ref()?)))
        .collect();
    db.set_native_batch(&natives).await?;
    let mut diffs = Vec::new();
    let mut entries = 0;
    for m in batch {
        let Some(d) = &m.diff else { continue };
        if entries + d.files.len() > DIFF_ENTRIES_PER_TX && !diffs.is_empty() {
            db.set_diff_batch(&diffs).await?;
            diffs.clear();
            entries = 0;
        }
        entries += d.files.len();
        diffs.push((m.name.as_str(), m.version.as_str(), d));
    }
    db.set_diff_batch(&diffs).await?;
    let errors: Vec<_> = batch
        .iter()
        .filter_map(|m| Some((m.name.as_str(), m.version.as_str(), m.error.as_deref()?)))
        .collect();
    db.set_meta_error_batch(&errors).await?;
    Ok(())
}

/// The `registry` job's phase of [`generate_metadata`]: load the dump and write the versions in
/// `states` that need it.
async fn registry_phase(
    db: &Db,
    opts: &Options,
    states: &[MetaState],
) -> Result<Option<registry::Summary>, Error> {
    Ok(match (&opts.cratesio_dump, opts.runs(Job::Registry)) {
        (Some(dir), true) => {
            let dir = dir.clone();
            log::info!(
                "registry: loading the crates.io dump from {}",
                dir.display()
            );
            let dump = tokio::task::spawn_blocking(move || registry::load(&dir))
                .await
                .expect("dump loader panicked")?;
            let latest: Vec<MetaState>;
            let states = if opts.latest_only {
                latest = states.iter().filter(|s| s.latest).cloned().collect();
                &latest
            } else {
                states
            };
            Some(registry::run(db, &dump, states, opts.rescan).await?)
        }
        (None, true) if opts.jobs.contains(&Job::Registry) => return Err(Error::MissingDump),
        (None, true) => {
            log::info!("registry: skipped, no --cratesio-dump");
            None
        }
        (_, false) => None,
    })
}

/// Run only the `registry` job from the crates.io dump at `dump` for `only` (empty: every
/// crate in the database). `create-fresh-db` / `import-crates --cratesio-dump` use this to load
/// registry facts along with the index.
///
/// # Errors
/// As [`generate_metadata`].
pub async fn import_registry(
    db: Arc<Db>,
    dump: PathBuf,
    only: Vec<String>,
) -> Result<Summary, Error> {
    let opts = Options {
        jobs: vec![Job::Registry],
        only,
        cratesio_dump: Some(dump),
        ..Options::default()
    };
    generate_metadata(PathBuf::new(), db, opts).await
}

/// Compute and store the selected metadata for every version that needs it (see the module
/// docs). A database failure stops the run; everything stored before it stays.
///
/// # Errors
/// Database and thread-pool errors. Per-version problems are stored instead.
///
/// # Panics
/// Panics if the worker pool panics outside a version (those are caught per version).
pub async fn generate_metadata(
    crates_dir: PathBuf,
    db: Arc<Db>,
    opts: Options,
) -> Result<Summary, Error> {
    let states = db.metadata_work_list(&opts.only).await?;
    let registry = registry_phase(&db, &opts, &states).await?;
    let crates = group_by_crate(states);
    let mut summary = Summary {
        crates: crates.len() as u64,
        versions: crates.iter().map(|c| c.versions.len() as u64).sum(),
        registry,
        ..Summary::default()
    };
    let planned: Vec<(CrateWork, Vec<Pending>)> = crates
        .into_iter()
        .filter_map(|c| {
            let p = plan(&c, &opts);
            p.iter().any(|x| !x.is_empty()).then_some((c, p))
        })
        .collect();
    summary.pending = planned
        .iter()
        .map(|(_, p)| p.iter().filter(|x| !x.is_empty()).count() as u64)
        .sum();
    let threads = opts.threads.unwrap_or_else(default_threads);
    let jobs: Vec<&str> = Job::ALL
        .iter()
        .filter(|j| **j != Job::Registry && opts.runs(**j))
        .map(|j| j.name())
        .collect();
    log::info!(
        "generate-metadata: {} of {} versions in {} crates pending ({}) on {threads} threads",
        summary.pending,
        summary.versions,
        planned.len(),
        jobs.join(", ")
    );

    let (tx, mut rx) = tokio::sync::mpsc::channel::<VersionMeta>(CHANNEL_DEPTH);
    let max_file_bytes = opts.max_file_bytes;
    let workers = tokio::task::spawn_blocking(move || -> Result<(), Error> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .stack_size(WORKER_STACK_BYTES)
            .thread_name(|i| format!("metadata-{i}"))
            .build()?;
        pool.install(|| {
            // A closed channel means the writer gave up; stop scheduling crates.
            planned.into_par_iter().try_for_each(|(work, pending)| {
                let mut open = true;
                process_crate(&work, &pending, &crates_dir, max_file_bytes, |meta| {
                    open &= tx.blocking_send(meta).is_ok();
                });
                if open { Ok(()) } else { Err(()) }
            })
        })
        .ok();
        Ok(())
    });

    let started = std::time::Instant::now();
    let mut batch = Vec::with_capacity(WRITE_BATCH);
    let mut next_log = 10_000;
    while let Some(meta) = rx.recv().await {
        summary.written += 1;
        summary.unsafe_ += u64::from(meta.unsafe_.is_some());
        summary.build += u64::from(meta.build.is_some());
        summary.native += u64::from(meta.native.is_some());
        summary.diff += u64::from(meta.diff.is_some());
        summary.errors += u64::from(meta.error.as_deref().is_some_and(|e| !e.is_empty()));
        batch.push(meta);
        if batch.len() >= WRITE_BATCH {
            write_batch(&db, &batch).await?;
            batch.clear();
            if summary.written >= next_log {
                next_log += 10_000;
                let per_min = f64::from(u32::try_from(summary.written).unwrap_or(u32::MAX))
                    / started.elapsed().as_secs_f64().max(1.0)
                    * 60.0;
                log::info!(
                    "generate-metadata: {} of {} pending versions stored ({per_min:.0}/min), {} unreadable",
                    summary.written,
                    summary.pending,
                    summary.errors
                );
            }
        }
    }
    write_batch(&db, &batch).await?;
    workers.await.expect("worker pool panicked")?;
    log::info!("generate-metadata: {summary:?}");
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::source::test_support::tarball;
    use super::*;

    fn state(version: &str) -> MetaState {
        MetaState {
            name: "demo".into(),
            version: version.into(),
            ..MetaState::default()
        }
    }

    fn done(version: &str, base: Option<&str>) -> MetaState {
        MetaState {
            unsafe_scanner: Some(unsafety::SCANNER.into()),
            meta_build: Some(build::REVISION.into()),
            meta_native: Some(native::REVISION.into()),
            meta_diff: Some(diff::REVISION.into()),
            diff_base: base.map(Into::into),
            ..state(version)
        }
    }

    #[test]
    fn group_by_crate_sorts_versions_by_semver() {
        let crates = group_by_crate(vec![
            state("1.10.0"),
            state("1.2.0"),
            state("1.2.0-alpha.1"),
            state("0.9.0"),
            MetaState {
                name: "other".into(),
                ..state("1.0.0")
            },
        ]);
        assert_eq!(crates.len(), 2);
        let order: Vec<&str> = crates[0]
            .versions
            .iter()
            .map(|v| v.version.as_str())
            .collect();
        assert_eq!(order, ["0.9.0", "1.2.0-alpha.1", "1.2.0", "1.10.0"]);
    }

    #[test]
    fn plan_runs_only_stale_jobs_and_rediffs_moved_predecessors() {
        let opts = Options::default();
        let work = CrateWork {
            name: "demo".into(),
            versions: vec![
                done("1.0.0", None),
                done("1.1.0", Some("1.0.0")),
                // A backport published later now sits between 1.1.0 and 2.0.0.
                state("1.1.1"),
                done("2.0.0", Some("1.1.0")),
            ],
        };
        let p = plan(&work, &opts);
        assert!(p[0].is_empty() && p[1].is_empty(), "all markers current");
        assert!(
            p[2].unsafe_ && p[2].build && p[2].native && p[2].diff,
            "never scanned"
        );
        assert_eq!(
            p[3],
            Pending {
                diff: true,
                ..Pending::default()
            },
            "base moved to 1.1.1"
        );

        let unsafe_only = Options {
            jobs: vec![Job::Unsafe],
            ..Options::default()
        };
        assert_eq!(plan(&work, &unsafe_only)[3], Pending::default());

        let errored = CrateWork {
            name: "demo".into(),
            versions: vec![MetaState {
                unsafe_error: true,
                ..done("1.0.0", None)
            }],
        };
        assert!(plan(&errored, &opts)[0].unsafe_, "failed scans are retried");

        let rescan = Options {
            rescan: true,
            ..Options::default()
        };
        assert!(plan(&work, &rescan).iter().all(|x| !x.is_empty()));

        let latest = Options {
            latest_only: true,
            ..Options::default()
        };
        assert!(
            plan(&work, &latest).iter().all(|x| x.is_empty()),
            "none flagged latest"
        );
    }

    #[test]
    fn process_crate_reads_predecessors_for_diffs_and_reports_missing_tarballs() {
        let tmp = tempfile::tempdir().unwrap();
        let crates = tmp.path();
        for (v, body) in [("1.0.0", &b"a\n"[..]), ("1.1.0", &b"a\nb\n"[..])] {
            let entry = CrateEntry::from_parts("demo", v);
            let path = &entry.candidate_paths(crates)[0];
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                path,
                tarball(&format!("demo-{v}"), &[("src/lib.rs", body)], None),
            )
            .unwrap();
        }
        let work = CrateWork {
            name: "demo".into(),
            versions: vec![done("1.0.0", None), state("1.1.0"), state("2.0.0")],
        };
        let pending = plan(&work, &Options::default());
        let mut out = Vec::new();
        process_crate(&work, &pending, crates, 1 << 20, |m| out.push(m));

        assert_eq!(
            out.len(),
            2,
            "1.0.0 is done; it is only read as 1.1.0's base"
        );
        let v11 = &out[0];
        assert_eq!(v11.version, "1.1.0");
        let d = v11.diff.as_ref().unwrap();
        assert_eq!(d.base.as_deref(), Some("1.0.0"));
        assert_eq!((d.lines_added(), d.lines_removed()), (1, 0));
        assert!(v11.unsafe_.as_ref().unwrap().is_ok());
        assert!(v11.build.is_some() && v11.native.is_some());
        assert_eq!(v11.error.as_deref(), Some(""), "clears any earlier error");

        let v2 = &out[1];
        assert!(v2.error.as_deref().unwrap().contains("no .crate file"));
        assert!(
            v2.unsafe_.as_ref().unwrap().is_err(),
            "unsafe records the failure"
        );
        assert!(
            v2.build.is_none() && v2.native.is_none() && v2.diff.is_none(),
            "others stay pending"
        );
    }

    #[test]
    fn jobs_parse_by_name() {
        assert_eq!("diff".parse::<Job>().unwrap(), Job::Diff);
        assert!("nope".parse::<Job>().is_err());
    }
}
