// Reverse call-graph search over INVOKES: who calls a function, directly or
// through other functions.
//
// INVOKES is `(Version)-[:INVOKES {callsite, target}]->(Crate)`: the caller
// side is a concrete version, the callee side only a crate (painter never
// resolves the callee's version). So "callers of f in crate C at version V"
// is answered like this:
//
//   * an edge from another version of C itself counts only if it is V
//     (intra-crate calls);
//   * an edge from some other crate's version counts when that version's
//     DEPENDS_ON requirement on C admits V. With no direct DEPENDS_ON (the
//     call came in through a generic instantiated elsewhere) the row is kept
//     but marked unverified.
//
// The walk is breadth-first: every caller function becomes a new target one
// level further out. A callsite whose symbol belongs to the caller's own
// crate is an ordinary function of that version (callers: that version
// itself plus dependents whose requirement admits it). A callsite whose
// symbol belongs to some other crate is a monomorphised copy living in the
// caller's binary, so only that same version can call it.

/** Symbol crates painter never records as callees (mirrors analysis.rs BLOCKED_CRATES). */
const BLOCKED_CRATES = new Set(['core', 'std', 'alloc']);

/**
 * Crate a demangled symbol belongs to: the first identifier immediately
 * followed by `::` (same rule as `analysis::crate_of`), or null.
 */
export const crateOf = (symbol) => {
  const m = /[A-Za-z0-9_]+(?=::)/.exec(symbol);
  return m ? m[0] : null;
};

/** `crateOf` with painter's callee filter applied (`analysis::callee_crate`). */
export const calleeCrate = (symbol) => {
  if (symbol.startsWith('llvm.') || symbol.startsWith('__rust')) return null;
  const c = crateOf(symbol);
  return c && !BLOCKED_CRATES.has(c) ? c : null;
};

/** Symbols spell `my-crate` as `my_crate`; compare crate names in that form. */
export const normCrate = (name) => String(name).replace(/-/g, '_');

// ---------------------------------------------------------------------------
// Cargo version requirements
// ---------------------------------------------------------------------------

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

/**
 * One comparator (`^1.2`, `~0.3.1`, `>=1.0, <2` is two of these, `1.*`, `*`)
 * as [lowerInclusive, upperExclusive] bounds; either may be null.
 */
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
  // Smallest version above everything the partial version covers.
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

/**
 * Whether a Cargo requirement string (comma-separated comparators, all must
 * hold) admits `version`. Returns null when either side does not parse.
 */
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
// Walk
// ---------------------------------------------------------------------------

/**
 * Edges whose target is one of `targets`, from any version. Uses the
 * INVOKES(target) range index; without the hint the planner prefers the
 * crate seek and expands every edge into the crate (seconds for tokio).
 */
const GLOBAL_HOP = `
  UNWIND $targets AS tg
  MATCH (v:Version)-[i:INVOKES]->(t:Crate)
  USING INDEX i:INVOKES(target)
  WHERE i.target = tg
  OPTIONAL MATCH (v)-[d:DEPENDS_ON]->(t)
  WITH v, i, t, collect(DISTINCT d.requirement) AS reqs
  RETURN v.name AS name, v.version AS version, i.callsite AS callsite, i.target AS target, t.name AS crate, reqs`;

/** Edges from specific versions whose target is one of that version's `targets`. */
const LOCAL_HOP = `
  UNWIND $locals AS l
  MATCH (v:Version {name: l.name, version: l.version})-[i:INVOKES]->(t:Crate)
  WHERE i.target IN l.targets
  RETURN v.name AS name, v.version AS version, i.callsite AS callsite, i.target AS target, t.name AS crate, [] AS reqs`;

const versionKey = (name, version) => `${name}@${version}`;

/**
 * Walk callers of `targets` (functions of crate `crate`, optionally pinned to
 * `version`) out to `maxDepth` levels or `limit` rows.
 *
 * `read(cypher, params)` runs a read query and resolves to plain row objects.
 *
 * Every row is one distinct (crate, version, function) that calls into the
 * search, at the smallest depth it was reached, with the function it calls
 * (`calls`) and the chain back to the searched function (`path`).
 */
export const findCallers = async (read, { crate, version = null, targets, maxDepth, limit }) => {
  const rows = [];
  const seen = new Set();
  // Frontier entries: { fn, crate, version, local, path }. `local` = only the
  // version that contains it can call it (foreign monomorphised copy).
  let frontier = targets.map((fn) => ({ fn, crate, version, local: false, path: [fn] }));
  let depth = 0;
  let truncated = false;
  let unverified = 0;
  let rejected = 0;

  while (frontier.length && depth < maxDepth && !truncated) {
    depth += 1;
    const byTarget = new Map();
    const locals = new Map();
    const globals = new Set();
    for (const node of frontier) {
      if (!byTarget.has(node.fn)) byTarget.set(node.fn, []);
      byTarget.get(node.fn).push(node);
      if (node.local) {
        const k = versionKey(node.crate, node.version);
        if (!locals.has(k)) locals.set(k, { name: node.crate, version: node.version, targets: [] });
        locals.get(k).targets.push(node.fn);
      } else {
        globals.add(node.fn);
      }
    }

    const edges = [
      ...(globals.size ? await read(GLOBAL_HOP, { targets: [...globals] }) : []),
      ...(locals.size ? await read(LOCAL_HOP, { locals: [...locals.values()] }) : []),
    ];

    const next = [];
    for (const e of edges) {
      for (const node of byTarget.get(e.target) ?? []) {
        let verified = true;
        if (node.local) {
          if (e.name !== node.crate || e.version !== node.version) continue;
        } else {
          if (normCrate(e.crate) !== normCrate(node.crate)) continue;
          if (node.version !== null) {
            if (normCrate(e.name) === normCrate(node.crate)) {
              if (e.version !== node.version) continue;
            } else if (e.reqs.length === 0) {
              verified = false;
            } else if (!e.reqs.some((r) => requirementMatches(r, node.version) !== false)) {
              rejected += 1;
              continue;
            }
          }
        }

        const key = `${versionKey(e.name, e.version)}::${e.callsite}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
        if (!verified) unverified += 1;
        const path = [e.callsite, ...node.path];
        rows.push({ depth, crate: e.name, version: e.version, function: e.callsite, calls: e.target, verified, path });

        const sym = calleeCrate(e.callsite);
        if (!sym) continue; // core/std generic or no path: nothing records calls into it
        const own = normCrate(sym) === normCrate(e.name);
        next.push({ fn: e.callsite, crate: e.name, version: e.version, local: !own, path });
      }
      if (truncated) break;
    }
    frontier = next;
  }

  return { rows, depth, truncated, unverified, rejected, exhausted: !truncated && frontier.length === 0 };
};
