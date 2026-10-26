# Setup

Run before the first import.

```cypher
CREATE CONSTRAINT const_crate_name IF NOT EXISTS FOR (n:Crate) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT const_version IF NOT EXISTS FOR (n:Version) REQUIRE (n.name, n.version) IS UNIQUE;
CREATE CONSTRAINT const_symbol_name IF NOT EXISTS FOR (n:Symbol) REQUIRE n.name IS UNIQUE;
CREATE TEXT INDEX idx_symbol_name_text IF NOT EXISTS FOR (n:Symbol) ON (n.name);
CREATE INDEX idx_is_latest IF NOT EXISTS FOR (n:Version) ON (n.latest);
CREATE INDEX idx_unsafe_total IF NOT EXISTS FOR (n:Version) ON (n.unsafe_total);
CREATE TEXT INDEX idx_crate_name_text IF NOT EXISTS FOR (n:Crate) ON (n.name);
CREATE INDEX idx_has_build_script IF NOT EXISTS FOR (n:Version) ON (n.has_build_script);
CREATE INDEX idx_version_links IF NOT EXISTS FOR (n:Version) ON (n.links);
CREATE INDEX idx_has_native_code IF NOT EXISTS FOR (n:Version) ON (n.has_native_code);
CREATE INDEX idx_vendored_native IF NOT EXISTS FOR (n:Version) ON (n.vendored_native);
CREATE INDEX idx_diff_lines_added IF NOT EXISTS FOR (n:Version) ON (n.diff_lines_added);
CREATE CONSTRAINT const_user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT const_team_id IF NOT EXISTS FOR (t:Team) REQUIRE t.id IS UNIQUE;
CREATE CONSTRAINT const_category_slug IF NOT EXISTS FOR (c:Category) REQUIRE c.slug IS UNIQUE;
CREATE CONSTRAINT const_keyword_name IF NOT EXISTS FOR (k:Keyword) REQUIRE k.name IS UNIQUE;
CREATE INDEX idx_user_login IF NOT EXISTS FOR (u:User) ON (u.login);
CREATE INDEX idx_published_at IF NOT EXISTS FOR ()-[p:PUBLISHED]-() ON (p.at);
CREATE INDEX idx_owns_since IF NOT EXISTS FOR ()-[o:OWNS]-() ON (o.since);
CREATE INDEX idx_version_published_at IF NOT EXISTS FOR (v:Version) ON (v.published_at);
CREATE INDEX idx_crate_created_at IF NOT EXISTS FOR (c:Crate) ON (c.created_at);
CREATE INDEX idx_crate_downloads IF NOT EXISTS FOR (c:Crate) ON (c.downloads);
```

- `const_symbol_name`: `MERGE` on `Symbol.name` relies on it under concurrency; it also serves every
  function lookup and the UI Callers view.
- `idx_symbol_name_text`, `idx_crate_name_text`: `CONTAINS` / `ENDS WITH` and partial-name search.
- `idx_has_build_script` ... `idx_diff_lines_added`: let the UI leaderboards seek instead of scanning
  every version.
- `const_user_id` ... `idx_crate_downloads`: created by the `registry` job itself
  (`db::REGISTRY_SCHEMA_CYPHER`). `idx_published_at` is a relationship range index.
- The Map build adds its own `Crate.lod_*` indexes and `LOD_DEP` (see `render/README.md`).

Enterprise only:

```cypher
CREATE CONSTRAINT FOR (n:Version) REQUIRE (n.name, n.version) IS NODE KEY;
```

# Schema notes

- `(Crate)-[:VERSION_OF]->(Version)`: crate to version. Reach versions through `(:Crate {name})`;
  `(:Version {name})` without `version` cannot use the `(name, version)` index and scans every version.
- Calls: `(Version)-[:HAS_FN]->(:Fn)-[:IS]->(:Symbol)` is the caller,
  `(:Fn)-[:CALLS {copies}]->(:Symbol)-[:IN]->(Crate)` a callee. `Symbol` is one node per demangled
  name, shared by every version; `copies` > 1 because monomorphised generics demangle to the same name.
- A symbol's crate is the first path segment of its name (`num_traits` matches `num-traits`); the callee
  version is unknown. Only called symbols have `IN`.
- Databases from before 2026-10-25 hold `(Version)-[:INVOKES]->(Crate)` instead;
  `painter export-for-import` converts them.

# Crates and versions

### Latest version

```cypher
MATCH (:Crate {name: 'serde'})-[:VERSION_OF]->(v:Version)
WHERE v.latest
RETURN v.version
```

### All versions

```cypher
MATCH (:Crate {name: 'serde'})-[:VERSION_OF]->(v:Version)
RETURN v.version
ORDER BY v.semver_major DESC, v.semver_minor DESC, v.semver_patch DESC
```

### Clear latest flags

```cypher
MATCH (v:Version) WHERE v.latest IS NOT NULL
CALL { WITH v REMOVE v.latest } IN TRANSACTIONS OF 10000 ROWS
```

Run with `:auto` in the browser.

# Dependencies

### Direct dependencies of a version

```cypher
MATCH (:Version {name: 'rocket', version: '0.5.1'})-[d:DEPENDS_ON]->(c:Crate)
RETURN c.name, d.requirement, d.kind, d.optional
```

### Direct dependents, versions

```cypher
MATCH (v:Version)-[d:DEPENDS_ON]->(:Crate {name: 'atomic-counter'})
RETURN v.name, v.version, d.requirement
```

### Direct dependents, crates

```cypher
MATCH (c:Crate)-[:VERSION_OF]->(:Version)-[:DEPENDS_ON]->(:Crate {name: 'atomic-counter'})
RETURN DISTINCT c.name
```

### Transitive dependents, crates

Any version, up to 3 hops; large for popular crates.

```cypher
MATCH (c:Crate)
      ((:Crate)-[:VERSION_OF]->(:Version)-[:DEPENDS_ON]->(:Crate)){1,3}
      (:Crate {name: 'atomic-counter'})
RETURN DISTINCT c.name
```

### Transitive dependencies of a latest version

```cypher
MATCH (:Crate {name: 'rocket'})-[:VERSION_OF]->(v:Version)
WHERE v.latest
MATCH (v)-[:DEPENDS_ON]->(:Crate)
      ((:Crate)-[:VERSION_OF]->(lv:Version WHERE lv.latest)-[:DEPENDS_ON]->(:Crate)){0,3}
      (dep:Crate)
RETURN DISTINCT dep.name
```

Follows each dependency's latest version, not the one the requirement resolves to.

### Most direct dependents

Scans every `DEPENDS_ON`; minutes.

```cypher
MATCH (v:Version)-[:DEPENDS_ON]->(c:Crate)
RETURN c.name, count(DISTINCT v.name) AS crates
ORDER BY crates DESC LIMIT 10
```

# Function calls

Names are full demangled paths; find the exact name first.

### Functions of a crate that are called

```cypher
MATCH (:Crate {name: 'bytes'})<-[:IN]-(s:Symbol)
WHERE s.name CONTAINS 'copy_from_slice'
RETURN s.name, COUNT { (s)<-[:CALLS]-() } AS callers
ORDER BY callers DESC
```

### What a version calls

```cypher
MATCH (:Version {name: 'rocket', version: '0.5.1'})-[:HAS_FN]->(:Fn)-[:CALLS]->(:Symbol)-[:IN]->(c:Crate)
RETURN c.name, count(*) AS calls
ORDER BY calls DESC
```

```cypher
MATCH (:Version {name: 'rocket', version: '0.5.1'})-[:HAS_FN]->(f:Fn)-[:CALLS]->(t:Symbol)-[:IN]->(:Crate {name: 'tokio'})
MATCH (f)-[:IS]->(c:Symbol)
RETURN c.name AS caller, t.name AS callee
```

### All direct callers of a function

```cypher
MATCH (:Symbol {name: 'bytes::bytes::Bytes::copy_from_slice'})<-[:CALLS]-(f:Fn)<-[:HAS_FN]-(v:Version)
MATCH (f)-[:IS]->(c:Symbol)
RETURN v.name, v.version, c.name AS caller
```

Per caller version:

```cypher
MATCH (:Symbol {name: 'bytes::bytes::Bytes::copy_from_slice'})<-[:CALLS]-(:Fn)<-[:HAS_FN]-(v:Version)
RETURN v.name, v.version, count(*) AS callers
ORDER BY callers DESC
```

With the caller's requirement on the callee crate (empty = no direct dependency):

```cypher
MATCH (s:Symbol {name: 'bytes::bytes::Bytes::copy_from_slice'})-[:IN]->(t:Crate)
MATCH (s)<-[:CALLS]-(f:Fn)<-[:HAS_FN]-(v:Version)
MATCH (f)-[:IS]->(c:Symbol)
OPTIONAL MATCH (v)-[d:DEPENDS_ON]->(t)
RETURN v.name, v.version, c.name AS caller, collect(DISTINCT d.requirement) AS requirement
```

### Direct callers in one crate version

```cypher
MATCH (:Symbol {name: 'bytes::bytes::Bytes::copy_from_slice'})<-[:CALLS]-(f:Fn)<-[:HAS_FN]-(:Version {name: 'rust-s3', version: '0.37.2'})
MATCH (f)-[:IS]->(c:Symbol)
RETURN c.name
```

### Transitive callers, all sources

A caller's `Symbol` is the same node as its callee `Symbol`, so each level is one more hop.

```cypher
MATCH (:Symbol {name: 'bytes::bytes::Bytes::copy_from_slice'})
      ((:Symbol)<-[:CALLS]-(:Fn)-[:IS]->(:Symbol)){1,2}
      (c:Symbol)
RETURN DISTINCT c.name
LIMIT 500
```

With the version that holds the outermost caller:

```cypher
MATCH (:Symbol {name: 'bytes::bytes::Bytes::copy_from_slice'})<-[:CALLS]-(:Fn)-[:IS]->(c1:Symbol)
      <-[:CALLS]-(f2:Fn)-[:IS]->(c2:Symbol)
MATCH (f2)<-[:HAS_FN]-(v2:Version)
RETURN DISTINCT v2.name, v2.version, c2.name, c1.name AS via
LIMIT 500
```

Not version-checked: a hop matches every version that calls a function of that name (the UI Callers
view adds requirement checks).

### Transitive callers in one crate version

```cypher
MATCH (v:Version {name: 'rust-s3', version: '0.37.2'})
MATCH (:Symbol {name: 'bytes::bytes::Bytes::copy_from_slice'})<-[:CALLS]-(f1:Fn)-[:IS]->(c1:Symbol)
WHERE (v)-[:HAS_FN]->(f1)
OPTIONAL MATCH (c1)<-[:CALLS]-(f2:Fn)-[:IS]->(c2:Symbol) WHERE (v)-[:HAS_FN]->(f2)
OPTIONAL MATCH (c2)<-[:CALLS]-(f3:Fn)-[:IS]->(c3:Symbol) WHERE (v)-[:HAS_FN]->(f3)
RETURN DISTINCT c1.name, c2.name, c3.name
```

`null` = chain ends.

# Version metadata

`painter generate-metadata` stores these on each `Version`, plus a done-marker per job
(`unsafe_scanner`, `meta_build`, `meta_native`, `meta_diff`). `meta_error` is set while the tarball
cannot be read.

**unsafe**

- `unsafe_total`, `unsafe_{functions,exprs,impls,traits,methods}`, `safe_{...}`: geiger's
  counters over every `.rs` file in the `.crate` (tests included), zero when none.
- `rs_files` (parsed), `rs_files_failed` (not UTF-8, unparsable, or over 64 MB), `rs_lines`,
  `rs_bytes`, `rs_forbid_files` (files with `#![forbid(unsafe_code)]`).
- `forbids_unsafe`: the crate root (`[lib] path`, else `src/lib.rs`, else `src/main.rs`) forbids
  unsafe; absent when no root file parsed.
- `unsafe_scanned_at`; `unsafe_error` instead of counts when the tarball is missing or unreadable.

**build**

- `has_build_script`: Cargo would run a build script (`package.build`, else `build.rs` at the
  root). `build_script` (its path), `build_script_lines`, `links` (`package.links`).

**native**

- `has_native_code`: any C, C++, Objective-C, or assembly source or header.
- `vendored_native`: a vendored library rather than a binding shim: >= 1,000 non-blank source lines,
  or >= 5,000 with headers, or >= 200 under `vendor/`, `third_party/`, `deps/`, `external/`,
  `contrib/`, ... Raw counts are stored so the thresholds can be re-cut.
- `native_source_files`, `native_header_files`, `native_source_lines`, `native_lines` (sources
  and headers, non-blank), `native_bytes`, `native_largest_bytes`, `native_vendor_dir_lines`,
  `native_langs` (`c`, `c++`, `objc`, `asm`), `native_dirs` (top-level directories holding native
  files), `native_prebuilt_files` (`.a`, `.lib`, `.so`, `.dll`, `.dylib`, `.o`, `.obj`).

**diff** (against the previous version in semver order; the first version against nothing)

- `diff_base` (absent for the first), `diff_files_total`,
  `diff_files_added` / `_removed` / `_modified`, `diff_lines_added` / `_removed`,
  `diff_approximate` (a file's diff hit the 2 s bound and is approximate).
- Per changed file, as parallel lists (index `i` of each is one file): `diff_paths`,
  `diff_status` (`added`, `removed`, `modified`), `diff_added`, `diff_removed` (lines),
  `diff_binary` (binary or over 64 MB: changed, no line counts).

### Metadata coverage

```cypher
MATCH (v:Version)
RETURN count(v) AS versions, count(v.unsafe_scanner) AS unsafe, count(v.meta_build) AS build,
       count(v.meta_native) AS native, count(v.meta_diff) AS diff, count(v.meta_error) AS unreadable
```

### Latest versions that vendor native code

```cypher
MATCH (v:Version)
WHERE v.latest AND v.vendored_native
RETURN v.name, v.version, v.native_langs, v.native_source_lines, v.native_dirs, v.links
ORDER BY v.native_source_lines DESC LIMIT 50
```

### What changed in one version

```cypher
MATCH (:Crate {name: 'serde'})-[:VERSION_OF]->(v:Version {version: '1.0.229'})
UNWIND range(0, size(v.diff_paths) - 1) AS i
RETURN v.diff_base, v.diff_paths[i] AS file, v.diff_status[i] AS status,
       v.diff_added[i] AS added, v.diff_removed[i] AS removed
ORDER BY added + removed DESC
```

### Most-linked native libraries (`package.links`)

```cypher
MATCH (v:Version) WHERE v.links IS NOT NULL AND v.latest
RETURN v.links, count(DISTINCT v.name) AS crates, collect(DISTINCT v.name)[0..5] AS sample
ORDER BY crates DESC LIMIT 25
```

### Biggest version-to-version changes

Excludes first versions (everything counts as added).

```cypher
MATCH (v:Version)
WHERE v.latest AND v.diff_base IS NOT NULL
RETURN v.name, v.version, v.diff_base, v.diff_lines_added, v.diff_lines_removed,
       v.diff_files_added + v.diff_files_removed + v.diff_files_modified AS files_changed
ORDER BY v.diff_lines_added + v.diff_lines_removed DESC LIMIT 50
```

### Change history of one crate

```cypher
MATCH (:Crate {name: 'serde'})-[:VERSION_OF]->(v:Version)
RETURN v.version, v.diff_base, v.diff_lines_added, v.diff_lines_removed, v.diff_files_total
ORDER BY v.semver_major, v.semver_minor, v.semver_patch, coalesce(v.semver_pre, '') = '', v.version
```

### Releases that newly add a build script

```cypher
MATCH (v:Version)
WHERE v.latest AND v.has_build_script AND 'build.rs' IN v.diff_paths
WITH v, [i IN range(0, size(v.diff_paths) - 1) WHERE v.diff_paths[i] = 'build.rs'][0] AS i
WHERE v.diff_status[i] = 'added'
RETURN v.name, v.version, v.diff_base
```

# Unsafe

### Scan coverage

```cypher
MATCH (v:Version)
RETURN count(v) AS versions,
       count(v.unsafe_scanner) AS scanned,
       count(v.unsafe_error) AS unreadable,
       count(CASE WHEN v.unsafe_total > 0 THEN 1 END) AS with_unsafe,
       count(CASE WHEN v.forbids_unsafe THEN 1 END) AS forbid_unsafe
```

### Unsafe density of latest versions

```cypher
MATCH (v:Version)
WHERE v.latest AND v.rs_lines > 10000
RETURN v.name, v.version, v.rs_lines, v.unsafe_exprs,
       round(1000.0 * v.unsafe_exprs / v.rs_lines, 2) AS unsafe_per_kloc
ORDER BY unsafe_per_kloc DESC LIMIT 50
```

### Dependencies that claim `forbid(unsafe_code)` but have a build script

```cypher
MATCH (:Crate {name: 'rocket'})-[:VERSION_OF]->(v:Version)
WHERE v.latest
MATCH (v)-[:DEPENDS_ON]->(c:Crate)-[:VERSION_OF]->(dv:Version)
WHERE dv.latest AND dv.forbids_unsafe AND dv.has_build_script
RETURN c.name, dv.version
```

### Most unsafe latest versions

```cypher
MATCH (v:Version)
WHERE v.latest AND v.unsafe_total > 0
RETURN v.name, v.version, v.unsafe_total
ORDER BY v.unsafe_total DESC LIMIT 50
```

### Latest versions with unsafe

```cypher
MATCH (v:Version)
WHERE v.latest AND v.unsafe_total > 0
RETURN count(v)
```

### Unsafe in direct dependencies

```cypher
MATCH (:Crate {name: 'rocket'})-[:VERSION_OF]->(v:Version)
WHERE v.latest
MATCH (v)-[:DEPENDS_ON]->(:Crate)-[:VERSION_OF]->(dv:Version)
WHERE dv.latest AND dv.unsafe_total > 0
RETURN dv.name, dv.version, dv.unsafe_total
ORDER BY dv.unsafe_total DESC
```

# Registry (publishers, owners, dates)

`painter generate-metadata --job registry --cratesio-dump DIR` (or `create-fresh-db` /
`import-crates --cratesio-dump DIR`) loads an extracted crates.io database dump
(`https://static.crates.io/db-dump.tar.gz`). The index has no users, so this is the only source of
uploaders and owners.

- `(User {id, login, name, gh_id, created_at})`, `(Team {id, login, name, avatar})`
- `(User)-[:PUBLISHED {at}]->(Version)`: the uploader. Only recorded since 2019-02-22 and absent for
  trusted-publishing uploads, so `Version.published_at` is the complete date and per-user counts
  undercount CI publishing
- `(User)-[:PUBLISHED {at, last, versions}]->(Crate)`: first and last upload, upload count
- `(User|Team)-[:OWNS {since, added_by}]->(Crate)`: current owners; `added_by` is a login
- `(Crate)-[:IN_CATEGORY]->(Category {slug, name, description, path, crates})`,
  `(Crate)-[:HAS_KEYWORD]->(Keyword {name})`
- `Version`: `published_at`, `yanked`, `license`, `crate_size`, `downloads`, `edition`,
  `rust_version`, `has_lib`, `bin_names`, marker `meta_registry` (`registry-1@<dump timestamp>`),
  `registry_missing` when the dump lacks the version
- `Crate`: `created_at`, `updated_at`, `description`, `homepage`, `documentation`,
  `repository`, `downloads`, `trustpub_only`, `default_version`, `num_versions`, `registry_id`

Dates are `DateTime`s; compare against `datetime('2025-01-01')`.

### Crates published by a user

```cypher
MATCH (u:User {login: 'dtolnay'})-[p:PUBLISHED]->(c:Crate)
RETURN c.name, p.at AS first, p.last, p.versions ORDER BY p.versions DESC
```

### Crates first published in a timeframe

```cypher
MATCH (u:User)-[p:PUBLISHED]->(c:Crate)
WHERE p.at >= datetime('2025-01-01') AND p.at < datetime('2025-02-01')
RETURN c.name, u.login, p.at ORDER BY p.at
```

`p.at` is the user's first upload of the crate; for the crate's own first release use
`c.created_at` (`idx_crate_created_at`).

### Versions published in a timeframe

```cypher
MATCH (u:User)-[p:PUBLISHED]->(v:Version)
WHERE p.at >= datetime('2026-09-01') AND p.at < datetime('2026-09-02')
RETURN v.name, v.version, u.login, p.at ORDER BY p.at
```

### Who owns a crate

```cypher
MATCH (o)-[r:OWNS]->(:Crate {name: 'tokio'})
RETURN labels(o)[0] AS kind, o.login, r.since, r.added_by
```

### Owners who never published the crate

```cypher
MATCH (u:User)-[:OWNS]->(c:Crate {name: 'tokio'})
WHERE NOT (u)-[:PUBLISHED]->(c)
RETURN u.login
```

# Cleanup

### Duplicate versions

```cypher
MATCH (v:Version)
WITH v.name AS name, v.version AS version, count(*) AS n
WHERE n > 1
RETURN name, version, n
```

### Duplicate relationships

```cypher
MATCH (a)-[r]->(b)
WITH a, type(r) AS type, b, count(*) AS n
WHERE n > 1
RETURN a, type, b, n
LIMIT 100
```

Scans every relationship (slow).

### Unreferenced symbols

Re-exporting a version deletes its `Fn`s but leaves `Symbol`s, which other versions share.

```cypher
MATCH (s:Symbol) WHERE NOT EXISTS { (s)<-[:CALLS]-() } AND NOT EXISTS { (s)<-[:IS]-() }
CALL { WITH s DETACH DELETE s } IN TRANSACTIONS OF 10000 ROWS
```

### Drop the Map precompute

```cypher
MATCH ()-[r:LOD_DEP]->()
CALL { WITH r DELETE r } IN TRANSACTIONS OF 10000 ROWS;
MATCH (c:Crate) WHERE c.lod_x IS NOT NULL
CALL { WITH c REMOVE c.lod_x, c.lod_y, c.lod_community, c.lod_degree } IN TRANSACTIONS OF 10000 ROWS;
```
