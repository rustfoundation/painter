// Publishers view: crates.io users and teams from the registry job. Without a login
// selected it shows registry coverage and four leaderboards (most crates published,
// most uploads, owners and publishers of the most-downloaded crates); a login opens the
// publisher page: totals, an upload timeline, and every crate they published or own.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type PublisherCrate, type PublisherLeaderboards, type PublisherProfile, type RegistryStats, type UserHit } from '../api';
import { NativeFlags } from './BuildView';
import { copyTsv, errorMessage, fmt, fmtCompact, fmtDate, HistoryStrip, pct, SortHeaders, Tile, UserLink, useSort, type Column, type HistoryBar } from './meta';

interface Props {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onOpenCrate: (name: string) => void;
  onOpenUser: (login: string) => void;
  /** Login to open, set by other views (details panel, leaderboards). */
  target: { login: string; nonce: number } | null;
}

const COLOR_USER = '#E36BAE';
const COLOR_TEAM = '#20B2AA';
const COLOR_UPLOADS = '#C9A227';

type Board = 'byCrates' | 'byUploads' | 'owners' | 'publishers';
const BOARDS: { id: Board; label: string; title: string }[] = [
  { id: 'byCrates', label: 'Most crates published', title: 'Users by distinct crates they uploaded at least one version of' },
  { id: 'byUploads', label: 'Most uploads', title: 'Users by versions uploaded (crates.io records the uploader since 2017)' },
  { id: 'owners', label: 'Owners of top crates', title: 'Owners (users and teams) of the most-downloaded crates, by the downloads of the crates they own' },
  { id: 'publishers', label: 'Publishers of top crates', title: 'Users who uploaded versions of the most-downloaded crates, by those crates’ downloads' },
];

type CrateSort = 'name' | 'role' | 'downloads' | 'numVersions' | 'first' | 'last' | 'uploads' | 'since' | 'addedBy' | 'owners' | 'latestVersion';
type Role = 'all' | 'published' | 'owned' | 'both' | 'ownedOnly' | 'publishedOnly';

const CRATE_COLUMNS: Column<CrateSort>[] = [
  { key: 'name', label: 'crate', title: 'Sort by name' },
  { key: 'role', label: 'role', title: 'publisher = uploaded versions of it; owner = current crates.io owner' },
  { key: 'downloads', label: 'downloads', title: 'All-time crates.io downloads of the crate', num: true },
  { key: 'numVersions', label: 'versions', title: 'Versions of the crate', num: true },
  { key: 'uploads', label: 'uploads', title: 'Versions this user uploaded', num: true },
  { key: 'first', label: 'first upload', title: 'This user’s first upload of the crate' },
  { key: 'last', label: 'last upload', title: 'This user’s most recent upload of the crate' },
  { key: 'since', label: 'owner since', title: 'When this user / team became an owner' },
  { key: 'addedBy', label: 'added by', title: 'Login that added the ownership' },
  { key: 'owners', label: 'owners', title: 'Current owners of the crate (1 = sole owner)', num: true },
  { key: 'latestVersion', label: 'latest', title: 'Latest version (set-latest-versions) and its metadata badges' },
];

const roleOf = (c: PublisherCrate) => (c.published && c.owns ? 'both' : c.published ? 'publisher' : 'owner');

const sortValue = (c: PublisherCrate, key: CrateSort): string | number => {
  switch (key) {
    case 'name':
      return c.name;
    case 'role':
      return roleOf(c);
    case 'downloads':
      return c.downloads ?? -1;
    case 'numVersions':
      return c.numVersions ?? -1;
    case 'uploads':
      return c.published?.versions ?? -1;
    case 'first':
      return c.published?.first ?? '';
    case 'last':
      return c.published?.last ?? '';
    case 'since':
      return c.owns?.since ?? '';
    case 'addedBy':
      return c.owns?.addedBy ?? '';
    case 'owners':
      return c.owners;
    case 'latestVersion':
      return c.latestVersion ?? '';
  }
};

/** Uploads per month (or year), gaps filled, as the shared history strip. */
function Timeline({ timeline, byYear }: { timeline: PublisherProfile['timeline']; byYear: boolean }) {
  const bars = useMemo<HistoryBar[]>(() => {
    if (!timeline.length) return [];
    const counts = new Map<string, number>();
    for (const t of timeline) {
      const key = byYear ? String(t.year) : `${t.year}-${String(t.month).padStart(2, '0')}`;
      counts.set(key, (counts.get(key) ?? 0) + t.uploads);
    }
    const first = timeline[0];
    const last = timeline[timeline.length - 1];
    const keys: string[] = [];
    if (byYear) for (let y = first.year; y <= last.year; y += 1) keys.push(String(y));
    else {
      for (let y = first.year, m = first.month; y < last.year || (y === last.year && m <= last.month); ) {
        keys.push(`${y}-${String(m).padStart(2, '0')}`);
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
    }
    const max = Math.max(1, ...counts.values());
    return keys.map((k) => {
      const n = counts.get(k) ?? 0;
      return { version: k, latest: false, height: n / max, segments: [[COLOR_UPLOADS, 1]], title: `${k}: ${fmt(n)} upload${n === 1 ? '' : 's'}` };
    });
  }, [timeline, byYear]);
  if (!bars.length) return <p className="muted">No uploads with a recorded uploader (crates.io records uploaders since 2017; teams never upload).</p>;
  return (
    <HistoryStrip
      bars={bars}
      head={
        <>
          <b>Upload timeline</b>
          <span className="muted"> · versions uploaded per {byYear ? 'year' : 'month'}, {bars[0].version} to {bars[bars.length - 1].version}</span>
        </>
      }
    />
  );
}

function Leaderboard({ board, data, onOpenUser, onOpenCrate }: { board: Board; data: PublisherLeaderboards; onOpenUser: (l: string) => void; onOpenCrate: (n: string) => void }) {
  const sample = (names: string[]) => (
    <span className="muted small">
      {names.map((n, i) => (
        <span key={n}>
          {i ? ', ' : ''}
          <a
            className="link-name"
            onClick={(e) => {
              e.stopPropagation();
              onOpenCrate(n);
            }}
            title="Open this crate in the Default graph view"
          >
            {n}
          </a>
        </span>
      ))}
    </span>
  );
  if (board === 'byCrates' || board === 'byUploads') {
    const rows = data[board];
    return (
      <table>
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>login</th>
            <th>name</th>
            <th className="num">crates</th>
            <th className="num">uploads</th>
            <th>first upload</th>
            <th>last upload</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.login} onClick={() => onOpenUser(r.login)} title="Open this publisher">
              <td className="rank muted">{i + 1}</td>
              <td className="crate">
                <UserLink login={r.login} onOpen={onOpenUser} />
              </td>
              <td className="muted">{r.name ?? '—'}</td>
              <td className={`num ${board === 'byCrates' ? 'total' : ''}`}>{fmt(r.crates)}</td>
              <td className={`num ${board === 'byUploads' ? 'total' : ''}`}>{fmt(r.uploads)}</td>
              <td className="muted">{fmtDate(r.first)}</td>
              <td className="muted">{fmtDate(r.last)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (board === 'owners') {
    return (
      <table>
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>owner</th>
            <th>name</th>
            <th className="num" title="Owned crates among the top crates by downloads">
              crates
            </th>
            <th className="num" title="Of those, crates where this is the only owner">
              sole owner
            </th>
            <th className="num" title="Downloads of the owned top crates, summed">
              downloads
            </th>
            <th>e.g.</th>
          </tr>
        </thead>
        <tbody>
          {data.owners.map((r, i) => (
            <tr key={r.login} onClick={() => onOpenUser(r.login)} title="Open this owner">
              <td className="rank muted">{i + 1}</td>
              <td className="crate">
                <span className="swatch" style={{ background: r.kind === 'Team' ? COLOR_TEAM : COLOR_USER }} /> <UserLink login={r.login} onOpen={onOpenUser} />
                {r.kind === 'Team' && <span className="badge">team</span>}
              </td>
              <td className="muted">{r.name ?? '—'}</td>
              <td className="num">{fmt(r.crates)}</td>
              <td className={`num ${r.sole ? '' : 'muted'}`}>{fmt(r.sole)}</td>
              <td className="num total" title={fmt(r.downloads)}>
                {fmtCompact(r.downloads)}
              </td>
              <td>{sample(r.sample)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table>
      <thead>
        <tr>
          <th className="rank">#</th>
          <th>login</th>
          <th>name</th>
          <th className="num" title="Top crates they uploaded versions of">
            crates
          </th>
          <th className="num" title="Versions uploaded of those crates">
            uploads
          </th>
          <th className="num" title="Downloads of those crates, summed">
            downloads
          </th>
          <th>e.g.</th>
        </tr>
      </thead>
      <tbody>
        {data.publishers.map((r, i) => (
          <tr key={r.login} onClick={() => onOpenUser(r.login)} title="Open this publisher">
            <td className="rank muted">{i + 1}</td>
            <td className="crate">
              <UserLink login={r.login} onOpen={onOpenUser} />
            </td>
            <td className="muted">{r.name ?? '—'}</td>
            <td className="num">{fmt(r.crates)}</td>
            <td className="num">{fmt(r.uploads)}</td>
            <td className="num total" title={fmt(r.downloads)}>
              {fmtCompact(r.downloads)}
            </td>
            <td>{sample(r.sample)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PublishersView({ busy, onBusy, onError, onOpenCrate, onOpenUser, target }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ users: UserHit[]; teams: UserHit[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState<string | null>(null);
  const [profile, setProfile] = useState<PublisherProfile | null>(null);
  const [stats, setStats] = useState<RegistryStats | null>(null);
  const [boards, setBoards] = useState<PublisherLeaderboards | null>(null);
  const [board, setBoard] = useState<Board>('byCrates');
  const [byYear, setByYear] = useState(false);
  const [role, setRole] = useState<Role>('all');
  const [filter, setFilter] = useState('');
  const { sort, desc, toggle } = useSort<CrateSort>('downloads', 'name');
  const debounce = useRef<number | undefined>(undefined);

  // Coverage and leaderboards once (both cached server-side).
  useEffect(() => {
    let cancelled = false;
    api.registryStats().then((s) => !cancelled && setStats(s)).catch((err) => !cancelled && onError(errorMessage(err)));
    api.publisherLeaderboards().then((b) => !cancelled && setBoards(b)).catch((err) => !cancelled && onError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [onError]);

  // Login suggestions.
  useEffect(() => {
    window.clearTimeout(debounce.current);
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    debounce.current = window.setTimeout(() => {
      api.searchUsers(q).then(setHits).catch(() => setHits(null));
    }, 150);
    return () => window.clearTimeout(debounce.current);
  }, [query]);

  const load = useCallback(
    async (who: string) => {
      const l = who.trim();
      if (!l) return;
      setOpen(false);
      setQuery(l);
      setLogin(l);
      onBusy(true);
      onError(null);
      try {
        setProfile(await api.publisher(l));
      } catch (err) {
        setProfile(null);
        onError(errorMessage(err));
      } finally {
        onBusy(false);
      }
    },
    [onBusy, onError],
  );

  useEffect(() => {
    if (target) void load(target.login);
  }, [target, load]);

  const crates = useMemo(() => {
    if (!profile) return [];
    const f = filter.trim().toLowerCase();
    const rows = profile.crates.filter((c) => {
      if (f && !c.name.toLowerCase().includes(f)) return false;
      switch (role) {
        case 'published':
          return Boolean(c.published);
        case 'owned':
          return Boolean(c.owns);
        case 'both':
          return Boolean(c.published && c.owns);
        case 'ownedOnly':
          return Boolean(c.owns && !c.published);
        case 'publishedOnly':
          return Boolean(c.published && !c.owns);
        default:
          return true;
      }
    });
    rows.sort((a, b) => {
      const x = sortValue(a, sort);
      const y = sortValue(b, sort);
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return (desc ? -cmp : cmp) || a.name.localeCompare(b.name);
    });
    return rows;
  }, [profile, filter, role, sort, desc]);

  const copy = () =>
    copyTsv(
      ['crate', 'role', 'downloads', 'versions', 'uploads', 'first_upload', 'last_upload', 'owner_since', 'added_by', 'owners', 'latest', 'yanked', 'unsafe_total'],
      crates.map((c) => [
        c.name,
        roleOf(c),
        c.downloads,
        c.numVersions,
        c.published?.versions,
        c.published?.first,
        c.published?.last,
        c.owns?.since,
        c.owns?.addedBy,
        c.owners,
        c.latestVersion,
        c.yanked,
        c.unsafeTotal,
      ]),
    );

  const t = profile?.totals;
  const suggestions = hits ? [...hits.users, ...hits.teams] : [];

  return (
    <div className="unsafe">
      <div className="unsafe-controls">
        <div className="search">
          <input
            type="text"
            placeholder="crates.io login… (e.g. dtolnay, github:tokio-rs:core)"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(query);
              if (e.key === 'Escape') setOpen(false);
            }}
            spellCheck={false}
            className="q"
          />
          {open && suggestions.length > 0 && (
            <ul className="suggestions">
              {suggestions.map((s) => (
                <li key={s.login} onMouseDown={() => void load(s.login)}>
                  {s.login}
                  <span className="muted small">
                    {' '}
                    {s.name ? `${s.name} · ` : ''}
                    {s.crates ? `${fmt(s.crates)} published · ` : ''}
                    {fmt(s.owns)} owned
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className="primary" disabled={busy || !query.trim()} onClick={() => void load(query)}>
          {busy ? 'Loading…' : 'Open'}
        </button>
        {login && (
          <button
            onClick={() => {
              setLogin(null);
              setProfile(null);
              setQuery('');
            }}
            title="Back to the leaderboards"
          >
            Leaderboards
          </button>
        )}
        <span className="spacer" />
        {profile && (
          <>
            <span className="muted small">
              {fmt(crates.length)} of {fmt(profile.crates.length)} crates · {profile.meta.elapsedMs.toLocaleString()} ms
              {t?.truncated ? ' · list capped at 5,000' : ''}
            </span>
            <button onClick={copy} disabled={!crates.length} title="Copy the shown rows as tab-separated text">
              Copy TSV
            </button>
          </>
        )}
      </div>

      {!login && (
        <>
          <div className="unsafe-tiles">
            <div className="tile wide" title="Crates and versions the registry job has matched against the crates.io dump">
              <div className="tile-label">registry coverage · {stats?.dump ? stats.dump.replace(/^registry-\d+@/, '').slice(0, 10) : '…'} dump</div>
              <div className="tile-value">
                {pct(stats?.versionsInRegistry, stats?.versions)} <span className="muted small">{fmt(stats?.versionsInRegistry)} of {fmt(stats?.versions)} versions</span>
              </div>
              <div className="meter">
                <span style={{ width: stats ? `${(100 * stats.versionsInRegistry) / Math.max(1, stats.versions)}%` : 0 }} />
              </div>
              <div className="muted small">
                {fmt(stats?.cratesInRegistry)} of {fmt(stats?.crates)} crates · {fmt(stats?.versionsMissing)} versions not in the dump · {fmt(stats?.versionUploads)} uploads with a recorded uploader
              </div>
            </div>
            <Tile label="users" value={fmt(stats?.users)} note="referenced as owner or uploader" color={COLOR_USER} />
            <Tile label="teams" value={fmt(stats?.teams)} note="GitHub teams owning crates" color={COLOR_TEAM} />
            <Tile label="ownerships" value={fmt(stats?.owns)} note={`${fmt(stats?.cratesWithoutOwner)} crates with no owner`} title="OWNS edges: current (user or team, crate) pairs" />
            <Tile label="publisher pairs" value={fmt(stats?.cratePublishers)} note="distinct (user, crate)" title="PUBLISHED->Crate edges" color={COLOR_UPLOADS} />
            <Tile label="yanked" value={pct(stats?.latestYanked, stats?.latestVersions)} note={`${fmt(stats?.latestYanked)} latest · ${fmt(stats?.yanked)} overall`} title="Versions yanked on crates.io" />
            <Tile label="trusted publishing only" value={fmt(stats?.trustpubOnly)} note="crates" title="Crate.trustpub_only: uploads only through trusted publishing" />
            <Tile label="categories · keywords" value={`${fmt(stats?.categories)} · ${fmt(stats?.keywords)}`} />
          </div>
          <div className="unsafe-controls">
            {BOARDS.map((b) => (
              <button key={b.id} className={board === b.id ? 'active' : ''} title={b.title} onClick={() => setBoard(b.id)}>
                {b.label}
              </button>
            ))}
            <span className="spacer" />
            <span className="muted small">
              {boards ? `top 100 · download boards over the top ${fmt(boards.topCrates)} crates by downloads · ${boards.elapsedMs.toLocaleString()} ms${boards.cached ? ' (cached)' : ''}` : 'loading leaderboards…'}
            </span>
          </div>
          <div className="unsafe-table">
            {boards ? <Leaderboard board={board} data={boards} onOpenUser={(l) => void load(l)} onOpenCrate={onOpenCrate} /> : <p className="muted pad">Loading…</p>}
          </div>
        </>
      )}

      {login && profile && t && (
        <>
          <div className="unsafe-tiles">
            <div className="tile wide" title={`crates.io ${profile.kind.toLowerCase()} ${profile.login}`}>
              <div className="tile-label">
                <span className="swatch" style={{ background: profile.kind === 'Team' ? COLOR_TEAM : COLOR_USER }} /> {profile.kind.toLowerCase()} · id {profile.id}
              </div>
              <div className="tile-value">
                {profile.login} <span className="muted small">{profile.name ?? ''}</span>
              </div>
              <div className="muted small">
                {profile.kind === 'User' ? (
                  <>
                    <a href={`https://github.com/${profile.login}`} target="_blank" rel="noreferrer">
                      github.com/{profile.login}
                    </a>
                    {' · '}
                    <a href={`https://crates.io/users/${profile.login}`} target="_blank" rel="noreferrer">
                      crates.io
                    </a>
                    {profile.createdAt ? ` · GitHub account since ${fmtDate(profile.createdAt)}` : ''}
                  </>
                ) : (
                  <a href={`https://crates.io/teams/${profile.login}`} target="_blank" rel="noreferrer">
                    crates.io team
                  </a>
                )}
              </div>
            </div>
            <Tile label="crates published" value={fmt(t.published)} note={`${fmtCompact(t.publishedDownloads)} downloads`} title="Crates with at least one upload by this user" color={COLOR_UPLOADS} onClick={() => setRole(role === 'published' ? 'all' : 'published')} active={role === 'published'} />
            <Tile label="uploads" value={fmt(t.uploads)} note={t.firstUpload ? `${fmtDate(t.firstUpload)} → ${fmtDate(t.lastUpload)}` : 'none recorded'} title="Versions uploaded (since crates.io records uploaders, 2017)" />
            <Tile label="crates owned" value={fmt(t.owned)} note={`${fmt(t.soleOwner)} as sole owner`} title="Current ownerships" color={profile.kind === 'Team' ? COLOR_TEAM : COLOR_USER} onClick={() => setRole(role === 'owned' ? 'all' : 'owned')} active={role === 'owned'} />
            <Tile label="downloads of owned crates" value={fmtCompact(t.ownedDownloads)} note={fmt(t.ownedDownloads)} title="All-time crates.io downloads of the crates they own, summed" />
            <Tile label="latest versions with unsafe" value={pct(t.unsafe, t.withLatest)} note={`${fmt(t.unsafe)} of ${fmt(t.withLatest)}`} title="Latest versions of their crates (published or owned) with any unsafe code (unsafe scanner)" color="#E5484D" />
            <Tile label="build scripts · native" value={`${fmt(t.buildScripts)} · ${fmt(t.native)}`} note="latest versions" title="Latest versions with a build script / with native code" color="#F5A623" />
            <Tile label="yanked latest" value={fmt(t.yanked)} note="crates whose latest version is yanked" />
          </div>
          <div className="unsafe-detail pad-x">
            <div className="unsafe-detail-actions">
              <label className="opt">
                <input type="checkbox" checked={byYear} onChange={(e) => setByYear(e.target.checked)} /> by year
              </label>
            </div>
            <Timeline timeline={profile.timeline} byYear={byYear} />
          </div>
          <div className="unsafe-controls">
            <input type="text" placeholder="Crate name contains…" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} className="q" />
            <label className="opt">
              role
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="all">any</option>
                <option value="published">publisher</option>
                <option value="owned">owner</option>
                <option value="both">publisher and owner</option>
                <option value="publishedOnly">publisher, not owner</option>
                <option value="ownedOnly">owner, never uploaded</option>
              </select>
            </label>
          </div>
          <div className="unsafe-table">
            <table>
              <thead>
                <tr>
                  <th className="rank">#</th>
                  <SortHeaders columns={CRATE_COLUMNS} sort={sort} desc={desc} onSort={toggle} />
                  <th>flags</th>
                </tr>
              </thead>
              <tbody>
                {crates.map((c, i) => (
                  <tr key={c.name} onClick={() => onOpenCrate(c.name)} title={c.description ?? 'Open this crate in the Default graph view'}>
                    <td className="rank muted">{i + 1}</td>
                    <td className="crate">
                      {c.name}
                      {c.trustpubOnly && (
                        <span className="badge" title="Trusted publishing only">
                          trustpub
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`flag role-${roleOf(c)}`}>{roleOf(c)}</span>
                    </td>
                    <td className="num total" title={fmt(c.downloads)}>
                      {fmtCompact(c.downloads)}
                    </td>
                    <td className="num muted">{fmt(c.numVersions)}</td>
                    <td className={`num ${c.published ? '' : 'muted'}`}>{c.published ? fmt(c.published.versions) : '—'}</td>
                    <td className="muted">{fmtDate(c.published?.first)}</td>
                    <td className="muted">{fmtDate(c.published?.last)}</td>
                    <td className="muted">{fmtDate(c.owns?.since)}</td>
                    <td>{c.owns ? <UserLink login={c.owns.addedBy} onOpen={onOpenUser} /> : <span className="muted">—</span>}</td>
                    <td className={`num ${c.owners === 1 ? 'warn' : ''}`} title={c.owners === 1 ? 'Sole owner' : undefined}>
                      {fmt(c.owners)}
                    </td>
                    <td className="muted">
                      {c.latestVersion ?? '—'}
                      {c.yanked && (
                        <span className="flag yanked" title="Latest version is yanked">
                          yanked
                        </span>
                      )}
                    </td>
                    <td className="flags">
                      {(c.unsafeTotal ?? 0) > 0 && (
                        <span className="flag unsafe" title="Unsafe items in the latest version">
                          ☢{fmt(c.unsafeTotal)}
                        </span>
                      )}
                      <NativeFlags native={c.hasNativeCode} vendored={c.vendoredNative} build={c.hasBuildScript} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {crates.length === 0 && !busy && <p className="muted pad">No crates match.</p>}
          </div>
        </>
      )}
      {login && !profile && !busy && <p className="muted pad">No user or team with login “{login}”.</p>}
    </div>
  );
}
