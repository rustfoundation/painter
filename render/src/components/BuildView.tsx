// Build scripts view: a leaderboard of crate versions with a build script (painter's
// generate-metadata `build` job: has_build_script, build_script path, build_script_lines,
// links), coverage tiles, the most-linked native libraries, and a per-crate history.

import { Fragment, useMemo, useState } from 'react';
import { api, type BuildRow, type BuildSort, type BuildStats, type UnsafeScope, type UnsafeTri } from '../api';
import {
  copyTsv,
  CoverageTile,
  fmt,
  HistTile,
  HistoryStrip,
  LoadMore,
  pct,
  RowsSelect,
  ScopeSelect,
  SortHeaders,
  Tile,
  TriSelect,
  useCrateHistory,
  useDebounced,
  useLeaderboard,
  useSort,
  useStats,
  type Column,
  type HistoryBar,
} from './meta';

interface Props {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onOpenCrate: (name: string) => void;
}

const COLOR_SCRIPT = '#F5A623';
const COLOR_LINKS = '#B88BFF';

const COLUMNS: Column<BuildSort>[] = [
  { key: 'name', label: 'crate / version', title: 'Sort by name' },
  { key: 'path', label: 'script', title: 'Path of the build script (package.build, default build.rs)' },
  { key: 'lines', label: 'lines', title: 'Lines in the build script', num: true },
  { key: 'links', label: 'links', title: 'package.links: the native library the script claims to link' },
  { key: 'rsLines', label: 'rust lines', title: 'Lines of Rust in the crate (unsafe scanner)', num: true },
  { key: 'unsafe', label: 'unsafe', title: 'Unsafe items in the crate (unsafe scanner)', num: true },
];

const HIST_LABELS = ['0–10', '11–50', '51–200', '201–1k', '>1k'];

/** Native-code flags shared with the other views. */
export function NativeFlags({ native, vendored, links, build }: { native?: boolean | null; vendored?: boolean | null; links?: string | null; build?: boolean | null }) {
  return (
    <>
      {build && (
        <span className="flag build" title="Has a build script">
          build.rs
        </span>
      )}
      {links && (
        <span className="flag links" title={`package.links = ${links}`}>
          links {links}
        </span>
      )}
      {vendored ? (
        <span className="flag vendored" title="Enough native code to be a vendored library (see the Native code view)">
          vendored
        </span>
      ) : native ? (
        <span className="flag native" title="Ships some C / C++ / Objective-C / assembly">
          native
        </span>
      ) : null}
    </>
  );
}

const describe = (v: BuildRow) =>
  v.error
    ? `${v.version}: ${v.error}`
    : !v.revision
      ? `${v.version}: not scanned`
      : v.hasBuildScript
        ? `${v.version}: ${v.path ?? 'build.rs'}, ${fmt(v.lines)} lines${v.links ? `, links ${v.links}` : ''}`
        : `${v.version}: no build script`;

function BuildHistory({ name, versions, onPick }: { name: string; versions: BuildRow[]; onPick: (v: BuildRow) => void }) {
  const max = Math.max(1, ...versions.map((v) => v.lines ?? 0));
  const scanned = versions.filter((v) => v.revision && !v.error);
  const withScript = scanned.filter((v) => v.hasBuildScript);
  const bars: HistoryBar[] = versions.map((v) => ({
    version: v.version,
    latest: v.latest,
    height: !v.revision || v.error ? null : v.hasBuildScript ? (v.lines ?? 0) / max : 0,
    segments: [[v.links ? COLOR_LINKS : COLOR_SCRIPT, 1]],
    title: describe(v),
    error: Boolean(v.error),
  }));
  return (
    <HistoryStrip
      bars={bars}
      onPick={(version) => {
        const v = versions.find((x) => x.version === version);
        if (v) onPick(v);
      }}
      head={
        <>
          <b>{name}</b> across {versions.length.toLocaleString()} version{versions.length === 1 ? '' : 's'}
          <span className="muted">
            {' '}
            · {scanned.length.toLocaleString()} scanned · {withScript.length.toLocaleString()} with a build script · bar height = script lines,{' '}
            <span style={{ color: COLOR_LINKS }}>purple</span> = declares links
          </span>
        </>
      }
    />
  );
}

export function BuildView({ busy, onBusy, onError, onOpenCrate }: Props) {
  const [scope, setScope] = useState<UnsafeScope>('latest');
  const { sort, desc, toggle } = useSort<BuildSort>('lines', 'name');
  const [q, setQ] = useState('');
  const qDebounced = useDebounced(q);
  const [links, setLinks] = useState<UnsafeTri>('any');
  const [link, setLink] = useState('');
  const [custom, setCustom] = useState<UnsafeTri>('any');
  const [minLines, setMinLines] = useState(0);
  const [limit, setLimit] = useState(100);
  const [expanded, setExpanded] = useState<string | null>(null);

  const stats = useStats<BuildStats>(api.buildStats, scope, onError);
  const query = useMemo(() => ({ scope, sort, desc, q: qDebounced, links, link, custom, minLines, limit }), [scope, sort, desc, qDebounced, links, link, custom, minLines, limit]);
  const board = useLeaderboard<BuildRow, typeof query>(api.buildTop, query, onBusy, onError);
  const { history, ensure } = useCrateHistory<BuildRow>(api.buildCrate, onError);

  const expand = (r: BuildRow) => {
    const key = `${r.name}@${r.version}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    void ensure(r.name);
  };

  const copy = () =>
    copyTsv(
      ['crate', 'version', 'latest', 'build_script', 'build_script_lines', 'links', 'rs_lines', 'unsafe_total', 'has_native_code', 'vendored_native'],
      board.rows.map((r) => [r.name, r.version, r.latest, r.path, r.lines, r.links, r.rsLines, r.unsafeTotal, r.hasNativeCode, r.vendoredNative]),
    );

  return (
    <div className="unsafe">
      <div className="unsafe-tiles">
        <CoverageTile
          scope={scope}
          scanned={stats?.scanned}
          versions={stats?.versions}
          title="Versions the build job has scanned (meta_build), out of all versions in scope"
          note={
            <>
              {fmt(stats?.known)} with a build-script flag from any scanner · {fmt(stats?.unreadable)} unreadable
            </>
          }
        />
        <Tile
          label="with a build script"
          value={pct(stats?.withBuild, stats?.known)}
          note={`${fmt(stats?.withBuild)} versions`}
          title="Versions Cargo would run a build script for, out of those where it is known (the unsafe scanner stored has_build_script too)"
          color={COLOR_SCRIPT}
        />
        <Tile
          label="declare links"
          value={pct(stats?.withLinks, stats?.withBuildScanned)}
          note={`${fmt(stats?.withLinks)} of ${fmt(stats?.withBuildScanned)} scanned scripts`}
          title="package.links set: the build script links a native library"
          color={COLOR_LINKS}
          onClick={() => setLinks(links === 'yes' ? 'any' : 'yes')}
          active={links === 'yes'}
        />
        <Tile
          label="custom script path"
          value={fmt(stats?.custom)}
          note="not build.rs"
          title="package.build names something other than build.rs"
          onClick={() => setCustom(custom === 'yes' ? 'any' : 'yes')}
          active={custom === 'yes'}
        />
        <Tile label="build script lines" value={fmt(stats?.scriptLines)} note={stats?.missingScript ? `${fmt(stats.missingScript)} declared but not in the tarball` : 'over all scanned scripts'} title="Lines in every scanned build script, summed" />
        <HistTile label="scripts by line count" labels={HIST_LABELS} values={stats?.histogram} title="Scanned build scripts by size" />
        <div className="tile links-tile" title="package.links values by distinct crates (latest versions in scope). Click one to filter.">
          <div className="tile-label">most-linked libraries</div>
          <ul className="links-list">
            {(stats?.topLinks ?? []).map((l) => (
              <li key={l.links}>
                <a className={link === l.links ? 'active' : ''} onClick={() => setLink(link === l.links ? '' : l.links)} title={l.sample.join(', ')}>
                  {l.links}
                </a>
                <span className="muted small"> {l.crates}</span>
              </li>
            ))}
            {stats && stats.topLinks.length === 0 && <li className="muted small">none yet</li>}
          </ul>
        </div>
      </div>

      <div className="unsafe-controls">
        <ScopeSelect scope={scope} onChange={setScope} />
        <input type="text" placeholder="Crate name contains…" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} className="q" />
        <TriSelect label="links" value={links} onChange={setLinks} title="Only scripts that declare (or do not declare) package.links" />
        <label className="opt" title="Exact package.links value">
          links =
          <input type="text" value={link} onChange={(e) => setLink(e.target.value.trim())} placeholder="any" className="limit wide" spellCheck={false} />
        </label>
        <TriSelect label="custom path" value={custom} onChange={setCustom} title="Script is not the default build.rs" />
        <label className="opt" title="Only scripts with at least this many lines">
          min lines
          <input type="number" min={0} step={10} value={minLines} onChange={(e) => setMinLines(Math.max(0, Number(e.target.value) || 0))} className="limit" />
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

      <div className="unsafe-table">
        <table>
          <thead>
            <tr>
              <th className="rank">#</th>
              <SortHeaders columns={COLUMNS} sort={sort} desc={desc} onSort={toggle} />
              <th>flags</th>
            </tr>
          </thead>
          <tbody>
            {board.rows.map((r, i) => {
              const key = `${r.name}@${r.version}`;
              const open = expanded === key;
              return (
                <Fragment key={key}>
                  <tr className={open ? 'open' : ''} onClick={() => expand(r)} title="Click for the crate's build-script history">
                    <td className="rank muted">{i + 1}</td>
                    <td className="crate">
                      {r.name}
                      <span className="muted">@{r.version}</span>
                      {r.latest && scope === 'all' && <span className="badge">latest</span>}
                    </td>
                    <td className={r.path && r.path !== 'build.rs' ? '' : 'muted'}>
                      <code>{r.path ?? '—'}</code>
                    </td>
                    <td className="num total">{fmt(r.lines)}</td>
                    <td>
                      {r.links ? (
                        <a
                          className="link-name"
                          onClick={(e) => {
                            e.stopPropagation();
                            setLink(link === r.links ? '' : r.links!);
                          }}
                          title="Filter to this links value"
                        >
                          {r.links}
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num muted">{fmt(r.rsLines)}</td>
                    <td className={`num ${r.unsafeTotal ? '' : 'muted'}`}>{fmt(r.unsafeTotal)}</td>
                    <td className="flags">
                      <NativeFlags native={r.hasNativeCode} vendored={r.vendoredNative} />
                    </td>
                  </tr>
                  {open && (
                    <tr className="detail">
                      <td colSpan={COLUMNS.length + 2}>
                        <div className="unsafe-detail">
                          <div className="unsafe-detail-actions">
                            <button onClick={() => onOpenCrate(r.name)} title="Open this crate in the Default graph view">
                              Open in graph
                            </button>
                            <span className="muted small">
                              {r.path ?? 'build.rs'} · {fmt(r.lines)} lines{r.links ? ` · links ${r.links}` : ''} · scanned with {r.revision ?? '—'}
                            </span>
                          </div>
                          {history[r.name] ? (
                            <BuildHistory
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
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {board.rows.length === 0 && !busy && (
          <p className="muted pad">{stats && stats.scanned === 0 ? 'Nothing scanned yet: run painter generate-metadata --job build.' : 'No versions match the filters.'}</p>
        )}
        <LoadMore hasMore={board.hasMore} busy={busy} limit={limit} onClick={board.loadMore} />
      </div>
    </div>
  );
}
