import type { GraphPayload, Health, Stats, View } from '../api';

interface Props {
  view: View;
  depsMeta: GraphPayload['meta'] | null;
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
  const { view, depsMeta, mapMeta, health, healthError, stats, nodeCount, relCount, hiddenRelTypes, onToggleRelType, showRelCaptions, onToggleRelCaptions, error } = props;
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
      {view !== 'callers' && view !== 'unsafe' && (
        <span>
          view: {nodeCount} nodes · {relCount} rels
        </span>
      )}
      {view === 'map' && mapMeta && (
        <>
          <span className="sep" />
          <span title="level-of-detail state for the current viewport">
            map: {mapMeta.mode === 'cells' ? `clusters at grid level ${mapMeta.level}` : 'individual crates'} · {fmtInt(mapMeta.inView)} of{' '}
            {fmtInt(mapMeta.total)} crates in view · {fmtInt(mapMeta.elapsedMs)} ms
          </span>
        </>
      )}
      {view === 'deps' && depsMeta?.roots && (
        <>
          <span className="sep" />
          <span title={depsMeta.roots.join(', ')}>
            chain: {fmtInt(depsMeta.roots.length)} root{depsMeta.roots.length === 1 ? '' : 's'}
            {depsMeta.partial ? ` matching "${depsMeta.query}"` : ` (exact "${depsMeta.query}")`} · depth {fmtInt(depsMeta.depth)}
            {depsMeta.maxDepth ? `/${depsMeta.maxDepth}` : ''} · {fmtInt(depsMeta.edges)} edges
            {depsMeta.truncated ? ` · cut at max edges ${fmtInt(depsMeta.limit)}` : ''} · {fmtInt(depsMeta.elapsedMs)} ms
          </span>
        </>
      )}
      {view !== 'callers' && view !== 'unsafe' && (
      <>
      <span className="sep" />
      {(view === 'map' ? [] : view === 'deps' ? ['DEPENDS_ON'] : ['VERSION_OF', 'DEPENDS_ON', 'INVOKES']).map((t) => (
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
