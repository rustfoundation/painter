// The callee side is only a Symbol of a crate (painter never resolves the callee's version). So callers of f in C at V are:
// another version of C only if it is V; another crate's version if its DEPENDS_ON requirement on C admits V. With no direct
// DEPENDS_ON (the call came through a generic instantiated elsewhere) the row is kept but marked unverified.
// A callsite whose symbol belongs to a crate other than the caller's is a monomorphised copy in the caller's binary,
// so only that same version can call it.

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

// Starts from the Symbol.name uniqueness index: one seek per target plus its callers.
const GLOBAL_HOP = `
  UNWIND $targets AS tg
  MATCH (s:Symbol {name: tg})-[:IN]->(t:Crate)
  MATCH (s)<-[:CALLS]-(f:Fn)<-[:HAS_FN]-(v:Version)
  MATCH (f)-[:IS]->(cs:Symbol)
  OPTIONAL MATCH (v)-[d:DEPENDS_ON]->(t)
  WITH v, cs, s, t, collect(DISTINCT d.requirement) AS reqs
  RETURN v.name AS name, v.version AS version, cs.name AS callsite, s.name AS target, t.name AS crate, reqs`;

const LOCAL_HOP = `
  UNWIND $locals AS l
  UNWIND l.targets AS tg
  MATCH (s:Symbol {name: tg})-[:IN]->(t:Crate)
  MATCH (s)<-[:CALLS]-(f:Fn)<-[:HAS_FN]-(v:Version {name: l.name, version: l.version})
  MATCH (f)-[:IS]->(cs:Symbol)
  RETURN v.name AS name, v.version AS version, cs.name AS callsite, s.name AS target, t.name AS crate, [] AS reqs`;

const versionKey = (name, version) => `${name}@${version}`;

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
