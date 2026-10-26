use crate::db::{Db, DependencyRow, VersionRow};
use crates_index::{Crate, Index};
use futures::StreamExt;
use std::sync::Arc;

pub const IMPORT_CONCURRENCY: usize = 32;

const SET_LATEST_CONCURRENCY: usize = 64;

pub const INDEX_PATH_ENV: &str = "PAINTER_INDEX_PATH";

/// # Errors
/// Fails if the index cannot be opened.
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

/// # Errors
/// Fails if the index cannot be opened.
pub async fn update_missing_versions(conn: Arc<Db>) -> Result<(), Error> {
    let index = open_index()?;

    let do_crate = |c: Crate, db: Arc<Db>| async move {
        if let Ok(true) = db.crate_exists(c.name()).await {
            for v in c.versions() {
                if let Ok(false) = db.version_exists(v.name(), v.version()).await {
                    log::info!("Missing version: {}-{}", v.name(), v.version());
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

/// # Errors
/// Fails if the index cannot be opened.
pub async fn update_missing_crates(conn: Arc<Db>) -> Result<(), Error> {
    let index = open_index()?;

    let do_crate = |c: Crate, db: Arc<Db>| async move {
        if let Ok(false) = db.crate_exists(c.name()).await {
            println!("Missing crate: {}", c.name());
            if let Err(e) = insert_fresh_crate(c.clone(), db.clone()).await {
                log::error!("Failed crate: {}: {e}", c.name());
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

/// # Errors
/// Returns `Error::DatabaseError` on a failed query.
pub async fn insert_fresh_crate(c: Crate, db: Arc<Db>) -> Result<(), Error> {
    log::trace!("+Crate({}) with {} versions", c.name(), c.versions().len());
    let rows = version_rows(&c);
    db.insert_crate_versions(c.name(), &rows).await?;
    Ok(())
}

/// # Errors
/// Returns `Error::DatabaseError` on a failed query.
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

/// # Errors
/// Returns `Error::IndexError` if the index cannot be opened, or `Error::DatabaseError` on a failed query.
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

/// # Errors
/// Returns `Error::IndexError` if the index cannot be opened.
///
/// # Panics
/// Panics if the index walk task panics.
pub async fn set_latest_versions(conn: Arc<Db>) -> Result<(), Error> {
    use rayon::prelude::*;

    let index = open_index()?;
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Crate>(4096);
    let walker = tokio::task::spawn_blocking(move || {
        index.crates_parallel().for_each(|c| match c {
            Ok(c) => {
                let _ = tx.blocking_send(c);
            }
            Err(e) => log::error!("index walk failed: {e}"),
        });
    });

    let mut done = 0usize;
    let mut failed = 0usize;
    let mut chunk = Vec::with_capacity(SET_LATEST_CONCURRENCY);
    loop {
        chunk.clear();
        if rx.recv_many(&mut chunk, SET_LATEST_CONCURRENCY).await == 0 {
            break;
        }
        let tasks = chunk.iter().map(|c| {
            let db = conn.clone();
            async move {
                let latest = c.highest_version();
                db.set_latest(c.name(), latest.version())
                    .await
                    .map_err(|e| format!("{}-{}: {e}", c.name(), latest.version()))
            }
        });
        for result in futures::future::join_all(tasks).await {
            match result {
                Ok(()) => done += 1,
                Err(msg) => {
                    failed += 1;
                    log::error!("set_latest failed for {msg}");
                }
            }
        }
        if ((done + failed) / SET_LATEST_CONCURRENCY).is_multiple_of(16) {
            log::info!("set latest on {done} crates ({failed} failed)");
        }
    }
    walker.await.expect("index walk task panicked");

    log::info!("set-latest-versions finished: {done} crates, {failed} failed");
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    use crates_index::Crate;

    pub type FakeDep<'a> = (&'a str, &'a str, bool, Option<&'a str>);
    pub type FakeVersion<'a> = (&'a str, bool, &'a [FakeDep<'a>]);

    pub fn fake_crate(name: &str, versions: &[FakeVersion<'_>]) -> Crate {
        let mut lines = Vec::new();
        for (vers, yanked, deps) in versions {
            let deps: Vec<String> = deps
                .iter()
                .map(|(dn, req, optional, package)| {
                    let package = package.map_or("null".to_string(), |p| format!("\"{p}\""));
                    format!(
                        "{{\"name\":\"{dn}\",\"req\":\"{req}\",\"features\":[\"std\"],\
                         \"optional\":{optional},\"default_features\":true,\"target\":null,\
                         \"kind\":\"normal\",\"package\":{package}}}"
                    )
                })
                .collect();
            lines.push(format!(
                "{{\"name\":\"{name}\",\"vers\":\"{vers}\",\"deps\":[{}],\
                 \"cksum\":\"{}\",\"features\":{{}},\"yanked\":{yanked}}}",
                deps.join(","),
                "0".repeat(64)
            ));
        }
        Crate::from_slice(lines.join("\n").as_bytes()).expect("valid index json")
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::fake_crate;
    use super::*;

    #[test]
    fn version_rows_mirror_the_index_record() {
        let c = fake_crate(
            "foo",
            &[
                ("0.1.0", false, &[("serde", "^1.0", true, None)]),
                (
                    "0.2.0",
                    false,
                    &[("tokio", ">=1", false, Some("tokio-renamed"))],
                ),
            ],
        );
        let rows = version_rows(&c);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].version, "0.1.0");
        let d = &rows[0].dependencies[0];
        assert_eq!(d.name, "serde");
        assert_eq!(d.requirement, "^1.0");
        assert_eq!(d.features, "std");
        assert_eq!(d.kind, "Normal");
        assert!(d.optional);

        // `package = "..."` renames: the row carries the real crate name.
        let d = &rows[1].dependencies[0];
        assert_eq!(d.name, "tokio-renamed");
        assert!(!d.optional);
    }

    #[test]
    fn version_rows_handle_crates_without_dependencies() {
        let c = fake_crate("bare", &[("1.0.0", false, &[])]);
        let rows = version_rows(&c);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].dependencies.is_empty());
    }
}
