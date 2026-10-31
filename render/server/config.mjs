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
  // Deps view: crates drawn per tree by default, and the most a request may ask for.
  depsDefaultNodes: int('RENDER_DEPS_DEFAULT_NODES', 300),
  depsMaxNodes: int('RENDER_DEPS_MAX_NODES', 2_000),
  depsCacheMs: int('RENDER_DEPS_CACHE_MS', 600_000),
  // Whole-relationship-type scans (unsafe:all live fallback, ecosystem-wide queries).
  depsTimeoutMs: int('RENDER_DEPS_TIMEOUT_MS', 180_000),
  lod: {
    iterations: int('RENDER_LOD_ITERATIONS', 300),
    // Whole DEPENDS_ON scan.
    timeoutMs: int('RENDER_LOD_TIMEOUT_MS', 3_600_000),
    // A full crates.io graph needs a few GB.
    workerHeapMb: int('RENDER_LOD_WORKER_HEAP_MB', 8192),
    budget: int('RENDER_LOD_BUDGET', 600),
    maxLevel: int('RENDER_LOD_MAX_LEVEL', 12),
    // JSON snapshot of the loaded viewport index, keyed on LodMeta.built_at: a restart reads it in seconds
    // instead of streaming every crate and LOD_DEP edge again (minutes). Empty disables it.
    cachePath: env('RENDER_LOD_INDEX_CACHE', '/tmp/painter-lod-index.json'),
    // Positions every N iterations, so a crash can be resumed.
    checkpointPath: env('RENDER_LOD_CHECKPOINT', '/tmp/painter-lod-checkpoint.json'),
  },
  // Base URL of the jobs service (server/jobs/index.mjs). When set, render never runs a LOD worker or a stats
  // refresh itself: POST /api/lod/* and /api/stats/refresh are forwarded there, so the graph has one writer.
  jobsUrl: env('RENDER_JOBS_URL', '').replace(/\/+$/, ''),
  jobs: {
    // Dashboard totals (Stats nodes) are recomputed this often; 0 disables the timer (manual refresh only).
    statsIntervalMs: int('JOBS_STATS_INTERVAL_MS', 15 * 60_000),
    // Per-payload limit: unsafe:all is ~95 s on a cold local database and slower under import load.
    queryTimeoutMs: int('JOBS_QUERY_TIMEOUT_MS', 600_000),
    // The cheap Map update (place crates imported since the last build); 0 = only on request.
    lodUpdateIntervalMs: int('JOBS_LOD_UPDATE_INTERVAL_MS', 0),
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
  depsDefaultNodes: config.depsDefaultNodes,
  depsMaxNodes: config.depsMaxNodes,
  lod: { iterations: config.lod.iterations, budget: config.lod.budget, maxLevel: config.lod.maxLevel },
  jobsUrl: config.jobsUrl || null,
  jobs: config.jobs,
});
