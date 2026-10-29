// Driver setup shared by the render server and the jobs service, so both wait for neo4j the same way.
import neo4j from 'neo4j-driver';
import { collectGraph } from './graph.mjs';

export const createDriver = (config, { poolSize = 16 } = {}) =>
  neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password), {
    maxConnectionPoolSize: poolSize,
    connectionAcquisitionTimeout: 10_000,
    disableLosslessIntegers: false,
  });

// The compose stack may start the database slower than this container; 0 retries means wait forever.
export const waitForNeo4j = async (driver, config, log) => {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const info = await driver.getServerInfo({ database: config.neo4j.database });
      log(`connected to ${config.neo4j.uri} (${info.agent}, protocol ${info.protocolVersion})`);
      return;
    } catch (err) {
      const retriesLeft = config.neo4j.connectRetries === 0 ? 'unlimited' : config.neo4j.connectRetries - attempt;
      log(`neo4j not reachable at ${config.neo4j.uri} (attempt ${attempt}, retries left: ${retriesLeft}): ${err.message}`);
      if (config.neo4j.connectRetries !== 0 && attempt >= config.neo4j.connectRetries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, config.neo4j.connectRetryDelayMs));
    }
  }
};

/** Read transaction returning plain rows (driver integers and temporals converted like the API routes do). */
export const readRows = async (driver, config, cypher, params = {}, { timeoutMs = config.neo4j.queryTimeoutMs } = {}) => {
  const session = driver.session({ database: config.neo4j.database, defaultAccessMode: neo4j.session.READ });
  try {
    const started = Date.now();
    const result = await session.executeRead((tx) => tx.run(cypher, params), { timeout: timeoutMs });
    const elapsedMs = Date.now() - started;
    // Neo4j 5 can end a timed-out read as an empty stream instead of raising.
    if (result.records.length === 0 && elapsedMs >= timeoutMs * 0.95) {
      const err = new Error(`query timed out after ${elapsedMs} ms (limit ${timeoutMs} ms); the database may be busy`);
      err.code = 'Neo.ClientError.Transaction.TransactionTimedOut';
      throw err;
    }
    return collectGraph(result.records).rows;
  } finally {
    await session.close();
  }
};

export const write = async (driver, config, cypher, params = {}, { timeoutMs = 600_000 } = {}) => {
  const session = driver.session({ database: config.neo4j.database, defaultAccessMode: neo4j.session.WRITE });
  try {
    const result = await session.executeWrite((tx) => tx.run(cypher, params), { timeout: timeoutMs });
    return result.summary.counters.updates();
  } finally {
    await session.close();
  }
};
