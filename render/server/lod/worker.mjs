// Worker thread that runs a LOD job so the multi-minute layout never blocks
// the HTTP server's event loop. Started by jobs.mjs with workerData
// { kind: 'build' | 'update', neo4j: {uri,user,password,database}, iterations, timeoutMs }.

import { parentPort, workerData } from 'node:worker_threads';
import neo4j from 'neo4j-driver';
import { runBuild, runUpdate } from './build.mjs';

const { kind, neo4j: n4j, iterations, timeoutMs, reuseEdges, resume, checkpointPath } = workerData;
const driver = neo4j.driver(n4j.uri, neo4j.auth.basic(n4j.user, n4j.password), { maxConnectionPoolSize: 4 });

const post = (type, payload) => parentPort.postMessage({ type, ...payload });
const onProgress = (p) => post('progress', p);
const log = (message) => post('log', { message });

try {
  const result =
    kind === 'update'
      ? await runUpdate(driver, n4j.database, { timeoutMs, onProgress, log })
      : await runBuild(driver, n4j.database, { iterations, timeoutMs, reuseEdges, resume, checkpointPath, onProgress, log });
  post('done', { result });
} catch (err) {
  post('error', { message: err.message, stack: err.stack });
} finally {
  await driver.close();
}
