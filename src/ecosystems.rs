//! Minimal client for the [ecosyste.ms packages API](https://packages.ecosyste.ms/docs),
//! scoped to the crates.io registry. Only the endpoints the build rules need are wrapped.

use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::time::Duration;

/// Default API root.
pub const DEFAULT_BASE_URL: &str = "https://packages.ecosyste.ms/api/v1";
/// Registry name as ecosyste.ms knows it.
pub const REGISTRY: &str = "crates.io";
/// Largest page the API serves.
const MAX_PER_PAGE: usize = 1000;
/// Retries on rate limiting or transient server errors.
const MAX_RETRIES: u32 = 4;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("ecosyste.ms returned {status} for {url}")]
    Status {
        status: reqwest::StatusCode,
        url: String,
    },
}

/// Package sort keys supported by the registry packages listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageSort {
    /// Total downloads.
    Downloads,
    /// Number of packages that depend on this one (reverse dependencies).
    DependentPackages,
}

impl PackageSort {
    fn as_query(self) -> &'static str {
        match self {
            Self::Downloads => "downloads",
            Self::DependentPackages => "dependent_packages_count",
        }
    }
}

/// Subset of the ecosyste.ms package record we use.
#[derive(Debug, Clone, Deserialize)]
pub struct Package {
    pub name: String,
    #[serde(default)]
    pub downloads: Option<u64>,
    #[serde(default)]
    pub dependent_packages_count: Option<u64>,
}

/// Subset of the ecosyste.ms maintainer record we use.
#[derive(Debug, Clone, Deserialize)]
pub struct Maintainer {
    pub uuid: String,
    /// Some records have no login; use [`Maintainer::id`] to address the API.
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub packages_count: Option<u64>,
    #[serde(default)]
    pub total_downloads: Option<u64>,
}

impl Maintainer {
    /// Login if known, else UUID. Both are accepted by the maintainer endpoints.
    #[must_use]
    pub fn id(&self) -> &str {
        self.login.as_deref().unwrap_or(&self.uuid)
    }
}

/// Subset of the ecosyste.ms version record we use.
#[derive(Debug, Clone, Deserialize)]
pub struct VersionInfo {
    pub number: String,
    #[serde(default)]
    pub published_at: Option<DateTime<Utc>>,
}

/// HTTP client for the packages API.
#[derive(Debug, Clone)]
pub struct EcosystemsClient {
    http: reqwest::Client,
    base_url: String,
}

impl Default for EcosystemsClient {
    fn default() -> Self {
        Self::new(DEFAULT_BASE_URL)
    }
}

impl EcosystemsClient {
    /// Create a client against `base_url` (see [`DEFAULT_BASE_URL`]).
    ///
    /// # Panics
    /// Panics if the underlying HTTP client cannot be constructed, which only happens when TLS
    /// initialisation fails.
    #[must_use]
    pub fn new(base_url: &str) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!(
                "painter/",
                env!("CARGO_PKG_VERSION"),
                " (+https://github.com/rustfoundation/painter)"
            ))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("reqwest client");
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    fn registry_url(&self, path: &str) -> String {
        format!("{}/registries/{}/{}", self.base_url, REGISTRY, path)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        query: &[(&str, String)],
    ) -> Result<T, Error> {
        let mut attempt = 0;
        loop {
            let resp = self.http.get(url).query(query).send().await?;
            let status = resp.status();
            if status.is_success() {
                return Ok(resp.json::<T>().await?);
            }
            attempt += 1;
            let retryable = status == reqwest::StatusCode::TOO_MANY_REQUESTS
                || status.is_server_error();
            if !retryable || attempt > MAX_RETRIES {
                return Err(Error::Status {
                    status,
                    url: url.to_string(),
                });
            }
            let wait = Duration::from_secs(5 * u64::from(attempt));
            log::warn!("ecosyste.ms {status} for {url}; retrying in {wait:?}");
            tokio::time::sleep(wait).await;
        }
    }

    /// Fetch up to `limit` items from a paginated listing (`None` = all pages).
    async fn paged<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        query: &[(&str, String)],
        limit: Option<usize>,
    ) -> Result<Vec<T>, Error> {
        let mut out = Vec::new();
        let mut page = 1usize;
        loop {
            let remaining = limit.map_or(MAX_PER_PAGE, |l| l.saturating_sub(out.len()));
            if remaining == 0 {
                break;
            }
            let per_page = remaining.min(MAX_PER_PAGE);
            let mut q: Vec<(&str, String)> = query.to_vec();
            q.push(("page", page.to_string()));
            q.push(("per_page", per_page.to_string()));
            let items: Vec<T> = self.get_json(url, &q).await?;
            let got = items.len();
            out.extend(items);
            if got < per_page {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    /// The top `n` crates.io packages by `sort`, most first.
    ///
    /// # Errors
    /// Returns an HTTP or status error from the API.
    pub async fn top_packages(&self, sort: PackageSort, n: usize) -> Result<Vec<Package>, Error> {
        self.paged(
            &self.registry_url("packages"),
            &[
                ("sort", sort.as_query().to_string()),
                ("order", "desc".to_string()),
            ],
            Some(n),
        )
        .await
    }

    /// The top `n` crates.io maintainers by total downloads of the packages they maintain.
    ///
    /// The API cannot sort maintainers by downloads, so this scans every maintainer record
    /// (about 73k, in pages of 1000) and ranks client-side.
    ///
    /// # Errors
    /// Returns an HTTP or status error from the API.
    pub async fn top_maintainers_by_downloads(&self, n: usize) -> Result<Vec<Maintainer>, Error> {
        let url = self.registry_url("maintainers");
        let query = [
            ("sort", "packages_count".to_string()),
            ("order", "desc".to_string()),
        ];
        let mut all: Vec<Maintainer> = Vec::new();
        let mut page = 1usize;
        loop {
            let mut q: Vec<(&str, String)> = query.to_vec();
            q.push(("page", page.to_string()));
            q.push(("per_page", MAX_PER_PAGE.to_string()));
            let items: Vec<Maintainer> = self.get_json(&url, &q).await?;
            let got = items.len();
            all.extend(items);
            log::info!("ecosyste.ms: scanned {} maintainers", all.len());
            if got < MAX_PER_PAGE {
                break;
            }
            page += 1;
        }
        all.sort_by(|a, b| {
            b.total_downloads
                .unwrap_or(0)
                .cmp(&a.total_downloads.unwrap_or(0))
                .then_with(|| a.uuid.cmp(&b.uuid))
        });
        all.truncate(n);
        Ok(all)
    }

    /// The top `n` crates.io maintainers by number of packages they maintain (the only ranking
    /// the API sorts server-side).
    ///
    /// # Errors
    /// Returns an HTTP or status error from the API.
    pub async fn top_maintainers_by_packages(&self, n: usize) -> Result<Vec<Maintainer>, Error> {
        self.paged(
            &self.registry_url("maintainers"),
            &[
                ("sort", "packages_count".to_string()),
                ("order", "desc".to_string()),
            ],
            Some(n),
        )
        .await
    }

    /// Every package maintained by `login`.
    ///
    /// # Errors
    /// Returns an HTTP or status error from the API.
    pub async fn maintainer_packages(&self, login: &str) -> Result<Vec<Package>, Error> {
        self.paged(
            &self.registry_url(&format!("maintainers/{login}/packages")),
            &[],
            None,
        )
        .await
    }

    /// Every published version of `name` with its publish timestamp.
    ///
    /// # Errors
    /// Returns an HTTP or status error from the API.
    pub async fn package_versions(&self, name: &str) -> Result<Vec<VersionInfo>, Error> {
        self.paged(
            &self.registry_url(&format!("packages/{name}/versions")),
            &[],
            None,
        )
        .await
    }
}
