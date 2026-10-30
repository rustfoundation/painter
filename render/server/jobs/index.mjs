// painter-jobs: the one process that writes derived data into the graph. It refreshes the dashboard totals
// (`Stats` nodes, see ../stats.mjs) on a timer and runs the Map (LOD) build/update worker on request, so render
// instances stay read-only and never pay for a whole-graph scan on a request. Same image as render, different
// command; the control API below is HTTP on $PORT and is meant for render (RENDER_JOBS_URL) and run scripts.
import express from 'express';
import { config, describeConfig } from '../config.mjs';
import { createDriver, readRows, waitForNeo4j, write } from '../db.mjs';
import { createLodJobs } from '../lod/jobs.mjs';
import { STATS_IDS, STATS_JOBS, STATS_SCHEMA_CYPHER, isStatsId, readStatsAges, writeStats } from '../stats.mjs';

const log = (...args) => console.log(new Date().toISOString(), ...args);

const driver = createDriver(config, { poolSize: 4 });
// Stats queries are label scans (up to ~95 s each on a cold database), so they get their own long timeout.
const read = (cypher, params) => readRows(driver, config, cypher, params, { timeoutMs: config.jobs.queryTimeoutMs });
const writeCypher = (cypher, params) => write(driver, config, cypher, params);

const startedAt = new Date().toISOString();
let ready = false;

// --- stats ---

let statsRun = null; // { startedAt, reason, ids, done, current, results }
let statsLast = null;
let statsTimer = null;

/** Runs the given stats jobs one after another (one scan at a time keeps the load on neo4j bounded). */
const runStats = async ({ ids = STATS_IDS, reason = 'manual', skipFresherThanMs = 0 } = {}) => {
  if (statsRun) {
    const err = new Error(`a stats refresh is already running (${statsRun.done}/${statsRun.ids.length}, on ${statsRun.current})`);
    err.status = 409;
    throw err;
  }
  const run = { startedAt: new Date().toISOString(), reason, ids, done: 0, current: null, results: {} };
  statsRun = run;
  log(`stats: refresh started (${reason}, ${ids.length} payloads)`);
  try {
    // Another instance (or a manual run) may have just written some: skip those within the freshness window.
    const ages = skipFresherThanMs > 0 ? await readStatsAges(read).catch(() => ({})) : {};
    for (const id of ids) {
      run.current = id;
      const computedAt = ages[id]?.computedAt ? Date.parse(ages[id].computedAt) : 0;
      if (skipFresherThanMs > 0 && Date.now() - computedAt < skipFresherThanMs) {
        run.results[id] = { ok: true, skipped: true, computedAt: ages[id].computedAt };
        run.done += 1;
        continue;
      }
      const started = Date.now();
      try {
        const payload = await STATS_JOBS[id](read);
        const elapsedMs = Date.now() - started;
        await writeStats(writeCypher, id, payload, elapsedMs);
        run.results[id] = { ok: true, elapsedMs };
        log(`stats: ${id} in ${elapsedMs} ms`);
      } catch (err) {
        run.results[id] = { ok: false, elapsedMs: Date.now() - started, error: err.message };
        log(`stats: ${id} failed after ${Date.now() - started} ms: ${err.message}`);
      }
      run.done += 1;
    }
  } finally {
    run.current = null;
    const failed = Object.values(run.results).filter((r) => !r.ok).length;
    statsLast = { ...run, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(run.startedAt), failed };
    statsRun = null;
    log(`stats: refresh finished in ${statsLast.elapsedMs} ms, ${failed} failed`);
  }
  return statsLast;
};

const scheduleStats = () => {
  const interval = config.jobs.statsIntervalMs;
  if (interval <= 0) return log('stats: timer disabled (JOBS_STATS_INTERVAL_MS=0)');
  const tick = () => {
    if (statsRun) return;
    runStats({ reason: 'timer', skipFresherThanMs: interval / 2 }).catch((err) => log(`stats: timer run failed: ${err.message}`));
  };
  statsTimer = setInterval(tick, interval);
  statsTimer.unref();
  tick();
  log(`stats: refreshing every ${Math.round(interval / 1000)} s`);
};

// --- lod ---

const lodJobs = createLodJobs({ config, log });

const scheduleLodUpdate = () => {
  const interval = config.jobs.lodUpdateIntervalMs;
  if (interval <= 0) return;
  const timer = setInterval(() => {
    if (lodJobs.status().running) return;
    try {
      lodJobs.update({});
    } catch (err) {
      log(`lod update: not started: ${err.message}`);
    }
  }, interval);
  timer.unref();
  log(`lod: updating every ${Math.round(interval / 1000)} s`);
};

// --- control API ---

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const statsStatus = () => ({ running: statsRun ? { ...statsRun } : null, last: statsLast, intervalMs: config.jobs.statsIntervalMs, ids: STATS_IDS });

app.get(
  '/api/health',
  wrap(async (_req, res) => {
    let error = null;
    try {
      await driver.getServerInfo({ database: config.neo4j.database });
    } catch (err) {
      error = err.message;
    }
    res.status(error ? 503 : 200).json({ ok: !error, error, ready, startedAt, service: 'painter-jobs', config: describeConfig() });
  }),
);

app.get(
  '/api/status',
  wrap(async (_req, res) => {
    const stored = await readStatsAges(read).catch((err) => ({ error: err.message }));
    res.json({ service: 'painter-jobs', startedAt, ready, stats: { ...statsStatus(), stored }, lod: lodJobs.status() });
  }),
);

app.get('/api/stats/status', wrap(async (_req, res) => res.json({ ...statsStatus(), stored: await readStatsAges(read) })));

// Body: {ids?: string[]}; runs in the background, 202 with the run, 409 while one is in flight.
app.post(
  '/api/stats/refresh',
  wrap(async (req, res) => {
    const requested = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    const unknown = (requested ?? []).filter((id) => !isStatsId(id));
    if (unknown.length) return res.status(400).json({ error: `unknown stats ids: ${unknown.join(', ')}`, ids: STATS_IDS });
    if (statsRun) return res.status(409).json({ error: 'a stats refresh is already running', ...statsStatus() });
    runStats({ ids: requested ?? STATS_IDS, reason: 'request' }).catch((err) => log(`stats: requested run failed: ${err.message}`));
    res.status(202).json(statsStatus());
  }),
);

app.get('/api/lod/status', (_req, res) => res.json(lodJobs.status()));

const lodStart = (kind) =>
  wrap(async (req, res) => {
    const iterations = Number.parseInt(req.body?.iterations ?? '', 10);
    const options = { iterations: Number.isFinite(iterations) && iterations > 0 ? iterations : undefined, reuseEdges: Boolean(req.body?.reuseEdges), resume: Boolean(req.body?.resume) };
    try {
      res.status(202).json(kind === 'build' ? lodJobs.rebuild(options) : lodJobs.update(options));
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message, ...lodJobs.status() });
    }
  });

app.post('/api/lod/rebuild', lodStart('build'));
app.post('/api/lod/update', lodStart('update'));

app.use((err, _req, res, _next) => {
  log(`error: ${err.message}`);
  res.status(err.status ?? 500).json({ error: err.message });
});

log('starting painter-jobs with config', JSON.stringify(describeConfig()));

const server = app.listen(config.port, config.host, () => {
  log(`control API on http://${config.host}:${config.port}`);
});

waitForNeo4j(driver, config, log)
  .then(async () => {
    for (const cypher of STATS_SCHEMA_CYPHER) await writeCypher(cypher);
    ready = true;
    scheduleStats();
    scheduleLodUpdate();
  })
  .catch((err) => {
    log(`giving up on neo4j: ${err.message}`);
    process.exit(1);
  });

const shutdown = async (signal) => {
  log(`received ${signal}, shutting down`);
  if (statsTimer) clearInterval(statsTimer);
  server.close();
  await driver.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
