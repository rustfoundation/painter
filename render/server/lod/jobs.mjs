// Single-slot job manager for LOD builds and updates. One job at a time; the
// work happens in a worker thread (worker.mjs). `onFinished` lets the server
// reload its in-memory LOD index when a job completes.

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const createLodJobs = ({ config, log, onFinished }) => {
  let current = null; // { kind, startedAt, phase, done, total, message, worker }
  let last = null; // { kind, startedAt, finishedAt, ok, error, result, elapsedMs }

  const status = () => ({
    running: current ? { kind: current.kind, startedAt: current.startedAt, phase: current.phase, done: current.done, total: current.total, message: current.message } : null,
    last,
  });

  const start = (kind, { iterations, reuseEdges = false, resume = false } = {}) => {
    if (current) {
      const err = new Error(`a LOD ${current.kind} is already running (phase ${current.phase})`);
      err.status = 409;
      throw err;
    }
    const startedAt = new Date().toISOString();
    const worker = new Worker(path.join(here, 'worker.mjs'), {
      workerData: {
        kind,
        neo4j: { uri: config.neo4j.uri, user: config.neo4j.user, password: config.neo4j.password, database: config.neo4j.database },
        iterations: iterations ?? config.lod.iterations,
        timeoutMs: config.lod.timeoutMs,
        reuseEdges,
        resume,
        checkpointPath: config.lod.checkpointPath,
      },
      resourceLimits: { maxOldGenerationSizeMb: config.lod.workerHeapMb },
    });
    current = { kind, startedAt, phase: 'starting', done: null, total: null, message: null, worker };
    log(`lod ${kind}: started`);

    const finish = (ok, { result, error } = {}) => {
      last = { kind, startedAt, finishedAt: new Date().toISOString(), ok, error: error ?? null, result: result ?? null, elapsedMs: Date.now() - Date.parse(startedAt) };
      current = null;
      log(`lod ${kind}: ${ok ? 'finished' : 'failed'}${error ? `: ${error}` : ''}`);
      if (ok) onFinished?.(kind, result);
    };

    worker.on('message', (m) => {
      if (m.type === 'progress') {
        current.phase = m.phase ?? current.phase;
        if (m.done !== undefined) current.done = m.done;
        if (m.total !== undefined) current.total = m.total;
        if (m.message !== undefined) current.message = m.message;
      } else if (m.type === 'log') {
        log(`lod ${kind}: ${m.message}`);
      } else if (m.type === 'done') {
        finish(true, { result: m.result });
      } else if (m.type === 'error') {
        finish(false, { error: m.message });
      }
    });
    worker.on('error', (err) => finish(false, { error: err.message }));
    worker.on('exit', (code) => {
      if (current && current.worker === worker) finish(false, { error: `worker exited with code ${code}` });
    });
    return status();
  };

  return { status, rebuild: (o) => start('build', o), update: (o) => start('update', o) };
};
