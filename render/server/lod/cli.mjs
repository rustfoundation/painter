#!/usr/bin/env node
// Same environment configuration as the server (../config.mjs).
// Usage: build [--iterations N] [--reuse-edges] [--resume] [--checkpoint PATH] [--checkpoint-every N] | update | status
// --reuse-edges skips the DEPENDS_ON aggregation; --resume continues from the checkpoint file or stored positions.

import neo4j from 'neo4j-driver';
import { config } from '../config.mjs';
import { runBuild, runUpdate } from './build.mjs';
import { readRows } from './neo4j-io.mjs';

const [cmd = 'status', ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
};
const has = (name) => rest.includes(`--${name}`);

const driver = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password));
const log = (m) => console.error(new Date().toISOString(), m);
let lastLine = '';
const onProgress = (p) => {
  const line = `${p.phase}${p.total ? ` ${p.done ?? 0}/${p.total}` : p.done ? ` ${p.done}` : ''}${p.message ? ` ${p.message}` : ''}`;
  if (line !== lastLine) {
    lastLine = line;
    console.error(`  ${line}`);
  }
};

try {
  if (cmd === 'build') {
    const iterations = Number.parseInt(flag('iterations', String(config.lod.iterations)), 10);
    const meta = await runBuild(driver, config.neo4j.database, {
      iterations,
      timeoutMs: config.lod.timeoutMs,
      reuseEdges: has('reuse-edges'),
      resume: has('resume'),
      checkpointPath: flag('checkpoint', config.lod.checkpointPath),
      checkpointEvery: Number.parseInt(flag('checkpoint-every', '20'), 10),
      onProgress,
      log,
    });
    console.log(JSON.stringify(meta, null, 2));
  } else if (cmd === 'update') {
    const n = await runUpdate(driver, config.neo4j.database, { timeoutMs: config.lod.timeoutMs, onProgress, log });
    console.log(JSON.stringify({ placed: n }));
  } else if (cmd === 'status') {
    const rows = await readRows(driver, config.neo4j.database, `MATCH (m:LodMeta {id: 'default'}) RETURN properties(m) AS m`);
    const unpositioned = await readRows(driver, config.neo4j.database, `MATCH (c:Crate) WHERE c.lod_x IS NULL RETURN count(c) AS n`);
    console.log(JSON.stringify({ meta: rows[0]?.m ?? null, unpositionedCrates: unpositioned[0]?.n ?? null }, null, 2));
  } else {
    console.error(`unknown command '${cmd}'; use build | update | status`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await driver.close();
}
