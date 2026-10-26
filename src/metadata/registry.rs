//! Reads an extracted crates.io database dump: the index has no users or owners. Marker
//! `meta_registry` is `registry-<rev>@<dump timestamp>`, so a newer dump makes every version stale.
//! Trusted-publishing (and pre-2019-02-22) uploads have no `published_by`: no user `PUBLISHED`.
use crate::db::{
    Db, MetaState, RegistryCategory, RegistryCrate, RegistryTeam, RegistryUser, RegistryVersion,
};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Bump to recompute the job everywhere.
pub const REVISION: &str = "registry-1";

const VERSION_BATCH: usize = 1_000;
/// Each crate rewrites its owner/publisher/category/keyword edges, hence the smaller batch.
const CRATE_BATCH: usize = 250;
const NODE_BATCH: usize = 5_000;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("crates.io dump: {0}")]
    Io(#[from] std::io::Error),
    #[error("crates.io dump: {path}: {source}")]
    Csv { path: PathBuf, source: csv::Error },
    #[error("crates.io dump: no metadata.json under {0} (pass the extracted dump directory)")]
    NotADump(PathBuf),
    #[error("crates.io dump: bad metadata.json: {0}")]
    Metadata(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VersionRecord {
    pub created_at: String,
    pub published_by: Option<u32>,
    pub yanked: bool,
    pub license: String,
    pub crate_size: Option<i64>,
    pub downloads: i64,
    pub edition: String,
    pub rust_version: String,
    pub has_lib: Option<bool>,
    pub bin_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    pub team: bool,
    pub id: u32,
    pub since: String,
    pub added_by: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct CrateRecord {
    pub id: u32,
    pub created_at: String,
    pub updated_at: String,
    pub description: String,
    pub homepage: String,
    pub documentation: String,
    pub repository: String,
    pub downloads: i64,
    pub trustpub_only: bool,
    pub default_version: Option<String>,
    pub num_versions: i64,
    pub owners: Vec<Owner>,
    pub categories: Vec<String>,
    pub keywords: Vec<String>,
    pub versions: HashMap<String, VersionRecord>,
}

#[derive(Debug, Default)]
pub struct Dump {
    pub timestamp: String,
    pub crates: HashMap<String, CrateRecord>,
    pub users: HashMap<u32, RegistryUser>,
    pub teams: HashMap<u32, RegistryTeam>,
    pub categories: HashMap<u32, RegistryCategory>,
}

#[must_use]
pub fn marker(dump_timestamp: &str) -> String {
    format!("{REVISION}@{dump_timestamp}")
}

/// Empty if unparsable.
#[must_use]
pub fn pg_timestamp(s: &str) -> String {
    chrono::DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f%#z").map_or_else(
        |_| String::new(),
        |t| {
            t.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
        },
    )
}

#[must_use]
pub fn pg_array(s: &str) -> Vec<String> {
    let Some(inner) = s.strip_prefix('{').and_then(|s| s.strip_suffix('}')) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut cur = String::new();
    let (mut quoted, mut escaped, mut any) = (false, false, false);
    for ch in inner.chars() {
        if escaped {
            cur.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            quoted = !quoted;
            any = true;
        } else if ch == ',' && !quoted {
            out.push(std::mem::take(&mut cur));
            any = false;
        } else {
            cur.push(ch);
            any = true;
        }
    }
    if any || !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn pg_bool(s: &str) -> bool {
    s == "t"
}

/// The tarball unpacks into a dated directory, so `dir` may be its parent.
///
/// # Errors
/// [`Error::NotADump`] if neither holds `metadata.json`.
pub fn resolve_dir(dir: &Path) -> Result<PathBuf, Error> {
    if dir.join("metadata.json").is_file() {
        return Ok(dir.to_path_buf());
    }
    let mut subdirs: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.join("metadata.json").is_file())
        .collect();
    subdirs.sort();
    subdirs
        .pop()
        .ok_or_else(|| Error::NotADump(dir.to_path_buf()))
}

fn read_csv<T: for<'de> Deserialize<'de>>(
    dir: &Path,
    file: &str,
    mut each: impl FnMut(T),
) -> Result<(), Error> {
    let path = dir.join("data").join(file);
    let csv_err = |source| Error::Csv {
        path: path.clone(),
        source,
    };
    let mut reader = csv::Reader::from_path(&path).map_err(csv_err)?;
    for row in reader.deserialize() {
        each(row.map_err(csv_err)?);
    }
    Ok(())
}

#[derive(Deserialize)]
struct CrateRow {
    id: u32,
    name: String,
    created_at: String,
    updated_at: String,
    description: String,
    homepage: String,
    documentation: String,
    repository: String,
    #[serde(default)]
    trustpub_only: String,
}

#[derive(Deserialize)]
struct VersionRow {
    id: u32,
    crate_id: u32,
    num: String,
    created_at: String,
    published_by: Option<u32>,
    yanked: String,
    license: String,
    crate_size: Option<i64>,
    downloads: i64,
    #[serde(default)]
    edition: String,
    #[serde(default)]
    rust_version: String,
    #[serde(default)]
    has_lib: String,
    #[serde(default)]
    bin_names: String,
}

#[derive(Deserialize)]
struct UserRow {
    id: u32,
    gh_id: Option<i64>,
    name: String,
    username: String,
    created_at: String,
}

#[derive(Deserialize)]
struct TeamRow {
    id: u32,
    login: String,
    name: String,
    avatar: String,
}

#[derive(Deserialize)]
struct OwnerRow {
    crate_id: u32,
    created_at: String,
    created_by: Option<u32>,
    owner_id: u32,
    owner_kind: u8,
}

#[derive(Deserialize)]
struct CategoryRow {
    id: u32,
    category: String,
    slug: String,
    description: String,
    path: String,
    crates_cnt: i64,
}

#[derive(Deserialize)]
struct KeywordRow {
    id: u32,
    keyword: String,
}

#[derive(Deserialize)]
struct CrateLinkRow {
    crate_id: u32,
    #[serde(alias = "category_id")]
    keyword_id: u32,
}

#[derive(Deserialize)]
struct DownloadsRow {
    crate_id: u32,
    downloads: i64,
}

#[derive(Deserialize)]
struct DefaultVersionRow {
    crate_id: u32,
    num_versions: Option<i64>,
    version_id: u32,
}

#[derive(Deserialize)]
struct DumpMeta {
    timestamp: String,
}

fn crate_mut<'a>(
    names: &HashMap<u32, String>,
    crates: &'a mut HashMap<String, CrateRecord>,
    crate_id: u32,
) -> Option<&'a mut CrateRecord> {
    crates.get_mut(names.get(&crate_id)?)
}

/// Skips `crates.csv` READMEs and `versions.csv` features: ~3-4 GB RSS for the full dump.
///
/// # Errors
/// Unreadable or malformed files.
#[allow(clippy::too_many_lines)] // one block per table
pub fn load(dir: &Path) -> Result<Dump, Error> {
    let dir = resolve_dir(dir)?;
    let meta: DumpMeta = serde_json::from_slice(&std::fs::read(dir.join("metadata.json"))?)?;
    let mut dump = Dump {
        timestamp: meta.timestamp,
        ..Dump::default()
    };

    let mut names: HashMap<u32, String> = HashMap::new();
    read_csv(&dir, "crates.csv", |r: CrateRow| {
        names.insert(r.id, r.name.clone());
        dump.crates.insert(
            r.name,
            CrateRecord {
                id: r.id,
                created_at: pg_timestamp(&r.created_at),
                updated_at: pg_timestamp(&r.updated_at),
                description: r.description,
                homepage: r.homepage,
                documentation: r.documentation,
                repository: r.repository,
                trustpub_only: pg_bool(&r.trustpub_only),
                ..CrateRecord::default()
            },
        );
    })?;

    let mut version_nums: HashMap<u32, String> = HashMap::new();
    read_csv(&dir, "versions.csv", |r: VersionRow| {
        let Some(c) = crate_mut(&names, &mut dump.crates, r.crate_id) else {
            return;
        };
        version_nums.insert(r.id, r.num.clone());
        c.versions.insert(
            r.num,
            VersionRecord {
                created_at: pg_timestamp(&r.created_at),
                published_by: r.published_by,
                yanked: pg_bool(&r.yanked),
                license: r.license,
                crate_size: r.crate_size,
                downloads: r.downloads,
                edition: r.edition,
                rust_version: r.rust_version,
                has_lib: (!r.has_lib.is_empty()).then(|| pg_bool(&r.has_lib)),
                bin_names: pg_array(&r.bin_names),
            },
        );
    })?;
    read_csv(&dir, "crate_downloads.csv", |r: DownloadsRow| {
        if let Some(c) = crate_mut(&names, &mut dump.crates, r.crate_id) {
            c.downloads = r.downloads;
        }
    })?;
    read_csv(&dir, "default_versions.csv", |r: DefaultVersionRow| {
        if let Some(c) = crate_mut(&names, &mut dump.crates, r.crate_id) {
            c.default_version = version_nums.get(&r.version_id).cloned();
            c.num_versions = r.num_versions.unwrap_or_default();
        }
    })?;
    drop(version_nums);
    read_csv(&dir, "crate_owners.csv", |r: OwnerRow| {
        if let Some(c) = crate_mut(&names, &mut dump.crates, r.crate_id) {
            c.owners.push(Owner {
                team: r.owner_kind == 1,
                id: r.owner_id,
                since: pg_timestamp(&r.created_at),
                added_by: r.created_by,
            });
        }
    })?;

    let mut category_slugs: HashMap<u32, String> = HashMap::new();
    read_csv(&dir, "categories.csv", |r: CategoryRow| {
        category_slugs.insert(r.id, r.slug.clone());
        dump.categories.insert(
            r.id,
            RegistryCategory {
                slug: r.slug,
                name: r.category,
                description: r.description,
                path: r.path,
                crates: r.crates_cnt,
            },
        );
    })?;
    read_csv(&dir, "crates_categories.csv", |r: CrateLinkRow| {
        if let (Some(slug), Some(c)) = (
            category_slugs.get(&r.keyword_id),
            crate_mut(&names, &mut dump.crates, r.crate_id),
        ) {
            c.categories.push(slug.clone());
        }
    })?;
    let mut keywords: HashMap<u32, String> = HashMap::new();
    read_csv(&dir, "keywords.csv", |r: KeywordRow| {
        keywords.insert(r.id, r.keyword);
    })?;
    read_csv(&dir, "crates_keywords.csv", |r: CrateLinkRow| {
        if let (Some(kw), Some(c)) = (
            keywords.get(&r.keyword_id),
            crate_mut(&names, &mut dump.crates, r.crate_id),
        ) {
            c.keywords.push(kw.clone());
        }
    })?;

    read_csv(&dir, "users.csv", |r: UserRow| {
        dump.users.insert(
            r.id,
            RegistryUser {
                id: r.id,
                login: r.username,
                name: r.name,
                gh_id: r.gh_id.unwrap_or(-1),
                created_at: pg_timestamp(&r.created_at),
            },
        );
    })?;
    read_csv(&dir, "teams.csv", |r: TeamRow| {
        dump.teams.insert(
            r.id,
            RegistryTeam {
                id: r.id,
                login: r.login,
                name: r.name,
                avatar: r.avatar,
            },
        );
    })?;
    Ok(dump)
}

#[must_use]
pub fn publishers(c: &CrateRecord) -> Vec<(u32, String, String, i64)> {
    let mut by_user: BTreeMap<u32, (String, String, i64)> = BTreeMap::new();
    for v in c.versions.values() {
        let (Some(user), false) = (v.published_by, v.created_at.is_empty()) else {
            continue;
        };
        let e = by_user
            .entry(user)
            .or_insert_with(|| (v.created_at.clone(), v.created_at.clone(), 0));
        // RFC 3339 UTC strings of one format order chronologically.
        if v.created_at < e.0 {
            e.0.clone_from(&v.created_at);
        }
        if v.created_at > e.1 {
            e.1.clone_from(&v.created_at);
        }
        e.2 += 1;
    }
    by_user
        .into_iter()
        .map(|(u, (first, last, n))| (u, first, last, n))
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    pub versions: u64,
    pub missing: u64,
    pub published: u64,
    pub crates: u64,
    pub users: u64,
    pub teams: u64,
}

/// # Errors
/// Database errors; everything written before stays.
#[allow(clippy::too_many_lines)]
pub async fn run(
    db: &Db,
    dump: &Dump,
    states: &[MetaState],
    rescan: bool,
) -> Result<Summary, crate::db::Error> {
    let marker = marker(&dump.timestamp);
    let pending: Vec<&MetaState> = states
        .iter()
        .filter(|s| rescan || s.meta_registry.as_deref() != Some(marker.as_str()))
        .collect();
    let crate_names: Vec<&str> = {
        let mut seen = HashSet::new();
        let mut v: Vec<&str> = pending
            .iter()
            .map(|s| s.name.as_str())
            .filter(|n| seen.insert(*n))
            .collect();
        v.sort_unstable();
        v
    };
    log::info!(
        "registry: {} of {} versions in {} crates pending (dump {})",
        pending.len(),
        states.len(),
        crate_names.len(),
        dump.timestamp
    );
    let mut summary = Summary::default();
    if pending.is_empty() {
        return Ok(summary);
    }
    db.ensure_registry_schema().await?;

    let mut users: HashSet<u32> = HashSet::new();
    let mut teams: HashSet<u32> = HashSet::new();
    for c in crate_names.iter().filter_map(|n| dump.crates.get(*n)) {
        users.extend(c.versions.values().filter_map(|v| v.published_by));
        for o in &c.owners {
            if o.team {
                teams.insert(o.id);
            } else {
                users.insert(o.id);
            }
            users.extend(o.added_by);
        }
    }
    let users: Vec<&RegistryUser> = users.iter().filter_map(|u| dump.users.get(u)).collect();
    for chunk in users.chunks(NODE_BATCH) {
        db.upsert_registry_users(chunk).await?;
    }
    summary.users = users.len() as u64;
    let teams: Vec<&RegistryTeam> = teams.iter().filter_map(|t| dump.teams.get(t)).collect();
    for chunk in teams.chunks(NODE_BATCH) {
        db.upsert_registry_teams(chunk).await?;
    }
    summary.teams = teams.len() as u64;
    let categories: Vec<&RegistryCategory> = dump.categories.values().collect();
    for chunk in categories.chunks(NODE_BATCH) {
        db.upsert_registry_categories(chunk).await?;
    }
    log::info!(
        "registry: {} users, {} teams, {} categories upserted",
        summary.users,
        summary.teams,
        categories.len()
    );

    let login = |id: Option<u32>| {
        id.and_then(|u| dump.users.get(&u))
            .map(|u| u.login.clone())
            .unwrap_or_default()
    };
    let crates: Vec<RegistryCrate> = crate_names
        .iter()
        .filter_map(|n| Some((*n, dump.crates.get(*n)?)))
        .map(|(name, c)| RegistryCrate {
            name: name.to_string(),
            id: c.id,
            created_at: c.created_at.clone(),
            updated_at: c.updated_at.clone(),
            description: c.description.clone(),
            homepage: c.homepage.clone(),
            documentation: c.documentation.clone(),
            repository: c.repository.clone(),
            downloads: c.downloads,
            trustpub_only: c.trustpub_only,
            default_version: c.default_version.clone().unwrap_or_default(),
            num_versions: c.num_versions,
            user_owners: c
                .owners
                .iter()
                .filter(|o| !o.team && dump.users.contains_key(&o.id))
                .map(|o| (o.id, o.since.clone(), login(o.added_by)))
                .collect(),
            team_owners: c
                .owners
                .iter()
                .filter(|o| o.team && dump.teams.contains_key(&o.id))
                .map(|o| (o.id, o.since.clone(), login(o.added_by)))
                .collect(),
            publishers: publishers(c)
                .into_iter()
                .filter(|p| dump.users.contains_key(&p.0))
                .collect(),
            categories: c.categories.clone(),
            keywords: c.keywords.clone(),
        })
        .collect();
    let started = std::time::Instant::now();
    for (i, chunk) in crates.chunks(CRATE_BATCH).enumerate() {
        db.set_registry_crates(chunk).await?;
        summary.crates += chunk.len() as u64;
        if (i + 1) % 40 == 0 {
            log::info!(
                "registry: {} of {} crates stored ({:.0}s)",
                summary.crates,
                crates.len(),
                started.elapsed().as_secs_f64()
            );
        }
    }
    log::info!("registry: {} crates stored", summary.crates);

    let started = std::time::Instant::now();
    let mut next_log = 50_000;
    for chunk in pending.chunks(VERSION_BATCH) {
        let rows: Vec<RegistryVersion> = chunk
            .iter()
            .map(|s| {
                let rec = dump
                    .crates
                    .get(&s.name)
                    .and_then(|c| c.versions.get(&s.version));
                summary.missing += u64::from(rec.is_none());
                RegistryVersion {
                    name: s.name.clone(),
                    version: s.version.clone(),
                    record: rec.map(|r| VersionRecord {
                        published_by: r.published_by.filter(|u| dump.users.contains_key(u)),
                        ..r.clone()
                    }),
                }
            })
            .collect();
        summary.published += rows
            .iter()
            .filter(|r| r.record.as_ref().is_some_and(|r| r.published_by.is_some()))
            .count() as u64;
        db.set_registry_versions(&rows, &marker).await?;
        summary.versions += rows.len() as u64;
        if summary.versions >= next_log {
            next_log += 50_000;
            log::info!(
                "registry: {} of {} versions stored ({:.0}/min), {} not in the dump",
                summary.versions,
                pending.len(),
                f64::from(u32::try_from(summary.versions).unwrap_or(u32::MAX))
                    / started.elapsed().as_secs_f64().max(1.0)
                    * 60.0,
                summary.missing
            );
        }
    }
    log::info!("registry: {summary:?}");
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_timestamps_become_rfc3339_utc() {
        assert_eq!(
            pg_timestamp("2026-08-20 06:59:27.454905+00"),
            "2026-08-20T06:59:27.454905Z"
        );
        assert_eq!(
            pg_timestamp("2019-03-11 21:46:06+00"),
            "2019-03-11T21:46:06.000000Z"
        );
        assert_eq!(
            pg_timestamp("2019-03-11 23:46:06+02"),
            "2019-03-11T21:46:06.000000Z"
        );
        assert_eq!(pg_timestamp(""), "");
    }

    #[test]
    fn pg_arrays_split_and_unquote() {
        assert_eq!(pg_array("{}"), Vec::<String>::new());
        assert_eq!(pg_array("{a,b}"), ["a", "b"]);
        assert_eq!(pg_array(r#"{"a,b",c,"d \"e\""}"#), ["a,b", "c", "d \"e\""]);
        assert_eq!(pg_array(r#"{""}"#), [""]);
        assert_eq!(pg_array(""), Vec::<String>::new());
    }

    fn write(dir: &Path, file: &str, body: &str) {
        std::fs::write(dir.join("data").join(file), body).unwrap();
    }

    fn fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("2026-10-26-020019");
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            r#"{"timestamp": "2026-10-26T02:00:19Z", "crates_io_commit": "x"}"#,
        )
        .unwrap();
        write(
            &dir,
            "crates.csv",
            "created_at,description,documentation,homepage,id,max_features,max_upload_size,name,readme,repository,trustpub_only,updated_at\n\
            2014-12-05 20:20:39+00,A demo,,,1,,,demo,\"# big\nreadme\",https://g/demo,f,2026-01-01 00:00:00+00\n\
            2020-01-01 00:00:00+00,,,,2,,,other,,,t,2020-01-01 00:00:00+00\n",
        );
        write(
            &dir,
            "versions.csv",
            "bin_names,categories,crate_id,crate_size,created_at,description,documentation,downloads,edition,features,has_lib,homepage,id,keywords,license,links,num,num_no_build,published_by,repository,rust_version,tar_sha256,updated_at,yanked,zip_json_sha256,zip_sha256\n\
            {},{},1,100,2014-12-05 20:20:39+00,,,5,,{},,,10,{},MIT,,0.1.0,0.1.0,,,,x,2014-12-05 20:20:39+00,f,,\n\
            {demo-cli},{},1,200,2020-02-02 00:00:00+00,,,7,2021,{},t,,11,{},MIT OR Apache-2.0,,1.0.0,1.0.0,7,,1.60,x,2020-02-02 00:00:00+00,t,,\n\
            {},{},1,300,2021-03-03 00:00:00+00,,,9,2021,{},t,,12,{},MIT,,1.1.0,1.1.0,7,,,x,2021-03-03 00:00:00+00,f,,\n",
        );
        write(&dir, "crate_downloads.csv", "crate_id,downloads\n1,21\n");
        write(
            &dir,
            "default_versions.csv",
            "crate_id,num_versions,version_id\n1,3,12\n",
        );
        write(
            &dir,
            "crate_owners.csv",
            "crate_id,created_at,created_by,owner_id,owner_kind\n1,2014-12-05 20:20:39+00,,7,0\n1,2022-01-01 00:00:00+00,7,3,1\n",
        );
        write(
            &dir,
            "categories.csv",
            "category,crates_cnt,created_at,description,id,path,slug\nParsing,1,2017-01-01 00:00:00+00,Parsers,5,root.parsing,parsing\n",
        );
        write(&dir, "crates_categories.csv", "category_id,crate_id\n5,1\n");
        write(
            &dir,
            "keywords.csv",
            "crates_cnt,created_at,id,keyword\n1,2017-01-01 00:00:00+00,9,demo\n",
        );
        write(&dir, "crates_keywords.csv", "crate_id,keyword_id\n1,9\n");
        write(
            &dir,
            "users.csv",
            "created_at,gh_id,id,name,username\n2014-01-01 00:00:00+00,77,7,Ann,ann\n",
        );
        write(
            &dir,
            "teams.csv",
            "avatar,github_id,id,login,name,org_id\nhttps://a,1,3,github:org:team,Team,2\n",
        );
        tmp
    }

    #[test]
    fn load_reads_the_dump_layout() {
        let tmp = fixture();
        let dump = load(tmp.path()).unwrap();
        assert_eq!(dump.timestamp, "2026-10-26T02:00:19Z");
        assert_eq!(marker(&dump.timestamp), "registry-1@2026-10-26T02:00:19Z");
        let demo = &dump.crates["demo"];
        assert_eq!(demo.downloads, 21);
        assert_eq!(demo.default_version.as_deref(), Some("1.1.0"));
        assert_eq!(demo.num_versions, 3);
        assert_eq!(demo.categories, ["parsing"]);
        assert_eq!(demo.keywords, ["demo"]);
        assert_eq!(demo.owners.len(), 2);
        assert!(demo.owners[1].team && demo.owners[1].added_by == Some(7));
        let v = &demo.versions["1.0.0"];
        assert_eq!(v.published_by, Some(7));
        assert!(v.yanked);
        assert_eq!(v.bin_names, ["demo-cli"]);
        assert_eq!(v.has_lib, Some(true));
        assert_eq!(v.rust_version, "1.60");
        assert_eq!(demo.versions["0.1.0"].published_by, None);
        assert_eq!(demo.versions["0.1.0"].has_lib, None);
        assert!(dump.crates["other"].trustpub_only);
        assert_eq!(dump.users[&7].login, "ann");
        assert_eq!(dump.teams[&3].login, "github:org:team");

        assert_eq!(
            publishers(demo),
            [(
                7,
                "2020-02-02T00:00:00.000000Z".to_string(),
                "2021-03-03T00:00:00.000000Z".to_string(),
                2
            )],
            "0.1.0 predates published_by"
        );
    }

    #[test]
    fn resolve_dir_rejects_non_dumps() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(matches!(resolve_dir(tmp.path()), Err(Error::NotADump(_))));
    }
}
