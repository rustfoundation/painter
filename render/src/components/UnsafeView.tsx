// Unsafe view: a leaderboard of crate versions by unsafe-code metrics (painter's
// count-unsafe stage: geiger counters per category, source size, forbid(unsafe_code),
// build scripts), with coverage tiles, server-side sort/filter, a per-crate history
// and the unsafe carried in by a version's dependency closure.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type UnsafeCategory,
  type UnsafeDepsResult,
  type UnsafeRow,
  type UnsafeScope,
  type UnsafeSort,
  type UnsafeStats,
  type UnsafeTri,
} from '../api';

interface Props {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  /** Open a crate in the Default graph view. */
  onOpenCrate: (name: string) => void;
}

export const CATEGORIES: { key: UnsafeCategory; label: string; color: string; hint: string }[] = [
  { key: 'functions', label: 'fns', color: '#E5484D', hint: 'unsafe fn items' },
  { key: 'exprs', label: 'exprs', color: '#F5A623', hint: 'expressions inside unsafe blocks or unsafe fns' },
  { key: 'impls', label: 'impls', color: '#B88BFF', hint: 'unsafe impl blocks (Send, Sync, ...)' },
  { key: 'traits', label: 'traits', color: '#4C8DFF', hint: 'unsafe trait declarations' },
  { key: 'methods', label: 'methods', color: '#2BB673', hint: 'unsafe methods in impl blocks' },
];

const COLUMNS: { key: UnsafeSort; label: string; title: string; num?: boolean }[] = [
  { key: 'name', label: 'crate / version', title: 'Sort by name' },
  { key: 'total', label: 'unsafe', title: 'All unsafe counts summed', num: true },
  ...CATEGORIES.map((c) => ({ key: c.key as UnsafeSort, label: c.label, title: c.hint, num: true })),
  { key: 'lines', label: 'lines', title: 'Lines of Rust parsed', num: true },
  { key: 'density', label: '/kloc', title: 'Unsafe expressions per thousand lines', num: true },
  { key: 'share', label: 'share', title: 'Unsafe expressions as a share of all expressions', num: true },
];

const HISTOGRAM_LABELS = ['0', '1–10', '11–100', '101–1k', '>1k'];

/** The safe counterpart of a category on a row or the stats. */
const safeOf = (x: UnsafeRow | UnsafeStats, k: UnsafeCategory): number =>
  ({ functions: x.safeFunctions, exprs: x.safeExprs, impls: x.safeImpls, traits: x.safeTraits, methods: x.safeMethods })[k] ?? 0;

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString());
const pct = (part: number | undefined, whole: number | undefined) =>
  !whole || part === undefined ? '—' : `${((100 * part) / whole).toFixed(whole > 10_000 ? 1 : 0)}%`;
const errorMessage = (err: unknown) =>
  err instanceof ApiError ? (err.code ? `${err.message} [${err.code}]` : err.message) : err instanceof Error ? err.message : String(err);

/** Stacked bar of the five categories, proportional to the row's total. */
function MixBar({ row, width = 120 }: { row: Pick<UnsafeRow, UnsafeCategory | 'total'>; width?: number }) {
  if (!row.total) return <span className="mix empty" style={{ width }} />;
  return (
    <span className="mix" style={{ width }} title={CATEGORIES.map((c) => `${c.hint}: ${fmt(row[c.key])}`).join('\n')}>
      {CATEGORIES.map((c) => {
        const n = row[c.key] ?? 0;
        return n ? <span key={c.key} style={{ flex: n, background: c.color }} /> : null;
      })}
    </span>
  );
}

/** Flag badges shared by the table and the detail panels. */
function Flags({ forbids, build, failed }: { forbids: boolean | null | undefined; build: boolean; failed?: number }) {
  return (
    <>
      {forbids === true && (
        <span className="flag forbid" title="Crate root has #![forbid(unsafe_code)]">
          forbid
        </span>
      )}
      {build && (
        <span className="flag build" title="Has a build script (runs arbitrary code at build time)">
          build.rs
        </span>
      )}
      {failed ? (
        <span className="flag failed" title={`${failed} .rs file(s) could not be parsed (old syntax, not UTF-8, or over 64 MB) and are not counted`}>
          {failed} unparsed
        </span>
      ) : null}
    </>
  );
}

/** Per-version history of one crate: a bar per version, latest highlighted. */
function CrateHistory({ name, versions, onPick }: { name: string; versions: UnsafeRow[]; onPick: (v: UnsafeRow) => void }) {
  const max = Math.max(1, ...versions.map((v) => v.total ?? 0));
  const scanned = versions.filter((v) => v.scanner && !v.error);
  return (
    <div className="unsafe-history">
      <div className="unsafe-history-head">
        <b>{name}</b> across {versions.length.toLocaleString()} version{versions.length === 1 ? '' : 's'}
        <span className="muted"> · {scanned.length.toLocaleString()} scanned · bar height = unsafe total, colour = category mix</span>
      </div>
      <div className="unsafe-bars" style={{ gridTemplateColumns: `repeat(${versions.length}, minmax(6px, 1fr))` }}>
        {versions.map((v) => {
          const h = v.total ? Math.max(3, Math.round((100 * v.total) / max)) : v.scanner ? 2 : 0;
          const title = v.error
            ? `${v.version}: ${v.error}`
            : v.scanner
              ? `${v.version}: ${fmt(v.total)} unsafe (${CATEGORIES.map((c) => `${fmt(v[c.key])} ${c.label}`).join(', ')}), ${fmt(v.lines)} lines`
              : `${v.version}: not scanned`;
          return (
            <div key={v.version} className={`unsafe-bar ${v.latest ? 'latest' : ''} ${v.error ? 'error' : ''}`} title={title} onClick={() => onPick(v)}>
              <div className="col" style={{ height: `${h}%` }}>
                {v.total ? <MixBarVertical row={v} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="unsafe-bars-axis muted small">
        <span>{versions[0]?.version}</span>
        <span>{versions[versions.length - 1]?.version}</span>
      </div>
    </div>
  );
}

function MixBarVertical({ row }: { row: Pick<UnsafeRow, UnsafeCategory | 'total'> }) {
  return (
    <>
      {CATEGORIES.map((c) => {
        const n = row[c.key] ?? 0;
        return n ? <span key={c.key} style={{ flex: n, background: c.color }} /> : null;
      })}
    </>
  );
}

/** Unsafe carried in through a version's dependency closure. */
function DepsPanel({ result, onOpenCrate }: { result: UnsafeDepsResult; onOpenCrate: (name: string) => void }) {
  const s = result.summary;
  return (
    <div className="unsafe-deps">
      <div className="unsafe-history-head">
        <b>{result.crate}@{result.version}</b> pulls in <b>{fmt(s.total)}</b> unsafe items through{' '}
        <b>{fmt(s.crates)}</b> dependencies ({result.depth} hop{result.depth === 1 ? '' : 's'}, dev-dependencies skipped,
        each at its latest version)
        <span className="muted">
          {' '}
          · {fmt(s.scanned)} scanned · {fmt(s.forbids)} forbid unsafe · {fmt(s.buildScripts)} with build scripts ·{' '}
          {fmt(s.lines)} lines
        </span>
      </div>
      <MixBar row={{ total: s.total, functions: s.functions, exprs: s.exprs, impls: s.impls, traits: s.traits, methods: s.methods }} width={400} />
      <table className="unsafe-deps-table">
        <tbody>
          {result.deps.map((d) => (
            <tr key={d.name}>
              <td className="crate">
                <a onClick={() => onOpenCrate(d.name)} title="Open in the graph">
                  {d.name}
                </a>
                <span className="muted">@{d.version ?? '?'}</span>
              </td>
              <td className="num">{d.scanned ? fmt(d.total) : <span className="muted">not scanned</span>}</td>
              <td className="num muted">{d.scanned ? `${fmt(d.lines)} lines` : ''}</td>
              <td>
                <Flags forbids={d.forbidsUnsafe} build={d.hasBuildScript} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.deps.length < s.crates && <p className="muted small">Showing the {result.deps.length} most unsafe of {fmt(s.crates)}.</p>}
    </div>
  );
}

export function UnsafeView({ busy, onBusy, onError, onOpenCrate }: Props) {
  const [scope, setScope] = useState<UnsafeScope>('latest');
  const [sort, setSort] = useState<UnsafeSort>('total');
  const [desc, setDesc] = useState(true);
  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');
  const [forbids, setForbids] = useState<UnsafeTri>('any');
  const [build, setBuild] = useState<UnsafeTri>('any');
  const [minLines, setMinLines] = useState(0);
  const [minUnsafe, setMinUnsafe] = useState(0);
  const [limit, setLimit] = useState(100);

  const [stats, setStats] = useState<UnsafeStats | null>(null);
  const [rows, setRows] = useState<UnsafeRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, UnsafeRow[]>>({});
  const [deps, setDeps] = useState<Record<string, UnsafeDepsResult | 'loading'>>({});
  const [depsDepth, setDepsDepth] = useState(2);

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    api
      .unsafeStats(scope)
      .then((s) => !cancelled && setStats(s))
      .catch((err) => !cancelled && onError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [scope, onError]);

  const query = useMemo(
    () => ({ scope, sort, desc, q: qDebounced, forbids, build, minLines, minUnsafe, limit }),
    [scope, sort, desc, qDebounced, forbids, build, minLines, minUnsafe, limit],
  );

  const load = useCallback(
    async (offset: number) => {
      onBusy(true);
      onError(null);
      try {
        const r = await api.unsafeTop({ ...query, offset });
        setRows((prev) => (offset ? [...prev, ...r.rows] : r.rows));
        setHasMore(r.hasMore);
        setElapsed(r.meta.elapsedMs);
      } catch (err) {
        if (!offset) setRows([]);
        onError(errorMessage(err));
      } finally {
        onBusy(false);
      }
    },
    [query, onBusy, onError],
  );

  useEffect(() => {
    setExpanded(null);
    void load(0);
  }, [load]);

  const toggleSort = (key: UnsafeSort) => {
    if (key === sort) setDesc((d) => !d);
    else {
      setSort(key);
      setDesc(key !== 'name');
    }
  };

  const expand = async (r: UnsafeRow) => {
    const key = `${r.name}@${r.version}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (!history[r.name]) {
      try {
        const versions = await api.unsafeCrate(r.name);
        setHistory((h) => ({ ...h, [r.name]: versions }));
      } catch (err) {
        onError(errorMessage(err));
      }
    }
  };

  const loadDeps = async (r: UnsafeRow) => {
    const key = `${r.name}@${r.version}:${depsDepth}`;
    setDeps((d) => ({ ...d, [key]: 'loading' }));
    try {
      const result = await api.unsafeDeps(r.name, r.version, depsDepth, 50);
      setDeps((d) => ({ ...d, [key]: result }));
    } catch (err) {
      setDeps((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      onError(errorMessage(err));
    }
  };

  const copyTsv = () => {
    const head = ['crate', 'version', 'latest', 'unsafe_total', ...CATEGORIES.map((c) => `unsafe_${c.key}`), 'rs_lines', 'rs_files', 'per_kloc', 'share', 'forbids_unsafe', 'has_build_script'];
    const lines = [head.join('\t')];
    for (const r of rows) {
      lines.push(
        [r.name, r.version, r.latest, r.total, ...CATEGORIES.map((c) => r[c.key]), r.lines, r.files, r.density.toFixed(2), r.share.toFixed(4), r.forbidsUnsafe ?? '', r.hasBuildScript].join('\t'),
      );
    }
    void navigator.clipboard.writeText(lines.join('\n'));
  };

  const histMax = Math.max(1, ...(stats?.histogram ?? [1]));

  return (
    <div className="unsafe">
      <div className="unsafe-tiles">
        <div className="tile wide" title="Versions whose tarball was scanned, out of all versions in scope">
          <div className="tile-label">scan coverage · {scope === 'latest' ? 'latest versions' : 'all versions'}</div>
          <div className="tile-value">
            {pct(stats?.scanned, stats?.versions)} <span className="muted small">{fmt(stats?.scanned)} of {fmt(stats?.versions)}</span>
          </div>
          <div className="meter">
            <span style={{ width: stats ? `${(100 * stats.scanned) / Math.max(1, stats.versions)}%` : 0 }} />
          </div>
          <div className="muted small">
            {fmt(stats?.unreadable)} unreadable · {fmt(stats?.files)} files · {fmt(stats?.lines)} lines
          </div>
        </div>
        <div className="tile" title="Scanned versions with at least one unsafe item">
          <div className="tile-label">with any unsafe</div>
          <div className="tile-value">{pct(stats?.withUnsafe, stats?.scanned)}</div>
          <div className="muted small">{fmt(stats?.withUnsafe)} versions</div>
        </div>
        <div className="tile" title="Crate root carries #![forbid(unsafe_code)]">
          <div className="tile-label">forbid(unsafe_code)</div>
          <div className="tile-value">{pct(stats?.forbids, stats?.scanned)}</div>
          <div className="muted small">{fmt(stats?.forbids)} versions</div>
        </div>
        <div className="tile" title="Versions with a build script">
          <div className="tile-label">build scripts</div>
          <div className="tile-value">{pct(stats?.buildScripts, stats?.scanned)}</div>
          <div className="muted small">{fmt(stats?.buildScripts)} versions</div>
        </div>
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`tile cat ${sort === c.key ? 'active' : ''}`}
            style={{ borderTopColor: c.color }}
            title={`${c.hint}. Click to sort by it.`}
            onClick={() => toggleSort(c.key)}
          >
            <div className="tile-label">unsafe {c.label}</div>
            <div className="tile-value">{fmt(stats?.[c.key])}</div>
            <div className="muted small">of {fmt(stats ? stats[c.key] + safeOf(stats, c.key) : undefined)}</div>
          </button>
        ))}
        <div className="tile hist" title="Scanned versions by unsafe total">
          <div className="tile-label">versions by unsafe total</div>
          <div className="hist-bars">
            {(stats?.histogram ?? [0, 0, 0, 0, 0]).map((n, i) => (
              <div key={i} className="hist-col" title={`${HISTOGRAM_LABELS[i]}: ${fmt(n)}`}>
                <div className="hist-bar" style={{ height: `${Math.max(2, (100 * Math.log1p(n)) / Math.log1p(histMax))}%` }} />
                <div className="muted small">{HISTOGRAM_LABELS[i]}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="unsafe-controls">
        <label className="opt">
          scope
          <select value={scope} onChange={(e) => setScope(e.target.value as UnsafeScope)} title="All versions scans every version in the database: slower">
            <option value="latest">latest versions</option>
            <option value="all">all versions</option>
          </select>
        </label>
        <input type="text" placeholder="Crate name contains…" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} className="q" />
        <label className="opt">
          forbid(unsafe_code)
          <select value={forbids} onChange={(e) => setForbids(e.target.value as UnsafeTri)}>
            <option value="any">any</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </label>
        <label className="opt">
          build script
          <select value={build} onChange={(e) => setBuild(e.target.value as UnsafeTri)}>
            <option value="any">any</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </label>
        <label className="opt" title="Only versions with at least this many lines of Rust (density is noisy on tiny crates)">
          min lines
          <input type="number" min={0} step={1000} value={minLines} onChange={(e) => setMinLines(Math.max(0, Number(e.target.value) || 0))} className="limit wide" />
        </label>
        <label className="opt" title="Only versions with at least this many unsafe items">
          min unsafe
          <input type="number" min={0} value={minUnsafe} onChange={(e) => setMinUnsafe(Math.max(0, Number(e.target.value) || 0))} className="limit" />
        </label>
        <label className="opt">
          rows
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 100, 250, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <span className="muted small">
          {rows.length.toLocaleString()} rows{hasMore ? '+' : ''} · {elapsed.toLocaleString()} ms
        </span>
        <button onClick={copyTsv} disabled={!rows.length} title="Copy the shown rows as tab-separated text">
          Copy TSV
        </button>
      </div>

      <div className="unsafe-table">
        <table>
          <thead>
            <tr>
              <th className="rank">#</th>
              <th className="mixcol" title="Category mix of the unsafe total">
                mix
              </th>
              {COLUMNS.map((c) => (
                <th key={c.key} className={`${c.num ? 'num' : ''} ${sort === c.key ? 'sorted' : ''}`} title={c.title} onClick={() => toggleSort(c.key)}>
                  {c.label}
                  {sort === c.key ? (desc ? ' ▾' : ' ▴') : ''}
                </th>
              ))}
              <th>flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const key = `${r.name}@${r.version}`;
              const open = expanded === key;
              const depsKey = `${key}:${depsDepth}`;
              const d = deps[depsKey];
              return (
                <Fragment key={key}>
                  <tr className={open ? 'open' : ''} onClick={() => void expand(r)} title="Click for the crate's history and dependency unsafe">
                    <td className="rank muted">{i + 1}</td>
                    <td className="mixcol">
                      <MixBar row={r} />
                    </td>
                    <td className="crate">
                      {r.name}
                      <span className="muted">@{r.version}</span>
                      {r.latest && scope === 'all' && <span className="badge">latest</span>}
                    </td>
                    <td className="num total">{fmt(r.total)}</td>
                    {CATEGORIES.map((c) => (
                      <td key={c.key} className={`num ${r[c.key] ? '' : 'muted'}`}>
                        {fmt(r[c.key])}
                      </td>
                    ))}
                    <td className="num muted">{fmt(r.lines)}</td>
                    <td className="num">{r.density.toFixed(1)}</td>
                    <td className="num">{(100 * r.share).toFixed(1)}%</td>
                    <td className="flags">
                      <Flags forbids={r.forbidsUnsafe} build={r.hasBuildScript} failed={r.filesFailed ?? undefined} />
                    </td>
                  </tr>
                  {open && (
                    <tr className="detail">
                      <td colSpan={COLUMNS.length + 3}>
                        <div className="unsafe-detail">
                          <div className="unsafe-detail-actions">
                            <button onClick={() => onOpenCrate(r.name)} title="Open this crate in the Default graph view">
                              Open in graph
                            </button>
                            <label className="opt" title="Hops of dependencies to follow (dev-dependencies skipped)">
                              depth
                              <input type="number" min={1} max={5} value={depsDepth} onChange={(e) => setDepsDepth(Math.min(5, Math.max(1, Number(e.target.value) || 1)))} className="limit" />
                            </label>
                            <button onClick={() => void loadDeps(r)} disabled={d === 'loading'} title="Sum the unsafe of every dependency reachable from this version">
                              {d === 'loading' ? 'Loading…' : 'Unsafe in dependencies'}
                            </button>
                            <span className="muted small">
                              {r.files !== null ? `${fmt(r.files)} files · ${fmt(r.bytes)} bytes · ` : ''}
                              scanned {r.scannedAt ? new Date(r.scannedAt).toLocaleString() : '—'} with {r.scanner ?? '—'}
                            </span>
                          </div>
                          <div className="unsafe-detail-grid">
                            <table className="unsafe-cats">
                              <thead>
                                <tr>
                                  <th />
                                  <th className="num">unsafe</th>
                                  <th className="num">safe</th>
                                  <th className="num">share</th>
                                </tr>
                              </thead>
                              <tbody>
                                {CATEGORIES.map((c) => {
                                  const u = r[c.key] ?? 0;
                                  const s = safeOf(r, c.key);
                                  return (
                                    <tr key={c.key}>
                                      <th>
                                        <span className="swatch" style={{ background: c.color }} /> {c.hint}
                                      </th>
                                      <td className="num">{fmt(u)}</td>
                                      <td className="num muted">{fmt(s)}</td>
                                      <td className="num">{u + s ? `${((100 * u) / (u + s)).toFixed(1)}%` : '—'}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                            {history[r.name] ? (
                              <CrateHistory
                                name={r.name}
                                versions={history[r.name]}
                                onPick={(v) => {
                                  setQ(r.name);
                                  if (!v.latest) setScope('all');
                                }}
                              />
                            ) : (
                              <p className="muted">Loading version history…</p>
                            )}
                          </div>
                          {d && d !== 'loading' && <DepsPanel result={d} onOpenCrate={onOpenCrate} />}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && !busy && (
          <p className="muted pad">{stats && stats.scanned === 0 ? 'Nothing scanned yet: run painter count-unsafe.' : 'No versions match the filters.'}</p>
        )}
        {hasMore && (
          <div className="pad">
            <button disabled={busy} onClick={() => void load(rows.length)}>
              Load {limit} more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
