# Setup

Run before the first import.

```cypher
CREATE CONSTRAINT const_crate_name IF NOT EXISTS FOR (n:Crate) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT const_version IF NOT EXISTS FOR (n:Version) REQUIRE (n.name, n.version) IS UNIQUE;
CREATE INDEX idx_invoke IF NOT EXISTS FOR ()-[r:INVOKES]-() ON (r.callsite, r.target);
CREATE INDEX idx_invoke_target IF NOT EXISTS FOR ()-[r:INVOKES]-() ON (r.target);
CREATE TEXT INDEX idx_invoke_target_text IF NOT EXISTS FOR ()-[r:INVOKES]-() ON (r.target);
CREATE INDEX idx_is_latest IF NOT EXISTS FOR (n:Version) ON (n.latest);
CREATE INDEX idx_unsafe_total IF NOT EXISTS FOR (n:Version) ON (n.unsafe_total);
CREATE TEXT INDEX idx_crate_name_text IF NOT EXISTS FOR (n:Crate) ON (n.name);
```

- `idx_invoke_target`: function lookups below and the UI Callers view.
- `idx_crate_name_text`: UI partial-name search.
- Map build adds `crate_lod_x`, `crate_lod_community`, `Crate.lod_*`, `LOD_DEP` (see `render/README.md`).

Enterprise only:

```cypher
CREATE CONSTRAINT FOR (n:Version) REQUIRE (n.name, n.version) IS NODE KEY;
```

# Schema notes

- `(Crate)-[:VERSION_OF]->(Version)`: crate to version.
- `(Version)-[:INVOKES {callsite, target}]->(Crate)`: one edge per call site. Callee crate is the first path segment of `target`; callee version unknown.
- Callee crate uses the symbol spelling: calls into `actix-web` point at `actix_web`.
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

`target` is the full demangled name. Find it first.

### Functions of a crate that are called

```cypher
MATCH (:Crate {name: 'bytes'})<-[i:INVOKES]-(:Version)
WHERE i.target CONTAINS 'copy_from_slice'
RETURN i.target, count(*) AS calls
ORDER BY calls DESC
```

### What a version calls

```cypher
MATCH (:Version {name: 'rocket', version: '0.5.1'})-[i:INVOKES]->(c:Crate)
RETURN c.name, count(*) AS calls
ORDER BY calls DESC
```

```cypher
MATCH (:Version {name: 'rocket', version: '0.5.1'})-[i:INVOKES]->(:Crate {name: 'tokio'})
RETURN i.callsite, i.target
```

### All direct callers of a function

```cypher
MATCH (v:Version)-[i:INVOKES]->(:Crate)
WHERE i.target = 'bytes::bytes::Bytes::copy_from_slice'
RETURN v.name, v.version, i.callsite
```

Per caller version:

```cypher
MATCH (v:Version)-[i:INVOKES]->(:Crate)
WHERE i.target = 'bytes::bytes::Bytes::copy_from_slice'
RETURN v.name, v.version, count(*) AS callsites
ORDER BY callsites DESC
```

With the caller's requirement on the callee crate (empty = no direct dependency):

```cypher
MATCH (v:Version)-[i:INVOKES]->(c:Crate)
WHERE i.target = 'bytes::bytes::Bytes::copy_from_slice'
OPTIONAL MATCH (v)-[d:DEPENDS_ON]->(c)
RETURN v.name, v.version, i.callsite, collect(DISTINCT d.requirement) AS requirement
```

### Direct callers in one crate version

```cypher
MATCH (v:Version {name: 'rust-s3', version: '0.37.2'})-[i:INVOKES]->(:Crate)
WHERE i.target = 'bytes::bytes::Bytes::copy_from_slice'
RETURN i.callsite
```

### Transitive callers, all sources

Each hop: callers of the previous hop's `callsite`. Add a `MATCH` per extra level. 2 levels: ~20 s.

```cypher
MATCH (v1:Version)-[i1:INVOKES]->(:Crate)
WHERE i1.target = 'bytes::bytes::Bytes::copy_from_slice'
MATCH (v2:Version)-[i2:INVOKES]->(:Crate)
WHERE i2.target = i1.callsite
RETURN DISTINCT v2.name, v2.version, i2.callsite, i1.callsite AS via
LIMIT 500
```

3 levels (slow: ~7 min for this function; prefer the UI Callers view):

```cypher
MATCH (v1:Version)-[i1:INVOKES]->(:Crate)
WHERE i1.target = 'bytes::bytes::Bytes::copy_from_slice'
MATCH (v2:Version)-[i2:INVOKES]->(:Crate)
WHERE i2.target = i1.callsite
MATCH (v3:Version)-[i3:INVOKES]->(:Crate)
WHERE i3.target = i2.callsite
RETURN DISTINCT v3.name, v3.version, i3.callsite, [i2.callsite, i1.callsite] AS via
LIMIT 500
```

Not version-checked: a hop matches every version that calls a function of that name. The UI Callers view adds requirement checks and walks up to 10 levels.

### Transitive callers in one crate version

Call chains inside a single version.

```cypher
MATCH (v:Version {name: 'rust-s3', version: '0.37.2'})-[i1:INVOKES]->(:Crate)
WHERE i1.target = 'bytes::bytes::Bytes::copy_from_slice'
OPTIONAL MATCH (v)-[i2:INVOKES]->(:Crate)
WHERE i2.target = i1.callsite
OPTIONAL MATCH (v)-[i3:INVOKES]->(:Crate)
WHERE i3.target = i2.callsite
RETURN DISTINCT i1.callsite, i2.callsite, i3.callsite
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
WHERE n > 1 AND type <> 'INVOKES'
RETURN a, type, b, n
LIMIT 100
```

`INVOKES` repeats per call site by design.

### Drop the Map precompute

```cypher
MATCH ()-[r:LOD_DEP]->()
CALL { WITH r DELETE r } IN TRANSACTIONS OF 10000 ROWS;
MATCH (c:Crate) WHERE c.lod_x IS NOT NULL
CALL { WITH c REMOVE c.lod_x, c.lod_y, c.lod_community, c.lod_degree } IN TRANSACTIONS OF 10000 ROWS;
```
