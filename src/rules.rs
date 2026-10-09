//! Build rules: pluggable policy deciding which crates, and which of their versions, the
//! ecosystem builder compiles.
//!
//! Implement [`BuildRules`] to supply your own policy, or use one of the provided ones:
//!
//! - [`BuildEverything`]: every crate in the crates.io index.
//! - [`NamedCrates`]: an explicit list of crate names.
//! - [`EcosystemsRules`]: crate sets ranked by <https://ecosyste.ms> (downloads, reverse
//!   dependencies, most-downloaded maintainers) and/or versions published after a date.

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

/// Policy deciding what the ecosystem builder compiles.
///
/// The builder first asks for [`candidate_crates`](Self::candidate_crates) to know which
/// crates to visit, then calls [`select_versions`](Self::select_versions) once per crate to
/// learn which versions to build. Both are async so implementations can consult external data
/// sources; they are invoked with bounded concurrency.
#[allow(clippy::double_must_use)] // fires on the `async_trait` expansion, not on our code
#[async_trait]
pub trait BuildRules: Send + Sync {
    /// Names of crates to consider. `None` means every crate in the index.
    async fn candidate_crates(&self) -> Result<Option<Vec<String>>, Error>;

    /// Which versions of `krate` to build. An empty vector skips the crate.
    async fn select_versions(&self, krate: &Crate) -> Result<Vec<Version>, Error>;
}

/// Versions of a crate as the index lists them, either the highest only or all non-yanked.
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

/// Build every crate in the index.
#[derive(Debug, Clone, Default)]
pub struct BuildEverything {
    /// Build every non-yanked version instead of only the highest.
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

/// Build an explicit list of crates.
#[derive(Debug, Clone, Default)]
pub struct NamedCrates {
    pub names: Vec<String>,
    /// Build every non-yanked version instead of only the highest.
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

/// Rules driven by ecosyste.ms rankings. The crate set is the union of `crates` and every
/// enabled `top_*` selector; if all are empty, every crate in the index is a candidate. `newer_than` then
/// drops versions published on or before that instant (using ecosyste.ms publish dates, one
/// request per crate).
#[derive(Debug, Clone, Default)]
pub struct EcosystemsRules {
    pub client: EcosystemsClient,
    /// Crates always included in the candidate set, regardless of rankings.
    pub crates: Vec<String>,
    /// Top N crates by total downloads.
    pub top_downloads: Option<usize>,
    /// Top N crates by number of dependent packages.
    pub top_reverse_dependencies: Option<usize>,
    /// Every crate of the top N maintainers, ranked by total downloads of their crates.
    pub top_maintainers: Option<usize>,
    /// Only versions published strictly after this instant.
    pub newer_than: Option<DateTime<Utc>>,
    /// Consider every non-yanked version instead of only the highest.
    pub all_versions: bool,
}

impl EcosystemsRules {
    /// Whether any crate-set selector is enabled.
    #[must_use]
    pub fn has_crate_selectors(&self) -> bool {
        !self.crates.is_empty()
            || self.top_downloads.is_some()
            || self.top_reverse_dependencies.is_some()
            || self.top_maintainers.is_some()
    }

    /// Parse a `YYYY-MM-DD` (midnight UTC) or RFC 3339 timestamp.
    ///
    /// # Errors
    /// Returns [`Error::InvalidDate`] if neither format matches.
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

/// Append `names` to `out`, skipping any already present, preserving first-seen order.
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

/// Keep only versions whose publish date (looked up by version number) is strictly after
/// `cutoff`. Versions with no known date are dropped.
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
            "0.2.0" => Some(utc("2024-01-01")), // exactly the cutoff: not strictly newer
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
        // No `newer_than`: versions pass straight through without any API call.
        let c = fake_crate("a", &[("0.1.0", false, &[])]);
        assert_eq!(rules.select_versions(&c).await.unwrap().len(), 1);

        let rules = EcosystemsRules {
            crates: vec!["serde".into()],
            ..EcosystemsRules::default()
        };
        assert!(rules.has_crate_selectors());
        // Explicit crates need no API call either.
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
