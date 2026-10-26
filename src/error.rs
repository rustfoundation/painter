use crate::{check, compile, crate_fs, db, index, metadata, migrate, rules};

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("IO Error: {0}")]
    IoError(#[from] std::io::Error),
    #[error(
        "Crate name contained invalid characters or did not match the NAME-VER format. Name: {0}"
    )]
    CrateNameError(String),
    #[error("LLVM IR failure: {0}")]
    LLVMError(String),
    #[error("Database Error: {0}")]
    DbError(#[from] db::Error),
    #[error("Indexing Error: {0}")]
    IndexError(#[from] index::Error),
    #[error("Crate FS Error: {0}")]
    CrateFsError(#[from] crate_fs::Error),
    #[error("Compile Error: {0}")]
    CompileError(#[from] compile::Error),
    #[error("Build rules error: {0}")]
    RulesError(#[from] rules::Error),
    #[error("Compile check error: {0}")]
    CheckError(#[from] check::Error),
    #[error("Migration export error: {0}")]
    MigrateError(#[from] migrate::Error),
    #[error("Metadata error: {0}")]
    MetadataError(#[from] metadata::Error),
    #[error(
        "no Neo4j password: pass -p, --password-file, $NEO4J_PASSWORD, or $NEO4J_PASSWORD_FILE"
    )]
    MissingPassword,
    #[error("MissingBytecodesPath")]
    MissingBytecodesPath,
    #[error("MissingCompressedPath")]
    MissingCompressedPath,
    #[error("MissingExtractedSourcesPath")]
    MissingExtractedSourcesPath,
}
