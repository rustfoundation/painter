//! Pluggable policy for which crates, and which of their versions, get compiled.

use crate::ecosystems::{EcosystemsClient, PackageSort};
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use crates_index::{Crate, Version};
use std::collections::HashSet;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("ecosyste.ms error: {0}")]
    Ecosystems(#[from] crate::ecosystems::Error),
    #[error("invalid date `{0}`: expected YYYY-MM-DD or RFC 3339")]
    InvalidDate(String),
}

#[allow(clippy::double_must_use)] // fires on the `async_trait` expansion
#[async_trait]
pub trait BuildRules: Send + Sync {
    /// `None` means every crate in the index.
    async fn candidate_crates(&self) -> Result<Option<Vec<String>>, Error>;

    /// An empty vector skips the crate.
    async fn select_versions(&self, krate: &Crate) -> Result<Vec<Version>, Error>;
}

#[must_use]
pub fn index_versions(krate: &Crate, all_versions: bool) -> Vec<Version> {
    if all_versions {
        krate
            .versions()
            .iter()
            .filter(|v| !v.is_yanked())
            .cloned()
            .collect()
    } else {
        vec![krate.highest_version().clone()]
    }
}

#[derive(Debug, Clone, Default)]
pub struct BuildEverything {
    pub all_versions: bool,
}

#[async_trait]
impl BuildRules for BuildEverything {
    async fn candidate_crates(&self) -> Result<Option<Vec<String>>, Error> {
        Ok(None)
    }

    async fn select_versions(&self, krate: &Crate) -> Result<Vec<Version>, Error> {
        Ok(index_versions(krate, self.all_versions))
    }
}

#[derive(Debug, Clone, Default)]
pub struct NamedCrates {
    pub names: Vec<String>,
    pub all_versions: bool,
}

#[async_trait]
impl BuildRules for NamedCrates {
    async fn candidate_crates(&self) -> Result<Option<Vec<String>>, Error> {
        Ok(Some(self.names.clone()))
    }

    async fn select_versions(&self, krate: &Crate) -> Result<Vec<Version>, Error> {
        Ok(index_versions(krate, self.all_versions))
    }
}

/// `newer_than` costs one ecosyste.ms request per candidate crate.
#[derive(Debug, Clone, Default)]
pub struct EcosystemsRules {
    pub client: EcosystemsClient,
    pub crates: Vec<String>,
    pub top_downloads: Option<usize>,
    pub top_reverse_dependencies: Option<usize>,
    pub top_maintainers: Option<usize>,
    /// Only versions published strictly after this instant.
    pub newer_than: Option<DateTime<Utc>>,
    pub all_versions: bool,
}

impl EcosystemsRules {
    #[must_use]
    pub fn has_crate_selectors(&self) -> bool {
        !self.crates.is_empty()
            || self.top_downloads.is_some()
            || self.top_reverse_dependencies.is_some()
            || self.top_maintainers.is_some()
    }

    /// # Errors
    /// [`Error::InvalidDate`] unless `YYYY-MM-DD` (midnight UTC) or RFC 3339.
    pub fn parse_date(s: &str) -> Result<DateTime<Utc>, Error> {
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return Ok(dt.with_timezone(&Utc));
        }
        NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|ndt| ndt.and_utc())
            .ok_or_else(|| Error::InvalidDate(s.to_string()))
    }
}

pub fn union_names<S: std::hash::BuildHasher>(
    out: &mut Vec<String>,
    seen: &mut HashSet<String, S>,
    names: Vec<String>,
) {
    for n in names {
        if seen.insert(n.clone()) {
            out.push(n);
        }
    }
}

/// Versions with no known date are dropped.
#[must_use]
pub fn filter_newer_than<'a>(
    versions: Vec<Version>,
    published: &dyn Fn(&str) -> Option<DateTime<Utc>>,
    cutoff: &'a DateTime<Utc>,
) -> Vec<Version> {
    versions
        .into_iter()
        .filter(|v| published(v.version()).is_some_and(|d| d > *cutoff))
        .collect()
}

#[async_trait]
impl BuildRules for EcosystemsRules {
    async fn candidate_crates(&self) -> Result<Option<Vec<String>>, Error> {
        if !self.has_crate_selectors() {
            return Ok(None);
        }

        let mut names = Vec::new();
        let mut seen = HashSet::new();
        union_names(&mut names, &mut seen, self.crates.clone());

        if let Some(n) = self.top_downloads {
            log::info!("ecosyste.ms: fetching top {n} crates by downloads");
            let pkgs = self.client.top_packages(PackageSort::Downloads, n).await?;
            union_names(
                &mut names,
                &mut seen,
                pkgs.into_iter().map(|p| p.name).collect(),
            );
        }
        if let Some(n) = self.top_reverse_dependencies {
            log::info!("ecosyste.ms: fetching top {n} crates by reverse dependencies");
            let pkgs = self
                .client
                .top_packages(PackageSort::DependentPackages, n)
                .await?;
            union_names(
                &mut names,
                &mut seen,
                pkgs.into_iter().map(|p| p.name).collect(),
            );
        }
        if let Some(n) = self.top_maintainers {
            log::info!("ecosyste.ms: ranking maintainers by downloads, taking top {n}");
            for m in self.client.top_maintainers_by_downloads(n).await? {
                let pkgs = self.client.maintainer_packages(m.id()).await?;
                log::info!(
                    "ecosyste.ms: maintainer {} ({} downloads) has {} crates",
                    m.id(),
                    m.total_downloads.unwrap_or(0),
                    pkgs.len()
                );
                union_names(
                    &mut names,
                    &mut seen,
                    pkgs.into_iter().map(|p| p.name).collect(),
                );
            }
        }

        Ok(Some(names))
    }

    async fn select_versions(&self, krate: &Crate) -> Result<Vec<Version>, Error> {
        let versions = index_versions(krate, self.all_versions);
        let Some(cutoff) = self.newer_than else {
            return Ok(versions);
        };

        let dates: std::collections::HashMap<String, DateTime<Utc>> = self
            .client
            .package_versions(krate.name())
            .await?
            .into_iter()
            .filter_map(|v| v.published_at.map(|d| (v.number, d)))
            .collect();

        Ok(filter_newer_than(
            versions,
            &|num| dates.get(num).copied(),
            &cutoff,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::test_support::fake_crate;

    fn utc(s: &str) -> DateTime<Utc> {
        EcosystemsRules::parse_date(s).unwrap()
    }

    #[test]
    fn index_versions_highest_or_all_unyanked() {
        let c = fake_crate(
            "foo",
            &[
                ("0.1.0", false, &[]),
                ("0.2.0", true, &[]),
                ("0.3.0", false, &[]),
            ],
        );
        let highest: Vec<_> = index_versions(&c, false)
            .iter()
            .map(|v| v.version().to_string())
            .collect();
        assert_eq!(highest, ["0.3.0"]);
        let all: Vec<_> = index_versions(&c, true)
            .iter()
            .map(|v| v.version().to_string())
            .collect();
        assert_eq!(all, ["0.1.0", "0.3.0"], "yanked versions are dropped");
    }

    #[test]
    fn filter_newer_than_drops_old_and_undated_versions() {
        let c = fake_crate(
            "foo",
            &[
                ("0.1.0", false, &[]),
                ("0.2.0", false, &[]),
                ("0.3.0", false, &[]),
            ],
        );
        let cutoff = utc("2024-01-01");
        let published = |v: &str| match v {
            "0.1.0" => Some(utc("2023-06-01")),
            "0.2.0" => Some(utc("2024-01-01")), // exactly the cutoff: not newer
            "0.3.0" => Some(utc("2024-02-01")),
            _ => None,
        };
        let kept: Vec<_> = filter_newer_than(index_versions(&c, true), &published, &cutoff)
            .iter()
            .map(|v| v.version().to_string())
            .collect();
        assert_eq!(kept, ["0.3.0"]);

        let none = filter_newer_than(index_versions(&c, true), &|_| None, &cutoff);
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn build_everything_visits_whole_index() {
        let rules = BuildEverything {
            all_versions: false,
        };
        assert_eq!(rules.candidate_crates().await.unwrap(), None);
        let c = fake_crate("foo", &[("0.1.0", false, &[]), ("0.2.0", false, &[])]);
        let v = rules.select_versions(&c).await.unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].version(), "0.2.0");
    }

    #[tokio::test]
    async fn named_crates_lists_names() {
        let rules = NamedCrates {
            names: vec!["a".into(), "b".into()],
            all_versions: true,
        };
        assert_eq!(
            rules.candidate_crates().await.unwrap(),
            Some(vec!["a".to_string(), "b".to_string()])
        );
        let c = fake_crate("a", &[("0.1.0", false, &[]), ("0.2.0", false, &[])]);
        assert_eq!(rules.select_versions(&c).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn ecosystems_rules_without_selectors_cover_the_index() {
        let rules = EcosystemsRules::default();
        assert!(!rules.has_crate_selectors());
        assert_eq!(rules.candidate_crates().await.unwrap(), None);
        let c = fake_crate("a", &[("0.1.0", false, &[])]);
        assert_eq!(rules.select_versions(&c).await.unwrap().len(), 1);

        let rules = EcosystemsRules {
            crates: vec!["serde".into()],
            ..EcosystemsRules::default()
        };
        assert!(rules.has_crate_selectors());
        assert_eq!(
            rules.candidate_crates().await.unwrap(),
            Some(vec!["serde".to_string()])
        );
    }

    #[test]
    fn parses_dates() {
        let d = EcosystemsRules::parse_date("2024-03-01").unwrap();
        assert_eq!(d.to_rfc3339(), "2024-03-01T00:00:00+00:00");
        let d = EcosystemsRules::parse_date("2024-03-01T12:30:00Z").unwrap();
        assert_eq!(d.to_rfc3339(), "2024-03-01T12:30:00+00:00");
        assert!(EcosystemsRules::parse_date("yesterday").is_err());
    }

    #[test]
    fn union_preserves_order_and_dedups() {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        union_names(&mut out, &mut seen, vec!["a".into(), "b".into()]);
        union_names(
            &mut out,
            &mut seen,
            vec!["b".into(), "c".into(), "a".into()],
        );
        assert_eq!(out, vec!["a", "b", "c"]);
    }
}
