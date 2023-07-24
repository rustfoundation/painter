use async_compat::Compat;
use neo4rs::{query, Graph, Node};
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("Database Error: {0}")]
    Neo4jError(#[from] neo4rs::Error),
    #[error("Field Not Found: node={0}, field={1}")]
    FieldNotFound(i64, String),
    #[error("Semver String Invalid: {0}")]
    InvalidSemver(String),
}

pub struct Db {
    conn: Arc<Graph>,
}
impl Db {
    #[allow(clippy::must_use_candidate)]
    pub fn inner(&self) -> Arc<Graph> {
        self.conn.clone()
    }

    ///
    /// # Panics
    /// asdf
    /// # Errors
    /// asdf
    pub async fn connect<URI, U, P>(uri: URI, username: U, password: P) -> Result<Self, Error>
    where
        URI: AsRef<str>,
        U: AsRef<str>,
        P: AsRef<str>,
    {
        let conn = Arc::new(
            Graph::connect(
                neo4rs::config()
                    .uri(uri.as_ref())
                    .user(username.as_ref())
                    .password(password.as_ref())
                    .db("neo4j")
                    .fetch_size(10)
                    .max_connections(64)
                    .build()
                    .unwrap(),
            )
            .await?,
        );
        Ok(Self { conn })
    }

    ///
    /// # Panics
    /// asdf
    /// # Errors
    /// asdf
    #[allow(clippy::similar_names)]
    pub async fn insert_invoke(
        &self,
        caller: &str,
        callee: &str,
        src_crate: (&str, &str),
        dst_crate: &str,
    ) -> Result<(), Error> {
        let mut result = self
            .conn
            .execute(
                query(
                    "MATCH (srcVersion:Version { name: $src_crate, version: $src_version }) 
                        MATCH (dstCrate:Crate { name: dst_crate }) 
                        CREATE (srcVersion)-[:INVOKES {caller: $caller, callee: $callee}]->(dstCrate)
                    ",
                )
                .param("src_crate", src_crate.0)
                .param("src_version", src_crate.1)
                .param("dst_crate", dst_crate)
                .param("caller", caller)
                .param("callee", callee),
            )
            .await?;

        Ok(())
    }

    ///
    /// # Panics
    /// asdf
    /// # Errors
    /// asdf
    pub async fn insert_crate_version<'a, I, S1, S2, S3, S4, S5>(
        &self,
        name: &str,
        version: &str,
        depends_on: I,
    ) -> Result<(), Error>
    where
        I: Iterator<Item = &'a (S1, S2, S3, S4, S5)>,
        S1: AsRef<str> + 'a,
        S2: AsRef<str> + 'a,
        S3: AsRef<str> + 'a,
        S4: AsRef<str> + 'a,
        S5: AsRef<str> + 'a,
    {
        let semver = if let Ok(s) = lenient_semver::parse(version) {
            s
        } else {
            let split: Vec<_> = version.split('.').collect();
            let patch = split[2]
                .chars()
                .filter(char::is_ascii_digit)
                .collect::<String>()
                .parse::<u64>()
                .map_err(|_| Error::InvalidSemver(version.to_owned()))?;

            semver::Version {
                major: split[0]
                    .parse::<u64>()
                    .map_err(|_| Error::InvalidSemver(version.to_owned()))?,
                minor: split[1]
                    .parse::<u64>()
                    .map_err(|_| Error::InvalidSemver(version.to_owned()))?,
                patch,
                build: semver::BuildMetadata::default(),
                pre: semver::Prerelease::default(),
            }
        };

        let version_id = {
            let mut result = self.conn
            .execute(
                query(
                    "MERGE (crate:Crate { name: $name }) 
                     CREATE (version:Version {name: $name, version: $version, major: toInteger($semver_major), minor: toInteger($semver_minor), patch: toInteger($semver_patch), build: $semver_build, pre: $semver_pre })
                     CREATE (version)-[:VERSION_OF]->(crate)
                     RETURN version",
                )
                .param("name", name)
                .param("version", version)
                .param("semver_major", u32::try_from(semver.major).map_err(|_| Error::InvalidSemver(version.to_owned()))?)
                    .param("semver_minor", u32::try_from(semver.minor).map_err(|_| Error::InvalidSemver(version.to_owned()))?)
                    .param("semver_patch", u32::try_from(semver.patch).map_err(|_| Error::InvalidSemver(version.to_owned()))?)
                    .param("semver_build", semver.build.as_str())
                    .param("semver_pre", semver.pre.as_str())
            )
            .await?;

            let version_node: Node = result
                .next()
                .await
                .unwrap()
                .unwrap()
                .get("version")
                .unwrap();

            version_node.id()
        };

        for depend in depends_on {
            self
                .conn
                .execute(
                    query(
                        "MATCH (version:Version) WHERE ID(version) = $version_id
                         MERGE (depend:Crate { name: $depend })
                         CREATE (version)-[:DEPENDS_ON { requirement: $req, features: $features, kind: $kind, optional: toBoolean($optional) } ]->(depend)",
                    )
                        .param("version_id", version_id)
                        .param("depend", depend.0.as_ref())
                        .param("req", depend.1.as_ref())
                        .param("features", depend.2.as_ref())
                        .param("kind", depend.3.as_ref())
                        .param("optional", depend.4.as_ref())
                )
                .await?.next().await?;
        }

        Ok(())
    }
}
