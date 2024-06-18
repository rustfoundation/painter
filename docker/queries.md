```
CREATE CONSTRAINT const_crate_name IF NOT EXISTS FOR (n:Crate) REQUIRE n.name IS UNIQUE
CREATE CONSTRAINT FOR (n:Version) REQUIRE (n.name, n.version) IS UNIQUE
CREATE INDEX idx_invoke FOR ()-[r:INVOKES]-() ON (r.caller, r.callee)
CREATE INDEX idx_is_latest FOR (n:Version) ON (n.latest)
CREATE INDEX idx_unsafe_total FOR (n:Version) ON (n.unsafe_total)
```

### Enterprise Indexes

```
CREATE CONSTRAINT FOR (n:Version) REQUIRE (n.name, n.version) IS NODE KEY
```

# Cleanup

Crates have a unique contrait, cant duplicate

## Find duplicate version entres

Match (n1:Version)
Match (n2:Version) Where id(n1) <> id(n2) and n1.name = n2.name and n1.version = n2.version
RETURN n1, n2

## duplicate relationships

Match (v1:Version)-[d1:DEPENDS_ON]->(c1:Crate) where count(d) > 1

###

MATCH
(n1)-[r]->(n2)
WITH
n1, type(r) as type_r, n2, count(*) as count_r
WHERE
count_r > 1
MATCH
(n1)-[r]->(n2)
WHERE
type(r) = type_r
RETURN
n1, r, n2

## crates, not versions

MATCH (v:Version)-[:DEPENDS_ON*..256]->()<-[:VERSION_OF]-(a:Version)-[:DEPENDS_ON]->(b: Crate { name: 'serde'})
RETURN b.name, count(DISTINCT v) as depends

# Direct Depend

### Versions

MATCH (a)-[:DEPENDS_ON]->(b: Crate { name: 'atomic-counter'})
RETURN b.name, count(a) as versions ORDER BY versions

### Crates

MATCH (c:Crate)<-[:VERSION_OF]-(a)-[:DEPENDS_ON]->(b: Crate { name: 'atomic-counter'})
RETURN a, b, c

MATCH (c:Crate)<-[:VERSION_OF]-(a)-[:DEPENDS_ON]->(b: Crate { name: 'atomic-counter'})
RETURN DISTINCT c.name

## Transitive Dependencies

### Versions

MATCH (v:Version)-[*..100]->(b: Crate { name: 'atomic-counter'})
RETURN b.name, count(DISTINCT v) as depends

### Crates

MATCH (c:Crate)-[:DEPENDS_ON*..256]->(b: Crate { name: 'atomic-counter'})
RETURN DISTINCT c.name

# Top with direct depends

MATCH (a)-[:DEPENDS_ON]->(b)
RETURN b.name, count(a) as versions ORDER BY versions DESC LIMIT 10

# Top with transitive depends

MATCH (a)-[:DEPENDS_ON*..256]->(b)
RETURN b.name, count(a) as versions ORDER BY versions DESC LIMIT 10

# clear latest flag

MATCH (v:Version) REMOVE v.latest RETURN v

# Top unsafe

MATCH (v:Version) WHERE v.unsafe_total > 0 RETURN v.name, v.unsafe_total ORDER BY v.unsafe_total DESC LIMIT 50

# latest version

MATCH (v:Version) WHERE (v.latest = true) RETURN (v) LIMIT 20

# Latest unsafe totals

MATCH (v:Version) WHERE (v.latest = true) AND (v.unsafe_total IS NOT NULL) AND (v.unsafe_total > 0) RETURN COUNT(v)

# Transitive Unsafe

MATCH (v:Version)[:DEPENDS_ON*]->(c:Crate) WHERE (v.latest = true) RETURN COUNT(v) LIMIT 100