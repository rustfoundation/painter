use crate::{check, compile, crate_fs, db, index, migrate, rules};

/// Top error type returned during any stage of analysis from compile to data import.
#[derive(thiserror::Error, Debug)]
pub enum Error {
    /// Filesystem failure.
    #[error("IO Error: {0}")]
    IoError(#[from] std::io::Error),
    /// A `<name>-<version>` string could not be split.
    #[error(
        "Crate name contained invalid characters or did not match the NAME-VER format. Name: {0}"
    )]
    CrateNameError(String),
    /// Bitcode could not be parsed.
    #[error("LLVM IR failure: {0}")]
    LLVMError(String),
    /// Neo4j failure.
    #[error("Database Error: {0}")]
    DbError(#[from] db::Error),
    /// crates.io index failure.
    #[error("Indexing Error: {0}")]
    IndexError(#[from] index::Error),
    /// Crate extraction or lookup failure.
    #[error("Crate FS Error: {0}")]
    CrateFsError(#[from] crate_fs::Error),
    /// Compilation stage failure.
    #[error("Compile Error: {0}")]
    CompileError(#[from] compile::Error),
    /// Build-rule resolution failure.
    #[error("Build rules error: {0}")]
    RulesError(#[from] rules::Error),
    /// `compile-check` failure.
    #[error("Compile check error: {0}")]
    CheckError(#[from] check::Error),
    /// `export-for-import` failure.
    #[error("Migration export error: {0}")]
    MigrateError(#[from] migrate::Error),
    /// `-b` was required but not given.
    #[error("MissingBytecodesPath")]
    MissingBytecodesPath,
    /// `-c` was required but not given.
    #[error("MissingCompressedPath")]
    MissingCompressedPath,
    /// `-s` was required but not given.
    #[error("MissingExtractedSourcesPath")]
    MissingExtractedSourcesPath,
}
