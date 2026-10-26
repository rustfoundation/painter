//! Older manifests omit `build`, so the default `build.rs` is applied here.
use super::source::SourceTree;

/// Done-marker (`Version.meta_build`); bump to recompute everything.
pub const REVISION: &str = "build 1";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuildInfo {
    pub has_build_script: bool,
    pub path: Option<String>,
    pub lines: Option<u64>,
    pub links: Option<String>,
}

#[must_use]
pub fn scan(tree: &SourceTree) -> BuildInfo {
    let path = match &tree.manifest.build {
        Some(stated) => stated.clone(),
        None => tree.get("build.rs").map(|_| "build.rs".to_string()),
    };
    let lines = path
        .as_deref()
        .and_then(|p| tree.get(p.trim_start_matches("./")))
        .and_then(|f| f.text())
        .map(|t| t.lines().count() as u64);
    BuildInfo {
        has_build_script: path.is_some(),
        path,
        lines,
        links: tree.manifest.links.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::source::test_support::tree;
    use super::*;

    #[test]
    fn default_build_rs_is_found() {
        let b = scan(&tree(&[
            ("build.rs", b"fn main() {\n}\n"),
            ("src/lib.rs", b""),
        ]));
        assert!(b.has_build_script);
        assert_eq!(b.path.as_deref(), Some("build.rs"));
        assert_eq!(b.lines, Some(2));
        assert_eq!(b.links, None);
    }

    #[test]
    fn manifest_overrides_the_default() {
        let off = scan(&tree(&[
            ("Cargo.toml", b"[package]\nname = \"d\"\nbuild = false\n"),
            ("build.rs", b"fn main() {}\n"),
        ]));
        assert_eq!(
            off,
            BuildInfo::default(),
            "build = false wins over build.rs"
        );

        let named = scan(&tree(&[
            (
                "Cargo.toml",
                b"[package]\nname = \"d\"\nbuild = \"tools/gen.rs\"\nlinks = \"ssl\"\n",
            ),
            ("tools/gen.rs", b"fn main() {}\n"),
        ]));
        assert!(named.has_build_script);
        assert_eq!(named.path.as_deref(), Some("tools/gen.rs"));
        assert_eq!(named.lines, Some(1));
        assert_eq!(named.links.as_deref(), Some("ssl"));

        let none = scan(&tree(&[("src/lib.rs", b"")]));
        assert!(!none.has_build_script);
    }
}
