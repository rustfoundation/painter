// Nothing precomputed: each board is one index-backed query bounded by N or the OWNS.since range.

import { useMemo, useState } from 'react';
import { api, type BusFactorRow, type NewUploaderRow, type OwnerAdditionRow } from '../api';
import { copyTsv, daysAgo, fmt, fmtCompact, fmtDate, fmtDateTime, LoadMore, RowsSelect, UserLink, useLeaderboard } from './meta';

interface Props {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onOpenCrate: (name: string) => void;
  onOpenUser: (login: string) => void;
}

type Signal = 'bus' | 'additions' | 'uploaders';

const SIGNALS: { id: Signal; label: string; title: string }[] = [
  { id: 'bus', label: 'Single-owner crates', title: 'Popular crates owned by exactly one user and no team: one account between the ecosystem and a takeover' },
  { id: 'additions', label: 'Recent owner additions', title: 'Owners added recently to popular crates by someone other than themselves' },
  { id: 'uploaders', label: 'New uploader shipped latest', title: 'Popular crates whose latest version was uploaded by someone who had never uploaded the crate before' },
];

const TOP_OPTIONS = [500, 1000, 2000, 5000, 10000, 20000];

/** Resolves to an empty page: keeps an inactive board's hook mounted without a request. */
const inert = () => Promise.resolve({ rows: [], hasMore: false, meta: { elapsedMs: 0 } });

const dl = (n: number | null | undefined) => (
  <td className="num total" title={fmt(n)}>
    {fmtCompact(n)}
  </td>
);

export function SupplyView({ busy, onBusy, onError, onOpenCrate, onOpenUser }: Props) {
  const [signal, setSignal] = useState<Signal>('bus');
  const [top, setTop] = useState(2000);
  const [since, setSince] = useState(daysAgo(180));
  const [minDownloads, setMinDownloads] = useState(100_000);
  const [self, setSelf] = useState<'exclude' | 'include'>('exclude');
  const [limit, setLimit] = useState(100);

  const busQuery = useMemo(() => ({ top, limit }), [top, limit]);
  const addQuery = useMemo(() => ({ since, minDownloads, self, limit }), [since, minDownloads, self, limit]);
  const upQuery = useMemo(() => ({ top, limit }), [top, limit]);
  const bus = useLeaderboard<BusFactorRow, typeof busQuery>(signal === 'bus' ? api.busFactor : inert, busQuery, onBusy, onError);
  const additions = useLeaderboard<OwnerAdditionRow, typeof addQuery>(signal === 'additions' ? api.ownerAdditions : inert, addQuery, onBusy, onError);
  const uploaders = useLeaderboard<NewUploaderRow, typeof upQuery>(signal === 'uploaders' ? api.newUploaders : inert, upQuery, onBusy, onError);

  const active = signal === 'bus' ? bus : signal === 'additions' ? additions : uploaders;

  const copy = () => {
    if (signal === 'bus')
      copyTsv(
        ['crate', 'downloads', 'owner', 'owner_since', 'added_by', 'owner_crates', 'publishers', 'latest', 'latest_at', 'degree', 'trustpub_only'],
        bus.rows.map((r) => [r.name, r.downloads, r.login, r.since, r.addedBy, r.ownerCrates, r.publishers, r.latestVersion, r.latestAt, r.degree, r.trustpubOnly]),
      );
    else if (signal === 'additions')
      copyTsv(
        ['crate', 'downloads', 'owner', 'kind', 'added_by', 'since', 'owners', 'has_published', 'owner_published_crates', 'owner_account_since'],
        additions.rows.map((r) => [r.name, r.downloads, r.login, r.kind, r.addedBy, r.since, r.owners, r.hasPublished, r.ownerPublished, r.ownerCreatedAt]),
      );
    else
      copyTsv(
        ['crate', 'downloads', 'version', 'uploaded', 'uploader', 'is_owner', 'uploader_crates', 'uploader_account_since', 'publishers', 'owners'],
        uploaders.rows.map((r) => [r.name, r.downloads, r.version, r.at, r.login, r.owner, r.uploaderCrates, r.uploaderCreatedAt, r.publishers, r.owners.join(' ')]),
      );
  };

  return (
    <div className="unsafe">
      <div className="unsafe-controls">
        <div className="views" role="group" aria-label="Signal">
          {SIGNALS.map((s) => (
            <button key={s.id} className={signal === s.id ? 'active' : ''} title={s.title} onClick={() => setSignal(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        {signal !== 'additions' ? (
          <label className="opt" title="How many of the most-downloaded crates to inspect (Crate.downloads index)">
            top crates
            <select value={top} onChange={(e) => setTop(Number(e.target.value))}>
              {TOP_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="opt" title="Owners added on or after this date (OWNS.since index)">
              since
              <input type="date" value={since} onChange={(e) => e.target.value && setSince(e.target.value)} />
            </label>
            <label className="opt" title="Only crates with at least this many downloads">
              min downloads
              <input type="number" min={0} step={10000} value={minDownloads} onChange={(e) => setMinDownloads(Math.max(0, Number(e.target.value) || 0))} className="limit wide" />
            </label>
            <label className="opt" title="Whether to include owners who added themselves (the crate's creator)">
              self-added
              <select value={self} onChange={(e) => setSelf(e.target.value as 'exclude' | 'include')}>
                <option value="exclude">exclude</option>
                <option value="include">include</option>
              </select>
            </label>
          </>
        )}
        <RowsSelect value={limit} onChange={setLimit} />
        <span className="spacer" />
        <span className="muted small">
          {active.rows.length.toLocaleString()} rows{active.hasMore ? '+' : ''} · {active.elapsed.toLocaleString()} ms
        </span>
        <button onClick={copy} disabled={!active.rows.length} title="Copy the shown rows as tab-separated text">
          Copy TSV
        </button>
      </div>

      <p className="muted small pad-x explain">{SIGNALS.find((s) => s.id === signal)?.title}. Rows are ordered by crate downloads. Click a crate to open it in the graph, a login to open the publisher.</p>

      <div className="unsafe-table">
        {signal === 'bus' && (
          <table>
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>crate</th>
                <th className="num">downloads</th>
                <th className="num" title="Crate-level dependency degree from the Map precompute (dependents + dependencies), when built">
                  degree
                </th>
                <th>sole owner</th>
                <th title="When they became the owner">owner since</th>
                <th title="Who added the ownership (themselves = the crate's creator)">added by</th>
                <th className="num" title="Other crates this account owns">
                  owns
                </th>
                <th className="num" title="Distinct users who ever uploaded a version">
                  publishers
                </th>
                <th>latest</th>
                <th>last release</th>
              </tr>
            </thead>
            <tbody>
              {bus.rows.map((r, i) => (
                <tr key={r.name} onClick={() => onOpenCrate(r.name)} title={r.repository ?? undefined}>
                  <td className="rank muted">{i + 1}</td>
                  <td className="crate">
                    {r.name}
                    {r.trustpubOnly && (
                      <span className="badge" title="Trusted publishing only: uploads need the configured CI identity, not just the owner account">
                        trustpub
                      </span>
                    )}
                  </td>
                  {dl(r.downloads)}
                  <td className="num muted">{fmt(r.degree)}</td>
                  <td>
                    <UserLink login={r.login} name={r.ownerName} onOpen={onOpenUser} />
                  </td>
                  <td className="muted">{fmtDate(r.since)}</td>
                  <td>{r.addedBy === r.login ? <span className="muted">self</span> : <UserLink login={r.addedBy} onOpen={onOpenUser} />}</td>
                  <td className="num muted">{fmt(r.ownerCrates)}</td>
                  <td className={`num ${r.publishers > 1 ? '' : 'muted'}`}>{fmt(r.publishers)}</td>
                  <td className="muted">
                    {r.latestVersion ?? '—'}
                    {r.yanked && <span className="flag yanked">yanked</span>}
                  </td>
                  <td className="muted">{fmtDate(r.latestAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {signal === 'additions' && (
          <table>
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>crate</th>
                <th className="num">downloads</th>
                <th>new owner</th>
                <th>added by</th>
                <th>since</th>
                <th className="num" title="Owners of the crate now">
                  owners
                </th>
                <th title="Whether the new owner has uploaded a version of the crate">uploaded it</th>
                <th className="num" title="Crates the new owner has published (users)">
                  publishes
                </th>
                <th title="GitHub account age of the new owner (users)">account since</th>
              </tr>
            </thead>
            <tbody>
              {additions.rows.map((r, i) => (
                <tr key={`${r.name}:${r.login}`} onClick={() => onOpenCrate(r.name)} title={fmtDateTime(r.since)}>
                  <td className="rank muted">{i + 1}</td>
                  <td className="crate">{r.name}</td>
                  {dl(r.downloads)}
                  <td>
                    <UserLink login={r.login} name={r.ownerName} onOpen={onOpenUser} />
                    {r.kind === 'Team' && <span className="badge">team</span>}
                  </td>
                  <td>
                    <UserLink login={r.addedBy} onOpen={onOpenUser} />
                  </td>
                  <td className="muted">{fmtDate(r.since)}</td>
                  <td className={`num ${r.owners === 1 ? 'warn' : ''}`}>{fmt(r.owners)}</td>
                  <td className={r.hasPublished ? '' : 'muted'}>{r.kind === 'Team' ? '—' : r.hasPublished ? 'yes' : 'no'}</td>
                  <td className="num muted">{fmt(r.ownerPublished)}</td>
                  <td className="muted">{fmtDate(r.ownerCreatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {signal === 'uploaders' && (
          <table>
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>crate / latest</th>
                <th className="num">downloads</th>
                <th>uploaded</th>
                <th title="Uploader of the latest version; this is their only upload of the crate">first-time uploader</th>
                <th title="Whether the uploader is a current owner">owner</th>
                <th className="num" title="Crates the uploader has published">
                  publishes
                </th>
                <th title="GitHub account age of the uploader">account since</th>
                <th className="num" title="Distinct users who ever uploaded the crate">
                  publishers
                </th>
                <th>owners</th>
              </tr>
            </thead>
            <tbody>
              {uploaders.rows.map((r, i) => (
                <tr key={r.name} onClick={() => onOpenCrate(r.name)} title={fmtDateTime(r.at)}>
                  <td className="rank muted">{i + 1}</td>
                  <td className="crate">
                    {r.name}
                    <span className="muted">@{r.version}</span>
                    {r.yanked && <span className="flag yanked">yanked</span>}
                  </td>
                  {dl(r.downloads)}
                  <td className="muted">{fmtDate(r.at)}</td>
                  <td>
                    <UserLink login={r.login} name={r.uploaderName} onOpen={onOpenUser} />
                  </td>
                  <td className={r.owner ? 'muted' : 'warn'}>{r.owner ? 'yes' : 'no'}</td>
                  <td className="num muted">{fmt(r.uploaderCrates)}</td>
                  <td className="muted">{fmtDate(r.uploaderCreatedAt)}</td>
                  <td className="num muted">{fmt(r.publishers)}</td>
                  <td>
                    {r.owners.map((o, j) => (
                      <span key={o}>
                        {j ? ', ' : ''}
                        <UserLink login={o} onOpen={onOpenUser} />
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {active.rows.length === 0 && !busy && <p className="muted pad">No rows.</p>}
        <LoadMore hasMore={active.hasMore} busy={busy} limit={limit} onClick={active.loadMore} />
      </div>
    </div>
  );
}
