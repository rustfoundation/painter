import neo4j from 'neo4j-driver';
import { crateNameScope } from './match.mjs';

// `scope` 'latest' is served by idx_is_latest; 'all' is a label scan (seconds on millions of versions).

export const SORTS = {
  total: 'v.unsafe_total',
  functions: 'v.unsafe_functions',
  exprs: 'v.unsafe_exprs',
  impls: 'v.unsafe_impls',
  traits: 'v.unsafe_traits',
  methods: 'v.unsafe_methods',
  density: 'density',
  share: 'share',
  lines: 'v.rs_lines',
  files: 'v.rs_files',
  forbidFiles: 'v.rs_forbid_files',
  failed: 'v.rs_files_failed',
  name: 'v.name',
};

const RETURN_ROW = `
  RETURN v.name AS name, v.version AS version, coalesce(v.latest, false) AS latest,
         v.unsafe_total AS total,
         v.unsafe_functions AS functions, v.unsafe_exprs AS exprs, v.unsafe_impls AS impls,
         v.unsafe_traits AS traits, v.unsafe_methods AS methods,
         v.safe_functions AS safeFunctions, v.safe_exprs AS safeExprs, v.safe_impls AS safeImpls,
         v.safe_traits AS safeTraits, v.safe_methods AS safeMethods,
         v.rs_files AS files, v.rs_files_failed AS filesFailed, v.rs_lines AS lines, v.rs_bytes AS bytes,
         v.rs_forbid_files AS forbidFiles, v.forbids_unsafe AS forbidsUnsafe,
         coalesce(v.has_build_script, false) AS hasBuildScript,
         v.unsafe_scanner AS scanner, toString(v.unsafe_scanned_at) AS scannedAt, v.unsafe_error AS error,
         density, share`;

const DERIVED = `
  WITH v,
       CASE WHEN v.rs_lines > 0 THEN 1000.0 * v.unsafe_exprs / v.rs_lines ELSE 0.0 END AS density,
       CASE WHEN v.unsafe_exprs + v.safe_exprs > 0
            THEN 1.0 * v.unsafe_exprs / (v.unsafe_exprs + v.safe_exprs) ELSE 0.0 END AS share`;

const scopeClause = (scope) => (scope === 'all' ? 'true' : 'v.latest = true');

// Aggregates every version in scope, so callers should cache it.
export const unsafeStats = async (read, scope) => {
  const rows = await read(
    `MATCH (v:Version) WHERE ${scopeClause(scope)}
     RETURN count(v) AS versions,
            count(v.unsafe_scanner) AS scanned,
            count(v.unsafe_error) AS unreadable,
            count(CASE WHEN v.unsafe_total > 0 THEN 1 END) AS withUnsafe,
            count(CASE WHEN v.forbids_unsafe THEN 1 END) AS forbids,
            count(CASE WHEN v.has_build_script THEN 1 END) AS buildScripts,
            sum(v.unsafe_functions) AS functions, sum(v.unsafe_exprs) AS exprs, sum(v.unsafe_impls) AS impls,
            sum(v.unsafe_traits) AS traits, sum(v.unsafe_methods) AS methods,
            sum(v.safe_functions) AS safeFunctions, sum(v.safe_exprs) AS safeExprs, sum(v.safe_impls) AS safeImpls,
            sum(v.safe_traits) AS safeTraits, sum(v.safe_methods) AS safeMethods,
            sum(v.rs_lines) AS lines, sum(v.rs_files) AS files, sum(v.rs_files_failed) AS filesFailed,
            [count(CASE WHEN v.unsafe_total = 0 THEN 1 END),
             count(CASE WHEN v.unsafe_total >= 1 AND v.unsafe_total <= 10 THEN 1 END),
             count(CASE WHEN v.unsafe_total > 10 AND v.unsafe_total <= 100 THEN 1 END),
             count(CASE WHEN v.unsafe_total > 100 AND v.unsafe_total <= 1000 THEN 1 END),
             count(CASE WHEN v.unsafe_total > 1000 THEN 1 END)] AS histogram`,
  );
  return { scope, ...rows[0] };
};

// Returns one row more than `limit` when more exist (`hasMore`).
export const unsafeTop = async (read, { scope, sort, desc, q, forbids, build, minLines, minUnsafe, limit, offset }) => {
  const ns = await crateNameScope(read, neo4j.int, q);
  const order = SORTS[sort] ?? SORTS.total;
  const rows = await read(
    `${ns.match}
     WHERE ${scopeClause(scope)}
       AND v.unsafe_scanner IS NOT NULL AND v.unsafe_error IS NULL
       AND ${ns.filter}
       AND ($forbids = 'any' OR ($forbids = 'yes' AND v.forbids_unsafe = true)
            OR ($forbids = 'no' AND coalesce(v.forbids_unsafe, false) = false))
       AND ($build = 'any' OR v.has_build_script = ($build = 'yes'))
       AND v.rs_lines >= $minLines
       AND v.unsafe_total >= $minUnsafe
     ${DERIVED}
     ORDER BY ${order} ${desc ? 'DESC' : 'ASC'}, v.name, v.version
     SKIP $offset LIMIT $limit
     ${RETURN_ROW}`,
    { ...ns.params, forbids, build, minLines: neo4j.int(minLines), minUnsafe: neo4j.int(minUnsafe), offset: neo4j.int(offset), limit: neo4j.int(limit + 1) },
  );
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
};

export const unsafeCrate = async (read, name) =>
  read(
    `MATCH (:Crate {name: $name})-[:VERSION_OF]->(v:Version)
     ${DERIVED}
     ORDER BY v.semver_major, v.semver_minor, v.semver_patch, coalesce(v.semver_pre, '') = '', v.version
     ${RETURN_ROW}`,
    { name },
  );

// Dev-dependencies are skipped at every hop; optional ones are included.
export const unsafeDeps = async (read, { crate, version, depth, limit }) => {
  const hops = Math.min(5, Math.max(1, depth)) - 1;
  const [head] = await read(
    `MATCH (:Crate {name: $crate})-[:VERSION_OF]->(v:Version)
     WHERE ($version IS NULL AND v.latest = true) OR v.version = $version
     RETURN v.version AS version LIMIT 1`,
    { crate, version },
  );
  if (!head) return null;
  const rows = await read(
    `MATCH (:Crate {name: $crate})-[:VERSION_OF]->(root:Version {version: $version})
     MATCH (root)-[d0:DEPENDS_ON WHERE d0.kind <> 'dev']->(:Crate)
           ((:Crate)-[:VERSION_OF]->(lv:Version WHERE lv.latest)-[d:DEPENDS_ON WHERE d.kind <> 'dev']->(:Crate)){0,${hops}}
           (dep:Crate)
     WITH DISTINCT dep
     OPTIONAL MATCH (dep)-[:VERSION_OF]->(v:Version) WHERE v.latest = true
     WITH dep, v
     WITH count(dep) AS crates,
          count(v.unsafe_scanner) AS scanned,
          sum(coalesce(v.unsafe_total, 0)) AS total,
          sum(coalesce(v.unsafe_functions, 0)) AS functions, sum(coalesce(v.unsafe_exprs, 0)) AS exprs,
          sum(coalesce(v.unsafe_impls, 0)) AS impls, sum(coalesce(v.unsafe_traits, 0)) AS traits,
          sum(coalesce(v.unsafe_methods, 0)) AS methods, sum(coalesce(v.rs_lines, 0)) AS lines,
          count(CASE WHEN v.forbids_unsafe THEN 1 END) AS forbids,
          count(CASE WHEN v.has_build_script THEN 1 END) AS buildScripts,
          collect({dep: dep, v: v}) AS all
     UNWIND all AS x
     WITH crates, scanned, total, functions, exprs, impls, traits, methods, lines, forbids, buildScripts, x.dep AS dep, x.v AS v
     ORDER BY coalesce(v.unsafe_total, -1) DESC, dep.name
     LIMIT $limit
     RETURN crates, scanned, total, functions, exprs, impls, traits, methods, lines, forbids, buildScripts,
            dep.name AS name, v.version AS version, v.unsafe_total AS depTotal,
            v.unsafe_exprs AS depExprs, v.rs_lines AS depLines, v.forbids_unsafe AS depForbids,
            coalesce(v.has_build_script, false) AS depBuild, v.unsafe_scanner IS NOT NULL AS depScanned`,
    { crate, version: head.version, limit: neo4j.int(limit) },
  );
  const summary = rows[0]
    ? {
        crates: rows[0].crates,
        scanned: rows[0].scanned,
        total: rows[0].total,
        functions: rows[0].functions,
        exprs: rows[0].exprs,
        impls: rows[0].impls,
        traits: rows[0].traits,
        methods: rows[0].methods,
        lines: rows[0].lines,
        forbids: rows[0].forbids,
        buildScripts: rows[0].buildScripts,
      }
    : { crates: 0, scanned: 0, total: 0, functions: 0, exprs: 0, impls: 0, traits: 0, methods: 0, lines: 0, forbids: 0, buildScripts: 0 };
  return {
    crate,
    version: head.version,
    depth: hops + 1,
    summary,
    deps: rows.map((r) => ({
      name: r.name,
      version: r.version,
      total: r.depTotal,
      exprs: r.depExprs,
      lines: r.depLines,
      forbidsUnsafe: r.depForbids,
      hasBuildScript: r.depBuild,
      scanned: r.depScanned,
    })),
  };
};
