use crate::db::Db;
use crates_index::Crate;
use std::sync::Arc;

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
    let index = crates_index::Index::new_cargo_default()?;

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

    let iter = index.crates().array_chunks::<128>();
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
    let index = crates_index::Index::new_cargo_default()?;

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

    let iter = index.crates().array_chunks::<128>();
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
    for v in c.versions() {
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

///
/// # Panics
/// asdf
/// # Errors
/// asdf
pub async fn create_fresh_db(conn: Arc<Db>) -> Result<(), Error> {
    let index = crates_index::Index::new_cargo_default()?;

    let iter = index.crates().array_chunks::<12>();
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
    let index = crates_index::Index::new_cargo_default()?;

    let do_crate = |c: Crate, db: Arc<Db>| async move {
        let latest = c.highest_version();
        db.set_latest(c.name(), latest.version()).await;
    };

    let iter = index.crates().array_chunks::<128>();
    for chunk in iter {
        let tasks: Vec<_> = chunk
            .into_iter()
            .map(|c| do_crate(c, conn.clone()))
            .collect();

        futures::future::join_all(tasks).await;
    }

    Ok(())
}
