// Default view payload: one crate, the dependencies its subject version declares, its newest versions, the
// crates its compiled code calls into, and (on request) its most-downloaded dependents. Everything comes
// back in one Cypher round trip (the port-forwarded database costs ~150 ms per statement), every part is
// bounded, and nodes are annotated with `role` / `counts` so the client can lay the graph out without
// a force simulation.
//
// Dependencies are folded to one edge per (from, crate): a version can declare the same crate several
// times (per target, per kind), which drew doubled arrows. The edge keeps every requirement, the strongest
// kind (normal > build > dev), `optional` only when every declaration is optional, and `via` (the version
// that declared it). Calls into a declared dependency land on that edge as `calls`; calls into other crates
// (inlined transitive code) become an `INVOKES` edge to a `callee` node. Self-calls are dropped.
//
// Dependents come from the Map precompute (`LOD_DEP`, one edge per crate pair, `versions` = how many
// versions declare it) ordered by downloads, so "the 25 biggest users of serde" is a 130k-edge scan
// (~350 ms) instead of a 1.7M-edge DEPENDS_ON walk. Inbound call counts are not offered here: even
// bounded, "who calls into serde" is 4-15 s (see the Callers view).

export const OVERVIEW_PARTS = ['deps', 'versions', 'calls', 'dependents'];
export const OVERVIEW_LIMITS = { deps: 200, versions: 60, calls: 100, dependents: 100 };
export const OVERVIEW_DEFAULTS = { deps: 60, versions: 12, calls: 40, dependents: 25 };

const OVERVIEW_CYPHER = `
MATCH (c:Crate {name: $name})
CALL {
  WITH c
  OPTIONAL MATCH (c)-[:VERSION_OF]->(v:Version)
  WHERE $version IS NULL OR v.version = $version
  WITH v
  ORDER BY coalesce(v.latest, false) DESC,
           v.semver_major DESC, v.semver_minor DESC, v.semver_patch DESC,
           coalesce(v.semver_pre, '') = '' DESC, v.version DESC
  LIMIT 1
  RETURN v AS subject
}
CALL {
  WITH c
  OPTIONAL MATCH (c)-[vo:VERSION_OF]->(v:Version) WHERE $wantVersions
  WITH vo, v
  ORDER BY coalesce(v.latest, false) DESC,
           v.semver_major DESC, v.semver_minor DESC, v.semver_patch DESC,
           coalesce(v.semver_pre, '') = '' DESC, v.version DESC
  SKIP $skip LIMIT $versionsLimit
  RETURN collect({vo: vo, v: v}) AS versions
}
CALL {
  WITH subject
  OPTIONAL MATCH (subject)-[d:DEPENDS_ON]->(dc:Crate) WHERE $wantDeps
  WITH dc, collect(properties(d)) AS ds
  WHERE dc IS NOT NULL
  WITH dc, ds ORDER BY coalesce(dc.downloads, 0) DESC
  WITH collect({dc: dc, ds: ds,
                dependents: COUNT { (dc)<-[:LOD_DEP]-() },
                deps: COUNT { (dc)-[:LOD_DEP]->() },
                versions: COUNT { (dc)-[:VERSION_OF]->() }}) AS items
  RETURN items[0..$depsLimit] AS deps, size(items) AS depsTotal
}
CALL {
  WITH subject
  OPTIONAL MATCH (subject)-[:HAS_FN]->(f:Fn)-[k:CALLS]->(s:Symbol)-[:IN]->(ic:Crate) WHERE $wantCalls
  WITH ic, count(k) AS calls, count(DISTINCT f) AS callers, collect(DISTINCT s.name) AS targets
  WHERE ic IS NOT NULL
  WITH ic, calls, callers, size(targets) AS symbols, targets[0..10] AS targets
  ORDER BY calls DESC
  WITH collect({ic: ic, calls: calls, callers: callers, symbols: symbols, targets: targets}) AS items
  RETURN items[0..$callsLimit] AS calls, size(items) AS callsTotal
}
CALL {
  WITH c
  OPTIONAL MATCH (c)<-[l:LOD_DEP]-(d:Crate) WHERE $wantDependents
  WITH d, l WHERE d IS NOT NULL
  WITH d, l ORDER BY coalesce(d.downloads, 0) DESC
  SKIP $skip LIMIT $dependentsLimit
  RETURN collect({d: d, versions: l.versions,
                  dependents: COUNT { (d)<-[:LOD_DEP]-() },
                  deps: COUNT { (d)-[:LOD_DEP]->() },
                  versionsCount: COUNT { (d)-[:VERSION_OF]->() }}) AS dependents
}
RETURN c, subject,
       {versions: COUNT { (c)-[:VERSION_OF]->() },
        dependents: COUNT { (c)<-[:LOD_DEP]-() },
        dependentVersions: COUNT { (c)<-[:DEPENDS_ON]-() },
        deps: COUNT { (c)-[:LOD_DEP]->() },
        symbolsCalled: COUNT { (c)<-[:IN]-() }} AS counts,
       versions, deps, depsTotal, calls, callsTotal, dependents`;

// Without a Map build there is no LOD_DEP; sample distinct dependents off DEPENDS_ON instead (stops at the
// limit, so it is bounded even for serde, but it is not ordered by downloads).
const FALLBACK_DEPENDENTS_CYPHER = `
MATCH (c:Crate {name: $name})<-[:DEPENDS_ON]-(:Version)<-[:VERSION_OF]-(d:Crate)
WITH DISTINCT d LIMIT $dependentsLimit
RETURN collect({d: d, versions: null, dependents: 0, deps: 0,
                versionsCount: COUNT { (d)-[:VERSION_OF]->() }}) AS dependents`;

const KIND_RANK = { normal: 0, build: 1, dev: 2 };
const normKind = (k) => String(k ?? 'normal').toLowerCase();

const uniq = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined && x !== ''))];

// One DEPENDS_ON per crate: the strongest kind wins, optional only if every declaration is optional.
export const mergeDeclarations = (ds) => {
  let kind = 'dev';
  let optional = true;
  for (const d of ds) {
    const k = normKind(d.kind);
    if ((KIND_RANK[k] ?? 0) < (KIND_RANK[kind] ?? 0)) kind = k;
    if (d.optional !== true) optional = false;
  }
  if (ds.length === 0) {
    kind = 'normal';
    optional = false;
  }
  const requirements = uniq(ds.map((d) => d.requirement));
  const features = uniq(ds.flatMap((d) => (Array.isArray(d.features) ? d.features : [])));
  return {
    kind,
    optional,
    requirement: requirements.join(' | '),
    features,
    declarations: ds.length,
  };
};

const parseParts = (value) => {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const parts = raw.map((p) => String(p).trim()).filter((p) => OVERVIEW_PARTS.includes(p));
  return parts.length ? [...new Set(parts)] : ['deps', 'versions', 'calls'];
};

const clampTo = (value, fallback, max) => {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
};

/**
 * Builds the overview payload. `readGraph(cypher, params)` is the server's read helper; `int` wraps numbers
 * for the driver. Options: `name` (exact crate name), `parts`, `limit` (per part), `skip` (versions /
 * dependents paging), `version` (subject version; default latest), `from` ('crate' | 'version': which node
 * the dependency / call edges start at), `root` (mark the crate as the layout root).
 */
export async function crateOverview(readGraph, int, opts) {
  const parts = parseParts(opts.parts);
  const want = (p) => parts.includes(p);
  const limits = {
    deps: clampTo(opts.limit, OVERVIEW_DEFAULTS.deps, OVERVIEW_LIMITS.deps),
    versions: clampTo(opts.limit, OVERVIEW_DEFAULTS.versions, OVERVIEW_LIMITS.versions),
    calls: clampTo(opts.limit, OVERVIEW_DEFAULTS.calls, OVERVIEW_LIMITS.calls),
    dependents: clampTo(opts.limit, OVERVIEW_DEFAULTS.dependents, OVERVIEW_LIMITS.dependents),
  };
  const skip = Math.max(0, Number.parseInt(opts.skip ?? '0', 10) || 0);
  const version = typeof opts.version === 'string' && opts.version ? opts.version : null;
  const fromVersion = opts.from === 'version' && version !== null;

  const started = Date.now();
  const g = await readGraph(OVERVIEW_CYPHER, {
    name: opts.name,
    version,
    skip: int(skip),
    wantVersions: want('versions'),
    wantDeps: want('deps'),
    wantCalls: want('calls'),
    wantDependents: want('dependents'),
    versionsLimit: int(limits.versions),
    depsLimit: int(limits.deps),
    callsLimit: int(limits.calls),
    dependentsLimit: int(limits.dependents),
  });
  const row = g.rows[0];
  if (!row || !row.c) return null;

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const crate = byId.get(row.c.id);
  const subject = row.subject ? byId.get(row.subject.id) : null;
  const subjectVersion = subject ? String(subject.properties.version ?? '') : null;
  const fromId = fromVersion && subject ? subject.id : crate.id;

  const nodes = new Map();
  const rels = [];
  const keep = (node, role, counts) => {
    if (!node) return;
    const existing = nodes.get(node.id);
    if (existing) {
      if (counts && !existing.counts) existing.counts = counts;
      return;
    }
    const copy = { ...node };
    if (role) copy.role = role;
    if (counts) copy.counts = counts;
    nodes.set(node.id, copy);
  };

  keep(crate, opts.root ? 'root' : undefined, row.counts);
  if (fromVersion && subject) keep(subject);

  for (const item of row.versions ?? []) {
    if (!item.v) continue;
    keep(byId.get(item.v.id));
    if (item.vo) rels.push(item.vo);
  }

  // Calls keyed by callee crate id; the ones into declared dependencies decorate the dependency edge.
  const calls = new Map();
  let selfCalls = 0;
  for (const item of row.calls ?? []) {
    if (!item.ic) continue;
    if (item.ic.id === crate.id) {
      selfCalls += item.calls;
      continue;
    }
    calls.set(item.ic.id, item);
  }

  const depIds = new Set();
  for (const item of row.deps ?? []) {
    if (!item.dc || item.dc.id === crate.id) continue;
    depIds.add(item.dc.id);
    keep(byId.get(item.dc.id), 'dep', { dependents: item.dependents, deps: item.deps, versions: item.versions });
    const merged = mergeDeclarations(item.ds ?? []);
    const call = calls.get(item.dc.id);
    rels.push({
      id: `dep:${fromId}->${item.dc.id}`,
      type: 'DEPENDS_ON',
      from: fromId,
      to: item.dc.id,
      properties: {
        ...merged,
        via: subjectVersion,
        ...(call ? { calls: call.calls, callers: call.callers, symbols: call.symbols, targets: call.targets } : {}),
      },
    });
  }

  for (const [id, call] of calls) {
    if (depIds.has(id)) continue;
    keep(byId.get(id), 'callee');
    rels.push({
      id: `agg:${fromId}->${id}:INVOKES`,
      type: 'INVOKES',
      from: fromId,
      to: id,
      properties: { count: call.calls, callers: call.callers, symbols: call.symbols, targets: call.targets, aggregated: true, via: subjectVersion },
    });
  }

  let dependents = row.dependents ?? [];
  let dependentsSource = 'lod';
  if (want('dependents') && dependents.filter((d) => d.d).length === 0 && row.counts.dependents === 0 && row.counts.dependentVersions > 0) {
    const fb = await readGraph(FALLBACK_DEPENDENTS_CYPHER, { name: opts.name, dependentsLimit: int(limits.dependents) });
    for (const n of fb.nodes) byId.set(n.id, n);
    dependents = fb.rows[0]?.dependents ?? [];
    dependentsSource = 'sample';
  }
  for (const item of dependents) {
    if (!item.d || item.d.id === crate.id) continue;
    keep(byId.get(item.d.id), 'dependent', { dependents: item.dependents, deps: item.deps, versions: item.versionsCount });
    rels.push({
      id: `dep:${item.d.id}->${crate.id}`,
      type: 'DEPENDS_ON',
      from: item.d.id,
      to: crate.id,
      properties: { aggregated: true, versions: item.versions ?? null },
    });
  }

  const nodeIds = new Set(nodes.keys());
  return {
    nodes: [...nodes.values()],
    rels: rels.filter((r) => nodeIds.has(r.from) && nodeIds.has(r.to)),
    meta: {
      records: g.meta.records,
      elapsedMs: Date.now() - started,
      resolvedName: String(crate.properties.name),
      overview: {
        name: String(crate.properties.name),
        version: subjectVersion,
        parts,
        from: fromVersion ? 'version' : 'crate',
        skip,
        limits,
        counts: row.counts,
        depsTotal: row.depsTotal ?? 0,
        callsTotal: row.callsTotal ?? 0,
        selfCalls,
        dependentsShown: dependents.filter((d) => d.d).length,
        dependentsSource: want('dependents') ? dependentsSource : null,
      },
    },
  };
}
