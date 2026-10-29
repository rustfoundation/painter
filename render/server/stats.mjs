// Dashboard totals are whole-graph aggregates (label scans of 3.2M versions, whole relationship types), so the
// jobs service computes them on a timer and stores each payload as JSON on a `(Stats {id})` node. The render
// server serves that node in milliseconds and only falls back to the live aggregate when no node exists yet.
// Payloads are JSON strings because Neo4j properties cannot hold lists of maps (topLinks, langs, boards).
import neo4j from 'neo4j-driver';
import { unsafeStats } from './unsafe.mjs';
import { buildStats, diffStats, nativeStats } from './metadata.mjs';
import { publisherLeaderboards, registryStats } from './registry.mjs';

export const STATS_SCHEMA_CYPHER = ['CREATE CONSTRAINT const_stats_id IF NOT EXISTS FOR (s:Stats) REQUIRE s.id IS UNIQUE'];

// The status bar's counts: four full scans, the slowest of the lot on the CALLS type.
export const overviewStats = async (read) => {
  const rows = await read(
    `CALL { MATCH (c:Crate) RETURN count(c) AS crates }
     CALL { MATCH (v:Version) RETURN count(v) AS versions }
     CALL { MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS dependsOn }
     CALL { MATCH ()-[r:CALLS]->() RETURN count(r) AS invokes }
     RETURN crates, versions, dependsOn, invokes`,
  );
  return rows[0] ?? {};
};

/** Every precomputed payload: id -> (read) => payload. Ids are what the API routes look up. */
export const STATS_JOBS = {
  overview: (read) => overviewStats(read),
  'unsafe:latest': (read) => unsafeStats(read, 'latest'),
  'unsafe:all': (read) => unsafeStats(read, 'all'),
  'build:latest': (read) => buildStats(read, 'latest'),
  'build:all': (read) => buildStats(read, 'all'),
  'native:latest': (read) => nativeStats(read, 'latest'),
  'native:all': (read) => nativeStats(read, 'all'),
  'diffs:latest': (read) => diffStats(read, 'latest'),
  'diffs:all': (read) => diffStats(read, 'all'),
  registry: (read) => registryStats(read),
  leaderboards: (read) => publisherLeaderboards(read, 100),
};

export const STATS_IDS = Object.keys(STATS_JOBS);

export const isStatsId = (id) => Object.hasOwn(STATS_JOBS, id);

/** The stored payload for `id` with its provenance, or null when no job has written it yet. */
export const readStats = async (read, id) => {
  const rows = await read(
    `MATCH (s:Stats {id: $id})
     RETURN s.payload AS payload, toString(s.computed_at) AS computedAt, s.elapsed_ms AS elapsedMs`,
    { id },
  );
  const row = rows[0];
  if (!row?.payload) return null;
  return { ...JSON.parse(row.payload), computedAt: row.computedAt, elapsedMs: row.elapsedMs, source: 'precomputed' };
};

/** `computed_at` per id (ISO string), for freshness checks and the status endpoints. */
export const readStatsAges = async (read) => {
  const rows = await read(`MATCH (s:Stats) RETURN s.id AS id, toString(s.computed_at) AS computedAt, s.elapsed_ms AS elapsedMs, s.bytes AS bytes`);
  return Object.fromEntries(rows.map((r) => [r.id, { computedAt: r.computedAt, elapsedMs: r.elapsedMs, bytes: r.bytes }]));
};

export const writeStats = (write, id, payload, elapsedMs) => {
  const json = JSON.stringify(payload);
  return write(
    `MERGE (s:Stats {id: $id})
     SET s.payload = $payload, s.computed_at = datetime(), s.elapsed_ms = $elapsedMs, s.bytes = $bytes`,
    { id, payload: json, elapsedMs: neo4j.int(elapsedMs), bytes: neo4j.int(Buffer.byteLength(json)) },
  );
};
