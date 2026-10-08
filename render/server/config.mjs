// Runtime configuration for the render server.
//
// Everything is read from the environment at startup so the same image can be
// pointed at any Neo4j instance (the compose-internal `neo4j` service, a
// localhost instance for development, or a remote one).

const env = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};

const int = (name, fallback) => {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  /** HTTP port the render server listens on. */
  port: int('PORT', 8080),
  /** Interface to bind. `0.0.0.0` in docker, `127.0.0.1` is fine locally. */
  host: env('HOST', '0.0.0.0'),
  neo4j: {
    /** Bolt URI, e.g. bolt://localhost:7687 or neo4j://neo4j:7687 */
    uri: env('NEO4J_URI', 'bolt://localhost:7687'),
    user: env('NEO4J_USER', 'neo4j'),
    password: env('NEO4J_PASSWORD', 'changeme123'),
    database: env('NEO4J_DATABASE', 'neo4j'),
    /** Hard cap on rows returned by any query, including ad-hoc Cypher. */
    maxRows: int('NEO4J_MAX_ROWS', 2000),
    /** Per-query transaction timeout in milliseconds. */
    queryTimeoutMs: int('NEO4J_QUERY_TIMEOUT_MS', 30_000),
    /** How many times to retry the initial connectivity check before giving up (0 = forever). */
    connectRetries: int('NEO4J_CONNECT_RETRIES', 0),
    connectRetryDelayMs: int('NEO4J_CONNECT_RETRY_DELAY_MS', 3000),
  },
  /**
   * Allow arbitrary Cypher through POST /api/cypher. Queries always run in a
   * read transaction, but you may still want this off on a shared deployment.
   */
  allowCypher: env('RENDER_ALLOW_CYPHER', 'true') !== 'false',
  /**
   * Crate-level dependency view (/api/graph/deps). `depsMaxEdges` caps how
   * many aggregated crate->crate edges one response may carry; the full
   * graph result is cached in memory for `depsCacheMs`.
   */
  depsMaxEdges: int('RENDER_DEPS_MAX_EDGES', 50_000),
  depsDefaultEdges: int('RENDER_DEPS_DEFAULT_EDGES', 5_000),
  depsCacheMs: int('RENDER_DEPS_CACHE_MS', 600_000),
  /** Transaction timeout for the whole-graph deps query, which scans every DEPENDS_ON edge. */
  depsTimeoutMs: int('RENDER_DEPS_TIMEOUT_MS', 180_000),
};

export const describeConfig = () => ({
  port: config.port,
  host: config.host,
  neo4j: {
    uri: config.neo4j.uri,
    user: config.neo4j.user,
    database: config.neo4j.database,
    maxRows: config.neo4j.maxRows,
    queryTimeoutMs: config.neo4j.queryTimeoutMs,
  },
  allowCypher: config.allowCypher,
  depsMaxEdges: config.depsMaxEdges,
  depsDefaultEdges: config.depsDefaultEdges,
});
