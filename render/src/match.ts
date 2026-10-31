// Client twin of server/match.mjs. Plain text is an exact, case-insensitive name; only `*` (any run of
// characters) and `?` (one character) make a query fuzzy. Suggestion dropdowns still offer partial matches.

export const hasWildcard = (q: string): boolean => /[*?]/.test(q);

const escapeRe = (c: string) => (/[\\^$.|+()[\]{}]/.test(c) ? `\\${c}` : c);

/** Predicate on a name: exact (case-insensitive) without wildcards, the full-string pattern with them. */
export const nameTester = (q: string): ((name: string) => boolean) => {
  const text = q.trim();
  if (!text) return () => true;
  if (!hasWildcard(text)) {
    const lower = text.toLowerCase();
    return (name) => name.toLowerCase() === lower;
  }
  const re = new RegExp(`^${[...text].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : escapeRe(c))).join('')}$`, 'i');
  return (name) => re.test(name);
};

/** Placeholder suffix shared by every name filter. */
export const PATTERN_HINT = 'exact name, or a pattern like tokio*';
