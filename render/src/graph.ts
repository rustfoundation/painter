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
  unknownNode: '#888888',
  unknownRel: '#666666',
} as const;

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

export const nodeTitle = (n: GraphNode): string => {
  const p = n.properties;
  if (isVersion(n)) return `${p.name}@${p.version}`;
  if (isCrate(n)) return String(p.name ?? n.id);
  return String(p.name ?? p.title ?? n.id);
};

export const relTitle = (r: GraphRel): string => {
  if (r.type === 'INVOKES' && typeof r.properties.count === 'number') return `INVOKES ×${r.properties.count}`;
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
    const base = isCrate(n) ? 22 : 14;
    const size = Math.min(base + Math.log2(d + 1) * 4, 60);
    let color: string = COLORS.unknownNode;
    if (isCrate(n)) color = store.roots.has(String(n.properties.name)) ? COLORS.crateRoot : COLORS.crate;
    else if (isVersion(n)) {
      if (n.properties.latest === true) color = COLORS.versionLatest;
      else if (n.properties.semver_pre) color = COLORS.versionPre;
      else color = COLORS.version;
    }
    nodes.push({
      id: n.id,
      caption: nodeTitle(n),
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
