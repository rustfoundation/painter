const env = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};

const int = (name, fallback) => {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: int('PORT', 8080),
  host: env('HOST', '0.0.0.0'),
  neo4j: {
    uri: env('NEO4J_URI', 'bolt://localhost:7687'),
    user: env('NEO4J_USER', 'neo4j'),
    password: env('NEO4J_PASSWORD', 'changeme123'),
    database: env('NEO4J_DATABASE', 'neo4j'),
    maxRows: int('NEO4J_MAX_ROWS', 2000),
    queryTimeoutMs: int('NEO4J_QUERY_TIMEOUT_MS', 30_000),
    connectRetries: int('NEO4J_CONNECT_RETRIES', 0),
    connectRetryDelayMs: int('NEO4J_CONNECT_RETRY_DELAY_MS', 3000),
  },
  // Queries always run in a read transaction, but you may want this off on a shared deployment.
  allowCypher: env('RENDER_ALLOW_CYPHER', 'true') !== 'false',
  depsMaxEdges: int('RENDER_DEPS_MAX_EDGES', 50_000),
  depsDefaultEdges: int('RENDER_DEPS_DEFAULT_EDGES', 5_000),
  depsCacheMs: int('RENDER_DEPS_CACHE_MS', 600_000),
  // Scans every DEPENDS_ON edge.
  depsTimeoutMs: int('RENDER_DEPS_TIMEOUT_MS', 180_000),
  lod: {
    iterations: int('RENDER_LOD_ITERATIONS', 300),
    // Whole DEPENDS_ON scan.
    timeoutMs: int('RENDER_LOD_TIMEOUT_MS', 3_600_000),
    // A full crates.io graph needs a few GB.
    workerHeapMb: int('RENDER_LOD_WORKER_HEAP_MB', 8192),
    budget: int('RENDER_LOD_BUDGET', 600),
    maxLevel: int('RENDER_LOD_MAX_LEVEL', 12),
    // Positions every N iterations, so a crash can be resumed.
    checkpointPath: env('RENDER_LOD_CHECKPOINT', '/tmp/painter-lod-checkpoint.json'),
  },
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
  lod: { iterations: config.lod.iterations, budget: config.lod.budget, maxLevel: config.lod.maxLevel },
});
