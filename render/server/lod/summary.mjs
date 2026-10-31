// Per-community summaries computed once from the in-memory index (no database query per request):
// where each large community sits on the map, how big it is, and which crates dominate it, so the UI
// can label blobs ("serde · serde_json · thiserror") and give the top communities meaningful colours.

/** Andrew's monotone chain; points are [x, y]. Returns the hull counter-clockwise without the repeated first point. */
export const convexHull = (points) => {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
};

/** Keep at most `max` hull vertices, evenly spaced, so payloads stay small. */
const thinHull = (hull, max = 40) => {
  if (hull.length <= max) return hull;
  const out = [];
  for (let k = 0; k < max; k++) out.push(hull[Math.floor((k * hull.length) / max)]);
  return out;
};

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

/**
 * Rank communities by total downloads (summed importance as the tie-break, and the only signal
 * before the registry job has run; families of auto-generated crates would otherwise outrank real
 * ecosystems by sheer count) and describe the top `limit`:
 * centroid, 80th-percentile radius (outliers excluded), a convex hull of the crates within that
 * radius, and the dominant crates. ForceAtlas2 keeps Louvain communities only loosely together, so
 * `spread` (radius / map span) tells the client how coherent a blob really is.
 */
export const summarizeCommunities = (idx, { limit = 48, topNames = 4 } = {}) => {
  const groups = new Map();
  for (let i = 0; i < idx.count; i++) {
    const c = idx.community[i];
    if (c < 0) continue;
    let g = groups.get(c);
    if (!g) {
      g = { id: c, members: [], sumScore: 0, downloads: 0 };
      groups.set(c, g);
    }
    g.members.push(i);
    g.sumScore += idx.score[i];
    g.downloads += idx.downloads[i];
  }
  const ranked = [...groups.values()].sort((a, b) => b.downloads - a.downloads || b.sumScore - a.sumScore);
  const out = [];
  for (const g of ranked.slice(0, limit)) {
    const n = g.members.length;
    let sx = 0;
    let sy = 0;
    for (const i of g.members) {
      sx += idx.x[i];
      sy += idx.y[i];
    }
    const cx = sx / n;
    const cy = sy / n;
    const dist = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const i = g.members[k];
      dist[k] = Math.hypot(idx.x[i] - cx, idx.y[i] - cy);
    }
    const sorted = Float64Array.from(dist).sort();
    const radius = quantile(sorted, 0.8);
    const inner = [];
    let ix0 = Infinity;
    let iy0 = Infinity;
    let ix1 = -Infinity;
    let iy1 = -Infinity;
    for (let k = 0; k < n; k++) {
      if (dist[k] > radius) continue;
      const i = g.members[k];
      inner.push([idx.x[i], idx.y[i]]);
      if (idx.x[i] < ix0) ix0 = idx.x[i];
      if (idx.y[i] < iy0) iy0 = idx.y[i];
      if (idx.x[i] > ix1) ix1 = idx.x[i];
      if (idx.y[i] > iy1) iy1 = idx.y[i];
    }
    const top = g.members
      .slice()
      .sort((a, b) => idx.score[b] - idx.score[a])
      .slice(0, topNames)
      .map((i) => idx.names[i]);
    out.push({
      id: g.id,
      size: n,
      downloads: g.downloads,
      x: cx,
      y: cy,
      radius,
      spread: radius / idx.span,
      bbox: { x0: ix0, y0: iy0, x1: ix1, y1: iy1 },
      hull: thinHull(convexHull(inner)).map(([x, y]) => [Math.round(x), Math.round(y)]),
      top,
    });
  }
  return { communities: out, total: groups.size };
};
