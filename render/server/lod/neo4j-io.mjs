// Neo4j I/O for the level-of-detail (LOD) pipeline.
//
// Everything here is written to survive a database that is being imported
// into concurrently: reads stream instead of buffering the whole result,
// writes go in bounded UNWIND batches, and nothing holds a transaction open
// for longer than one batch.

import neo4j from 'neo4j-driver';

const toNum = (v) => (neo4j.isInt(v) ? v.toNumber() : v);

/**
 * Stream a read query, calling `onRecord(record)` for each row without
 * buffering the result. Resolves with the number of rows seen.
 */
export const streamRead = (driver, database, cypher, params, { timeoutMs, onRecord }) =>
  new Promise((resolve, reject) => {
    const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
    let count = 0;
    session
      .run(cypher, params, { timeout: timeoutMs })
      .subscribe({
        onNext: (record) => {
          count += 1;
          onRecord(record);
        },
        onCompleted: () => session.close().then(() => resolve(count), reject),
        onError: (err) => session.close().then(() => reject(err), () => reject(err)),
      });
  });

/** Run a write query in its own auto-commit transaction; returns the summary counters. */
export const write = async (driver, database, cypher, params = {}, { timeoutMs = 600_000 } = {}) => {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.WRITE });
  try {
    const result = await session.executeWrite((tx) => tx.run(cypher, params), { timeout: timeoutMs });
    return result.summary.counters.updates();
  } finally {
    await session.close();
  }
};

/** Run a read query and return plain rows (small results only). */
export const readRows = async (driver, database, cypher, params = {}, { timeoutMs = 60_000 } = {}) => {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.executeRead((tx) => tx.run(cypher, params), { timeout: timeoutMs });
    return result.records.map((r) => Object.fromEntries(r.keys.map((k) => [k, toNum(r.get(k))])));
  } finally {
    await session.close();
  }
};

/**
 * Load the crate-level dependency edges `(a)-[:LOD_DEP {versions}]->(b)`
 * written by a previous build. Returns `{ names: string[], edges: [aIdx, bIdx, versions][] }`
 * over *all* crates (isolated ones included) so callers see new crates too.
 */
export const loadLodGraph = async (driver, database, { timeoutMs }) => {
  const names = [];
  const index = new Map();
  await streamRead(driver, database, `MATCH (c:Crate) RETURN c.name AS name`, {}, {
    timeoutMs,
    onRecord: (r) => {
      const name = r.get('name');
      index.set(name, names.length);
      names.push(name);
    },
  });
  const edges = [];
  await streamRead(driver, database, `MATCH (a:Crate)-[r:LOD_DEP]->(b:Crate) RETURN a.name AS a, b.name AS b, r.versions AS n`, {}, {
    timeoutMs,
    onRecord: (r) => {
      const a = index.get(r.get('a'));
      const b = index.get(r.get('b'));
      if (a !== undefined && b !== undefined) edges.push([a, b, toNum(r.get('n'))]);
    },
  });
  return { names, index, edges };
};

/**
 * Load the persisted layout: `{ name, x, y, community, degree }` for every
 * crate that has one, plus the LodMeta record.
 */
export const loadLodPositions = async (driver, database, { timeoutMs }) => {
  const positions = [];
  await streamRead(
    driver,
    database,
    `MATCH (c:Crate) WHERE c.lod_x IS NOT NULL
     RETURN c.name AS name, c.lod_x AS x, c.lod_y AS y, c.lod_community AS community, c.lod_degree AS degree`,
    {},
    {
      timeoutMs,
      onRecord: (r) =>
        positions.push({
          name: r.get('name'),
          x: toNum(r.get('x')),
          y: toNum(r.get('y')),
          community: toNum(r.get('community')) ?? -1,
          degree: toNum(r.get('degree')) ?? 0,
        }),
    },
  );
  const meta = (await readRows(driver, database, `MATCH (m:LodMeta {id: 'default'}) RETURN properties(m) AS m`))[0]?.m ?? null;
  return { positions, meta: meta ? Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, toNum(v)])) : null };
};

/**
 * Aggregate `(Version)-[:DEPENDS_ON]->(Crate)` into crate-level edges.
 * Streams the whole DEPENDS_ON relationship set once; on a full index this is
 * tens of millions of rows, so it gets the long LOD timeout.
 * Returns `Map<"a\u0000b", versions>`.
 */
export const aggregateDependsOn = async (driver, database, { timeoutMs, onProgress }) => {
  const edges = new Map();
  let rows = 0;
  await streamRead(
    driver,
    database,
    `MATCH (v:Version)-[:DEPENDS_ON]->(b:Crate)
     WITH v.name AS a, b.name AS b, count(*) AS n
     RETURN a, b, n`,
    {},
    {
      timeoutMs,
      onRecord: (r) => {
        edges.set(`${r.get('a')}\u0000${r.get('b')}`, toNum(r.get('n')));
        rows += 1;
        if (onProgress && rows % 100_000 === 0) onProgress(rows);
      },
    },
  );
  return edges;
};

/** Delete every LOD_DEP relationship in bounded batches. Returns the number deleted. */
export const deleteLodEdges = async (driver, database, { batch = 50_000, onProgress } = {}) => {
  let total = 0;
  for (;;) {
    const counters = await write(
      driver,
      database,
      `MATCH ()-[r:LOD_DEP]->() WITH r LIMIT $batch DELETE r RETURN count(*) AS n`,
      { batch: neo4j.int(batch) },
    );
    const n = counters.relationshipsDeleted ?? 0;
    total += n;
    if (onProgress) onProgress(total);
    if (n < batch) break;
  }
  return total;
};

/** Create LOD_DEP relationships from `[a, b, versions]` name triples, in batches. */
export const createLodEdges = async (driver, database, triples, { batch = 10_000, onProgress } = {}) => {
  let done = 0;
  for (let i = 0; i < triples.length; i += batch) {
    const rows = triples.slice(i, i + batch).map(([a, b, n]) => ({ a, b, n: neo4j.int(n) }));
    await write(
      driver,
      database,
      `UNWIND $rows AS row
       MATCH (a:Crate {name: row.a})
       MATCH (b:Crate {name: row.b})
       CREATE (a)-[:LOD_DEP {versions: row.n}]->(b)`,
      { rows },
    );
    done = Math.min(i + batch, triples.length);
    if (onProgress) onProgress(done);
  }
  return done;
};

/** Write `lod_x / lod_y / lod_community / lod_degree` for `{name, x, y, community, degree}` rows. */
export const writeLodPositions = async (driver, database, rows, { batch = 10_000, onProgress } = {}) => {
  let done = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch).map((r) => ({
      name: r.name,
      x: r.x,
      y: r.y,
      community: neo4j.int(r.community),
      degree: neo4j.int(r.degree),
    }));
    await write(
      driver,
      database,
      `UNWIND $rows AS row
       MATCH (c:Crate {name: row.name})
       SET c.lod_x = row.x, c.lod_y = row.y, c.lod_community = row.community, c.lod_degree = row.degree`,
      { rows: chunk },
    );
    done = Math.min(i + batch, rows.length);
    if (onProgress) onProgress(done);
  }
  return done;
};

export const writeLodMeta = (driver, database, meta) =>
  write(
    driver,
    database,
    `MERGE (m:LodMeta {id: 'default'})
     SET m += $meta, m.built_at = datetime()`,
    { meta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, Number.isInteger(v) ? neo4j.int(v) : v])) },
  );

export const ensureLodIndexes = async (driver, database) => {
  await write(driver, database, `CREATE INDEX crate_lod_x IF NOT EXISTS FOR (c:Crate) ON (c.lod_x)`);
  await write(driver, database, `CREATE INDEX crate_lod_community IF NOT EXISTS FOR (c:Crate) ON (c.lod_community)`);
};
