//! `diff` job: what changed in a version since the previous one, per file, as line counts.
//!
//! The previous version is the next lower one in semver order among the crate's versions
//! (pre-releases sort before their release), which is what `diff_base` records. The first
//! version is compared with nothing, so every file counts as added. Nothing of the diff itself
//! is stored, only per changed file its path, status (`added`, `removed`, `modified`), lines
//! added and removed, and whether it is binary, plus totals.
//!
//! Text is compared line by line with a Myers diff (`similar`), bounded by [`DIFF_TIMEOUT`] per
//! file; a diff that hits the bound is approximate (still a valid edit, maybe not the
//! smallest) and the version is flagged `diff_approximate`. A file is binary when it contains
//! a NUL byte; binary or unloaded files count as changed when their bytes or size differ, with
//! no line counts.
use super::source::{SourceFile, SourceTree};
use std::time::{Duration, Instant};

/// Job revision, stored as `Version.meta_diff` (this job's done-marker). Bump it when the
/// comparison changes to recompute every version.
pub const REVISION: &str = "diff 1";

/// Longest a single file's line diff may take before it settles for an approximate result.
pub const DIFF_TIMEOUT: Duration = Duration::from_secs(2);

/// How a file changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Added,
    Removed,
    Modified,
}

impl Status {
    /// The value stored in `diff_status`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Added => "added",
            Status::Removed => "removed",
            Status::Modified => "modified",
        }
    }
}

/// One changed file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub status: Status,
    pub added: u64,
    pub removed: u64,
    pub binary: bool,
}

/// A version's changes against its predecessor.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiffInfo {
    /// The version compared against; `None` for the first version.
    pub base: Option<String>,
    /// Changed files, sorted by path. Unchanged files are left out.
    pub files: Vec<FileChange>,
    /// Files in this version.
    pub files_total: u64,
    /// Some file diff hit [`DIFF_TIMEOUT`] and its counts are approximate.
    pub approximate: bool,
}

impl DiffInfo {
    fn count(&self, status: Status) -> u64 {
        self.files.iter().filter(|f| f.status == status).count() as u64
    }
    /// Files added since the base.
    #[must_use]
    pub fn files_added(&self) -> u64 {
        self.count(Status::Added)
    }
    /// Files removed since the base.
    #[must_use]
    pub fn files_removed(&self) -> u64 {
        self.count(Status::Removed)
    }
    /// Files changed in place since the base.
    #[must_use]
    pub fn files_modified(&self) -> u64 {
        self.count(Status::Modified)
    }
    /// Lines added over every changed file.
    #[must_use]
    pub fn lines_added(&self) -> u64 {
        self.files.iter().map(|f| f.added).sum()
    }
    /// Lines removed over every changed file.
    #[must_use]
    pub fn lines_removed(&self) -> u64 {
        self.files.iter().map(|f| f.removed).sum()
    }
}

/// Text of a file for line diffing, or `None` when it is binary or not loaded.
fn text_of(file: &SourceFile) -> Option<&[u8]> {
    let data = file.data.as_deref()?;
    (!data.contains(&0)).then_some(data)
}

fn line_count(data: &[u8]) -> u64 {
    if data.is_empty() {
        0
    } else {
        data.split(|&b| b == b'\n').count() as u64 - u64::from(data.ends_with(b"\n"))
    }
}

/// Lines added and removed between two texts, and whether the diff hit the time bound.
fn line_delta(old: &[u8], new: &[u8]) -> (u64, u64, bool) {
    let started = Instant::now();
    let diff = similar::TextDiff::configure()
        .algorithm(similar::Algorithm::Myers)
        .timeout(DIFF_TIMEOUT)
        .diff_lines(old, new);
    let (mut added, mut removed) = (0u64, 0u64);
    for op in diff.ops() {
        match op.tag() {
            similar::DiffTag::Insert => added += op.new_range().len() as u64,
            similar::DiffTag::Delete => removed += op.old_range().len() as u64,
            similar::DiffTag::Replace => {
                added += op.new_range().len() as u64;
                removed += op.old_range().len() as u64;
            }
            similar::DiffTag::Equal => {}
        }
    }
    (added, removed, started.elapsed() >= DIFF_TIMEOUT)
}

/// Compare a version (`new`) with its predecessor (`old`, `None` for the first version).
#[must_use]
pub fn diff(old: Option<(&str, &SourceTree)>, new: &SourceTree) -> DiffInfo {
    let empty = SourceTree::default();
    let (base, old_tree) = old.map_or((None, &empty), |(v, t)| (Some(v.to_string()), t));
    let mut info = DiffInfo {
        base,
        files_total: new.files.len() as u64,
        ..DiffInfo::default()
    };
    // Both file lists are sorted by path: merge them.
    let mut olds = old_tree.files.iter().peekable();
    let mut news = new.files.iter().peekable();
    loop {
        let removed_next = match (olds.peek(), news.peek()) {
            (None, None) => break,
            (Some(before), Some(after)) if before.path == after.path => None,
            (Some(before), after) => Some(after.is_none_or(|a| before.path < a.path)),
            (None, Some(_)) => Some(false),
        };
        let change = match removed_next {
            Some(true) => {
                let Some(before) = olds.next() else { break };
                let text = text_of(before);
                FileChange {
                    path: before.path.clone(),
                    status: Status::Removed,
                    added: 0,
                    removed: text.map_or(0, line_count),
                    binary: text.is_none(),
                }
            }
            Some(false) => {
                let Some(after) = news.next() else { break };
                let text = text_of(after);
                FileChange {
                    path: after.path.clone(),
                    status: Status::Added,
                    added: text.map_or(0, line_count),
                    removed: 0,
                    binary: text.is_none(),
                }
            }
            None => {
                let (Some(before), Some(after)) = (olds.next(), news.next()) else {
                    break;
                };
                if before.size == after.size && before.data == after.data {
                    continue;
                }
                match (text_of(before), text_of(after)) {
                    (Some(old_text), Some(new_text)) => {
                        let (added, removed, timed_out) = line_delta(old_text, new_text);
                        info.approximate |= timed_out;
                        FileChange {
                            path: after.path.clone(),
                            status: Status::Modified,
                            added,
                            removed,
                            binary: false,
                        }
                    }
                    _ => FileChange {
                        path: after.path.clone(),
                        status: Status::Modified,
                        added: 0,
                        removed: 0,
                        binary: true,
                    },
                }
            }
        };
        info.files.push(change);
    }
    info
}

#[cfg(test)]
mod tests {
    use super::super::source::test_support::tree;
    use super::*;

    #[test]
    fn counts_added_removed_and_modified_lines_per_file() {
        let old = tree(&[
            ("src/lib.rs", b"a\nb\nc\n"),
            ("gone.rs", b"x\ny\n"),
            ("same.rs", b"same\n"),
            ("logo.png", b"\x89PNG\0\x01"),
        ]);
        let new = tree(&[
            ("src/lib.rs", b"a\nB\nc\nd\n"),
            ("new.rs", b"1\n2\n3"),
            ("same.rs", b"same\n"),
            ("logo.png", b"\x89PNG\0\x02"),
        ]);
        let d = diff(Some(("1.0.0", &old)), &new);
        assert_eq!(d.base.as_deref(), Some("1.0.0"));
        assert_eq!(d.files_total, 4);
        let by_path: Vec<(&str, &str, u64, u64, bool)> = d
            .files
            .iter()
            .map(|f| {
                (
                    f.path.as_str(),
                    f.status.as_str(),
                    f.added,
                    f.removed,
                    f.binary,
                )
            })
            .collect();
        assert_eq!(
            by_path,
            [
                ("gone.rs", "removed", 0, 2, false),
                ("logo.png", "modified", 0, 0, true),
                ("new.rs", "added", 3, 0, false),
                ("src/lib.rs", "modified", 2, 1, false),
            ]
        );
        assert_eq!(
            (d.files_added(), d.files_removed(), d.files_modified()),
            (1, 1, 2)
        );
        assert_eq!((d.lines_added(), d.lines_removed()), (5, 3));
        assert!(!d.approximate);
    }

    #[test]
    fn the_first_version_adds_everything() {
        let d = diff(None, &tree(&[("a.rs", b"1\n2\n"), ("b.rs", b"")]));
        assert_eq!(d.base, None);
        assert_eq!((d.files_added(), d.lines_added()), (2, 2));
    }

    #[test]
    fn identical_versions_have_no_changes() {
        let t = tree(&[("a.rs", b"1\n")]);
        let d = diff(Some(("0.1.0", &t)), &t);
        assert_eq!(d.files, Vec::<FileChange>::new());
        assert_eq!(d.files_total, 1);
    }

    #[test]
    fn line_count_handles_trailing_newlines() {
        assert_eq!(line_count(b""), 0);
        assert_eq!(line_count(b"a"), 1);
        assert_eq!(line_count(b"a\n"), 1);
        assert_eq!(line_count(b"a\nb"), 2);
    }
}
