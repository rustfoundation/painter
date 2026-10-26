//! `build` job: whether a version has a build script, where, how big, and what it links.
//!
//! Cargo runs `build.rs` at the crate root unless the manifest says otherwise: `package.build`
//! names another script, or `build = false` turns it off. crates.io normalizes `Cargo.toml` on
//! publish, so newer manifests state it explicitly; older ones rely on the default, which this
//! job applies. `package.links` names the native library the build script links.
use super::source::SourceTree;

/// Job revision, stored as `Version.meta_build` (this job's done-marker). Bump it when the
/// detection changes to recompute every version.
pub const REVISION: &str = "build 1";

/// Build-script facts of one version.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuildInfo {
    /// Cargo would run a build script for this version.
    pub has_build_script: bool,
    /// The script's path when it has one (normally `build.rs`).
    pub path: Option<String>,
    /// Lines in the script, when it is in the tarball and readable.
    pub lines: Option<u64>,
    /// `package.links`.
    pub links: Option<String>,
}

/// Work out the build-script facts of a version.
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
