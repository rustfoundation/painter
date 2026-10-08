use crate::{compile, crate_fs, db, index, rules};

/// Top error type returned during any stage of analysis from compile to data import.
#[derive(thiserror::Error, Debug)]
pub enum Error {
    ///
    #[error("IO Error: {0}")]
    IoError(#[from] std::io::Error),
    #[error(
        "Crate name contained invalid characters or did not match the NAME-VER format. Name: {0}"
    )]
    ///
    CrateNameError(String),
    ///
    #[error("LLVM IR failure: {0}")]
    LLVMError(String),
    ///
    #[error("Database Error: {0}")]
    DbError(#[from] db::Error),
    ///
    #[error("Indexing Error: {0}")]
    IndexError(#[from] index::Error),
    ///
    #[error("Crate FS Error: {0}")]
    CrateFsError(#[from] crate_fs::Error),
    ///
    #[error("Compile Error: {0}")]
    CompileError(#[from] compile::Error),
    ///
    #[error("Build rules error: {0}")]
    RulesError(#[from] rules::Error),
    ///
    #[error("MissingBytecodesPath")]
    MissingBytecodesPath,
    ///
    #[error("MissingCompressedPath")]
    MissingCompressedPath,
    ///
    #[error("MissingExtractedSourcesPath")]
    MissingExtractedSourcesPath,
}
