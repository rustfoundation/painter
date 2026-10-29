import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, type StatsMeta, type UnsafeScope } from '../api';

export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString());
export const pct = (part: number | null | undefined, whole: number | null | undefined) =>
  !whole || part === null || part === undefined ? '—' : `${((100 * part) / whole).toFixed(whole > 10_000 ? 1 : 0)}%`;
export const fmtBytes = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
/** Registry timestamps are DateTimes serialised as ISO strings. */
export const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—');
export const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};
export const fmtAgo = (iso: string) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return fmtDateTime(iso);
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

/** "totals computed 5 min ago" for a precomputed payload, or that they were aggregated on request. */
export const freshness = (s: StatsMeta | null | undefined) => {
  if (!s) return null;
  if (s.computedAt) return `totals computed ${fmtAgo(s.computedAt)}`;
  if (s.source === 'live') return `totals computed live (no jobs service)${s.elapsedMs ? ` in ${s.elapsedMs.toLocaleString()} ms` : ''}`;
  return null;
};

export const fmtCompact = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  return n.toLocaleString();
};
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (days: number) => isoDay(new Date(Date.now() - days * 86_400_000));

export function UserLink({ login, onOpen, name }: { login: string | null | undefined; onOpen?: (login: string) => void; name?: string | null }) {
  if (!login) return <span className="muted">—</span>;
  return (
    <a
      className="user-link"
      title={name ? `${name} · open in Publishers` : 'Open in Publishers'}
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.(login);
      }}
    >
      {login}
    </a>
  );
}

export const errorMessage = (err: unknown) =>
  err instanceof ApiError ? (err.code ? `${err.message} [${err.code}]` : err.message) : err instanceof Error ? err.message : String(err);

export function ScopeSelect({ scope, onChange }: { scope: UnsafeScope; onChange: (s: UnsafeScope) => void }) {
  return (
    <label className="opt">
      scope
      <select value={scope} onChange={(e) => onChange(e.target.value as UnsafeScope)} title="All versions scans every version in the database: slower">
        <option value="latest">latest versions</option>
        <option value="all">all versions</option>
      </select>
    </label>
  );
}

export function TriSelect<T extends string>({ label, value, onChange, title }: { label: string; value: T; onChange: (v: T) => void; title?: string }) {
  return (
    <label className="opt" title={title}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        <option value="any">any</option>
        <option value="yes">yes</option>
        <option value="no">no</option>
      </select>
    </label>
  );
}

export function RowsSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="opt">
      rows
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {[50, 100, 250, 500, 1000].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CoverageTile({ scope, scanned, versions, note, title, stats }: { scope: UnsafeScope; scanned?: number; versions?: number; note?: ReactNode; title: string; stats?: StatsMeta | null }) {
  const fresh = freshness(stats);
  return (
    <div className="tile wide" title={fresh ? `${title}. ${fresh}` : title}>
      <div className="tile-label">scan coverage · {scope === 'latest' ? 'latest versions' : 'all versions'}</div>
      <div className="tile-value">
        {pct(scanned, versions)} <span className="muted small">{fmt(scanned)} of {fmt(versions)}</span>
      </div>
      <div className="meter">
        <span style={{ width: scanned !== undefined && versions ? `${(100 * scanned) / Math.max(1, versions)}%` : 0 }} />
      </div>
      {note && <div className="muted small">{note}</div>}
      {fresh && <div className="muted small">{fresh}</div>}
    </div>
  );
}

export function Tile({ label, value, note, title, color, onClick, active }: { label: string; value: ReactNode; note?: ReactNode; title?: string; color?: string; onClick?: () => void; active?: boolean }) {
  const body = (
    <>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="muted small">{note}</div>}
    </>
  );
  return onClick ? (
    <button type="button" className={`tile cat ${active ? 'active' : ''}`} style={color ? { borderTopColor: color } : undefined} title={title} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="tile" style={color ? { borderTopColor: color } : undefined} title={title}>
      {body}
    </div>
  );
}

export function HistTile({ label, labels, values, title }: { label: string; labels: string[]; values?: number[]; title: string }) {
  const vals = values ?? labels.map(() => 0);
  const max = Math.max(1, ...vals);
  return (
    <div className="tile hist" title={title}>
      <div className="tile-label">{label}</div>
      <div className="hist-bars">
        {vals.map((n, i) => (
          <div key={i} className="hist-col" title={`${labels[i]}: ${fmt(n)}`}>
            <div className="hist-bar" style={{ height: `${Math.max(2, (100 * Math.log1p(n)) / Math.log1p(max))}%` }} />
            <div className="muted small">{labels[i]}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface Column<S extends string> {
  key: S;
  label: string;
  title: string;
  num?: boolean;
}

export function SortHeaders<S extends string>({ columns, sort, desc, onSort }: { columns: Column<S>[]; sort: S; desc: boolean; onSort: (k: S) => void }) {
  return (
    <>
      {columns.map((c) => (
        <th key={c.key} className={`${c.num ? 'num' : ''} ${sort === c.key ? 'sorted' : ''}`} title={c.title} onClick={() => onSort(c.key)}>
          {c.label}
          {sort === c.key ? (desc ? ' ▾' : ' ▴') : ''}
        </th>
      ))}
    </>
  );
}

export function useSort<S extends string>(initial: S, nameKey: S) {
  const [sort, setSort] = useState<S>(initial);
  const [desc, setDesc] = useState(true);
  const toggle = useCallback(
    (key: S) => {
      if (key === sort) setDesc((d) => !d);
      else {
        setSort(key);
        setDesc(key !== nameKey);
      }
    },
    [sort, nameKey],
  );
  return { sort, desc, toggle };
}

export function useDebounced(value: string, ms = 300) {
  const [debounced, setDebounced] = useState(value.trim());
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value.trim()), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function useStats<T>(fetch: (scope: UnsafeScope) => Promise<T>, scope: UnsafeScope, onError: (m: string | null) => void) {
  const [stats, setStats] = useState<T | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(scope)
      .then((s) => !cancelled && setStats(s))
      .catch((err) => !cancelled && onError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [fetch, scope, onError]);
  return stats;
}

export function useLeaderboard<Row, Q extends object>(
  fetch: (q: Q & { offset: number }) => Promise<{ rows: Row[]; hasMore: boolean; meta: { elapsedMs: number } }>,
  query: Q,
  onBusy: (b: boolean) => void,
  onError: (m: string | null) => void,
) {
  const [rows, setRows] = useState<Row[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [generation, setGeneration] = useState(0);
  const load = useCallback(
    async (offset: number) => {
      onBusy(true);
      onError(null);
      try {
        const r = await fetch({ ...query, offset });
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
    [fetch, query, onBusy, onError],
  );
  useEffect(() => {
    setGeneration((g) => g + 1);
    void load(0);
  }, [load]);
  const loadMore = useCallback(() => void load(rows.length), [load, rows.length]);
  return useMemo(() => ({ rows, hasMore, elapsed, loadMore, generation }), [rows, hasMore, elapsed, loadMore, generation]);
}

export function useCrateHistory<Row>(fetch: (name: string) => Promise<Row[]>, onError: (m: string | null) => void) {
  const [history, setHistory] = useState<Record<string, Row[]>>({});
  const ensure = useCallback(
    async (name: string) => {
      if (history[name]) return;
      try {
        const versions = await fetch(name);
        setHistory((h) => ({ ...h, [name]: versions }));
      } catch (err) {
        onError(errorMessage(err));
      }
    },
    [fetch, history, onError],
  );
  return { history, ensure };
}

export interface HistoryBar {
  version: string;
  latest: boolean;
  height: number | null;
  segments: [string, number][];
  title: string;
  error?: boolean;
}

export function HistoryStrip({ bars, onPick, head }: { bars: HistoryBar[]; onPick?: (version: string) => void; head: ReactNode }) {
  return (
    <div className="unsafe-history">
      <div className="unsafe-history-head">{head}</div>
      <div className="unsafe-bars" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(6px, 1fr))` }}>
        {bars.map((b) => (
          <div key={b.version} className={`unsafe-bar ${b.latest ? 'latest' : ''} ${b.error ? 'error' : ''}`} title={b.title} onClick={() => onPick?.(b.version)}>
            <div className="col" style={{ height: `${b.height === null ? 0 : b.height ? Math.max(3, Math.round(100 * b.height)) : 2}%` }}>
              {b.segments.map(([color, weight], i) => (weight ? <span key={i} style={{ flex: weight, background: color }} /> : null))}
            </div>
          </div>
        ))}
      </div>
      <div className="unsafe-bars-axis muted small">
        <span>{bars[0]?.version}</span>
        <span>{bars[bars.length - 1]?.version}</span>
      </div>
    </div>
  );
}

export function LoadMore({ hasMore, busy, limit, onClick }: { hasMore: boolean; busy: boolean; limit: number; onClick: () => void }) {
  if (!hasMore) return null;
  return (
    <div className="pad">
      <button disabled={busy} onClick={onClick}>
        Load {limit} more
      </button>
    </div>
  );
}

export const copyTsv = (head: string[], rows: (string | number | boolean | null | undefined)[][]) => {
  const lines = [head.join('\t'), ...rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))).join('\t'))];
  void navigator.clipboard.writeText(lines.join('\n'));
};
