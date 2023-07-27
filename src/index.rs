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
pub async fn create_fresh_db(conn: Arc<Db>) -> Result<(), Error> {
    let index = crates_index::Index::new_cargo_default()?;

    let do_crate = |c: Crate, db: Arc<Db>| async move {
        println!("{}", c.name());

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
                .await
                .unwrap();
        }
    };

    let iter = index.crates().array_chunks::<64>();
    for chunk in iter {
        let tasks: Vec<_> = chunk
            .into_iter()
            .map(|c| do_crate(c, conn.clone()))
            .collect();

        futures::future::join_all(tasks).await;
    }

    Ok(())
}
