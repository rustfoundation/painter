//! Counts must match the old `count-unsafe` tool (same file selection; verified on 72 crates).
use super::source::SourceTree;
use cargo_geiger_serde::CounterBlock;
use geiger::IncludeTests;
use std::collections::HashMap;
use std::path::Path;

/// Done-marker (`Version.unsafe_scanner`); a newer geiger may count differently, so bump to rescan.
pub const SCANNER: &str = "geiger 0.5.0";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnsafeMetrics {
    pub counters: CounterBlock,
    pub rs_files: u64,
    pub rs_files_failed: u64,
    pub rs_lines: u64,
    pub rs_bytes: u64,
    pub rs_forbid_files: u64,
    /// `None` when no root file was parsed.
    pub forbids_unsafe: Option<bool>,
}

impl UnsafeMetrics {
    #[must_use]
    pub fn total_unsafe(&self) -> u64 {
        let c = &self.counters;
        c.functions.unsafe_
            + c.exprs.unsafe_
            + c.item_impls.unsafe_
            + c.item_traits.unsafe_
            + c.methods.unsafe_
    }
}

/// # Errors
/// Returns the `syn` error if the source does not parse.
pub fn scan_source(src: &str) -> Result<geiger::RsFileMetrics, syn::Error> {
    geiger::find_unsafe_in_string(src, IncludeTests::Yes)
}

#[must_use]
pub fn scan(tree: &SourceTree) -> UnsafeMetrics {
    let mut metrics = UnsafeMetrics::default();
    let mut forbids: HashMap<&str, bool> = HashMap::new();
    for file in &tree.files {
        // count-unsafe parity: case-sensitive extension match.
        if Path::new(&file.path).extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let Some(src) = file.text() else {
            metrics.rs_files_failed += 1;
            continue;
        };
        match scan_source(src) {
            Ok(result) => {
                metrics.counters += result.counters;
                metrics.rs_files += 1;
                metrics.rs_lines += src.lines().count() as u64;
                metrics.rs_bytes += src.len() as u64;
                if result.forbids_unsafe {
                    metrics.rs_forbid_files += 1;
                }
                forbids.insert(&file.path, result.forbids_unsafe);
            }
            Err(_) => metrics.rs_files_failed += 1,
        }
    }
    let lib_root = tree.manifest.lib_path.as_deref().unwrap_or("src/lib.rs");
    metrics.forbids_unsafe = forbids
        .get(lib_root)
        .or_else(|| forbids.get("src/main.rs"))
        .copied();
    metrics
}

#[cfg(test)]
mod tests {
    use super::super::source::test_support::tree;
    use super::*;

    const LIB: &str = "#![forbid(unsafe_code)]\npub fn add(a: u32, b: u32) -> u32 { a + b }\n\
                       pub struct S;\nimpl S { pub fn m(&self) -> u32 { add(1, 2) } }\n";
    const UNSAFE: &str = "pub unsafe fn raw(p: *const u8) -> u8 { *p }\n\
                          pub fn call() -> u8 { unsafe { raw(std::ptr::null()) } }\n\
                          pub struct T;\nunsafe impl Send for T {}\n";

    #[test]
    fn scan_sums_geiger_over_rs_files_and_counts_failures() {
        let files: &[(&str, &[u8])] = &[
            ("build.rs", b"fn main() {}\n"),
            ("src/lib.rs", LIB.as_bytes()),
            ("src/other.rs", UNSAFE.as_bytes()),
            ("src/bad.rs", b"fn (\n"),
            ("src/binary.rs", b"fn f() {}\n\xff\xfe"),
            ("src/UPPER.RS", b"fn not_counted() {}\n"),
            ("README.md", b"unsafe { not rust }"),
        ];
        let m = scan(&tree(files));
        let expected = scan_source("fn main() {}\n").unwrap().counters
            + scan_source(LIB).unwrap().counters
            + scan_source(UNSAFE).unwrap().counters;
        assert_eq!(m.counters, expected);
        assert_eq!(m.rs_files, 3, "build.rs, lib.rs, other.rs");
        assert_eq!(m.rs_files_failed, 2, "bad.rs, binary.rs");
        assert_eq!(
            m.rs_lines,
            1 + LIB.lines().count() as u64 + UNSAFE.lines().count() as u64
        );
        assert_eq!(m.rs_bytes, (13 + LIB.len() + UNSAFE.len()) as u64);
        assert_eq!(m.rs_forbid_files, 1);
        assert_eq!(m.forbids_unsafe, Some(true), "src/lib.rs is the root");
        assert_eq!(m.counters.functions.unsafe_, 1);
        assert_eq!(m.counters.item_impls.unsafe_, 1);
        assert!(m.total_unsafe() > 0);
    }

    #[test]
    fn forbid_follows_lib_path_then_main() {
        let files: &[(&str, &[u8])] = &[
            (
                "Cargo.toml",
                b"[package]\nname = \"demo\"\n[lib]\npath = \"src/root.rs\"\n",
            ),
            ("src/root.rs", b"pub fn f() {}\n"),
            ("src/lib.rs", LIB.as_bytes()),
        ];
        assert_eq!(scan(&tree(files)).forbids_unsafe, Some(false));
        let files: &[(&str, &[u8])] =
            &[("src/main.rs", b"#![forbid(unsafe_code)]\nfn main() {}\n")];
        assert_eq!(scan(&tree(files)).forbids_unsafe, Some(true));
        let files: &[(&str, &[u8])] = &[("tests/t.rs", b"fn t() {}\n")];
        assert_eq!(scan(&tree(files)).forbids_unsafe, None);
    }
}
