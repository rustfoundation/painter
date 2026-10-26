// Mapping from the painter graph schema to NVL nodes/relationships, plus the
// in-memory graph store the UI mutates (merge, remove, clear).

import type { Node as NvlNode, Relationship as NvlRel } from '@neo4j-nvl/base';
import type { GraphNode, GraphPayload, GraphRel } from './api';

export const COLORS = {
  crate: '#4C8DFF',
  crateRoot: '#1F5FD1',
  version: '#F5A623',
  versionLatest: '#2BB673',
  versionPre: '#B88BFF',
  VERSION_OF: '#9AA3B2',
  DEPENDS_ON: '#4C8DFF',
  INVOKES: '#E5484D',
  user: '#E36BAE',
  team: '#20B2AA',
  OWNS: '#E36BAE',
  PUBLISHED: '#C9A227',
  unknownNode: '#888888',
  unknownRel: '#666666',
} as const;

/** Stable, distinguishable colour for a Louvain community id. */
export const communityColor = (id: number): string => {
  if (id < 0) return '#6b7280';
  const golden = 0.618033988749895;
  const h = ((id * golden) % 1) * 360;
  const s = (62 + (id % 3) * 8) / 100;
  const l = (52 + ((id >> 2) % 3) * 6) / 100;
  // HSL -> hex. NVL parses colours with `color-string`, which does not accept
  // the space-separated hsl() syntax, so emit hex.
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r1)}${hex(g1)}${hex(b1)}`;
};

export interface GraphStore {
  nodes: Map<string, GraphNode>;
  rels: Map<string, GraphRel>;
  /** Crate names that were explicitly loaded through the search box. */
  roots: Set<string>;
}

export const emptyStore = (): GraphStore => ({ nodes: new Map(), rels: new Map(), roots: new Set() });

/** Return a new store with `payload` merged in (immutable update for React). */
export const mergePayload = (store: GraphStore, payload: GraphPayload, root?: string): GraphStore => {
  const nodes = new Map(store.nodes);
  const rels = new Map(store.rels);
  for (const n of payload.nodes) nodes.set(n.id, n);
  for (const r of payload.rels) {
    if (nodes.has(r.from) && nodes.has(r.to)) rels.set(r.id, r);
  }
  const roots = new Set(store.roots);
  if (root) roots.add(root);
  return { nodes, rels, roots };
};

export const removeNode = (store: GraphStore, id: string): GraphStore => {
  const nodes = new Map(store.nodes);
  nodes.delete(id);
  const rels = new Map([...store.rels].filter(([, r]) => r.from !== id && r.to !== id));
  return { nodes, rels, roots: store.roots };
};

/** Remove every node not connected to anything (after removals / filters). */
export const pruneIsolated = (store: GraphStore): GraphStore => {
  const connected = new Set<string>();
  for (const r of store.rels.values()) {
    connected.add(r.from);
    connected.add(r.to);
  }
  const nodes = new Map([...store.nodes].filter(([id, n]) => connected.has(id) || store.roots.has(String(n.properties.name))));
  return { nodes, rels: store.rels, roots: store.roots };
};

export const isCrate = (n: GraphNode) => n.labels.includes('Crate');
export const isVersion = (n: GraphNode) => n.labels.includes('Version');
export const isUser = (n: GraphNode) => n.labels.includes('User');
export const isTeam = (n: GraphNode) => n.labels.includes('Team');

export const nodeTitle = (n: GraphNode): string => {
  const p = n.properties;
  if (isVersion(n)) return `${p.name}@${p.version}`;
  if (isCrate(n)) return String(p.name ?? n.id);
  // Registry users and teams: the crates.io login (`github:org:team` for teams).
  if (isUser(n) || isTeam(n)) return String(p.login ?? p.name ?? n.id);
  return String(p.name ?? p.title ?? n.id);
};

/**
 * Canvas caption: the title plus the generate-metadata badges of a scanned version:
 * `⊘` yanked (registry job), `☢N` unsafe items, `⚙` build script (`⚙→lib` when it
 * declares `links`), `C` native code (`C!` vendored, `C+bin` prebuilt binaries),
 * `Δ+a/−r` lines changed since the previous version. Absent properties (job not run
 * yet) add nothing.
 */
export const nodeCaption = (n: GraphNode): string => {
  const title = nodeTitle(n);
  if (!isVersion(n)) return title;
  const p = n.properties;
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0);
  const badges: string[] = [];
  if (p.yanked === true) badges.push('⊘');
  if (num('unsafe_total') > 0) badges.push(`☢${num('unsafe_total').toLocaleString()}`);
  if (p.has_build_script === true) badges.push(typeof p.links === 'string' && p.links ? `⚙→${p.links}` : '⚙');
  if (p.has_native_code === true) badges.push(`C${p.vendored_native === true ? '!' : ''}${num('native_prebuilt_files') > 0 ? '+bin' : ''}`);
  if (typeof p.diff_base === 'string' && (num('diff_lines_added') > 0 || num('diff_lines_removed') > 0)) {
    badges.push(`Δ+${num('diff_lines_added').toLocaleString()}/−${num('diff_lines_removed').toLocaleString()}`);
  }
  return badges.length ? `${title} ${badges.join(' ')}` : title;
};

export const relTitle = (r: GraphRel): string => {
  if (r.type === 'INVOKES' && typeof r.properties.count === 'number') return `INVOKES ×${r.properties.count}`;
  if (r.type === 'PUBLISHED' && typeof r.properties.versions === 'number') return `${r.properties.versions} upload${r.properties.versions === 1 ? '' : 's'}`;
  if (r.type === 'OWNS' && typeof r.properties.since === 'string') return `since ${r.properties.since.slice(0, 10)}`;
  if (r.type === 'DEPENDS_ON' && r.properties.aggregated === true) {
    const v = Number(r.properties.versions ?? 0);
    return `${v} version${v === 1 ? '' : 's'}`;
  }
  if (r.type === 'DEPENDS_ON') {
    const kind = r.properties.kind && r.properties.kind !== 'normal' ? ` (${r.properties.kind})` : '';
    const opt = r.properties.optional ? ' optional' : '';
    return `${r.properties.requirement ?? ''}${kind}${opt}`.trim() || 'DEPENDS_ON';
  }
  return r.type;
};

export interface ViewOptions {
  showRelCaptions: boolean;
  hiddenRelTypes: Set<string>;
}

/** Convert the store into NVL element arrays. */
export const toNvl = (
  store: GraphStore,
  selectedId: string | null,
  view: ViewOptions,
): { nodes: NvlNode[]; rels: NvlRel[] } => {
  // Degree is used to scale node size a bit so hubs stand out.
  const degree = new Map<string, number>();
  for (const r of store.rels.values()) {
    if (view.hiddenRelTypes.has(r.type)) continue;
    degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
    degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
  }

  const nodes: NvlNode[] = [];
  for (const n of store.nodes.values()) {
    const d = degree.get(n.id) ?? 0;
    const base = isCrate(n) ? 22 : isUser(n) || isTeam(n) ? 18 : 14;
    const size = Math.min(base + Math.log2(d + 1) * 4, 60);
    let color: string = COLORS.unknownNode;
    if (isCrate(n)) color = store.roots.has(String(n.properties.name)) ? COLORS.crateRoot : COLORS.crate;
    else if (isUser(n)) color = COLORS.user;
    else if (isTeam(n)) color = COLORS.team;
    else if (isVersion(n)) {
      if (n.properties.latest === true) color = COLORS.versionLatest;
      else if (n.properties.semver_pre) color = COLORS.versionPre;
      else color = COLORS.version;
    }
    nodes.push({
      id: n.id,
      caption: nodeCaption(n),
      color,
      size,
      selected: n.id === selectedId,
    });
  }

  const rels: NvlRel[] = [];
  for (const r of store.rels.values()) {
    if (view.hiddenRelTypes.has(r.type)) continue;
    const color = (COLORS as Record<string, string>)[r.type] ?? COLORS.unknownRel;
    let width = 1;
    if (r.type === 'INVOKES' && typeof r.properties.count === 'number') {
      width = Math.min(1 + Math.log2(r.properties.count + 1), 8);
    } else if (r.type === 'DEPENDS_ON' && typeof r.properties.versions === 'number') {
      width = Math.min(1 + Math.log2(r.properties.versions + 1) / 2, 6);
    } else if (r.type === 'PUBLISHED' && typeof r.properties.versions === 'number') {
      width = Math.min(1 + Math.log2(r.properties.versions + 1) / 2, 6);
    }
    rels.push({
      id: r.id,
      from: r.from,
      to: r.to,
      type: r.type,
      color,
      width,
      caption: view.showRelCaptions ? relTitle(r) : undefined,
      captionSize: 10,
      selected: r.id === selectedId,
    });
  }

  return { nodes, rels };
};
