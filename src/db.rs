use neo4rs::{Graph, Node, Query, Row, query};
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
    /// Version strings whose node has a call graph: at least one `[:HAS_FN]` function.
    pub exported: std::collections::HashSet<String>,
}

/// Attempts made for one write before giving up on a transient error.
const WRITE_RETRIES: u32 = 6;

/// `[:CALLS]` edges [`Db::insert_calls`] creates per transaction (rounded up to whole callers).
pub const CALLS_PER_TX: usize = 10_000;

/// `(:Fn)` nodes [`Db::delete_calls`] deletes per transaction, with all their relationships.
pub const FNS_PER_DELETE_TX: usize = 1_000;

/// One distinct call made by a crate version: function `caller` calls `callee`, a function of
/// the crate whose `(Crate)` node is named `crate_name`.
///
/// `copies` is how many compiled (caller, callee) function pairs share these demangled names.
/// Painter demangles without the symbol hash, and legacy Rust mangling does not encode
/// generic arguments, so every monomorphised instance of a generic function (`foo::<u8>`,
/// `foo::<String>`, ...) gets the same name; [`collapse_calls`] folds them into one row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallRow {
    pub caller: String,
    pub callee: String,
    pub crate_name: String,
    pub copies: i64,
}

/// Longest function name stored as is in `Symbol.name`. Neo4j's range indexes (the
/// `Symbol.name` uniqueness constraint) reject values over about 8 KB, and deeply nested
/// generic types produce names that long; see [`symbol_key`].
pub const MAX_SYMBOL_NAME_BYTES: usize = 4096;

/// Bytes of a long name kept at the front of its [`symbol_key`].
const SYMBOL_KEY_PREFIX_BYTES: usize = 4000;

/// The `Symbol.name` a function name is stored under, and the full name when that differs.
///
/// Names up to [`MAX_SYMBOL_NAME_BYTES`] are their own key. A longer name is keyed by its first
/// 4000 bytes, `…#`, and the 64-bit FNV-1a hash of the whole name in hex; the full name goes in
/// the unindexed `Symbol.full_name`. The key is deterministic, so every version that mentions
/// the same long function `MERGE`s onto the same node, and the prefix still starts with the
/// function's path (so its crate can be read from it).
#[must_use]
pub fn symbol_key(name: &str) -> (std::borrow::Cow<'_, str>, Option<&str>) {
    if name.len() <= MAX_SYMBOL_NAME_BYTES {
        return (std::borrow::Cow::Borrowed(name), None);
    }
    let mut cut = SYMBOL_KEY_PREFIX_BYTES;
    while !name.is_char_boundary(cut) {
        cut -= 1;
    }
    let hash = name.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    });
    (
        std::borrow::Cow::Owned(format!("{}…#{hash:016x}", &name[..cut])),
        Some(name),
    )
}

/// Fold repeated `(caller, callee, callee crate)` triples into one [`CallRow`] each, counting
/// the repeats in `copies`. Nothing but the multiplicity is lost: the repeats are identical
/// once demangled.
/// The result is sorted by caller, then callee, so each caller's calls are adjacent.
#[must_use]
pub fn collapse_calls<I>(calls: I) -> Vec<CallRow>
where
    I: IntoIterator<Item = (String, String, String)>,
{
    let mut counts = std::collections::BTreeMap::<(String, String, String), i64>::new();
    for call in calls {
        *counts.entry(call).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|((caller, callee, crate_name), copies)| CallRow {
            caller,
            callee,
            crate_name,
            copies,
        })
        .collect()
}

/// Split `calls` (sorted by caller, as [`collapse_calls`] returns them) into batches of whole
/// callers holding about `per_batch` calls each. A caller is never split across batches, so a
/// batch can exceed `per_batch` by one caller's calls.
#[must_use]
pub fn caller_batches(calls: &[CallRow], per_batch: usize) -> Vec<Vec<&[CallRow]>> {
    let mut batches = Vec::new();
    let mut batch: Vec<&[CallRow]> = Vec::new();
    let mut size = 0;
    for group in calls.chunk_by(|a, b| a.caller == b.caller) {
        batch.push(group);
        size += group.len();
        if size >= per_batch {
            batches.push(std::mem::take(&mut batch));
            size = 0;
        }
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    batches
}

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

    /// Replace the call graph of one crate version. Every `(:Fn)` the version already has is
    /// deleted first ([`Db::delete_calls`]), so re-importing a version never duplicates calls.
    /// `calls` must be sorted by caller, as [`collapse_calls`] returns them, and every
    /// `crate_name` should name an existing `(Crate)`; a call whose crate is missing is dropped
    /// by the `MATCH`.
    ///
    /// ```text
    /// (Version)-[:HAS_FN]->(:Fn)-[:IS]->(:Symbol {name: caller})
    /// (:Fn)-[:CALLS {copies}]->(:Symbol {name: callee})-[:IN]->(Crate)
    /// ```
    ///
    /// `(:Symbol)` nodes are shared by every version that calls or defines the same function
    /// and are `MERGE`d through the `Symbol.name` uniqueness constraint on their
    /// [`symbol_key`] (see
    /// `docker/queries.md`); so is a symbol's `IN` edge. Writes run [`CALLS_PER_TX`] calls per
    /// transaction (whole callers each), so the replacement is not atomic: if it fails part way
    /// the version keeps some of its new calls, and re-importing it fixes that. An empty
    /// `calls` still deletes the old graph.
    ///
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    pub async fn insert_calls(
        &self,
        src_crate: (&str, &str),
        calls: &[CallRow],
    ) -> Result<(), Error> {
        self.delete_calls(src_crate.0, src_crate.1).await?;

        for batch in caller_batches(calls, CALLS_PER_TX) {
            // neo4rs 0.6 does not expose its map type, so send parallel (nested) lists and
            // index them: callers[i] calls callees[i][j] in crate dsts[i][j]. Names are sent
            // as their `symbol_key`, with the full name alongside when it was shortened.
            let from_keys: Vec<(std::borrow::Cow<'_, str>, Option<&str>)> =
                batch.iter().map(|g| symbol_key(&g[0].caller)).collect();
            let to_keys: Vec<Vec<(std::borrow::Cow<'_, str>, Option<&str>)>> = batch
                .iter()
                .map(|g| g.iter().map(|c| symbol_key(&c.callee)).collect())
                .collect();
            let from_fns: Vec<&str> = from_keys.iter().map(|k| k.0.as_ref()).collect();
            // neo4rs 0.6 cannot send nulls in lists: "" stands for "not shortened".
            let from_full: Vec<&str> = from_keys.iter().map(|k| k.1.unwrap_or("")).collect();
            let to_fns: Vec<Vec<&str>> = to_keys
                .iter()
                .map(|g| g.iter().map(|k| k.0.as_ref()).collect())
                .collect();
            let to_full: Vec<Vec<&str>> = to_keys
                .iter()
                .map(|g| g.iter().map(|k| k.1.unwrap_or("")).collect())
                .collect();
            let dsts: Vec<Vec<&str>> = batch
                .iter()
                .map(|g| g.iter().map(|c| c.crate_name.as_str()).collect())
                .collect();
            let copies: Vec<Vec<i64>> = batch
                .iter()
                .map(|g| g.iter().map(|c| c.copies).collect())
                .collect();

            self.write(
                query(
                    "MATCH (v:Version { name: $src_crate, version: $src_version })
                     UNWIND range(0, size($callers) - 1) AS i
                     MERGE (cs:Symbol { name: $callers[i] })
                       ON CREATE SET cs.full_name = nullIf($callers_full[i], '')
                     CREATE (v)-[:HAS_FN]->(f:Fn)-[:IS]->(cs)
                     WITH f, i
                     UNWIND range(0, size($callees[i]) - 1) AS j
                     MATCH (c:Crate { name: $dsts[i][j] })
                     MERGE (ts:Symbol { name: $callees[i][j] })
                       ON CREATE SET ts.full_name = nullIf($callees_full[i][j], '')
                     MERGE (ts)-[:IN]->(c)
                     CREATE (f)-[:CALLS { copies: $copies[i][j] }]->(ts)",
                )
                .param("src_crate", src_crate.0)
                .param("src_version", src_crate.1)
                .param("callers", from_fns)
                .param("callers_full", from_full)
                .param("callees", to_fns)
                .param("callees_full", to_full)
                .param("dsts", dsts)
                .param("copies", copies),
            )
            .await?;
        }

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
    /// them have a call graph (`HAS_FN`). Names with no `(Crate)` node are absent from the result.
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
                               ELSE EXISTS { (v)-[:HAS_FN]->() } END AS exported
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

    /// Delete the call graph of one crate version: its `(:Fn)` nodes with their `HAS_FN`,
    /// `IS`, and `CALLS` edges, [`FNS_PER_DELETE_TX`] functions per transaction. The
    /// `(Version)` node, its other relationships, and the shared `(:Symbol)` nodes stay; a
    /// symbol nothing refers to any more is left in place.
    ///
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    pub async fn delete_calls<S1, S2>(&self, name: S1, version: S2) -> Result<(), Error>
    where
        S1: AsRef<str>,
        S2: AsRef<str>,
    {
        let limit = i64::try_from(FNS_PER_DELETE_TX).unwrap_or(i64::MAX);
        loop {
            let row = self
                .write_first_row(
                    query(
                        "MATCH (:Version { name: $name, version: $version })-[:HAS_FN]->(f:Fn)
                         WITH f LIMIT $limit
                         DETACH DELETE f
                         RETURN count(f) AS deleted",
                    )
                    .param("name", name.as_ref())
                    .param("version", version.as_ref())
                    .param("limit", limit),
                )
                .await?;
            let deleted: i64 = row.and_then(|r| r.get("deleted")).unwrap_or(0);
            if deleted < limit {
                return Ok(());
            }
        }
    }

    /// Which of `names` exist as `(Crate)` nodes. One indexed lookup per name, sent in chunks.
    ///
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    pub async fn existing_crate_names(
        &self,
        names: &[String],
    ) -> Result<std::collections::HashSet<String>, Error> {
        let mut found = std::collections::HashSet::new();
        for chunk in names.chunks(5000) {
            let mut stream = self
                .conn
                .execute(
                    query("UNWIND $names AS n MATCH (c:Crate { name: n }) RETURN c.name AS name")
                        .param("names", chunk.to_vec()),
                )
                .await?;
            while let Some(row) = stream.next().await? {
                if let Some(name) = row.get::<String>("name") {
                    found.insert(name);
                }
            }
        }
        Ok(found)
    }

    /// Whether a crate version already has a call graph (at least one `[:HAS_FN]` function).
    ///
    /// # Panics
    /// Panics if the result stream fails after the query was accepted.
    /// # Errors
    /// This function will return an `painter::db::Error` in the event of a database error.
    pub async fn has_call_graph<S1, S2>(&self, name: S1, version: S2) -> Result<bool, Error>
    where
        S1: AsRef<str>,
        S2: AsRef<str>,
    {
        Ok(self
            .conn
            .execute(
                query("MATCH (:Version { name: $name, version: $version })-[:HAS_FN]->() RETURN 1 AS found LIMIT 1")
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

    fn call(from: &str, to: &str, copies: i64) -> CallRow {
        CallRow {
            caller: from.into(),
            callee: to.into(),
            crate_name: "k".into(),
            copies,
        }
    }

    #[test]
    fn collapse_calls_counts_copies_and_sorts_by_caller() {
        let t = |a: &str, b: &str| (a.to_string(), b.to_string(), "k".to_string());
        let calls = collapse_calls([
            t("b", "x"),
            t("a", "y"),
            t("b", "x"),
            t("a", "x"),
            t("b", "x"),
        ]);
        assert_eq!(
            calls,
            vec![call("a", "x", 1), call("a", "y", 1), call("b", "x", 3)]
        );
    }

    #[test]
    fn collapse_calls_keeps_distinct_crates_apart() {
        let calls = collapse_calls([
            ("f".to_string(), "g".to_string(), "one".to_string()),
            ("f".to_string(), "g".to_string(), "two".to_string()),
        ]);
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().all(|c| c.copies == 1));
    }

    #[test]
    fn caller_batches_keep_callers_whole() {
        let calls = vec![
            call("a", "x", 1),
            call("a", "y", 1),
            call("b", "x", 1),
            call("c", "x", 1),
            call("c", "y", 1),
            call("c", "z", 1),
        ];
        let batches = caller_batches(&calls, 2);
        let callers: Vec<Vec<&str>> = batches
            .iter()
            .map(|b| b.iter().map(|g| g[0].caller.as_str()).collect())
            .collect();
        assert_eq!(callers, vec![vec!["a"], vec!["b", "c"]]);
        assert_eq!(
            batches.iter().flatten().map(|g| g.len()).sum::<usize>(),
            calls.len()
        );
        assert_eq!(caller_batches(&[], 2).len(), 0);
    }

    #[test]
    fn symbol_key_keeps_short_names_and_shortens_long_ones_deterministically() {
        assert_eq!(
            symbol_key("a::b"),
            (std::borrow::Cow::Borrowed("a::b"), None)
        );
        let exact = "x".repeat(MAX_SYMBOL_NAME_BYTES);
        assert_eq!(symbol_key(&exact).1, None);

        let long = format!("serde::de::{}", "<T as Trait>".repeat(800));
        let (key, full) = symbol_key(&long);
        assert_eq!(full, Some(long.as_str()));
        assert!(key.len() <= MAX_SYMBOL_NAME_BYTES);
        assert!(key.starts_with("serde::de::"));
        assert_eq!(symbol_key(&long).0, key);
        let other = format!("{long}x");
        assert_ne!(symbol_key(&other).0, key);
    }

    #[test]
    fn symbol_key_cuts_on_a_char_boundary() {
        let long = "é".repeat(MAX_SYMBOL_NAME_BYTES);
        let (key, _) = symbol_key(&long);
        assert!(key.starts_with(&"é".repeat(SYMBOL_KEY_PREFIX_BYTES / 2)));
    }

    #[test]
    fn crate_db_status_defaults_empty() {
        let s = CrateDbStatus::default();
        assert!(s.versions.is_empty());
        assert!(s.exported.is_empty());
    }
}
