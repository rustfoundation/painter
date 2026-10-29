import { Fragment, useMemo, useState } from 'react';
import { api, type NativeLang, type NativeRow, type NativeSort, type NativeStats, type UnsafeScope, type UnsafeTri } from '../api';
import { NativeFlags } from './BuildView';
import {
  copyTsv,
  CoverageTile,
  fmt,
  fmtBytes,
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

export const LANGS: { key: NativeLang; label: string; color: string }[] = [
  { key: 'c', label: 'C', color: '#4C8DFF' },
  { key: 'c++', label: 'C++', color: '#B88BFF' },
  { key: 'objc', label: 'Objective-C', color: '#2BB673' },
  { key: 'asm', label: 'assembly', color: '#E5484D' },
];
const langColor = (lang: string) => LANGS.find((l) => l.key === lang)?.color ?? '#888';
const COLOR_VENDORED = '#F5A623';
const COLOR_NATIVE = '#4C8DFF';

const COLUMNS: Column<NativeSort>[] = [
  { key: 'name', label: 'crate / version', title: 'Sort by name' },
  { key: 'lines', label: 'lines', title: 'Non-blank lines in native sources and headers', num: true },
  { key: 'sourceLines', label: 'src lines', title: 'Non-blank lines in native source files (not headers)', num: true },
  { key: 'files', label: 'files', title: 'Native source + header files', num: true },
  { key: 'bytes', label: 'bytes', title: 'Bytes of native sources and headers', num: true },
  { key: 'largest', label: 'largest', title: 'Largest native file', num: true },
  { key: 'vendorDirLines', label: 'vendor/ lines', title: 'Native lines under vendor/, third_party/, deps/, external/, contrib/, ... directories', num: true },
  { key: 'prebuilt', label: 'prebuilt', title: 'Prebuilt binaries: .a .lib .so .dll .dylib .o .obj', num: true },
];

const HIST_LABELS = ['1–100', '101–1k', '1k–10k', '10k–100k', '>100k'];

export function LangChips({ langs }: { langs: string[] }) {
  return (
    <span className="lang-chips">
      {langs.map((l) => (
        <span key={l} className="lang-chip" style={{ background: langColor(l) }} title={LANGS.find((x) => x.key === l)?.label ?? l}>
          {l}
        </span>
      ))}
    </span>
  );
}

const describe = (v: NativeRow) =>
  v.error
    ? `${v.version}: ${v.error}`
    : !v.revision
      ? `${v.version}: not scanned`
      : v.hasNativeCode
        ? `${v.version}: ${fmt(v.lines)} native lines in ${fmt((v.sourceFiles ?? 0) + (v.headerFiles ?? 0))} files (${v.langs.join(', ')})${v.vendored ? ', vendored' : ''}${v.prebuilt ? `, ${v.prebuilt} prebuilt` : ''}`
        : `${v.version}: no native code`;

function NativeHistory({ name, versions, onPick }: { name: string; versions: NativeRow[]; onPick: (v: NativeRow) => void }) {
  const max = Math.max(1, ...versions.map((v) => v.lines ?? 0));
  const scanned = versions.filter((v) => v.revision && !v.error);
  const withNative = scanned.filter((v) => v.hasNativeCode);
  const bars: HistoryBar[] = versions.map((v) => ({
    version: v.version,
    latest: v.latest,
    height: !v.revision || v.error ? null : v.hasNativeCode ? (v.lines ?? 0) / max : 0,
    segments: [[v.vendored ? COLOR_VENDORED : COLOR_NATIVE, 1]],
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
            · {scanned.length.toLocaleString()} scanned · {withNative.length.toLocaleString()} with native code · bar height = native lines,{' '}
            <span style={{ color: COLOR_VENDORED }}>orange</span> = vendored
          </span>
        </>
      }
    />
  );
}

export function NativeView({ busy, onBusy, onError, onOpenCrate }: Props) {
  const [scope, setScope] = useState<UnsafeScope>('latest');
  const { sort, desc, toggle } = useSort<NativeSort>('lines', 'name');
  const [q, setQ] = useState('');
  const qDebounced = useDebounced(q);
  const [vendored, setVendored] = useState<UnsafeTri>('any');
  const [prebuilt, setPrebuilt] = useState<UnsafeTri>('any');
  const [lang, setLang] = useState<NativeLang | ''>('');
  const [minLines, setMinLines] = useState(0);
  const [limit, setLimit] = useState(100);
  const [expanded, setExpanded] = useState<string | null>(null);

  const stats = useStats<NativeStats>(api.nativeStats, scope, onError);
  const query = useMemo(() => ({ scope, sort, desc, q: qDebounced, vendored, prebuilt, lang, minLines, limit }), [scope, sort, desc, qDebounced, vendored, prebuilt, lang, minLines, limit]);
  const board = useLeaderboard<NativeRow, typeof query>(api.nativeTop, query, onBusy, onError);
  const { history, ensure } = useCrateHistory<NativeRow>(api.nativeCrate, onError);

  const expand = (r: NativeRow) => {
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
      ['crate', 'version', 'latest', 'vendored_native', 'native_lines', 'native_source_lines', 'native_source_files', 'native_header_files', 'native_bytes', 'native_largest_bytes', 'native_vendor_dir_lines', 'native_prebuilt_files', 'native_langs', 'native_dirs', 'has_build_script', 'links'],
      board.rows.map((r) => [r.name, r.version, r.latest, r.vendored, r.lines, r.sourceLines, r.sourceFiles, r.headerFiles, r.bytes, r.largestBytes, r.vendorDirLines, r.prebuilt, r.langs.join(','), r.dirs.join(','), r.hasBuildScript, r.links]),
    );

  const langStat = (k: NativeLang) => stats?.langs.find((l) => l.lang === k);

  return (
    <div className="unsafe">
      <div className="unsafe-tiles">
        <CoverageTile
          scope={scope}
          stats={stats}
          scanned={stats?.scanned}
          versions={stats?.versions}
          title="Versions the native job has scanned (meta_native), out of all versions in scope"
          note={
            <>
              {fmt(stats?.unreadable)} unreadable · {fmt(stats?.sourceFiles)} sources · {fmt(stats?.headerFiles)} headers · {fmtBytes(stats?.bytes)}
            </>
          }
        />
        <Tile
          label="with native code"
          value={pct(stats?.withNative, stats?.scanned)}
          note={`${fmt(stats?.withNative)} versions · ${fmt(stats?.lines)} lines`}
          title="Scanned versions with at least one native source or header"
          color={COLOR_NATIVE}
        />
        <Tile
          label="vendored library"
          value={pct(stats?.vendored, stats?.withNative)}
          note={`${fmt(stats?.vendored)} of those with native code`}
          title="At least 1,000 native source lines, 5,000 with headers, or 200 under a vendor/-style directory. Click to filter."
          color={COLOR_VENDORED}
          onClick={() => setVendored(vendored === 'yes' ? 'any' : 'yes')}
          active={vendored === 'yes'}
        />
        <Tile
          label="prebuilt binaries"
          value={fmt(stats?.withPrebuilt)}
          note={`versions · ${fmt(stats?.prebuiltFiles)} files (.a .so .dll .o …)`}
          title="Versions shipping prebuilt static / shared libraries or object files. Click to filter."
          onClick={() => setPrebuilt(prebuilt === 'yes' ? 'any' : 'yes')}
          active={prebuilt === 'yes'}
        />
        <Tile
          label="native + build script"
          value={pct(stats?.nativeWithBuild, stats?.withNative)}
          note={`${fmt(stats?.nativeWithBuild)} with build.rs · ${fmt(stats?.nativeWithLinks)} declare links`}
          title="Versions with native code that also have a build script (the usual way to compile it)"
        />
        {LANGS.map((l) => {
          const s = langStat(l.key);
          return (
            <Tile
              key={l.key}
              label={l.label}
              value={fmt(s?.versions ?? (stats ? 0 : undefined))}
              note={`versions · ${fmt(s?.lines ?? (stats ? 0 : undefined))} lines`}
              title={`Versions with ${l.label} files. Click to filter.`}
              color={l.color}
              onClick={() => setLang(lang === l.key ? '' : l.key)}
              active={lang === l.key}
            />
          );
        })}
        <HistTile label="versions by native lines" labels={HIST_LABELS} values={stats?.histogram} title="Versions with native code by non-blank native lines" />
        <div className="tile links-tile" title="Top-level directories holding native files, by distinct crates">
          <div className="tile-label">where it lives</div>
          <ul className="links-list">
            {(stats?.dirs ?? []).map((d) => (
              <li key={d.dir}>
                <code>{d.dir}/</code>
                <span className="muted small"> {d.crates}</span>
              </li>
            ))}
            {stats && stats.dirs.length === 0 && <li className="muted small">none yet</li>}
          </ul>
        </div>
      </div>

      <div className="unsafe-controls">
        <ScopeSelect scope={scope} onChange={setScope} />
        <input type="text" placeholder="Crate name contains…" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} className="q" />
        <TriSelect label="vendored" value={vendored} onChange={setVendored} title="Enough native code to be a library in its own right" />
        <TriSelect label="prebuilt" value={prebuilt} onChange={setPrebuilt} title="Ships .a / .so / .dll / .o files" />
        <label className="opt">
          language
          <select value={lang} onChange={(e) => setLang(e.target.value as NativeLang | '')}>
            <option value="">any</option>
            {LANGS.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="opt" title="Only versions with at least this many native lines">
          min lines
          <input type="number" min={0} step={100} value={minLines} onChange={(e) => setMinLines(Math.max(0, Number(e.target.value) || 0))} className="limit wide" />
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
              <th title="Languages present">langs</th>
              <SortHeaders columns={COLUMNS} sort={sort} desc={desc} onSort={toggle} />
              <th title="Top-level directories holding native files">dirs</th>
              <th>flags</th>
            </tr>
          </thead>
          <tbody>
            {board.rows.map((r, i) => {
              const key = `${r.name}@${r.version}`;
              const open = expanded === key;
              return (
                <Fragment key={key}>
                  <tr className={open ? 'open' : ''} onClick={() => expand(r)} title="Click for the crate's native-code history">
                    <td className="rank muted">{i + 1}</td>
                    <td>
                      <LangChips langs={r.langs} />
                    </td>
                    <td className="crate">
                      {r.name}
                      <span className="muted">@{r.version}</span>
                      {r.latest && scope === 'all' && <span className="badge">latest</span>}
                    </td>
                    <td className="num total">{fmt(r.lines)}</td>
                    <td className="num">{fmt(r.sourceLines)}</td>
                    <td className="num" title={`${fmt(r.sourceFiles)} sources + ${fmt(r.headerFiles)} headers`}>
                      {fmt((r.sourceFiles ?? 0) + (r.headerFiles ?? 0))}
                    </td>
                    <td className="num muted">{fmtBytes(r.bytes)}</td>
                    <td className="num muted">{fmtBytes(r.largestBytes)}</td>
                    <td className={`num ${r.vendorDirLines ? '' : 'muted'}`}>{fmt(r.vendorDirLines)}</td>
                    <td className={`num ${r.prebuilt ? '' : 'muted'}`}>{fmt(r.prebuilt)}</td>
                    <td className="dirs muted" title={r.dirs.join(', ')}>
                      {r.dirs.slice(0, 3).join(', ')}
                      {r.dirs.length > 3 ? ` +${r.dirs.length - 3}` : ''}
                    </td>
                    <td className="flags">
                      <NativeFlags vendored={r.vendored} build={r.hasBuildScript} links={r.links} />
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
                              {fmt(r.sourceFiles)} sources · {fmt(r.headerFiles)} headers · {fmt(r.lines)} lines ({fmt(r.sourceLines)} in sources) · {fmtBytes(r.bytes)} · largest{' '}
                              {fmtBytes(r.largestBytes)} · {fmt(r.vendorDirLines)} lines under vendor dirs · {fmt(r.prebuilt)} prebuilt · in{' '}
                              {r.dirs.map((d) => `${d}/`).join(' ') || '—'} · scanned with {r.revision ?? '—'}
                            </span>
                          </div>
                          {history[r.name] ? (
                            <NativeHistory
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
          <p className="muted pad">{stats && stats.scanned === 0 ? 'Nothing scanned yet: run painter generate-metadata --job native.' : 'No versions match the filters.'}</p>
        )}
        <LoadMore hasMore={board.hasMore} busy={busy} limit={limit} onClick={board.loadMore} />
      </div>
    </div>
  );
}
