use crates_index::Index;
use std::{collections::HashSet, path::Path};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DependsError {
    #[error("{0}")]
    IoError(#[from] std::io::Error),
    #[error("{0}")]
    IndexError(#[from] crates_index::error::Error),
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct CrateInfo {
    name: String,
    version: String,
}

pub fn to_cypher(index: &Index) -> Result<(), DependsError> {
    let all: Vec<_> = index.crates().collect();

    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn all() -> Result<(), DependsError> {
        let index = crates_index::Index::new_cargo_default()?;
        to_cypher(&index)?;

        Ok(())
    }
}
