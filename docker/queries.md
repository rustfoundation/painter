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
```

- `const_symbol_name`: required by painter's export (`MERGE` on `Symbol.name` under
  concurrency) and serves every function lookup below and the UI Callers view.
- `idx_symbol_name_text`: `CONTAINS` / `ENDS WITH` searches on function names.
- `idx_crate_name_text`: UI partial-name search.
- Map build adds `crate_lod_x`, `crate_lod_community`, `Crate.lod_*`, `LOD_DEP` (see `render/README.md`).

Enterprise only:

```cypher
CREATE CONSTRAINT FOR (n:Version) REQUIRE (n.name, n.version) IS NODE KEY;
```

# Schema notes

- `(Crate)-[:VERSION_OF]->(Version)`: crate to version.
- Calls: `(Version)-[:HAS_FN]->(:Fn)-[:IS]->(:Symbol)` is a function of a version (the caller),
  `(:Fn)-[:CALLS {copies}]->(:Symbol)-[:IN]->(Crate)` a function it calls. One `Fn` per
  (version, calling function), one `CALLS` per distinct call, one `Symbol` per demangled
  function name, shared by every version. `copies` = compiled (caller, callee) pairs behind the
  call: monomorphised instances of generic functions demangle to the same name.
- A symbol's crate is the first path segment of its name, matched to an existing `Crate`
  (`num_traits` is `num-traits`); the callee version is unknown. Only called symbols have `IN`.
- Before 2026-10-25 calls were `(Version)-[:INVOKES {callsite, target}]->(Crate)`, one edge per
  compiled pair; `painter export-for-import` converts a database of that shape.
- Reach versions through `(:Crate {name})`. `(:Version {name})` without `version` scans every version.

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

Run with `:auto` in the browser. Restore with `painter set-latest-versions`.

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

Any version, up to 3 hops. Large for popular crates.

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

Follows each dependency's latest version, not the version the requirement resolves to.

### Most direct dependents

Scans every `DEPENDS_ON` (minutes).

```cypher
MATCH (v:Version)-[:DEPENDS_ON]->(c:Crate)
RETURN c.name, count(DISTINCT v.name) AS crates
ORDER BY crates DESC LIMIT 10
```

# Function calls

Function names are full demangled paths. Find the exact name first.

### Functions of a crate that are called

```cypher
MATCH (:Crate {name: 'bytes'})<-[:IN]-(s:Symbol)
WHERE s.name CONTAINS 'copy_from_slice'
RETURN s.name, COUNT { (s)<-[:CALLS]-() } AS callers
ORDER BY callers DESC
```

`callers` = calling functions, one per (version, function).

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

A caller's `Symbol` is the same node as that function's callee `Symbol`, so each level is one
more `<-[:CALLS]-(:Fn)-[:IS]->` hop. Change `{1,2}` for more levels.

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

Not version-checked: a hop matches every version that calls a function of that name. The UI
Callers view adds requirement checks and walks up to 10 levels.

### Transitive callers in one crate version

Call chains inside a single version.

```cypher
MATCH (v:Version {name: 'rust-s3', version: '0.37.2'})
MATCH (:Symbol {name: 'bytes::bytes::Bytes::copy_from_slice'})<-[:CALLS]-(f1:Fn)-[:IS]->(c1:Symbol)
WHERE (v)-[:HAS_FN]->(f1)
OPTIONAL MATCH (c1)<-[:CALLS]-(f2:Fn)-[:IS]->(c2:Symbol) WHERE (v)-[:HAS_FN]->(f2)
OPTIONAL MATCH (c2)<-[:CALLS]-(f3:Fn)-[:IS]->(c3:Symbol) WHERE (v)-[:HAS_FN]->(f3)
RETURN DISTINCT c1.name, c2.name, c3.name
```

Each row is one chain, nearest caller first; `null` = chain ends.

# Unsafe

Needs `painter count-unsafe`.

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

Latest version of each dependency.

```cypher
MATCH (:Crate {name: 'rocket'})-[:VERSION_OF]->(v:Version)
WHERE v.latest
MATCH (v)-[:DEPENDS_ON]->(:Crate)-[:VERSION_OF]->(dv:Version)
WHERE dv.latest AND dv.unsafe_total > 0
RETURN dv.name, dv.version, dv.unsafe_total
ORDER BY dv.unsafe_total DESC
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

Scans every relationship (slow); none should repeat.

### Unreferenced symbols

Re-exporting a version deletes its `Fn` nodes but leaves `Symbol`s, which other versions share.
Symbols nothing refers to any more:

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
