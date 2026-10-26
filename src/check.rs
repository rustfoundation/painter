//! `compile-check`: reconcile the index, the bytecode root, and the database.

use crate::{
    compile,
    crate_fs::split_full_name,
    db::{CrateDbStatus, Db},
    rules::BuildRules,
};
use futures::StreamExt;
use rayon::prelude::*;
use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    path::Path,
    sync::Arc,
};

pub const DB_CHUNK: usize = 500;

pub const DB_CONCURRENCY: usize = 16;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("{0}")]
    IoError(#[from] std::io::Error),
    #[error("{0}")]
    PlanError(#[from] compile::Error),
    #[error("{0}")]
    DatabaseError(#[from] crate::db::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionStatus {
    pub name: String,
    pub version: String,
    pub bytecode: bool,
    pub in_db: bool,
    /// At least one `[:HAS_FN]`; versions with no cross-crate calls never get one.
    pub exported: bool,
}

impl VersionStatus {
    #[must_use]
    pub fn complete(&self) -> bool {
        self.bytecode && self.in_db && self.exported
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub statuses: Vec<VersionStatus>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    pub total: usize,
    pub bytecode: usize,
    pub in_db: usize,
    pub exported: usize,
    pub missing_bytecode: usize,
    pub missing_db: usize,
    pub missing_both: usize,
}

impl Counts {
    fn from_statuses<'a, I: Iterator<Item = &'a VersionStatus>>(iter: I) -> Self {
        let mut c = Self::default();
        for s in iter {
            c.total += 1;
            c.bytecode += usize::from(s.bytecode);
            c.in_db += usize::from(s.in_db);
            c.exported += usize::from(s.exported);
            c.missing_bytecode += usize::from(!s.bytecode);
            c.missing_db += usize::from(!s.in_db);
            c.missing_both += usize::from(!s.bytecode && !s.in_db);
        }
        c
    }
}

impl Report {
    #[must_use]
    pub fn versions(&self) -> Counts {
        Counts::from_statuses(self.statuses.iter())
    }

    /// A crate counts towards a column only if every selected version does.
    #[must_use]
    pub fn crates(&self) -> Counts {
        let mut by_crate: HashMap<&str, VersionStatus> = HashMap::new();
        for s in &self.statuses {
            let e = by_crate.entry(&s.name).or_insert_with(|| VersionStatus {
                name: s.name.clone(),
                version: String::new(),
                bytecode: true,
                in_db: true,
                exported: true,
            });
            e.bytecode &= s.bytecode;
            e.in_db &= s.in_db;
            e.exported &= s.exported;
        }
        Counts::from_statuses(by_crate.values())
    }

    #[must_use]
    pub fn missing(&self) -> Vec<&VersionStatus> {
        let mut v: Vec<_> = self.statuses.iter().filter(|s| !s.complete()).collect();
        v.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.version.cmp(&b.version)));
        v
    }

    /// # Panics
    /// Never; writing to a `String` cannot fail.
    #[must_use]
    pub fn render_summary(&self) -> String {
        let rows = [("crates", self.crates()), ("versions", self.versions())];
        let mut out = String::new();
        writeln!(
            out,
            "{:<10} {:>10} {:>10} {:>10} {:>10} | {:>12} {:>12} {:>12}",
            "", "index", "bytecode", "in db", "exported", "no bytecode", "not in db", "neither"
        )
        .unwrap();
        for (label, c) in rows {
            writeln!(
                out,
                "{label:<10} {:>10} {:>10} {:>10} {:>10} | {:>12} {:>12} {:>12}",
                c.total,
                c.bytecode,
                c.in_db,
                c.exported,
                c.missing_bytecode,
                c.missing_db,
                c.missing_both
            )
            .unwrap();
        }
        out.push_str(
            "\n`exported` = has a call graph; versions with no cross-crate calls never gain one.\n\
             Crate rows count a crate only when every selected version qualifies.\n",
        );
        out
    }

    /// # Panics
    /// Never; writing to a `String` cannot fail.
    #[must_use]
    pub fn render_missing(&self) -> String {
        let mut out = String::new();
        for s in self.missing() {
            let mut missing = Vec::new();
            if !s.bytecode {
                missing.push("bytecode");
            }
            if !s.in_db {
                missing.push("db");
            } else if !s.exported {
                missing.push("calls");
            }
            writeln!(
                out,
                "{}-{}\tmissing: {}",
                s.name,
                s.version,
                missing.join(",")
            )
            .unwrap();
        }
        out
    }
}

/// # Errors
/// If `bc_root` cannot be listed.
pub fn scan_bytecodes(bc_root: &Path) -> Result<HashSet<(String, String)>, Error> {
    let entries: Vec<_> = std::fs::read_dir(bc_root)?.collect::<Result<_, _>>()?;
    Ok(entries
        .into_par_iter()
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let dir_name = entry.file_name();
            let dir_name = dir_name.to_str()?;
            if dir_name.starts_with('.') {
                // Compile's staging dir.
                return None;
            }
            let Some((name, version)) = split_full_name(dir_name) else {
                log::warn!("bytecode dir does not look like <name>-<version>: {dir_name}");
                return None;
            };
            let has_bc = std::fs::read_dir(entry.path())
                .ok()?
                .filter_map(Result::ok)
                .any(|f| f.path().extension().is_some_and(|e| e == "bc"));
            if has_bc {
                Some((name.to_owned(), version.to_owned()))
            } else {
                log::debug!("{dir_name}: bytecode dir has no .bc files, treating as missing");
                None
            }
        })
        .collect())
}

/// # Panics
/// If the bytecode scan task panics.
///
/// # Errors
/// If planning fails, the bytecode root cannot be read, or a query fails.
pub async fn compile_check(
    rules: &dyn BuildRules,
    rules_concurrency: usize,
    bc_root: &Path,
    db: Arc<Db>,
) -> Result<Report, Error> {
    let work = compile::plan(rules, rules_concurrency).await?;

    let mut names: Vec<&str> = work.iter().map(|(n, _)| n.as_str()).collect();
    names.sort_unstable();
    names.dedup();

    // Blocking filesystem work, overlapped with the database queries.
    log::info!("scanning bytecode root {}", bc_root.display());
    let scan = tokio::task::spawn_blocking({
        let bc_root = bc_root.to_path_buf();
        move || scan_bytecodes(&bc_root)
    });

    log::info!("querying database for {} crates", names.len());
    let mut db_status: HashMap<String, CrateDbStatus> = HashMap::new();
    {
        let mut queries = futures::stream::iter(names.chunks(DB_CHUNK))
            .map(|chunk| {
                let db = db.clone();
                async move { db.crate_version_status(chunk).await }
            })
            .buffer_unordered(DB_CONCURRENCY);
        while let Some(result) = queries.next().await {
            db_status.extend(result?);
        }
    }
    drop(names);

    let bytecodes = scan.await.expect("bytecode scan task panicked")?;
    log::info!("found {} compiled versions", bytecodes.len());

    let statuses = work
        .into_iter()
        .map(|(name, version)| {
            let (in_db, exported) = db_status.get(&name).map_or((false, false), |s| {
                (s.versions.contains(&version), s.exported.contains(&version))
            });
            let bytecode = bytecodes.contains(&(name.clone(), version.clone()));
            VersionStatus {
                name,
                version,
                bytecode,
                in_db,
                exported,
            }
        })
        .collect();

    Ok(Report { statuses })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(name: &str, version: &str, bytecode: bool, in_db: bool, exported: bool) -> VersionStatus {
        VersionStatus {
            name: name.into(),
            version: version.into(),
            bytecode,
            in_db,
            exported,
        }
    }

    #[test]
    fn scan_bytecodes_requires_a_bc_file_and_a_parsable_name() {
        let tmp = tempfile::tempdir().unwrap();
        let mk = |name: &str, files: &[&str]| {
            let d = tmp.path().join(name);
            std::fs::create_dir_all(&d).unwrap();
            for f in files {
                std::fs::write(d.join(f), b"").unwrap();
            }
        };
        mk("serde-1.0.0", &["serde-abc.bc"]);
        mk("foo-bar-0.2.0-rc.1", &["a.bc", "b.bc"]);
        mk("empty-1.0.0", &[]);
        mk("junk-1.0.0", &["notes.txt"]);
        mk("not_a_crate_dir", &["x.bc"]);
        mk(".painter-staging/half-1.0.0", &["x.bc"]);
        std::fs::write(tmp.path().join("stray-1.0.0"), b"file, not dir").unwrap();

        let found = scan_bytecodes(tmp.path()).unwrap();
        let mut names: Vec<_> = found.iter().map(|(n, v)| format!("{n}-{v}")).collect();
        names.sort();
        assert_eq!(names, ["foo-bar-0.2.0-rc.1", "serde-1.0.0"]);

        assert!(scan_bytecodes(&tmp.path().join("missing")).is_err());
    }

    #[test]
    fn summary_table_reports_totals_and_gaps() {
        let report = Report {
            statuses: vec![
                st("a", "1.0.0", true, true, true),
                st("b", "0.1.0", false, false, false),
            ],
        };
        let table = report.render_summary();
        let versions_row = table.lines().find(|l| l.starts_with("versions")).unwrap();
        let cols: Vec<_> = versions_row.split_whitespace().collect();
        assert_eq!(cols, ["versions", "2", "1", "1", "1", "|", "1", "1", "1"]);
        assert!(table.contains("exported"));
        assert_eq!(Report::default().render_missing(), "");
    }

    #[test]
    fn counts_versions_and_crates() {
        let report = Report {
            statuses: vec![
                st("a", "1.0.0", true, true, true),
                st("a", "1.0.1", false, true, false),
                st("b", "0.1.0", false, false, false),
                st("c", "2.0.0", true, true, false),
            ],
        };
        let v = report.versions();
        assert_eq!(v.total, 4);
        assert_eq!(v.bytecode, 2);
        assert_eq!(v.in_db, 3);
        assert_eq!(v.exported, 1);
        assert_eq!(v.missing_bytecode, 2);
        assert_eq!(v.missing_db, 1);
        assert_eq!(v.missing_both, 1);

        let c = report.crates();
        assert_eq!(c.total, 3);
        assert_eq!(c.bytecode, 1);
        assert_eq!(c.in_db, 2);
        assert_eq!(c.exported, 0);
        assert_eq!(c.missing_both, 1);

        let missing: Vec<_> = report
            .missing()
            .iter()
            .map(|s| format!("{}-{}", s.name, s.version))
            .collect();
        assert_eq!(missing, ["a-1.0.1", "b-0.1.0", "c-2.0.0"]);
        assert!(
            report
                .render_missing()
                .contains("b-0.1.0\tmissing: bytecode,db")
        );
        assert!(report.render_missing().contains("c-2.0.0\tmissing: calls"));
    }
}
