// `scope` is 'latest' (idx_is_latest) or 'all' (a label scan, seconds on millions of versions). A generate-metadata
// run may be in progress, so any property can be null; the meta_* markers are what "scanned" means.
import neo4j from 'neo4j-driver';
import { crateNameScope, hasWildcard, wildcardRegex } from './match.mjs';

const scopeClause = (scope) => (scope === 'all' ? 'true' : 'v.latest = true');
const tri = (expr, value) => `($${value} = 'any' OR ($${value} = 'yes' AND ${expr}) OR ($${value} = 'no' AND NOT ${expr}))`;

const SEMVER_ORDER = `ORDER BY v.semver_major, v.semver_minor, v.semver_patch, coalesce(v.semver_pre, '') = '', v.version`;

const page = (rows, limit) => {
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
};

export const BUILD_SORTS = {
  lines: 'v.build_script_lines',
  name: 'v.name',
  path: 'v.build_script',
  links: 'v.links',
  rsLines: 'v.rs_lines',
  unsafe: 'v.unsafe_total',
};

const BUILD_ROW = `
  RETURN v.name AS name, v.version AS version, coalesce(v.latest, false) AS latest,
         v.has_build_script AS hasBuildScript, v.build_script AS path, v.build_script_lines AS lines,
         v.links AS links, v.meta_build AS revision, v.meta_error AS error,
         v.rs_lines AS rsLines, v.unsafe_total AS unsafeTotal,
         coalesce(v.has_native_code, false) AS hasNativeCode, coalesce(v.vendored_native, false) AS vendoredNative`;

// `known` counts versions where has_build_script is set at all (the unsafe scanner stored it before the build job
// existed); `scanned` is the build job's own marker.
export const buildStats = async (read, scope) => {
  const [rows, top] = await Promise.all([
    read(
      `MATCH (v:Version) WHERE ${scopeClause(scope)}
       RETURN count(v) AS versions,
              count(v.meta_build) AS scanned,
              count(v.has_build_script) AS known,
              count(v.meta_error) AS unreadable,
              count(CASE WHEN v.has_build_script THEN 1 END) AS withBuild,
              count(CASE WHEN v.has_build_script AND v.meta_build IS NOT NULL THEN 1 END) AS withBuildScanned,
              count(v.links) AS withLinks,
              count(CASE WHEN v.build_script IS NOT NULL AND v.build_script <> 'build.rs' THEN 1 END) AS custom,
              count(CASE WHEN v.has_build_script AND v.build_script_lines IS NULL AND v.meta_build IS NOT NULL THEN 1 END) AS missingScript,
              sum(v.build_script_lines) AS scriptLines,
              [count(CASE WHEN v.build_script_lines >= 0 AND v.build_script_lines <= 10 THEN 1 END),
               count(CASE WHEN v.build_script_lines > 10 AND v.build_script_lines <= 50 THEN 1 END),
               count(CASE WHEN v.build_script_lines > 50 AND v.build_script_lines <= 200 THEN 1 END),
               count(CASE WHEN v.build_script_lines > 200 AND v.build_script_lines <= 1000 THEN 1 END),
               count(CASE WHEN v.build_script_lines > 1000 THEN 1 END)] AS histogram`,
    ),
    buildLinks(read, scope, 10),
  ]);
  return { scope, ...rows[0], topLinks: top };
};

// idx_version_links makes `links IS NOT NULL` an index scan.
export const buildLinks = async (read, scope, limit) =>
  read(
    `MATCH (v:Version) WHERE v.links IS NOT NULL AND ${scopeClause(scope)}
     WITH v.links AS links, count(v) AS versions, count(DISTINCT v.name) AS crates, collect(DISTINCT v.name)[0..6] AS sample
     ORDER BY crates DESC, versions DESC, links
     RETURN links, versions, crates, sample LIMIT $limit`,
    { limit: neo4j.int(limit) },
  );

export const buildTop = async (read, { scope, sort, desc, q, links, link, custom, minLines, limit, offset }) => {
  const ns = await crateNameScope(read, neo4j.int, q);
  const order = BUILD_SORTS[sort] ?? BUILD_SORTS.lines;
  // An exact `link` name is served by idx_version_links; a `*` / `?` pattern and no link use idx_has_build_script.
  const linkPattern = link && hasWildcard(link);
  const linkClause = !link ? '' : linkPattern ? 'v.links =~ $linkRe AND ' : 'v.links = $link AND ';
  const rows = await read(
    `${ns.match}
     WHERE ${linkClause}v.has_build_script = true AND ${scopeClause(scope)}
       AND v.meta_build IS NOT NULL
       AND ${ns.filter}
       AND ${tri('v.links IS NOT NULL', 'links')}
       AND ${tri("v.build_script <> 'build.rs'", 'custom')}
       AND coalesce(v.build_script_lines, 0) >= $minLines
     WITH v ORDER BY ${order} ${desc ? 'DESC' : 'ASC'}, v.name, v.version
     SKIP $offset LIMIT $limit
     ${BUILD_ROW}`,
    { ...ns.params, links, link, linkRe: linkPattern ? wildcardRegex(link) : null, custom, minLines: neo4j.int(minLines), offset: neo4j.int(offset), limit: neo4j.int(limit + 1) },
  );
  return page(rows, limit);
};

export const buildCrate = async (read, name) =>
  read(`MATCH (:Crate {name: $name})-[:VERSION_OF]->(v:Version) WITH v ${SEMVER_ORDER} ${BUILD_ROW}`, { name });

export const NATIVE_SORTS = {
  lines: 'v.native_lines',
  sourceLines: 'v.native_source_lines',
  files: 'coalesce(v.native_source_files, 0) + coalesce(v.native_header_files, 0)',
  bytes: 'v.native_bytes',
  largest: 'v.native_largest_bytes',
  vendorDirLines: 'v.native_vendor_dir_lines',
  prebuilt: 'v.native_prebuilt_files',
  name: 'v.name',
};

const NATIVE_ROW = `
  RETURN v.name AS name, v.version AS version, coalesce(v.latest, false) AS latest,
         v.has_native_code AS hasNativeCode, v.vendored_native AS vendored,
         v.native_source_files AS sourceFiles, v.native_header_files AS headerFiles,
         v.native_source_lines AS sourceLines, v.native_lines AS lines, v.native_bytes AS bytes,
         v.native_largest_bytes AS largestBytes, v.native_vendor_dir_lines AS vendorDirLines,
         coalesce(v.native_langs, []) AS langs, coalesce(v.native_dirs, []) AS dirs,
         v.native_prebuilt_files AS prebuilt, v.meta_native AS revision, v.meta_error AS error,
         coalesce(v.has_build_script, false) AS hasBuildScript, v.links AS links`;

// Only the coverage counts scan every version; the totals use idx_has_native_code (a few hundred to few thousand nodes).
export const nativeStats = async (read, scope) => {
  const [coverage, rows, langs, dirs] = await Promise.all([
    read(
      `MATCH (v:Version) WHERE ${scopeClause(scope)}
       RETURN count(v) AS versions, count(v.meta_native) AS scanned, count(v.meta_error) AS unreadable`,
    ),
    read(
      `MATCH (v:Version) WHERE v.has_native_code = true AND ${scopeClause(scope)}
       RETURN count(v) AS withNative,
              count(CASE WHEN v.vendored_native THEN 1 END) AS vendored,
              count(CASE WHEN v.native_prebuilt_files > 0 THEN 1 END) AS withPrebuilt,
              count(CASE WHEN v.has_native_code AND v.has_build_script THEN 1 END) AS nativeWithBuild,
              count(CASE WHEN v.has_native_code AND v.links IS NOT NULL THEN 1 END) AS nativeWithLinks,
              sum(v.native_source_files) AS sourceFiles, sum(v.native_header_files) AS headerFiles,
              sum(v.native_source_lines) AS sourceLines, sum(v.native_lines) AS lines,
              sum(v.native_bytes) AS bytes, sum(v.native_prebuilt_files) AS prebuiltFiles,
              [count(CASE WHEN v.native_lines >= 1 AND v.native_lines <= 100 THEN 1 END),
               count(CASE WHEN v.native_lines > 100 AND v.native_lines <= 1000 THEN 1 END),
               count(CASE WHEN v.native_lines > 1000 AND v.native_lines <= 10000 THEN 1 END),
               count(CASE WHEN v.native_lines > 10000 AND v.native_lines <= 100000 THEN 1 END),
               count(CASE WHEN v.native_lines > 100000 THEN 1 END)] AS histogram`,
    ),
    read(
      `MATCH (v:Version) WHERE v.has_native_code = true AND ${scopeClause(scope)}
       UNWIND v.native_langs AS lang
       WITH lang, count(v) AS versions, count(DISTINCT v.name) AS crates, sum(v.native_lines) AS lines
       RETURN lang, versions, crates, lines ORDER BY versions DESC`,
    ),
    read(
      `MATCH (v:Version) WHERE v.has_native_code = true AND ${scopeClause(scope)}
       UNWIND v.native_dirs AS dir
       WITH dir, count(v) AS versions, count(DISTINCT v.name) AS crates
       RETURN dir, versions, crates ORDER BY crates DESC, dir LIMIT 12`,
    ),
  ]);
  return { scope, ...coverage[0], ...rows[0], langs, dirs };
};

export const nativeTop = async (read, { scope, sort, desc, q, vendored, prebuilt, lang, minLines, limit, offset }) => {
  const ns = await crateNameScope(read, neo4j.int, q);
  const order = NATIVE_SORTS[sort] ?? NATIVE_SORTS.lines;
  const rows = await read(
    `${ns.match}
     WHERE v.has_native_code = true AND ${scopeClause(scope)}
       AND ${ns.filter}
       AND ${tri('v.vendored_native = true', 'vendored')}
       AND ${tri('v.native_prebuilt_files > 0', 'prebuilt')}
       AND ($lang = '' OR $lang IN coalesce(v.native_langs, []))
       AND coalesce(v.native_lines, 0) >= $minLines
     WITH v ORDER BY ${order} ${desc ? 'DESC' : 'ASC'}, v.name, v.version
     SKIP $offset LIMIT $limit
     ${NATIVE_ROW}`,
    { ...ns.params, vendored, prebuilt, lang, minLines: neo4j.int(minLines), offset: neo4j.int(offset), limit: neo4j.int(limit + 1) },
  );
  return page(rows, limit);
};

export const nativeCrate = async (read, name) =>
  read(`MATCH (:Crate {name: $name})-[:VERSION_OF]->(v:Version) WITH v ${SEMVER_ORDER} ${NATIVE_ROW}`, { name });

export const DIFF_SORTS = {
  churn: 'churn',
  added: 'v.diff_lines_added',
  removed: 'v.diff_lines_removed',
  filesChanged: 'filesChanged',
  filesAdded: 'v.diff_files_added',
  filesRemoved: 'v.diff_files_removed',
  filesModified: 'v.diff_files_modified',
  filesTotal: 'v.diff_files_total',
  name: 'v.name',
};

const DIFF_DERIVED = `
  WITH v,
       coalesce(v.diff_lines_added, 0) + coalesce(v.diff_lines_removed, 0) AS churn,
       coalesce(v.diff_files_added, 0) + coalesce(v.diff_files_removed, 0) + coalesce(v.diff_files_modified, 0) AS filesChanged`;

const DIFF_ROW = `
  RETURN v.name AS name, v.version AS version, coalesce(v.latest, false) AS latest,
         v.diff_base AS base, v.diff_files_added AS filesAdded, v.diff_files_removed AS filesRemoved,
         v.diff_files_modified AS filesModified, v.diff_files_total AS filesTotal,
         v.diff_lines_added AS linesAdded, v.diff_lines_removed AS linesRemoved,
         v.diff_approximate AS approximate, v.meta_diff AS revision, v.meta_error AS error,
         churn, filesChanged, v.rs_lines AS rsLines`;

export const diffStats = async (read, scope) => {
  const rows = await read(
    `MATCH (v:Version) WHERE ${scopeClause(scope)}
     RETURN count(v) AS versions,
            count(v.meta_diff) AS scanned,
            count(v.meta_error) AS unreadable,
            count(CASE WHEN v.meta_diff IS NOT NULL AND v.diff_base IS NULL THEN 1 END) AS firsts,
            count(CASE WHEN v.diff_approximate THEN 1 END) AS approximate,
            count(CASE WHEN v.diff_base IS NOT NULL AND v.diff_files_added + v.diff_files_removed + v.diff_files_modified = 0 THEN 1 END) AS unchanged,
            sum(CASE WHEN v.diff_base IS NOT NULL THEN v.diff_lines_added END) AS linesAdded,
            sum(CASE WHEN v.diff_base IS NOT NULL THEN v.diff_lines_removed END) AS linesRemoved,
            sum(CASE WHEN v.diff_base IS NOT NULL THEN v.diff_files_added END) AS filesAdded,
            sum(CASE WHEN v.diff_base IS NOT NULL THEN v.diff_files_removed END) AS filesRemoved,
            sum(CASE WHEN v.diff_base IS NOT NULL THEN v.diff_files_modified END) AS filesModified,
            sum(v.diff_files_total) AS filesTotal,
            [count(CASE WHEN v.diff_base IS NOT NULL AND v.diff_lines_added + v.diff_lines_removed = 0 THEN 1 END),
             count(CASE WHEN v.diff_base IS NOT NULL AND v.diff_lines_added + v.diff_lines_removed >= 1 AND v.diff_lines_added + v.diff_lines_removed <= 10 THEN 1 END),
             count(CASE WHEN v.diff_base IS NOT NULL AND v.diff_lines_added + v.diff_lines_removed > 10 AND v.diff_lines_added + v.diff_lines_removed <= 100 THEN 1 END),
             count(CASE WHEN v.diff_base IS NOT NULL AND v.diff_lines_added + v.diff_lines_removed > 100 AND v.diff_lines_added + v.diff_lines_removed <= 1000 THEN 1 END),
             count(CASE WHEN v.diff_base IS NOT NULL AND v.diff_lines_added + v.diff_lines_removed > 1000 AND v.diff_lines_added + v.diff_lines_removed <= 10000 THEN 1 END),
             count(CASE WHEN v.diff_base IS NOT NULL AND v.diff_lines_added + v.diff_lines_removed > 10000 THEN 1 END)] AS histogram`,
  );
  return { scope, ...rows[0] };
};

// Sorting by `added` is index-backed (idx_diff_lines_added); the computed sorts walk every scanned version in scope.
export const diffTop = async (read, { scope, sort, desc, q, firsts, approximate, minChurn, limit, offset }) => {
  const ns = await crateNameScope(read, neo4j.int, q);
  const order = DIFF_SORTS[sort] ?? DIFF_SORTS.churn;
  const firstsClause = firsts === 'include' ? 'true' : firsts === 'only' ? 'v.diff_base IS NULL' : 'v.diff_base IS NOT NULL';
  const rows = await read(
    `${ns.match}
     WHERE ${scopeClause(scope)}
       AND v.meta_diff IS NOT NULL
       AND ${firstsClause}
       AND ${ns.filter}
       AND ${tri('v.diff_approximate = true', 'approximate')}
     ${DIFF_DERIVED}
     WHERE churn >= $minChurn
     WITH v, churn, filesChanged
     ORDER BY ${order} ${desc ? 'DESC' : 'ASC'}, v.name, v.version
     SKIP $offset LIMIT $limit
     ${DIFF_ROW}`,
    { ...ns.params, approximate, minChurn: neo4j.int(minChurn), offset: neo4j.int(offset), limit: neo4j.int(limit + 1) },
  );
  return page(rows, limit);
};

export const diffCrate = async (read, name) =>
  read(`MATCH (:Crate {name: $name})-[:VERSION_OF]->(v:Version) ${DIFF_DERIVED} ${SEMVER_ORDER} ${DIFF_ROW}`, { name });

// `files` is null when the diff job has not run on the version yet.
export const diffVersion = async (read, { crate, version }) => {
  const [row] = await read(
    `MATCH (:Crate {name: $crate})-[:VERSION_OF]->(v:Version {version: $version})
     ${DIFF_DERIVED}
     WITH v, churn, filesChanged,
          v.diff_paths AS paths, v.diff_status AS status, v.diff_added AS added, v.diff_removed AS removed, v.diff_binary AS binary
     ${DIFF_ROW}, paths, status, added, removed, binary`,
    { crate, version },
  );
  if (!row) return null;
  const { paths, status, added, removed, binary, ...rest } = row;
  const files = Array.isArray(paths)
    ? paths.map((path, i) => ({ path, status: status?.[i] ?? null, added: added?.[i] ?? 0, removed: removed?.[i] ?? 0, binary: binary?.[i] === true }))
    : null;
  files?.sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path));
  return { ...rest, files };
};
