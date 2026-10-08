use crate::{db::Db, Error, Roots};
use llvm_ir_analysis::{llvm_ir::Module, ModuleAnalysis};
use rayon::prelude::*;
use rustc_demangle::demangle;

use crates_index::Crate;
use std::{io::Write, path::Path, sync::Arc};

/// Callee crates that are never recorded as invocations: the standard library family and
/// compiler/runtime intrinsics.
const BLOCKED_CRATES: &[&str] = &["core", "std", "alloc"];

/// Determine the crate a demangled Rust symbol belongs to: the first identifier that is
/// immediately followed by `::`. Handles trait-impl paths such as
/// `<serde::de::X as core::fmt::Display>::fmt` (gives `serde`) and
/// `<&T as serde::Serialize>::serialize` (gives `serde`). Returns `None` for symbols without a
/// path (e.g. `__rust_alloc`, `llvm.memcpy.p0.i64`).
#[must_use]
pub fn crate_of(demangled: &str) -> Option<&str> {
    let bytes = demangled.as_bytes();
    let mut start = None;
    for (i, &b) in bytes.iter().enumerate() {
        let is_ident = b.is_ascii_alphanumeric() || b == b'_';
        match (start, is_ident) {
            (None, true) => start = Some(i),
            (Some(st), false) => {
                if bytes[i..].starts_with(b"::") {
                    return Some(&demangled[st..i]);
                }
                start = None;
            }
            _ => {}
        }
    }
    None
}

/// Whether a demangled callee should be recorded as a cross-crate invocation.
#[must_use]
pub fn callee_crate(demangled: &str) -> Option<&str> {
    if demangled.starts_with("llvm.") || demangled.starts_with("__rust") {
        return None;
    }
    let c = crate_of(demangled)?;
    if BLOCKED_CRATES.contains(&c) {
        None
    } else {
        Some(c)
    }
}

/// Extract all function calls/invocations within a bytecode file. Returns a `Vec<(String,String)>`
/// of (caller, callee) demangled function names.
///
/// # Panics
/// This function will panic if iterating the `Roots::bytecode_root` fails.
///
/// This function will panic if an LLVM parsing error occurs while parsing the bytecode.
/// # Errors
/// TODO: Failure cases currently panic and should be moved to errors.
#[allow(clippy::unnecessary_wraps)]
pub fn extract_calls<P: AsRef<Path>>(crate_bc_dir: P) -> Result<Vec<(String, String)>, Error> {
    let mut calls = Vec::<(String, String)>::new();

    for bc_entry in std::fs::read_dir(crate_bc_dir.as_ref())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some() && e.path().extension().unwrap() == "bc")
    {
        let bc_path = bc_entry.path();

        let module = Module::from_bc_path(&bc_path)
            .map_err(Error::LLVMError)
            .unwrap();
        let analysis = ModuleAnalysis::new(&module);

        let graph = analysis.call_graph();
        graph.inner().all_edges().for_each(|(src_raw, dst_raw, _)| {
            let src = format!("{:#}", demangle(src_raw));
            let dst = format!("{:#}", demangle(dst_raw));

            if callee_crate(&dst).is_some() {
                calls.push((src, dst));
            }
        });
    }

    Ok(calls)
}

/// Extracts all calls within a  single crates bytecode. Then, perform database insertions of each
/// call into the database.
///
/// # Panics
/// This function panics if extracting the filename of a crates full name from its path fails.
///
/// # Errors
/// Returns `painter::analysis::Error` on failure of database insertion.
#[allow(clippy::needless_pass_by_value)]
pub async fn export_crate_db<P: AsRef<Path>>(crate_bc_dir: P, db: Arc<Db>) -> Result<(), Error> {
    let calls = extract_calls(&crate_bc_dir)?;
    let crate_fullname = crate_bc_dir.as_ref().file_name().unwrap().to_str().unwrap();

    let (crate_name, crate_version) = crate::crate_fs::split_full_name(crate_fullname)
        .ok_or_else(|| Error::CrateNameError(crate_fullname.to_string()))?;

    // If this crate/version has an invoke, assume its completed and bail
    if db.has_any_invoke(crate_name, crate_version).await? {
        log::trace!("{}-{} Exists, skipping..", crate_name, crate_version);
        return Ok(());
    }

    log::trace!("Importing: {}", crate_name);

    // `extract_calls` only keeps callees with a recordable crate.
    let rows: Vec<(String, String, String)> = calls
        .into_iter()
        .filter_map(|(caller, callee)| {
            let dst = callee_crate(&callee)?.to_string();
            Some((caller, callee, dst))
        })
        .collect();

    db.insert_invokes((crate_name, crate_version), &rows).await?;
    log::info!("{}: imported {} invocations", crate_fullname, rows.len());

    Ok(())
}

/// Iterate across all crates in the bytecode root, and call `export_crate_db`
///
/// # Panics
/// This function panics if there are permissions issues reading the bytecode root directory.
/// # Errors
/// Returns `painter::analysis::Error` on failure.
pub async fn export_all_db<P: AsRef<Path>>(bc_root: P, db: Arc<Db>) -> Result<(), Error> {
    let dirs: Vec<_> = std::fs::read_dir(&bc_root)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .collect();

    let mut failures = 0usize;
    for chunk in crate::chunked(dirs.iter(), 16) {
        let tasks: Vec<_> = chunk
            .iter()
            .map(|c| export_crate_db(c.path(), db.clone()))
            .collect();

        for (dir, result) in chunk.iter().zip(futures::future::join_all(tasks).await) {
            if let Err(e) = result {
                failures += 1;
                log::error!("{}: export failed: {}", dir.path().display(), e);
            }
        }
    }

    if failures > 0 {
        log::error!("{failures} crate version(s) failed to export");
    }

    Ok(())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CountUnsafeEntry {
    pub safe: u32,
    pub unsafe_: u32,
}
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CountUnsafeResult {
    pub functions: CountUnsafeEntry,
    pub exprs: CountUnsafeEntry,
    pub item_impls: CountUnsafeEntry,
    pub item_traits: CountUnsafeEntry,
    pub methods: CountUnsafeEntry,
}
impl CountUnsafeResult {
    #[must_use]
    pub fn has_unsafe(&self) -> bool {
        self.functions.unsafe_ > 0
            || self.exprs.unsafe_ > 0
            || self.item_impls.unsafe_ > 0
            || self.item_traits.unsafe_ > 0
            || self.methods.unsafe_ > 0
    }

    #[must_use]
    pub fn total_unsafe(&self) -> u32 {
        self.functions.unsafe_
            + self.exprs.unsafe_
            + self.item_impls.unsafe_
            + self.item_traits.unsafe_
            + self.methods.unsafe_
    }
}

pub async fn count_unsafe_crate_extract(
    c: Crate,
    roots: Roots,
    db: Arc<Db>,
) -> Result<(), Error> {
    let compressed_root = &roots.compressed_root;
    let sources_root = &roots.sources_root;

    for v in c.versions() {
        let crate_fullname = format!("{}-{}", v.name(), v.version());
        let crate_path = compressed_root.join(format!("{}.crate", &crate_fullname));

        // Lets work off the tgz for now, since we cant extract
        // TODO: this needs to be unified to a file driver
        if std::fs::metadata(&crate_path).is_ok() {
            let extracted_path = sources_root.join(&crate_fullname);
            let tar_gz = std::fs::File::open(&crate_path).unwrap();
            let tar = flate2::read::GzDecoder::new(tar_gz);
            let mut archive = tar::Archive::new(tar);
            if archive.unpack(sources_root).is_ok() {
                log::trace!("Extracted {}", &crate_fullname);

                // Run our count
                let output = std::process::Command::new("count-unsafe")
                    .args([&extracted_path])
                    .output()
                    .unwrap();
                if output.status.success() {
                    let raw_json = std::str::from_utf8(&output.stdout).unwrap();
                    log::trace!("{}", &raw_json);

                    let unsafe_result: CountUnsafeResult = serde_json::from_str(raw_json).unwrap();
                    if unsafe_result.has_unsafe() {
                        log::debug!("{} unsafe", &crate_fullname);
                        if let Err(e) = db.set_unsafe(v.name(), v.version(), &unsafe_result).await {
                            log::error!("set_unsafe failed for {}: {}", &crate_fullname, e);
                        }
                    }

                    // Finally delete
                    //std::fs::remove_dir_all(extracted_path).unwrap();
                    log::trace!("Deleted {}", &crate_fullname);
                }
            }
        }
    }
    Ok(())
}
pub async fn count_unsafe_crate(c: Crate, roots: Roots, db: Arc<Db>) -> Result<(), Error> {
    let sources_root = &roots.sources_root;

    for v in c.versions() {
        let crate_fullname = format!("{}-{}", v.name(), v.version());
        let crate_path = sources_root.join(format!("{}", &crate_fullname));

        // Lets work off the tgz for now, since we cant extract
        // TODO: this needs to be unified to a file driver
        if std::fs::metadata(&crate_path).is_ok() {
            // Run our count
            let output = std::process::Command::new("count-unsafe")
                .args([&crate_path])
                .output()
                .unwrap();
            if output.status.success() {
                let raw_json = std::str::from_utf8(&output.stdout).unwrap();
                log::trace!("{}", &raw_json);

                let unsafe_result: CountUnsafeResult = serde_json::from_str(raw_json).unwrap();
                if unsafe_result.has_unsafe() {
                    log::debug!("{} unsafe", &crate_fullname);
                    if let Err(e) = db.set_unsafe(v.name(), v.version(), &unsafe_result).await {
                        log::error!("set_unsafe failed for {}: {}", &crate_fullname, e);
                    }
                }
            }
        }
    }
    Ok(())
}

pub async fn count_unsafe(roots: &Roots, db: Arc<Db>) -> Result<(), Error> {
    let index = crate::index::open_index().map_err(crate::index::Error::from)?;

    let iter = crate::chunked(index.crates(), 128);
    for chunk in iter {
        let tasks: Vec<_> = chunk
            .into_iter()
            .map(|c| count_unsafe_crate(c, roots.clone(), db.clone()))
            .collect();

        futures::future::join_all(tasks).await;
    }

    Ok(())
}

#[allow(dead_code)]
fn export_crate_csv<P: AsRef<Path>>(crate_bc_dir: P) -> Result<(), Error> {
    let calls = extract_calls(&crate_bc_dir)?;
    let crate_fullname = crate_bc_dir.as_ref().file_name().unwrap().to_str().unwrap();

    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(crate_bc_dir.as_ref().join("calls.csv"))
            .unwrap();

        calls.iter().enumerate().for_each(|(_, (src, dst))| {
            writeln!(file, "{crate_fullname},{src},{dst}").unwrap();
        });
    }

    Ok(())
}

#[allow(dead_code)]
fn export_all_csv<P: AsRef<Path>>(bc_root: P) -> Result<(), Error> {
    let dirs: Vec<_> = std::fs::read_dir(&bc_root)?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .collect();

    dirs.par_iter().for_each(|crate_bc_dir| {
        export_crate_csv(crate_bc_dir.path()).unwrap();
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crate_of_handles_plain_and_trait_impl_paths() {
        assert_eq!(crate_of("serde::de::Deserialize::deserialize"), Some("serde"));
        assert_eq!(
            crate_of("<serde::de::WithDecimalPoint as core::fmt::Display>::fmt"),
            Some("serde")
        );
        assert_eq!(crate_of("<&T as serde::Serialize>::serialize"), Some("serde"));
        assert_eq!(crate_of("<[u8] as core::fmt::Debug>::fmt"), Some("core"));
        assert_eq!(crate_of("alloc::vec::Vec<T>::push"), Some("alloc"));
        assert_eq!(crate_of("__rust_alloc"), None);
        assert_eq!(crate_of("llvm.memcpy.p0.i64"), None);
    }

    #[test]
    fn callee_crate_blocks_std_family_and_intrinsics() {
        assert_eq!(callee_crate("core::fmt::Write::write_char"), None);
        assert_eq!(callee_crate("std::io::Write::write"), None);
        assert_eq!(callee_crate("<alloc::string::String as core::fmt::Write>::write_str"), None);
        assert_eq!(callee_crate("llvm.memset.p0.i64"), None);
        assert_eq!(callee_crate("__rust_dealloc"), None);
        assert_eq!(callee_crate("serde_json::ser::to_string"), Some("serde_json"));
        assert_eq!(callee_crate("<T as serde::Serialize>::serialize"), Some("serde"));
    }
}
