// The callee side is only a Symbol of a crate (painter never resolves the callee's version). So callers of f in C at V are:
// another version of C only if it is V; another crate's version if its DEPENDS_ON requirement on C admits V. With no direct
// DEPENDS_ON (the call came through a generic instantiated elsewhere) the row is kept but marked unverified.
// A callsite whose symbol belongs to a crate other than the caller's is a monomorphised copy in the caller's binary,
// so only that same version can call it.

import { hasWildcard, longestLiteral, nameTester, wildcardRegex } from './match.mjs';

// Mirrors analysis.rs BLOCKED_CRATES.
const BLOCKED_CRATES = new Set(['core', 'std', 'alloc']);

// Same rule as `analysis::crate_of`.
export const crateOf = (symbol) => {
  const m = /[A-Za-z0-9_]+(?=::)/.exec(symbol);
  return m ? m[0] : null;
};

// Mirrors `analysis::callee_crate`.
export const calleeCrate = (symbol) => {
  if (symbol.startsWith('llvm.') || symbol.startsWith('__rust')) return null;
  const c = crateOf(symbol);
  return c && !BLOCKED_CRATES.has(c) ? c : null;
};

// Symbols spell `my-crate` as `my_crate`.
export const normCrate = (name) => String(name).replace(/-/g, '_');

const parseVersion = (s) => {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(s);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
};

const cmpPre = (a, b) => {
  if (!a.length || !b.length) return (b.length ? 1 : 0) - (a.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn && +a[i] !== +b[i]) return +a[i] - +b[i];
    if (an !== bn) return an ? -1 : 1;
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};

const cmp = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch || cmpPre(a.pre, b.pre);

const comparatorBounds = (raw) => {
  const m = /^\s*(\^|~|=|>=|<=|>|<)?\s*v?(\*|\d+)(?:\.(\*|x|X|\d+))?(?:\.(\*|x|X|\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(raw);
  if (!m) return null;
  const op = m[1] ?? '^';
  const wild = (p) => p === undefined || p === '*' || p === 'x' || p === 'X';
  if (m[2] === '*') return { lo: null, hi: null };
  const major = +m[2];
  const minor = wild(m[3]) ? null : +m[3];
  const patch = wild(m[4]) ? null : +m[4];
  const pre = m[5] ? m[5].split('.') : [];
  const v = (a, b, c, p = []) => ({ major: a, minor: b, patch: c, pre: p });
  const lo = v(major, minor ?? 0, patch ?? 0, pre);
  const next = minor === null ? v(major + 1, 0, 0) : patch === null ? v(major, minor + 1, 0) : v(major, minor, patch + 1);
  switch (op) {
    case '=':
      return { lo, hi: next };
    case '>':
      return { lo: next, hi: null };
    case '>=':
      return { lo, hi: null };
    case '<':
      return { lo: null, hi: lo };
    case '<=':
      return { lo: null, hi: next };
    case '~':
      return { lo, hi: minor === null ? v(major + 1, 0, 0) : v(major, minor + 1, 0) };
    default: {
      // Caret: the left-most non-zero component may not change.
      if (major > 0 || minor === null) return { lo, hi: v(major + 1, 0, 0) };
      if (minor > 0 || patch === null) return { lo, hi: v(0, minor + 1, 0) };
      return { lo, hi: v(0, 0, patch + 1) };
    }
  }
};

export const requirementMatches = (requirement, version) => {
  const ver = parseVersion(version);
  if (!ver) return null;
  for (const part of String(requirement).split(',')) {
    if (!part.trim()) continue;
    const b = comparatorBounds(part);
    if (!b) return null;
    if (b.lo && cmp(ver, b.lo) < 0) return false;
    if (b.hi && cmp(ver, b.hi) >= 0) return false;
  }
  return true;
};


// ---------------------------------------------------------------------------
// Symbol search: one box for `crate::path::fn`, `crate::`, or a bare name.
//
// Suggestions are partial (CONTAINS) for plain text. A query with `*` / `?` is a full-name pattern
// (server/match.mjs): `crate::pattern` is a regex over that crate's symbols, a global pattern seeds
// from an index-backed CONTAINS on its longest literal and filters that with the regex.

// Symbol paths spell `my-crate` as `my_crate`; accept either.
export const crateSpellings = (name) => [...new Set([name, normCrate(name), name.replace(/_/g, '-')])];

const SCOPED_SEARCH = `
  MATCH (t:Crate) WHERE t.name IN $names
  MATCH (t)<-[:IN]-(s:Symbol)
  WHERE $q = '' OR s.name CONTAINS $q
  WITH t, s, COUNT { (s)<-[:CALLS]-() } AS calls
  ORDER BY s.name ENDS WITH $tail DESC, calls DESC, size(s.name)
  RETURN t.name AS crate, s.name AS name, calls LIMIT $limit`;

// TEXT index idx_symbol_name_text makes CONTAINS an index scan; the scan cap keeps a common word
// (`new`, `fmt`) from walking all 4.6M symbols before ranking.
const GLOBAL_SEARCH = `
  MATCH (s:Symbol) WHERE s.name CONTAINS $q
  WITH s LIMIT $scan
  WITH s, COUNT { (s)<-[:CALLS]-() } AS calls
  ORDER BY s.name ENDS WITH $tail DESC, calls DESC, size(s.name)
  LIMIT $limit
  MATCH (s)-[:IN]->(t:Crate)
  RETURN t.name AS crate, s.name AS name, calls`;

const CRATE_PREFIX = `
  MATCH (c:Crate) WHERE c.name STARTS WITH $q OR c.name STARTS WITH $alt
  WITH c ORDER BY size(c.name), c.name LIMIT $limit
  RETURN c.name AS name`;

// A crate holds at most a few thousand called symbols (syn ~3.1k), so the regex walks them all;
// `$scan` only bounds the matches ranked.
const SCOPED_PATTERN = `
  MATCH (t:Crate) WHERE t.name IN $names
  MATCH (t)<-[:IN]-(s:Symbol)
  WHERE s.name =~ $re
  WITH t, s LIMIT $scan
  WITH t, s, COUNT { (s)<-[:CALLS]-() } AS calls
  ORDER BY calls DESC, size(s.name), s.name
  RETURN t.name AS crate, s.name AS name, calls LIMIT $limit`;

// CONTAINS is case-sensitive, the regex is not: the seed decides what the pattern can find.
const GLOBAL_PATTERN = `
  MATCH (s:Symbol) WHERE s.name CONTAINS $lit
  WITH s LIMIT $scan
  WITH s WHERE s.name =~ $re
  WITH s, COUNT { (s)<-[:CALLS]-() } AS calls
  ORDER BY calls DESC, size(s.name), s.name
  LIMIT $limit
  MATCH (s)-[:IN]->(t:Crate)
  RETURN t.name AS crate, s.name AS name, calls`;

const EXACT_SYMBOL = `
  MATCH (s:Symbol {name: $name})
  OPTIONAL MATCH (s)-[:IN]->(t:Crate)
  RETURN s.name AS name, t.name AS crate, COUNT { (s)<-[:CALLS]-() } AS calls
  LIMIT 1`;

/** Shortest literal a global pattern needs, so it seeds from the TEXT index instead of scanning. */
export const MIN_PATTERN_LITERAL = 3;
const SEARCH_SCAN = 1500;
const SCOPED_PATTERN_SCAN = 5000;

const patternHint = `a pattern needs a run of at least ${MIN_PATTERN_LITERAL} plain characters to search from (e.g. serde_json::*from_str or *::from_str)`;

/** Symbols matching a wildcard query, most callers first. */
const searchPattern = async (read, int, text, { limit, scan }) => {
  const sep = text.indexOf('::');
  const head = sep > 0 ? text.slice(0, sep) : '';
  if (head && !hasWildcard(head)) {
    const re = wildcardRegex(normCrate(head) + text.slice(sep));
    const symbols = await read(SCOPED_PATTERN, { names: crateSpellings(head), re, scan: int(SCOPED_PATTERN_SCAN), limit: int(limit) });
    return { symbols, crates: [], scope: head, pattern: true };
  }
  const lit = longestLiteral(text);
  if (lit.length < MIN_PATTERN_LITERAL) return { symbols: [], crates: [], scope: null, pattern: true, hint: patternHint };
  const symbols = await read(GLOBAL_PATTERN, { lit, re: wildcardRegex(text), scan: int(scan), limit: int(limit) });
  return { symbols, crates: [], scope: null, pattern: true, seed: lit, scan };
};

export const searchSymbols = async (read, int, q, { limit = 30, scan = SEARCH_SCAN } = {}) => {
  const started = Date.now();
  const text = q.trim();
  if (!text) return { symbols: [], crates: [], scope: null, elapsedMs: 0 };
  if (hasWildcard(text)) return { ...(await searchPattern(read, int, text, { limit, scan })), elapsedMs: Date.now() - started };
  const sep = text.indexOf('::');
  const tail = text.split('::').pop();
  if (sep > 0) {
    const head = text.slice(0, sep);
    const rest = text.slice(sep + 2);
    const scoped = await read(SCOPED_SEARCH, { names: crateSpellings(head), q: rest, tail, limit: int(limit) });
    if (scoped.length || rest === '') return { symbols: scoped, crates: [], scope: head, elapsedMs: Date.now() - started };
  }
  const [symbols, crates] = await Promise.all([
    read(GLOBAL_SEARCH, { q: text, tail, scan: int(scan), limit: int(limit) }),
    // A bare word is often a crate name: offer `crate::` so the next keystroke scopes the search.
    sep > 0
      ? Promise.resolve([])
      : read(CRATE_PREFIX, { q: text, alt: text.replace(/_/g, '-'), limit: int(5) }).then((rows) => rows.map((r) => r.name)),
  ]);
  return { symbols, crates, scope: null, elapsedMs: Date.now() - started };
};

/**
 * What Enter opens without a picked suggestion: plain text only an exact (case-sensitive, it is an
 * index seek) full symbol name; a wildcard query the match with the most callers.
 */
export const resolveSymbol = async (read, int, q) => {
  const started = Date.now();
  const text = q.trim();
  if (!text) return { symbol: null, pattern: false, elapsedMs: 0 };
  if (!hasWildcard(text)) {
    const [row] = await read(EXACT_SYMBOL, { name: text });
    const symbol = row ? { name: row.name, crate: row.crate ?? crateOf(row.name), calls: row.calls } : null;
    return { symbol, pattern: false, elapsedMs: Date.now() - started };
  }
  const r = await searchPattern(read, int, text, { limit: 30, scan: SEARCH_SCAN });
  return { symbol: r.symbols[0] ?? null, pattern: true, matches: r.symbols.length, hint: r.hint ?? null, elapsedMs: Date.now() - started };
};

// ---------------------------------------------------------------------------
// Callers, aggregated per crate and served in pages.
//
// One aggregate pass per (symbol, pinned versions, local scope, cap) returns per caller version only
// its crate, downloads, latest flag, calling-function count, and DEPENDS_ON requirements; the semver
// check runs here and the result is cached (CACHE_SIZE entries, CACHE_TTL_MS). Pages sort and filter
// that in memory, then fetch calling function names for the page's crates only.

/**
 * Default cap on the calling `Fn` nodes expanded for one symbol. Each one is a random read of the
 * Fn and its Version: ~1 s warm but 10-25 s cold per 50k on the production disk, so hot symbols
 * (`serde_json::de::from_str` 48k, `Deserializer::peek_error` 154k) answer from a prefix first and
 * the UI offers to expand the rest (`cap` up to MAX_FN_CAP).
 */
export const DEFAULT_FN_CAP = 15_000;
export const MAX_FN_CAP = 250_000;
/** Function names returned per caller crate; the rest is `functionCount`. */
const FUNCTIONS_PER_CRATE = 40;
export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 500;
const CACHE_SIZE = 20;
const CACHE_TTL_MS = 10 * 60_000;
export const CALLER_SORTS = ['downloads', 'functions', 'versions', 'crate'];

// Symbol side: one seek on const_symbol_name, then the CALLS fan-in (the expensive part for hot
// symbols: every Fn and its Version are random reads). `getDegree` gives the true total for free.
// One row per caller version, so at most $cap rows.
const CALLERS_AGG = `
  MATCH (s:Symbol {name: $name})-[:IN]->(t:Crate)
  WITH s, t, COUNT { (s)<-[:CALLS]-() } AS total
  MATCH (s)<-[:CALLS]-(f:Fn)
  WITH t, total, f LIMIT $cap
  MATCH (f)<-[:HAS_FN]-(v:Version)
  WITH t, total, v, count(f) AS fns
  MATCH (cc:Crate)-[:VERSION_OF]->(v)
  OPTIONAL MATCH (v)-[d:DEPENDS_ON]->(t)
  WITH t, total, cc, v, fns, collect(DISTINCT d.requirement) AS reqs
  RETURN t.name AS targetCrate, total, cc.name AS crate, cc.downloads AS downloads, v.version AS version,
         coalesce(v.latest, false) AS latest, fns, reqs
  LIMIT $cap`;

// Version side, for a symbol that is a monomorphised copy inside the caller's own binary: only the
// versions that contain it can call it, and those are few, so start from them.
const CALLERS_LOCAL_AGG = `
  MATCH (s:Symbol {name: $name})
  WITH s, COUNT { (s)<-[:CALLS]-() } AS total
  UNWIND $versions AS ver
  MATCH (cc:Crate {name: $crate})-[:VERSION_OF]->(v:Version {version: ver})
  MATCH (v)-[:HAS_FN]->(f:Fn)-[:CALLS]->(s)
  WITH total, cc, v, count(f) AS fns
  RETURN $crate AS targetCrate, total, cc.name AS crate, cc.downloads AS downloads, v.version AS version,
         coalesce(v.latest, false) AS latest, fns, [] AS reqs
  LIMIT $cap`;

// Calling function names for one page: the same capped fan-in as CALLERS_AGG (so the same callers),
// narrowed to the page's kept versions before the Fn -> Symbol hop. `versions` = in how many of the
// crate's calling versions the function calls it.
const CALLERS_NAMES = `
  MATCH (s:Symbol {name: $name})<-[:CALLS]-(f:Fn)
  WITH f LIMIT $cap
  MATCH (f)<-[:HAS_FN]-(v:Version)
  WHERE v.name IN $crates AND v.name + '@' + v.version IN $keys
  MATCH (f)-[:IS]->(cs:Symbol)
  WITH v.name AS crate, cs.name AS fn, count(*) AS nv
  ORDER BY crate, nv DESC, fn
  WITH crate, count(*) AS functionCount, collect({name: fn, versions: nv})[0..$per] AS functions
  RETURN crate, functionCount, functions
  LIMIT $limit`;

const CALLERS_LOCAL_NAMES = `
  MATCH (s:Symbol {name: $name})
  UNWIND $versions AS ver
  MATCH (cc:Crate {name: $crate})-[:VERSION_OF]->(v:Version {version: ver})
  MATCH (v)-[:HAS_FN]->(f:Fn)-[:CALLS]->(s)
  WITH f LIMIT $cap
  MATCH (f)-[:IS]->(cs:Symbol)
  WITH cs.name AS fn, count(*) AS nv
  ORDER BY nv DESC, fn
  WITH count(*) AS functionCount, collect({name: fn, versions: nv})[0..$per] AS functions
  RETURN $crate AS crate, functionCount, functions
  LIMIT 1`;

const SYMBOL_HOME = `
  MATCH (s:Symbol {name: $name})
  OPTIONAL MATCH (s)-[:IN]->(t:Crate)
  RETURN s.name AS name, t.name AS crate, COUNT { (s)<-[:CALLS]-() } AS calls,
         COUNT { (s)<-[:IS]-() } AS definitions
  LIMIT 1`;

const cmpVersions = (a, b) => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return a.localeCompare(b);
  return cmp(x, y);
};

const versionStatus = (targetCrate, versions, row) => {
  if (!versions) return 'verified';
  if (targetCrate && normCrate(row.crate) === normCrate(targetCrate)) return versions.includes(row.version) ? 'same' : 'rejected';
  if (!row.reqs.length) return 'unverified';
  for (const req of row.reqs) {
    for (const v of versions) {
      if (requirementMatches(req, v) !== false) return 'verified';
    }
  }
  return 'rejected';
};

/**
 * Who calls `name`, grouped by caller crate, without function names. `versions` (optional) pins the
 * callee crate to those versions: a caller version of another crate is `verified` when one of its
 * DEPENDS_ON requirements on the callee crate admits one of them, `unverified` when it has no such
 * dependency (the call came through a generic instantiated elsewhere), and dropped (`rejected`) when
 * every requirement excludes them. `local` = `{crate, versions}` restricts the walk to those versions
 * (the symbol is a foreign monomorphised copy inside that crate's binary).
 */
const aggregateCallers = async (read, int, { name, versions, local, cap }) => {
  const started = Date.now();
  const rows = local
    ? await read(CALLERS_LOCAL_AGG, { name, crate: local.crate, versions: local.versions.slice(0, 200), cap: int(cap) })
    : await read(CALLERS_AGG, { name, cap: int(cap) });
  const targetCrate = rows[0]?.targetCrate ?? null;
  const total = rows[0]?.total ?? 0;
  let scanned = 0;
  let rejected = 0;
  const rejectedByCrate = new Map();
  const byCrate = new Map();
  for (const row of rows) {
    scanned += row.fns;
    const status = versionStatus(targetCrate, versions, row);
    if (status === 'rejected') {
      rejected += 1;
      rejectedByCrate.set(row.crate, (rejectedByCrate.get(row.crate) ?? 0) + 1);
      continue;
    }
    if (!byCrate.has(row.crate)) byCrate.set(row.crate, { crate: row.crate, downloads: row.downloads ?? 0, versions: [] });
    byCrate.get(row.crate).versions.push({ version: row.version, latest: row.latest, fns: row.fns, status });
  }
  const callers = [...byCrate.values()].map((c) => {
    c.versions.sort((a, b) => Number(b.latest) - Number(a.latest) || -cmpVersions(a.version, b.version));
    const unverified = c.versions.filter((v) => v.status === 'unverified').length;
    return { ...c, fns: c.versions.reduce((n, v) => n + v.fns, 0), verified: c.versions.length - unverified, unverified };
  });
  callers.sort((a, b) => b.downloads - a.downloads || b.fns - a.fns || a.crate.localeCompare(b.crate));
  return { targetCrate, total, scanned, rejected, rejectedByCrate, callers, names: new Map(), elapsedMs: Date.now() - started };
};

// Small LRU of aggregate promises: concurrent requests for one key share the query, failures are evicted.
const aggregates = new Map();
const cachedAggregate = (key, compute) => {
  const hit = aggregates.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    aggregates.delete(key);
    aggregates.set(key, hit);
    return { promise: hit.promise, cached: true };
  }
  const entry = { at: Date.now(), promise: compute() };
  aggregates.delete(key);
  aggregates.set(key, entry);
  entry.promise.catch(() => aggregates.get(key) === entry && aggregates.delete(key));
  while (aggregates.size > CACHE_SIZE) aggregates.delete(aggregates.keys().next().value);
  return { promise: entry.promise, cached: false };
};

const aggregateFor = (read, int, { name, versions, local, cap }) => {
  const key = JSON.stringify([name, versions, local && { crate: local.crate, versions: local.versions.slice(0, 200) }, local ? null : cap]);
  return cachedAggregate(key, () => aggregateCallers(read, int, { name, versions, local, cap }));
};

const SORT_VALUE = {
  downloads: (c) => c.downloads,
  functions: (c) => c.fns,
  versions: (c) => c.versions.length,
  crate: (c) => c.crate,
};

const sortCallers = (list, sort, desc) => {
  if (sort === 'downloads' && desc) return list; // the aggregate's own order
  const val = SORT_VALUE[sort] ?? SORT_VALUE.downloads;
  const dir = desc ? -1 : 1;
  return [...list].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const r = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    return dir * r || b.downloads - a.downloads || a.crate.localeCompare(b.crate);
  });
};

/** Fills `agg.names` for `crates` (page rows not fetched before). */
const fetchNames = async (read, int, agg, { name, local, cap }, crates) => {
  if (!crates.length) return;
  const rows = local
    ? await read(CALLERS_LOCAL_NAMES, {
        name,
        crate: local.crate,
        versions: crates[0].versions.map((v) => v.version),
        cap: int(cap),
        per: int(FUNCTIONS_PER_CRATE),
      })
    : await read(CALLERS_NAMES, {
        name,
        cap: int(cap),
        crates: crates.map((c) => c.crate),
        keys: crates.flatMap((c) => c.versions.map((v) => `${c.crate}@${v.version}`)),
        per: int(FUNCTIONS_PER_CRATE),
        limit: int(crates.length),
      });
  for (const r of rows) agg.names.set(r.crate, { functionCount: r.functionCount, functions: r.functions });
  for (const c of crates) if (!agg.names.has(c.crate)) agg.names.set(c.crate, { functionCount: 0, functions: [] });
};

const intParam = (value, fallback, lo, hi) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Query-string -> callersPage / callerCrateNames options (shared by both routes). */
export const parseCallersQuery = (q) => {
  const versions = String(q.versions ?? '').trim();
  const localCrate = String(q.localCrate ?? '').trim();
  const sort = CALLER_SORTS.includes(q.sort) ? q.sort : 'downloads';
  return {
    name: String(q.fn ?? '').trim(),
    versions: versions ? versions.split(',').filter(Boolean) : null,
    local: localCrate ? { crate: localCrate, versions: String(q.localVersions ?? '').split(',').filter(Boolean) } : null,
    cap: intParam(q.cap, DEFAULT_FN_CAP, 1000, MAX_FN_CAP),
    offset: intParam(q.offset, 0, 0, 10_000_000),
    limit: intParam(q.limit, DEFAULT_PAGE, 1, MAX_PAGE),
    sort,
    desc: q.desc === undefined ? sort !== 'crate' : q.desc === '1' || q.desc === 'true',
    filter: String(q.filter ?? '').trim(),
    q: String(q.q ?? '').trim(),
  };
};

/**
 * One page of caller crates. Totals cover the whole filtered set; `filter` is a caller crate name
 * (exact, case-insensitive) or a `*` / `?` pattern.
 */
export const callersPage = async (read, int, opts) => {
  const started = Date.now();
  const { name, versions, local, cap, offset, limit, sort, desc, filter } = opts;
  const { promise, cached } = aggregateFor(read, int, opts);
  const agg = await promise;
  const test = nameTester(filter);
  const kept = filter ? agg.callers.filter((c) => test(c.crate)) : agg.callers;
  const sorted = sortCallers(kept, sort, desc);
  const page = sorted.slice(offset, offset + limit);
  await fetchNames(read, int, agg, { name, local, cap }, page.filter((c) => !agg.names.has(c.crate)));
  const rejected = filter ? [...agg.rejectedByCrate].reduce((n, [crate, k]) => n + (test(crate) ? k : 0), 0) : agg.rejected;
  return {
    target: { name, crate: agg.targetCrate, versions, local },
    callers: page.map((c) => ({ ...c, ...agg.names.get(c.crate) })),
    meta: {
      total: agg.total,
      scanned: agg.scanned,
      cap,
      truncated: !local && agg.total > cap,
      rejected,
      crates: kept.length,
      versions: kept.reduce((n, c) => n + c.versions.length, 0),
      fns: kept.reduce((n, c) => n + c.fns, 0),
      unverified: kept.reduce((n, c) => n + c.unverified, 0),
      allCrates: agg.callers.length,
      offset,
      limit,
      hasMore: offset + page.length < kept.length,
      sort,
      desc,
      filter,
      cached,
      aggregateMs: agg.elapsedMs,
      elapsedMs: Date.now() - started,
    },
  };
};

/**
 * Caller crate names for the filter box's hints, off the cached aggregate: partial and
 * case-insensitive (`-` and `_` alike), prefix matches first, then by downloads.
 */
export const callerCrateNames = async (read, int, opts, { limit = 12 } = {}) => {
  const { promise } = aggregateFor(read, int, opts);
  const agg = await promise;
  const q = normCrate(opts.q.toLowerCase());
  const test = hasWildcard(q) ? nameTester(opts.q) : null;
  const scored = [];
  for (const c of agg.callers) {
    const n = normCrate(c.crate.toLowerCase());
    const at = test ? (test(c.crate) ? 0 : -1) : n.indexOf(q);
    if (at < 0) continue;
    scored.push({ c, rank: n === q ? 0 : at === 0 ? 1 : 2 });
  }
  scored.sort((a, b) => a.rank - b.rank || b.c.downloads - a.c.downloads || a.c.crate.localeCompare(b.c.crate));
  return {
    names: scored.slice(0, Math.min(50, limit)).map(({ c }) => ({ crate: c.crate, downloads: c.downloads, fns: c.fns })),
    matches: scored.length,
  };
};

export const symbolHome = (read, name) => read(SYMBOL_HOME, { name }).then((rows) => rows[0] ?? null);

// ---------------------------------------------------------------------------
// Callees: what one function calls, in the newest version that defines it (or a chosen one).

const CALLEES = `
  MATCH (s:Symbol {name: $name})<-[:IS]-(f:Fn)<-[:HAS_FN]-(v:Version)
  WHERE ($crate IS NULL OR v.name = $crate) AND ($version IS NULL OR v.version = $version)
  WITH f, v
  ORDER BY coalesce(v.latest, false) DESC, v.semver_major DESC, v.semver_minor DESC, v.semver_patch DESC, v.version DESC
  LIMIT 1
  MATCH (f)-[c:CALLS]->(cs:Symbol)-[:IN]->(t:Crate)
  RETURN v.name AS crate, v.version AS version, t.name AS callee, t.downloads AS downloads, cs.name AS name,
         c.copies AS copies, COUNT { (cs)<-[:CALLS]-() } AS calls
  ORDER BY callee, calls DESC, name`;

// Same for a generic function, which is never compiled in its own crate, only monomorphised in
// callers: take the copy in the most-downloaded caller (`from` tells the UI where it came from).
const CALLEES_ANY = `
  MATCH (s:Symbol {name: $name})<-[:IS]-(f:Fn)<-[:HAS_FN]-(v:Version)<-[:VERSION_OF]-(cc:Crate)
  WITH f, v
  ORDER BY coalesce(cc.downloads, 0) DESC, coalesce(v.latest, false) DESC, v.version DESC
  LIMIT 1
  MATCH (f)-[c:CALLS]->(cs:Symbol)-[:IN]->(t:Crate)
  RETURN v.name AS crate, v.version AS version, t.name AS callee, t.downloads AS downloads, cs.name AS name,
         c.copies AS copies, COUNT { (cs)<-[:CALLS]-() } AS calls
  ORDER BY callee, calls DESC, name`;

export const calleesOf = async (read, { name, crate = null, version = null }) => {
  const started = Date.now();
  let rows = await read(CALLEES, { name, crate, version });
  if (!rows.length && version) rows = await read(CALLEES, { name, crate, version: null });
  if (!rows.length) rows = await read(CALLEES_ANY, { name });
  const byCrate = new Map();
  for (const r of rows) {
    if (!byCrate.has(r.callee)) byCrate.set(r.callee, { crate: r.callee, downloads: r.downloads ?? 0, functions: [] });
    byCrate.get(r.callee).functions.push({ name: r.name, copies: r.copies ?? 1, calls: r.calls });
  }
  const callees = [...byCrate.values()].sort((a, b) => b.functions.length - a.functions.length || a.crate.localeCompare(b.crate));
  return {
    from: rows.length ? { crate: rows[0].crate, version: rows[0].version } : null,
    callees,
    meta: { crates: callees.length, functions: rows.length, elapsedMs: Date.now() - started },
  };
};
