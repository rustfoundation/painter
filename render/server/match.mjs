// Name matching shared by every search box and table filter.
//
// Plain text is an exact, case-insensitive name. Only `*` (any run of characters) and `?` (one
// character) make a query fuzzy: `tokio*`, `*-sys`, `*serde*`, `serde_?son`. Suggestion dropdowns are
// the exception: they always offer partial matches so the user can pick an exact name.

export const hasWildcard = (q) => /[*?]/.test(String(q ?? ''));

const escapeRe = (c) => (/[\\^$.|+()[\]{}]/.test(c) ? `\\${c}` : c);
const toRegexBody = (q) => [...q].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : escapeRe(c))).join('');

/** Cypher `=~` pattern (full-string, case-insensitive) for a wildcard query. */
export const wildcardRegex = (q) => `(?i)${toRegexBody(String(q).trim())}`;

/** JS predicate on a name: exact (case-insensitive) without wildcards, the pattern with them. */
export const nameTester = (q) => {
  const text = String(q ?? '').trim();
  if (!text) return () => true;
  if (!hasWildcard(text)) {
    const lower = text.toLowerCase();
    return (name) => String(name).toLowerCase() === lower;
  }
  const re = new RegExp(`^${toRegexBody(text)}$`, 'i');
  return (name) => re.test(String(name));
};

/**
 * Longest literal run of a wildcard query (`*tokio-*util` -> `tokio-`), so a pattern search can seed
 * from an index-backed CONTAINS before the regex filters it. Empty when the query is all wildcards.
 */
export const longestLiteral = (q) =>
  String(q)
    .split(/[*?]+/)
    .reduce((best, part) => (part.length > best.length ? part : best), '');

/**
 * Cypher filter on `expr` driven by the `$q` / `$re` parameters from `nameParams`: empty matches
 * everything, `$re` null is an exact case-insensitive comparison, otherwise the wildcard regex.
 */
export const nameFilter = (expr) => `($q = '' OR ($re IS NULL AND toLower(${expr}) = $q) OR ($re IS NOT NULL AND ${expr} =~ $re))`;

export const nameParams = (q) => {
  const text = String(q ?? '').trim();
  return { q: text.toLowerCase(), re: hasWildcard(text) ? wildcardRegex(text) : null };
};

/** Above this many crates a pattern filters the version scan instead of anchoring on the names. */
const NAME_ANCHOR_MAX = 5000;

/**
 * Crate-name filter for the version tables (unsafe, build, native, diffs). Their scans walk a sort
 * index until the page is full, so a filter that matches few versions (an exact name, a rare pattern)
 * would read every version first. Resolve the crate names up front instead (one index lookup, or a
 * regex over the ~340k crate names) and start from those crates.
 * Returns `{ match, filter, params, crates }` to splice into `MATCH (v:Version) WHERE ... AND filter`.
 */
export const crateNameScope = async (read, int, q) => {
  const text = String(q ?? '').trim();
  const all = { match: 'MATCH (v:Version)', filter: 'true', params: {}, crates: null };
  if (!text) return all;
  let names;
  if (hasWildcard(text)) {
    const rows = await read(`MATCH (c:Crate) WHERE c.name =~ $re RETURN c.name AS name LIMIT $max`, { re: wildcardRegex(text), max: int(NAME_ANCHOR_MAX + 1) });
    if (rows.length > NAME_ANCHOR_MAX) return { ...all, filter: 'v.name =~ $nameRe', params: { nameRe: wildcardRegex(text) } };
    names = rows.map((r) => r.name);
  } else {
    const typed = [...new Set([text, text.toLowerCase()])];
    names = (await read(`MATCH (c:Crate) WHERE c.name IN $names RETURN c.name AS name`, { names: typed })).map((r) => r.name);
    if (!names.length) {
      names = (await read(`MATCH (c:Crate) WHERE toLower(c.name) = $q RETURN c.name AS name LIMIT 1`, { q: text.toLowerCase() })).map((r) => r.name);
    }
  }
  return { match: 'MATCH (nc:Crate WHERE nc.name IN $crateNames)-[:VERSION_OF]->(v:Version)', filter: 'true', params: { crateNames: names }, crates: names.length };
};
