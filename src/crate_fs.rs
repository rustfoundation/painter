#![allow(clippy::module_name_repetitions)]
use circular_buffer::CircularBuffer;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

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
    pub full_name: String,
}
impl CrateEntry {
    pub fn new(full_name: String) -> Result<Self, Error> {
        let (_, _) = full_name
            .rsplit_once('-')
            .ok_or(Error::CrateNameError(full_name.clone()))?;

        // TODO: Semver check valid here

        Ok(Self { full_name })
    }
    pub fn full_name(&self) -> &str {
        &self.full_name
    }

    pub fn name(&self) -> &str {
        self.full_name.rsplit_once('-').unwrap().0
    }

    pub fn version(&self) -> &str {
        self.full_name.rsplit_once('-').unwrap().1
    }

    pub fn filename(&self) -> String {
        format!("{}.crate", self.full_name())
    }
}
impl<S> From<S> for CrateEntry
where
    S: AsRef<str>,
{
    fn from(rhv: S) -> CrateEntry {
        Self::new(rhv.as_ref().to_string()).unwrap()
    }
}

#[derive(Debug)]
pub struct CrateCache {
    src_crate_file: PathBuf,
    extracted_path: PathBuf,
    no_delete: bool,
}
impl CrateCache {
    pub fn new<P>(entry: &CrateEntry, crates_dir: P, sources_dir: P) -> Result<Self, Error>
    where
        P: AsRef<Path>,
    {
        let src_crate_file = crates_dir.as_ref().join(entry.filename());
        let extracted_path = sources_dir.as_ref().join(entry.full_name()).clone();

        if extracted_path.exists() {
            return Ok(Self {
                src_crate_file,
                extracted_path,
                no_delete: true,
            });
        }

        log::trace!(
            "Attempting extraction: {} -> {}",
            src_crate_file.display(),
            extracted_path.display()
        );

        let tar_gz = std::fs::File::open(&src_crate_file)?;
        let tar = flate2::read::GzDecoder::new(tar_gz);
        let mut archive = tar::Archive::new(tar);
        archive.unpack(sources_dir.as_ref())?;

        if !extracted_path.exists() {
            return Err(Error::ExtractionFailed);
        }

        Ok(Self {
            src_crate_file,
            extracted_path,
            no_delete: false,
        })
    }

    pub fn path(&self) -> &Path {
        &self.extracted_path
    }
}
impl Drop for CrateCache {
    fn drop(&mut self) {
        log::trace!("dropping {:?}", self);
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
    index: crates_index::Index,
    config: CrateFsConfig,
}
impl CrateFs {
    pub fn new(config: CrateFsConfig) -> Result<Self, Error> {
        let index = crates_index::Index::new_cargo_default()?;

        Ok(Self {
            cache: CircularBuffer::boxed(),
            config,
            index,
        })
    }

    fn find_cache_index(&self, entry: &CrateEntry) -> Option<usize> {
        self.cache.iter().enumerate().find_map(
            |(i, (e, _))| {
                if *e == *entry {
                    Some(i)
                } else {
                    None
                }
            },
        )
    }
    pub fn close<S: AsRef<str>>(&mut self, fullname: S) -> Result<(), Error> {
        let entry = CrateEntry::new(fullname.as_ref().to_string())?;

        self.cache
            .remove(self.find_cache_index(&entry).ok_or(Error::CrateNotFound)?);

        Ok(())
    }

    pub fn open<S: AsRef<str>>(&mut self, fullname: S) -> Result<&CrateCache, Error> {
        let entry = CrateEntry::new(fullname.as_ref().to_string())?;

        if let Some(index) = self.find_cache_index(&entry) {
            Ok(&self.cache.get(index).ok_or(Error::CrateNotFound)?.1)
        } else {
            // Check that we have the crate file
            let cratefile_path = self
                .config
                .crates_path
                .join(format!("{}.crate", entry.full_name()));
            if !cratefile_path.exists() {
                return Err(Error::CrateFileNotFound);
            }

            // Check we have capcity, otherwise purge the front entry

            let cache_entry =
                CrateCache::new(&entry, &self.config.crates_path, &self.config.extract_path)?;

            self.cache.push_back((entry, cache_entry));
            Ok(&self.cache.back().ok_or(Error::CrateNotFound)?.1)
        }
    }

    pub fn config(&self) -> &CrateFsConfig {
        &self.config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_logging() {
        // capture log messages with test harness
        let _ = env_logger::builder().is_test(true).try_init();
    }
}
