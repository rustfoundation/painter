// Default view: layout and styling for the crate overview served by /api/graph/overview.
//
// The server annotates nodes with `role` (root / dep / dependent / callee) and `counts`; this module turns
// that into a deterministic radial picture on NVL's `free` layout: the root in the middle, what it uses to
// the right (normal dependencies on the inner arc, build / dev on an outer one), what uses it to the
// left, its newest versions as a strip along the bottom (oldest left, latest right), crates.io accounts on
// top. Positions are kept in a module-level map keyed by node id: NVL's React wrapper only re-sends
// attributes that changed, so a stable x/y never snaps a node the user dragged, and expansions place only
// the nodes that are new, fanned out from the node that was expanded, away from the root.
import type { Node as NvlNode, Relationship as NvlRel } from '@neo4j-nvl/base';
import type { GraphNode, GraphPayload, GraphRel, OverviewPart } from './api';
import { COLORS, isCrate, isTeam, isUser, isVersion, mergePayload, nodeCaption, nodeTitle, relTitle, toNvl, type GraphStore, type ViewOptions } from './graph';
import type { LabelSpec } from './components/OverviewLabels';
import { fmtCompact } from './components/meta';

export type Role = 'root' | 'dep' | 'dependent' | 'callee';

export const ROLE_COLORS = {
  root: '#1F5FD1',
  dep: '#4C8DFF',
  depOptional: '#7FA8E8',
  depBuild: '#A78BFA',
  depDev: '#8B93A7',
  dependent: '#2BB673',
  callee: '#E5484D',
  version: '#F5A623',
  versionPre: '#B88BFF',
  versionYanked: '#596273',
} as const;

interface XY {
  x: number;
  y: number;
}

const positions = new Map<string, XY>();
// The latest version's x; older versions extend to the left of it as they are paged in.
let stripRight: number | null = null;

export const clearOverviewLayout = () => {
  positions.clear();
  stripRight = null;
};

export const overviewPosition = (id: string): XY | undefined => positions.get(id);

const roleOf = (n: GraphNode | undefined): Role | undefined => (n?.role as Role | undefined) ?? undefined;

/** Merge a payload, keeping the role / counts a node already has (an expansion returns the anchor crate without them). */
export const mergeOverview = (store: GraphStore, payload: GraphPayload, root?: string): GraphStore => {
  const patched: GraphPayload = {
    ...payload,
    nodes: payload.nodes.map((n) => {
      const prev = store.nodes.get(n.id);
      if (!prev) return n;
      return { ...n, role: prev.role ?? n.role, counts: n.counts ?? prev.counts };
    }),
  };
  return mergePayload(store, patched, root);
};

export const findRoot = (store: GraphStore): GraphNode | undefined => {
  for (const n of store.nodes.values()) if (roleOf(n) === 'root') return n;
  for (const n of store.nodes.values()) if (isCrate(n) && store.roots.has(String(n.properties.name))) return n;
  return undefined;
};

/** How many of a crate's versions / dependents are already drawn, for paging ("+N older"). */
export const shownCount = (store: GraphStore, name: string, part: OverviewPart): number => {
  if (part === 'versions') {
    let n = 0;
    for (const v of store.nodes.values()) if (isVersion(v) && v.properties.name === name) n += 1;
    return n;
  }
  if (part === 'dependents') {
    const crate = [...store.nodes.values()].find((n) => isCrate(n) && n.properties.name === name);
    if (!crate) return 0;
    let n = 0;
    for (const r of store.rels.values()) if (r.type === 'DEPENDS_ON' && r.to === crate.id && r.properties.aggregated === true) n += 1;
    return n;
  }
  return 0;
};

const semverKey = (v: GraphNode): number[] => {
  const p = v.properties;
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0);
  // Pre-releases sort before their release.
  return [num('semver_major'), num('semver_minor'), num('semver_patch'), p.semver_pre ? 0 : 1];
};
const cmpSemver = (a: GraphNode, b: GraphNode): number => {
  const ka = semverKey(a);
  const kb = semverKey(b);
  for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return String(a.properties.version).localeCompare(String(b.properties.version));
};

const downloads = (n: GraphNode): number => (typeof n.properties.downloads === 'number' ? (n.properties.downloads as number) : 0);

const rad = (deg: number) => (deg * Math.PI) / 180;

/** `n` points evenly spread over an arc of `arcDeg` centred on `angleDeg`, at least `spacing` apart. */
const fan = (center: XY, angleDeg: number, arcDeg: number, n: number, minRadius: number, spacing: number): XY[] => {
  if (n === 0) return [];
  // A couple of nodes sit near the axis instead of at the arc's extremes.
  const arc = rad(Math.min(arcDeg, Math.max(0, n - 1) * 22));
  const radius = Math.max(minRadius, n > 1 && arc > 0 ? ((n - 1) * spacing) / arc : minRadius);
  const out: XY[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const a = rad(angleDeg) - arc / 2 + t * arc;
    out.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return out;
};

const kindRank = (k: unknown): number => (k === 'build' ? 1 : k === 'dev' ? 2 : 0);

interface DepEdge {
  kind: string;
  optional: boolean;
  calls: number;
}

/** The declaration an edge set makes about `nodeId` from `fromId`, strongest kind first. */
const depEdgeFrom = (store: GraphStore, fromId: string, nodeId: string): DepEdge | null => {
  let best: DepEdge | null = null;
  for (const r of store.rels.values()) {
    if (r.type !== 'DEPENDS_ON' || r.from !== fromId || r.to !== nodeId || r.properties.aggregated === true) continue;
    const e = { kind: String(r.properties.kind ?? 'normal'), optional: r.properties.optional === true, calls: Number(r.properties.calls ?? 0) };
    if (!best || kindRank(e.kind) < kindRank(best.kind)) best = e;
  }
  return best;
};

const ARC = 124;
const SPACING = 90;
const STRIP_SPACING = 120;
const RING_MAX = 20;

/** Split an ordered list into equal rings of at most RING_MAX so one huge arc does not push the fit zoom down. */
const chunkRing = (xs: GraphNode[]): GraphNode[][] => {
  if (xs.length === 0) return [];
  const rings = Math.ceil(xs.length / RING_MAX);
  const per = Math.ceil(xs.length / rings);
  const out: GraphNode[][] = [];
  for (let i = 0; i < xs.length; i += per) out.push(xs.slice(i, i + per));
  return out;
};

/**
 * Give every node without a position one. `anchorId` is the node that was expanded (the root on the
 * initial load); new crates fan out from it on the side away from the root.
 */
export const placeOverview = (store: GraphStore, anchorId: string | null): void => {
  const root = findRoot(store);
  if (root && !positions.has(root.id)) positions.set(root.id, { x: 0, y: 0 });
  const rootPos = root ? positions.get(root.id)! : { x: 0, y: 0 };
  const anchor = anchorId ? store.nodes.get(anchorId) : undefined;
  const anchorPos = anchor ? positions.get(anchor.id) : undefined;
  const anchorIsRoot = !anchor || !root || anchor.id === root.id;

  const fresh = [...store.nodes.values()].filter((n) => !positions.has(n.id));
  if (fresh.length === 0) return;

  const outgoing = new Set<string>();
  const incoming = new Set<string>();
  if (anchor) {
    for (const r of store.rels.values()) {
      if (r.from === anchor.id) outgoing.add(r.to);
      if (r.to === anchor.id) incoming.add(r.from);
    }
  }

  const rootName = root ? String(root.properties.name) : null;
  const versions = fresh.filter((n) => isVersion(n) && rootName !== null && n.properties.name === rootName);
  const accounts = fresh.filter((n) => isUser(n) || isTeam(n));
  const crates = fresh.filter((n) => isCrate(n) && !versions.includes(n));
  const rest = fresh.filter((n) => !versions.includes(n) && !accounts.includes(n) && !crates.includes(n));

  if (anchorIsRoot || !anchorPos) {
    const right = crates.filter((n) => outgoing.has(n.id) || roleOf(n) === 'dep' || roleOf(n) === 'callee');
    const left = crates.filter((n) => !right.includes(n));
    const from = anchor?.id ?? root?.id ?? '';
    const groupOf = (n: GraphNode): number => {
      const e = depEdgeFrom(store, from, n.id);
      if (roleOf(n) === 'callee' && !e) return 2;
      if (!e) return 2;
      if (e.kind === 'build') return 3;
      if (e.kind === 'dev') return 4;
      return e.optional ? 1 : 0;
    };
    right.sort((a, b) => groupOf(a) - groupOf(b) || downloads(b) - downloads(a));
    left.sort((a, b) => downloads(b) - downloads(a));

    // Deps: normal / optional / called on the inner arc, build / dev outside; one arc when small.
    const existingRight = [...positions.values()].filter((p) => p.x > rootPos.x + 1).map((p) => Math.hypot(p.x - rootPos.x, p.y - rootPos.y));
    let r0 = existingRight.length ? Math.max(...existingRight) + 260 : 280;
    const inner = right.filter((n) => groupOf(n) <= 2);
    const outer = right.filter((n) => groupOf(n) > 2);
    const rings: GraphNode[][] = [];
    if (right.length <= 18) rings.push(right);
    else rings.push(...chunkRing(inner), ...chunkRing(outer));
    for (const ring of rings) {
      const pts = fan(rootPos, 0, ARC, ring.length, r0, SPACING);
      ring.forEach((n, i) => positions.set(n.id, pts[i]));
      if (ring.length) r0 = Math.hypot(pts[0].x - rootPos.x, pts[0].y - rootPos.y) + 260;
    }

    const existingLeft = [...positions.values()].filter((p) => p.x < rootPos.x - 1).map((p) => Math.hypot(p.x - rootPos.x, p.y - rootPos.y));
    let l0 = existingLeft.length ? Math.max(...existingLeft) + 260 : 300;
    const leftRings: GraphNode[][] = left.length <= 18 ? [left] : chunkRing(left);
    for (const ring of leftRings) {
      const pts = fan(rootPos, 180, ARC, ring.length, l0, SPACING);
      ring.forEach((n, i) => positions.set(n.id, pts[i]));
      if (ring.length) l0 = Math.hypot(pts[0].x - rootPos.x, pts[0].y - rootPos.y) + 260;
    }

    if (accounts.length) {
      const pts = fan(rootPos, -90, 110, accounts.length, 260, SPACING);
      accounts.forEach((n, i) => positions.set(n.id, pts[i]));
    }
  } else {
    // Expansion of a non-root node: fan away from the root, deps and dependents alike.
    const away = (Math.atan2(anchorPos.y - rootPos.y, anchorPos.x - rootPos.x) * 180) / Math.PI;
    const group = [...crates, ...accounts].sort((a, b) => downloads(b) - downloads(a));
    const pts = fan(anchorPos, away, Math.min(150, 40 + group.length * 14), group.length, 170, 60);
    group.forEach((n, i) => positions.set(n.id, pts[i]));
    if (versions.length) {
      const vpts = fan(anchorPos, away + 90, 90, versions.length, 150, 60);
      versions.forEach((n, i) => positions.set(n.id, vpts[i]));
    }
  }

  // Version strip under everything placed so far, oldest left, latest right. Re-laid out for the whole set
  // so paged-in older versions slot in on the left while the ones already there keep their x.
  if (versions.length && root) {
    const all = [...store.nodes.values()].filter((n) => isVersion(n) && n.properties.name === rootName).sort(cmpSemver);
    let maxY = 0;
    for (const n of store.nodes.values()) {
      if (isVersion(n) || !positions.has(n.id)) continue;
      maxY = Math.max(maxY, positions.get(n.id)!.y - rootPos.y);
    }
    const y = rootPos.y + Math.max(240, maxY + 150);
    if (stripRight === null) stripRight = rootPos.x + ((all.length - 1) * STRIP_SPACING) / 2;
    all.forEach((n, i) => {
      if (!fresh.includes(n)) return;
      positions.set(n.id, { x: stripRight! - (all.length - 1 - i) * STRIP_SPACING, y });
    });
  } else if (versions.length) {
    const pts = fan(anchorPos ?? rootPos, 90, 120, versions.length, 220, 70);
    versions.forEach((n, i) => positions.set(n.id, pts[i]));
  }

  // Anything else (Cypher results, nodes of unknown shape): a ring beyond everything placed.
  if (rest.length) {
    let far = 0;
    for (const p of positions.values()) far = Math.max(far, Math.hypot(p.x - rootPos.x, p.y - rootPos.y));
    const pts = fan(rootPos, -90, 359, rest.length, far + 200, 70);
    rest.forEach((n, i) => positions.set(n.id, pts[i]));
  }

  // Later expansions can reach down to the strip; keep it under everything else.
  if (root) {
    const strip = [...store.nodes.values()].filter((n) => isVersion(n) && n.properties.name === rootName && positions.has(n.id));
    if (strip.length) {
      const stripY = positions.get(strip[0].id)!.y;
      let maxY = -Infinity;
      for (const n of store.nodes.values()) {
        if (isVersion(n) && n.properties.name === rootName) continue;
        const p = positions.get(n.id);
        if (p) maxY = Math.max(maxY, p.y);
      }
      if (Number.isFinite(maxY) && stripY < maxY + 110) {
        const y = maxY + 150;
        for (const n of strip) positions.set(n.id, { x: positions.get(n.id)!.x, y });
      }
    }
  }
};

// NVL `size` is a radius (a 48 node is 96 layout units across).
const sizeByDownloads = (n: GraphNode): number => Math.min(22, Math.max(10, 8 + Math.log10(downloads(n) + 1) * 1.5));

const badgesOf = (n: GraphNode): string => nodeCaption(n).slice(nodeTitle(n).length).trim();

const dateOf = (v: unknown): string => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : '');

/**
 * Captions for the DOM overlay (components/OverviewLabels.tsx): name plus one line of what matters for
 * the role: requirement / kind / calls for a dependency, downloads and declaring versions for a
 * dependent, date and metadata badges for a version.
 */
export const overviewLabels = (store: GraphStore, rootVersion: string | null): LabelSpec[] => {
  const root = findRoot(store);
  const out: LabelSpec[] = [];
  for (const n of store.nodes.values()) {
    const role = roleOf(n);
    if (root && n.id === root.id) {
      out.push({ id: n.id, text: rootVersion ? `${n.properties.name} ${rootVersion}` : String(n.properties.name), sub: `${fmtCompact(downloads(n))} downloads`, cls: 'root', size: 30 });
    } else if (isCrate(n)) {
      // Downloads are the node size; the line says what ties the crate to the root.
      const parts: string[] = [];
      const e = root ? depEdgeFrom(store, root.id, n.id) : null;
      if (e) {
        for (const r of store.rels.values()) {
          if (r.type !== 'DEPENDS_ON' || !root || r.from !== root.id || r.to !== n.id || r.properties.aggregated === true) continue;
          const req = String(r.properties.requirement ?? '').trim();
          if (req) parts.push(req);
          break;
        }
        if (e.kind !== 'normal') parts.push(e.kind);
        if (e.optional) parts.push('optional');
        if (e.calls) parts.push(`${e.calls.toLocaleString()} calls`);
      } else if (role === 'dependent' && root) {
        for (const r of store.rels.values()) {
          if (r.type === 'DEPENDS_ON' && r.from === n.id && r.to === root.id && typeof r.properties.versions === 'number') {
            parts.push(`${r.properties.versions.toLocaleString()} versions use it`);
            break;
          }
        }
      } else if (role === 'callee' && root) {
        for (const r of store.rels.values()) {
          if (r.type === 'INVOKES' && r.from === root.id && r.to === n.id) {
            parts.push(`${Number(r.properties.count ?? 0).toLocaleString()} calls, not declared`);
            break;
          }
        }
      }
      out.push({ id: n.id, text: String(n.properties.name), sub: parts.join(' · ') || undefined, cls: role ?? 'other', size: sizeByDownloads(n) });
    } else if (isVersion(n)) {
      const latest = n.properties.latest === true;
      out.push({
        id: n.id,
        text: latest ? `${n.properties.version} · latest` : String(n.properties.version),
        sub: dateOf(n.properties.published_at) || undefined,
        sub2: badgesOf(n) || undefined,
        cls: `version${latest ? ' latest' : ''}${n.properties.yanked === true ? ' yanked' : ''}`,
        size: latest ? 13 : 8,
      });
    } else if (isUser(n) || isTeam(n)) {
      const kinds = new Set<string>();
      for (const r of store.rels.values()) {
        if (r.from !== n.id) continue;
        if (r.type === 'OWNS') kinds.add('owner');
        if (r.type === 'PUBLISHED') kinds.add(typeof r.properties.versions === 'number' ? `${r.properties.versions} uploads` : 'uploader');
      }
      out.push({ id: n.id, text: nodeTitle(n), sub: [...kinds].join(' · ') || undefined, cls: 'account', size: 12 });
    } else {
      out.push({ id: n.id, text: nodeTitle(n), cls: 'other', size: 12 });
    }
  }
  return out;
};

/** Edge caption: requirement, kind, optional, plus how many calls the compiled code makes into it. */
export const overviewRelTitle = (r: GraphRel): string => {
  const base = relTitle(r);
  const calls = Number(r.properties.calls ?? 0);
  return calls > 0 ? `${base} · ${calls.toLocaleString()} calls` : base;
};

/**
 * `toNvl` plus the overview styling: role colours, download sizing, fixed positions, the version chain, and
 * dependency edges coloured by kind. Captions come from `overviewLabels`.
 */
export const toNvlOverview = (store: GraphStore, selectedId: string | null, view: ViewOptions): { nodes: NvlNode[]; rels: NvlRel[] } => {
  const base = toNvl(store, selectedId, view);
  const root = findRoot(store);
  const nodes = base.nodes.map((nn) => {
    const n = store.nodes.get(nn.id);
    if (!n) return nn;
    const pos = positions.get(n.id);
    // Captions are drawn by the OverviewLabels overlay; NVL's own would hide inside small nodes.
    const out: NvlNode = { ...nn, caption: '', ...(pos ? { x: pos.x, y: pos.y } : {}) };
    const role = roleOf(n);
    if (root && n.id === root.id) {
      out.color = ROLE_COLORS.root;
      out.size = 30;
    } else if (isCrate(n)) {
      out.size = sizeByDownloads(n);
      if (role === 'dependent') out.color = ROLE_COLORS.dependent;
      else if (role === 'callee') out.color = ROLE_COLORS.callee;
      else if (role === 'dep' && root) {
        const e = depEdgeFrom(store, root.id, n.id);
        out.color = !e ? ROLE_COLORS.dep : e.kind === 'build' ? ROLE_COLORS.depBuild : e.kind === 'dev' ? ROLE_COLORS.depDev : e.optional ? ROLE_COLORS.depOptional : ROLE_COLORS.dep;
      } else if (role === 'dep') out.color = ROLE_COLORS.dep;
    } else if (isVersion(n)) {
      out.size = n.properties.latest === true ? 13 : 8;
      out.color = n.properties.yanked === true ? ROLE_COLORS.versionYanked : n.properties.semver_pre ? ROLE_COLORS.versionPre : ROLE_COLORS.version;
    }
    return out;
  });

  // The version strip reads as a timeline: a canvas-only oldest -> newest chain (`PRECEDES`, not stored)
  // instead of a VERSION_OF arrow from the root to every version (those stay in the store for details).
  const rootName = root ? String(root.properties.name) : null;
  const strip = rootName === null ? [] : [...store.nodes.values()].filter((n) => isVersion(n) && n.properties.name === rootName).sort(cmpSemver);
  const stripIds = new Set(strip.map((n) => n.id));
  const chain: NvlRel[] = [];
  if (!view.hiddenRelTypes.has('PRECEDES')) {
    for (let i = 1; i < strip.length; i += 1) {
      chain.push({
        id: `next:${strip[i - 1].id}->${strip[i].id}`,
        from: strip[i - 1].id,
        to: strip[i].id,
        type: 'PRECEDES',
        color: '#4A5160',
        width: 1,
        caption: undefined,
      });
    }
  }

  const rels = base.rels.filter((rr) => {
    const r = store.rels.get(rr.id);
    if (!r || r.type !== 'VERSION_OF' || !root) return true;
    const other = r.from === root.id ? r.to : r.to === root.id ? r.from : null;
    return other === null || !stripIds.has(other);
  }).map((rr) => {
    const r = store.rels.get(rr.id);
    if (!r || r.type !== 'DEPENDS_ON') return rr;
    const out: NvlRel = { ...rr };
    if (r.properties.aggregated === true) {
      out.color = ROLE_COLORS.dependent;
    } else if (r.properties.kind !== undefined) {
      const kind = String(r.properties.kind);
      out.color = kind === 'build' ? ROLE_COLORS.depBuild : kind === 'dev' ? ROLE_COLORS.depDev : r.properties.optional === true ? ROLE_COLORS.depOptional : COLORS.DEPENDS_ON;
      const calls = Number(r.properties.calls ?? 0);
      out.width = calls > 0 ? Math.min(1.5 + Math.log2(calls + 1) / 1.5, 8) : 1.5;
      if (view.showRelCaptions) out.caption = overviewRelTitle(r);
    }
    return out;
  });

  return { nodes, rels: [...rels, ...chain] };
};
