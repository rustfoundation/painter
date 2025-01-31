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
    #[error("Crate Invalid: {0}")]
    CrateNotFound(String),
}

pub struct Db {
    conn: Arc<Graph>,
}
impl Db {
    #[allow(clippy::must_use_candidate)]
    pub fn inner(&self) -> Arc<Graph> {
        self.conn.clone()
    }

    /// Connect to the neo4j database with the specified parameters.
    /// # Panics
    /// This function will panic if invalid parameters are provided in the configuration.
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a connection failure.
    pub async fn connect<URI, U, P>(uri: URI, username: U, password: P) -> Result<Self, Error>
    where
        URI: AsRef<str>,
        U: AsRef<str>,
        P: AsRef<str>,
    {
        let conn = Arc::new(
            Graph::connect(
                neo4rs::ConfigBuilder::default()
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

    /// Insert a new function invocation into the database. This creates the specified relationship
    /// between a crates version `(Version)` node and a `(Crate)` node. This limitation currently
    /// exists because unless a crate has been specified as a version-locked full semver dependency,
    /// there is no true determination of what version it is calling.
    ///
    /// This may change in the future where we can specify a range of versions for an invocation.
    ///
    /// `(Version)-[:INVOKES { caller, callee }]->(Crate)`
    ///
    /// # Panics
    /// This function should not panic.
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    #[allow(clippy::similar_names)]
    pub async fn insert_invoke(
        &self,
        caller: &str,
        callee: &str,
        src_crate: (&str, &str),
        dst_crate: &str,
    ) -> Result<(), Error> {
        self
            .conn
            .execute(
                query(
                    "MATCH (srcVersion:Version { name: $src_crate, version: $src_version }) 
                        MATCH (dstCrate:Crate { name: $dst_crate }) 
                        CREATE (srcVersion)-[:INVOKES {callsite: $caller, target: $callee}]->(dstCrate)
                    ",
                )
                .param("src_crate", src_crate.0)
                .param("src_version", src_crate.1)
                .param("dst_crate", dst_crate)
                .param("caller", caller)
                .param("callee", callee),
            )
            .await?.next().await?;

        Ok(())
    }

    /// Insert a new version of a crate into the database. This will create a new `(Version)` node,
    /// linking it to its associated top-level `(Crate)` node. If that node does not exist, it is created.
    ///
    /// Also inserts all dependency relationships for this version of the crate; whatever is specified
    /// in the Cargo.toml for this version as its dependencies will gain `[:DEPENDS_ON]` relationships
    /// with other `(Crate)` nodes. We do not specify exact version-version `[:DEPENDS_ON]` relationships,
    /// because semver may cause these versions to shift and change based on build time and release
    /// cycles.
    ///
    /// `(Version)-[:DEPENDS_ON {requirement, features, kind, optional}]->(Crate)`
    ///
    /// # Panics
    /// This function may panic if there is an error in the initial insertion of the Crate node
    /// in which it cant be referenced in future queries. Specifically, it will panic in the event
    /// a new Node is not returned during insertion.
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
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
                     CREATE (version:Version {name: $name, version: $version, semver_major: toInteger($semver_major), semver_minor: toInteger($semver_minor), semver_patch: toInteger($semver_patch), semver_build: $semver_build, semver_pre: $semver_pre })
                     CREATE (version)<-[:VERSION_OF]-(crate)
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

        let tx = self.conn.start_txn().await.unwrap();

        tx.run_queries(depends_on.into_iter().map(|depend| {
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
        }).collect()).await?;

        tx.commit().await?;

        Ok(())
    }

    /// Upserts a new function invocation into the database. This creates the specified relationship
    /// between a crates version `(Version)` node and a `(Crate)` node. This limitation currently
    /// exists because unless a crate has been specified as a version-locked full semver dependency,
    /// there is no true determination of what version it is calling.
    ///
    /// If the current relationship already exists, a new one will *not* be created, hence the upsert.
    ///
    /// This may change in the future where we can specify a range of versions for an invocation.
    ///
    /// `(Version)-[:INVOKES { caller, callee }]->(Crate)`
    ///
    /// # Panics
    /// This function should not panic.
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    #[allow(clippy::similar_names)]
    pub async fn upsert_invoke(
        &self,
        caller: &str,
        callee: &str,
        src_crate: (&str, &str),
        dst_crate: &str,
    ) -> Result<(), Error> {
        self.conn
            .execute(
                query(
                    "MATCH (srcVersion:Version { name: $src_crate, version: $src_version }) 
                        MATCH (dstCrate:Crate { name: dst_crate }) 
                        MERGE (srcVersion)-[:INVOKES {caller: $caller, callee: $callee}]->(dstCrate)
                    ",
                )
                .param("src_crate", src_crate.0)
                .param("src_version", src_crate.1)
                .param("dst_crate", dst_crate)
                .param("caller", caller)
                .param("callee", callee),
            )
            .await?
            .next()
            .await?;

        Ok(())
    }

    /// Insert a new version of a crate into the database. This will create a new `(Version)` node,
    /// linking it to its associated top-level `(Crate)` node. If that node does not exist, it is created.
    ///
    /// Also inserts all dependency relationships for this version of the crate; whatever is specified
    /// in the Cargo.toml for this version as its dependencies will gain `[:DEPENDS_ON]` relationships
    /// with other `(Crate)` nodes. We do not specify exact version-version `[:DEPENDS_ON]` relationships,
    /// because semver may cause these versions to shift and change based on build time and release
    /// cycles.
    ///
    /// If the current relationship already exists, a new one will *not* be created, hence the upsert.
    ///
    /// `(Version)-[:DEPENDS_ON {requirement, features, kind, optional}]->(Crate)`
    ///
    /// # Panics
    /// This function may panic if there is an error in the initial insertion of the Crate node
    /// in which it cant be referenced in future queries. Specifically, it will panic in the event
    /// a new Node is not returned during insertion.
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    pub async fn upsert_crate_version<'a, I, S1, S2, S3, S4, S5>(
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
            let mut result = self
                .conn
                .execute(
                    query(
                        "MERGE (crate:Crate { name: $name }) 
                     MERGE (version:Version {name: $name, version: $version, 
                     semver_major: toInteger($semver_major), 
                     semver_minor: toInteger($semver_minor), 
                     semver_patch: toInteger($semver_patch), 
                     semver_build: $semver_build, 
                     semver_pre: $semver_pre })
                     MERGE (version)<-[:VERSION_OF]-(crate)
                     RETURN version",
                    )
                    .param("name", name)
                    .param("version", version)
                    .param(
                        "semver_major",
                        u32::try_from(semver.major)
                            .map_err(|_| Error::InvalidSemver(version.to_owned()))?,
                    )
                    .param(
                        "semver_minor",
                        u32::try_from(semver.minor)
                            .map_err(|_| Error::InvalidSemver(version.to_owned()))?,
                    )
                    .param(
                        "semver_patch",
                        u32::try_from(semver.patch)
                            .map_err(|_| Error::InvalidSemver(version.to_owned()))?,
                    )
                    .param("semver_build", semver.build.as_str())
                    .param("semver_pre", semver.pre.as_str()),
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
                         MERGE (version)-[:DEPENDS_ON { requirement: $req, features: $features, kind: $kind, optional: toBoolean($optional) } ]->(depend)",
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

    ///
    /// # Panics
    ///
    /// # Errors
    ///
    pub async fn crate_exists<S1>(&self, name: S1) -> Result<bool, Error>
    where
        S1: AsRef<str>,
    {
        Ok(self
            .conn
            .execute(
                query("MATCH c=(Crate {name:  $name }) RETURN c LIMIT 1")
                    .param("name", name.as_ref()),
            )
            .await?
            .next()
            .await
            .unwrap()
            .is_some())
    }

    ///
    /// # Panics
    ///
    /// # Errors
    ///
    pub async fn has_any_invoke<S1, S2>(&self, name: S1, version: S2) -> Result<bool, Error>
    where
        S1: AsRef<str>,
        S2: AsRef<str>,
    {
        Ok(self
            .conn
            .execute(
                query("MATCH (Version {name:  $name, version: $version })-[r:INVOKES]->() RETURN id(r) LIMIT 1")
                    .param("name", name.as_ref())
                    .param("version", version.as_ref()),
            )
            .await?
            .next()
            .await
            .unwrap()
            .is_some())
    }

    ///
    /// # Panics
    ///
    /// # Errors
    ///
    pub async fn set_latest<S1, S2>(&self, name: S1, version: S2) -> Result<(), Error>
    where
        S1: AsRef<str>,
        S2: AsRef<str>,
    {
        // Clear all other latest for this name
        self.conn
            .execute(
                query("MATCH (v:Version {name: $name }) SET v.latest = False")
                    .param("name", name.as_ref()),
            )
            .await?
            .next()
            .await?;

        self.conn
            .execute(
                query("MATCH (v:Version {name: $name, version: $version }) SET v.latest = True")
                    .param("name", name.as_ref())
                    .param("version", version.as_ref()),
            )
            .await?
            .next()
            .await?;

        Ok(())
    }

    ///
    /// # Panics
    ///
    /// # Errors
    ///
    pub async fn version_exists<S1, S2>(&self, name: S1, version: S2) -> Result<bool, Error>
    where
        S1: AsRef<str>,
        S2: AsRef<str>,
    {
        Ok(self
            .conn
            .execute(
                query("MATCH (v:Version { name: $name, version: $version } RETURN v LIMIT 1")
                    .param("name", name.as_ref())
                    .param("version", version.as_ref()),
            )
            .await?
            .next()
            .await
            .unwrap()
            .is_some())
    }

    ///
    /// # Panics
    ///
    /// # Errors
    ///
    pub async fn crate_version_exists<S1, S2>(&self, name: S1, version: S2) -> Result<bool, Error>
    where
        S1: AsRef<str>,
        S2: AsRef<str>,
    {
        Ok(self
            .conn
            .execute(
                query("MATCH v=(Version {name:  $name, version: $version}) RETURN v LIMIT 1")
                    .param("name", name.as_ref())
                    .param("version", version.as_ref()),
            )
            .await?
            .next()
            .await
            .unwrap()
            .is_some())
    }

    ///
    /// # Panics
    ///
    /// # Errors
    ///
    pub async fn set_unsafe<S1, S2>(
        &self,
        name: S1,
        version: S2,
        unsafe_result: &crate::analysis::CountUnsafeResult,
    ) -> Result<(), Error>
    where
        S1: AsRef<str>,
        S2: AsRef<str>,
    {
        if self
            .conn
            .execute(
                query(
                    "MATCH (v:Version {name:  $name, version: $version}) SET \
                v.unsafe_total = $unsafe_total, \
                v.unsafe_functions = $unsafe_functions, \
                v.unsafe_exprs = $unsafe_exprs, \
                v.unsafe_impls = $unsafe_impls, \
                v.unsafe_traits = $unsafe_traits, \
                v.unsafe_methods = $unsafe_methods, \
                v.safe_functions = $safe_functions, \
                v.safe_exprs = $safe_exprs, \
                v.safe_impls = $safe_impls, \
                v.safe_traits = $safe_traits, \
                v.safe_methods = $safe_methods \
                RETURN v",
                )
                .param("name", name.as_ref())
                .param("version", version.as_ref())
                .param("unsafe_total", unsafe_result.total_unsafe())
                .param("unsafe_functions", unsafe_result.functions.unsafe_)
                .param("unsafe_exprs", unsafe_result.exprs.unsafe_)
                .param("unsafe_impls", unsafe_result.item_impls.unsafe_)
                .param("unsafe_traits", unsafe_result.item_traits.unsafe_)
                .param("unsafe_methods", unsafe_result.methods.unsafe_)
                .param("safe_functions", unsafe_result.functions.safe)
                .param("safe_exprs", unsafe_result.exprs.safe)
                .param("safe_impls", unsafe_result.item_impls.safe)
                .param("safe_traits", unsafe_result.item_traits.safe)
                .param("safe_methods", unsafe_result.methods.safe),
            )
            .await?
            .next()
            .await?
            .is_none()
        {
            Err(Error::CrateNotFound(name.as_ref().to_string()))
        } else {
            Ok(())
        }
    }
}
