use crate::db::{Db, DependencyRow, VersionRow};
use crates_index::{Crate, Index};
use futures::StreamExt;
use std::sync::Arc;

/// How many crates are written to the database concurrently by the bulk import.
pub const IMPORT_CONCURRENCY: usize = 32;

/// Environment variable naming a local clone of the crates.io git index.
pub const INDEX_PATH_ENV: &str = "PAINTER_INDEX_PATH";

/// Open the crates.io index. If `PAINTER_INDEX_PATH` is set, that directory is used as an
/// existing git clone of <https://github.com/rust-lang/crates.io-index>; otherwise cargo's
/// default index location is used (which `crates-index` will clone if it is missing).
///
/// # Errors
/// Returns the underlying `crates_index::Error` if the index cannot be opened.
pub fn open_index() -> Result<Index, crates_index::Error> {
    match std::env::var_os(INDEX_PATH_ENV) {
        Some(path) => {
            log::info!("Using crates.io index at {}", path.to_string_lossy());
            Index::with_path(path, crates_index::INDEX_GIT_URL)
        }
        None => Index::new_cargo_default(),
    }
}

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("{0}")]
    IndexError(#[from] crates_index::Error),
    #[error("{0}")]
    DatabaseError(#[from] crate::db::Error),
}

///
/// # Panics
/// asdf
/// # Errors
/// asdf
pub async fn update_missing_versions(conn: Arc<Db>) -> Result<(), Error> {
    let index = open_index()?;

    let do_crate = |c: Crate, db: Arc<Db>| async move {
        if let Ok(res) = db.crate_exists(c.name()).await {
            if res {
                //log::info!("Missing crate: {}", c.name());
                //if let Err(e) = insert_fresh_crate(c.clone(), db.clone()).await {
                //    log::error!("Failed crate: {}", c.name());
                //    log::error!("Failed crate: {}", e);
                //}

                for v in c.versions() {
                    if let Ok(res) = db.version_exists(v.name(), v.version()).await {
                        if !res {
                            log::info!("Missing version: {}-{}", v.name(), v.version());
                        }
                    }
                }
            }
        }
    };

    let iter = crate::chunked(index.crates(), 128);
    for chunk in iter {
        let tasks: Vec<_> = chunk
            .into_iter()
            .map(|c| do_crate(c, conn.clone()))
            .collect();

        futures::future::join_all(tasks).await;
    }

    Ok(())
}

///
/// # Panics
/// asdf
/// # Errors
/// asdf
pub async fn update_missing_crates(conn: Arc<Db>) -> Result<(), Error> {
    let index = open_index()?;

    let do_crate = |c: Crate, db: Arc<Db>| async move {
        if let Ok(res) = db.crate_exists(c.name()).await {
            if !res {
                println!("Missing crate: {}", c.name());
                if let Err(e) = insert_fresh_crate(c.clone(), db.clone()).await {
                    log::error!("Failed crate: {}: {e}", c.name());
                }
            }
        }
    };

    let iter = crate::chunked(index.crates(), 128);
    for chunk in iter {
        let tasks: Vec<_> = chunk
            .into_iter()
            .map(|c| do_crate(c, conn.clone()))
            .collect();

        futures::future::join_all(tasks).await;
    }

    Ok(())
}

/// Convert an index crate into batched version rows.
#[must_use]
pub fn version_rows(c: &Crate) -> Vec<VersionRow> {
    c.versions()
        .iter()
        .map(|v| VersionRow {
            version: v.version().to_string(),
            dependencies: v
                .dependencies()
                .iter()
                .map(|d| DependencyRow {
                    name: d.crate_name().to_string(),
                    requirement: d.requirement().to_string(),
                    features: d.features().join(", "),
                    kind: format!("{:?}", d.kind()),
                    optional: d.is_optional(),
                })
                .collect(),
        })
        .collect()
}

/// Attempts made for one crate before giving up on transient database errors.
const TRANSIENT_RETRIES: u32 = 6;

/// Whether a database error is transient (deadlock between concurrent writers merging the same
/// `Crate` nodes, or any other `Neo.TransientError`) and the write can simply be retried. The
/// failed transaction was rolled back, so a retry never duplicates data.
fn is_transient(e: &crate::db::Error) -> bool {
    let msg = e.to_string();
    msg.contains("Neo.TransientError") || msg.contains("DeadlockDetected") || msg.contains("ForsetiClient")
}

/// Insert a crate and all of its versions with one database round trip, skipping versions that
/// already exist, so an interrupted import can be resumed by re-running it. Transient errors are
/// retried with exponential backoff.
///
/// # Errors
/// Returns `Error::DatabaseError` on a failed query.
pub async fn insert_fresh_crate(c: Crate, db: Arc<Db>) -> Result<(), Error> {
    log::trace!("+Crate({}) with {} versions", c.name(), c.versions().len());
    let rows = version_rows(&c);
    let mut attempt = 0;
    loop {
        match db.insert_crate_versions(c.name(), &rows).await {
            Ok(()) => return Ok(()),
            Err(e) if is_transient(&e) && attempt < TRANSIENT_RETRIES => {
                attempt += 1;
                // 50ms, 100ms, 200ms, ... plus jitter derived from the name so retries spread out.
                let jitter = u64::try_from(c.name().len() % 7).unwrap_or(0) * 10;
                let wait = std::time::Duration::from_millis(50 * (1 << attempt) + jitter);
                log::debug!("{}: transient error, retry {attempt} in {wait:?}", c.name());
                tokio::time::sleep(wait).await;
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Idempotently import (or refresh) a single crate and all of its versions from the index.
/// Existing nodes and relationships are matched with `MERGE`, so this is safe to run against a
/// database that already contains the crate.
///
/// # Errors
/// Returns `Error::DatabaseError` on any failed query.
pub async fn upsert_crate(c: Crate, db: Arc<Db>) -> Result<(), Error> {
    log::trace!("~Crate({})", c.name());
    for v in c.versions() {
        log::trace!("~Crate({}),Version({})", c.name(), v.version());
        let depends: Vec<_> = v
            .dependencies()
            .iter()
            .map(|d| {
                (
                    d.name(),
                    d.requirement(),
                    d.features().join(", "),
                    format!("{:?}", d.kind()),
                    format!("{}", d.is_optional()),
                )
            })
            .collect();

        db.upsert_crate_version(v.name(), v.version(), depends.iter())
            .await?;
    }

    Ok(())
}

/// Import the named crates (all versions) from the index, idempotently. Unknown names are
/// logged and skipped.
///
/// # Errors
/// Returns `Error::IndexError` if the index cannot be opened, or `Error::DatabaseError` on a
/// failed query.
pub async fn import_crates<S: AsRef<str>>(names: &[S], db: Arc<Db>) -> Result<(), Error> {
    let index = open_index()?;

    for name in names {
        let name = name.as_ref();
        match index.crate_(name) {
            Some(c) => {
                log::info!("Importing {} ({} versions)", name, c.versions().len());
                upsert_crate(c, db.clone()).await?;
            }
            None => log::error!("Crate not found in index: {name}"),
        }
    }

    Ok(())
}

/// Import every crate in the index (or only `only`, if non-empty): all versions, `VERSION_OF`,
/// and `DEPENDS_ON`. Versions already present are skipped, so re-running resumes an interrupted
/// import. One write per crate, `IMPORT_CONCURRENCY` crates in flight at once. Per-crate
/// failures are logged and counted, not fatal.
///
/// # Errors
/// Returns `Error::IndexError` if the index cannot be opened.
pub async fn create_fresh_db<S: AsRef<str>>(conn: Arc<Db>, only: &[S]) -> Result<(), Error> {
    let index = open_index()?;

    let crates: Box<dyn Iterator<Item = Crate>> = if only.is_empty() {
        Box::new(index.crates())
    } else {
        let selected: Vec<Crate> = only
            .iter()
            .filter_map(|n| {
                let c = index.crate_(n.as_ref());
                if c.is_none() {
                    log::error!("Crate not found in index: {}", n.as_ref());
                }
                c
            })
            .collect();
        Box::new(selected.into_iter())
    };

    let mut done = 0usize;
    let mut failed = 0usize;
    let mut versions = 0usize;
    let mut stream = futures::stream::iter(crates.map(|c| {
        let db = conn.clone();
        async move {
            let name = c.name().to_string();
            let n = c.versions().len();
            (name, n, insert_fresh_crate(c, db).await)
        }
    }))
    .buffer_unordered(IMPORT_CONCURRENCY);

    while let Some((name, n, result)) = stream.next().await {
        match result {
            Ok(()) => {
                done += 1;
                versions += n;
                if done.is_multiple_of(1000) {
                    log::info!("imported {done} crates, {versions} versions ({failed} failed)");
                }
            }
            Err(e) => {
                failed += 1;
                log::error!("{name}: import failed: {e}");
            }
        }
    }

    log::info!("import finished: {done} crates, {versions} versions, {failed} failed");
    Ok(())
}

///
/// # Panics
/// asdf
/// # Errors
/// asdf
pub async fn set_latest_versions(conn: Arc<Db>) -> Result<(), Error> {
    let index = open_index()?;

    let do_crate = |c: Crate, db: Arc<Db>| async move {
        let latest = c.highest_version();
        if let Err(e) = db.set_latest(c.name(), latest.version()).await {
            log::error!("set_latest failed for {}-{}: {}", c.name(), latest.version(), e);
        }
    };

    let iter = crate::chunked(index.crates(), 64);
    for chunk in iter {
        let tasks: Vec<_> = chunk
            .into_iter()
            .map(|c| do_crate(c, conn.clone()))
            .collect();

        futures::future::join_all(tasks).await;
    }

    Ok(())
}
