// Releases view: crates or versions published in a timeframe (registry job dates),
// with a per-day / per-month timeline of the range, server-side paging, and filters.
//   crates   · first release  = Crate.created_at
//            · new publisher  = PUBLISHED->Crate .at (a user's first upload of the crate; flags
//                               "joined" when the crate already existed)
//   versions · uploads        = PUBLISHED->Version .at (uploader recorded, since 2017)
//            · published_at   = Version.published_at (every version, uploader when known)

import { useEffect, useMemo, useState } from 'react';
import { api, type ReleaseKind, type ReleaseRow, type ReleaseSort, type ReleaseSource, type ReleasesHistogram } from '../api';
import { NativeFlags } from './BuildView';
import { copyTsv, daysAgo, errorMessage, fmt, fmtBytes, fmtCompact, fmtDate, fmtDateTime, HistoryStrip, isoDay, LoadMore, RowsSelect, SortHeaders, UserLink, useDebounced, useLeaderboard, useSort, type Column, type HistoryBar } from './meta';

interface Props {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onOpenCrate: (name: string) => void;
  onOpenUser: (login: string) => void;
}

const COLOR_CRATES = '#4C8DFF';
const COLOR_VERSIONS = '#F5A623';

const SOURCES: Record<ReleaseKind, { id: ReleaseSource; label: string; title: string }[]> = {
  crates: [
    { id: 'created', label: 'first release (Crate.created_at)', title: 'Crates whose first version was published in the range' },
    { id: 'publisher', label: 'new publisher (first upload of a crate)', title: 'A user’s first upload of a crate in the range: new crates and existing crates that gained a publisher' },
  ],
  versions: [
    { id: 'publisher', label: 'uploads with a recorded uploader', title: 'PUBLISHED edges: crates.io records the uploader since 2017' },
    { id: 'published_at', label: 'every version (Version.published_at)', title: 'All versions published in the range, uploader shown when recorded' },
  ],
};

const CRATE_COLUMNS: Column<ReleaseSort>[] = [
  { key: 'date', label: 'published', title: 'Sort by date (index order, fast for any range)' },
  { key: 'name', label: 'crate', title: 'Sort by name (sorts the whole range)' },
  { key: 'downloads', label: 'downloads', title: 'Sort by downloads (sorts the whole range)', num: true },
];
const VERSION_COLUMNS: Column<ReleaseSort>[] = [
  { key: 'date', label: 'published', title: 'Sort by date (index order, fast for any range)' },
  { key: 'name', label: 'crate / version', title: 'Sort by name (sorts the whole range)' },
  { key: 'downloads', label: 'downloads', title: 'Version downloads (sorts the whole range)', num: true },
];

const PRESETS: { label: string; days: number }[] = [
  { label: '24 h', days: 1 },
  { label: '7 d', days: 7 },
  { label: '30 d', days: 30 },
  { label: '90 d', days: 90 },
  { label: '1 y', days: 365 },
];

function RangeHistogram({ hist, color, onPick }: { hist: ReleasesHistogram | null; color: string; onPick: (bucket: string, unit: 'day' | 'month') => void }) {
  const bars = useMemo<HistoryBar[]>(() => {
    if (!hist) return [];
    // Fill gaps so the strip is a real time axis.
    const counts = new Map(hist.buckets.map((b) => [b.bucket, b.n]));
    const keys: string[] = [];
    const start = new Date(hist.from);
    const end = new Date(hist.to);
    if (hist.unit === 'day') {
      for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); d < end; d.setUTCDate(d.getUTCDate() + 1)) keys.push(isoDay(d));
    } else {
      for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); d < end; d.setUTCMonth(d.getUTCMonth() + 1)) keys.push(isoDay(d));
    }
    const max = Math.max(1, ...counts.values());
    return keys.map((k) => {
      const n = counts.get(k) ?? 0;
      return { version: hist.unit === 'month' ? k.slice(0, 7) : k, latest: false, height: n / max, segments: [[color, 1]], title: `${k}: ${fmt(n)}` };
    });
  }, [hist, color]);
  if (!hist) return <p className="muted small">Loading timeline…</p>;
  if (!bars.length) return <p className="muted small">Nothing in this range.</p>;
  return (
    <HistoryStrip
      bars={bars}
      onPick={(v) => onPick(v.length === 7 ? `${v}-01` : v, hist.unit)}
      head={
        <>
          <b>{fmt(hist.total)}</b> <span className="muted">in the range · per {hist.unit} · click a bar to zoom to it{hist.cached ? ' · cached' : ` · ${hist.elapsedMs.toLocaleString()} ms`}</span>
        </>
      }
    />
  );
}

export function ReleasesView({ busy, onBusy, onError, onOpenCrate, onOpenUser }: Props) {
  const [kind, setKind] = useState<ReleaseKind>('versions');
  const [source, setSource] = useState<ReleaseSource>('publisher');
  // 30 days: the crates.io index clone painter imports from can lag the registry dump by days,
  // so the newest Version nodes may be a week or two old.
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(isoDay(new Date()));
  const [q, setQ] = useState('');
  const qDebounced = useDebounced(q);
  const [minDownloads, setMinDownloads] = useState(0);
  const [limit, setLimit] = useState(100);
  const { sort, desc, toggle } = useSort<ReleaseSort>('date', 'name');
  const [hist, setHist] = useState<ReleasesHistogram | null>(null);

  const switchKind = (k: ReleaseKind) => {
    setKind(k);
    setSource(SOURCES[k][0].id);
  };

  const query = useMemo(() => ({ kind, source, from, to, q: qDebounced, minDownloads, sort, desc, limit }), [kind, source, from, to, qDebounced, minDownloads, sort, desc, limit]);
  const board = useLeaderboard<ReleaseRow, typeof query>(api.releases, query, onBusy, onError);

  useEffect(() => {
    let cancelled = false;
    setHist(null);
    api
      .releasesHistogram(kind, source, from, to)
      .then((h) => !cancelled && setHist(h))
      .catch((err) => !cancelled && onError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [kind, source, from, to, onError]);

  const preset = (days: number) => {
    setTo(isoDay(new Date()));
    setFrom(daysAgo(days));
  };

  const zoom = (bucket: string, unit: 'day' | 'month') => {
    if (unit === 'day') {
      setFrom(bucket);
      setTo(bucket);
    } else {
      const d = new Date(`${bucket}T00:00:00Z`);
      setFrom(isoDay(d));
      d.setUTCMonth(d.getUTCMonth() + 1);
      d.setUTCDate(0);
      setTo(isoDay(d));
    }
  };

  const copy = () =>
    kind === 'crates'
      ? copyTsv(
          ['crate', 'published', 'publisher', 'downloads', 'versions', 'default_version', 'owners', 'joined_existing'],
          board.rows.map((r) => [r.name, r.at, r.login, r.downloads, r.numVersions, r.defaultVersion, r.owners?.join(' '), r.extra.joined]),
        )
      : copyTsv(
          ['crate', 'version', 'published', 'uploader', 'downloads', 'yanked', 'license', 'crate_size', 'edition', 'rust_version', 'unsafe_total'],
          board.rows.map((r) => [r.name, r.version, r.at, r.login, r.downloads, r.yanked, r.license, r.crateSize, r.edition, r.rustVersion, r.unsafeTotal]),
        );

  const columns = kind === 'crates' ? CRATE_COLUMNS : VERSION_COLUMNS;
  const color = kind === 'crates' ? COLOR_CRATES : COLOR_VERSIONS;

  return (
    <div className="unsafe">
      <div className="unsafe-controls">
        <div className="views" role="group" aria-label="Kind">
          <button className={kind === 'crates' ? 'active' : ''} onClick={() => switchKind('crates')} title="Crates first published, or gaining a publisher, in the range">
            Crates
          </button>
          <button className={kind === 'versions' ? 'active' : ''} onClick={() => switchKind('versions')} title="Versions published in the range">
            Versions
          </button>
        </div>
        <label className="opt">
          by
          <select value={source} onChange={(e) => setSource(e.target.value as ReleaseSource)}>
            {SOURCES[kind].map((s) => (
              <option key={s.id} value={s.id} title={s.title}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="opt">
          from
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label className="opt">
          to
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
        <span className="presets">
          {PRESETS.map((p) => (
            <button key={p.days} onClick={() => preset(p.days)} title={`The last ${p.label}`}>
              {p.label}
            </button>
          ))}
        </span>
        <input type="text" placeholder="Crate name contains…" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} className="q" />
        <label className="opt" title="Only crates / versions with at least this many downloads">
          min downloads
          <input type="number" min={0} step={1000} value={minDownloads} onChange={(e) => setMinDownloads(Math.max(0, Number(e.target.value) || 0))} className="limit wide" />
        </label>
        <RowsSelect value={limit} onChange={setLimit} />
        <span className="spacer" />
        <span className="muted small">
          {board.rows.length.toLocaleString()} rows{board.hasMore ? '+' : ''} · {board.elapsed.toLocaleString()} ms
        </span>
        <button onClick={copy} disabled={!board.rows.length} title="Copy the shown rows as tab-separated text">
          Copy TSV
        </button>
      </div>

      <div className="unsafe-detail pad-x">
        <RangeHistogram hist={hist} color={color} onPick={zoom} />
      </div>

      <div className="unsafe-table">
        <table>
          <thead>
            <tr>
              <th className="rank">#</th>
              <SortHeaders columns={columns} sort={sort} desc={desc} onSort={toggle} />
              {kind === 'crates' ? (
                <>
                  <th title="Uploader whose first upload of the crate this is (new publisher source), else —">publisher</th>
                  <th className="num" title="Versions of the crate">
                    versions
                  </th>
                  <th title="Current owners (up to four)">owners</th>
                  <th>description</th>
                </>
              ) : (
                <>
                  <th title="Uploader, when crates.io recorded one">uploader</th>
                  <th>license</th>
                  <th className="num">size</th>
                  <th>edition</th>
                  <th>msrv</th>
                  <th>flags</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {board.rows.map((r, i) => (
              <tr key={`${r.name}@${r.version ?? ''}@${r.login ?? ''}`} onClick={() => onOpenCrate(r.name)} title={fmtDateTime(r.at)}>
                <td className="rank muted">{i + 1}</td>
                <td className="muted">{fmtDate(r.at)}</td>
                <td className="crate">
                  {r.name}
                  {r.version && <span className="muted">@{r.version}</span>}
                  {r.latest && <span className="badge">latest</span>}
                  {r.yanked && (
                    <span className="flag yanked" title="Yanked on crates.io">
                      yanked
                    </span>
                  )}
                  {r.trustpubOnly && (
                    <span className="badge" title="Trusted publishing only">
                      trustpub
                    </span>
                  )}
                  {kind === 'crates' && source === 'publisher' && r.extra.joined && (
                    <span className="flag joined" title={`Crate created ${fmtDate(r.createdAt)}; this user’s first upload is later: they joined an existing crate`}>
                      joined
                    </span>
                  )}
                </td>
                <td className="num total" title={fmt(r.downloads)}>
                  {fmtCompact(r.downloads)}
                </td>
                {kind === 'crates' ? (
                  <>
                    <td>
                      <UserLink login={r.login} onOpen={onOpenUser} />
                    </td>
                    <td className="num muted">{fmt(r.numVersions)}</td>
                    <td>
                      {(r.owners ?? []).map((o, j) => (
                        <span key={o}>
                          {j ? ', ' : ''}
                          <UserLink login={o} onOpen={onOpenUser} />
                        </span>
                      ))}
                      {(r.ownerCount ?? 0) > (r.owners?.length ?? 0) && <span className="muted small"> +{(r.ownerCount ?? 0) - (r.owners?.length ?? 0)}</span>}
                    </td>
                    <td className="muted desc">{r.description ?? ''}</td>
                  </>
                ) : (
                  <>
                    <td>
                      <UserLink login={r.login} onOpen={onOpenUser} />
                    </td>
                    <td className="muted">{r.license ?? '—'}</td>
                    <td className="num muted">{fmtBytes(r.crateSize)}</td>
                    <td className="muted">{r.edition ?? '—'}</td>
                    <td className="muted">{r.rustVersion ?? '—'}</td>
                    <td className="flags">
                      {(r.unsafeTotal ?? 0) > 0 && (
                        <span className="flag unsafe" title="Unsafe items">
                          ☢{fmt(r.unsafeTotal)}
                        </span>
                      )}
                      <NativeFlags native={r.hasNativeCode} vendored={r.vendoredNative} build={r.hasBuildScript} />
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {board.rows.length === 0 && !busy && <p className="muted pad">Nothing published in this range matches the filters.</p>}
        <LoadMore hasMore={board.hasMore} busy={busy} limit={limit} onClick={board.loadMore} />
      </div>
    </div>
  );
}
