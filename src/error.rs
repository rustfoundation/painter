use crate::{check, compile, crate_fs, db, index, metadata, migrate, rules};

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
    /// `generate-metadata` failure.
    #[error("Metadata error: {0}")]
    MetadataError(#[from] metadata::Error),
    /// A database command got neither `-p` nor `--password-file` (nor their env vars).
    #[error(
        "no Neo4j password: pass -p, --password-file, $NEO4J_PASSWORD, or $NEO4J_PASSWORD_FILE"
    )]
    MissingPassword,
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
