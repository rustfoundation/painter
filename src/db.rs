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

/// Lenient because the index contains non-compliant versions.
///
/// # Errors
/// `Error::InvalidSemver` if no interpretation works.
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

#[derive(Debug, Clone)]
pub struct DependencyRow {
    pub name: String,
    pub requirement: String,
    pub features: String,
    pub kind: String,
    pub optional: bool,
}

#[derive(Debug, Clone)]
pub struct VersionRow {
    pub version: String,
    pub dependencies: Vec<DependencyRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CrateDbStatus {
    pub versions: std::collections::HashSet<String>,
    pub exported: std::collections::HashSet<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MetaState {
    pub name: String,
    pub version: String,
    pub latest: bool,
    pub unsafe_scanner: Option<String>,
    pub unsafe_error: bool,
    pub meta_build: Option<String>,
    pub meta_native: Option<String>,
    pub meta_diff: Option<String>,
    pub diff_base: Option<String>,
    pub meta_registry: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegistryUser {
    pub id: u32,
    pub login: String,
    pub name: String,
    /// -1 if unknown.
    pub gh_id: i64,
    /// RFC 3339; empty if absent.
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegistryTeam {
    pub id: u32,
    pub login: String,
    pub name: String,
    pub avatar: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegistryCategory {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub crates: i64,
}

/// Dates are RFC 3339; empty strings mean absent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegistryCrate {
    pub name: String,
    pub id: u32,
    pub created_at: String,
    pub updated_at: String,
    pub description: String,
    pub homepage: String,
    pub documentation: String,
    pub repository: String,
    pub downloads: i64,
    pub trustpub_only: bool,
    pub default_version: String,
    pub num_versions: i64,
    /// `(user id, since, added by login)`.
    pub user_owners: Vec<(u32, String, String)>,
    /// `(team id, since, added by login)`.
    pub team_owners: Vec<(u32, String, String)>,
    /// `(user id, first upload, last upload, versions uploaded)`.
    pub publishers: Vec<(u32, String, String, i64)>,
    pub categories: Vec<String>,
    pub keywords: Vec<String>,
}

/// `record` is `None` when the dump does not know the version.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegistryVersion {
    pub name: String,
    pub version: String,
    pub record: Option<crate::metadata::registry::VersionRecord>,
}

fn int(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

const WRITE_RETRIES: u32 = 6;

pub const CALLS_PER_TX: usize = 10_000;

pub const FNS_PER_DELETE_TX: usize = 1_000;

/// `copies`: painter demangles without the symbol hash and legacy mangling drops generic args,
/// so monomorphised instances share a name; [`collapse_calls`] folds them into one row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallRow {
    pub caller: String,
    pub callee: String,
    pub crate_name: String,
    pub copies: i64,
}

/// Neo4j range indexes (the `Symbol.name` constraint) reject values over about 8 KB; see [`symbol_key`].
pub const MAX_SYMBOL_NAME_BYTES: usize = 4096;

const SYMBOL_KEY_PREFIX_BYTES: usize = 4000;

/// Longer names are keyed by a 4000-byte prefix, `…#`, and the FNV-1a hash of the whole name,
/// with the full name in unindexed `Symbol.full_name`. Deterministic, so every version `MERGE`s onto
/// the same node; the prefix keeps the path so the callee crate can still be read from it.
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

/// Repeats are identical once demangled, so only multiplicity is lost. Sorted by caller so each
/// caller's calls are adjacent.
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

/// Callers are never split, so a batch can exceed `per_batch` by one caller's calls.
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

/// Neo4j rolls the failed transaction back, so a retry never duplicates data.
#[must_use]
pub fn is_transient(e: &Error) -> bool {
    let msg = e.to_string();
    msg.contains("Neo.TransientError")
        || msg.contains("DeadlockDetected")
        || msg.contains("ForsetiClient")
}

/// Jitter keeps writers that deadlocked against each other from retrying in lockstep.
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
    async fn write(&self, q: Query) -> Result<(), Error> {
        self.write_first_row(q).await.map(|_| ())
    }

    /// Consumes the whole result inside the retry loop so a transient failure while streaming rows
    /// is retried too.
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

    /// # Panics
    /// On invalid configuration.
    /// # Errors
    /// On connection failure.
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
                    // Without this `metadata_work_list` takes one round trip per 10 of its millions of rows.
                    .fetch_size(1_000)
                    .max_connections(64)
                    .build()
                    .unwrap(),
            )
            .await?,
        );
        Ok(Self { conn })
    }

    /// Not atomic: [`CALLS_PER_TX`] calls per transaction, so a failure part way keeps some new calls;
    /// re-importing fixes it. `calls` must be sorted by caller; calls into a missing `(Crate)` are
    /// dropped by the `MATCH`.
    ///
    /// # Errors
    /// On a database error.
    pub async fn insert_calls(
        &self,
        src_crate: (&str, &str),
        calls: &[CallRow],
    ) -> Result<(), Error> {
        self.delete_calls(src_crate.0, src_crate.1).await?;

        for batch in caller_batches(calls, CALLS_PER_TX) {
            // neo4rs 0.6 has no map type: send parallel (nested) lists, callers[i] calls callees[i][j] in
            // crate dsts[i][j].
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

    /// Skips versions that already exist, so an interrupted import is resumable. `(Crate)` is `MERGE`d
    /// because dependencies may have created it.
    ///
    /// # Errors
    /// On a database error.
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

    /// Reached through `VERSION_OF`: the `(name, version)` index cannot serve a name-only lookup.
    ///
    /// # Panics
    /// If the server returns a row without the requested columns.
    /// # Errors
    /// On a database error.
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

    /// Dependencies link to `(Crate)`, not a version, because semver resolution shifts with build time.
    ///
    /// # Panics
    /// If the new `Crate` node is not returned on insertion.
    /// # Errors
    /// On a database error.
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

    /// # Panics
    /// If the result stream fails.
    /// # Errors
    /// On a database error.
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

    /// Shared `(:Symbol)` nodes stay, even if nothing refers to them any more.
    ///
    /// # Errors
    /// On a database error.
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

    /// # Errors
    /// On a database error.
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

    /// # Panics
    /// If the result stream fails after the query was accepted.
    /// # Errors
    /// On a database error.
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

    /// Reached through the `Crate` node: a name-only `MATCH (v:Version { name })` cannot use the
    /// `(name, version)` index and scans every `Version`.
    ///
    /// # Errors
    /// On a database error.
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

    /// # Panics
    /// If the result stream fails.
    /// # Errors
    /// On a database error.
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

    /// # Panics
    /// If the result stream fails.
    /// # Errors
    /// On a database error.
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

    /// Reached through `(Crate)`: a bare `(v:Version)` scan cannot use the name constraint index.
    ///
    /// # Panics
    /// If the server returns a row without the requested columns.
    /// # Errors
    /// On a database error.
    pub async fn metadata_work_list(&self, only: &[String]) -> Result<Vec<MetaState>, Error> {
        let start = if only.is_empty() {
            "MATCH (c:Crate)-[:VERSION_OF]->(v:Version)"
        } else {
            "UNWIND $only AS only MATCH (c:Crate { name: only })-[:VERSION_OF]->(v:Version)"
        };
        let mut stream = self
            .conn
            .execute(
                query(&format!(
                    "{start}
                     RETURN c.name AS name, v.version AS version, coalesce(v.latest, false) AS latest,
                            coalesce(v.unsafe_scanner, '') AS unsafe_scanner,
                            v.unsafe_error IS NOT NULL AS unsafe_error,
                            coalesce(v.meta_build, '') AS meta_build,
                            coalesce(v.meta_native, '') AS meta_native,
                            coalesce(v.meta_diff, '') AS meta_diff,
                            coalesce(v.diff_base, '') AS diff_base,
                            coalesce(v.meta_registry, '') AS meta_registry"
                ))
                .param("only", only.to_vec()),
            )
            .await?;
        let mut out = Vec::new();
        let opt = |s: String| (!s.is_empty()).then_some(s);
        while let Some(row) = stream.next().await? {
            out.push(MetaState {
                name: row.get("name").unwrap(),
                version: row.get("version").unwrap(),
                latest: row.get("latest").unwrap(),
                unsafe_scanner: opt(row.get("unsafe_scanner").unwrap()),
                unsafe_error: row.get("unsafe_error").unwrap(),
                meta_build: opt(row.get("meta_build").unwrap()),
                meta_native: opt(row.get("meta_native").unwrap()),
                meta_diff: opt(row.get("meta_diff").unwrap()),
                diff_base: opt(row.get("diff_base").unwrap()),
                meta_registry: opt(row.get("meta_registry").unwrap()),
            });
        }
        Ok(out)
    }

    /// Every property is `SET`, so rewriting a version replaces it; `forbids_unsafe` is absent when no
    /// crate root file parsed.
    ///
    /// # Errors
    /// On a database error.
    #[allow(clippy::too_many_lines)]
    pub async fn set_unsafe_batch(
        &self,
        results: &[(
            &str,
            &str,
            &Result<crate::metadata::unsafety::UnsafeMetrics, String>,
        )],
    ) -> Result<(), Error> {
        use crate::metadata::unsafety::{SCANNER, UnsafeMetrics};
        let ok: Vec<(&str, &str, &UnsafeMetrics)> = results
            .iter()
            .filter_map(|(n, v, r)| Some((*n, *v, r.as_ref().ok()?)))
            .collect();
        if !ok.is_empty() {
            let col = |f: &dyn Fn(&UnsafeMetrics) -> u64| -> Vec<i64> {
                ok.iter().map(|(_, _, m)| int(f(m))).collect()
            };
            self.write(
                query(
                    "UNWIND range(0, size($names) - 1) AS i
                     MATCH (v:Version { name: $names[i], version: $versions[i] })
                     SET v.unsafe_total = $unsafe_total[i],
                         v.unsafe_functions = $unsafe_functions[i],
                         v.unsafe_exprs = $unsafe_exprs[i],
                         v.unsafe_impls = $unsafe_impls[i],
                         v.unsafe_traits = $unsafe_traits[i],
                         v.unsafe_methods = $unsafe_methods[i],
                         v.safe_functions = $safe_functions[i],
                         v.safe_exprs = $safe_exprs[i],
                         v.safe_impls = $safe_impls[i],
                         v.safe_traits = $safe_traits[i],
                         v.safe_methods = $safe_methods[i],
                         v.rs_files = $rs_files[i],
                         v.rs_files_failed = $rs_files_failed[i],
                         v.rs_lines = $rs_lines[i],
                         v.rs_bytes = $rs_bytes[i],
                         v.rs_forbid_files = $rs_forbid_files[i],
                         v.forbids_unsafe = CASE $forbids[i] WHEN 1 THEN true WHEN 0 THEN false ELSE null END,
                         v.unsafe_scanner = $scanner,
                         v.unsafe_scanned_at = datetime()
                     REMOVE v.unsafe_error",
                )
                .param("names", ok.iter().map(|o| o.0).collect::<Vec<_>>())
                .param("versions", ok.iter().map(|o| o.1).collect::<Vec<_>>())
                .param("unsafe_total", col(&UnsafeMetrics::total_unsafe))
                .param("unsafe_functions", col(&|m| m.counters.functions.unsafe_))
                .param("unsafe_exprs", col(&|m| m.counters.exprs.unsafe_))
                .param("unsafe_impls", col(&|m| m.counters.item_impls.unsafe_))
                .param("unsafe_traits", col(&|m| m.counters.item_traits.unsafe_))
                .param("unsafe_methods", col(&|m| m.counters.methods.unsafe_))
                .param("safe_functions", col(&|m| m.counters.functions.safe))
                .param("safe_exprs", col(&|m| m.counters.exprs.safe))
                .param("safe_impls", col(&|m| m.counters.item_impls.safe))
                .param("safe_traits", col(&|m| m.counters.item_traits.safe))
                .param("safe_methods", col(&|m| m.counters.methods.safe))
                .param("rs_files", col(&|m| m.rs_files))
                .param("rs_files_failed", col(&|m| m.rs_files_failed))
                .param("rs_lines", col(&|m| m.rs_lines))
                .param("rs_bytes", col(&|m| m.rs_bytes))
                .param("rs_forbid_files", col(&|m| m.rs_forbid_files))
                .param(
                    "forbids",
                    ok.iter()
                        .map(|(_, _, m)| match m.forbids_unsafe {
                            Some(true) => 1,
                            Some(false) => 0,
                            None => -1,
                        })
                        .collect::<Vec<i64>>(),
                )
                .param("scanner", SCANNER),
            )
            .await?;
        }

        let failed: Vec<(&str, &str, &str)> = results
            .iter()
            .filter_map(|(n, v, r)| Some((*n, *v, r.as_ref().err()?.as_str())))
            .collect();
        if !failed.is_empty() {
            self.write(
                query(
                    "UNWIND range(0, size($names) - 1) AS i
                     MATCH (v:Version { name: $names[i], version: $versions[i] })
                     SET v.unsafe_error = $errors[i],
                         v.unsafe_scanner = $scanner,
                         v.unsafe_scanned_at = datetime()
                     REMOVE v.unsafe_total, v.unsafe_functions, v.unsafe_exprs, v.unsafe_impls,
                            v.unsafe_traits, v.unsafe_methods, v.safe_functions, v.safe_exprs,
                            v.safe_impls, v.safe_traits, v.safe_methods, v.rs_files,
                            v.rs_files_failed, v.rs_lines, v.rs_bytes, v.rs_forbid_files,
                            v.forbids_unsafe",
                )
                .param("names", failed.iter().map(|o| o.0).collect::<Vec<_>>())
                .param("versions", failed.iter().map(|o| o.1).collect::<Vec<_>>())
                .param("errors", failed.iter().map(|o| o.2).collect::<Vec<_>>())
                .param("scanner", SCANNER),
            )
            .await?;
        }
        Ok(())
    }

    /// Absent values are `SET` to null, which removes a stale property.
    ///
    /// # Errors
    /// On a database error.
    pub async fn set_build_batch(
        &self,
        results: &[(&str, &str, &crate::metadata::build::BuildInfo)],
    ) -> Result<(), Error> {
        if results.is_empty() {
            return Ok(());
        }
        self.write(
            query(
                "UNWIND range(0, size($names) - 1) AS i
                 MATCH (v:Version { name: $names[i], version: $versions[i] })
                 SET v.has_build_script = $has[i],
                     v.build_script = nullIf($paths[i], ''),
                     v.build_script_lines = CASE WHEN $lines[i] < 0 THEN null ELSE $lines[i] END,
                     v.links = nullIf($links[i], ''),
                     v.meta_build = $revision",
            )
            .param("names", results.iter().map(|r| r.0).collect::<Vec<_>>())
            .param("versions", results.iter().map(|r| r.1).collect::<Vec<_>>())
            .param(
                "has",
                results
                    .iter()
                    .map(|r| r.2.has_build_script)
                    .collect::<Vec<_>>(),
            )
            .param(
                "paths",
                results
                    .iter()
                    .map(|r| r.2.path.as_deref().unwrap_or(""))
                    .collect::<Vec<_>>(),
            )
            .param(
                "lines",
                results
                    .iter()
                    .map(|r| r.2.lines.map_or(-1, int))
                    .collect::<Vec<_>>(),
            )
            .param(
                "links",
                results
                    .iter()
                    .map(|r| r.2.links.as_deref().unwrap_or(""))
                    .collect::<Vec<_>>(),
            )
            .param("revision", crate::metadata::build::REVISION),
        )
        .await
    }

    /// # Errors
    /// On a database error.
    pub async fn set_native_batch(
        &self,
        results: &[(&str, &str, &crate::metadata::native::NativeInfo)],
    ) -> Result<(), Error> {
        use crate::metadata::native::NativeInfo;
        if results.is_empty() {
            return Ok(());
        }
        let col = |f: &dyn Fn(&NativeInfo) -> u64| -> Vec<i64> {
            results.iter().map(|r| int(f(r.2))).collect()
        };
        self.write(
            query(
                "UNWIND range(0, size($names) - 1) AS i
                 MATCH (v:Version { name: $names[i], version: $versions[i] })
                 SET v.has_native_code = $has[i],
                     v.vendored_native = $vendored[i],
                     v.native_source_files = $source_files[i],
                     v.native_header_files = $header_files[i],
                     v.native_source_lines = $source_lines[i],
                     v.native_lines = $total_lines[i],
                     v.native_bytes = $bytes[i],
                     v.native_largest_bytes = $largest[i],
                     v.native_vendor_dir_lines = $vendor_lines[i],
                     v.native_langs = $langs[i],
                     v.native_dirs = $dirs[i],
                     v.native_prebuilt_files = $prebuilt[i],
                     v.meta_native = $revision",
            )
            .param("names", results.iter().map(|r| r.0).collect::<Vec<_>>())
            .param("versions", results.iter().map(|r| r.1).collect::<Vec<_>>())
            .param(
                "has",
                results
                    .iter()
                    .map(|r| r.2.has_native_code())
                    .collect::<Vec<_>>(),
            )
            .param(
                "vendored",
                results.iter().map(|r| r.2.vendored).collect::<Vec<_>>(),
            )
            .param("source_files", col(&|n| n.source_files))
            .param("header_files", col(&|n| n.header_files))
            .param("source_lines", col(&|n| n.source_lines))
            .param("total_lines", col(&|n| n.total_lines))
            .param("bytes", col(&|n| n.bytes))
            .param("largest", col(&|n| n.largest_bytes))
            .param("vendor_lines", col(&|n| n.vendor_dir_lines))
            .param("prebuilt", col(&|n| n.prebuilt_files))
            .param(
                "langs",
                results
                    .iter()
                    .map(|r| r.2.langs.clone())
                    .collect::<Vec<_>>(),
            )
            .param(
                "dirs",
                results.iter().map(|r| r.2.dirs.clone()).collect::<Vec<_>>(),
            )
            .param("revision", crate::metadata::native::REVISION),
        )
        .await
    }

    /// The per-file lists are replaced wholesale, so rewriting never duplicates entries.
    ///
    /// # Errors
    /// On a database error.
    #[allow(clippy::too_many_lines)]
    pub async fn set_diff_batch(
        &self,
        results: &[(&str, &str, &crate::metadata::diff::DiffInfo)],
    ) -> Result<(), Error> {
        if results.is_empty() {
            return Ok(());
        }
        let list = |f: &dyn Fn(&crate::metadata::diff::FileChange) -> i64| -> Vec<Vec<i64>> {
            results
                .iter()
                .map(|r| r.2.files.iter().map(f).collect())
                .collect()
        };
        self.write(
            query(
                "UNWIND range(0, size($names) - 1) AS i
                 MATCH (v:Version { name: $names[i], version: $versions[i] })
                 SET v.diff_base = nullIf($bases[i], ''),
                     v.diff_files_added = $files_added[i],
                     v.diff_files_removed = $files_removed[i],
                     v.diff_files_modified = $files_modified[i],
                     v.diff_lines_added = $lines_added[i],
                     v.diff_lines_removed = $lines_removed[i],
                     v.diff_files_total = $files_total[i],
                     v.diff_approximate = $approximate[i],
                     v.diff_paths = $paths[i],
                     v.diff_status = $status[i],
                     v.diff_added = $added[i],
                     v.diff_removed = $removed[i],
                     v.diff_binary = $binary[i],
                     v.meta_diff = $revision",
            )
            .param("names", results.iter().map(|r| r.0).collect::<Vec<_>>())
            .param("versions", results.iter().map(|r| r.1).collect::<Vec<_>>())
            .param(
                "bases",
                results
                    .iter()
                    .map(|r| r.2.base.as_deref().unwrap_or(""))
                    .collect::<Vec<_>>(),
            )
            .param(
                "files_added",
                results
                    .iter()
                    .map(|r| int(r.2.files_added()))
                    .collect::<Vec<_>>(),
            )
            .param(
                "files_removed",
                results
                    .iter()
                    .map(|r| int(r.2.files_removed()))
                    .collect::<Vec<_>>(),
            )
            .param(
                "files_modified",
                results
                    .iter()
                    .map(|r| int(r.2.files_modified()))
                    .collect::<Vec<_>>(),
            )
            .param(
                "lines_added",
                results
                    .iter()
                    .map(|r| int(r.2.lines_added()))
                    .collect::<Vec<_>>(),
            )
            .param(
                "lines_removed",
                results
                    .iter()
                    .map(|r| int(r.2.lines_removed()))
                    .collect::<Vec<_>>(),
            )
            .param(
                "files_total",
                results
                    .iter()
                    .map(|r| int(r.2.files_total))
                    .collect::<Vec<_>>(),
            )
            .param(
                "approximate",
                results.iter().map(|r| r.2.approximate).collect::<Vec<_>>(),
            )
            .param(
                "paths",
                results
                    .iter()
                    .map(|r| r.2.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>())
                    .collect::<Vec<_>>(),
            )
            .param(
                "status",
                results
                    .iter()
                    .map(|r| {
                        r.2.files
                            .iter()
                            .map(|f| f.status.as_str())
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>(),
            )
            .param("added", list(&|f| int(f.added)))
            .param("removed", list(&|f| int(f.removed)))
            .param(
                "binary",
                results
                    .iter()
                    .map(|r| r.2.files.iter().map(|f| f.binary).collect::<Vec<_>>())
                    .collect::<Vec<_>>(),
            )
            .param("revision", crate::metadata::diff::REVISION),
        )
        .await
    }

    /// A non-empty entry leaves the version's jobs pending so the next run retries them.
    ///
    /// # Errors
    /// On a database error.
    pub async fn set_meta_error_batch(&self, results: &[(&str, &str, &str)]) -> Result<(), Error> {
        if results.is_empty() {
            return Ok(());
        }
        self.write(
            query(
                "UNWIND range(0, size($names) - 1) AS i
                 MATCH (v:Version { name: $names[i], version: $versions[i] })
                 SET v.meta_error = nullIf($errors[i], '')",
            )
            .param("names", results.iter().map(|r| r.0).collect::<Vec<_>>())
            .param("versions", results.iter().map(|r| r.1).collect::<Vec<_>>())
            .param("errors", results.iter().map(|r| r.2).collect::<Vec<_>>()),
        )
        .await
    }

    /// New indexes populate in the background.
    ///
    /// # Errors
    /// On a database error.
    pub async fn ensure_registry_schema(&self) -> Result<(), Error> {
        for q in REGISTRY_SCHEMA_CYPHER {
            self.write(query(q)).await?;
        }
        Ok(())
    }

    /// # Errors
    /// On a database error.
    pub async fn upsert_registry_users(&self, users: &[&RegistryUser]) -> Result<(), Error> {
        if users.is_empty() {
            return Ok(());
        }
        self.write(
            query(
                "UNWIND range(0, size($ids) - 1) AS i
                 MERGE (u:User { id: $ids[i] })
                 SET u.login = $logins[i],
                     u.name = nullIf($names[i], ''),
                     u.gh_id = CASE WHEN $gh[i] < 0 THEN null ELSE $gh[i] END,
                     u.created_at = CASE WHEN $created[i] = '' THEN null ELSE datetime($created[i]) END",
            )
            .param("ids", users.iter().map(|u| i64::from(u.id)).collect::<Vec<_>>())
            .param("logins", users.iter().map(|u| u.login.as_str()).collect::<Vec<_>>())
            .param("names", users.iter().map(|u| u.name.as_str()).collect::<Vec<_>>())
            .param("gh", users.iter().map(|u| u.gh_id).collect::<Vec<_>>())
            .param(
                "created",
                users.iter().map(|u| u.created_at.as_str()).collect::<Vec<_>>(),
            ),
        )
        .await
    }

    /// # Errors
    /// On a database error.
    pub async fn upsert_registry_teams(&self, teams: &[&RegistryTeam]) -> Result<(), Error> {
        if teams.is_empty() {
            return Ok(());
        }
        self.write(
            query(
                "UNWIND range(0, size($ids) - 1) AS i
                 MERGE (t:Team { id: $ids[i] })
                 SET t.login = $logins[i], t.name = nullIf($names[i], ''),
                     t.avatar = nullIf($avatars[i], '')",
            )
            .param(
                "ids",
                teams.iter().map(|t| i64::from(t.id)).collect::<Vec<_>>(),
            )
            .param(
                "logins",
                teams.iter().map(|t| t.login.as_str()).collect::<Vec<_>>(),
            )
            .param(
                "names",
                teams.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            )
            .param(
                "avatars",
                teams.iter().map(|t| t.avatar.as_str()).collect::<Vec<_>>(),
            ),
        )
        .await
    }

    /// # Errors
    /// On a database error.
    pub async fn upsert_registry_categories(
        &self,
        categories: &[&RegistryCategory],
    ) -> Result<(), Error> {
        if categories.is_empty() {
            return Ok(());
        }
        self.write(
            query(
                "UNWIND range(0, size($slugs) - 1) AS i
                 MERGE (c:Category { slug: $slugs[i] })
                 SET c.name = $names[i], c.description = nullIf($descriptions[i], ''),
                     c.path = $paths[i], c.crates = $crates[i]",
            )
            .param(
                "slugs",
                categories
                    .iter()
                    .map(|c| c.slug.as_str())
                    .collect::<Vec<_>>(),
            )
            .param(
                "names",
                categories
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>(),
            )
            .param(
                "descriptions",
                categories
                    .iter()
                    .map(|c| c.description.as_str())
                    .collect::<Vec<_>>(),
            )
            .param(
                "paths",
                categories
                    .iter()
                    .map(|c| c.path.as_str())
                    .collect::<Vec<_>>(),
            )
            .param(
                "crates",
                categories.iter().map(|c| c.crates).collect::<Vec<_>>(),
            ),
        )
        .await
    }

    /// Users, teams, and categories must exist first; crates without a `(Crate)` node are skipped.
    ///
    /// # Errors
    /// On a database error.
    #[allow(clippy::too_many_lines)]
    pub async fn set_registry_crates(&self, crates: &[RegistryCrate]) -> Result<(), Error> {
        if crates.is_empty() {
            return Ok(());
        }
        let col = |f: fn(&RegistryCrate) -> &str| crates.iter().map(f).collect::<Vec<_>>();
        self.write(
            query(
                "UNWIND range(0, size($names) - 1) AS i
                 MATCH (c:Crate { name: $names[i] })
                 SET c.registry_id = $ids[i],
                     c.created_at = CASE WHEN $created[i] = '' THEN null ELSE datetime($created[i]) END,
                     c.updated_at = CASE WHEN $updated[i] = '' THEN null ELSE datetime($updated[i]) END,
                     c.description = nullIf($descriptions[i], ''),
                     c.homepage = nullIf($homepages[i], ''),
                     c.documentation = nullIf($docs[i], ''),
                     c.repository = nullIf($repos[i], ''),
                     c.downloads = $downloads[i],
                     c.trustpub_only = $trustpub[i],
                     c.default_version = nullIf($defaults[i], ''),
                     c.num_versions = $num_versions[i]
                 WITH c, i
                 CALL { WITH c MATCH (c)<-[r:OWNS|PUBLISHED]-() DELETE r }
                 CALL { WITH c MATCH (c)-[r:IN_CATEGORY|HAS_KEYWORD]->() DELETE r }
                 CALL { WITH c, i
                     UNWIND range(0, size($uo_ids[i]) - 1) AS j
                     MATCH (u:User { id: $uo_ids[i][j] })
                     CREATE (u)-[:OWNS { since: datetime($uo_since[i][j]),
                                         added_by: nullIf($uo_by[i][j], '') }]->(c) }
                 CALL { WITH c, i
                     UNWIND range(0, size($to_ids[i]) - 1) AS j
                     MATCH (t:Team { id: $to_ids[i][j] })
                     CREATE (t)-[:OWNS { since: datetime($to_since[i][j]),
                                         added_by: nullIf($to_by[i][j], '') }]->(c) }
                 CALL { WITH c, i
                     UNWIND range(0, size($pub_ids[i]) - 1) AS j
                     MATCH (u:User { id: $pub_ids[i][j] })
                     CREATE (u)-[:PUBLISHED { at: datetime($pub_first[i][j]),
                                              last: datetime($pub_last[i][j]),
                                              versions: $pub_counts[i][j] }]->(c) }
                 CALL { WITH c, i
                     UNWIND $categories[i] AS slug
                     MATCH (cat:Category { slug: slug })
                     CREATE (c)-[:IN_CATEGORY]->(cat) }
                 CALL { WITH c, i
                     UNWIND $keywords[i] AS kw
                     MERGE (k:Keyword { name: kw })
                     CREATE (c)-[:HAS_KEYWORD]->(k) }",
            )
            .param("names", col(|c| &c.name))
            .param("ids", crates.iter().map(|c| i64::from(c.id)).collect::<Vec<_>>())
            .param("created", col(|c| &c.created_at))
            .param("updated", col(|c| &c.updated_at))
            .param("descriptions", col(|c| &c.description))
            .param("homepages", col(|c| &c.homepage))
            .param("docs", col(|c| &c.documentation))
            .param("repos", col(|c| &c.repository))
            .param("downloads", crates.iter().map(|c| c.downloads).collect::<Vec<_>>())
            .param("trustpub", crates.iter().map(|c| c.trustpub_only).collect::<Vec<_>>())
            .param("defaults", col(|c| &c.default_version))
            .param(
                "num_versions",
                crates.iter().map(|c| c.num_versions).collect::<Vec<_>>(),
            )
            .param("uo_ids", owner_col(crates, false, |o| i64::from(o.0)))
            .param("uo_since", owner_col(crates, false, |o| o.1.clone()))
            .param("uo_by", owner_col(crates, false, |o| o.2.clone()))
            .param("to_ids", owner_col(crates, true, |o| i64::from(o.0)))
            .param("to_since", owner_col(crates, true, |o| o.1.clone()))
            .param("to_by", owner_col(crates, true, |o| o.2.clone()))
            .param(
                "pub_ids",
                crates
                    .iter()
                    .map(|c| c.publishers.iter().map(|p| i64::from(p.0)).collect())
                    .collect::<Vec<Vec<i64>>>(),
            )
            .param(
                "pub_first",
                crates
                    .iter()
                    .map(|c| c.publishers.iter().map(|p| p.1.clone()).collect())
                    .collect::<Vec<Vec<String>>>(),
            )
            .param(
                "pub_last",
                crates
                    .iter()
                    .map(|c| c.publishers.iter().map(|p| p.2.clone()).collect())
                    .collect::<Vec<Vec<String>>>(),
            )
            .param(
                "pub_counts",
                crates
                    .iter()
                    .map(|c| c.publishers.iter().map(|p| p.3).collect())
                    .collect::<Vec<Vec<i64>>>(),
            )
            .param(
                "categories",
                crates.iter().map(|c| c.categories.clone()).collect::<Vec<_>>(),
            )
            .param(
                "keywords",
                crates.iter().map(|c| c.keywords.clone()).collect::<Vec<_>>(),
            ),
        )
        .await
    }

    /// # Errors
    /// On a database error.
    pub async fn set_registry_versions(
        &self,
        rows: &[RegistryVersion],
        marker: &str,
    ) -> Result<(), Error> {
        if rows.is_empty() {
            return Ok(());
        }
        let rec = |r: &RegistryVersion| r.record.clone().unwrap_or_default();
        self.write(
            query(
                "UNWIND range(0, size($names) - 1) AS i
                 MATCH (v:Version { name: $names[i], version: $versions[i] })
                 SET v.meta_registry = $marker,
                     v.registry_missing = CASE WHEN $found[i] THEN null ELSE true END,
                     v.published_at = CASE WHEN $at[i] = '' THEN null ELSE datetime($at[i]) END,
                     v.yanked = CASE WHEN $found[i] THEN $yanked[i] ELSE null END,
                     v.license = nullIf($licenses[i], ''),
                     v.crate_size = CASE WHEN $sizes[i] < 0 THEN null ELSE $sizes[i] END,
                     v.downloads = CASE WHEN $found[i] THEN $downloads[i] ELSE null END,
                     v.edition = nullIf($editions[i], ''),
                     v.rust_version = nullIf($rust_versions[i], ''),
                     v.has_lib = CASE $has_lib[i] WHEN 1 THEN true WHEN 0 THEN false ELSE null END,
                     v.bin_names = CASE WHEN size($bins[i]) = 0 THEN null ELSE $bins[i] END
                 WITH v, i
                 CALL { WITH v, i
                     MATCH (v)<-[r:PUBLISHED]-(u:User) WHERE u.id <> $publishers[i] DELETE r }
                 CALL { WITH v, i
                     WITH v, i WHERE $publishers[i] >= 0 AND $at[i] <> ''
                     MATCH (u:User { id: $publishers[i] })
                     MERGE (u)-[p:PUBLISHED]->(v)
                     SET p.at = datetime($at[i]) }",
            )
            .param("marker", marker)
            .param(
                "names",
                rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            )
            .param(
                "versions",
                rows.iter().map(|r| r.version.as_str()).collect::<Vec<_>>(),
            )
            .param(
                "found",
                rows.iter().map(|r| r.record.is_some()).collect::<Vec<_>>(),
            )
            .param(
                "at",
                rows.iter().map(|r| rec(r).created_at).collect::<Vec<_>>(),
            )
            .param(
                "yanked",
                rows.iter().map(|r| rec(r).yanked).collect::<Vec<_>>(),
            )
            .param(
                "licenses",
                rows.iter().map(|r| rec(r).license).collect::<Vec<_>>(),
            )
            .param(
                "sizes",
                rows.iter()
                    .map(|r| rec(r).crate_size.unwrap_or(-1))
                    .collect::<Vec<_>>(),
            )
            .param(
                "downloads",
                rows.iter().map(|r| rec(r).downloads).collect::<Vec<_>>(),
            )
            .param(
                "editions",
                rows.iter().map(|r| rec(r).edition).collect::<Vec<_>>(),
            )
            .param(
                "rust_versions",
                rows.iter().map(|r| rec(r).rust_version).collect::<Vec<_>>(),
            )
            .param(
                "has_lib",
                rows.iter()
                    .map(|r| rec(r).has_lib.map_or(-1_i64, i64::from))
                    .collect::<Vec<_>>(),
            )
            .param(
                "bins",
                rows.iter().map(|r| rec(r).bin_names).collect::<Vec<_>>(),
            )
            .param(
                "publishers",
                rows.iter()
                    .map(|r| rec(r).published_by.map_or(-1, i64::from))
                    .collect::<Vec<_>>(),
            ),
        )
        .await
    }
}

fn owner_col<T>(
    crates: &[RegistryCrate],
    teams: bool,
    f: impl Fn(&(u32, String, String)) -> T,
) -> Vec<Vec<T>> {
    crates
        .iter()
        .map(|c| {
            let owners = if teams {
                &c.team_owners
            } else {
                &c.user_owners
            };
            owners.iter().map(&f).collect()
        })
        .collect()
}

pub const REGISTRY_SCHEMA_CYPHER: [&str; 10] = [
    "CREATE CONSTRAINT const_user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE",
    "CREATE CONSTRAINT const_team_id IF NOT EXISTS FOR (t:Team) REQUIRE t.id IS UNIQUE",
    "CREATE CONSTRAINT const_category_slug IF NOT EXISTS FOR (c:Category) REQUIRE c.slug IS UNIQUE",
    "CREATE CONSTRAINT const_keyword_name IF NOT EXISTS FOR (k:Keyword) REQUIRE k.name IS UNIQUE",
    "CREATE INDEX idx_user_login IF NOT EXISTS FOR (u:User) ON (u.login)",
    "CREATE INDEX idx_published_at IF NOT EXISTS FOR ()-[p:PUBLISHED]-() ON (p.at)",
    "CREATE INDEX idx_owns_since IF NOT EXISTS FOR ()-[o:OWNS]-() ON (o.since)",
    "CREATE INDEX idx_version_published_at IF NOT EXISTS FOR (v:Version) ON (v.published_at)",
    "CREATE INDEX idx_crate_created_at IF NOT EXISTS FOR (c:Crate) ON (c.created_at)",
    "CREATE INDEX idx_crate_downloads IF NOT EXISTS FOR (c:Crate) ON (c.downloads)",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_semver_accepts_strict_and_lenient_versions() {
        let v = parse_semver("1.2.3").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (1, 2, 3));
        let v = parse_semver("1.2").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (1, 2, 0));
        let v = parse_semver("1.0.0-alpha.1+build.5").unwrap();
        assert_eq!(v.pre.as_str(), "alpha.1");
        assert_eq!(v.build.as_str(), "build.5");
    }

    #[test]
    fn parse_semver_falls_back_to_digit_stripping() {
        // The index contains strings like this.
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
        // The shift is clamped so a huge attempt count cannot overflow.
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
