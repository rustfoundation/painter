// painter-render: a small HTTP server that
//   1. owns the Neo4j driver (configured from the environment, see config.mjs),
//   2. exposes a read-only JSON API tailored to the painter graph schema,
//   3. serves the built NVL frontend from ../dist.
//
// The browser never talks to Neo4j directly, so credentials stay server side
// and the frontend only needs to know where this server is (same origin).

import express from 'express';
import neo4j from 'neo4j-driver';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config, describeConfig } from './config.mjs';
import { collectGraph } from './graph.mjs';
import { findCallers, normCrate } from './callers.mjs';
import { SORTS as UNSAFE_SORTS, unsafeCrate, unsafeDeps, unsafeStats, unsafeTop } from './unsafe.mjs';
import { createLodJobs } from './lod/jobs.mjs';
import { LodIndex } from './lod/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------
// Neo4j
// ---------------------------------------------------------------------------

const driver = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password), {
  maxConnectionPoolSize: 16,
  connectionAcquisitionTimeout: 10_000,
  disableLosslessIntegers: false,
});

const clampLimit = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, config.neo4j.maxRows);
  return Math.min(n, config.neo4j.maxRows);
};

/** Run a Cypher query in a read transaction and return the collected graph. */
const readGraph = async (cypher, params = {}, { timeoutMs = config.neo4j.queryTimeoutMs } = {}) => {
  const session = driver.session({ database: config.neo4j.database, defaultAccessMode: neo4j.session.READ });
  try {
    const started = Date.now();
    const result = await session.executeRead((tx) => tx.run(cypher, params), { timeout: timeoutMs });
    const elapsedMs = Date.now() - started;
    // Neo4j 5 can end a timed-out read as an empty stream instead of raising
    // TransactionTimedOut; treat "nothing back, took the whole budget" as a timeout.
    if (result.records.length === 0 && elapsedMs >= timeoutMs * 0.95) {
      const err = new Error(`query timed out after ${elapsedMs} ms (limit ${timeoutMs} ms); the database may be busy`);
      err.code = 'Neo.ClientError.Transaction.TransactionTimedOut';
      throw err;
    }
    const graph = collectGraph(result.records);
    return { ...graph, meta: { records: result.records.length, elapsedMs } };
  } finally {
    await session.close();
  }
};

const waitForNeo4j = async () => {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const info = await driver.getServerInfo({ database: config.neo4j.database });
      log(`connected to ${config.neo4j.uri} (${info.agent}, protocol ${info.protocolVersion})`);
      return;
    } catch (err) {
      const retriesLeft = config.neo4j.connectRetries === 0 ? 'unlimited' : config.neo4j.connectRetries - attempt;
      log(`neo4j not reachable at ${config.neo4j.uri} (attempt ${attempt}, retries left: ${retriesLeft}): ${err.message}`);
      if (config.neo4j.connectRetries !== 0 && attempt >= config.neo4j.connectRetries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, config.neo4j.connectRetryDelayMs));
    }
  }
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const api = express.Router();

/** Wrap async handlers so rejections become 500 responses instead of hanging. */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

api.get(
  '/health',
  wrap(async (_req, res) => {
    let server = null;
    let error = null;
    try {
      const info = await driver.getServerInfo({ database: config.neo4j.database });
      server = { agent: info.agent, address: info.address, protocolVersion: info.protocolVersion };
    } catch (err) {
      error = err.message;
    }
    res.status(error ? 503 : 200).json({ ok: !error, error, server, config: describeConfig() });
  }),
);

/** Summary counts, used for the status bar. Cheap with the count store. */
api.get(
  '/stats',
  wrap(async (_req, res) => {
    const g = await readGraph(
      `CALL { MATCH (c:Crate) RETURN count(c) AS crates }
       CALL { MATCH (v:Version) RETURN count(v) AS versions }
       CALL { MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS dependsOn }
       CALL { MATCH ()-[r:CALLS]->() RETURN count(r) AS invokes }
       RETURN crates, versions, dependsOn, invokes`,
    );
    res.json(g.rows[0] ?? {});
  }),
);

/**
 * Crate name search: case-insensitive partial match anywhere in the name.
 * Prefix matches rank first, then shorter names, so "serd" lists serde,
 * serde_json, ... before e.g. "xserde". A TEXT index on Crate.name
 * (docker/queries.md) makes CONTAINS fast; without it this is a label scan.
 */
const searchCrates = async (q, limit) =>
  readGraph(
    `MATCH (c:Crate) WHERE toLower(c.name) CONTAINS $q
     WITH c, toLower(c.name) AS lname
     RETURN c.name AS name
     ORDER BY lname = $q DESC, lname STARTS WITH $q DESC, size(c.name), c.name
     LIMIT $limit`,
    { q, limit: neo4j.int(limit) },
  ).then((g) => g.rows.map((r) => r.name));

/**
 * Resolve user input to a crate name: exact match first, otherwise the best
 * partial match as ranked by searchCrates. Returns null when nothing matches.
 */
const resolveCrateName = async (input) => {
  const q = String(input ?? '').trim();
  if (!q) return null;
  const exact = await readGraph(`MATCH (c:Crate {name: $name}) RETURN c.name AS name LIMIT 1`, { name: q });
  if (exact.rows.length) return exact.rows[0].name;
  const matches = await searchCrates(q.toLowerCase(), 1);
  return matches[0] ?? null;
};

api.get(
  '/crates/search',
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const limit = clampLimit(req.query.limit, 20);
    if (!q) return res.json({ names: [] });
    res.json({ names: await searchCrates(q, limit) });
  }),
);

/**
 * Build a synthetic aggregated INVOKES relationship. The graph stores calls as
 * (Version)-[:HAS_FN]->(:Fn)-[:CALLS]->(:Symbol)-[:IN]->(Crate), far too dense
 * to draw; we collapse them into one edge per (Version, Crate) pair carrying
 * the number of distinct calls and sample target symbols.
 */
const aggregatedInvokes = (fromId, toId, count, targets) => ({
  id: `agg:${fromId}->${toId}:INVOKES`,
  type: 'INVOKES',
  from: fromId,
  to: toId,
  properties: { count, targets, aggregated: true },
});

/**
 * Load a crate with its versions and, optionally, their outgoing DEPENDS_ON
 * and INVOKES edges and incoming dependents. `:name` may be a partial name;
 * it is resolved to the best match and reported back as meta.resolvedName.
 *
 * Query params:
 *   versions   = latest | all            (default latest)
 *   deps       = true | false            (default true)   Version-[:DEPENDS_ON]->Crate
 *   invokes    = true | false            (default true)   calls from a Version into each Crate (aggregated per crate)
 *   dependents = true | false            (default false)  Version-[:DEPENDS_ON]->(this Crate), with their Crate
 *   limit      = per-relationship-type cap (default 200)
 *
 * "latest" prefers `v.latest = true` (set by `painter set-latest-versions`) and
 * otherwise falls back to the highest semver triple.
 */
api.get(
  '/graph/crate/:name',
  wrap(async (req, res) => {
    const requested = String(req.params.name);
    const name = await resolveCrateName(requested);
    if (!name) {
      return res.status(404).json({ error: `no crate matches '${requested}'` });
    }
    const allVersions = req.query.versions === 'all';
    const deps = req.query.deps !== 'false';
    const invokes = req.query.invokes !== 'false';
    const dependents = req.query.dependents === 'true';
    const limit = neo4j.int(clampLimit(req.query.limit, 200));

    // VERSION_OF is created as (Crate)-[:VERSION_OF]->(Version) by db.rs; the
    // README says the opposite, so match it undirected to be safe.
    const g = await readGraph(
      `MATCH (c:Crate {name: $name})
       OPTIONAL MATCH (c)-[:VERSION_OF]-(v:Version)
       WITH c, v
       ORDER BY coalesce(v.latest, false) DESC,
                v.semver_major DESC, v.semver_minor DESC, v.semver_patch DESC,
                coalesce(v.semver_pre, '') = '' DESC, v.version DESC
       WITH c, collect(v) AS vs
       WITH c, CASE WHEN $all THEN vs[0..$limit] ELSE vs[0..1] END AS vs
       UNWIND (CASE WHEN size(vs) = 0 THEN [null] ELSE vs END) AS v
       OPTIONAL MATCH (c)-[vo:VERSION_OF]-(v)
       CALL {
         WITH v
         OPTIONAL MATCH (v)-[d:DEPENDS_ON]->(dc:Crate) WHERE $deps
         RETURN collect({d: d, dc: dc})[0..$limit] AS depsList
       }
       CALL {
         WITH v
         OPTIONAL MATCH (v)-[:HAS_FN]->(:Fn)-[k:CALLS]->(s:Symbol)-[:IN]->(ic:Crate) WHERE $invokes
         WITH ic, count(k) AS n, collect(DISTINCT s.name)[0..10] AS targets
         WHERE ic IS NOT NULL
         WITH ic, n, targets ORDER BY n DESC
         RETURN collect({ic: ic, n: n, targets: targets})[0..$limit] AS invList
       }
       RETURN c, v, vo, depsList, invList`,
      { name, limit, all: allVersions, deps, invokes },
    );

    if (g.nodes.length === 0) {
      return res.status(404).json({ error: `crate '${name}' not found` });
    }
    g.meta.resolvedName = name;

    for (const row of g.rows) {
      if (!row.v) continue;
      for (const inv of row.invList ?? []) {
        if (inv.ic) g.rels.push(aggregatedInvokes(row.v.id, inv.ic.id, inv.n, inv.targets));
      }
    }

    if (dependents) {
      const dep = await readGraph(
        `MATCH (c:Crate {name: $name})<-[d:DEPENDS_ON]-(v:Version)
         WITH c, d, v LIMIT $limit
         OPTIONAL MATCH (v)-[vo:VERSION_OF]-(vc:Crate)
         RETURN c, d, v, vo, vc`,
        { name, limit },
      );
      mergeInto(g, dep);
    }

    res.json(stripRows(g));
  }),
);

/**
 * Expand a node: return its neighbours over the given relationship types.
 * Body: { id: elementId, direction?: 'in'|'out'|'both', types?: string[], limit?: number }
 * INVOKES neighbours (calls from a Version into a Crate, see aggregatedInvokes)
 * are aggregated per crate like in /graph/crate.
 */
api.post(
  '/graph/expand',
  wrap(async (req, res) => {
    const { id, direction = 'both', types = [], limit } = req.body ?? {};
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id (elementId) is required' });
    const allowed = ['VERSION_OF', 'DEPENDS_ON', 'INVOKES'];
    const requested = Array.isArray(types) && types.length ? types.filter((t) => allowed.includes(t)) : allowed;
    const plain = requested.filter((t) => t !== 'INVOKES');
    const cap = neo4j.int(clampLimit(limit, 100));
    const arrow = (body) => (direction === 'out' ? `-[${body}]->` : direction === 'in' ? `<-[${body}]-` : `-[${body}]-`);

    const g = plain.length
      ? await readGraph(
          `MATCH (n) WHERE elementId(n) = $id
           MATCH (n)${arrow(`r:${plain.join('|')}`)}(m)
           RETURN n, r, m LIMIT $limit`,
          { id, limit: cap },
        )
      : { nodes: [], rels: [], rows: [], meta: { records: 0, elapsedMs: 0 } };

    if (requested.includes('INVOKES')) {
      // Calls run Version -> Crate: outgoing from a Version, incoming to a Crate.
      const inv = await readGraph(
        `MATCH (n) WHERE elementId(n) = $id
         CALL {
           WITH n
           MATCH (n:Version)-[:HAS_FN]->(:Fn)-[k:CALLS]->(s:Symbol)-[:IN]->(m:Crate) WHERE $out
           RETURN m, true AS outgoing, count(k) AS cnt, collect(DISTINCT s.name)[0..10] AS targets
           UNION
           WITH n
           MATCH (n:Crate)<-[:IN]-(s:Symbol)<-[k:CALLS]-(:Fn)<-[:HAS_FN]-(m:Version) WHERE $in
           RETURN m, false AS outgoing, count(k) AS cnt, collect(DISTINCT s.name)[0..10] AS targets
         }
         WITH n, m, outgoing, cnt, targets ORDER BY cnt DESC
         RETURN n, m, outgoing, cnt, targets LIMIT $limit`,
        { id, limit: cap, out: direction !== 'in', in: direction !== 'out' },
      );
      for (const row of inv.rows) {
        const [from, to] = row.outgoing ? [row.n.id, row.m.id] : [row.m.id, row.n.id];
        inv.rels.push(aggregatedInvokes(from, to, row.cnt, row.targets));
      }
      mergeInto(g, inv);
    }
    res.json(stripRows(g));
  }),
);

// ---------------------------------------------------------------------------
// Crate-level dependency view
// ---------------------------------------------------------------------------

/**
 * Synthetic crate->crate edge: "some version of `from` depends on `to`".
 * `versions` is how many distinct versions of `from` declare the dependency.
 */
const aggregatedDependsOn = (fromId, toId, versions) => ({
  id: `dep:${fromId}->${toId}`,
  type: 'DEPENDS_ON',
  from: fromId,
  to: toId,
  properties: { versions, aggregated: true },
});

const depsFromRows = (g) => {
  for (const row of g.rows) {
    if (row.a && row.b) g.rels.push(aggregatedDependsOn(row.a.id, row.b.id, row.versions));
  }
  return g;
};

/** In-memory cache for the (expensive) whole-graph query, keyed by limit. Only non-empty results are cached. */
const depsCache = new Map();

/**
 * Total distinct crate->crate pairs. Informational only, so it is computed in
 * the background and never blocks a response: null until known, refreshed
 * after depsCacheMs so it tracks an import in progress.
 */
let depsTotalPairs = { value: null, at: 0, inFlight: null };

const totalCratePairs = () => {
  const stale = Date.now() - depsTotalPairs.at > config.depsCacheMs;
  if (stale && !depsTotalPairs.inFlight) {
    depsTotalPairs.inFlight = readGraph(
      `MATCH (v:Version)-[:DEPENDS_ON]->(b:Crate)
       RETURN count(DISTINCT [v.name, b.name]) AS pairs`,
      {},
      { timeoutMs: config.depsTimeoutMs },
    )
      .then((g) => {
        const pairs = g.rows[0]?.pairs ?? null;
        if (pairs !== null && pairs > 0) depsTotalPairs = { ...depsTotalPairs, value: pairs, at: Date.now() };
      })
      .catch((err) => log(`total crate pairs count failed: ${err.message}`))
      .finally(() => {
        depsTotalPairs.inFlight = null;
      });
  }
  return depsTotalPairs.value;
};

const clampDepsLimit = (value) => {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return config.depsDefaultEdges;
  return Math.min(n, config.depsMaxEdges);
};

/**
 * Crate-level dependency graph: only `(Crate)` nodes and aggregated
 * `DEPENDS_ON` edges. Every version of a crate is folded into the crate, and
 * an edge A->B exists if any version of A depends on B.
 *
 * Query params:
 *   crate     = name (may be partial)   neighbourhood of one crate; omit for the whole graph
 *   direction = out | in | both         (default both; only with `crate`)
 *   limit     = max edges               (default RENDER_DEPS_DEFAULT_EDGES, capped by RENDER_DEPS_MAX_EDGES)
 *
 * Without `crate` the response is the `limit` most-used crate->crate edges
 * (ranked by how many versions declare them), so a capped view still shows
 * the core of the ecosystem. meta.totalPairs reports the uncapped size.
 */
api.get(
  '/graph/deps',
  wrap(async (req, res) => {
    const limit = clampDepsLimit(req.query.limit);
    const crateInput = String(req.query.crate ?? '').trim();

    if (!crateInput) {
      const cached = depsCache.get(limit);
      if (cached && Date.now() - cached.at < config.depsCacheMs) {
        return res.json({ ...cached.payload, meta: { ...cached.payload.meta, cached: true } });
      }
      // Version nodes carry the crate name, so the VERSION_OF hop is unnecessary:
      // group DEPENDS_ON edges by (v.name, b) and resolve the source Crate only
      // for the `limit` winners. This scans every DEPENDS_ON edge once, which is
      // why it gets its own (long) timeout.
      const g = depsFromRows(
        await readGraph(
          `MATCH (v:Version)-[:DEPENDS_ON]->(b:Crate)
           WITH v.name AS aName, b, count(*) AS versions
           ORDER BY versions DESC
           LIMIT $limit
           MATCH (a:Crate {name: aName})
           RETURN a, b, versions`,
          { limit: neo4j.int(limit) },
          { timeoutMs: config.depsTimeoutMs },
        ),
      );
      const totalPairs = totalCratePairs();
      const payload = {
        ...stripRows(g),
        meta: {
          ...g.meta,
          limit,
          totalPairs,
          truncated: g.rels.length >= limit && (totalPairs === null || totalPairs > limit),
        },
      };
      if (g.rels.length > 0) depsCache.set(limit, { at: Date.now(), payload });
      return res.json(payload);
    }

    const name = await resolveCrateName(crateInput);
    if (!name) return res.status(404).json({ error: `no crate matches '${crateInput}'` });
    const direction = req.query.direction === 'out' || req.query.direction === 'in' ? req.query.direction : 'both';
    const cap = neo4j.int(limit);

    const g = await readGraph(`MATCH (c:Crate {name: $name}) RETURN c`, { name });
    if (direction !== 'in') {
      mergeInto(
        g,
        depsFromRows(
          await readGraph(
            `MATCH (a:Crate {name: $name})
             MATCH (v:Version {name: $name})-[:DEPENDS_ON]->(b:Crate)
             WITH a, b, count(*) AS versions
             ORDER BY versions DESC LIMIT $limit
             RETURN a, b, versions`,
            { name, limit: cap },
          ),
        ),
      );
    }
    if (direction !== 'out') {
      mergeInto(
        g,
        depsFromRows(
          await readGraph(
            `MATCH (b:Crate {name: $name})<-[:DEPENDS_ON]-(v:Version)
             WITH b, v.name AS aName, count(*) AS versions
             ORDER BY versions DESC LIMIT $limit
             MATCH (a:Crate {name: aName})
             RETURN a, b, versions`,
            { name, limit: cap },
          ),
        ),
      );
    }
    res.json({ ...stripRows(g), meta: { ...g.meta, limit, resolvedName: name } });
  }),
);

/**
 * Transitive dependency chain, crate level.
 *
 * Query params:
 *   q      = filter text. A crate named exactly `q` is the only root when it
 *            exists. Otherwise, with 3+ characters, every crate whose name
 *            contains `q` (case-insensitive) is a root.
 *   limit  = max edges in the response (default RENDER_DEPS_DEFAULT_EDGES, capped by RENDER_DEPS_MAX_EDGES)
 *   depth  = max hops from the roots, 0 = unlimited (default 0)
 *   exact  = 1 to force an exact name match regardless of length (suggestion picked)
 *
 * Breadth-first from the roots: each level is one query that resolves the
 * crate-level dependencies (any version of A depends on B) of the whole
 * frontier. Stops when the frontier is empty, `depth` is reached, or the edge
 * cap is hit; meta reports which. Root nodes are always included even if
 * they have no dependencies.
 */
api.get(
  '/graph/deps/chain',
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.status(400).json({ error: 'q is required' });
    const limit = clampDepsLimit(req.query.limit);
    const maxDepth = Math.max(0, Number.parseInt(req.query.depth ?? '0', 10) || 0);
    const forceExact = req.query.exact === '1' || req.query.exact === 'true';
    const started = Date.now();

    // Roots: the exact crate if it exists; otherwise all partial matches (3+ chars).
    let rootsGraph = await readGraph(`MATCH (c:Crate {name: $q}) RETURN c`, { q });
    let exact = rootsGraph.nodes.length > 0;
    let partial = false;
    if (!exact && !forceExact && q.length >= 3) {
      partial = true;
      rootsGraph = await readGraph(
        `MATCH (c:Crate) WHERE toLower(c.name) CONTAINS $q RETURN c ORDER BY size(c.name), c.name`,
        { q: q.toLowerCase() },
        { timeoutMs: config.depsTimeoutMs },
      );
    }
    if (rootsGraph.nodes.length === 0) {
      return res.status(404).json({
        error: partial ? `no crate name contains '${q}'` : q.length >= 3 ? `no crate named '${q}'` : `no crate named '${q}' (3+ characters enables partial matching)`,
      });
    }

    const g = { nodes: [...rootsGraph.nodes], rels: [], meta: { records: rootsGraph.meta.records, elapsedMs: 0 } };
    const roots = rootsGraph.nodes.map((n) => n.properties.name);
    const visited = new Set(roots);
    let frontier = roots;
    let depth = 0;
    let truncated = false;

    while (frontier.length > 0 && (maxDepth === 0 || depth < maxDepth)) {
      const remaining = limit - g.rels.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      // Crate.name is unique-constrained (indexed); Version.name is reached via VERSION_OF.
      const level = depsFromRows(
        await readGraph(
          `MATCH (a:Crate) WHERE a.name IN $names
           MATCH (a)-[:VERSION_OF]-(v:Version)-[:DEPENDS_ON]->(b:Crate)
           WITH a, b, count(v) AS versions
           ORDER BY a.name = $q DESC, versions DESC
           RETURN a, b, versions
           LIMIT $limit`,
          { names: frontier, q, limit: neo4j.int(remaining + 1) },
          { timeoutMs: config.depsTimeoutMs },
        ),
      );
      if (level.rels.length > remaining) {
        truncated = true;
        level.rels = level.rels.slice(0, remaining);
        const keep = new Set(level.rels.flatMap((r) => [r.from, r.to]));
        level.nodes = level.nodes.filter((n) => keep.has(n.id));
      }
      mergeInto(g, level);
      depth += 1;
      const next = [];
      for (const n of level.nodes) {
        const name = n.properties.name;
        if (!visited.has(name)) {
          visited.add(name);
          next.push(name);
        }
      }
      frontier = next;
      if (truncated) break;
    }

    res.json({
      ...stripRows(g),
      meta: {
        ...g.meta,
        elapsedMs: Date.now() - started,
        query: q,
        partial,
        exact,
        roots,
        depth,
        maxDepth,
        limit,
        truncated,
        crates: g.nodes.length,
        edges: g.rels.length,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Callers view: reverse call graph over CALLS (see callers.mjs)
// ---------------------------------------------------------------------------

/**
 * A called Symbol is IN the crate named by its path, which spells `my-crate`
 * as `my_crate`; accept either spelling for the callee crate.
 */
const crateSpellings = (name) => [...new Set([name, normCrate(name), name.replace(/_/g, '-')])];

/**
 * Functions of a crate that something calls: Symbols IN it whose name
 * contains `q` (case-insensitive), most-called first (`calls` = distinct
 * calling functions). Names ending in `q` rank first so `spawn` finds
 * `tokio::task::spawn::spawn`.
 */
const searchFunctions = async (crate, q, limit) =>
  readGraph(
    `MATCH (t:Crate) WHERE t.name IN $names
     MATCH (t)<-[:IN]-(s:Symbol)
     WHERE $q = '' OR toLower(s.name) CONTAINS $q
     WITH s.name AS name, COUNT { (s)<-[:CALLS]-() } AS calls
     ORDER BY toLower(name) ENDS WITH $q DESC, calls DESC, size(name)
     RETURN name, calls LIMIT $limit`,
    { names: crateSpellings(crate), q: q.toLowerCase(), limit: neo4j.int(limit) },
  ).then((g) => g.rows);

/** `?crate&q&limit`: function-name suggestions for the Callers view. */
api.get(
  '/functions/search',
  wrap(async (req, res) => {
    const crate = String(req.query.crate ?? '').trim();
    if (!crate) return res.status(400).json({ error: 'crate is required' });
    res.json({ functions: await searchFunctions(crate, String(req.query.q ?? '').trim(), clampLimit(req.query.limit, 20)) });
  }),
);

/** Every version of a crate, newest first (semver triple, then pre-releases last). */
api.get(
  '/crates/:name/versions',
  wrap(async (req, res) => {
    const g = await readGraph(
      `MATCH (c:Crate {name: $name})-[:VERSION_OF]-(v:Version)
       RETURN v.version AS version, coalesce(v.latest, false) AS latest, EXISTS { (v)-[:HAS_FN]->() } AS exported
       ORDER BY v.semver_major DESC, v.semver_minor DESC, v.semver_patch DESC, coalesce(v.semver_pre, '') = '' DESC, v.version DESC`,
      { name: String(req.params.name) },
    );
    res.json({ versions: g.rows });
  }),
);

/**
 * Who calls a function, directly or transitively.
 *
 * Query params:
 *   crate   = crate that defines the function (required)
 *   fn      = function: the full demangled name, or text contained in it (required)
 *   match   = exact | contains   (default contains; contains takes every matching
 *             target into the crate, up to 500)
 *   version = pin the crate version; callers must be that version (same crate) or
 *             declare a DEPENDS_ON requirement that admits it. Empty = any version.
 *   depth   = max call levels to walk outwards (default 3, max 10)
 *   limit   = max rows (default and cap NEO4J_MAX_ROWS)
 */
api.get(
  '/callers',
  wrap(async (req, res) => {
    const crate = String(req.query.crate ?? '').trim();
    const fn = String(req.query.fn ?? '').trim();
    if (!crate || !fn) return res.status(400).json({ error: 'crate and fn are required' });
    const version = String(req.query.version ?? '').trim() || null;
    const exact = req.query.match === 'exact';
    const maxDepth = Math.min(10, Math.max(1, Number.parseInt(req.query.depth ?? '3', 10) || 3));
    const limit = clampLimit(req.query.limit, config.neo4j.maxRows);
    const started = Date.now();

    if (version) {
      const found = await readGraph(`MATCH (c:Crate)-[:VERSION_OF]-(v:Version {version: $version}) WHERE c.name IN $names RETURN v LIMIT 1`, {
        names: crateSpellings(crate),
        version,
      });
      if (!found.nodes.length) return res.status(404).json({ error: `no version ${version} of crate '${crate}'` });
    }

    const targets = exact ? [fn] : (await searchFunctions(crate, fn, 500)).map((f) => f.name);
    if (!targets.length) {
      return res.status(404).json({
        error: `nothing calls a function of '${crate}' containing '${fn}' (calls are only recorded from crate versions painter has exported)`,
      });
    }

    const read = (cypher, params) => readGraph(cypher, params).then((g) => g.rows);
    const result = await findCallers(read, { crate, version, targets, maxDepth, limit });
    res.json({
      rows: result.rows,
      meta: {
        crate,
        version,
        fn,
        exact,
        targets,
        maxDepth,
        depth: result.depth,
        limit,
        truncated: result.truncated,
        exhausted: result.exhausted,
        unverified: result.unverified,
        rejected: result.rejected,
        elapsedMs: Date.now() - started,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Level-of-detail map: precompute jobs
// ---------------------------------------------------------------------------

// In-memory viewport index. Loaded lazily on first use and reloaded after a
// job finishes; `lodState` tells the UI whether a build exists / is loading.
let lodIndex = null;
let lodLoading = null;
let lodLoadError = null;

const loadLodIndex = () => {
  if (lodLoading) return lodLoading;
  lodLoadError = null;
  const started = Date.now();
  log('lod index: loading');
  lodLoading = LodIndex.load(driver, config.neo4j.database, { timeoutMs: config.lod.timeoutMs, maxLevel: config.lod.maxLevel })
    .then((idx) => {
      lodIndex = idx;
      log(idx ? `lod index: ${idx.count.toLocaleString()} crates, ${idx.edgeCount.toLocaleString()} edges in ${Date.now() - started} ms` : 'lod index: no build in database');
      return idx;
    })
    .catch((err) => {
      lodLoadError = err.message;
      log(`lod index: load failed: ${err.message}`);
      throw err;
    })
    .finally(() => {
      lodLoading = null;
    });
  return lodLoading;
};

const lodJobs = createLodJobs({
  config,
  log,
  onFinished: () => {
    lodIndex = null;
    loadLodIndex().catch(() => undefined);
  },
});

/** Resolve the index or send a 503 describing why it is not available. Returns null after responding. */
// ---------------------------------------------------------------------------
// Unsafe view: count-unsafe metrics on Version nodes (see unsafe.mjs)
// ---------------------------------------------------------------------------

const readRows = (cypher, params) => readGraph(cypher, params).then((g) => g.rows);
const unsafeScope = (v) => (v === 'all' ? 'all' : 'latest');
const unsafeTri = (v) => (v === 'yes' || v === 'no' ? v : 'any');
const nonNegInt = (v, fallback = 0) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Stats aggregate every version in scope (seconds for `all`); cache them briefly. */
const unsafeStatsCache = new Map();
const UNSAFE_STATS_TTL_MS = 60_000;

/** `?scope=latest|all`: coverage, totals per category, and an unsafe_total histogram. */
api.get(
  '/unsafe/stats',
  wrap(async (req, res) => {
    const scope = unsafeScope(req.query.scope);
    const hit = unsafeStatsCache.get(scope);
    if (hit && Date.now() - hit.at < UNSAFE_STATS_TTL_MS) return res.json({ ...hit.value, cached: true });
    const started = Date.now();
    const value = { ...(await unsafeStats(readRows, scope)), elapsedMs: Date.now() - started };
    unsafeStatsCache.set(scope, { at: Date.now(), value });
    res.json({ ...value, cached: false });
  }),
);

/**
 * `?scope&sort&dir&q&forbids&build&minLines&minUnsafe&limit&offset`: the leaderboard,
 * ordered and filtered server-side. `sort` is one of unsafe.mjs SORTS.
 */
api.get(
  '/unsafe/top',
  wrap(async (req, res) => {
    const started = Date.now();
    const sort = Object.hasOwn(UNSAFE_SORTS, String(req.query.sort)) ? String(req.query.sort) : 'total';
    const scope = unsafeScope(req.query.scope);
    const result = await unsafeTop(readRows, {
      scope,
      sort,
      desc: req.query.dir !== 'asc',
      q: String(req.query.q ?? '').trim(),
      forbids: unsafeTri(req.query.forbids),
      build: unsafeTri(req.query.build),
      minLines: nonNegInt(req.query.minLines),
      minUnsafe: nonNegInt(req.query.minUnsafe),
      limit: clampLimit(req.query.limit, 100),
      offset: nonNegInt(req.query.offset),
    });
    res.json({ ...result, meta: { elapsedMs: Date.now() - started, sort, scope } });
  }),
);

/** Every version of a crate with its metrics, oldest first. */
api.get(
  '/unsafe/crate/:name',
  wrap(async (req, res) => {
    const name = String(req.params.name);
    res.json({ name, versions: await unsafeCrate(readRows, name) });
  }),
);

/** `?crate&version&depth&limit`: unsafe in a version's dependency closure (version defaults to latest). */
api.get(
  '/unsafe/deps',
  wrap(async (req, res) => {
    const crate = String(req.query.crate ?? '').trim();
    if (!crate) return res.status(400).json({ error: 'crate is required' });
    const started = Date.now();
    const result = await unsafeDeps(readRows, {
      crate,
      version: String(req.query.version ?? '').trim() || null,
      depth: nonNegInt(req.query.depth, 2) || 1,
      limit: clampLimit(req.query.limit, 50),
    });
    if (!result) return res.status(404).json({ error: `no ${req.query.version ? `version ${req.query.version}` : 'latest version'} of crate '${crate}'` });
    res.json({ ...result, meta: { elapsedMs: Date.now() - started } });
  }),
);

const requireLod = async (res) => {
  if (lodIndex) return lodIndex;
  if (!lodLoading) loadLodIndex().catch(() => undefined);
  const running = lodJobs.status().running;
  res.status(503).json({
    error: lodLoadError
      ? `LOD index failed to load: ${lodLoadError}`
      : running
        ? `LOD ${running.kind} in progress (${running.phase})`
        : lodLoading
          ? 'LOD index is loading'
          : 'no LOD build exists; POST /api/lod/rebuild first',
    loading: Boolean(lodLoading),
    running,
  });
  return null;
};

/**
 * Viewport query for the Map view. Query: x0,y0,x1,y1 (layout coords), budget.
 * Returns GraphPayload-shaped nodes (Crate or Cluster) and aggregated DEPENDS_ON rels.
 */
api.get(
  '/lod/viewport',
  wrap(async (req, res) => {
    const idx = await requireLod(res);
    if (!idx) return;
    const num = (k) => Number.parseFloat(req.query[k]);
    const bbox = { x0: num('x0'), y0: num('y0'), x1: num('x1'), y1: num('y1') };
    if (![bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)) {
      // No bbox: the whole map.
      Object.assign(bbox, { x0: idx.bounds.minX, y0: idx.bounds.minY, x1: idx.bounds.maxX, y1: idx.bounds.maxY });
    }
    const budget = Math.max(10, Math.min(Number.parseInt(req.query.budget ?? '', 10) || config.lod.budget, 5000));
    const minCell = Math.max(0, Number.parseFloat(req.query.minCell ?? '') || 0);
    res.json(idx.viewport(bbox, { budget, minCell }));
  }),
);

/** Where a crate sits on the map, for "jump to". 404 if unknown or unpositioned. */
api.get(
  '/lod/locate',
  wrap(async (req, res) => {
    const idx = await requireLod(res);
    if (!idx) return;
    const name = String(req.query.name ?? '').trim();
    const hit = idx.locate(name);
    if (!hit) return res.status(404).json({ error: `crate '${name}' is not on the map` });
    res.json(hit);
  }),
);

/** Name search over positioned crates (in memory; no database round trip). */
api.get(
  '/lod/search',
  wrap(async (req, res) => {
    const idx = await requireLod(res);
    if (!idx) return;
    const q = String(req.query.q ?? '').trim();
    res.json({ names: q ? idx.search(q, clampLimit(req.query.limit, 20)) : [] });
  }),
);

/** Build/update job state plus the persisted LodMeta. */
api.get(
  '/lod/status',
  wrap(async (_req, res) => {
    const meta = (await readGraph(`MATCH (m:LodMeta {id: 'default'}) RETURN properties(m) AS m`)).rows[0]?.m ?? null;
    const unpositioned = (await readGraph(`MATCH (c:Crate) WHERE c.lod_x IS NULL RETURN count(c) AS n`)).rows[0]?.n ?? null;
    // A build run outside this process (CLI, another instance) changes built_at: reload.
    const dbBuiltAt = meta?.built_at ? String(meta.built_at) : null;
    const idxBuiltAt = lodIndex?.meta?.built_at ? String(lodIndex.meta.built_at) : null;
    if (!lodLoading && !lodJobs.status().running && ((lodIndex && dbBuiltAt !== idxBuiltAt) || (!lodIndex && dbBuiltAt))) {
      log(`lod index: build changed (${idxBuiltAt} -> ${dbBuiltAt}), reloading`);
      loadLodIndex().catch(() => undefined);
    }
    res.json({
      ...lodJobs.status(),
      meta,
      unpositionedCrates: unpositioned,
      index: lodIndex ? lodIndex.status() : null,
      indexLoading: Boolean(lodLoading),
      indexError: lodLoadError,
      config: describeConfig().lod,
    });
  }),
);

/**
 * Start a full rebuild (communities + layout + LOD_DEP edges).
 * Body: { iterations?, reuseEdges?: bool (skip aggregation, use stored LOD_DEP), resume?: bool (continue from checkpoint) }.
 * 409 if a job is running.
 */
api.post(
  '/lod/rebuild',
  wrap(async (req, res) => {
    const iterations = Number.parseInt(req.body?.iterations ?? '', 10);
    res.status(202).json(
      lodJobs.rebuild({
        ...(Number.isFinite(iterations) && iterations > 0 ? { iterations } : {}),
        reuseEdges: req.body?.reuseEdges === true,
        resume: req.body?.resume === true,
      }),
    );
  }),
);

/** Place crates added since the last build (cheap, incremental). 409 if a job is running. */
api.post(
  '/lod/update',
  wrap(async (_req, res) => {
    res.status(202).json(lodJobs.update());
  }),
);

/** Fetch a single node (with properties) by elementId. */
api.get(
  '/node/:id',
  wrap(async (req, res) => {
    const g = await readGraph(`MATCH (n) WHERE elementId(n) = $id RETURN n`, { id: req.params.id });
    if (!g.nodes.length) return res.status(404).json({ error: 'not found' });
    res.json(g.nodes[0]);
  }),
);

/** Ad-hoc Cypher. Always a read transaction; result rows are capped. */
api.post(
  '/cypher',
  wrap(async (req, res) => {
    if (!config.allowCypher) return res.status(403).json({ error: 'ad-hoc Cypher is disabled (RENDER_ALLOW_CYPHER=false)' });
    const { query, params = {} } = req.body ?? {};
    if (typeof query !== 'string' || !query.trim()) return res.status(400).json({ error: 'query is required' });
    if (params && typeof params !== 'object') return res.status(400).json({ error: 'params must be an object' });
    const g = await readGraph(query, params);
    if (g.rows.length > config.neo4j.maxRows) {
      g.rows = g.rows.slice(0, config.neo4j.maxRows);
      g.meta.truncated = true;
    }
    res.json(g);
  }),
);

const mergeInto = (target, source) => {
  const nodeIds = new Set(target.nodes.map((n) => n.id));
  const relIds = new Set(target.rels.map((r) => r.id));
  for (const n of source.nodes) if (!nodeIds.has(n.id)) target.nodes.push(n);
  for (const r of source.rels) if (!relIds.has(r.id)) target.rels.push(r);
  target.meta.records += source.meta.records;
  target.meta.elapsedMs += source.meta.elapsedMs;
};

const stripRows = ({ nodes, rels, meta }) => ({ nodes, rels, meta });

app.use('/api', api);

// Error handler: Neo4j errors carry a `code`; surface it so the UI can show it.
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, _req, res, _next) => {
  const status =
    err.status && Number.isInteger(err.status)
      ? err.status
      : err.type === 'entity.parse.failed'
      ? 400
      : err.code === 'Neo.ClientError.Transaction.TransactionTimedOut'
        ? 504
        : err.code?.startsWith('Neo.ClientError')
          ? 400
          : 500;
  log(`api error ${status}: ${err.code ?? ''} ${err.message}`);
  res.status(status).json({ error: err.message, code: err.code ?? null });
});

// Static frontend (production). In development Vite serves the frontend and
// proxies /api to this server, so dist may not exist.
if (existsSync(distDir)) {
  app.use(express.static(distDir, { index: 'index.html', maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res
      .status(200)
      .type('text/plain')
      .send('painter-render API is up, but no frontend build found. Run `npm run build` or use `npm run dev`.\n'),
  );
}

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

log('starting with config', JSON.stringify(describeConfig()));

const server = app.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}`);
});

// Do not block serving on Neo4j being up; the compose stack may start the
// database slower than this container. /api/health reports the real state.
waitForNeo4j().catch((err) => {
  log(`giving up on neo4j: ${err.message}`);
  process.exit(1);
});

const shutdown = async (signal) => {
  log(`received ${signal}, shutting down`);
  server.close();
  await driver.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
