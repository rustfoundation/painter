// Deps view: a bounded crate-level dependency tree around one root.
//
// Forward ("dependencies") walks DEPENDS_ON from the root's latest version (or, in `any` mode, the
// precomputed crate-level LOD_DEP edges the Map build aggregates from every version) one level at a
// time; reverse ("dependents") walks LOD_DEP backwards, since popular crates have 10^5 dependents and
// a DEPENDS_ON expansion over them times out, then verifies each candidate against its latest version
// when the mode asks for it. Every level is one query over the whole frontier (Crate.name is unique
// constrained, VERSION_OF fans out to a crate's versions only), so a tree costs depth + 1 queries.
//
// The walk is bounded by a node budget, not an edge cap: when a level would exceed it, the
// highest-downloaded new crates are kept and each parent remembers how many of its children were
// dropped (`hidden`). Crates on the last level report how many children they would have had
// (`unexpanded`), so the client can show "+N" and fetch them on demand with `expand`.

import neo4j from 'neo4j-driver';

export const KINDS = ['normal', 'build', 'dev'];
const KIND_LABELS = { normal: 'Normal', build: 'Build', dev: 'Dev' };

const CHUNK = 250;
/** Candidates per crate for the reverse walk before latest-version verification trims them. */
const REVERSE_CANDIDATES = 400;
/**
 * A reverse level expands crates best-downloaded first while their summed crate-level in-degree stays
 * under this; expanding one crate costs time proportional to its in-degree (serde: 130k, 0.4 s), so
 * a level of 300 popular crates would otherwise take minutes. The rest keep their `+N` count.
 */
const REVERSE_INDEGREE_BUDGET = 60_000;
/** At most this many crates of a reverse frontier are expanded per level (best-downloaded first). */
const REVERSE_FRONTIER_MAX = 50;
/**
 * Candidates per reverse level across the whole frontier. Each candidate costs a version seek plus a
 * DEPENDS_ON check (~1 ms), so a level is bounded to about this many milliseconds.
 */
const REVERSE_CANDIDATES_PER_LEVEL = 1_500;
/**
 * Reverse trees keep at most this many new dependents per crate on level 1, 2, ... (best-downloaded
 * first); popular crates have 10^4-10^5 dependents and a full budget of them is an unreadable grid.
 * The rest stay in the crate's "+N".
 */
const REVERSE_FANOUT = [30, 3];

export const parseKinds = (value) => {
  const wanted = String(value ?? 'normal')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => KINDS.includes(k));
  return wanted.length ? [...new Set(wanted)] : ['normal'];
};

const asBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return value === '1' || value === 'true' || value === true;
};

export const parseDepsQuery = (query, config) => {
  const depthRaw = Number.parseInt(query.depth ?? '', 10);
  const budgetRaw = Number.parseInt(query.limit ?? '', 10);
  return {
    mode: query.mode === 'any' ? 'any' : 'latest',
    direction: query.direction === 'in' ? 'in' : 'out',
    kinds: parseKinds(query.kinds),
    optional: asBool(query.optional, false),
    depth: Number.isFinite(depthRaw) && depthRaw >= 0 ? Math.min(depthRaw, 12) : 2,
    budget:
      Number.isFinite(budgetRaw) && budgetRaw > 0 ? Math.min(budgetRaw, config.depsMaxNodes) : config.depsDefaultNodes,
  };
};

const chunked = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const kindLabels = (kinds) => kinds.map((k) => KIND_LABELS[k]);

/**
 * Binds `v` to crate `a`'s current version: crates.io's default version (registry job,
 * `Crate.default_version`; one seek on the (name, version) constraint) or, when that is unset or its
 * node has not been imported yet, the highest version (`Version.latest`, which needs a VERSION_OF
 * expansion over every version of the crate, ~1.5 ms per crate).
 */
const CURRENT_VERSION = `
  CALL {
    WITH a
    MATCH (v:Version {name: a.name, version: a.default_version}) RETURN v
    UNION
    WITH a
    WITH a WHERE a.default_version IS NULL OR NOT EXISTS { (:Version {name: a.name, version: a.default_version}) }
    MATCH (a)-[:VERSION_OF]->(v:Version {latest: true}) RETURN v
  }`;

/**
 * One forward level: for every crate in `names`, its direct dependencies. Rows are aggregated per
 * (from, to) pair: `kinds` is the set of dependency kinds, `optional` is true only when every
 * declaration is optional, `req` is one of the requirements.
 */
const forwardLevel = async (readRows, names, opts) => {
  const rows = [];
  for (const chunk of chunked(names, CHUNK)) {
    const part =
      opts.mode === 'latest'
        ? await readRows(
            `MATCH (a:Crate) WHERE a.name IN $names
             ${CURRENT_VERSION}
             MATCH (v)-[d:DEPENDS_ON]->(b:Crate)
             WHERE d.kind IN $kinds AND ($optional OR coalesce(d.optional, false) = false)
             WITH a, b, collect(DISTINCT d.kind) AS kinds,
                  min(CASE WHEN coalesce(d.optional, false) THEN 1 ELSE 0 END) = 1 AS optional,
                  collect(DISTINCT d.requirement) AS reqs
             RETURN a.name AS from, b.name AS to, kinds, optional, reqs[0] AS req, null AS versions,
                    b.downloads AS downloads, COUNT { (b)<-[:LOD_DEP]-() } AS dependents`,
            { names: chunk, kinds: kindLabels(opts.kinds), optional: opts.optional },
          )
        : await readRows(
            `MATCH (a:Crate) WHERE a.name IN $names
             MATCH (a)-[r:LOD_DEP]->(b:Crate)
             RETURN a.name AS from, b.name AS to, [] AS kinds, false AS optional, null AS req, r.versions AS versions,
                    b.downloads AS downloads, COUNT { (b)<-[:LOD_DEP]-() } AS dependents`,
            { names: chunk },
          );
    rows.push(...part);
  }
  return rows;
};

/**
 * One reverse level: for every crate in `names`, the crates that depend on it, best-downloaded first.
 * LOD_DEP folds every version, so in `latest` mode each candidate is checked against its latest
 * version and dropped when that version no longer declares the dependency (or only with an excluded
 * kind). `dependents` is the candidate's own in-degree so node sizes mean the same thing both ways.
 */
const reverseLevel = async (readRows, names, opts, perNode) => {
  const rows = [];
  for (const chunk of chunked(names, CHUNK)) {
    const part =
      opts.mode === 'latest'
        ? await readRows(
            `MATCH (c:Crate) WHERE c.name IN $names
             MATCH (c)<-[r:LOD_DEP]-(a:Crate)
             WITH c, a, r ORDER BY coalesce(a.downloads, 0) DESC
             WITH c, collect({a: a, versions: r.versions})[0..$perNode] AS top
             UNWIND top AS t
             WITH c, t.a AS a, t.versions AS versions
             ${CURRENT_VERSION}
             MATCH (v)-[d:DEPENDS_ON]->(c)
             WHERE d.kind IN $kinds AND ($optional OR coalesce(d.optional, false) = false)
             WITH c, a, versions, collect(DISTINCT d.kind) AS kinds,
                  min(CASE WHEN coalesce(d.optional, false) THEN 1 ELSE 0 END) = 1 AS optional,
                  collect(DISTINCT d.requirement) AS reqs
             RETURN a.name AS from, c.name AS to, kinds, optional, reqs[0] AS req, versions,
                    a.downloads AS downloads, COUNT { (a)<-[:LOD_DEP]-() } AS dependents`,
            { names: chunk, perNode: neo4j.int(perNode), kinds: kindLabels(opts.kinds), optional: opts.optional },
          )
        : await readRows(
            `MATCH (c:Crate) WHERE c.name IN $names
             MATCH (c)<-[r:LOD_DEP]-(a:Crate)
             WITH c, a, r ORDER BY coalesce(a.downloads, 0) DESC
             WITH c, collect({a: a, versions: r.versions})[0..$perNode] AS top
             UNWIND top AS t
             WITH c, t.a AS a, t.versions AS versions
             RETURN a.name AS from, c.name AS to, [] AS kinds, false AS optional, null AS req, versions,
                    a.downloads AS downloads, COUNT { (a)<-[:LOD_DEP]-() } AS dependents`,
            { names: chunk, perNode: neo4j.int(perNode) },
          );
    rows.push(...part);
  }
  return rows;
};

/** The crate on the far side of an edge row, as seen from the walk's frontier. */
const other = (row, opts) => (opts.direction === 'out' ? row.to : row.from);
const self = (row, opts) => (opts.direction === 'out' ? row.from : row.to);

const level = (readRows, names, opts, perNode) =>
  opts.direction === 'out' ? forwardLevel(readRows, names, opts) : reverseLevel(readRows, names, opts, perNode);

const rootInfo = async (readRows, name) => {
  const rows = await readRows(
    `MATCH (a:Crate {name: $name})
     ${CURRENT_VERSION}
     WITH a, v LIMIT 1
     OPTIONAL MATCH (v)-[d:DEPENDS_ON]->()
     WITH a, v, d.kind AS kind, coalesce(d.optional, false) AS optional, count(d) AS n
     RETURN a.name AS name, a.downloads AS downloads, COUNT { (a)<-[:LOD_DEP]-() } AS dependents, a.description AS description,
            v.version AS latest, [x IN collect({kind: toLower(kind), optional: optional, n: n}) WHERE x.n > 0] AS declared`,
    { name },
  );
  return rows[0] ?? null;
};

const edgeOf = (row) => ({
  from: row.from,
  to: row.to,
  kinds: (row.kinds ?? []).map((k) => String(k).toLowerCase()),
  optional: row.optional === true,
  req: row.req ?? null,
  versions: row.versions ?? null,
});

/** Reverse walk: the part of a frontier worth expanding within REVERSE_INDEGREE_BUDGET (see above). */
const reverseFrontier = (frontier, nodes) => {
  const ranked = frontier
    .map((name) => nodes.get(name))
    .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0) || a.name.localeCompare(b.name));
  const kept = [];
  let sum = 0;
  for (const n of ranked) {
    if (n.dependents === 0) continue;
    if (kept.length > 0 && sum + n.dependents > REVERSE_INDEGREE_BUDGET) continue;
    sum += n.dependents;
    kept.push(n.name);
    if (kept.length >= REVERSE_FRONTIER_MAX) break;
  }
  return kept;
};

/**
 * Reverse walks only fetch the best-downloaded candidates per crate, but a crate's total crate-level
 * in-degree is known exactly (`dependents`), so "+N" is every dependent not drawn rather than the
 * candidates that happened to be fetched. This also covers the last level and crates the frontier
 * budget skipped. In `latest` mode it is an upper bound: some of those crates only depended on it in
 * older versions.
 */
const fixReverseHidden = (nodes, edges, opts) => {
  if (opts.direction !== 'in') return;
  const shown = new Map();
  for (const e of edges) shown.set(e.to, (shown.get(e.to) ?? 0) + 1);
  for (const n of nodes.values()) {
    n.hidden = Math.max(0, n.dependents - (shown.get(n.name) ?? 0));
    n.unexpanded = 0;
  }
};

/**
 * Breadth-first tree from `root`. Returns `{root, nodes, edges, meta}` where every node has
 * `depth` (hops from the root along kept edges), `downloads`, `dependents` (crate-level in-degree),
 * `hidden` (children dropped by the budget) and `unexpanded` (children beyond max depth).
 */
export const depsTree = async (readRows, root, opts) => {
  const started = Date.now();
  const info = await rootInfo(readRows, root);
  if (!info) return null;

  const nodes = new Map([[root, { name: root, depth: 0, downloads: info.downloads ?? null, dependents: info.dependents ?? 0, hidden: 0, unexpanded: 0 }]]);
  const edges = [];
  const edgeKeys = new Set();
  let frontier = [root];
  let depth = 0;
  let truncated = false;
  let queries = 1;
  const levels = [];

  const addEdge = (row) => {
    const key = `${row.from}\u0000${row.to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edgeOf(row));
  };

  while (frontier.length > 0 && depth < opts.depth) {
    if (opts.direction === 'in' && depth > 0) frontier = reverseFrontier(frontier, nodes);
    if (frontier.length === 0) break;
    // Only `room` new crates can be kept, so fetching many more candidates per crate is wasted work.
    const room = opts.budget - nodes.size;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const levelStarted = Date.now();
    const perNode = Math.min(REVERSE_CANDIDATES, Math.max(20, Math.ceil(room * 1.5)), Math.max(10, Math.ceil(REVERSE_CANDIDATES_PER_LEVEL / frontier.length)));
    let rows = await level(readRows, frontier, opts, perNode);
    queries += 1;
    depth += 1;
    levels.push({
      depth,
      frontier: frontier.length,
      indegree: opts.direction === 'in' ? frontier.reduce((sum, n) => sum + nodes.get(n).dependents, 0) : undefined,
      rows: rows.length,
      elapsedMs: Date.now() - levelStarted,
    });
    if (opts.direction === 'in') {
      const cap = REVERSE_FANOUT[Math.min(depth - 1, REVERSE_FANOUT.length - 1)];
      const perParent = new Map();
      const sorted = [...rows].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
      rows = [];
      for (const row of sorted) {
        if (!nodes.has(other(row, opts))) {
          const count = perParent.get(self(row, opts)) ?? 0;
          if (count >= cap) {
            truncated = true;
            continue;
          }
          perParent.set(self(row, opts), count + 1);
        }
        rows.push(row);
      }
    }
    // New crates this level would introduce, best-downloaded first (ties: most depended-on, then name).
    const fresh = new Map();
    for (const row of rows) {
      const name = other(row, opts);
      if (nodes.has(name) || fresh.has(name)) continue;
      fresh.set(name, { name, depth, downloads: row.downloads ?? null, dependents: row.dependents ?? 0, hidden: 0, unexpanded: 0 });
    }
    let kept = fresh;
    if (fresh.size > room) {
      truncated = true;
      const ranked = [...fresh.values()].sort(
        (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0) || b.dependents - a.dependents || a.name.localeCompare(b.name),
      );
      kept = new Map(ranked.slice(0, Math.max(room, 0)).map((n) => [n.name, n]));
    }
    for (const n of kept.values()) nodes.set(n.name, n);
    for (const row of rows) {
      const name = other(row, opts);
      if (nodes.has(name)) addEdge(row);
      else nodes.get(self(row, opts)).hidden += 1;
    }
    frontier = [...kept.keys()];
    if (frontier.length === 0) break;
  }

  // Children of the last level walked (max depth or a full budget) that were not fetched, so the client can offer to expand them. A reverse
  // walk knows them already: every node's `dependents` is its exact crate-level in-degree.
  if (opts.direction === 'out' && frontier.length > 0) {
    const rows = await level(readRows, frontier, opts, Math.min(REVERSE_CANDIDATES, opts.budget));
    queries += 1;
    for (const row of rows) {
      const name = other(row, opts);
      if (!nodes.has(name)) nodes.get(self(row, opts)).unexpanded += 1;
      else addEdge(row);
    }
  }

  fixReverseHidden(nodes, edges, opts);

  return {
    root,
    rootInfo: { latest: info.latest ?? null, description: info.description ?? null, declared: info.declared ?? [] },
    nodes: [...nodes.values()],
    edges,
    meta: {
      ...opts,
      depthReached: depth,
      nodes: nodes.size,
      edges: edges.length,
      hidden: [...nodes.values()].reduce((s, n) => s + n.hidden, 0),
      unexpanded: [...nodes.values()].reduce((s, n) => s + n.unexpanded, 0),
      truncated,
      queries,
      levels,
      elapsedMs: Date.now() - started,
    },
  };
};

/**
 * One crate's direct neighbours in the walk's direction, every one of them up to `budget`
 * (best-downloaded first), for progressive expansion of a tree the client already holds.
 */
export const depsExpand = async (readRows, name, opts) => {
  const started = Date.now();
  const info = await rootInfo(readRows, name);
  if (!info) return null;
  const rows = await level(readRows, [name], opts, opts.budget);
  const ranked = rows
    .map((row) => ({ row, name: other(row, opts) }))
    .sort((a, b) => (b.row.downloads ?? 0) - (a.row.downloads ?? 0) || (b.row.dependents ?? 0) - (a.row.dependents ?? 0) || a.name.localeCompare(b.name));
  const kept = ranked.slice(0, opts.budget);
  const nodes = new Map(
    kept.map(({ row, name: n }) => [n, { name: n, depth: 1, downloads: row.downloads ?? null, dependents: row.dependents ?? 0, hidden: 0, unexpanded: 0 }]),
  );
  nodes.set(name, { name, depth: 0, downloads: info.downloads ?? null, dependents: info.dependents ?? 0, hidden: Math.max(0, rows.length - kept.length), unexpanded: 0 });
  const edges = kept.map(({ row }) => edgeOf(row));
  // How many children each new crate has in turn, so the client can offer to expand them too.
  if (kept.length > 0 && opts.direction === 'out') {
    const edgeKeys = new Set(edges.map((e) => `${e.from}\u0000${e.to}`));
    const next = await level(readRows, [...nodes.keys()].filter((n) => n !== name), opts, Math.min(REVERSE_CANDIDATES, opts.budget));
    for (const row of next) {
      const target = other(row, opts);
      const key = `${row.from}\u0000${row.to}`;
      if (nodes.has(target)) {
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push(edgeOf(row));
        }
      } else nodes.get(self(row, opts)).unexpanded += 1;
    }
  }
  fixReverseHidden(nodes, edges, opts);
  return {
    root: name,
    nodes: [...nodes.values()],
    edges,
    meta: { ...opts, total: rows.length, truncated: rows.length > kept.length, elapsedMs: Date.now() - started },
  };
};
