import express from 'express';
import neo4j from 'neo4j-driver';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config, describeConfig } from './config.mjs';
import { collectGraph } from './graph.mjs';
import { findCallers, normCrate } from './callers.mjs';
import { SORTS as UNSAFE_SORTS, unsafeCrate, unsafeDeps, unsafeStats, unsafeTop } from './unsafe.mjs';
import {
  BUILD_SORTS,
  DIFF_SORTS,
  NATIVE_SORTS,
  buildCrate,
  buildLinks,
  buildStats,
  buildTop,
  diffCrate,
  diffStats,
  diffTop,
  diffVersion,
  nativeCrate,
  nativeStats,
  nativeTop,
} from './metadata.mjs';
import {
  RELEASE_SORTS,
  RELEASE_SOURCES,
  busFactor,
  crateRegistry,
  dateRange,
  newUploaders,
  ownerAdditions,
  parseInstant,
  publisherLeaderboards,
  registryStats,
  releases,
  releasesHistogram,
  searchUsers,
  userProfile,
  versionPublisher,
} from './registry.mjs';
import { createLodJobs } from './lod/jobs.mjs';
import { LodIndex } from './lod/index.mjs';
import { createDriver, waitForNeo4j } from './db.mjs';
import { STATS_IDS, overviewStats, readStats, readStatsAges } from './stats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');

const log = (...args) => console.log(new Date().toISOString(), ...args);

const driver = createDriver(config);

const clampLimit = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, config.neo4j.maxRows);
  return Math.min(n, config.neo4j.maxRows);
};

const readGraph = async (cypher, params = {}, { timeoutMs = config.neo4j.queryTimeoutMs } = {}) => {
  const session = driver.session({ database: config.neo4j.database, defaultAccessMode: neo4j.session.READ });
  try {
    const started = Date.now();
    const result = await session.executeRead((tx) => tx.run(cypher, params), { timeout: timeoutMs });
    const elapsedMs = Date.now() - started;
    // Neo4j 5 can end a timed-out read as an empty stream instead of raising.
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

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const api = express.Router();

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

// Whole-graph totals live on `Stats` nodes written by the jobs service (server/jobs/index.mjs); a route only
// runs the aggregate itself when no node exists yet (fresh database, jobs service not deployed).
const readRowsPlain = (cypher, params) => readGraph(cypher, params).then((g) => g.rows);
const precomputedStats = (id) => readStats(readRowsPlain, id).catch((err) => {
  log(`stats ${id}: precomputed read failed, computing live: ${err.message}`);
  return null;
});

// Forwards a control request to the jobs service; null when none is configured.
const jobsRequest = async (method, pathname, body) => {
  if (!config.jobsUrl) return null;
  const response = await fetch(`${config.jobsUrl}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
};

const forwardToJobs = (method, pathname) =>
  wrap(async (req, res) => {
    const r = await jobsRequest(method, pathname, method === 'POST' ? req.body ?? {} : undefined);
    if (!r) return res.status(503).json({ error: 'no jobs service configured (RENDER_JOBS_URL); run server/jobs/index.mjs or call it directly', ids: STATS_IDS });
    res.status(r.status).json(r.payload);
  });

api.get(
  '/stats',
  wrap(async (_req, res) => {
    const stored = await precomputedStats('overview');
    if (stored) return res.json(stored);
    const started = Date.now();
    res.json({ ...(await overviewStats(readRowsPlain)), elapsedMs: Date.now() - started, computedAt: null, source: 'live' });
  }),
);

api.get(
  '/stats/status',
  wrap(async (_req, res) => {
    const stored = await readStatsAges(readRowsPlain);
    const jobs = await jobsRequest('GET', '/api/stats/status').catch((err) => ({ status: 503, payload: { error: err.message } }));
    res.json({ ids: STATS_IDS, stored, jobsUrl: config.jobsUrl || null, jobs: jobs?.payload ?? null });
  }),
);

api.post('/stats/refresh', forwardToJobs('POST', '/api/stats/refresh'));

// A TEXT index on Crate.name (docker/queries.md) makes CONTAINS fast; without it this is a label scan.
const searchCrates = async (q, limit) =>
  readGraph(
    `MATCH (c:Crate) WHERE toLower(c.name) CONTAINS $q
     WITH c, toLower(c.name) AS lname
     RETURN c.name AS name
     ORDER BY lname = $q DESC, lname STARTS WITH $q DESC, size(c.name), c.name
     LIMIT $limit`,
    { q, limit: neo4j.int(limit) },
  ).then((g) => g.rows.map((r) => r.name));

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

// Calls are too dense to draw, so collapse them to one edge per (Version, Crate).
const aggregatedInvokes = (fromId, toId, count, targets) => ({
  id: `agg:${fromId}->${toId}:INVOKES`,
  type: 'INVOKES',
  from: fromId,
  to: toId,
  properties: { count, targets, aggregated: true },
});

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

    // db.rs creates (Crate)-[:VERSION_OF]->(Version) but the README says the reverse.
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

api.post(
  '/graph/expand',
  wrap(async (req, res) => {
    const { id, direction = 'both', types = [], limit } = req.body ?? {};
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id (elementId) is required' });
    const allowed = ['VERSION_OF', 'DEPENDS_ON', 'INVOKES', 'OWNS', 'PUBLISHED'];
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

const depsCache = new Map();

// Informational only: computed in the background so it never blocks a response.
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

// Without `crate`, return the most-used edges (by version count) so a capped view still shows the ecosystem core.
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
      // Version nodes carry the crate name, so skip the VERSION_OF hop and resolve the source Crate only
      // for the `limit` winners. Scans every DEPENDS_ON edge once, hence the long timeout.
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

api.get(
  '/graph/deps/chain',
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.status(400).json({ error: 'q is required' });
    const limit = clampDepsLimit(req.query.limit);
    const maxDepth = Math.max(0, Number.parseInt(req.query.depth ?? '0', 10) || 0);
    const forceExact = req.query.exact === '1' || req.query.exact === 'true';
    const started = Date.now();

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
      // Crate.name is unique-constrained (indexed).
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

// Symbol paths spell `my-crate` as `my_crate`; accept either.
const crateSpellings = (name) => [...new Set([name, normCrate(name), name.replace(/_/g, '-')])];

// Names ending in `q` rank first so `spawn` finds `tokio::task::spawn::spawn`.
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

api.get(
  '/functions/search',
  wrap(async (req, res) => {
    const crate = String(req.query.crate ?? '').trim();
    if (!crate) return res.status(400).json({ error: 'crate is required' });
    res.json({ functions: await searchFunctions(crate, String(req.query.q ?? '').trim(), clampLimit(req.query.limit, 20)) });
  }),
);

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

const readRows = (cypher, params) => readGraph(cypher, params).then((g) => g.rows);
/** Label scan of every version; under import load it can exceed the default timeout. */
const readRowsSlow = (cypher, params) => readGraph(cypher, params, { timeoutMs: config.depsTimeoutMs }).then((g) => g.rows);
const unsafeScope = (v) => (v === 'all' ? 'all' : 'latest');
const unsafeTri = (v) => (v === 'yes' || v === 'no' ? v : 'any');
const nonNegInt = (v, fallback = 0) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Live fallback when no `Stats` node exists: aggregates every version in scope (seconds for `all`), so cache it. */
const unsafeStatsCache = new Map();
const UNSAFE_STATS_TTL_MS = 60_000;

api.get(
  '/unsafe/stats',
  wrap(async (req, res) => {
    const scope = unsafeScope(req.query.scope);
    const stored = await precomputedStats(`unsafe:${scope}`);
    if (stored) return res.json({ ...stored, cached: true });
    const hit = unsafeStatsCache.get(scope);
    if (hit && Date.now() - hit.at < UNSAFE_STATS_TTL_MS) return res.json({ ...hit.value, cached: true });
    const started = Date.now();
    const value = { ...(await unsafeStats(readRowsSlow, scope)), elapsedMs: Date.now() - started, computedAt: null, source: 'live' };
    unsafeStatsCache.set(scope, { at: Date.now(), value });
    res.json({ ...value, cached: false });
  }),
);

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

api.get(
  '/unsafe/crate/:name',
  wrap(async (req, res) => {
    const name = String(req.params.name);
    res.json({ name, versions: await unsafeCrate(readRows, name) });
  }),
);

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

const metaStatsCache = new Map();
const META_STATS_TTL_MS = 60_000;

const cachedStats = (key, fn) =>
  wrap(async (req, res) => {
    const scope = unsafeScope(req.query.scope);
    const cacheKey = `${key}:${scope}`;
    const stored = await precomputedStats(cacheKey);
    if (stored) return res.json({ ...stored, cached: true });
    const hit = metaStatsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < META_STATS_TTL_MS) return res.json({ ...hit.value, cached: true });
    const started = Date.now();
    const value = { ...(await fn(readRowsSlow, scope)), elapsedMs: Date.now() - started, computedAt: null, source: 'live' };
    metaStatsCache.set(cacheKey, { at: Date.now(), value });
    res.json({ ...value, cached: false });
  });

const sortKey = (sorts, requested, fallback) => (Object.hasOwn(sorts, String(requested)) ? String(requested) : fallback);

api.get('/build/stats', cachedStats('build', buildStats));

api.get(
  '/build/top',
  wrap(async (req, res) => {
    const started = Date.now();
    const sort = sortKey(BUILD_SORTS, req.query.sort, 'lines');
    const scope = unsafeScope(req.query.scope);
    const result = await buildTop(readRows, {
      scope,
      sort,
      desc: req.query.dir !== 'asc',
      q: String(req.query.q ?? '').trim(),
      links: unsafeTri(req.query.links),
      link: String(req.query.link ?? '').trim(),
      custom: unsafeTri(req.query.custom),
      minLines: nonNegInt(req.query.minLines),
      limit: clampLimit(req.query.limit, 100),
      offset: nonNegInt(req.query.offset),
    });
    res.json({ ...result, meta: { elapsedMs: Date.now() - started, sort, scope } });
  }),
);

api.get(
  '/build/links',
  wrap(async (req, res) => {
    const started = Date.now();
    const rows = await buildLinks(readRows, unsafeScope(req.query.scope), clampLimit(req.query.limit, 50));
    res.json({ rows, meta: { elapsedMs: Date.now() - started } });
  }),
);

api.get(
  '/build/crate/:name',
  wrap(async (req, res) => {
    const name = String(req.params.name);
    res.json({ name, versions: await buildCrate(readRows, name) });
  }),
);

api.get('/native/stats', cachedStats('native', nativeStats));

const NATIVE_LANGS = new Set(['c', 'c++', 'objc', 'asm']);

api.get(
  '/native/top',
  wrap(async (req, res) => {
    const started = Date.now();
    const sort = sortKey(NATIVE_SORTS, req.query.sort, 'lines');
    const scope = unsafeScope(req.query.scope);
    const lang = String(req.query.lang ?? '').trim().toLowerCase();
    const result = await nativeTop(readRows, {
      scope,
      sort,
      desc: req.query.dir !== 'asc',
      q: String(req.query.q ?? '').trim(),
      vendored: unsafeTri(req.query.vendored),
      prebuilt: unsafeTri(req.query.prebuilt),
      lang: NATIVE_LANGS.has(lang) ? lang : '',
      minLines: nonNegInt(req.query.minLines),
      limit: clampLimit(req.query.limit, 100),
      offset: nonNegInt(req.query.offset),
    });
    res.json({ ...result, meta: { elapsedMs: Date.now() - started, sort, scope } });
  }),
);

api.get(
  '/native/crate/:name',
  wrap(async (req, res) => {
    const name = String(req.params.name);
    res.json({ name, versions: await nativeCrate(readRows, name) });
  }),
);

api.get('/diffs/stats', cachedStats('diffs', diffStats));

api.get(
  '/diffs/top',
  wrap(async (req, res) => {
    const started = Date.now();
    const sort = sortKey(DIFF_SORTS, req.query.sort, 'churn');
    const scope = unsafeScope(req.query.scope);
    const firsts = ['exclude', 'include', 'only'].includes(String(req.query.firsts)) ? String(req.query.firsts) : 'exclude';
    const result = await diffTop(readRows, {
      scope,
      sort,
      desc: req.query.dir !== 'asc',
      q: String(req.query.q ?? '').trim(),
      firsts,
      approximate: unsafeTri(req.query.approximate),
      minChurn: nonNegInt(req.query.minChurn),
      limit: clampLimit(req.query.limit, 100),
      offset: nonNegInt(req.query.offset),
    });
    res.json({ ...result, meta: { elapsedMs: Date.now() - started, sort, scope, firsts } });
  }),
);

api.get(
  '/diffs/crate/:name',
  wrap(async (req, res) => {
    const name = String(req.params.name);
    res.json({ name, versions: await diffCrate(readRows, name) });
  }),
);

api.get(
  '/diffs/version',
  wrap(async (req, res) => {
    const crate = String(req.query.crate ?? '').trim();
    const version = String(req.query.version ?? '').trim();
    if (!crate || !version) return res.status(400).json({ error: 'crate and version are required' });
    const result = await diffVersion(readRows, { crate, version });
    if (!result) return res.status(404).json({ error: `no version ${version} of crate '${crate}'` });
    res.json(result);
  }),
);

// Leaderboards and coverage stats aggregate whole relationship types, hence cached.

const REGISTRY_CACHE_TTL_MS = 10 * 60_000;
const registryCache = new Map();

// `statsId` names the precomputed payload (stats.mjs) to prefer; the live path is the fallback.
const cachedRegistry = async (key, fn, statsId = null) => {
  if (statsId) {
    const stored = await precomputedStats(statsId);
    if (stored) return { ...stored, cached: true };
  }
  const hit = registryCache.get(key);
  if (hit && Date.now() - hit.at < REGISTRY_CACHE_TTL_MS) return { ...hit.value, cached: true };
  const started = Date.now();
  const value = { ...(await fn(readRowsSlow)), elapsedMs: Date.now() - started, computedAt: null, source: 'live' };
  registryCache.set(key, { at: Date.now(), value });
  return { ...value, cached: false };
};

api.get(
  '/registry/stats',
  wrap(async (_req, res) => {
    res.json(await cachedRegistry('stats', registryStats, 'registry'));
  }),
);

api.get(
  '/publishers/search',
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ users: [], teams: [] });
    res.json(await searchUsers(readRows, q, clampLimit(req.query.limit, 20)));
  }),
);

api.get(
  '/publishers/user/:login',
  wrap(async (req, res) => {
    const started = Date.now();
    const login = String(req.params.login).trim();
    const profile = await userProfile(readRows, login);
    if (!profile) return res.status(404).json({ error: `no user or team with login '${login}'` });
    res.json({ ...profile, meta: { elapsedMs: Date.now() - started } });
  }),
);

api.get(
  '/publishers/leaderboards',
  wrap(async (_req, res) => {
    res.json(await cachedRegistry('leaderboards', (read) => publisherLeaderboards(read, 100), 'leaderboards'));
  }),
);

const releaseArgs = (query) => {
  const kind = query.kind === 'crates' ? 'crates' : 'versions';
  const sources = RELEASE_SOURCES[kind];
  const source = sources.includes(String(query.source)) ? String(query.source) : sources[0];
  return { kind, source, ...dateRange(query.from, query.to, kind === 'crates' ? 30 : 7) };
};

// Sorting by anything but the date materialises the whole range, so it gets the long timeout.
api.get(
  '/releases',
  wrap(async (req, res) => {
    const started = Date.now();
    const args = releaseArgs(req.query);
    const sort = RELEASE_SORTS.includes(String(req.query.sort)) ? String(req.query.sort) : 'date';
    const result = await releases(sort === 'date' ? readRows : readRowsSlow, {
      ...args,
      sort,
      desc: req.query.dir !== 'asc',
      q: String(req.query.q ?? '').trim(),
      minDownloads: nonNegInt(req.query.minDownloads),
      limit: clampLimit(req.query.limit, 100),
      offset: nonNegInt(req.query.offset),
    });
    res.json({ ...result, meta: { ...args, sort, elapsedMs: Date.now() - started } });
  }),
);

api.get(
  '/releases/histogram',
  wrap(async (req, res) => {
    const args = releaseArgs(req.query);
    res.json(await cachedRegistry(`hist:${args.kind}:${args.source}:${args.from}:${args.to}`, (read) => releasesHistogram(read, args)));
  }),
);

const topN = (v) => Math.min(50_000, Math.max(100, nonNegInt(v, 2000) || 2000));

api.get(
  '/supply/bus-factor',
  wrap(async (req, res) => {
    const started = Date.now();
    const top = topN(req.query.top);
    const result = await busFactor(readRowsSlow, { top, limit: clampLimit(req.query.limit, 100), offset: nonNegInt(req.query.offset) });
    res.json({ ...result, meta: { top, elapsedMs: Date.now() - started } });
  }),
);

api.get(
  '/supply/owner-additions',
  wrap(async (req, res) => {
    const started = Date.now();
    const since = parseInstant(req.query.since, new Date(Date.now() - 180 * 86_400_000).toISOString());
    const self = req.query.self === 'include' ? 'include' : 'exclude';
    const minDownloads = nonNegInt(req.query.minDownloads, 100_000);
    const result = await ownerAdditions(readRowsSlow, { since, minDownloads, self, limit: clampLimit(req.query.limit, 100), offset: nonNegInt(req.query.offset) });
    res.json({ ...result, meta: { since, minDownloads, self, elapsedMs: Date.now() - started } });
  }),
);

api.get(
  '/supply/new-uploaders',
  wrap(async (req, res) => {
    const started = Date.now();
    const top = topN(req.query.top);
    const result = await newUploaders(readRowsSlow, { top, limit: clampLimit(req.query.limit, 100), offset: nonNegInt(req.query.offset) });
    res.json({ ...result, meta: { top, elapsedMs: Date.now() - started } });
  }),
);

api.get(
  '/registry/crate/:name',
  wrap(async (req, res) => {
    const name = String(req.params.name);
    const result = await crateRegistry(readRows, name);
    if (!result) return res.status(404).json({ error: `crate '${name}' not found` });
    res.json(result);
  }),
);

api.get(
  '/registry/version',
  wrap(async (req, res) => {
    const crate = String(req.query.crate ?? '').trim();
    const version = String(req.query.version ?? '').trim();
    if (!crate || !version) return res.status(400).json({ error: 'crate and version are required' });
    const result = await versionPublisher(readRows, { crate, version });
    if (!result) return res.status(404).json({ error: `no version ${version} of crate '${crate}'` });
    res.json(result);
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

api.get(
  '/lod/viewport',
  wrap(async (req, res) => {
    const idx = await requireLod(res);
    if (!idx) return;
    const num = (k) => Number.parseFloat(req.query[k]);
    const bbox = { x0: num('x0'), y0: num('y0'), x1: num('x1'), y1: num('y1') };
    if (![bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)) {
      Object.assign(bbox, { x0: idx.bounds.minX, y0: idx.bounds.minY, x1: idx.bounds.maxX, y1: idx.bounds.maxY });
    }
    const budget = Math.max(10, Math.min(Number.parseInt(req.query.budget ?? '', 10) || config.lod.budget, 5000));
    const minCell = Math.max(0, Number.parseFloat(req.query.minCell ?? '') || 0);
    res.json(idx.viewport(bbox, { budget, minCell }));
  }),
);

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

api.get(
  '/lod/search',
  wrap(async (req, res) => {
    const idx = await requireLod(res);
    if (!idx) return;
    const q = String(req.query.q ?? '').trim();
    res.json({ names: q ? idx.search(q, clampLimit(req.query.limit, 20)) : [] });
  }),
);

api.get(
  '/lod/status',
  wrap(async (_req, res) => {
    const meta = (await readGraph(`MATCH (m:LodMeta {id: 'default'}) RETURN properties(m) AS m`)).rows[0]?.m ?? null;
    const unpositioned = (await readGraph(`MATCH (c:Crate) WHERE c.lod_x IS NULL RETURN count(c) AS n`)).rows[0]?.n ?? null;
    // A build run elsewhere (CLI, another instance) changes built_at.
    const dbBuiltAt = meta?.built_at ? String(meta.built_at) : null;
    const idxBuiltAt = lodIndex?.meta?.built_at ? String(lodIndex.meta.built_at) : null;
    // With a jobs service the worker runs there; its status is what the UI's Rebuild/Update buttons reflect.
    const remote = await jobsRequest('GET', '/api/lod/status').catch((err) => ({ status: 503, payload: { error: err.message } }));
    const jobStatus = remote && remote.status === 200 ? remote.payload : lodJobs.status();
    if (!lodLoading && !jobStatus.running && ((lodIndex && dbBuiltAt !== idxBuiltAt) || (!lodIndex && dbBuiltAt))) {
      log(`lod index: build changed (${idxBuiltAt} -> ${dbBuiltAt}), reloading`);
      loadLodIndex().catch(() => undefined);
    }
    res.json({
      ...jobStatus,
      jobsUrl: config.jobsUrl || null,
      jobsError: remote && remote.status !== 200 ? remote.payload?.error ?? `jobs service returned ${remote.status}` : null,
      meta,
      unpositionedCrates: unpositioned,
      index: lodIndex ? lodIndex.status() : null,
      indexLoading: Boolean(lodLoading),
      indexError: lodLoadError,
      config: describeConfig().lod,
    });
  }),
);

api.post(
  '/lod/rebuild',
  wrap(async (req, res) => {
    const remote = await jobsRequest('POST', '/api/lod/rebuild', req.body ?? {});
    if (remote) return res.status(remote.status).json(remote.payload);
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

api.post(
  '/lod/update',
  wrap(async (req, res) => {
    const remote = await jobsRequest('POST', '/api/lod/update', req.body ?? {});
    if (remote) return res.status(remote.status).json(remote.payload);
    res.status(202).json(lodJobs.update());
  }),
);

api.get(
  '/node/:id',
  wrap(async (req, res) => {
    const g = await readGraph(`MATCH (n) WHERE elementId(n) = $id RETURN n`, { id: req.params.id });
    if (!g.nodes.length) return res.status(404).json({ error: 'not found' });
    res.json(g.nodes[0]);
  }),
);

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

// In development Vite serves the frontend and proxies /api, so dist may not exist.
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

log('starting with config', JSON.stringify(describeConfig()));

const server = app.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}`);
});

// The compose stack may start the database slower than this container; /api/health reports the real state.
waitForNeo4j(driver, config, log)
  .then(() => {
    if (config.jobsUrl) return log(`stats: served from Stats nodes, refreshes forwarded to ${config.jobsUrl}`);
    // Label scan of every version (tens of seconds under import load): warm the cache for the first Publishers visit.
    cachedRegistry('stats', registryStats, 'registry')
      .then((s) => log(`registry stats ${s.source === 'precomputed' ? 'precomputed at ' + s.computedAt : 'warmed in ' + s.elapsedMs + ' ms'}`))
      .catch((err) => log(`registry stats warm-up failed: ${err.message}`));
  })
  .catch((err) => {
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
