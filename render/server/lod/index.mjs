// In-memory viewport index for the Map. Nothing is precomputed per zoom level: a viewport is one
// walk down the global importance order (downloads + dependents) picking crates inside the bbox
// that keep a minimum on-screen spacing, so a crate that is a landmark at one zoom stays one at every
// deeper zoom. A sparse density grid over the same bbox shows where the other crates are without
// sending them. Community summaries (summary.mjs) are built once at load.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import neo4j from 'neo4j-driver';
import { loadLodPositions, streamRead } from './neo4j-io.mjs';
import { summarizeCommunities } from './summary.mjs';
import { hasWildcard, nameTester } from '../match.mjs';

const SNAPSHOT_VERSION = 2;
/** Density grid columns across the requested bbox; rows follow its aspect ratio. */
const DENSITY_COLS = 96;
const VIEW_CACHE_MAX = 64;
/** Communities that get their own colour (must match MAP_PALETTE.length in src/mapOverlay.ts); density cells are tinted by majority among them. */
const PALETTE_SLOTS = 16;
const NEIGHBOUR_CACHE_MAX = 256;

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

/** Importance: downloads dominate, dependents (LOD_DEP in-degree) break ties and rank crates the registry has not seen. */
const importance = (downloads, dependents) => Math.log10(downloads + 1) + 1.5 * Math.log10(dependents + 1);

export class LodIndex {
  /**
   * Columnar input: `names` plus parallel `x, y, community, degree, downloads` arrays and edge
   * index triples `ea -> eb` with weight `ev` (versions declaring the dependency).
   */
  constructor({ names, x, y, community, degree, downloads, ea, eb, ev, meta }) {
    const n = names.length;
    this.count = n;
    this.meta = meta;
    this.names = names;
    this.byName = new Map();
    for (let i = 0; i < n; i++) this.byName.set(names[i], i);
    this.x = Float64Array.from(x);
    this.y = Float64Array.from(y);
    this.community = Int32Array.from(community);
    this.degree = Int32Array.from(degree);
    this.downloads = Float64Array.from(downloads);
    // Bounds with a small margin so edge points are strictly inside.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (this.x[i] < minX) minX = this.x[i];
      if (this.y[i] < minY) minY = this.y[i];
      if (this.x[i] > maxX) maxX = this.x[i];
      if (this.y[i] > maxY) maxY = this.y[i];
    }
    const pad = Math.max(maxX - minX, maxY - minY, 1) * 0.01;
    this.bounds = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    this.span = Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY);
    // Isolated crates sit on an outer ring, so the whole bounds are mostly empty: the 1.5-98.5
    // percentile box is where the ecosystem actually is and is what the UI opens on.
    const xs = Float64Array.from(this.x).sort();
    const ys = Float64Array.from(this.y).sort();
    this.core = { minX: quantile(xs, 0.015), minY: quantile(ys, 0.015), maxX: quantile(xs, 0.985), maxY: quantile(ys, 0.985) };

    // Edges as CSR both ways (deps = out, dependents = in).
    const m = ea.length;
    const valid = new Uint8Array(m);
    this.outdeg = new Int32Array(n);
    this.indeg = new Int32Array(n);
    let k = 0;
    for (let e = 0; e < m; e++) {
      const a = ea[e];
      const b = eb[e];
      if (a === undefined || b === undefined || a < 0 || b < 0 || a >= n || b >= n || a === b) continue;
      valid[e] = 1;
      this.outdeg[a] += 1;
      this.indeg[b] += 1;
      k += 1;
    }
    this.edgeCount = k;
    this.outStart = new Int32Array(n + 1);
    this.inStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      this.outStart[i + 1] = this.outStart[i] + this.outdeg[i];
      this.inStart[i + 1] = this.inStart[i] + this.indeg[i];
    }
    this.outIdx = new Int32Array(k);
    this.outW = new Float32Array(k);
    this.inIdx = new Int32Array(k);
    this.inW = new Float32Array(k);
    const outFill = Int32Array.from(this.outStart.subarray(0, n));
    const inFill = Int32Array.from(this.inStart.subarray(0, n));
    for (let e = 0; e < m; e++) {
      if (!valid[e]) continue;
      const a = ea[e];
      const b = eb[e];
      const w = ev[e];
      this.outIdx[outFill[a]] = b;
      this.outW[outFill[a]] = w;
      outFill[a] += 1;
      this.inIdx[inFill[b]] = a;
      this.inW[inFill[b]] = w;
      inFill[b] += 1;
    }

    this.score = new Float32Array(n);
    for (let i = 0; i < n; i++) this.score[i] = importance(this.downloads[i], this.indeg[i]);
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => this.score[b] - this.score[a] || this.indeg[b] - this.indeg[a] || a - b);
    this.order = order;
    this.rank = new Int32Array(n);
    for (let r = 0; r < n; r++) this.rank[order[r]] = r;

    const summary = summarizeCommunities(this, { limit: 48 });
    this.communities = summary.communities;
    this.communityCount = summary.total;
    this.communityById = new Map(this.communities.map((c) => [c.id, c]));
    // Palette slot per crate: 0..PALETTE_SLOTS-1 for the top communities, PALETTE_SLOTS for everything else.
    const slotOf = new Map(this.communities.slice(0, PALETTE_SLOTS).map((c, k) => [c.id, k]));
    this.slot = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.slot[i] = slotOf.get(this.community[i]) ?? PALETTE_SLOTS;
    this.slotCommunity = this.communities.slice(0, PALETTE_SLOTS).map((c) => c.id);
    this.viewCache = new Map();
    this.neighbourCache = new Map();
    this.loadedAt = new Date().toISOString();
  }

  /**
   * Loads from the database, or from the JSON snapshot at `cachePath` when its `built_at` matches
   * the database's LodMeta (a full load streams 340k crates and 2.9M edges, ~4 min against a remote
   * database; the snapshot takes seconds). The snapshot is rewritten after every database load.
   */
  static async load(driver, database, { timeoutMs, cachePath = null, log = () => {} } = {}) {
    const meta = await loadLodMeta(driver, database);
    // LodMeta is written last, so no meta means a build is mid-write (or none exists): report not ready.
    if (!meta || !meta.built_at) return null;
    const builtAt = String(meta.built_at);
    if (cachePath) {
      try {
        const snap = await readSnapshot(cachePath);
        if (snap && snap.version === SNAPSHOT_VERSION && snap.built_at === builtAt) {
          log(`lod index: using snapshot ${cachePath} (built ${builtAt})`);
          return new LodIndex({ ...snap, meta });
        }
        if (snap) log(`lod index: snapshot is for build ${snap.built_at}, database has ${builtAt}; reloading`);
      } catch (err) {
        log(`lod index: snapshot unreadable (${err.message}); loading from the database`);
      }
    }
    const { positions } = await loadLodPositions(driver, database, { timeoutMs });
    if (positions.length === 0) return null;
    const byName = new Map();
    const names = new Array(positions.length);
    const x = new Float64Array(positions.length);
    const y = new Float64Array(positions.length);
    const community = new Int32Array(positions.length);
    const degree = new Int32Array(positions.length);
    const downloads = new Float64Array(positions.length);
    positions.forEach((p, i) => {
      names[i] = p.name;
      byName.set(p.name, i);
      x[i] = p.x;
      y[i] = p.y;
      community[i] = p.community;
      degree[i] = p.degree;
      downloads[i] = p.downloads;
    });
    const ea = [];
    const eb = [];
    const ev = [];
    await streamRead(driver, database, `MATCH (a:Crate)-[r:LOD_DEP]->(b:Crate) RETURN a.name AS a, b.name AS b, r.versions AS n`, {}, {
      timeoutMs,
      onRecord: (r) => {
        const a = byName.get(r.get('a'));
        const b = byName.get(r.get('b'));
        if (a === undefined || b === undefined) return;
        ea.push(a);
        eb.push(b);
        const v = r.get('n');
        ev.push(neo4j.isInt(v) ? v.toNumber() : Number(v));
      },
    });
    const columns = { names, x: Array.from(x), y: Array.from(y), community: Array.from(community), degree: Array.from(degree), downloads: Array.from(downloads), ea, eb, ev };
    if (cachePath) {
      writeSnapshot(cachePath, { version: SNAPSHOT_VERSION, built_at: builtAt, ...columns })
        .then(() => log(`lod index: snapshot written to ${cachePath}`))
        .catch((err) => log(`lod index: snapshot write failed: ${err.message}`));
    }
    return new LodIndex({ ...columns, meta });
  }

  inView(x0, y0, x1, y1) {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      if (this.x[i] >= x0 && this.x[i] <= x1 && this.y[i] >= y0 && this.y[i] <= y1) out.push(i);
    }
    return out;
  }

  /**
   * `budget` landmarks for the bbox, at least `minCell` layout units apart (the client derives it from
   * its zoom, so spacing is constant on screen), plus their edges and a density grid of everything else.
   */
  viewport(bbox, { budget, maxRels = budget, minCell = 0 }) {
    const started = Date.now();
    const x0 = Math.min(bbox.x0, bbox.x1);
    const x1 = Math.max(bbox.x0, bbox.x1);
    const y0 = Math.min(bbox.y0, bbox.y1);
    const y1 = Math.max(bbox.y0, bbox.y1);
    const key = [x0, y0, x1, y1, minCell].map((v) => v.toPrecision(4)).join(',') + `:${budget}:${maxRels}`;
    const hit = this.viewCache.get(key);
    if (hit) {
      this.viewCache.delete(key);
      this.viewCache.set(key, hit);
      return { ...hit, meta: { ...hit.meta, elapsedMs: Date.now() - started, cached: true } };
    }
    const result = this.viewportUncached({ x0, y0, x1, y1 }, { budget, maxRels, minCell, started });
    this.viewCache.set(key, result);
    if (this.viewCache.size > VIEW_CACHE_MAX) this.viewCache.delete(this.viewCache.keys().next().value);
    return result;
  }

  viewportUncached({ x0, y0, x1, y1 }, { budget, maxRels, minCell, started }) {
    const w = Math.max(x1 - x0, 1e-9);
    const h = Math.max(y1 - y0, 1e-9);
    // Density grid and in-view count: one pass over every point.
    const cols = DENSITY_COLS;
    const rows = Math.max(8, Math.min(160, Math.round((cols * h) / w)));
    const counts = new Int32Array(cols * rows);
    // Per-cell tally per palette slot: the majority coloured community tints the cell, grey if "other" wins.
    const slots = PALETTE_SLOTS + 1;
    const tally = new Int32Array(cols * rows * slots);
    let inView = 0;
    for (let i = 0; i < this.count; i++) {
      const px = this.x[i];
      const py = this.y[i];
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      inView += 1;
      const cx = Math.min(cols - 1, Math.floor(((px - x0) / w) * cols));
      const cy = Math.min(rows - 1, Math.floor(((py - y0) / h) * rows));
      const c = cy * cols + cx;
      counts[c] += 1;
      tally[c * slots + this.slot[i]] += 1;
    }
    const cells = [];
    for (let c = 0; c < counts.length; c++) {
      if (counts[c] === 0) continue;
      let best = PALETTE_SLOTS;
      let bestN = tally[c * slots + PALETTE_SLOTS];
      for (let k = 0; k < PALETTE_SLOTS; k++) {
        if (tally[c * slots + k] > bestN) {
          bestN = tally[c * slots + k];
          best = k;
        }
      }
      cells.push(c, counts[c], best < PALETTE_SLOTS ? this.slotCommunity[best] : -1);
    }

    // Landmarks: walk the global importance order, keep those in the bbox that do not crowd a
    // higher-ranked pick. Spacing uses a dense occupancy grid of `minCell` cells over the bbox (one
    // occupant per cell, 3x3 neighbourhood distance check), so the scan is a few ms even when the
    // screen fills up long before the budget and every in-view crate has to be considered.
    const picks = [];
    const cell = minCell > 0 ? minCell : 0;
    const gw = cell ? Math.ceil(w / cell) + 1 : 0;
    const gh = cell ? Math.ceil(h / cell) + 1 : 0;
    const occupant = cell ? new Int32Array(gw * gh).fill(-1) : null;
    const capacity = cell ? gw * gh : Infinity;
    let scanned = 0;
    for (let r = 0; r < this.count && picks.length < budget && picks.length < capacity; r++) {
      const i = this.order[r];
      const px = this.x[i];
      const py = this.y[i];
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      scanned += 1;
      if (occupant) {
        const gx = Math.floor((px - x0) / cell);
        const gy = Math.floor((py - y0) / cell);
        let crowded = occupant[gy * gw + gx] >= 0;
        for (let dy = -1; dy <= 1 && !crowded; dy++) {
          const yy = gy + dy;
          if (yy < 0 || yy >= gh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = gx + dx;
            if (xx < 0 || xx >= gw) continue;
            const j = occupant[yy * gw + xx];
            if (j >= 0 && Math.hypot(this.x[j] - px, this.y[j] - py) < cell) {
              crowded = true;
              break;
            }
          }
        }
        if (crowded) continue;
        occupant[gy * gw + gx] = i;
      }
      picks.push(i);
    }

    // Edges among the landmarks (out-degree is small, so this is cheap even for serde).
    const pickPos = new Int32Array(this.count).fill(-1);
    picks.forEach((i, p) => (pickPos[i] = p));
    const rels = [];
    for (const a of picks) {
      for (let e = this.outStart[a]; e < this.outStart[a + 1]; e++) {
        const b = this.outIdx[e];
        if (pickPos[b] < 0) continue;
        rels.push({ a, b, versions: this.outW[e] });
      }
    }
    rels.sort((p, q) => q.versions - p.versions);
    const relsTotal = rels.length;
    // More than `maxRels` edges is a smear, not information: send none and let the client show the
    // selection's own edges instead.
    const truncated = relsTotal > maxRels;
    const relsOut = (truncated ? [] : rels).map((e) => ({
      id: `dep:crate:${this.names[e.a]}->crate:${this.names[e.b]}`,
      type: 'DEPENDS_ON',
      from: `crate:${this.names[e.a]}`,
      to: `crate:${this.names[e.b]}`,
      properties: { versions: e.versions, aggregated: true },
    }));
    const level = Math.max(0, Math.round(Math.log2(this.span / Math.max(w, h))));
    return {
      mode: 'landmarks',
      level,
      nodes: picks.map((i) => this.crateNode(i)),
      rels: relsOut,
      density: { x0, y0, x1, y1, cols, rows, cells },
      meta: {
        inView,
        total: this.count,
        shown: picks.length,
        candidates: scanned,
        relsTotal,
        elapsedMs: Date.now() - started,
        relsTruncated: truncated,
        bounds: this.bounds,
      },
    };
  }

  crateNode(i, extra = null) {
    return {
      id: `crate:${this.names[i]}`,
      labels: ['Crate'],
      properties: {
        name: this.names[i],
        x: Math.round(this.x[i] * 10) / 10,
        y: Math.round(this.y[i] * 10) / 10,
        community: this.community[i],
        downloads: this.downloads[i],
        dependents: this.indeg[i],
        dependencies: this.outdeg[i],
        rank: this.rank[i],
        ...(extra ?? {}),
      },
    };
  }

  /** Index of a crate by exact name, case-insensitively; a `*` / `?` pattern resolves to its most important match. */
  resolve(name) {
    const text = String(name ?? '').trim();
    if (!text) return undefined;
    if (hasWildcard(text)) {
      const test = nameTester(text);
      let best;
      for (let i = 0; i < this.count; i++) if ((best === undefined || this.rank[i] < this.rank[best]) && test(this.names[i])) best = i;
      return best;
    }
    const i = this.byName.get(text);
    if (i !== undefined) return i;
    if (!this.byLower) {
      this.byLower = new Map();
      for (let j = 0; j < this.count; j++) {
        const l = this.names[j].toLowerCase();
        if (!this.byLower.has(l)) this.byLower.set(l, j);
      }
    }
    return this.byLower.get(text.toLowerCase());
  }

  locate(name) {
    const i = this.resolve(name);
    if (i === undefined) return null;
    return this.crateNode(i).properties;
  }

  /** The crate plus its most important direct dependencies and dependents (crate level, all versions folded). */
  neighbours(name, limit = 30) {
    const i = this.byName.get(name);
    if (i === undefined) return null;
    const key = `${name}:${limit}`;
    const hit = this.neighbourCache.get(key);
    if (hit) return hit;
    const side = (start, idxs, ws) => {
      const list = [];
      for (let e = start[i]; e < start[i + 1]; e++) list.push(e);
      list.sort((p, q) => this.score[idxs[q]] - this.score[idxs[p]]);
      return { total: list.length, top: list.slice(0, limit).map((e) => this.crateNode(idxs[e], { versions: ws[e] })) };
    };
    const result = {
      crate: this.crateNode(i),
      community: this.communityById.get(this.community[i]) ? this.communityLabel(this.community[i]) : null,
      dependencies: side(this.outStart, this.outIdx, this.outW),
      dependents: side(this.inStart, this.inIdx, this.inW),
    };
    this.neighbourCache.set(key, result);
    if (this.neighbourCache.size > NEIGHBOUR_CACHE_MAX) this.neighbourCache.delete(this.neighbourCache.keys().next().value);
    return result;
  }

  communityLabel(id) {
    const c = this.communityById.get(id);
    return c ? { id: c.id, size: c.size, top: c.top } : null;
  }

  /** Suggestions: partial matches (exact name first), or a `*` / `?` pattern; both by importance. */
  search(q, limit = 20) {
    const needle = q.toLowerCase();
    const test = hasWildcard(q) ? nameTester(q) : (name) => name.toLowerCase().includes(needle);
    const hits = [];
    for (let i = 0; i < this.count; i++) {
      if (test(this.names[i])) hits.push(i);
    }
    const exact = (i) => this.names[i].toLowerCase() === needle;
    hits.sort((a, b) => (exact(a) ? -1 : exact(b) ? 1 : this.rank[a] - this.rank[b]));
    return hits.slice(0, limit).map((i) => this.names[i]);
  }

  status() {
    return {
      loadedAt: this.loadedAt,
      crates: this.count,
      edges: this.edgeCount,
      bounds: this.bounds,
      core: this.core,
      communities: this.communityCount,
      meta: this.meta,
    };
  }
}

const loadLodMeta = async (driver, database) => {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.executeRead((tx) => tx.run(`MATCH (m:LodMeta {id: 'default'}) RETURN properties(m) AS m`), { timeout: 60_000 });
    const m = result.records[0]?.get('m') ?? null;
    return m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, neo4j.isInt(v) ? v.toNumber() : v])) : null;
  } finally {
    await session.close();
  }
};

const readSnapshot = async (file) => {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(await fsp.readFile(file, 'utf8'));
};

const writeSnapshot = async (file, data) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
};
