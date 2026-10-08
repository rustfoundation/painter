import type { Health, Stats } from '../api';

interface Props {
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
  const { health, healthError, stats, nodeCount, relCount, hiddenRelTypes, onToggleRelType, showRelCaptions, onToggleRelCaptions, error } = props;
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
        {fmtInt(stats?.invokes)} INVOKES
      </span>
      <span className="sep" />
      <span>
        view: {nodeCount} nodes · {relCount} rels
      </span>
      <span className="sep" />
      {['VERSION_OF', 'DEPENDS_ON', 'INVOKES'].map((t) => (
        <label key={t} className="opt">
          <input type="checkbox" checked={!hiddenRelTypes.has(t)} onChange={() => onToggleRelType(t)} /> {t}
        </label>
      ))}
      <label className="opt">
        <input type="checkbox" checked={showRelCaptions} onChange={onToggleRelCaptions} /> edge labels
      </label>
      <span className="spacer" />
      {error && <span className="error">{error}</span>}
    </div>
  );
}
