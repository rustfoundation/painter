use async_compat::Compat;
use neo4rs::{query, Graph, Node};
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("Database Error: {0}")]
    Neo4jError(#[from] neo4rs::Error),
    #[error("Field Not Found: node={0}, field={1}")]
    FieldNotFound(i64, String),
    #[error("Semver String Invalid: {0}")]
    InvalidSemver(String),
}

//CREATE CONSTRAINT FOR (c:Crate) REQUIRE c.name IS UNIQUE;
pub struct Db {
    conn: Arc<Graph>,
}
impl Db {
    pub fn inner(&self) -> Arc<Graph> {
        self.conn.clone()
    }

    pub async fn connect<URI, U, P>(uri: URI, username: U, password: P) -> Result<Self, DbError>
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

    pub fn insert_invoke(
        caller: &str,
        callee: &str,
        src_crate: (&str, &str),
        dst_crate: &str,
    ) -> Result<(), DbError> {
        todo!()
    }

    pub async fn insert_crate_version<'a, I, S1, S2, S3, S4, S5>(
        &self,
        name: &str,
        version: &str,
        depends_on: I,
    ) -> Result<(), DbError>
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
            let split: Vec<_> = version.split(".").collect();
            let patch = split[2]
                .chars()
                .filter(|c| c.is_digit(10))
                .collect::<String>()
                .parse::<u64>()
                .map_err(|_| DbError::InvalidSemver(version.to_owned()))?;

            semver::Version {
                major: split[0]
                    .parse::<u64>()
                    .map_err(|_| DbError::InvalidSemver(version.to_owned()))?,
                minor: split[1]
                    .parse::<u64>()
                    .map_err(|_| DbError::InvalidSemver(version.to_owned()))?,
                patch: patch,
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
                .param("semver_major", u32::try_from(semver.major).map_err(|_| DbError::InvalidSemver(version.to_owned()))?)
                    .param("semver_minor", u32::try_from(semver.minor).map_err(|_| DbError::InvalidSemver(version.to_owned()))?)
                    .param("semver_patch", u32::try_from(semver.patch).map_err(|_| DbError::InvalidSemver(version.to_owned()))?)
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
