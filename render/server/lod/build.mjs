// Level-of-detail precompute pipeline.
//
// Full build (`runBuild`):
//   1. aggregate  (Version)-[:DEPENDS_ON]->(Crate) into crate-level edges
//   2. edges      persist them as (Crate)-[:LOD_DEP {versions}]->(Crate)
//   3. graph      build an undirected graphology graph over all crates
//   4. communities Louvain community detection (semantic grouping / colours)
//   5. layout     ForceAtlas2 (Barnes-Hut) seeded by community, isolated
//                 crates on an outer ring
//   6. positions  persist Crate.lod_x / lod_y / lod_community / lod_degree
//   7. meta       (:LodMeta {id:'default'}) with counts, bounds, timings
//
// Incremental update (`runUpdate`): crates that have no position yet (added by
// an import after the last build) get their crate-level edges aggregated from
// DEPENDS_ON, persisted as LOD_DEP, and are placed at the centroid of their
// already-positioned neighbours with the majority community. Cheap, keeps the
// map usable between full rebuilds; it does not move existing crates.
//
// Both are pure functions over a driver so they can run in a worker thread or
// from the CLI. Progress is reported through `onProgress({phase, done, total, message})`.

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import neo4j from 'neo4j-driver';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  aggregateDependsOn,
  createLodEdges,
  deleteLodEdges,
  ensureLodIndexes,
  loadLodGraph,
  loadLodPositions,
  readRows,
  streamRead,
  writeLodMeta,
  writeLodPositions,
} from './neo4j-io.mjs';

const SPLIT = '\u0000';

/** Deterministic pseudo-random in [0,1) from a string, for stable jitter and seeding. */
const hash01 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_003) / 1_000_003;
};

/**
 * Build the graphology graph from `names` and `[aIdx, bIdx, versions]` edges.
 * Undirected with summed weights: Louvain and ForceAtlas2 both want that.
 */
export const buildGraph = (names, edges) => {
  const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  for (const name of names) graph.addNode(name);
  for (const [a, b, n] of edges) {
    if (a === b) continue;
    const na = names[a];
    const nb = names[b];
    const w = 1 + Math.log2(n);
    if (graph.hasEdge(na, nb)) graph.updateEdgeAttribute(na, nb, 'weight', (x) => x + w);
    else graph.addEdge(na, nb, { weight: w });
  }
  return graph;
};

/**
 * Seed positions: connected crates by community on a circle (so ForceAtlas2
 * starts near its answer), isolated crates on an outer ring sorted by name.
 * Returns the number of isolated crates.
 */
const seedPositions = (graph, communities) => {
  const connected = [];
  const isolated = [];
  graph.forEachNode((n) => (graph.degree(n) === 0 ? isolated : connected).push(n));

  const communityIds = [...new Set(connected.map((n) => communities[n]))];
  const communityAngle = new Map(communityIds.map((c, i) => [c, (2 * Math.PI * i) / Math.max(1, communityIds.length)]));
  const r0 = Math.sqrt(connected.length) * 10;
  for (const n of connected) {
    const a = communityAngle.get(communities[n]) + (hash01(n) - 0.5) * 0.4;
    const r = r0 * (0.6 + 0.4 * hash01(n + '|r'));
    graph.setNodeAttribute(n, 'x', Math.cos(a) * r);
    graph.setNodeAttribute(n, 'y', Math.sin(a) * r);
  }
  isolated.sort();
  const rIso = r0 * 2.2;
  isolated.forEach((n, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, isolated.length);
    const r = rIso * (1 + 0.15 * hash01(n));
    graph.setNodeAttribute(n, 'x', Math.cos(a) * r);
    graph.setNodeAttribute(n, 'y', Math.sin(a) * r);
    graph.setNodeAttribute(n, 'fixed', true);
  });
  return isolated.length;
};

/**
 * Run ForceAtlas2 on the connected part only (isolated crates keep their ring
 * position), in rounds so progress can be reported.
 */
/**
 * Checkpoint file: `{ iterationsDone, positions: { name: [x, y] } }`. Written
 * atomically (tmp + rename) so a crash mid-write never leaves a torn file.
 */
const writeCheckpoint = (path, iterationsDone, graph) => {
  const positions = {};
  graph.forEachNode((n, a) => {
    positions[n] = [a.x, a.y];
  });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ iterationsDone, savedAt: new Date().toISOString(), positions }));
  renameSync(tmp, path);
};

const readCheckpoint = (path) => {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const layout = (graph, { iterations, startIteration = 0, checkpointPath, checkpointEvery = 20, onProgress, log = () => {} }) => {
  const sub = graph.copy();
  sub.forEachNode((n) => {
    if (sub.degree(n) === 0) sub.dropNode(n);
  });
  const settings = {
    ...forceAtlas2.inferSettings(sub),
    barnesHutOptimize: true,
    barnesHutTheta: 0.6,
    strongGravityMode: false,
    gravity: 1,
    scalingRatio: 10,
    slowDown: 1 + Math.log(sub.order),
    linLogMode: false,
    outboundAttractionDistribution: true,
    adjustSizes: false,
    edgeWeightInfluence: 1,
  };
  const round = 10;
  let sinceCheckpoint = 0;
  const copyBack = () =>
    sub.forEachNode((n, attrs) => {
      graph.setNodeAttribute(n, 'x', attrs.x);
      graph.setNodeAttribute(n, 'y', attrs.y);
    });
  for (let done = startIteration; done < iterations; done += round) {
    const step = Math.min(round, iterations - done);
    forceAtlas2.assign(sub, { iterations: step, settings });
    sinceCheckpoint += step;
    const now = Math.min(done + round, iterations);
    onProgress?.({ phase: 'layout', done: now, total: iterations });
    if (checkpointPath && sinceCheckpoint >= checkpointEvery && now < iterations) {
      copyBack();
      writeCheckpoint(checkpointPath, now, graph);
      log(`layout: checkpoint at iteration ${now} -> ${checkpointPath}`);
      sinceCheckpoint = 0;
    }
  }
  copyBack();
};

const bounds = (rows) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rows) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x > maxX) maxX = r.x;
    if (r.y > maxY) maxY = r.y;
  }
  return { minX, minY, maxX, maxY };
};

/**
 * Full rebuild. `opts.iterations` ForceAtlas2 iterations (default 300),
 * `opts.timeoutMs` for the big streaming reads.
 */
/**
 * Options:
 *   iterations      total ForceAtlas2 iterations (default 300)
 *   reuseEdges      skip aggregation and use the LOD_DEP edges already in the database
 *   resume          start from the checkpoint file (if present) or, failing that, from
 *                   Crate.lod_x/lod_y when they exist; remaining iterations are run
 *   checkpointPath  file to checkpoint positions to every `checkpointEvery` iterations
 *   checkpointEvery default 20
 */
export const runBuild = async (driver, database, opts = {}) => {
  const {
    iterations = 300,
    timeoutMs = 3_600_000,
    reuseEdges = false,
    resume = false,
    checkpointPath = null,
    checkpointEvery = 20,
    onProgress = () => {},
    log = () => {},
  } = opts;
  const t0 = Date.now();
  const timings = {};
  const mark = (phase) => {
    timings[phase] = Date.now();
  };

  await ensureLodIndexes(driver, database);

  let names;
  let index;
  let edges;
  if (reuseEdges) {
    mark('graph');
    onProgress({ phase: 'graph', message: 'loading crates and stored LOD_DEP edges' });
    ({ names, index, edges } = await loadLodGraph(driver, database, { timeoutMs }));
    if (edges.length === 0) throw new Error('reuseEdges requested but no LOD_DEP edges exist; run without it');
    log(`graph: reused ${edges.length.toLocaleString()} stored LOD_DEP edges`);
  } else {
    // 1. aggregate
    mark('aggregate');
    onProgress({ phase: 'aggregate', message: 'aggregating DEPENDS_ON into crate-level edges' });
    const agg = await aggregateDependsOn(driver, database, {
      timeoutMs,
      onProgress: (rows) => onProgress({ phase: 'aggregate', done: rows, message: `${rows.toLocaleString()} crate pairs` }),
    });
    const triples = [];
    for (const [key, n] of agg) {
      const i = key.indexOf(SPLIT);
      triples.push([key.slice(0, i), key.slice(i + 1), n]);
    }
    agg.clear();
    log(`aggregate: ${triples.length.toLocaleString()} crate-level edges in ${Date.now() - timings.aggregate} ms`);

    // 2. persist edges
    mark('edges');
    onProgress({ phase: 'edges', done: 0, total: triples.length, message: 'deleting previous LOD_DEP edges' });
    await deleteLodEdges(driver, database, { onProgress: (n) => onProgress({ phase: 'edges', message: `deleted ${n.toLocaleString()}` }) });
    await createLodEdges(driver, database, triples, {
      onProgress: (done) => onProgress({ phase: 'edges', done, total: triples.length }),
    });
    log(`edges: wrote ${triples.length.toLocaleString()} LOD_DEP in ${Date.now() - timings.edges} ms`);

    // 3. graph (re-read names so crates that only appear as targets are included)
    mark('graph');
    onProgress({ phase: 'graph', message: 'loading crate list' });
    names = [];
    index = new Map();
    await streamRead(driver, database, `MATCH (c:Crate) RETURN c.name AS name`, {}, {
      timeoutMs,
      onRecord: (r) => {
        index.set(r.get('name'), names.length);
        names.push(r.get('name'));
      },
    });
    edges = [];
    for (const [a, b, n] of triples) {
      const ia = index.get(a);
      const ib = index.get(b);
      if (ia !== undefined && ib !== undefined) edges.push([ia, ib, n]);
    }
    triples.length = 0;
  }
  const graph = buildGraph(names, edges);
  log(`graph: ${graph.order.toLocaleString()} crates, ${graph.size.toLocaleString()} edges in ${Date.now() - timings.graph} ms`);

  // 4. communities
  mark('communities');
  onProgress({ phase: 'communities', message: 'Louvain community detection' });
  const communities = louvain(graph, { getEdgeWeight: 'weight', resolution: 1 });
  const communityCount = new Set(Object.values(communities)).size;
  log(`communities: ${communityCount.toLocaleString()} in ${Date.now() - timings.communities} ms`);

  // 5. layout
  mark('layout');
  const isolated = seedPositions(graph, communities);
  let startIteration = 0;
  if (resume) {
    const cp = readCheckpoint(checkpointPath);
    if (cp && cp.positions) {
      let applied = 0;
      for (const [name, [x, y]] of Object.entries(cp.positions)) {
        if (graph.hasNode(name)) {
          graph.mergeNodeAttributes(name, { x, y });
          applied += 1;
        }
      }
      startIteration = Math.min(cp.iterationsDone ?? 0, iterations);
      log(`resume: ${applied.toLocaleString()} positions from checkpoint (${startIteration} iterations done)`);
    } else {
      const { positions, meta } = await loadLodPositions(driver, database, { timeoutMs });
      if (positions.length) {
        for (const p of positions) if (graph.hasNode(p.name)) graph.mergeNodeAttributes(p.name, { x: p.x, y: p.y });
        startIteration = Math.min(meta?.iterations ?? 0, iterations);
        log(`resume: ${positions.length.toLocaleString()} positions from the database (${startIteration} iterations done)`);
      } else {
        log('resume: nothing to resume from, starting fresh');
      }
    }
  }
  onProgress({
    phase: 'layout',
    done: startIteration,
    total: iterations,
    message: `ForceAtlas2 over ${(graph.order - isolated).toLocaleString()} connected crates`,
  });
  layout(graph, { iterations, startIteration, checkpointPath, checkpointEvery, onProgress, log });
  log(`layout: ${iterations - startIteration} iterations in ${Date.now() - timings.layout} ms (${isolated.toLocaleString()} isolated on ring)`);

  // 6. positions
  mark('positions');
  const rows = graph.mapNodes((n, attrs) => ({
    name: n,
    x: attrs.x,
    y: attrs.y,
    community: communities[n] ?? -1,
    degree: graph.degree(n),
  }));
  await writeLodPositions(driver, database, rows, {
    onProgress: (done) => onProgress({ phase: 'positions', done, total: rows.length }),
  });
  log(`positions: wrote ${rows.length.toLocaleString()} in ${Date.now() - timings.positions} ms`);

  // 7. meta
  const b = bounds(rows);
  const meta = {
    crates: rows.length,
    edges: edges.length,
    communities: communityCount,
    isolated,
    iterations,
    reused_edges: reuseEdges,
    min_x: b.minX,
    min_y: b.minY,
    max_x: b.maxX,
    max_y: b.maxY,
    build_ms: Date.now() - t0,
    updated_crates: 0,
  };
  await writeLodMeta(driver, database, meta);
  onProgress({ phase: 'done', message: `built ${rows.length.toLocaleString()} crates in ${Math.round((Date.now() - t0) / 1000)} s` });
  return meta;
};

/**
 * Incremental update: position crates that have none. Returns the number placed.
 */
export const runUpdate = async (driver, database, opts = {}) => {
  const { timeoutMs = 3_600_000, onProgress = () => {}, log = () => {} } = opts;
  const t0 = Date.now();

  onProgress({ phase: 'update', message: 'finding unpositioned crates' });
  const fresh = (await readRows(driver, database, `MATCH (c:Crate) WHERE c.lod_x IS NULL RETURN c.name AS name`, {}, { timeoutMs })).map(
    (r) => r.name,
  );
  if (fresh.length === 0) {
    onProgress({ phase: 'done', message: 'nothing to update' });
    return 0;
  }
  log(`update: ${fresh.length.toLocaleString()} crates without a position`);

  const { positions, meta } = await loadLodPositions(driver, database, { timeoutMs });
  if (!meta) throw new Error('no LOD build exists yet; run a full rebuild first');
  const pos = new Map(positions.map((p) => [p.name, p]));

  // Crate-level edges touching the new crates, both directions, in batches of names.
  const triples = [];
  const batch = 500;
  for (let i = 0; i < fresh.length; i += batch) {
    const names = fresh.slice(i, i + batch);
    const out = await readRows(
      driver,
      database,
      `UNWIND $names AS name
       MATCH (v:Version {name: name})-[:DEPENDS_ON]->(b:Crate)
       WITH name AS a, b.name AS b, count(*) AS n
       RETURN a, b, n`,
      { names },
      { timeoutMs },
    );
    const inn = await readRows(
      driver,
      database,
      `UNWIND $names AS name
       MATCH (b:Crate {name: name})<-[:DEPENDS_ON]-(v:Version)
       WITH v.name AS a, name AS b, count(*) AS n
       RETURN a, b, n`,
      { names },
      { timeoutMs },
    );
    for (const r of [...out, ...inn]) triples.push([r.a, r.b, r.n]);
    onProgress({ phase: 'update', done: Math.min(i + batch, fresh.length), total: fresh.length, message: 'collecting edges' });
  }
  // Dedupe (a new crate depending on another new crate appears from both sides).
  const seen = new Map();
  for (const [a, b, n] of triples) seen.set(`${a}${SPLIT}${b}`, n);
  const unique = [...seen].map(([k, n]) => {
    const i = k.indexOf(SPLIT);
    return [k.slice(0, i), k.slice(i + 1), n];
  });

  // Remove any LOD_DEP already touching these crates (idempotent re-runs), then create.
  for (let i = 0; i < fresh.length; i += batch) {
    await driver
      .session({ database, defaultAccessMode: neo4j.session.WRITE })
      .executeWrite((tx) =>
        tx.run(
          `UNWIND $names AS name MATCH (c:Crate {name: name})-[r:LOD_DEP]-() DELETE r`,
          { names: fresh.slice(i, i + batch) },
        ),
      );
  }
  await createLodEdges(driver, database, unique, {
    onProgress: (done) => onProgress({ phase: 'update', done, total: unique.length, message: 'writing LOD_DEP' }),
  });

  // Place each new crate at the centroid of positioned neighbours; iterate a
  // few times so new crates that only neighbour other new crates settle too.
  const neighbours = new Map();
  const addN = (a, b) => {
    if (!neighbours.has(a)) neighbours.set(a, []);
    neighbours.get(a).push(b);
  };
  for (const [a, b] of unique) {
    addN(a, b);
    addN(b, a);
  }
  const freshSet = new Set(fresh);
  const placed = new Map();
  const ringR = Math.max(Math.abs(meta.min_x), Math.abs(meta.max_x), Math.abs(meta.min_y), Math.abs(meta.max_y)) * 1.05;
  for (let pass = 0; pass < 3; pass++) {
    for (const name of fresh) {
      if (placed.has(name) && pass > 0 && placed.get(name).anchored) continue;
      const ns = (neighbours.get(name) ?? []).map((n) => pos.get(n) ?? placed.get(n)).filter(Boolean);
      if (ns.length === 0) continue;
      let sx = 0;
      let sy = 0;
      const comm = new Map();
      for (const p of ns) {
        sx += p.x;
        sy += p.y;
        comm.set(p.community, (comm.get(p.community) ?? 0) + 1);
      }
      const community = [...comm.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const jitter = 8;
      placed.set(name, {
        name,
        x: sx / ns.length + (hash01(name) - 0.5) * jitter,
        y: sy / ns.length + (hash01(name + '|y') - 0.5) * jitter,
        community,
        degree: (neighbours.get(name) ?? []).length,
        anchored: ns.some((p) => !freshSet.has(p.name)),
      });
    }
  }
  // Anything still unplaced has no positioned neighbours: outer ring.
  let ringI = 0;
  for (const name of fresh) {
    if (placed.has(name)) continue;
    const a = 2 * Math.PI * hash01(name);
    placed.set(name, { name, x: Math.cos(a) * ringR, y: Math.sin(a) * ringR, community: -1, degree: 0 });
    ringI += 1;
  }
  const rows = [...placed.values()].map(({ name, x, y, community, degree }) => ({ name, x, y, community, degree }));
  await writeLodPositions(driver, database, rows, {
    onProgress: (done) => onProgress({ phase: 'update', done, total: rows.length, message: 'writing positions' }),
  });
  await writeLodMeta(driver, database, {
    crates: meta.crates + rows.length,
    edges: meta.edges + unique.length,
    updated_crates: (meta.updated_crates ?? 0) + rows.length,
    update_ms: Date.now() - t0,
  });
  log(`update: placed ${rows.length.toLocaleString()} crates (${ringI} on ring) with ${unique.length.toLocaleString()} edges in ${Date.now() - t0} ms`);
  onProgress({ phase: 'done', message: `placed ${rows.length.toLocaleString()} new crates` });
  return rows.length;
};

export { loadLodGraph, loadLodPositions };
