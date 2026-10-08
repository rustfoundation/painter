use crate::db::Db;
use crates_index::{Crate, Index};
use std::sync::Arc;

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
                    log::error!("Failed crate: {}", c.name());
                    log::error!("Failed crate: {}", e);
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
///
/// # Errors
///
pub async fn insert_fresh_crate(c: Crate, db: Arc<Db>) -> Result<(), Error> {
    log::trace!("+Crate({})", c.name());
    for v in c.versions() {
        log::trace!("+Crate({}),Version({})", c.name(), v.version());
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

        db.insert_crate_version(v.name(), v.version(), depends.iter())
            .await?;
    }

    Ok(())
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
            None => log::error!("Crate not found in index: {}", name),
        }
    }

    Ok(())
}

///
/// # Panics
/// asdf
/// # Errors
/// asdf
pub async fn create_fresh_db(conn: Arc<Db>) -> Result<(), Error> {
    let index = open_index()?;

    let iter = crate::chunked(index.crates(), 64);
    for chunk in iter {
        let tasks: Vec<_> = chunk
            .into_iter()
            .map(|c| insert_fresh_crate(c, conn.clone()))
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
