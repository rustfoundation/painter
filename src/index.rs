use crate::db::Db;
use crates_index::{Crate, Index, Version};
use rayon::prelude::*;
use std::{path::Path, sync::Arc};

#[derive(thiserror::Error, Debug)]
pub enum IndexError {
    #[error("{0}")]
    IndexError(#[from] crates_index::Error),
    #[error("{0}")]
    DatabaseError(#[from] crate::db::DbError),
}

pub async fn create_fresh_db() -> Result<(), IndexError> {
    let index = crates_index::Index::new_cargo_default()?;

    let conn = Arc::new(Db::connect("127.0.0.1:7687", "neo4j", "a9834rjwl4ikj").await?);

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
                .await;
        }
    };

    //for c in index.crates() {s
    //    do_crate(c, conn).await?;
    //}

    let mut iter = index.crates().array_chunks::<64>();
    for chunk in iter {
        let tasks: Vec<_> = chunk
            .into_iter()
            .map(|c| do_crate(c, conn.clone()))
            .collect();

        futures::future::join_all(tasks).await;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[smol_potat::test]
    async fn basic() {
        smol::block_on(async_compat::Compat::new(async {
            create_fresh_db().await.unwrap();
        }));
    }
}
