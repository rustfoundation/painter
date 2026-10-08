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
  meta: { records: number; elapsedMs: number; truncated?: boolean };
}

export interface Health {
  ok: boolean;
  error: string | null;
  server: { agent: string; address: string; protocolVersion: { major: number; minor: number } } | null;
  config: {
    neo4j: { uri: string; user: string; database: string; maxRows: number; queryTimeoutMs: number };
    allowCypher: boolean;
  };
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
  expand: (id: string, direction: 'in' | 'out' | 'both', types: ExpandType[], limit = 100) =>
    request<GraphPayload>('/api/graph/expand', json({ id, direction, types, limit })),
  cypher: (query: string, params: Record<string, unknown> = {}) =>
    request<GraphPayload>('/api/cypher', json({ query, params })),
};
