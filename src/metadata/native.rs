//! Small `.c` shims in `-sys` crates are not vendoring, so `vendored` needs a line threshold.
//! Raw counts are stored so the thresholds can be re-cut in Cypher.
use super::source::SourceTree;
use std::collections::BTreeSet;

/// Done-marker (`Version.meta_native`); bump when detection or thresholds change.
pub const REVISION: &str = "native 1";

pub const VENDORED_SOURCE_LINES: u64 = 1_000;
pub const VENDORED_TOTAL_LINES: u64 = 5_000;
pub const VENDORED_DIR_LINES: u64 = 200;
const MAX_DIRS: usize = 16;

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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeInfo {
    pub source_files: u64,
    pub header_files: u64,
    pub source_lines: u64,
    pub total_lines: u64,
    pub bytes: u64,
    pub largest_bytes: u64,
    pub vendor_dir_lines: u64,
    pub langs: Vec<String>,
    pub dirs: Vec<String>,
    pub prebuilt_files: u64,
    pub vendored: bool,
}

impl NativeInfo {
    #[must_use]
    pub fn has_native_code(&self) -> bool {
        self.source_files + self.header_files > 0
    }
}

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
