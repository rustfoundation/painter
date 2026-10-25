#![allow(clippy::module_name_repetitions)]
use circular_buffer::CircularBuffer;
use std::path::{Path, PathBuf};

/// Top error type returned during any stage of analysis from compile to data import.
#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("IO Error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("{0}")]
    IndexError(#[from] crates_index::Error),
    #[error("CrateNotFound")]
    CrateNotFound,
    #[error("CrateFileNotFound")]
    CrateFileNotFound,
    #[error("CrateFileNotFound")]
    ExtractionFailed,
    #[error(
        "Crate name contained invalid characters or did not match the NAME-VER format. Name: {0}"
    )]
    CrateNameError(String),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CrateEntry {
    name: String,
    version: String,
}
impl CrateEntry {
    /// Build an entry from a `<name>-<version>` string. Both crate names and versions may
    /// contain `-` (e.g. `serde-1.0.172-alpha.0`), so the split is chosen as the right-most `-`
    /// whose right-hand side parses as a semver version.
    ///
    /// # Errors
    /// Returns `Error::CrateNameError` if no such split exists.
    pub fn new(full_name: &str) -> Result<Self, Error> {
        let (name, version) = split_full_name(full_name)
            .ok_or_else(|| Error::CrateNameError(full_name.to_string()))?;
        Ok(Self {
            name: name.to_string(),
            version: version.to_string(),
        })
    }

    /// Build an entry from an already-separated name and version (e.g. from the index).
    #[must_use]
    pub fn from_parts(name: &str, version: &str) -> Self {
        Self {
            name: name.to_string(),
            version: version.to_string(),
        }
    }

    #[must_use]
    pub fn full_name(&self) -> String {
        format!("{}-{}", self.name, self.version)
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn filename(&self) -> String {
        format!("{}.crate", self.full_name())
    }

    /// Candidate locations of this crate's `.crate` file under `crates_dir`, most specific
    /// first. Supports the crates.io-index style sharded layout
    /// (`1/<n>`, `2/<n>`, `3/<c>/<n>`, `<ab>/<cd>/<n>`) with the crate name as the leaf
    /// directory, the same layout without the name directory, and a flat directory.
    #[must_use]
    pub fn candidate_paths(&self, crates_dir: &Path) -> Vec<PathBuf> {
        let name = self.name().to_ascii_lowercase();
        let file = self.filename();
        let shard: PathBuf = match name.len() {
            0 => PathBuf::new(),
            1 => PathBuf::from("1"),
            2 => PathBuf::from("2"),
            3 => Path::new("3").join(&name[..1]),
            _ => Path::new(&name[..2]).join(&name[2..4]),
        };

        vec![
            crates_dir.join(&shard).join(&name).join(&file),
            crates_dir.join(&shard).join(&file),
            crates_dir.join(&file),
        ]
    }

    /// Locate this crate's `.crate` file under `crates_dir`.
    ///
    /// # Errors
    /// Returns `Error::CrateFileNotFound` if none of the candidate layouts contain the file.
    pub fn locate(&self, crates_dir: &Path) -> Result<PathBuf, Error> {
        self.candidate_paths(crates_dir)
            .into_iter()
            .find(|p| p.is_file())
            .ok_or(Error::CrateFileNotFound)
    }
}
/// Split `<name>-<version>` at the right-most `-` whose remainder is a valid (lenient) semver.
#[must_use]
pub fn split_full_name(full_name: &str) -> Option<(&str, &str)> {
    full_name
        .char_indices()
        .filter(|(_, c)| *c == '-')
        .map(|(i, _)| (&full_name[..i], &full_name[i + 1..]))
        .rev()
        .find(|(name, version)| {
            !name.is_empty()
                && version.starts_with(|c: char| c.is_ascii_digit())
                && lenient_semver::parse(version).is_ok()
        })
}

impl<S> From<S> for CrateEntry
where
    S: AsRef<str>,
{
    fn from(rhv: S) -> CrateEntry {
        Self::new(rhv.as_ref()).unwrap()
    }
}

#[derive(Debug)]
pub struct CrateCache {
    extracted_path: PathBuf,
    no_delete: bool,
}
impl CrateCache {
    /// Extract `entry` from `crates_dir` into `sources_dir`, or adopt an existing extraction
    /// (which is then never deleted on drop).
    ///
    /// # Errors
    /// Returns `Error::CrateFileNotFound` if the `.crate` is missing, `Error::IoError` if the
    /// archive cannot be read or unpacked, or `Error::ExtractionFailed` if unpacking produced no
    /// `<name>-<version>` directory.
    pub fn new<P>(entry: &CrateEntry, crates_dir: P, sources_dir: P) -> Result<Self, Error>
    where
        P: AsRef<Path>,
    {
        let extracted_path = sources_dir.as_ref().join(entry.full_name()).clone();

        if extracted_path.exists() {
            return Ok(Self {
                extracted_path,
                no_delete: true,
            });
        }

        let src_crate_file = entry.locate(crates_dir.as_ref())?;

        log::trace!(
            "Attempting extraction: {} -> {}",
            src_crate_file.display(),
            extracted_path.display()
        );

        let tar_gz = std::fs::File::open(&src_crate_file)?;
        let tar = flate2::read::GzDecoder::new(tar_gz);
        let mut archive = tar::Archive::new(tar);
        if let Err(e) = archive.unpack(sources_dir.as_ref()) {
            // Do not leave a half-unpacked tree behind: a later open would adopt it as a
            // pre-existing extraction.
            let _ = std::fs::remove_dir_all(&extracted_path);
            return Err(e.into());
        }

        if !extracted_path.exists() {
            return Err(Error::ExtractionFailed);
        }

        Ok(Self {
            extracted_path,
            no_delete: false,
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.extracted_path
    }
}
impl Drop for CrateCache {
    fn drop(&mut self) {
        log::trace!("dropping {self:?}");
        if !self.no_delete {
            std::fs::remove_dir_all(&self.extracted_path).unwrap();
        }
    }
}

pub struct CrateFsConfig {
    pub crates_path: PathBuf,
    pub extract_path: PathBuf,
}
impl CrateFsConfig {
    /// Configure the `.crate` store and extraction directory.
    ///
    /// # Panics
    /// Panics if either directory does not exist.
    pub fn with_paths<P1, P2>(crates_path: P1, extract_path: P2) -> Self
    where
        P1: Into<PathBuf>,
        P2: Into<PathBuf>,
    {
        let crates_path = crates_path.into();
        let extract_path = extract_path.into();

        // assert paths exist
        assert!(crates_path.exists());
        assert!(extract_path.exists());

        Self {
            crates_path,
            extract_path,
        }
    }
}

pub struct CrateFs {
    cache: Box<CircularBuffer<1024, (CrateEntry, CrateCache)>>,
    config: CrateFsConfig,
}
impl CrateFs {
    /// Create an empty cache over the configured crate and extraction directories.
    ///
    /// # Errors
    /// Currently infallible; returns `Result` so callers do not change when validation is added.
    pub fn new(config: CrateFsConfig) -> Result<Self, Error> {
        Ok(Self {
            cache: CircularBuffer::boxed(),
            config,
        })
    }

    fn find_cache_index(&self, entry: &CrateEntry) -> Option<usize> {
        self.cache.iter().enumerate().find_map(
            |(i, (e, _))| {
                if *e == *entry { Some(i) } else { None }
            },
        )
    }
    /// Evict `fullname` from the cache, deleting its extraction unless it pre-existed.
    ///
    /// # Errors
    /// Returns `Error::CrateNameError` if `fullname` does not split, or `Error::CrateNotFound`
    /// if it is not cached.
    pub fn close<S: AsRef<str>>(&mut self, fullname: S) -> Result<(), Error> {
        let entry = CrateEntry::new(fullname.as_ref())?;

        self.cache
            .remove(self.find_cache_index(&entry).ok_or(Error::CrateNotFound)?);

        Ok(())
    }

    /// Evict `entry` from the cache if present and delete its extraction from the sources
    /// directory, even one that existed before this `CrateFs` opened it (e.g. left behind by an
    /// interrupted run).
    ///
    /// # Errors
    /// Returns `Error::IoError` if the extraction exists but cannot be removed.
    pub fn purge(&mut self, entry: &CrateEntry) -> Result<(), Error> {
        if let Some(index) = self.find_cache_index(entry) {
            // Dropping the cache entry deletes extractions it created itself.
            self.cache.remove(index);
        }
        let path = self.config.extract_path.join(entry.full_name());
        if path.exists() {
            std::fs::remove_dir_all(&path)?;
        }
        Ok(())
    }

    /// Open (extracting if needed) the crate named `<name>-<version>`.
    ///
    /// # Errors
    /// Returns `Error::CrateNameError` if `fullname` does not split, otherwise as
    /// [`CrateFs::open_entry`].
    pub fn open<S: AsRef<str>>(&mut self, fullname: S) -> Result<&CrateCache, Error> {
        let entry = CrateEntry::new(fullname.as_ref())?;
        self.open_entry(entry)
    }

    /// Open (extracting if needed) the crate described by `entry`.
    ///
    /// # Errors
    /// Returns `Error::CrateFileNotFound` if the `.crate` file is missing, or an extraction
    /// error.
    pub fn open_entry(&mut self, entry: CrateEntry) -> Result<&CrateCache, Error> {
        if let Some(index) = self.find_cache_index(&entry) {
            Ok(&self.cache.get(index).ok_or(Error::CrateNotFound)?.1)
        } else {
            // Check we have capcity, otherwise purge the front entry

            let cache_entry =
                CrateCache::new(&entry, &self.config.crates_path, &self.config.extract_path)?;

            self.cache.push_back((entry, cache_entry));
            Ok(&self.cache.back().ok_or(Error::CrateNotFound)?.1)
        }
    }

    #[must_use]
    pub fn config(&self) -> &CrateFsConfig {
        &self.config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_plain_and_prerelease_names() {
        assert_eq!(split_full_name("serde-1.0.0"), Some(("serde", "1.0.0")));
        assert_eq!(
            split_full_name("serde-1.0.172-alpha.0"),
            Some(("serde", "1.0.172-alpha.0"))
        );
        assert_eq!(
            split_full_name("serde-0.9.0-rc4"),
            Some(("serde", "0.9.0-rc4"))
        );
        assert_eq!(split_full_name("foo-2d-1.0.0"), Some(("foo-2d", "1.0.0")));
        assert_eq!(split_full_name("nodash"), None);
        assert_eq!(split_full_name("-1.0.0"), None);
    }

    /// Write a gzipped tarball `<name>-<version>.crate` containing `<name>-<version>/<files>`
    /// at `dest`.
    fn write_crate_tarball(dest: &Path, entry: &CrateEntry, files: &[(&str, &str)]) {
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        let gz = flate2::write::GzEncoder::new(
            std::fs::File::create(dest).unwrap(),
            flate2::Compression::fast(),
        );
        let mut tar = tar::Builder::new(gz);
        for (name, body) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(
                &mut header,
                format!("{}/{name}", entry.full_name()),
                body.as_bytes(),
            )
            .unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn crate_entry_accessors() {
        let e = CrateEntry::new("foo-bar-1.2.3-beta.1").unwrap();
        assert_eq!(e.name(), "foo-bar");
        assert_eq!(e.version(), "1.2.3-beta.1");
        assert_eq!(e.full_name(), "foo-bar-1.2.3-beta.1");
        assert_eq!(e.filename(), "foo-bar-1.2.3-beta.1.crate");
        assert_eq!(e, CrateEntry::from_parts("foo-bar", "1.2.3-beta.1"));
        assert_eq!(CrateEntry::from("foo-bar-1.2.3-beta.1"), e);
        assert!(matches!(
            CrateEntry::new("noversion"),
            Err(Error::CrateNameError(_))
        ));
    }

    #[test]
    fn locate_tries_every_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let e = CrateEntry::from_parts("serde", "1.0.0");
        assert!(matches!(
            e.locate(tmp.path()),
            Err(Error::CrateFileNotFound)
        ));

        // Flat layout.
        let flat = tmp.path().join("serde-1.0.0.crate");
        std::fs::write(&flat, b"").unwrap();
        assert_eq!(e.locate(tmp.path()).unwrap(), flat);

        // Shard-only layout wins over flat.
        let shard = tmp.path().join("se/rd/serde-1.0.0.crate");
        std::fs::create_dir_all(shard.parent().unwrap()).unwrap();
        std::fs::write(&shard, b"").unwrap();
        assert_eq!(e.locate(tmp.path()).unwrap(), shard);

        // Name directory wins over both.
        let named = tmp.path().join("se/rd/serde/serde-1.0.0.crate");
        std::fs::create_dir_all(named.parent().unwrap()).unwrap();
        std::fs::write(&named, b"").unwrap();
        assert_eq!(e.locate(tmp.path()).unwrap(), named);

        // Mixed-case names shard by their lowercase form.
        let upper = CrateEntry::from_parts("Serde", "1.0.0");
        assert_eq!(
            upper.candidate_paths(tmp.path())[0],
            tmp.path().join("se/rd/serde/Serde-1.0.0.crate")
        );
    }

    #[test]
    fn crate_fs_extracts_caches_and_evicts() {
        let tmp = tempfile::tempdir().unwrap();
        let crates = tmp.path().join("crates");
        let sources = tmp.path().join("sources");
        std::fs::create_dir_all(&crates).unwrap();
        std::fs::create_dir_all(&sources).unwrap();

        let entry = CrateEntry::from_parts("demo", "0.1.0");
        write_crate_tarball(
            &entry.candidate_paths(&crates)[0],
            &entry,
            &[
                ("Cargo.toml", "[package]\nname = \"demo\"\n"),
                ("src/lib.rs", ""),
            ],
        );

        let mut fs = CrateFs::new(CrateFsConfig::with_paths(&crates, &sources)).unwrap();
        let extracted = fs.open("demo-0.1.0").unwrap().path().to_path_buf();
        assert_eq!(extracted, sources.join("demo-0.1.0"));
        assert_eq!(
            std::fs::read_to_string(extracted.join("Cargo.toml")).unwrap(),
            "[package]\nname = \"demo\"\n"
        );
        assert!(extracted.join("src/lib.rs").is_file());

        // Second open hits the cache (same path, no re-extraction needed).
        assert_eq!(fs.open_entry(entry.clone()).unwrap().path(), extracted);

        // Closing evicts and deletes the extraction we created.
        fs.close("demo-0.1.0").unwrap();
        assert!(!extracted.exists());
        assert!(matches!(fs.close("demo-0.1.0"), Err(Error::CrateNotFound)));

        // Missing archive.
        assert!(matches!(
            fs.open("absent-1.0.0"),
            Err(Error::CrateFileNotFound)
        ));
    }

    #[test]
    fn crate_cache_keeps_preexisting_extractions() {
        let tmp = tempfile::tempdir().unwrap();
        let crates = tmp.path().join("crates");
        let sources = tmp.path().join("sources");
        std::fs::create_dir_all(&crates).unwrap();
        let pre = sources.join("demo-0.1.0");
        std::fs::create_dir_all(&pre).unwrap();

        let entry = CrateEntry::from_parts("demo", "0.1.0");
        {
            let cache = CrateCache::new(&entry, &crates, &sources).unwrap();
            assert_eq!(cache.path(), pre);
        }
        assert!(pre.exists(), "pre-existing extraction must survive drop");
    }

    #[test]
    fn purge_deletes_cached_and_preexisting_extractions() {
        let tmp = tempfile::tempdir().unwrap();
        let crates = tmp.path().join("crates");
        let sources = tmp.path().join("sources");
        std::fs::create_dir_all(&crates).unwrap();
        std::fs::create_dir_all(&sources).unwrap();

        let fresh = CrateEntry::from_parts("demo", "0.1.0");
        write_crate_tarball(
            &fresh.candidate_paths(&crates)[2],
            &fresh,
            &[("Cargo.toml", "")],
        );
        let stale = CrateEntry::from_parts("stale", "1.0.0");
        std::fs::create_dir_all(sources.join(stale.full_name()).join("src")).unwrap();

        let mut fs = CrateFs::new(CrateFsConfig::with_paths(&crates, &sources)).unwrap();
        let extracted = fs.open_entry(fresh.clone()).unwrap().path().to_path_buf();
        let adopted = fs.open_entry(stale.clone()).unwrap().path().to_path_buf();

        fs.purge(&fresh).unwrap();
        fs.purge(&stale).unwrap();
        assert!(!extracted.exists());
        assert!(
            !adopted.exists(),
            "pre-existing extraction must be purged too"
        );
        assert!(matches!(fs.close("demo-0.1.0"), Err(Error::CrateNotFound)));

        // Purging something that was never opened or extracted is a no-op.
        fs.purge(&CrateEntry::from_parts("absent", "1.0.0"))
            .unwrap();
    }

    #[test]
    fn crate_cache_removes_partial_extractions() {
        let tmp = tempfile::tempdir().unwrap();
        let crates = tmp.path().join("crates");
        let sources = tmp.path().join("sources");
        std::fs::create_dir_all(&sources).unwrap();

        // A truncated archive: the first file unpacks, then the gzip stream ends.
        let entry = CrateEntry::from_parts("demo", "0.1.0");
        let path = entry.candidate_paths(&crates)[2].clone();
        let big = "x".repeat(1 << 20);
        write_crate_tarball(&path, &entry, &[("a.txt", "a"), ("b.txt", &big)]);
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();

        assert!(CrateCache::new(&entry, &crates, &sources).is_err());
        assert!(!sources.join("demo-0.1.0").exists());
    }

    #[test]
    fn crate_cache_rejects_archives_with_the_wrong_top_level_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let crates = tmp.path().join("crates");
        let sources = tmp.path().join("sources");
        std::fs::create_dir_all(&sources).unwrap();

        let entry = CrateEntry::from_parts("demo", "0.1.0");
        // Archive is named for demo-0.1.0 but unpacks to other-9.9.9/.
        write_crate_tarball(
            &entry.candidate_paths(&crates)[2],
            &CrateEntry::from_parts("other", "9.9.9"),
            &[("Cargo.toml", "")],
        );
        assert!(matches!(
            CrateCache::new(&entry, &crates, &sources),
            Err(Error::ExtractionFailed)
        ));
    }

    #[test]
    fn candidate_paths_follow_index_sharding() {
        let root = Path::new("/r");
        let first = |n: &str| CrateEntry::from_parts(n, "1.0.0").candidate_paths(root)[0].clone();
        assert_eq!(first("s"), root.join("1/s/s-1.0.0.crate"));
        assert_eq!(first("ab"), root.join("2/ab/ab-1.0.0.crate"));
        assert_eq!(first("abc"), root.join("3/a/abc/abc-1.0.0.crate"));
        assert_eq!(first("serde"), root.join("se/rd/serde/serde-1.0.0.crate"));
    }
}
