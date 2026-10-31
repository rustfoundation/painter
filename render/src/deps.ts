// Deps view model: the server's bounded tree (`/api/deps/tree`, server/deps.mjs), progressive
// expansion, a layered layout by hop count, and the root-to-node path. Everything here is keyed by
// crate name; the server never returns Neo4j element ids for this view.
import { request } from './api';

export type DepsMode = 'latest' | 'any';
export type DepsDirection = 'out' | 'in';
export type DepKind = 'normal' | 'build' | 'dev';
export const DEP_KINDS: DepKind[] = ['normal', 'build', 'dev'];

export interface DepsOptions {
  /** `latest`: the current version's declared dependencies; `any`: any version ever published (Map's LOD_DEP). */
  mode: DepsMode;
  /** `out`: what the root depends on; `in`: what depends on the root. */
  direction: DepsDirection;
  kinds: Record<DepKind, boolean>;
  /** Include optional (feature-gated) dependencies. */
  optional: boolean;
  /** Hops from the root fetched up front; deeper levels are fetched by expanding a crate. */
  depth: number;
  /** Node budget per tree. */
  limit: number;
}

export const DEFAULT_DEPS_OPTIONS: DepsOptions = {
  mode: 'latest',
  direction: 'out',
  kinds: { normal: true, build: false, dev: false },
  optional: false,
  depth: 2,
  limit: 300,
};

export interface DepsNode {
  name: string;
  /** Hops from the root along fetched edges (shortest). */
  depth: number;
  downloads: number | null;
  /** Crate-level in-degree: how many crates ever declared a dependency on it. */
  dependents: number;
  /** Direct children dropped by the node budget. */
  hidden: number;
  /** Direct children beyond the fetched depth. */
  unexpanded: number;
}

export interface DepsEdge {
  /** The dependent. */
  from: string;
  /** The dependency. */
  to: string;
  kinds: DepKind[];
  optional: boolean;
  req: string | null;
  /** `any` mode: how many versions of `from` declared it. */
  versions: number | null;
}

export interface DepsLevel {
  depth: number;
  frontier: number;
  indegree?: number;
  rows: number;
  elapsedMs: number;
}

export interface DepsTreeMeta {
  mode: DepsMode;
  direction: DepsDirection;
  kinds: DepKind[];
  optional: boolean;
  depth: number;
  budget: number;
  depthReached: number;
  nodes: number;
  edges: number;
  hidden: number;
  unexpanded: number;
  truncated: boolean;
  queries: number;
  levels: DepsLevel[];
  elapsedMs: number;
  resolvedName: string;
  query: string;
}

export interface DepsTree {
  root: string;
  rootInfo: {
    latest: string | null;
    description: string | null;
    /** Dependency declarations of the root's current version, grouped by kind and optional. */
    declared: { kind: string; optional: boolean; n: number }[];
  };
  nodes: DepsNode[];
  edges: DepsEdge[];
  meta: DepsTreeMeta;
}

export interface DepsExpansion {
  root: string;
  nodes: DepsNode[];
  edges: DepsEdge[];
  meta: { total: number; truncated: boolean; elapsedMs: number };
}

const params = (opts: DepsOptions, extra: Record<string, string>) =>
  new URLSearchParams({
    ...extra,
    mode: opts.mode,
    direction: opts.direction,
    kinds: DEP_KINDS.filter((k) => opts.kinds[k]).join(',') || 'normal',
    optional: opts.optional ? '1' : '0',
    depth: String(opts.depth),
    limit: String(opts.limit),
  });

export const depsApi = {
  tree: (crate: string, opts: DepsOptions) => request<DepsTree>(`/api/deps/tree?${params(opts, { crate })}`),
  expand: (crate: string, opts: DepsOptions) => request<DepsExpansion>(`/api/deps/expand?${params(opts, { crate })}`),
};

/** What the status bar reports about the tree on screen. */
export interface DepsStatus {
  root: string;
  version: string | null;
  direction: DepsDirection;
  mode: DepsMode;
  kinds: DepKind[];
  optional: boolean;
  depth: number;
  depthReached: number;
  nodes: number;
  edges: number;
  /** Direct children of drawn crates that are not drawn (budget or depth). */
  notShown: number;
  truncated: boolean;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------------------------
// Store

export interface DepsGraph {
  root: string;
  rootInfo: DepsTree['rootInfo'];
  direction: DepsDirection;
  nodes: Map<string, DepsNode>;
  edges: Map<string, DepsEdge>;
  /** Crates whose children were fetched explicitly (so "+N" means truncation, not depth). */
  expanded: Set<string>;
}

export const edgeKey = (e: { from: string; to: string }) => `${e.from}→${e.to}`;

/** Parent and child of an edge as the tree sees it: the root is always the parent side. */
export const parentOf = (e: DepsEdge, direction: DepsDirection) => (direction === 'out' ? e.from : e.to);
export const childOf = (e: DepsEdge, direction: DepsDirection) => (direction === 'out' ? e.to : e.from);

export const buildGraph = (tree: DepsTree): DepsGraph => ({
  root: tree.root,
  rootInfo: tree.rootInfo,
  direction: tree.meta.direction,
  nodes: new Map(tree.nodes.map((n) => [n.name, n])),
  edges: new Map(tree.edges.map((e) => [edgeKey(e), e])),
  expanded: new Set(),
});

/** Merges one crate's fetched children; new crates sit one hop below it. */
export const mergeExpansion = (g: DepsGraph, exp: DepsExpansion): DepsGraph => {
  const nodes = new Map(g.nodes);
  const edges = new Map(g.edges);
  const parent = nodes.get(exp.root);
  const base = parent?.depth ?? 0;
  for (const n of exp.nodes) {
    if (n.name !== exp.root && !nodes.has(n.name)) nodes.set(n.name, { ...n, depth: base + 1 });
  }
  for (const e of exp.edges) if (nodes.has(e.from) && nodes.has(e.to)) edges.set(edgeKey(e), e);
  if (parent) {
    // Children the server knows about: the ones it returned plus the ones it reports as not returned.
    const fetched = exp.edges.filter((e) => parentOf(e, g.direction) === exp.root).length;
    const total = fetched + (exp.nodes.find((n) => n.name === exp.root)?.hidden ?? 0);
    const shown = [...edges.values()].filter((e) => parentOf(e, g.direction) === exp.root).length;
    nodes.set(exp.root, { ...parent, hidden: Math.max(0, total - shown), unexpanded: 0 });
  }
  const expanded = new Set(g.expanded);
  expanded.add(exp.root);
  return { ...g, nodes, edges, expanded };
};

/** Children of `name` in the tree (edges where it is the parent). */
export const childrenOf = (g: DepsGraph, name: string): DepsEdge[] =>
  [...g.edges.values()].filter((e) => parentOf(e, g.direction) === name);

/** Removes everything that is only reachable from the root through `name`'s children. */
export const collapseNode = (g: DepsGraph, name: string): DepsGraph => {
  const children = childrenOf(g, name);
  if (children.length === 0) return g;
  const blocked = new Set(children.map((e) => edgeKey(e)));
  const reach = new Set<string>([g.root]);
  const queue = [g.root];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of g.edges.values()) {
      if (parentOf(e, g.direction) !== cur || blocked.has(edgeKey(e))) continue;
      const c = childOf(e, g.direction);
      if (!reach.has(c)) {
        reach.add(c);
        queue.push(c);
      }
    }
  }
  const nodes = new Map([...g.nodes].filter(([n]) => reach.has(n)));
  const edges = new Map([...g.edges].filter(([, e]) => nodes.has(e.from) && nodes.has(e.to)));
  const self = nodes.get(name);
  if (self) {
    const stillShown = [...edges.values()].filter((e) => parentOf(e, g.direction) === name).length;
    nodes.set(name, { ...self, unexpanded: children.length - stillShown + self.hidden + self.unexpanded, hidden: 0 });
  }
  const expanded = new Set([...g.expanded].filter((n) => nodes.has(n) && n !== name));
  return { ...g, nodes, edges, expanded };
};

/** Direct children a crate has that are not on screen. */
export const notShown = (n: DepsNode) => n.hidden + n.unexpanded;

// ---------------------------------------------------------------------------------------------
// Layout: layers by hop count from the root, ordered to keep parents above their children.

export interface Point {
  x: number;
  y: number;
}

export const LAYER_GAP = 150;
export const NODE_GAP = 112;
/** Vertical gap between the sub-rows of a wrapped layer. */
export const ROW_GAP = 90;

/** Shortest hop count from the root over parent -> child edges, plus the layers in BFS order. */
const layersOf = (g: DepsGraph): { depth: Map<string, number>; layers: string[][] } => {
  const children = new Map<string, DepsEdge[]>();
  for (const e of g.edges.values()) {
    const p = parentOf(e, g.direction);
    const list = children.get(p);
    if (list) list.push(e);
    else children.set(p, [e]);
  }
  const byDownloads = (a: string, b: string) =>
    (g.nodes.get(b)?.downloads ?? 0) - (g.nodes.get(a)?.downloads ?? 0) || a.localeCompare(b);
  const depth = new Map<string, number>([[g.root, 0]]);
  const layers: string[][] = [[g.root]];
  let frontier = [g.root];
  while (frontier.length) {
    const next: string[] = [];
    for (const p of frontier) {
      const kids = (children.get(p) ?? []).map((e) => childOf(e, g.direction)).sort(byDownloads);
      for (const c of kids) {
        if (depth.has(c)) continue;
        depth.set(c, layers.length);
        next.push(c);
      }
    }
    if (next.length) layers.push(next);
    frontier = next;
  }
  // Anything the root cannot reach (should not happen) goes in a final layer.
  const orphans = [...g.nodes.keys()].filter((n) => !depth.has(n)).sort(byDownloads);
  if (orphans.length) {
    for (const n of orphans) depth.set(n, layers.length);
    layers.push(orphans);
  }
  return { depth, layers };
};

export const layoutTree = (g: DepsGraph): Map<string, Point> => {
  const out = new Map<string, Point>();
  if (g.nodes.size === 0) return out;
  const { depth, layers } = layersOf(g);

  // Neighbours split by direction in the layering (parents = shallower, children = deeper).
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const e of g.edges.values()) {
    const a = e.from;
    const b = e.to;
    const da = depth.get(a) ?? 0;
    const db = depth.get(b) ?? 0;
    if (da === db) continue;
    const [shallow, deep] = da < db ? [a, b] : [b, a];
    (down.get(shallow) ?? down.set(shallow, []).get(shallow)!).push(deep);
    (up.get(deep) ?? up.set(deep, []).get(deep)!).push(shallow);
  }

  // Barycenter ordering: a few sweeps sorting each layer by the mean normalized position of its
  // neighbours in the adjacent direction. Positions are normalized per layer so layers of different
  // widths compare.
  const pos = new Map<string, number>();
  const normalize = (layer: string[]) => layer.forEach((n, i) => pos.set(n, layer.length === 1 ? 0.5 : i / (layer.length - 1)));
  layers.forEach(normalize);
  const sweep = (layer: string[], nbrs: Map<string, string[]>) => {
    const key = new Map<string, number>();
    for (const n of layer) {
      const ns = nbrs.get(n);
      key.set(n, ns && ns.length ? ns.reduce((s, m) => s + (pos.get(m) ?? 0.5), 0) / ns.length : (pos.get(n) ?? 0.5));
    }
    layer.sort((a, b) => key.get(a)! - key.get(b)! || pos.get(a)! - pos.get(b)!);
    normalize(layer);
  };
  for (let iter = 0; iter < 3; iter += 1) {
    for (let d = 1; d < layers.length; d += 1) sweep(layers[d], up);
    for (let d = layers.length - 2; d >= 1; d -= 1) sweep(layers[d], down);
  }
  for (let d = 1; d < layers.length; d += 1) sweep(layers[d], up);

  // Wide layers wrap into balanced sub-rows (keeping the barycenter order) so the tree stays roughly
  // as wide as it is tall and captions remain readable when fitted. Their positions are fixed here.
  const x = new Map<string, number>();
  const rowOf = new Map<string, number>();
  const wrapped = new Set<number>();
  layers.forEach((layer, d) => {
    const rowMax = Math.min(24, Math.max(10, Math.ceil(Math.sqrt(layer.length * 3))));
    if (layer.length <= rowMax) {
      layer.forEach((n, i) => x.set(n, (i - (layer.length - 1) / 2) * NODE_GAP));
      return;
    }
    wrapped.add(d);
    const rows = Math.ceil(layer.length / rowMax);
    const perRow = Math.ceil(layer.length / rows);
    for (let r = 0; r < rows; r += 1) {
      const row = layer.slice(r * perRow, (r + 1) * perRow);
      // Odd rows shift by half a gap so edges from above pass between the nodes of the row in front.
      const offset = r % 2 ? NODE_GAP / 2 : 0;
      row.forEach((n, i) => {
        x.set(n, (i - (row.length - 1) / 2) * NODE_GAP + offset);
        rowOf.set(n, r);
      });
    }
  });

  // Narrow layers: parents pulled over the centroid of their children (and children under their
  // parents) while keeping the order and a minimum gap.
  const pull = (d: number, nbrs: Map<string, string[]>) => {
    const layer = layers[d];
    if (layer.length === 0 || wrapped.has(d)) return;
    const target = layer.map((n) => {
      const ns = nbrs.get(n);
      return ns && ns.length ? ns.reduce((s, m) => s + (x.get(m) ?? 0), 0) / ns.length : x.get(n)!;
    });
    // Enforce the gap left to right, then recentre on the mean target so the layer does not drift.
    const placed: number[] = [];
    for (let i = 0; i < layer.length; i += 1) placed.push(i === 0 ? target[0] : Math.max(target[i], placed[i - 1] + NODE_GAP));
    const shift = target.reduce((s, v) => s + v, 0) / target.length - placed.reduce((s, v) => s + v, 0) / placed.length;
    layer.forEach((n, i) => x.set(n, placed[i] + shift));
  };
  for (let iter = 0; iter < 3; iter += 1) {
    for (let d = 1; d < layers.length; d += 1) pull(d, up);
    for (let d = layers.length - 2; d >= 0; d -= 1) pull(d, down);
  }

  let y = 0;
  layers.forEach((layer, d) => {
    if (d > 0) y += LAYER_GAP;
    let rows = 1;
    for (const n of layer) {
      const r = rowOf.get(n) ?? 0;
      rows = Math.max(rows, r + 1);
      out.set(n, { x: x.get(n)!, y: y + r * ROW_GAP });
    }
    y += (rows - 1) * ROW_GAP;
  });
  return out;
};

// ---------------------------------------------------------------------------------------------
// Paths

export interface DepsPath {
  /** Root first. */
  names: string[];
  /** Keys of the edges on the path. */
  edges: Set<string>;
  /** `steps[i]` joins `names[i]` and `names[i + 1]`. */
  steps: DepsEdge[];
}

/** Shortest root -> name path over parent -> child edges. */
export const pathFromRoot = (g: DepsGraph, name: string): DepsPath | null => {
  if (name === g.root) return { names: [g.root], edges: new Set(), steps: [] };
  const prev = new Map<string, DepsEdge>();
  const seen = new Set<string>([g.root]);
  const queue = [g.root];
  const byParent = new Map<string, DepsEdge[]>();
  for (const e of g.edges.values()) {
    const p = parentOf(e, g.direction);
    (byParent.get(p) ?? byParent.set(p, []).get(p)!).push(e);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of byParent.get(cur) ?? []) {
      const c = childOf(e, g.direction);
      if (seen.has(c)) continue;
      seen.add(c);
      prev.set(c, e);
      if (c === name) {
        const names = [name];
        const steps: DepsEdge[] = [];
        let at = name;
        while (at !== g.root) {
          const edge = prev.get(at)!;
          steps.push(edge);
          at = parentOf(edge, g.direction);
          names.push(at);
        }
        steps.reverse();
        return { names: names.reverse(), edges: new Set(steps.map(edgeKey)), steps };
      }
      queue.push(c);
    }
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// Styling

export const DEPS_COLORS = {
  root: '#1F5FD1',
  crate: '#4C8DFF',
  onPath: '#9CC2FF',
  pathEdge: '#FFD166',
  kind: { normal: '#7E96B8', build: '#F5A623', dev: '#B88BFF' } as Record<DepKind, string>,
};

/** Dominant kind of an edge for colouring: normal beats build beats dev. */
export const edgeKind = (e: DepsEdge): DepKind | null => DEP_KINDS.find((k) => e.kinds.includes(k)) ?? null;

const withAlpha = (hex: string, alpha: number) => {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};

/** `faint`: a shortcut to a crate already reached by a shorter path (not part of the tree proper). */
export const edgeColor = (e: DepsEdge, mode: DepsMode, faint = false): string => {
  const base = mode === 'any' ? DEPS_COLORS.kind.normal : DEPS_COLORS.kind[edgeKind(e) ?? 'normal'];
  let alpha = mode === 'any' ? 0.7 : e.optional ? 0.38 : 1;
  if (faint) alpha *= 0.22;
  return alpha === 1 ? base : withAlpha(base, alpha);
};

/** True when the edge goes exactly one hop deeper from the root's side (a tree edge, not a shortcut). */
export const isTreeEdge = (g: DepsGraph, e: DepsEdge): boolean => {
  const p = g.nodes.get(parentOf(e, g.direction));
  const c = g.nodes.get(childOf(e, g.direction));
  return Boolean(p && c && c.depth === p.depth + 1);
};

/**
 * Declarations of the root's current version the options leave out, e.g. `{optional: 23, dev: 5}`.
 * Counts declarations (a dependency listed for two targets counts twice).
 */
export const excludedDeclarations = (g: DepsGraph, opts: DepsOptions): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const d of g.rootInfo.declared ?? []) {
    const kind = (DEP_KINDS as string[]).includes(d.kind) ? (d.kind as DepKind) : 'normal';
    if (!opts.kinds[kind]) out[kind] = (out[kind] ?? 0) + d.n;
    else if (d.optional && !opts.optional) out.optional = (out.optional ?? 0) + d.n;
  }
  return out;
};

export const edgeWidth = (e: DepsEdge, mode: DepsMode): number => {
  if (mode === 'any') return Math.min(1 + Math.log2((e.versions ?? 1) + 1) / 2, 5);
  return e.optional ? 1 : 1.8;
};

export const nodeSize = (n: DepsNode, isRoot: boolean): number => {
  const s = 20 + Math.log2(n.dependents + 1) * 2;
  return Math.max(isRoot ? 36 : 0, Math.min(s, 48));
};

export const compact = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '–';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(n);
};

export const describeEdge = (e: DepsEdge, mode: DepsMode): string => {
  if (mode === 'any') return `${e.versions ?? '?'} version${e.versions === 1 ? '' : 's'} of ${e.from} declared ${e.to}`;
  const kinds = e.kinds.length ? e.kinds.join(' + ') : 'normal';
  return `${e.from} → ${e.to}: ${kinds}${e.optional ? ', optional' : ''}${e.req ? ` ${e.req}` : ''}`;
};
