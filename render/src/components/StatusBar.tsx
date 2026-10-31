import { isTableView, type Health, type OverviewMeta, type Stats, type View } from '../api';
import type { DepsStatus } from '../deps';

interface Props {
  view: View;
  depsStatus: DepsStatus | null;
  overviewMeta?: (OverviewMeta & { elapsedMs: number }) | null;
  mapMeta: { mode: string; level: number; inView: number; total: number; nodes: number; rels: number; elapsedMs: number } | null;
  health: Health | null;
  healthError: string | null;
  stats: Stats | null;
  nodeCount: number;
  relCount: number;
  hiddenRelTypes: Set<string>;
  onToggleRelType: (t: string) => void;
  showRelCaptions: boolean;
  onToggleRelCaptions: () => void;
  error: string | null;
}

const fmtInt = (n: number | undefined) => (n === undefined ? '…' : n.toLocaleString());

export function StatusBar(props: Props) {
  const { view, depsStatus, overviewMeta, mapMeta, health, healthError, stats, nodeCount, relCount, hiddenRelTypes, onToggleRelType, showRelCaptions, onToggleRelCaptions, error } = props;
  const connected = health?.ok === true;
  return (
    <div className="statusbar">
      <span className={`dot ${connected ? 'ok' : 'bad'}`} />
      <span>
        {health
          ? connected
            ? `${health.config.neo4j.uri} (${health.server?.agent ?? 'neo4j'}, db ${health.config.neo4j.database})`
            : `cannot reach ${health.config.neo4j.uri}: ${health.error}`
          : healthError
            ? `render server unreachable: ${healthError}`
            : 'connecting…'}
      </span>
      <span className="sep" />
      <span title="totals in the database">
        db: {fmtInt(stats?.crates)} crates · {fmtInt(stats?.versions)} versions · {fmtInt(stats?.dependsOn)} DEPENDS_ON ·{' '}
        {fmtInt(stats?.invokes)} CALLS
      </span>
      <span className="sep" />
      {!isTableView(view) && (
        <span>
          view: {nodeCount} nodes · {relCount} rels
        </span>
      )}
      {view === 'map' && mapMeta && (
        <>
          <span className="sep" />
          <span title="level-of-detail state for the current viewport">
            map: {fmtInt(mapMeta.nodes)} landmarks of {fmtInt(mapMeta.inView)} crates in view ({fmtInt(mapMeta.total)} total) · zoom level{' '}
            {mapMeta.level} · {fmtInt(mapMeta.elapsedMs)} ms
          </span>
        </>
      )}
      {view === 'default' && overviewMeta && (
        <>
          <span className="sep" />
          <span title="what was loaded for the root crate">
            {overviewMeta.name}
            {overviewMeta.version ? ` ${overviewMeta.version}` : ''}: {fmtInt(overviewMeta.depsTotal)} deps
            {overviewMeta.callsTotal - (overviewMeta.selfCalls ? 1 : 0) > 0 ? ` · calls into ${fmtInt(overviewMeta.callsTotal - (overviewMeta.selfCalls ? 1 : 0))} crates` : ''} ·{' '}
            {fmtInt(overviewMeta.counts.dependents)} dependent crates · {fmtInt(overviewMeta.counts.versions)} versions · {fmtInt(overviewMeta.elapsedMs)} ms
          </span>
        </>
      )}
      {view === 'deps' && depsStatus && (
        <>
          <span className="sep" />
          <span title="what the tree on screen contains">
            deps: {depsStatus.direction === 'out' ? 'dependencies of' : 'dependents of'} {depsStatus.root}
            {depsStatus.version ? ` ${depsStatus.version}` : ''} ·{' '}
            {depsStatus.mode === 'latest' ? `${depsStatus.kinds.join('/')}${depsStatus.optional ? ' +optional' : ''}` : 'any version'} · depth{' '}
            {depsStatus.depthReached}/{depsStatus.depth} · {fmtInt(depsStatus.nodes)} crates · {fmtInt(depsStatus.edges)} edges
            {depsStatus.notShown > 0 ? ` · +${fmtInt(depsStatus.notShown)} not drawn${depsStatus.truncated ? ' (budget)' : ''}` : ''} ·{' '}
            {fmtInt(depsStatus.elapsedMs)} ms
          </span>
        </>
      )}
      {!isTableView(view) && view !== 'deps' && (
      <>
      <span className="sep" />
      {(view === 'map' ? [] : view === 'default' ? ['PRECEDES', 'DEPENDS_ON', 'INVOKES', 'OWNS', 'PUBLISHED'] : ['VERSION_OF', 'DEPENDS_ON', 'INVOKES', 'OWNS', 'PUBLISHED']).map((t) => (
        <label key={t} className="opt">
          <input type="checkbox" checked={!hiddenRelTypes.has(t)} onChange={() => onToggleRelType(t)} /> {t}
        </label>
      ))}
      <label className="opt">
        <input type="checkbox" checked={showRelCaptions} onChange={onToggleRelCaptions} /> edge labels
      </label>
      </>
      )}
      <span className="spacer" />
      {error && <span className="error">{error}</span>}
    </div>
  );
}
