use neo4rs::{query, Graph, Node, Query, Row};
use std::sync::Arc;
use std::time::Duration;
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

/// Parse a version string leniently: `lenient_semver` first, then a `major.minor.patch`
/// fallback that strips non-digits from the patch, because the index contains non-compliant
/// versions.
///
/// # Errors
/// Returns `Error::InvalidSemver` if no interpretation works.
pub fn parse_semver(version: &str) -> Result<semver::Version, Error> {
    if let Ok(s) = lenient_semver::parse(version) {
        return Ok(s);
    }
    let invalid = || Error::InvalidSemver(version.to_owned());
    let split: Vec<_> = version.split('.').collect();
    if split.len() < 3 {
        return Err(invalid());
    }
    let patch = split[2]
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>()
        .parse::<u64>()
        .map_err(|_| invalid())?;

    Ok(semver::Version {
        major: split[0].parse::<u64>().map_err(|_| invalid())?,
        minor: split[1].parse::<u64>().map_err(|_| invalid())?,
        patch,
        build: semver::BuildMetadata::default(),
        pre: semver::Prerelease::default(),
    })
}

/// One dependency declaration of a crate version, as stored on `[:DEPENDS_ON]`.
#[derive(Debug, Clone)]
pub struct DependencyRow {
    pub name: String,
    pub requirement: String,
    pub features: String,
    pub kind: String,
    pub optional: bool,
}

/// One version of a crate with its dependency declarations, for batched inserts.
#[derive(Debug, Clone)]
pub struct VersionRow {
    pub version: String,
    pub dependencies: Vec<DependencyRow>,
}

/// What the database holds for one crate, as returned by [`Db::crate_version_status`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CrateDbStatus {
    /// Version strings with a `(Version)` node.
    pub versions: std::collections::HashSet<String>,
    /// Version strings whose node has at least one outgoing `INVOKES` edge.
    pub exported: std::collections::HashSet<String>,
}

/// Attempts made for one write before giving up on a transient error.
const WRITE_RETRIES: u32 = 6;

/// Whether a database error is transient (a deadlock between concurrent writers touching the
/// same nodes or index entries, or any other `Neo.TransientError`) and the write can simply be
/// retried. Neo4j rolls the failed transaction back, so a retry never duplicates data.
#[must_use]
pub fn is_transient(e: &Error) -> bool {
    let msg = e.to_string();
    msg.contains("Neo.TransientError")
        || msg.contains("DeadlockDetected")
        || msg.contains("ForsetiClient")
}

/// Exponential backoff for retry `attempt` (1-based): 100ms, 200ms, 400ms, ... plus up to 50ms
/// of jitter so writers that deadlocked against each other do not retry in lockstep.
fn backoff(attempt: u32) -> Duration {
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_nanos() % 50));
    Duration::from_millis(50 * (1u64 << attempt.min(10)) + jitter)
}

pub struct Db {
    conn: Arc<Graph>,
}
impl Db {
    /// Run a write query that returns nothing, retrying transient failures with backoff. See
    /// [`is_transient`].
    async fn write(&self, q: Query) -> Result<(), Error> {
        self.write_first_row(q).await.map(|_| ())
    }

    /// Run a write query and return its first row, if any. The whole result is consumed inside
    /// the retry loop, so a transient failure surfaced while streaming rows is retried too.
    async fn write_first_row(&self, q: Query) -> Result<Option<Row>, Error> {
        let mut attempt = 0;
        loop {
            match self.write_once(q.clone()).await {
                Ok(row) => return Ok(row),
                Err(e) if is_transient(&e) && attempt < WRITE_RETRIES => {
                    attempt += 1;
                    let wait = backoff(attempt);
                    log::debug!("transient database error, retry {attempt} in {wait:?}: {e}");
                    tokio::time::sleep(wait).await;
                }
                Err(e) => return Err(e),
            }
        }
    }

    async fn write_once(&self, q: Query) -> Result<Option<Row>, Error> {
        let mut stream = self.conn.execute(q).await?;
        let first = stream.next().await?;
        while stream.next().await?.is_some() {}
        Ok(first)
    }
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
        self.write(
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
            .await?;

        Ok(())
    }

    /// Replace every invocation of one crate version in a single write query. Any `[:INVOKES]`
    /// edges the version already has are deleted and the new ones created in the same
    /// transaction, so re-importing a version never duplicates edges and the version's invoke
    /// graph is either fully replaced or untouched. Each entry of `calls` is
    /// `(caller, callee, callee_crate)`. Callee crates that do not exist as `(Crate)` nodes are
    /// skipped by the `MATCH`.
    ///
    /// An empty `calls` still wipes the existing edges, so a version that no longer has any
    /// cross-crate calls ends up with none.
    ///
    /// `(Version)-[:INVOKES { callsite, target }]->(Crate)`
    ///
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    pub async fn insert_invokes(
        &self,
        src_crate: (&str, &str),
        calls: &[(String, String, String)],
    ) -> Result<(), Error> {
        if calls.is_empty() {
            return self.delete_invokes(src_crate.0, src_crate.1).await;
        }

        // neo4rs 0.6 does not expose its map type, so send three parallel lists and index them.
        let callsites: Vec<&str> = calls.iter().map(|c| c.0.as_str()).collect();
        let targets: Vec<&str> = calls.iter().map(|c| c.1.as_str()).collect();
        let dsts: Vec<&str> = calls.iter().map(|c| c.2.as_str()).collect();

        self.write(
                query(
                    "MATCH (srcVersion:Version { name: $src_crate, version: $src_version })
                     OPTIONAL MATCH (srcVersion)-[old:INVOKES]->()
                     DELETE old
                     WITH DISTINCT srcVersion
                     UNWIND range(0, size($callers) - 1) AS i
                     MATCH (dstCrate:Crate { name: $dsts[i] })
                     CREATE (srcVersion)-[:INVOKES { callsite: $callers[i], target: $callees[i] }]->(dstCrate)",
                )
                .param("src_crate", src_crate.0)
                .param("src_version", src_crate.1)
                .param("callers", callsites)
                .param("callees", targets)
                .param("dsts", dsts),
            )
            .await?;

        Ok(())
    }

    /// Insert a crate with every one of its versions and their dependency edges in a single
    /// write query. This is the fast path used by `create-fresh-db`: one round trip per crate
    /// instead of one per version plus one per dependency.
    ///
    /// Resumable: versions that already exist in the database are skipped (checked through the
    /// `(name, version)` uniqueness index), so re-running an interrupted import only adds what is
    /// missing and never duplicates nodes or edges. `(Crate)` nodes are `MERGE`d because other
    /// crates' dependencies may already have created them. Versions whose number cannot be
    /// parsed even leniently are skipped with a warning rather than failing the crate.
    ///
    /// `(Crate)-[:VERSION_OF]->(Version)-[:DEPENDS_ON {requirement, features, kind, optional}]->(Crate)`
    ///
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    #[allow(clippy::too_many_lines)]
    pub async fn insert_crate_versions(
        &self,
        name: &str,
        rows: &[VersionRow],
    ) -> Result<(), Error> {
        let parsed: Vec<(&VersionRow, semver::Version)> = rows
            .iter()
            .filter_map(|row| match parse_semver(&row.version) {
                Ok(sv) => Some((row, sv)),
                Err(e) => {
                    log::warn!("{}-{}: skipping, {}", name, row.version, e);
                    None
                }
            })
            .collect();

        if parsed.is_empty() {
            // Still make sure the crate node exists.
            self.write(query("MERGE (:Crate { name: $name })").param("name", name))
                .await?;
            return Ok(());
        }

        let versions: Vec<&str> = parsed.iter().map(|(r, _)| r.version.as_str()).collect();
        let majors: Vec<i64> = parsed
            .iter()
            .map(|(_, sv)| i64::try_from(sv.major).unwrap_or(i64::MAX))
            .collect();
        let minors: Vec<i64> = parsed
            .iter()
            .map(|(_, sv)| i64::try_from(sv.minor).unwrap_or(i64::MAX))
            .collect();
        let patches: Vec<i64> = parsed
            .iter()
            .map(|(_, sv)| i64::try_from(sv.patch).unwrap_or(i64::MAX))
            .collect();
        let builds: Vec<&str> = parsed.iter().map(|(_, sv)| sv.build.as_str()).collect();
        let pres: Vec<&str> = parsed.iter().map(|(_, sv)| sv.pre.as_str()).collect();
        // Per-version dependency columns: outer index = version, inner = dependency.
        let dep_names: Vec<Vec<&str>> = parsed
            .iter()
            .map(|(r, _)| r.dependencies.iter().map(|d| d.name.as_str()).collect())
            .collect();
        let dep_reqs: Vec<Vec<&str>> = parsed
            .iter()
            .map(|(r, _)| {
                r.dependencies
                    .iter()
                    .map(|d| d.requirement.as_str())
                    .collect()
            })
            .collect();
        let dep_features: Vec<Vec<&str>> = parsed
            .iter()
            .map(|(r, _)| r.dependencies.iter().map(|d| d.features.as_str()).collect())
            .collect();
        let dep_kinds: Vec<Vec<&str>> = parsed
            .iter()
            .map(|(r, _)| r.dependencies.iter().map(|d| d.kind.as_str()).collect())
            .collect();
        let dep_optional: Vec<Vec<bool>> = parsed
            .iter()
            .map(|(r, _)| r.dependencies.iter().map(|d| d.optional).collect())
            .collect();

        self.write(
            query(
                "MERGE (crate:Crate { name: $name })
                     WITH crate
                     UNWIND range(0, size($versions) - 1) AS i
                     WITH crate, i
                     WHERE NOT EXISTS { MATCH (:Version { name: $name, version: $versions[i] }) }
                     CREATE (v:Version {
                         name: $name,
                         version: $versions[i],
                         semver_major: $majors[i],
                         semver_minor: $minors[i],
                         semver_patch: $patches[i],
                         semver_build: $builds[i],
                         semver_pre: $pres[i]
                     })
                     CREATE (crate)-[:VERSION_OF]->(v)
                     WITH v, i
                     UNWIND range(0, size($dep_names[i]) - 1) AS j
                     MERGE (d:Crate { name: $dep_names[i][j] })
                     CREATE (v)-[:DEPENDS_ON {
                         requirement: $dep_reqs[i][j],
                         features: $dep_features[i][j],
                         kind: $dep_kinds[i][j],
                         optional: $dep_optional[i][j]
                     }]->(d)",
            )
            .param("name", name)
            .param("versions", versions)
            .param("majors", majors)
            .param("minors", minors)
            .param("patches", patches)
            .param("builds", builds)
            .param("pres", pres)
            .param("dep_names", dep_names)
            .param("dep_reqs", dep_reqs)
            .param("dep_features", dep_features)
            .param("dep_kinds", dep_kinds)
            .param("dep_optional", dep_optional),
        )
        .await?;

        Ok(())
    }

    /// For each crate name that has a `(Crate)` node, list its `(Version)` nodes and which of
    /// them carry `INVOKES` edges. Names with no `(Crate)` node are absent from the result.
    /// Versions are reached through `VERSION_OF` because the `(name, version)` constraint
    /// index cannot serve a name-only lookup, which would otherwise scan every `Version`.
    ///
    /// # Panics
    /// Panics if the server returns a row without the requested columns.
    /// # Errors
    /// Returns `Error::Neo4jError` on a query failure.
    pub async fn crate_version_status(
        &self,
        names: &[&str],
    ) -> Result<std::collections::HashMap<String, CrateDbStatus>, Error> {
        let mut result = self
            .conn
            .execute(
                query(
                    "UNWIND $names AS name
                     MATCH (c:Crate { name: name })
                     OPTIONAL MATCH (c)-[:VERSION_OF]->(v:Version)
                     WITH name, v,
                          CASE WHEN v IS NULL THEN false
                               ELSE EXISTS { (v)-[:INVOKES]->() } END AS exported
                     RETURN name,
                            collect(v.version) AS versions,
                            collect(CASE WHEN exported THEN v.version END) AS exported",
                )
                .param("names", names.to_vec()),
            )
            .await?;

        let mut out = std::collections::HashMap::new();
        while let Ok(Some(row)) = result.next().await {
            let name: String = row.get("name").unwrap();
            let versions: Vec<String> = row.get("versions").unwrap();
            let exported: Vec<String> = row.get("exported").unwrap();
            out.insert(
                name,
                CrateDbStatus {
                    versions: versions.into_iter().collect(),
                    exported: exported.into_iter().collect(),
                },
            );
        }
        Ok(out)
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
        self.write(
            query(
                "MATCH (srcVersion:Version { name: $src_crate, version: $src_version }) 
                        MATCH (dstCrate:Crate { name: $dst_crate }) 
                        MERGE (srcVersion)-[:INVOKES {caller: $caller, callee: $callee}]->(dstCrate)
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
        let semver = parse_semver(version)?;

        let version_id = {
            let row = self
                .write_first_row(
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

            let version_node: Node = row
                .expect("MERGE returns the version")
                .get("version")
                .unwrap();

            version_node.id()
        };

        for depend in depends_on {
            self
                .write(
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
                .await?;
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

    /// Delete every `[:INVOKES]` edge of one crate version, leaving the `(Version)` node and all
    /// other relationships in place.
    ///
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    pub async fn delete_invokes<S1, S2>(&self, name: S1, version: S2) -> Result<(), Error>
    where
        S1: AsRef<str>,
        S2: AsRef<str>,
    {
        self.write(
            query("MATCH (:Version { name: $name, version: $version })-[r:INVOKES]->() DELETE r")
                .param("name", name.as_ref())
                .param("version", version.as_ref()),
        )
        .await?;
        Ok(())
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

    /// Mark `version` as the latest of crate `name` and clear the flag on its other versions,
    /// in one statement. Versions are reached through the `Crate` node: a name-only
    /// `MATCH (v:Version { name })` cannot use the `(name, version)` constraint index and
    /// label-scans every `Version` in the database.
    ///
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    pub async fn set_latest<S1, S2>(&self, name: S1, version: S2) -> Result<(), Error>
    where
        S1: AsRef<str>,
        S2: AsRef<str>,
    {
        self.write(
            query(
                "MATCH (:Crate { name: $name })-[:VERSION_OF]->(v:Version)
                 SET v.latest = (v.version = $version)",
            )
            .param("name", name.as_ref())
            .param("version", version.as_ref()),
        )
        .await
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
            .write_first_row(
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
            .is_none()
        {
            Err(Error::CrateNotFound(name.as_ref().to_string()))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_semver_accepts_strict_and_lenient_versions() {
        let v = parse_semver("1.2.3").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (1, 2, 3));
        // lenient: missing patch
        let v = parse_semver("1.2").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (1, 2, 0));
        // prerelease and build metadata survive
        let v = parse_semver("1.0.0-alpha.1+build.5").unwrap();
        assert_eq!(v.pre.as_str(), "alpha.1");
        assert_eq!(v.build.as_str(), "build.5");
    }

    #[test]
    fn parse_semver_falls_back_to_digit_stripping() {
        // Not valid even for lenient_semver, but the index contains strings like this: the
        // fallback keeps only the digits of the patch component.
        assert!(lenient_semver::parse("1.2.3!!").is_err());
        let v = parse_semver("1.2.3!!").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (1, 2, 3));
        assert!(matches!(
            parse_semver("1.x.3!!"),
            Err(Error::InvalidSemver(_))
        ));
        assert!(matches!(
            parse_semver("not.a.version"),
            Err(Error::InvalidSemver(_))
        ));
        assert!(matches!(parse_semver(""), Err(Error::InvalidSemver(_))));
    }

    #[test]
    fn is_transient_matches_deadlocks_only() {
        let deadlock = Error::CrateNotFound(
            "Neo.TransientError.Transaction.DeadlockDetected: ForsetiClient[...] can't acquire"
                .into(),
        );
        assert!(is_transient(&deadlock));
        assert!(is_transient(&Error::CrateNotFound(
            "Neo.TransientError.General.MemoryPoolOutOfMemoryError".into()
        )));
        assert!(!is_transient(&Error::CrateNotFound("serde".into())));
        assert!(!is_transient(&Error::InvalidSemver("1.x".into())));
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        assert!(backoff(1) >= Duration::from_millis(100));
        assert!(backoff(1) < Duration::from_millis(150));
        assert!(backoff(3) >= Duration::from_millis(400));
        // The shift is clamped so an absurd attempt count cannot overflow.
        assert!(backoff(60) <= Duration::from_millis(51_250));
    }

    #[test]
    fn crate_db_status_defaults_empty() {
        let s = CrateDbStatus::default();
        assert!(s.versions.is_empty());
        assert!(s.exported.is_empty());
    }
}
