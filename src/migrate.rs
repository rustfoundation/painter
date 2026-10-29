//! One-off rebuild from the `INVOKES` call schema to `HAS_FN`/`CALLS`/`Symbol`.
//!
//! Deleting old edges in place would not shrink Neo4j's store files and Community has no
//! compaction, so this streams the database out as `neo4j-admin database import` CSVs instead.

use crate::db::{CallRow, collapse_calls, symbol_key};
use futures::StreamExt;
use neo4rs::{Graph, query};
use std::collections::HashSet;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Database Error: {0}")]
    Neo4j(#[from] neo4rs::Error),
    #[error("IO Error: {0}")]
    Io(#[from] std::io::Error),
    #[error("refusing to export: the database has {0}, which the export does not copy")]
    UnknownSchema(String),
    #[error("row without column `{0}`")]
    MissingColumn(&'static str),
}

/// Derived nodes the rebuild drops on purpose: the render jobs service recomputes them on its timer.
const DROPPED_LABELS: &[&str] = &["Stats"];

const NODE_PROPERTIES: &[(&str, &[&str])] = &[
    (
        "Crate",
        &["name", "lod_x", "lod_y", "lod_community", "lod_degree"],
    ),
    (
        "Version",
        &[
            "name",
            "version",
            "latest",
            "semver_major",
            "semver_minor",
            "semver_patch",
            "semver_build",
            "semver_pre",
        ],
    ),
    (
        "LodMeta",
        &[
            "id",
            "built_at",
            "build_ms",
            "crates",
            "edges",
            "isolated",
            "communities",
            "iterations",
            "updated_crates",
            "reused_edges",
            "min_x",
            "max_x",
            "min_y",
            "max_y",
        ],
    ),
];

const REL_PROPERTIES: &[(&str, &[&str])] = &[
    ("INVOKES", &["callsite", "target"]),
    ("VERSION_OF", &[]),
    (
        "DEPENDS_ON",
        &["requirement", "features", "kind", "optional"],
    ),
    ("LOD_DEP", &["versions"]),
];

const VERSION_CONCURRENCY: usize = 16;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ExportSummary {
    pub crates: u64,
    pub versions: u64,
    pub lod_meta: u64,
    pub version_of: u64,
    pub depends_on: u64,
    pub lod_dep: u64,
    pub invokes: u64,
    pub versions_with_calls: u64,
    pub fns: u64,
    pub calls: u64,
    pub symbols: u64,
    pub symbol_crates: u64,
}

/// Strings are always quoted so `""` stays an empty string; an empty field is no property.
struct Csv {
    out: BufWriter<std::fs::File>,
    rows: u64,
}

enum Field<'a> {
    Str(Option<&'a str>),
    Int(Option<i64>),
    Float(Option<f64>),
    Bool(Option<bool>),
}

impl Csv {
    fn create(dir: &Path, file: &str, header: &[&str]) -> Result<Self, Error> {
        let mut out = BufWriter::with_capacity(1 << 20, std::fs::File::create(dir.join(file))?);
        writeln!(out, "{}", header.join(","))?;
        Ok(Self { out, rows: 0 })
    }

    fn row(&mut self, fields: &[Field<'_>]) -> Result<(), Error> {
        for (i, field) in fields.iter().enumerate() {
            if i > 0 {
                self.out.write_all(b",")?;
            }
            match field {
                Field::Str(Some(s)) => write_quoted(&mut self.out, s)?,
                Field::Int(Some(n)) => write!(self.out, "{n}")?,
                Field::Float(Some(x)) => write!(self.out, "{x:?}")?,
                Field::Bool(Some(b)) => write!(self.out, "{b}")?,
                Field::Str(None) | Field::Int(None) | Field::Float(None) | Field::Bool(None) => {}
            }
        }
        self.out.write_all(b"\n")?;
        self.rows += 1;
        Ok(())
    }

    fn finish(mut self) -> Result<u64, Error> {
        self.out.flush()?;
        Ok(self.rows)
    }
}

fn write_quoted<W: Write>(out: &mut W, s: &str) -> std::io::Result<()> {
    out.write_all(b"\"")?;
    let mut rest = s;
    while let Some(at) = rest.find('"') {
        out.write_all(&rest.as_bytes()[..=at])?;
        out.write_all(b"\"")?;
        rest = &rest[at + 1..];
    }
    out.write_all(rest.as_bytes())?;
    out.write_all(b"\"")
}

/// Neither name nor version can contain `@`.
fn version_id(name: &str, version: &str) -> String {
    format!("{name}@{version}")
}

fn need_str(row: &neo4rs::Row, col: &'static str) -> Result<String, Error> {
    row.get::<String>(col).ok_or(Error::MissingColumn(col))
}

fn need_strs(row: &neo4rs::Row, col: &'static str) -> Result<Vec<String>, Error> {
    row.get::<Vec<String>>(col).ok_or(Error::MissingColumn(col))
}

async fn check_schema(graph: &Graph) -> Result<(), Error> {
    let mut unknown = Vec::new();

    let mut rows = graph
        .execute(query(
            "CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName
             RETURN nodeLabels, propertyName",
        ))
        .await?;
    while let Some(row) = rows.next().await? {
        let labels = need_strs(&row, "nodeLabels")?;
        let prop = row.get::<String>("propertyName");
        if let [label] = labels.as_slice()
            && DROPPED_LABELS.contains(&label.as_str())
        {
            continue;
        }
        let known = match labels.as_slice() {
            [label] => NODE_PROPERTIES
                .iter()
                .find(|(l, _)| l == label)
                .map(|(_, p)| *p),
            _ => None,
        };
        match (known, prop) {
            (None, _) => unknown.push(format!("nodes labelled {labels:?}")),
            (Some(props), Some(p)) if !props.contains(&p.as_str()) => {
                unknown.push(format!("property {labels:?}.{p}"));
            }
            _ => {}
        }
    }

    let mut rows = graph
        .execute(query(
            "CALL db.schema.relTypeProperties() YIELD relType, propertyName
             RETURN relType, propertyName",
        ))
        .await?;
    while let Some(row) = rows.next().await? {
        let rel = need_str(&row, "relType")?;
        let rel = rel
            .trim_start_matches(":`")
            .trim_end_matches('`')
            .to_string();
        let prop = row.get::<String>("propertyName");
        let known = REL_PROPERTIES
            .iter()
            .find(|(r, _)| *r == rel)
            .map(|(_, p)| *p);
        match (known, prop) {
            (None, _) => unknown.push(format!("relationship type {rel}")),
            (Some(props), Some(p)) if !props.contains(&p.as_str()) => {
                unknown.push(format!("property {rel}.{p}"));
            }
            _ => {}
        }
    }

    unknown.sort();
    unknown.dedup();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(Error::UnknownSchema(unknown.join(", ")))
    }
}

async fn export_crates(graph: &Graph, dir: &Path) -> Result<u64, Error> {
    let mut csv = Csv::create(
        dir,
        "crates.csv",
        &[
            "name:ID(Crate)",
            "lod_x:double",
            "lod_y:double",
            "lod_community:long",
            "lod_degree:long",
        ],
    )?;
    let mut rows = graph
        .execute(query(
            "MATCH (c:Crate) RETURN c.name AS name, c.lod_x AS lod_x, c.lod_y AS lod_y,
                    c.lod_community AS lod_community, c.lod_degree AS lod_degree",
        ))
        .await?;
    while let Some(row) = rows.next().await? {
        let name = need_str(&row, "name")?;
        csv.row(&[
            Field::Str(Some(&name)),
            Field::Float(row.get::<f64>("lod_x")),
            Field::Float(row.get::<f64>("lod_y")),
            Field::Int(row.get::<i64>("lod_community")),
            Field::Int(row.get::<i64>("lod_degree")),
        ])?;
    }
    csv.finish()
}

async fn export_versions(graph: &Graph, dir: &Path) -> Result<(u64, u64), Error> {
    let mut nodes = Csv::create(
        dir,
        "versions.csv",
        &[
            ":ID(Version)",
            "name",
            "version",
            "latest:boolean",
            "semver_major:long",
            "semver_minor:long",
            "semver_patch:long",
            "semver_build",
            "semver_pre",
        ],
    )?;
    let mut edges = Csv::create(
        dir,
        "version_of.csv",
        &[":START_ID(Crate)", ":END_ID(Version)"],
    )?;
    let mut rows = graph
        .execute(query(
            "MATCH (v:Version)
             RETURN v.name AS name, v.version AS version, v.latest AS latest,
                    v.semver_major AS major, v.semver_minor AS minor, v.semver_patch AS patch,
                    v.semver_build AS build, v.semver_pre AS pre,
                    [(c:Crate)-[:VERSION_OF]->(v) | c.name] AS crates",
        ))
        .await?;
    while let Some(row) = rows.next().await? {
        let name = need_str(&row, "name")?;
        let version = need_str(&row, "version")?;
        let id = version_id(&name, &version);
        let build = row.get::<String>("build");
        let pre = row.get::<String>("pre");
        nodes.row(&[
            Field::Str(Some(&id)),
            Field::Str(Some(&name)),
            Field::Str(Some(&version)),
            Field::Bool(row.get::<bool>("latest")),
            Field::Int(row.get::<i64>("major")),
            Field::Int(row.get::<i64>("minor")),
            Field::Int(row.get::<i64>("patch")),
            Field::Str(build.as_deref()),
            Field::Str(pre.as_deref()),
        ])?;
        let crates = need_strs(&row, "crates")?;
        for c in &crates {
            edges.row(&[Field::Str(Some(c)), Field::Str(Some(&id))])?;
        }
    }
    Ok((nodes.finish()?, edges.finish()?))
}

async fn export_lod_meta(graph: &Graph, dir: &Path) -> Result<u64, Error> {
    let mut csv = Csv::create(
        dir,
        "lod_meta.csv",
        &[
            "id",
            "built_at:datetime",
            "build_ms:long",
            "crates:long",
            "edges:long",
            "isolated:long",
            "communities:long",
            "iterations:long",
            "updated_crates:long",
            "reused_edges:boolean",
            "min_x:double",
            "max_x:double",
            "min_y:double",
            "max_y:double",
        ],
    )?;
    let mut rows = graph
        .execute(query(
            "MATCH (m:LodMeta)
             RETURN m.id AS id, toString(m.built_at) AS built_at, m.build_ms AS build_ms,
                    m.crates AS crates, m.edges AS edges, m.isolated AS isolated,
                    m.communities AS communities, m.iterations AS iterations,
                    m.updated_crates AS updated_crates, m.reused_edges AS reused_edges,
                    m.min_x AS min_x, m.max_x AS max_x, m.min_y AS min_y, m.max_y AS max_y",
        ))
        .await?;
    while let Some(row) = rows.next().await? {
        let id = row.get::<String>("id");
        let built_at = row.get::<String>("built_at");
        csv.row(&[
            Field::Str(id.as_deref()),
            Field::Str(built_at.as_deref()),
            Field::Int(row.get::<i64>("build_ms")),
            Field::Int(row.get::<i64>("crates")),
            Field::Int(row.get::<i64>("edges")),
            Field::Int(row.get::<i64>("isolated")),
            Field::Int(row.get::<i64>("communities")),
            Field::Int(row.get::<i64>("iterations")),
            Field::Int(row.get::<i64>("updated_crates")),
            Field::Bool(row.get::<bool>("reused_edges")),
            Field::Float(row.get::<f64>("min_x")),
            Field::Float(row.get::<f64>("max_x")),
            Field::Float(row.get::<f64>("min_y")),
            Field::Float(row.get::<f64>("max_y")),
        ])?;
    }
    csv.finish()
}

async fn export_depends_on(graph: &Graph, dir: &Path) -> Result<u64, Error> {
    let mut csv = Csv::create(
        dir,
        "depends_on.csv",
        &[
            ":START_ID(Version)",
            ":END_ID(Crate)",
            "requirement",
            "features",
            "kind",
            "optional:boolean",
        ],
    )?;
    let mut rows = graph
        .execute(query(
            "MATCH (v:Version)-[d:DEPENDS_ON]->(c:Crate)
             RETURN v.name AS name, v.version AS version, c.name AS crate,
                    d.requirement AS requirement, d.features AS features, d.kind AS kind,
                    d.optional AS optional",
        ))
        .await?;
    while let Some(row) = rows.next().await? {
        let name = need_str(&row, "name")?;
        let version = need_str(&row, "version")?;
        let krate = need_str(&row, "crate")?;
        let requirement = row.get::<String>("requirement");
        let features = row.get::<String>("features");
        let kind = row.get::<String>("kind");
        csv.row(&[
            Field::Str(Some(&version_id(&name, &version))),
            Field::Str(Some(&krate)),
            Field::Str(requirement.as_deref()),
            Field::Str(features.as_deref()),
            Field::Str(kind.as_deref()),
            Field::Bool(row.get::<bool>("optional")),
        ])?;
    }
    csv.finish()
}

async fn export_lod_dep(graph: &Graph, dir: &Path) -> Result<u64, Error> {
    let mut csv = Csv::create(
        dir,
        "lod_dep.csv",
        &[":START_ID(Crate)", ":END_ID(Crate)", "versions:long"],
    )?;
    let mut rows = graph
        .execute(query(
            "MATCH (a:Crate)-[r:LOD_DEP]->(b:Crate) RETURN a.name AS a, b.name AS b, r.versions AS versions",
        ))
        .await?;
    while let Some(row) = rows.next().await? {
        let a = need_str(&row, "a")?;
        let b = need_str(&row, "b")?;
        csv.row(&[
            Field::Str(Some(&a)),
            Field::Str(Some(&b)),
            Field::Int(row.get::<i64>("versions")),
        ])?;
    }
    csv.finish()
}

async fn version_calls(
    graph: Arc<Graph>,
    name: String,
    version: String,
) -> Result<(String, String, u64, Vec<CallRow>), Error> {
    let mut rows = graph
        .execute(
            query(
                "MATCH (:Version { name: $name, version: $version })-[i:INVOKES]->(c:Crate)
                 RETURN i.callsite AS callsite, i.target AS target, c.name AS crate",
            )
            .param("name", name.as_str())
            .param("version", version.as_str()),
        )
        .await?;
    let mut raw = Vec::new();
    while let Some(row) = rows.next().await? {
        raw.push((
            need_str(&row, "callsite")?,
            need_str(&row, "target")?,
            need_str(&row, "crate")?,
        ));
    }
    let edges = raw.len() as u64;
    Ok((name, version, edges, collapse_calls(raw)))
}

struct CallFiles {
    symbols: Csv,
    fns: Csv,
    has_fn: Csv,
    is: Csv,
    calls: Csv,
    symbol_in: Csv,
    seen_symbols: HashSet<String>,
    seen_in: HashSet<String>,
    next_fn: u64,
}

impl CallFiles {
    fn create(dir: &Path) -> Result<Self, Error> {
        Ok(Self {
            symbols: Csv::create(dir, "symbols.csv", &["name:ID(Symbol)", "full_name"])?,
            fns: Csv::create(dir, "fns.csv", &[":ID(Fn)"])?,
            has_fn: Csv::create(dir, "has_fn.csv", &[":START_ID(Version)", ":END_ID(Fn)"])?,
            is: Csv::create(dir, "is.csv", &[":START_ID(Fn)", ":END_ID(Symbol)"])?,
            calls: Csv::create(
                dir,
                "calls.csv",
                &[":START_ID(Fn)", ":END_ID(Symbol)", "copies:long"],
            )?,
            symbol_in: Csv::create(dir, "in.csv", &[":START_ID(Symbol)", ":END_ID(Crate)"])?,
            seen_symbols: HashSet::new(),
            seen_in: HashSet::new(),
            next_fn: 0,
        })
    }

    fn symbol(&mut self, name: &str) -> Result<String, Error> {
        let (key, full) = symbol_key(name);
        if !self.seen_symbols.contains(key.as_ref()) {
            self.symbols
                .row(&[Field::Str(Some(&key)), Field::Str(full)])?;
            self.seen_symbols.insert(key.to_string());
        }
        Ok(key.into_owned())
    }

    fn version(&mut self, name: &str, version: &str, calls: &[CallRow]) -> Result<(), Error> {
        let vid = version_id(name, version);
        for group in calls.chunk_by(|a, b| a.caller == b.caller) {
            let fn_id = i64::try_from(self.next_fn).unwrap_or(i64::MAX);
            self.next_fn += 1;
            self.fns.row(&[Field::Int(Some(fn_id))])?;
            self.has_fn
                .row(&[Field::Str(Some(&vid)), Field::Int(Some(fn_id))])?;
            let from = self.symbol(&group[0].caller)?;
            self.is
                .row(&[Field::Int(Some(fn_id)), Field::Str(Some(&from))])?;
            for call in group {
                let callee = self.symbol(&call.callee)?;
                self.calls.row(&[
                    Field::Int(Some(fn_id)),
                    Field::Str(Some(&callee)),
                    Field::Int(Some(call.copies)),
                ])?;
                let pair = format!("{callee}\0{}", call.crate_name);
                if !self.seen_in.contains(&pair) {
                    self.symbol_in.row(&[
                        Field::Str(Some(&callee)),
                        Field::Str(Some(&call.crate_name)),
                    ])?;
                    self.seen_in.insert(pair);
                }
            }
        }
        Ok(())
    }

    fn finish(self, summary: &mut ExportSummary) -> Result<(), Error> {
        summary.symbols = self.symbols.finish()?;
        summary.fns = self.fns.finish()?;
        self.has_fn.finish()?;
        self.is.finish()?;
        summary.calls = self.calls.finish()?;
        summary.symbol_crates = self.symbol_in.finish()?;
        Ok(())
    }
}

async fn export_calls(
    graph: &Arc<Graph>,
    dir: &Path,
    summary: &mut ExportSummary,
) -> Result<(), Error> {
    let mut versions = Vec::new();
    let mut rows = graph
        .execute(query(
            "MATCH (v:Version) WHERE EXISTS { (v)-[:INVOKES]->() }
             RETURN v.name AS name, v.version AS version",
        ))
        .await?;
    while let Some(row) = rows.next().await? {
        versions.push((need_str(&row, "name")?, need_str(&row, "version")?));
    }
    log::info!("export: {} versions have INVOKES edges", versions.len());

    let mut files = CallFiles::create(dir)?;
    let mut results = futures::stream::iter(
        versions
            .into_iter()
            .map(|(name, version)| version_calls(graph.clone(), name, version)),
    )
    .buffer_unordered(VERSION_CONCURRENCY);
    while let Some(result) = results.next().await {
        let (name, version, edges, calls) = result?;
        files.version(&name, &version, &calls)?;
        summary.invokes += edges;
        summary.versions_with_calls += 1;
        if summary.versions_with_calls.is_multiple_of(1000) {
            log::info!(
                "export: {} versions, {} INVOKES edges read, {} distinct calls",
                summary.versions_with_calls,
                summary.invokes,
                files.calls.rows
            );
        }
    }
    files.finish(summary)
}

/// Large fetch size: the export streams hundreds of millions of rows.
async fn connect(uri: &str, user: &str, password: &str) -> Result<Arc<Graph>, Error> {
    Ok(Arc::new(
        Graph::connect(
            neo4rs::ConfigBuilder::default()
                .uri(uri)
                .user(user)
                .password(password)
                .db("neo4j")
                .fetch_size(10_000)
                .max_connections(VERSION_CONCURRENCY + 4)
                .build()?,
        )
        .await?,
    ))
}

/// Run while nothing writes to the database, or the files may mix states.
///
/// # Errors
/// [`Error::UnknownSchema`] before writing anything, else database or I/O errors.
pub async fn export_for_import(
    uri: &str,
    user: &str,
    password: &str,
    out: &Path,
) -> Result<ExportSummary, Error> {
    let graph = connect(uri, user, password).await?;
    check_schema(&graph).await?;
    std::fs::create_dir_all(out)?;

    let mut summary = ExportSummary {
        crates: export_crates(&graph, out).await?,
        ..ExportSummary::default()
    };
    log::info!("export: {} crates", summary.crates);
    (summary.versions, summary.version_of) = export_versions(&graph, out).await?;
    log::info!(
        "export: {} versions, {} VERSION_OF",
        summary.versions,
        summary.version_of
    );
    summary.lod_meta = export_lod_meta(&graph, out).await?;
    summary.depends_on = export_depends_on(&graph, out).await?;
    log::info!("export: {} DEPENDS_ON", summary.depends_on);
    summary.lod_dep = export_lod_dep(&graph, out).await?;
    log::info!("export: {} LOD_DEP", summary.lod_dep);
    export_calls(&graph, out, &mut summary).await?;
    log::info!("export: {summary:?}");
    Ok(summary)
}

#[must_use]
pub fn import_args(dir: &str) -> Vec<String> {
    let nodes = [
        ("Crate", "crates.csv"),
        ("Version", "versions.csv"),
        ("LodMeta", "lod_meta.csv"),
        ("Symbol", "symbols.csv"),
        ("Fn", "fns.csv"),
    ];
    let rels = [
        ("VERSION_OF", "version_of.csv"),
        ("DEPENDS_ON", "depends_on.csv"),
        ("LOD_DEP", "lod_dep.csv"),
        ("HAS_FN", "has_fn.csv"),
        ("IS", "is.csv"),
        ("CALLS", "calls.csv"),
        ("IN", "in.csv"),
    ];
    let path = |file: &str| PathBuf::from(dir).join(file).display().to_string();
    nodes
        .iter()
        .map(|(label, file)| format!("--nodes={label}={}", path(file)))
        .chain(
            rels.iter()
                .map(|(rel, file)| format!("--relationships={rel}={}", path(file))),
        )
        .collect()
}

pub const SCHEMA_CYPHER: &str = "\
CREATE CONSTRAINT const_crate_name IF NOT EXISTS FOR (n:Crate) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT const_version IF NOT EXISTS FOR (n:Version) REQUIRE (n.name, n.version) IS UNIQUE;
CREATE CONSTRAINT const_symbol_name IF NOT EXISTS FOR (n:Symbol) REQUIRE n.name IS UNIQUE;
CREATE TEXT INDEX idx_symbol_name_text IF NOT EXISTS FOR (n:Symbol) ON (n.name);
CREATE INDEX idx_is_latest IF NOT EXISTS FOR (n:Version) ON (n.latest);
CREATE INDEX idx_unsafe_total IF NOT EXISTS FOR (n:Version) ON (n.unsafe_total);
CREATE TEXT INDEX idx_crate_name_text IF NOT EXISTS FOR (n:Crate) ON (n.name);
CREATE INDEX crate_lod_x IF NOT EXISTS FOR (n:Crate) ON (n.lod_x);
CREATE INDEX crate_lod_community IF NOT EXISTS FOR (n:Crate) ON (n.lod_community);
";

#[cfg(test)]
mod tests {
    use super::*;

    fn row(from: &str, to: &str, krate: &str, copies: i64) -> CallRow {
        CallRow {
            caller: from.into(),
            callee: to.into(),
            crate_name: krate.into(),
            copies,
        }
    }

    fn read(dir: &Path, file: &str) -> String {
        std::fs::read_to_string(dir.join(file)).unwrap()
    }

    #[test]
    fn quoted_fields_double_embedded_quotes() {
        let mut out = Vec::new();
        write_quoted(&mut out, r#"a"b""c"#).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), r#""a""b""""c""#);
        let mut out = Vec::new();
        write_quoted(&mut out, "").unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), r#""""#);
    }

    #[test]
    fn csv_rows_quote_strings_and_leave_nulls_empty() {
        let dir = tempfile::tempdir().unwrap();
        let mut csv = Csv::create(
            dir.path(),
            "t.csv",
            &["a", "b:long", "c:double", "d:boolean", "e"],
        )
        .unwrap();
        csv.row(&[
            Field::Str(Some("x,y")),
            Field::Int(Some(-3)),
            Field::Float(Some(1.0)),
            Field::Bool(Some(true)),
            Field::Str(Some("")),
        ])
        .unwrap();
        csv.row(&[
            Field::Str(None),
            Field::Int(None),
            Field::Float(None),
            Field::Bool(None),
            Field::Str(None),
        ])
        .unwrap();
        assert_eq!(csv.finish().unwrap(), 2);
        assert_eq!(
            read(dir.path(), "t.csv"),
            "a,b:long,c:double,d:boolean,e\n\"x,y\",-3,1.0,true,\"\"\n,,,,\n"
        );
    }

    #[test]
    fn call_files_write_one_fn_per_caller_and_dedupe_symbols() {
        let dir = tempfile::tempdir().unwrap();
        let mut files = CallFiles::create(dir.path()).unwrap();
        files
            .version(
                "a",
                "1.0.0",
                &[
                    row("a::f", "b::g", "b", 3),
                    row("a::f", "c::h", "c", 1),
                    row("a::k", "b::g", "b", 1),
                ],
            )
            .unwrap();
        files
            .version("a", "2.0.0", &[row("b::g", "b::g", "b", 2)])
            .unwrap();
        let mut summary = ExportSummary::default();
        files.finish(&mut summary).unwrap();

        assert_eq!(summary.fns, 3);
        assert_eq!(summary.calls, 4);
        assert_eq!(summary.symbols, 4);
        assert_eq!(summary.symbol_crates, 2);
        assert_eq!(
            read(dir.path(), "has_fn.csv"),
            ":START_ID(Version),:END_ID(Fn)\n\"a@1.0.0\",0\n\"a@1.0.0\",1\n\"a@2.0.0\",2\n"
        );
        assert_eq!(
            read(dir.path(), "is.csv"),
            ":START_ID(Fn),:END_ID(Symbol)\n0,\"a::f\"\n1,\"a::k\"\n2,\"b::g\"\n"
        );
        assert_eq!(
            read(dir.path(), "calls.csv"),
            ":START_ID(Fn),:END_ID(Symbol),copies:long\n0,\"b::g\",3\n0,\"c::h\",1\n1,\"b::g\",1\n2,\"b::g\",2\n"
        );
        assert_eq!(
            read(dir.path(), "in.csv"),
            ":START_ID(Symbol),:END_ID(Crate)\n\"b::g\",\"b\"\n\"c::h\",\"c\"\n"
        );
    }

    #[test]
    fn call_files_key_long_symbols_and_keep_the_full_name() {
        let dir = tempfile::tempdir().unwrap();
        let mut files = CallFiles::create(dir.path()).unwrap();
        let long = format!("b::{}", "x".repeat(crate::db::MAX_SYMBOL_NAME_BYTES));
        files
            .version("a", "1.0.0", &[row("a::f", &long, "b", 1)])
            .unwrap();
        files.finish(&mut ExportSummary::default()).unwrap();
        let (key, _) = symbol_key(&long);
        let symbols = read(dir.path(), "symbols.csv");
        assert!(symbols.contains(&format!("\"{key}\",\"{long}\"\n")));
        assert!(symbols.contains("\"a::f\",\n"));
        assert!(read(dir.path(), "calls.csv").contains(&format!("0,\"{key}\",1")));
        assert!(read(dir.path(), "in.csv").contains(&format!("\"{key}\",\"b\"")));
    }

    #[test]
    fn import_args_cover_every_file() {
        let args = import_args("/import");
        assert_eq!(args.len(), 12);
        assert!(args.contains(&"--nodes=Symbol=/import/symbols.csv".to_string()));
        assert!(args.contains(&"--relationships=CALLS=/import/calls.csv".to_string()));
    }
}
