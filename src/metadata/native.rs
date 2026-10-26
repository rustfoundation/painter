//! `native` job: does a version vendor C, C++, Objective-C, or assembly code, or ship prebuilt
//! native binaries?
//!
//! Many `-sys` crates carry a small `.c` shim or a couple of headers just to bind a system
//! library; that is not vendoring a library. So every native file is measured (non-blank lines
//! and bytes, sources and headers apart), and [`NativeInfo::vendored`] is only set when there is
//! enough of it to be a library in its own right:
//!
//! - at least [`VENDORED_SOURCE_LINES`] non-blank lines in native *source* files, or
//! - at least [`VENDORED_TOTAL_LINES`] in sources and headers together (header-only libraries),
//!   or
//! - at least [`VENDORED_DIR_LINES`] under a conventional vendoring directory (`vendor/`,
//!   `third_party/`, `deps/`, `external/`, `contrib/`, `submodules/`, ...), where even a small
//!   amount is somebody else's code.
//!
//! The raw numbers are stored too, so other thresholds can be applied in Cypher. Prebuilt
//! static or shared libraries and object files (`.a`, `.lib`, `.so`, `.dll`, `.dylib`, `.o`,
//! `.obj`) are counted separately.
use super::source::SourceTree;
use std::collections::BTreeSet;

/// Job revision, stored as `Version.meta_native` (this job's done-marker). Bump it when the
/// detection or thresholds change to recompute every version.
pub const REVISION: &str = "native 1";

/// Non-blank lines in native source files (not headers) that make a version "vendored".
pub const VENDORED_SOURCE_LINES: u64 = 1_000;
/// Non-blank lines in native sources and headers together that make it "vendored".
pub const VENDORED_TOTAL_LINES: u64 = 5_000;
/// Non-blank native lines under a vendoring directory that make it "vendored".
pub const VENDORED_DIR_LINES: u64 = 200;
/// Most top-level directories of native code listed in `native_dirs`.
const MAX_DIRS: usize = 16;

/// Directory names that conventionally hold someone else's code.
const VENDOR_DIRS: &[&str] = &[
    "vendor",
    "vendored",
    "third_party",
    "third-party",
    "thirdparty",
    "3rdparty",
    "deps",
    "external",
    "extern",
    "contrib",
    "submodules",
];

/// Language of a native file and whether it is a header.
fn classify(ext: &str) -> Option<(&'static str, bool)> {
    Some(match ext {
        "c" => ("c", false),
        "h" => ("c", true),
        "cc" | "cpp" | "cxx" | "c++" | "cu" => ("c++", false),
        "hh" | "hpp" | "hxx" | "h++" | "inl" | "ipp" | "tpp" | "cuh" => ("c++", true),
        "m" | "mm" => ("objc", false),
        "s" | "asm" => ("asm", false),
        _ => return None,
    })
}

fn is_prebuilt(ext: &str) -> bool {
    matches!(ext, "a" | "lib" | "so" | "dll" | "dylib" | "o" | "obj")
}

/// Native-code facts of one version.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeInfo {
    /// Native source files (`.c`, `.cpp`, `.cc`, `.m`, `.s`, ...).
    pub source_files: u64,
    /// Native headers (`.h`, `.hpp`, ...).
    pub header_files: u64,
    /// Non-blank lines in native source files.
    pub source_lines: u64,
    /// Non-blank lines in native sources and headers.
    pub total_lines: u64,
    /// Bytes in native sources and headers.
    pub bytes: u64,
    /// Size of the largest native file.
    pub largest_bytes: u64,
    /// Non-blank native lines under a vendoring directory (see the module docs).
    pub vendor_dir_lines: u64,
    /// Languages present: `c`, `c++`, `objc`, `asm`.
    pub langs: Vec<String>,
    /// Top-level directories holding native files (`.` for the crate root), at most 16.
    pub dirs: Vec<String>,
    /// Prebuilt native binaries (`.a`, `.so`, `.dll`, `.o`, ...).
    pub prebuilt_files: u64,
    /// Enough native code to count as a vendored library (see the module docs).
    pub vendored: bool,
}

impl NativeInfo {
    /// Any native source or header at all.
    #[must_use]
    pub fn has_native_code(&self) -> bool {
        self.source_files + self.header_files > 0
    }
}

/// Measure a version's native code.
#[must_use]
pub fn scan(tree: &SourceTree) -> NativeInfo {
    let mut info = NativeInfo::default();
    let mut langs = BTreeSet::new();
    let mut dirs = BTreeSet::new();
    for file in &tree.files {
        let Some(ext) = file.extension() else {
            continue;
        };
        if is_prebuilt(&ext) {
            info.prebuilt_files += 1;
            continue;
        }
        // `.S` (preprocessed assembly) lowercases to `.s`.
        let Some((lang, header)) = classify(&ext) else {
            continue;
        };
        let lines = file.data.as_deref().map_or(0, |d| {
            d.split(|&b| b == b'\n')
                .filter(|l| l.iter().any(|b| !b.is_ascii_whitespace()))
                .count() as u64
        });
        if header {
            info.header_files += 1;
        } else {
            info.source_files += 1;
            info.source_lines += lines;
        }
        info.total_lines += lines;
        info.bytes += file.size;
        info.largest_bytes = info.largest_bytes.max(file.size);
        langs.insert(lang);
        let mut parts = file.path.split('/');
        let top = parts.next().unwrap_or_default();
        dirs.insert(if file.path.contains('/') { top } else { "." });
        if file
            .path
            .split('/')
            .rev()
            .skip(1)
            .any(|d| VENDOR_DIRS.contains(&d.to_ascii_lowercase().as_str()))
        {
            info.vendor_dir_lines += lines;
        }
    }
    info.langs = langs.into_iter().map(str::to_string).collect();
    info.dirs = dirs
        .into_iter()
        .take(MAX_DIRS)
        .map(str::to_string)
        .collect();
    info.vendored = info.source_lines >= VENDORED_SOURCE_LINES
        || info.total_lines >= VENDORED_TOTAL_LINES
        || info.vendor_dir_lines >= VENDORED_DIR_LINES;
    info
}

#[cfg(test)]
mod tests {
    use super::super::source::test_support::tree;
    use super::*;

    fn lines(n: usize) -> Vec<u8> {
        "int x;\n\n".repeat(n).into_bytes()
    }

    #[test]
    fn a_small_binding_shim_is_native_but_not_vendored() {
        let info = scan(&tree(&[
            ("src/lib.rs", b"extern \"C\" {}"),
            ("src/shim.c", &lines(40)),
            ("src/shim.h", &lines(10)),
        ]));
        assert!(info.has_native_code());
        assert!(!info.vendored);
        assert_eq!((info.source_files, info.header_files), (1, 1));
        assert_eq!(info.source_lines, 40, "blank lines are not counted");
        assert_eq!(info.total_lines, 50);
        assert_eq!(info.langs, ["c"]);
        assert_eq!(info.dirs, ["src"]);
    }

    #[test]
    fn a_large_or_vendor_dir_tree_is_vendored() {
        let big = scan(&tree(&[
            ("libgit2/src/a.c", &lines(800)),
            ("libgit2/src/b.cpp", &lines(300)),
        ]));
        assert!(big.vendored, "1,100 source lines");
        assert_eq!(big.langs, ["c", "c++"]);
        assert_eq!(big.dirs, ["libgit2"]);

        let headers = scan(&tree(&[("include/stb.h", &lines(6000))]));
        assert!(headers.vendored, "header-only library");
        assert_eq!(headers.source_lines, 0);

        let vendor = scan(&tree(&[("vendor/zlib/adler32.c", &lines(250))]));
        assert!(vendor.vendored, "small, but under vendor/");
        assert_eq!(vendor.vendor_dir_lines, 250);
    }

    #[test]
    fn prebuilt_binaries_and_other_files_are_kept_apart() {
        let info = scan(&tree(&[
            ("lib/libfoo.a", b"!<arch>\n"),
            ("win/foo.DLL", b"MZ"),
            ("asm/start.S", &lines(5)),
            ("README.md", b"# c"),
        ]));
        assert_eq!(info.prebuilt_files, 2);
        assert_eq!(info.langs, ["asm"]);
        assert_eq!(info.dirs, ["asm"]);
        assert!(!info.vendored);
        assert!(!scan(&tree(&[("src/lib.rs", b"")])).has_native_code());
    }
}
