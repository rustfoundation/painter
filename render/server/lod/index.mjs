// In-memory level-of-detail index over the precomputed layout.
//
// Holds every crate's position (typed arrays) and the crate-level LOD_DEP
// edges. A viewport query picks the coarsest grid level whose non-empty cells
// inside the view fit the element budget, then returns either cluster nodes
// ("N crates") or, when few enough remain, the individual crates, plus the
// aggregated edges between whatever is visible.
//
// Nothing is precomputed per level: a viewport costs one pass over the points
// in the view per level tried, and one pass over all edges. On a full
// crates.io graph (hundreds of thousands of crates, ~1-2M edges) that is tens
// of milliseconds, which is cheaper than holding per-level edge tables.

import { loadLodPositions, streamRead } from './neo4j-io.mjs';

const packCell = (level, ix, iy) => `${level}:${ix}:${iy}`;

export class LodIndex {
  constructor({ positions, edges, meta, maxLevel }) {
    const n = positions.length;
    this.count = n;
    this.meta = meta;
    this.maxLevel = maxLevel;
    this.names = new Array(n);
    this.byName = new Map();
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.community = new Int32Array(n);
    this.degree = new Int32Array(n);
    positions.forEach((p, i) => {
      this.names[i] = p.name;
      this.byName.set(p.name, i);
      this.x[i] = p.x;
      this.y[i] = p.y;
      this.community[i] = p.community;
      this.degree[i] = p.degree;
    });
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
    // Normalised coordinates in [0,1) for cell bucketing.
    this.nx = new Float32Array(n);
    this.ny = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.nx[i] = (this.x[i] - this.bounds.minX) / this.span;
      this.ny[i] = (this.y[i] - this.bounds.minY) / this.span;
    }
    // Edges as index pairs.
    const m = edges.length;
    this.ea = new Int32Array(m);
    this.eb = new Int32Array(m);
    this.ev = new Float32Array(m);
    let k = 0;
    for (const [a, b, v] of edges) {
      const ia = this.byName.get(a);
      const ib = this.byName.get(b);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      this.ea[k] = ia;
      this.eb[k] = ib;
      this.ev[k] = v;
      k += 1;
    }
    this.edgeCount = k;
    this.loadedAt = new Date().toISOString();
  }

  /** Load positions and LOD_DEP edges from Neo4j. Returns null when no build exists. */
  static async load(driver, database, { timeoutMs, maxLevel }) {
    const { positions, meta } = await loadLodPositions(driver, database, { timeoutMs });
    // LodMeta is written last by a build, so "positions but no meta" means a
    // build is mid-write: report not ready rather than serve a partial map.
    if (positions.length === 0 || !meta || !meta.built_at) return null;
    const edges = [];
    await streamRead(driver, database, `MATCH (a:Crate)-[r:LOD_DEP]->(b:Crate) RETURN a.name AS a, b.name AS b, r.versions AS n`, {}, {
      timeoutMs,
      onRecord: (r) => edges.push([r.get('a'), r.get('b'), Number(r.get('n'))]),
    });
    return new LodIndex({ positions, edges, meta, maxLevel });
  }

  cellOf(i, level) {
    const g = 1 << level;
    return packCell(level, Math.min(g - 1, Math.floor(this.nx[i] * g)), Math.min(g - 1, Math.floor(this.ny[i] * g)));
  }

  /** Indices of crates inside a layout-space bbox. */
  inView(x0, y0, x1, y1) {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      if (this.x[i] >= x0 && this.x[i] <= x1 && this.y[i] >= y0 && this.y[i] <= y1) out.push(i);
    }
    return out;
  }

  /**
   * Viewport query. `bbox` in layout coordinates; `budget` max nodes.
   * Returns { mode: 'crates' | 'cells', level, nodes, rels, meta }.
   */
  /**
   * `minCell`: smallest cell size (layout units) worth drawing as a cluster;
   * the client derives it from its zoom so clusters keep a minimum on-screen
   * spacing. Levels whose cells are smaller are not used.
   */
  viewport(bbox, { budget, maxRels = budget, minCell = 0 }) {
    const started = Date.now();
    const x0 = Math.min(bbox.x0, bbox.x1);
    const x1 = Math.max(bbox.x0, bbox.x1);
    const y0 = Math.min(bbox.y0, bbox.y1);
    const y1 = Math.max(bbox.y0, bbox.y1);
    // The whole-map view (every crate inside the bbox) is the most common and
    // the most expensive query; memoise it per budget.
    const whole = x0 <= this.bounds.minX && y0 <= this.bounds.minY && x1 >= this.bounds.maxX && y1 >= this.bounds.maxY;
    const levelCap = minCell > 0 ? Math.max(0, Math.min(this.maxLevel, Math.floor(Math.log2(this.span / minCell)))) : this.maxLevel;
    const cacheKey = `${budget}:${maxRels}:${levelCap}`;
    if (whole) {
      this.wholeCache ??= new Map();
      const hit = this.wholeCache.get(cacheKey);
      if (hit) return { ...hit, meta: { ...hit.meta, elapsedMs: 0, cached: true } };
    }
    const result = this.viewportUncached({ x0, y0, x1, y1 }, { budget, maxRels, started, levelCap });
    if (whole) this.wholeCache.set(cacheKey, result);
    return result;
  }

  viewportUncached({ x0, y0, x1, y1 }, { budget, maxRels, started, levelCap }) {
    const idx = this.inView(x0, y0, x1, y1);

    if (idx.length <= budget && levelCap >= this.maxLevel) {
      return this.cratesPayload(idx, { maxRels, started, inView: idx.length, level: this.maxLevel });
    }

    // Finest level whose cell count fits the budget. Count distinct cells per
    // level from coarse to fine with numeric keys, bailing out of a level as
    // soon as it exceeds the budget; only the winning level is materialised.
    let level = 0;
    for (let l = 1; l <= levelCap; l++) {
      const g = 1 << l;
      const seen = new Set();
      let over = false;
      for (const i of idx) {
        const ix = Math.min(g - 1, Math.floor(this.nx[i] * g));
        const iy = Math.min(g - 1, Math.floor(this.ny[i] * g));
        seen.add(ix * g + iy);
        if (seen.size > budget) {
          over = true;
          break;
        }
      }
      if (over) break;
      level = l;
    }
    const cells = new Map();
    for (const i of idx) {
      const key = this.cellOf(i, level);
      let c = cells.get(key);
      if (!c) {
        c = { key, members: [] };
        cells.set(key, c);
      }
      c.members.push(i);
    }
    return this.cellsPayload(cells, { level, maxRels, started, inView: idx.length });
  }

  crateNode(i) {
    return {
      id: `crate:${this.names[i]}`,
      labels: ['Crate'],
      properties: { name: this.names[i], x: this.x[i], y: this.y[i], community: this.community[i], degree: this.degree[i] },
    };
  }

  cratesPayload(idx, { maxRels, started, inView, level }) {
    const visible = new Uint8Array(this.count);
    for (const i of idx) visible[i] = 1;
    const nodes = idx.map((i) => this.crateNode(i));
    const rels = [];
    for (let k = 0; k < this.edgeCount; k++) {
      const a = this.ea[k];
      const b = this.eb[k];
      if (visible[a] && visible[b]) {
        rels.push({
          id: `dep:crate:${this.names[a]}->crate:${this.names[b]}`,
          type: 'DEPENDS_ON',
          from: `crate:${this.names[a]}`,
          to: `crate:${this.names[b]}`,
          properties: { versions: this.ev[k], aggregated: true },
        });
      }
    }
    rels.sort((p, q) => q.properties.versions - p.properties.versions);
    const truncated = rels.length > maxRels;
    return {
      mode: 'crates',
      level,
      nodes,
      rels: truncated ? rels.slice(0, maxRels) : rels,
      meta: { inView, total: this.count, elapsedMs: Date.now() - started, relsTruncated: truncated, bounds: this.bounds },
    };
  }

  cellsPayload(cells, { level, maxRels, started, inView }) {
    const nodes = [];
    // Visible element index per crate: -1 hidden, otherwise index into `ids`.
    const elemOf = new Int32Array(this.count).fill(-1);
    const ids = [];
    const g = 1 << level;
    for (const c of cells.values()) {
      if (c.members.length === 1) {
        const i = c.members[0];
        elemOf[i] = ids.length;
        ids.push(`crate:${this.names[i]}`);
        nodes.push(this.crateNode(i));
        continue;
      }
      let sx = 0;
      let sy = 0;
      const comm = new Map();
      const top = [];
      for (const i of c.members) {
        sx += this.x[i];
        sy += this.y[i];
        comm.set(this.community[i], (comm.get(this.community[i]) ?? 0) + 1);
        elemOf[i] = ids.length;
        if (top.length < 3 || this.degree[i] > top[top.length - 1].d) {
          top.push({ n: this.names[i], d: this.degree[i] });
          top.sort((p, q) => q.d - p.d);
          if (top.length > 3) top.length = 3;
        }
      }
      let community = -1;
      let best = -1;
      for (const [k, v] of comm) {
        if (v > best) {
          best = v;
          community = k;
        }
      }
      const [, ix, iy] = c.key.split(':').map(Number);
      const id = `cell:${c.key}`;
      ids.push(id);
      nodes.push({
        id,
        labels: ['Cluster'],
        properties: {
          count: c.members.length,
          x: sx / c.members.length,
          y: sy / c.members.length,
          community,
          top: top.map((t) => t.n),
          level,
          bbox: {
            x0: this.bounds.minX + (ix / g) * this.span,
            y0: this.bounds.minY + (iy / g) * this.span,
            x1: this.bounds.minX + ((ix + 1) / g) * this.span,
            y1: this.bounds.minY + ((iy + 1) / g) * this.span,
          },
        },
      });
    }
    // Aggregate edges between visible elements with numeric keys.
    const n = ids.length;
    const agg = new Map();
    for (let k = 0; k < this.edgeCount; k++) {
      const fa = elemOf[this.ea[k]];
      const fb = elemOf[this.eb[k]];
      if (fa < 0 || fb < 0 || fa === fb) continue;
      const key = fa * n + fb;
      let e = agg.get(key);
      if (!e) {
        e = { fa, fb, count: 0, versions: 0 };
        agg.set(key, e);
      }
      e.count += 1;
      e.versions += this.ev[k];
    }
    let rels = [...agg.values()];
    rels.sort((p, q) => q.count - p.count);
    const truncated = rels.length > maxRels;
    if (truncated) rels = rels.slice(0, maxRels);
    const relsOut = rels.map((e) => ({
      id: `dep:${ids[e.fa]}->${ids[e.fb]}`,
      type: 'DEPENDS_ON',
      from: ids[e.fa],
      to: ids[e.fb],
      properties: { count: e.count, versions: e.versions, aggregated: true },
    }));
    return {
      mode: 'cells',
      level,
      nodes,
      rels: relsOut,
      meta: { inView, total: this.count, cells: cells.size, elapsedMs: Date.now() - started, relsTruncated: truncated, bounds: this.bounds },
    };
  }

  /** Position of one crate, or null. */
  locate(name) {
    const i = this.byName.get(name);
    if (i === undefined) return null;
    return { name, x: this.x[i], y: this.y[i], community: this.community[i], degree: this.degree[i] };
  }

  /** Crate names containing `q` (case-insensitive), highest degree first. */
  search(q, limit = 20) {
    const needle = q.toLowerCase();
    const hits = [];
    for (let i = 0; i < this.count; i++) {
      if (this.names[i].toLowerCase().includes(needle)) hits.push(i);
    }
    hits.sort((a, b) => (this.names[a] === needle ? -1 : this.names[b] === needle ? 1 : this.degree[b] - this.degree[a]));
    return hits.slice(0, limit).map((i) => this.names[i]);
  }

  status() {
    return { loadedAt: this.loadedAt, crates: this.count, edges: this.edgeCount, bounds: this.bounds, maxLevel: this.maxLevel, meta: this.meta };
  }
}
