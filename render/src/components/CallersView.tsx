// Callers view: pick a crate, optionally a version, and a function of it; get a
// table of every crate version and function that calls it, directly or
// through other functions (reverse walk over CALLS, see server/callers.mjs).

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type CallerRow, type CallersResult, type CrateVersion } from '../api';

interface Props {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
}

type SortKey = 'depth' | 'crate' | 'function' | 'calls';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'depth', label: 'depth' },
  { key: 'crate', label: 'crate / version' },
  { key: 'function', label: 'function' },
  { key: 'calls', label: 'calls' },
];

const errorMessage = (err: unknown) =>
  err instanceof ApiError ? (err.code ? `${err.message} [${err.code}]` : err.message) : err instanceof Error ? err.message : String(err);

/** Text input with a debounced suggestion list; Enter on a highlighted item or a click picks it. */
function SuggestInput(props: {
  value: string;
  onChange: (v: string) => void;
  /** `picked` is true when the value came from the list rather than typing. */
  onPick: (v: string, picked: boolean) => void;
  fetch: (q: string) => Promise<{ value: string; hint?: string }[]>;
  placeholder: string;
  className?: string;
  /** Suggest on focus even when empty (function list of a crate). */
  suggestEmpty?: boolean;
}) {
  const { value, onChange, onPick, fetch, placeholder, className, suggestEmpty } = props;
  const [items, setItems] = useState<{ value: string; hint?: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!open || (!value.trim() && !suggestEmpty)) {
      setItems([]);
      return;
    }
    let cancelled = false;
    timer.current = window.setTimeout(() => {
      fetch(value.trim())
        .then((r) => {
          if (cancelled) return;
          setItems(r);
          setActive(-1);
        })
        .catch(() => !cancelled && setItems([]));
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
    };
  }, [value, open, fetch, suggestEmpty]);

  const pick = (v: string, picked: boolean) => {
    setOpen(false);
    onPick(v, picked);
  };

  return (
    <div className={`search ${className ?? ''}`}>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, -1));
          } else if (e.key === 'Enter') {
            if (open && active >= 0) pick(items[active].value, true);
            else pick(value, false);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        spellCheck={false}
      />
      {open && items.length > 0 && (
        <ul className="suggestions">
          {items.map((s, i) => (
            <li key={s.value} className={i === active ? 'active' : ''} onMouseDown={() => pick(s.value, true)} title={s.value}>
              <span className="mono">{s.value}</span>
              {s.hint && <span className="muted small"> {s.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CallersView({ busy, onBusy, onError }: Props) {
  const [crate, setCrate] = useState('');
  const [versions, setVersions] = useState<CrateVersion[]>([]);
  const [version, setVersion] = useState('');
  const [fn, setFn] = useState('');
  /** Set when the function came from the suggestion list: search that exact name. */
  const [exact, setExact] = useState(false);
  const [depth, setDepth] = useState(3);
  const [limit, setLimit] = useState(2000);
  const [result, setResult] = useState<CallersResult | null>(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'depth', desc: false });
  /** Row key (`crate@version::function`) whose call chain is shown. */
  const [expanded, setExpanded] = useState<string | null>(null);

  // Versions of the chosen crate, for the version pin.
  useEffect(() => {
    setVersions([]);
    setVersion('');
    const name = crate.trim();
    if (!name) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      api
        .crateVersions(name)
        .then((v) => !cancelled && setVersions(v))
        .catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [crate]);

  const fetchCrates = useMemo(() => (q: string) => api.searchCrates(q).then((names) => names.map((value) => ({ value }))), []);
  const fetchFunctions = useMemo(
    () => (q: string) =>
      crate.trim()
        ? api.searchFunctions(crate.trim(), q, 30).then((fs) => fs.map((f) => ({ value: f.name, hint: `${f.calls.toLocaleString()} calls` })))
        : Promise.resolve([]),
    [crate],
  );

  const search = async (fnValue = fn, exactValue = exact) => {
    if (!crate.trim() || !fnValue.trim()) return;
    onBusy(true);
    onError(null);
    setExpanded(null);
    try {
      setResult(await api.callers({ crate: crate.trim(), version: version || null, fn: fnValue.trim(), exact: exactValue, depth, limit }));
    } catch (err) {
      setResult(null);
      onError(errorMessage(err));
    } finally {
      onBusy(false);
    }
  };

  const rows = useMemo(() => {
    if (!result) return [];
    const f = filter.trim().toLowerCase();
    const kept = f
      ? result.rows.filter((r) => `${r.crate}@${r.version} ${r.function} ${r.calls}`.toLowerCase().includes(f))
      : result.rows.slice();
    const val = (r: CallerRow) => (sort.key === 'crate' ? `${r.crate}@${r.version}` : r[sort.key]);
    kept.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.desc ? -c : c;
    });
    return kept;
  }, [result, filter, sort]);

  const versionCount = useMemo(() => new Set(result?.rows.map((r) => `${r.crate}@${r.version}`)).size, [result]);

  const copyTsv = () => {
    const lines = [['depth', 'crate', 'version', 'function', 'calls', 'verified'].join('\t')];
    for (const r of rows) lines.push([r.depth, r.crate, r.version, r.function, r.calls, r.verified].join('\t'));
    void navigator.clipboard.writeText(lines.join('\n'));
  };

  const m = result?.meta;

  return (
    <div className="callers">
      <div className="callers-form">
        <SuggestInput
          value={crate}
          onChange={setCrate}
          onPick={(v) => setCrate(v)}
          fetch={fetchCrates}
          placeholder="Crate, e.g. tokio"
          className="crate"
        />
        <label className="opt" title="Pin the callee crate's version: callers must be that version or declare a requirement that admits it">
          version
          <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={!versions.length}>
            <option value="">any</option>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}
                {v.latest ? ' (latest)' : ''}
                {v.exported ? ' ·calls exported' : ''}
              </option>
            ))}
          </select>
        </label>
        <SuggestInput
          value={fn}
          onChange={(v) => {
            setFn(v);
            setExact(false);
          }}
          onPick={(v, picked) => {
            setFn(v);
            setExact(picked);
            void search(v, picked);
          }}
          fetch={fetchFunctions}
          placeholder={crate.trim() ? 'Function name or part of one, e.g. task::spawn' : 'Pick a crate first'}
          className="fn"
          suggestEmpty
        />
        <label className="opt" title="Levels of callers to walk outwards; 1 = direct callers only">
          depth
          <input type="number" min={1} max={10} value={depth} onChange={(e) => setDepth(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} className="limit" />
        </label>
        <label className="opt">
          max rows
          <input type="number" min={1} max={2000} step={100} value={limit} onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))} className="limit wide" />
        </label>
        <button className="primary" disabled={busy || !crate.trim() || !fn.trim()} onClick={() => void search()}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>

      {!result ? (
        <div className="callers-empty">
          <h1>function callers</h1>
          <p>
            Pick a crate and type a function of it. The table lists every crate version and function that calls it, directly
            (depth 1) or through other functions (depth 2+).
          </p>
          <p className="muted">
            Typed text matches every called function of the crate containing it; a suggestion searches that exact function.
            Pinning a version keeps callers whose dependency requirement admits it. Only calls painter has exported show up, and
            the callee crate comes from the symbol path, so a hyphenated crate is reached under its underscore name.
          </p>
        </div>
      ) : (
        <>
          <div className="callers-summary">
            <span>
              <b>{result.rows.length.toLocaleString()}</b> functions in <b>{versionCount.toLocaleString()}</b> crate versions call{' '}
              {m!.targets.length === 1 ? <code>{m!.targets[0]}</code> : <span title={m!.targets.join('\n')}>{m!.targets.length} functions of {m!.crate} matching “{m!.fn}”</span>}
              {m!.version ? ` @ ${m!.version}` : ''}
            </span>
            <span className="muted">
              depth {m!.depth}/{m!.maxDepth}
              {m!.exhausted ? ' (no further callers)' : ''}
              {m!.truncated ? ` · cut at ${m!.limit.toLocaleString()} rows` : ''}
              {m!.version && m!.rejected ? ` · ${m!.rejected.toLocaleString()} edges excluded by version requirement` : ''}
              {m!.unverified ? ` · ${m!.unverified.toLocaleString()} unverified (no direct dependency)` : ''} · {m!.elapsedMs.toLocaleString()} ms
            </span>
            <span className="spacer" />
            <input type="text" placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
            <button onClick={copyTsv} disabled={!rows.length} title="Copy the shown rows as tab-separated text">
              Copy TSV
            </button>
          </div>
          <div className="callers-table">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      className={c.key}
                      onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : false }))}
                    >
                      {c.label}
                      {sort.key === c.key ? (sort.desc ? ' ▾' : ' ▴') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const key = `${r.crate}@${r.version}::${r.function}`;
                  return (
                  <Fragment key={key}>
                    <tr className={expanded === key ? 'open' : ''} onClick={() => setExpanded((e) => (e === key ? null : key))} title="Click for the call chain">
                      <td className="depth">{r.depth}</td>
                      <td className="crate">
                        {r.crate}
                        <span className="muted">@{r.version}</span>
                        {!r.verified && (
                          <span className="badge" title="Version pinned, but this crate has no direct dependency to check the requirement against">
                            unverified
                          </span>
                        )}
                      </td>
                      <td className="function mono">{r.function}</td>
                      <td className="calls mono muted">{r.calls}</td>
                    </tr>
                    {expanded === key && (
                      <tr className="chain">
                        <td />
                        <td colSpan={3}>
                          <ol>
                            {r.path.map((p, j) => (
                              <li key={j} className="mono">
                                {p}
                              </li>
                            ))}
                          </ol>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <p className="muted pad">No rows{filter ? ' match the filter' : ''}.</p>}
          </div>
        </>
      )}
    </div>
  );
}
