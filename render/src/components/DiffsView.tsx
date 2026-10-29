import { Fragment, useMemo, useState } from 'react';
import { api, type DiffFile, type DiffFirsts, type DiffRow, type DiffSort, type DiffStats, type DiffVersion, type UnsafeScope, type UnsafeTri } from '../api';
import {
  copyTsv,
  CoverageTile,
  errorMessage,
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

export const COLOR_ADDED = '#2BB673';
export const COLOR_REMOVED = '#E5484D';

const COLUMNS: Column<DiffSort>[] = [
  { key: 'name', label: 'crate / version', title: 'Sort by name' },
  { key: 'churn', label: 'churn', title: 'Lines added + removed against the previous version', num: true },
  { key: 'added', label: '+ lines', title: 'Lines added', num: true },
  { key: 'removed', label: '− lines', title: 'Lines removed', num: true },
  { key: 'filesChanged', label: 'files ±', title: 'Files added + removed + modified', num: true },
  { key: 'filesAdded', label: '+ files', title: 'Files added', num: true },
  { key: 'filesRemoved', label: '− files', title: 'Files removed', num: true },
  { key: 'filesModified', label: '~ files', title: 'Files modified', num: true },
  { key: 'filesTotal', label: 'files', title: 'Files in this version', num: true },
];

const HIST_LABELS = ['0', '1–10', '11–100', '101–1k', '1k–10k', '>10k'];

export function ChurnBar({ added, removed, max, width = 120 }: { added: number; removed: number; max: number; width?: number }) {
  const total = added + removed;
  if (!total) return <span className="mix empty" style={{ width }} />;
  const w = Math.max(4, Math.round((width * Math.log1p(total)) / Math.log1p(Math.max(max, 1))));
  return (
    <span className="mix" style={{ width: w }} title={`+${fmt(added)} / −${fmt(removed)}`}>
      {added ? <span style={{ flex: added, background: COLOR_ADDED }} /> : null}
      {removed ? <span style={{ flex: removed, background: COLOR_REMOVED }} /> : null}
    </span>
  );
}

export function DiffFlags({ base, approximate, unchanged }: { base: string | null; approximate: boolean | null; unchanged?: boolean }) {
  return (
    <>
      {base === null && (
        <span className="flag first" title="First version of the crate: compared against nothing, every file counts as added">
          first
        </span>
      )}
      {approximate && (
        <span className="flag approx" title="A file hit the 2 s diff timeout; its counts are a valid but maybe not minimal edit">
          approx
        </span>
      )}
      {unchanged && (
        <span className="flag" title="Identical to the previous version">
          unchanged
        </span>
      )}
    </>
  );
}

const describe = (v: DiffRow) =>
  v.error
    ? `${v.version}: ${v.error}`
    : !v.revision
      ? `${v.version}: not scanned`
      : v.base === null
        ? `${v.version}: first version, ${fmt(v.filesTotal)} files, ${fmt(v.linesAdded)} lines`
        : `${v.version} vs ${v.base}: +${fmt(v.linesAdded)} / −${fmt(v.linesRemoved)} lines in ${fmt(v.filesChanged)} files (${fmt(v.filesAdded)} added, ${fmt(v.filesRemoved)} removed, ${fmt(v.filesModified)} modified)${v.approximate ? ', approximate' : ''}`;

function DiffHistory({ name, versions, selected, onPick }: { name: string; versions: DiffRow[]; selected: string | null; onPick: (v: DiffRow) => void }) {
  // The first version adds every file, which would dwarf the real changes: scale on the rest.
  const later = versions.filter((v) => v.base !== null);
  const max = Math.max(1, ...later.map((v) => v.churn));
  const scanned = versions.filter((v) => v.revision && !v.error);
  const bars: HistoryBar[] = versions.map((v) => ({
    version: v.version,
    latest: v.latest || v.version === selected,
    height: !v.revision || v.error ? null : v.base === null ? 1 : Math.min(1, v.churn / max),
    segments: v.base === null ? [['#555', 1]] : [[COLOR_ADDED, v.linesAdded ?? 0], [COLOR_REMOVED, v.linesRemoved ?? 0]],
    title: describe(v),
    error: Boolean(v.error),
  }));
  const totalAdded = later.reduce((s, v) => s + (v.linesAdded ?? 0), 0);
  const totalRemoved = later.reduce((s, v) => s + (v.linesRemoved ?? 0), 0);
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
            · {scanned.length.toLocaleString()} scanned · <span style={{ color: COLOR_ADDED }}>+{fmt(totalAdded)}</span> /{' '}
            <span style={{ color: COLOR_REMOVED }}>−{fmt(totalRemoved)}</span> lines since the first version · bar height = churn (first version grey) · click a bar for its
            files
          </span>
        </>
      }
    />
  );
}

function FilesPanel({ v }: { v: DiffVersion }) {
  const files = v.files ?? [];
  const max = Math.max(1, ...files.map((f) => f.added + f.removed));
  const status = (f: DiffFile) => (f.status === 'added' ? '+' : f.status === 'removed' ? '−' : '~');
  return (
    <div className="diff-files">
      <div className="unsafe-history-head">
        <b>
          {v.name}@{v.version}
        </b>{' '}
        {v.base === null ? 'is the first version: every file is new' : `vs ${v.base}`}
        <span className="muted">
          {' '}
          · {fmt(v.filesChanged)} of {fmt(v.filesTotal)} files changed · <span style={{ color: COLOR_ADDED }}>+{fmt(v.linesAdded)}</span> /{' '}
          <span style={{ color: COLOR_REMOVED }}>−{fmt(v.linesRemoved)}</span> lines
        </span>{' '}
        <DiffFlags base={v.base} approximate={v.approximate} />
      </div>
      {v.files === null ? (
        <p className="muted small">Not diffed yet.</p>
      ) : files.length === 0 ? (
        <p className="muted small">No file differs from the previous version.</p>
      ) : (
        <table className="diff-files-table">
          <tbody>
            {files.map((f) => (
              <tr key={f.path} className={f.status ?? ''}>
                <td className={`status ${f.status ?? ''}`}>{status(f)}</td>
                <td className="path">
                  <code>{f.path}</code>
                  {f.binary && <span className="flag">binary</span>}
                </td>
                <td className="num added">{f.added ? `+${fmt(f.added)}` : ''}</td>
                <td className="num removed">{f.removed ? `−${fmt(f.removed)}` : ''}</td>
                <td>
                  <ChurnBar added={f.added} removed={f.removed} max={max} width={100} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function DiffsView({ busy, onBusy, onError, onOpenCrate }: Props) {
  const [scope, setScope] = useState<UnsafeScope>('latest');
  const { sort, desc, toggle } = useSort<DiffSort>('churn', 'name');
  const [q, setQ] = useState('');
  const qDebounced = useDebounced(q);
  const [firsts, setFirsts] = useState<DiffFirsts>('exclude');
  const [approximate, setApproximate] = useState<UnsafeTri>('any');
  const [minChurn, setMinChurn] = useState(0);
  const [limit, setLimit] = useState(100);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, DiffVersion | 'loading'>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});

  const stats = useStats<DiffStats>(api.diffStats, scope, onError);
  const query = useMemo(() => ({ scope, sort, desc, q: qDebounced, firsts, approximate, minChurn, limit }), [scope, sort, desc, qDebounced, firsts, approximate, minChurn, limit]);
  const board = useLeaderboard<DiffRow, typeof query>(api.diffTop, query, onBusy, onError);
  const { history, ensure } = useCrateHistory<DiffRow>(api.diffCrate, onError);

  const loadFiles = async (name: string, version: string) => {
    const key = `${name}@${version}`;
    setPicked((p) => ({ ...p, [name]: version }));
    if (files[key]) return;
    setFiles((f) => ({ ...f, [key]: 'loading' }));
    try {
      const v = await api.diffVersion(name, version);
      setFiles((f) => ({ ...f, [key]: v }));
    } catch (err) {
      setFiles((f) => {
        const next = { ...f };
        delete next[key];
        return next;
      });
      onError(errorMessage(err));
    }
  };

  const expand = (r: DiffRow) => {
    const key = `${r.name}@${r.version}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    void ensure(r.name);
    void loadFiles(r.name, r.version);
  };

  const copy = () =>
    copyTsv(
      ['crate', 'version', 'latest', 'diff_base', 'diff_lines_added', 'diff_lines_removed', 'diff_files_added', 'diff_files_removed', 'diff_files_modified', 'diff_files_total', 'diff_approximate'],
      board.rows.map((r) => [r.name, r.version, r.latest, r.base, r.linesAdded, r.linesRemoved, r.filesAdded, r.filesRemoved, r.filesModified, r.filesTotal, r.approximate]),
    );

  const maxChurn = Math.max(1, ...board.rows.map((r) => r.churn));
  const later = stats ? stats.scanned - stats.firsts : undefined;

  return (
    <div className="unsafe">
      <div className="unsafe-tiles">
        <CoverageTile
          scope={scope}
          stats={stats}
          scanned={stats?.scanned}
          versions={stats?.versions}
          title="Versions the diff job has compared with their predecessor (meta_diff), out of all versions in scope"
          note={
            <>
              {fmt(stats?.unreadable)} unreadable · {fmt(stats?.firsts)} first versions (nothing to compare) · {fmt(stats?.filesTotal)} files
            </>
          }
        />
        <Tile
          label="lines added"
          value={fmt(stats?.linesAdded)}
          note={`over ${fmt(later)} non-first versions`}
          title="Lines added across every scanned version that has a predecessor. Click to sort by it."
          color={COLOR_ADDED}
          onClick={() => toggle('added')}
          active={sort === 'added'}
        />
        <Tile
          label="lines removed"
          value={fmt(stats?.linesRemoved)}
          note={stats ? `net ${stats.linesAdded - stats.linesRemoved >= 0 ? '+' : ''}${fmt(stats.linesAdded - stats.linesRemoved)}` : undefined}
          title="Lines removed across every scanned version that has a predecessor. Click to sort by it."
          color={COLOR_REMOVED}
          onClick={() => toggle('removed')}
          active={sort === 'removed'}
        />
        <Tile
          label="files changed"
          value={fmt(stats ? stats.filesAdded + stats.filesRemoved + stats.filesModified : undefined)}
          note={`+${fmt(stats?.filesAdded)} · −${fmt(stats?.filesRemoved)} · ~${fmt(stats?.filesModified)}`}
          title="Files added, removed, and modified across non-first versions. Click to sort by it."
          onClick={() => toggle('filesChanged')}
          active={sort === 'filesChanged'}
        />
        <Tile
          label="unchanged republishes"
          value={pct(stats?.unchanged, later)}
          note={`${fmt(stats?.unchanged)} versions identical to the previous`}
          title="Versions whose tarball has no file differing from the previous version"
        />
        <Tile
          label="approximate"
          value={fmt(stats?.approximate)}
          note="hit the 2 s per-file diff timeout"
          title="Versions where some file's diff timed out; counts are an upper bound. Click to filter."
          onClick={() => setApproximate(approximate === 'yes' ? 'any' : 'yes')}
          active={approximate === 'yes'}
        />
        <HistTile label="versions by churn" labels={HIST_LABELS} values={stats?.histogram} title="Non-first versions by lines added + removed" />
      </div>

      <div className="unsafe-controls">
        <ScopeSelect scope={scope} onChange={setScope} />
        <input type="text" placeholder="Crate name contains…" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} className="q" />
        <label className="opt" title="A crate's first version is compared against nothing, so every line counts as added">
          first versions
          <select value={firsts} onChange={(e) => setFirsts(e.target.value as DiffFirsts)}>
            <option value="exclude">exclude</option>
            <option value="include">include</option>
            <option value="only">only</option>
          </select>
        </label>
        <TriSelect label="approximate" value={approximate} onChange={setApproximate} title="Some file hit the diff timeout" />
        <label className="opt" title="Only versions with at least this many lines added + removed">
          min churn
          <input type="number" min={0} step={100} value={minChurn} onChange={(e) => setMinChurn(Math.max(0, Number(e.target.value) || 0))} className="limit wide" />
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
              <th className="mixcol" title="Lines added (green) and removed (red), log scale">
                change
              </th>
              <SortHeaders columns={COLUMNS} sort={sort} desc={desc} onSort={toggle} />
              <th title="Version compared against">base</th>
              <th>flags</th>
            </tr>
          </thead>
          <tbody>
            {board.rows.map((r, i) => {
              const key = `${r.name}@${r.version}`;
              const open = expanded === key;
              const shown = picked[r.name] ?? r.version;
              const f = files[`${r.name}@${shown}`];
              return (
                <Fragment key={key}>
                  <tr className={open ? 'open' : ''} onClick={() => expand(r)} title="Click for the crate's change history and this version's files">
                    <td className="rank muted">{i + 1}</td>
                    <td className="mixcol">
                      <ChurnBar added={r.linesAdded ?? 0} removed={r.linesRemoved ?? 0} max={maxChurn} />
                    </td>
                    <td className="crate">
                      {r.name}
                      <span className="muted">@{r.version}</span>
                      {r.latest && scope === 'all' && <span className="badge">latest</span>}
                    </td>
                    <td className="num total">{fmt(r.churn)}</td>
                    <td className="num added">{fmt(r.linesAdded)}</td>
                    <td className="num removed">{fmt(r.linesRemoved)}</td>
                    <td className="num">{fmt(r.filesChanged)}</td>
                    <td className={`num ${r.filesAdded ? '' : 'muted'}`}>{fmt(r.filesAdded)}</td>
                    <td className={`num ${r.filesRemoved ? '' : 'muted'}`}>{fmt(r.filesRemoved)}</td>
                    <td className={`num ${r.filesModified ? '' : 'muted'}`}>{fmt(r.filesModified)}</td>
                    <td className="num muted">{fmt(r.filesTotal)}</td>
                    <td className="muted">{r.base ?? '—'}</td>
                    <td className="flags">
                      <DiffFlags base={r.base} approximate={r.approximate} unchanged={r.base !== null && r.filesChanged === 0} />
                    </td>
                  </tr>
                  {open && (
                    <tr className="detail">
                      <td colSpan={COLUMNS.length + 4}>
                        <div className="unsafe-detail">
                          <div className="unsafe-detail-actions">
                            <button onClick={() => onOpenCrate(r.name)} title="Open this crate in the Default graph view">
                              Open in graph
                            </button>
                            <span className="muted small">
                              {r.base === null ? 'first version' : `against ${r.base}`} · {fmt(r.filesTotal)} files in this version · scanned with {r.revision ?? '—'}
                            </span>
                          </div>
                          {history[r.name] ? (
                            <DiffHistory name={r.name} versions={history[r.name]} selected={shown} onPick={(v) => void loadFiles(r.name, v.version)} />
                          ) : (
                            <p className="muted">Loading version history…</p>
                          )}
                          {f === 'loading' || !f ? <p className="muted">Loading changed files…</p> : <FilesPanel v={f} />}
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
          <p className="muted pad">{stats && stats.scanned === 0 ? 'Nothing diffed yet: run painter generate-metadata --job diff.' : 'No versions match the filters.'}</p>
        )}
        <LoadMore hasMore={board.hasMore} busy={busy} limit={limit} onClick={board.loadMore} />
      </div>
    </div>
  );
}
