// Thin client for the render server's JSON API (same origin, /api/...).

export interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphRel {
  id: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, unknown>;
}

export interface GraphPayload {
  nodes: GraphNode[];
  rels: GraphRel[];
  rows?: Record<string, unknown>[];
  columns?: string[];
  meta: {
    records: number;
    elapsedMs: number;
    truncated?: boolean;
    resolvedName?: string;
    /** Deps view: edge cap applied, total crate->crate pairs in the DB (whole-graph only), cache hit. */
    limit?: number;
    totalPairs?: number | null;
    cached?: boolean;
    /** Deps chain: filter text, whether it was a partial match, root crate names, depth reached. */
    query?: string;
    partial?: boolean;
    roots?: string[];
    depth?: number;
    maxDepth?: number;
    crates?: number;
    edges?: number;
  };
}

export interface Health {
  ok: boolean;
  error: string | null;
  server: { agent: string; address: string; protocolVersion: { major: number; minor: number } } | null;
  config: {
    neo4j: { uri: string; user: string; database: string; maxRows: number; queryTimeoutMs: number };
    allowCypher: boolean;
    depsMaxEdges: number;
    depsDefaultEdges: number;
  };
}

/** Which graph the UI shows. */
export type View = 'default' | 'deps' | 'map';

export const VIEWS: { id: View; label: string; title: string }[] = [
  { id: 'default', label: 'Default', title: 'Crates, versions, and their DEPENDS_ON / INVOKES edges' },
  { id: 'deps', label: 'Deps', title: 'Transitive crate-level dependency chain of every crate matching the filter' },
  { id: 'map', label: 'Map', title: 'Whole ecosystem on a precomputed layout; zoom in to resolve clusters into crates' },
];

/** Map view: one viewport's worth of elements from the LOD index. */
export interface LodViewport {
  mode: 'crates' | 'cells';
  level: number;
  nodes: GraphNode[];
  rels: GraphRel[];
  meta: {
    inView: number;
    total: number;
    cells?: number;
    elapsedMs: number;
    relsTruncated: boolean;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
  };
}

export interface LodJob {
  kind: 'build' | 'update';
  startedAt: string;
  phase: string;
  done: number | null;
  total: number | null;
  message: string | null;
}

export interface LodStatus {
  running: LodJob | null;
  last: { kind: string; startedAt: string; finishedAt: string; ok: boolean; error: string | null; elapsedMs: number } | null;
  meta: Record<string, unknown> | null;
  unpositionedCrates: number | null;
  index: { loadedAt: string; crates: number; edges: number; bounds: LodViewport['meta']['bounds']; maxLevel: number } | null;
  indexLoading: boolean;
  indexError: string | null;
  config: { iterations: number; budget: number; maxLevel: number };
}

export interface Stats {
  crates: number;
  versions: number;
  dependsOn: number;
  invokes: number;
}

export interface CrateLoadOptions {
  versions: 'latest' | 'all';
  deps: boolean;
  invokes: boolean;
  dependents: boolean;
  limit: number;
}

export type ExpandType = 'VERSION_OF' | 'DEPENDS_ON' | 'INVOKES';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string | null = null,
  ) {
    super(message);
  }
}

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body ?? {}) as { error?: string; code?: string | null };
    throw new ApiError(err.error ?? `${res.status} ${res.statusText}`, res.status, err.code ?? null);
  }
  return body as T;
};

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  health: () => request<Health>('/api/health'),
  stats: () => request<Stats>('/api/stats'),
  searchCrates: (q: string, limit = 15) =>
    request<{ names: string[] }>(`/api/crates/search?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) => r.names),
  loadCrate: (name: string, opts: CrateLoadOptions) => {
    const params = new URLSearchParams({
      versions: opts.versions,
      deps: String(opts.deps),
      invokes: String(opts.invokes),
      dependents: String(opts.dependents),
      limit: String(opts.limit),
    });
    return request<GraphPayload>(`/api/graph/crate/${encodeURIComponent(name)}?${params}`);
  },
  /**
   * Transitive crate-level dependency chain for every crate matching `q`
   * (partial match from 3 characters, exact below). depth 0 = unlimited.
   */
  loadDepsChain: (q: string, limit: number, depth: number, exact = false) =>
    request<GraphPayload>(
      `/api/graph/deps/chain?${new URLSearchParams({ q, limit: String(limit), depth: String(depth), exact: exact ? '1' : '0' })}`,
    ),
  /** Crate-level dependency graph. `crate` null loads the whole (capped) graph. */
  loadDeps: (crate: string | null, direction: 'in' | 'out' | 'both', limit: number) => {
    const params = new URLSearchParams({ direction, limit: String(limit) });
    if (crate) params.set('crate', crate);
    return request<GraphPayload>(`/api/graph/deps?${params}`);
  },
  lodStatus: () => request<LodStatus>('/api/lod/status'),
  lodRebuild: (opts: { iterations?: number; reuseEdges?: boolean; resume?: boolean } = {}) =>
    request<LodStatus>('/api/lod/rebuild', json(opts)),
  lodUpdate: () => request<LodStatus>('/api/lod/update', json({})),
  lodViewport: (bbox: { x0: number; y0: number; x1: number; y1: number } | null, budget: number, minCell = 0) => {
    const params = new URLSearchParams({ budget: String(budget), minCell: String(minCell) });
    if (bbox) for (const k of ['x0', 'y0', 'x1', 'y1'] as const) params.set(k, String(bbox[k]));
    return request<LodViewport>(`/api/lod/viewport?${params}`);
  },
  lodLocate: (name: string) =>
    request<{ name: string; x: number; y: number; community: number; degree: number }>(`/api/lod/locate?name=${encodeURIComponent(name)}`),
  lodSearch: (q: string, limit = 15) =>
    request<{ names: string[] }>(`/api/lod/search?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) => r.names),
  expand: (id: string, direction: 'in' | 'out' | 'both', types: ExpandType[], limit = 100) =>
    request<GraphPayload>('/api/graph/expand', json({ id, direction, types, limit })),
  cypher: (query: string, params: Record<string, unknown> = {}) =>
    request<GraphPayload>('/api/cypher', json({ query, params })),
};
