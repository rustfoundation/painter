//! Held in memory, never unpacked, so a hostile archive cannot place files anywhere.
use std::io::Read;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFile {
    pub path: String,
    pub size: u64,
    pub data: Option<Vec<u8>>,
}

impl SourceFile {
    #[must_use]
    pub fn text(&self) -> Option<&str> {
        std::str::from_utf8(self.data.as_deref()?).ok()
    }

    #[must_use]
    pub fn extension(&self) -> Option<String> {
        std::path::Path::new(&self.path)
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Manifest {
    /// `Some(None)` is `build = false`; `None` means unstated (default `build.rs` applies).
    pub build: Option<Option<String>>,
    pub lib_path: Option<String>,
    pub links: Option<String>,
}

impl Manifest {
    #[must_use]
    pub fn parse(text: &str) -> Self {
        let Ok(value) = toml::from_str::<toml::Value>(text) else {
            return Self::default();
        };
        let package = value.get("package");
        let build = match package.and_then(|p| p.get("build")) {
            Some(toml::Value::String(s)) => Some(Some(s.clone())),
            Some(toml::Value::Boolean(true)) => Some(Some("build.rs".to_string())),
            Some(toml::Value::Boolean(false)) => Some(None),
            _ => None,
        };
        let lib_path = value
            .get("lib")
            .and_then(|l| l.get("path"))
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        let links = package
            .and_then(|p| p.get("links"))
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        Self {
            build,
            lib_path,
            links,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceTree {
    pub files: Vec<SourceFile>,
    pub manifest: Manifest,
}

impl SourceTree {
    /// # Errors
    /// Returns the I/O error if the archive cannot be decompressed or walked.
    pub fn from_tarball<R: Read>(gz: R, max_file_bytes: u64) -> std::io::Result<Self> {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(gz));
        let mut files = Vec::new();
        for entry in archive.entries()? {
            let mut entry = entry?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = {
                let path = entry.path()?;
                let mut components = path.components();
                components.next();
                components.as_path().to_string_lossy().into_owned()
            };
            let size = entry.size();
            let data = if size > max_file_bytes {
                None
            } else {
                let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
                entry.read_to_end(&mut bytes)?;
                Some(bytes)
            };
            files.push(SourceFile { path, size, data });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        // Duplicate paths keep the last copy, like unpacking would.
        files.dedup_by(|later, earlier| {
            if later.path == earlier.path {
                std::mem::swap(later, earlier);
                true
            } else {
                false
            }
        });
        let manifest = files
            .binary_search_by(|f| f.path.as_str().cmp("Cargo.toml"))
            .ok()
            .and_then(|i| files[i].text())
            .map(Manifest::parse)
            .unwrap_or_default();
        Ok(Self { files, manifest })
    }

    #[must_use]
    pub fn get(&self, path: &str) -> Option<&SourceFile> {
        self.files
            .binary_search_by(|f| f.path.as_str().cmp(path))
            .ok()
            .map(|i| &self.files[i])
    }
}

#[cfg(test)]
pub mod test_support {
    use std::io::Write;

    /// # Panics
    /// Panics if writing the in-memory archive fails.
    #[must_use]
    pub fn tarball(root: &str, files: &[(&str, &[u8])], symlink: Option<(&str, &str)>) -> Vec<u8> {
        let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);
        for (path, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, format!("{root}/{path}"), *data)
                .unwrap();
        }
        if let Some((path, target)) = symlink {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_cksum();
            tar.append_link(&mut header, format!("{root}/{path}"), target)
                .unwrap();
        }
        let mut gz = tar.into_inner().unwrap();
        gz.flush().unwrap();
        gz.finish().unwrap()
    }

    /// # Panics
    /// Panics if the archive cannot be built or read back.
    #[must_use]
    pub fn tree(files: &[(&str, &[u8])]) -> super::SourceTree {
        super::SourceTree::from_tarball(&tarball("demo-0.1.0", files, None)[..], 1 << 20).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::tarball;
    use super::*;

    #[test]
    fn from_tarball_keeps_regular_files_sorted_and_caps_contents() {
        let files: &[(&str, &[u8])] = &[
            ("src/lib.rs", b"pub fn f() {}\n"),
            ("Cargo.toml", b"[package]\nname = \"demo\"\nlinks = \"z\"\n"),
            ("big.bin", &[0u8; 64]),
        ];
        let tree = SourceTree::from_tarball(
            &tarball("demo-0.1.0", files, Some(("l.rs", "src/lib.rs")))[..],
            48,
        )
        .unwrap();
        let paths: Vec<&str> = tree.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            ["Cargo.toml", "big.bin", "src/lib.rs"],
            "symlink skipped, sorted"
        );
        assert_eq!(tree.get("big.bin").unwrap().size, 64);
        assert_eq!(tree.get("big.bin").unwrap().data, None, "over the cap");
        assert_eq!(
            tree.get("src/lib.rs").unwrap().text(),
            Some("pub fn f() {}\n")
        );
        assert_eq!(tree.manifest.links.as_deref(), Some("z"));
        assert!(tree.get("missing").is_none());
    }

    #[test]
    fn manifest_parses_build_lib_and_links() {
        assert_eq!(Manifest::parse("not [ toml"), Manifest::default());
        let m = Manifest::parse(
            "[package]\nbuild = \"tools/b.rs\"\nlinks = \"git2\"\n[lib]\npath = \"x.rs\"\n",
        );
        assert_eq!(m.build, Some(Some("tools/b.rs".into())));
        assert_eq!(m.lib_path.as_deref(), Some("x.rs"));
        assert_eq!(m.links.as_deref(), Some("git2"));
        assert_eq!(
            Manifest::parse("[package]\nbuild = false\n").build,
            Some(None)
        );
        assert_eq!(
            Manifest::parse("[package]\nbuild = true\n").build,
            Some(Some("build.rs".into()))
        );
    }

    #[test]
    fn rejects_garbage() {
        assert!(SourceTree::from_tarball(&b"not a tarball"[..], 1 << 20).is_err());
    }
}
