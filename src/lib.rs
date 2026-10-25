//! `libpainter`: the pipeline stages behind the `painter` CLI.
//!
//! - [`index`]: crates.io index -> Neo4j `(Crate)` / `(Version)` graph
//! - [`compile`]: mass compilation of crate sources to LLVM bitcode
//! - [`analysis`]: call-graph extraction from bitcode and export to Neo4j
//! - [`crate_fs`]: cached extraction of `.crate` tarballs
//! - [`db`]: the Neo4j connection wrapper and all Cypher
//! - [`check`]: reconcile index, bytecode root, and database (`compile-check`)
//! - [`migrate`]: rebuild a database from the old `INVOKES` schema (`export-for-import`)
#![deny(clippy::all, clippy::pedantic)]
#![allow(clippy::enum_variant_names)]

pub mod analysis;
pub mod check;
pub mod compile;
pub mod crate_fs;
pub mod db;
pub mod ecosystems;
pub mod error;
pub mod index;
pub mod migrate;
pub mod rules;

use std::path::PathBuf;

pub use error::Error;
pub use rules::BuildRules;

/// Group an iterator into `Vec`s of at most `size` items. Unlike `Iterator::array_chunks`, the
/// final partial chunk is yielded rather than dropped.
pub fn chunked<I: Iterator>(iter: I, size: usize) -> impl Iterator<Item = Vec<I::Item>> {
    let mut iter = iter.peekable();
    std::iter::from_fn(move || {
        iter.peek()?;
        Some(iter.by_ref().take(size).collect())
    })
}

/// Root directories used by the compile, export, and unsafe-counting stages.
///
/// - `sources_root`: extracted crate sources, laid out as `sources_root/<name>-<version>/`
/// - `bytecodes_root`: emitted LLVM bitcode, laid out as `bytecodes_root/<name>-<version>/`
/// - `compressed_root`: `.crate` tarballs, named `<name>-<version>.crate`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Roots {
    pub sources_root: PathBuf,
    pub bytecodes_root: Option<PathBuf>,
    pub compressed_root: PathBuf,
}

impl Roots {
    /// Build a [`crate_fs::CrateFs`] over this session's compressed and sources roots.
    ///
    /// # Panics
    /// Panics if either directory does not exist (see [`crate_fs::CrateFsConfig::with_paths`]).
    ///
    /// # Errors
    /// Returns [`Error::CrateFsError`] if the cache cannot be initialised.
    pub fn crate_fs(&self) -> Result<crate_fs::CrateFs, Error> {
        Ok(crate_fs::CrateFs::new(
            crate_fs::CrateFsConfig::with_paths(
                self.compressed_root.clone(),
                self.sources_root.clone(),
            ),
        )?)
    }

    /// The bytecode output root.
    ///
    /// # Errors
    /// Returns [`Error::MissingBytecodesPath`] if it was not provided.
    pub fn bytecodes_root(&self) -> Result<&PathBuf, Error> {
        self.bytecodes_root
            .as_ref()
            .ok_or(Error::MissingBytecodesPath)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_keeps_the_final_partial_chunk() {
        let chunks: Vec<Vec<i32>> = chunked(1..=7, 3).collect();
        assert_eq!(chunks, vec![vec![1, 2, 3], vec![4, 5, 6], vec![7]]);
    }

    #[test]
    fn chunked_handles_empty_and_exact_multiples() {
        assert_eq!(chunked(std::iter::empty::<u8>(), 4).count(), 0);
        let chunks: Vec<Vec<i32>> = chunked(1..=4, 2).collect();
        assert_eq!(chunks, vec![vec![1, 2], vec![3, 4]]);
    }

    #[test]
    fn roots_bytecodes_root_is_required() {
        let roots = Roots {
            sources_root: PathBuf::from("/s"),
            bytecodes_root: None,
            compressed_root: PathBuf::from("/c"),
        };
        assert!(matches!(
            roots.bytecodes_root(),
            Err(Error::MissingBytecodesPath)
        ));

        let roots = Roots {
            bytecodes_root: Some(PathBuf::from("/b")),
            ..roots
        };
        assert_eq!(roots.bytecodes_root().unwrap(), &PathBuf::from("/b"));
    }

    #[test]
    fn roots_crate_fs_opens_existing_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = Roots {
            sources_root: tmp.path().join("src"),
            bytecodes_root: None,
            compressed_root: tmp.path().join("crates"),
        };
        std::fs::create_dir_all(&roots.sources_root).unwrap();
        std::fs::create_dir_all(&roots.compressed_root).unwrap();
        let fs = roots.crate_fs().unwrap();
        assert_eq!(fs.config().crates_path, roots.compressed_root);
        assert_eq!(fs.config().extract_path, roots.sources_root);
    }
}
