CREATE CONSTRAINT const_crate_name IF NOT EXISTS FOR (n:Crate) REQUIRE n.name IS UNIQUE
CREATE INDEX idx_version_name FOR (n:Version) ON (n.name, n.version)
CREATE INDEX idx_invoke FOR ()-[r:INVOKES]-() ON (r.caller, r.callee)
CREATE INDEX idx_is_latest FOR (n:Version) ON (n.latest)

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
 
## transitive depnedencies 
MATCH (v:Version)->[:DEPENDS_ON*]->(c:Crate { name: 'serde')

# clear latest flag
MATCH (v:Version) REMOVE v.latest RETURN v

# Top unsafe
MATCH (v:Version) WHERE v.unsafe_total > 0 RETURN v.name, v.unsafe_total  ORDER BY v.unsafe_total DESC LIMIT 50

# latest version
MATCH (v:Version) WHERE (v.latest = true) RETURN (v) LIMIT 20

# Latest unsafe totals
MATCH (v:Version) WHERE (v.latest = true) AND (v.unsafe_total IS NOT NULL) AND (v.unsafe_total > 0) RETURN COUNT(v)

# Transitive Unsafe
MATCH (v:Version)[:DEPENDS_ON*]->(c:Crate) WHERE (v.latest = true) RETURN COUNT(v) LIMIT 100