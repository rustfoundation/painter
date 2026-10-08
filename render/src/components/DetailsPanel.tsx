import type { ExpandType, GraphNode, GraphRel, View } from '../api';
import { isCrate, isVersion, nodeTitle, relTitle } from '../graph';

interface Props {
  view: View;
  /** Deps view: load a crate's crate-level dependencies / dependents. */
  onExpandDeps: (name: string, direction: 'in' | 'out' | 'both') => void;
  selected: GraphNode | GraphRel | null;
  nodeById: (id: string) => GraphNode | undefined;
  onExpand: (id: string, direction: 'in' | 'out' | 'both', types: ExpandType[]) => void;
  onRemove: (id: string) => void;
  onLoadCrate: (name: string) => void;
  busy: boolean;
}

const isRel = (x: GraphNode | GraphRel): x is GraphRel => 'from' in x && 'to' in x;

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length ? v.map(fmt).join(', ') : '[]';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

function Properties({ props }: { props: Record<string, unknown> }) {
  const entries = Object.entries(props).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return <p className="muted">no properties</p>;
  return (
    <table className="props">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{fmt(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DetailsPanel({ view, onExpandDeps, selected, nodeById, onExpand, onRemove, onLoadCrate, busy }: Props) {
  if (!selected) {
    return (
      <div className="details">
        <h2>Nothing selected</h2>
        <p className="muted">
          {view === 'deps'
            ? 'Click a crate or edge to inspect it. Double-click a crate to add its direct crate-level dependencies and dependents.'
            : 'Click a node or relationship to inspect it. Double-click a node to expand all of its neighbours.'}
        </p>
        <h3>Legend</h3>
        {view === 'deps' ? (
          <ul className="legend">
            <li>
              <span className="swatch" style={{ background: '#1F5FD1' }} /> Crate (loaded root)
            </li>
            <li>
              <span className="swatch" style={{ background: '#4C8DFF' }} /> Crate (size = connections)
            </li>
            <li>
              <span className="line" style={{ background: '#4C8DFF' }} /> A → B: some version of A depends on B (width = how many)
            </li>
          </ul>
        ) : (
        <ul className="legend">
          <li>
            <span className="swatch" style={{ background: '#1F5FD1' }} /> Crate (loaded root)
          </li>
          <li>
            <span className="swatch" style={{ background: '#4C8DFF' }} /> Crate
          </li>
          <li>
            <span className="swatch" style={{ background: '#F5A623' }} /> Version
          </li>
          <li>
            <span className="swatch" style={{ background: '#2BB673' }} /> Version (latest = true)
          </li>
          <li>
            <span className="swatch" style={{ background: '#B88BFF' }} /> Version (pre-release)
          </li>
          <li>
            <span className="line" style={{ background: '#9AA3B2' }} /> VERSION_OF
          </li>
          <li>
            <span className="line" style={{ background: '#4C8DFF' }} /> DEPENDS_ON
          </li>
          <li>
            <span className="line" style={{ background: '#E5484D' }} /> INVOKES (width = call count)
          </li>
        </ul>
        )}
      </div>
    );
  }

  if (isRel(selected)) {
    const from = nodeById(selected.from);
    const to = nodeById(selected.to);
    const targets = Array.isArray(selected.properties.targets) ? (selected.properties.targets as string[]) : null;
    return (
      <div className="details">
        <h2>
          <span className="badge rel">{selected.type}</span> {relTitle(selected)}
        </h2>
        <p>
          <strong>{from ? nodeTitle(from) : selected.from}</strong> → <strong>{to ? nodeTitle(to) : selected.to}</strong>
        </p>
        {selected.properties.aggregated === true && selected.type === 'INVOKES' && (
          <p className="muted">
            Aggregated: {fmt(selected.properties.count)} INVOKES edges collapsed into one. Showing up to 10 distinct
            targets.
          </p>
        )}
        {selected.properties.aggregated === true && selected.type === 'DEPENDS_ON' && (
          <p className="muted">
            Crate-level edge: {fmt(selected.properties.versions)} version(s) of {from ? nodeTitle(from) : selected.from}{' '}
            declare a dependency on {to ? nodeTitle(to) : selected.to}.
          </p>
        )}
        {targets ? (
          <>
            <h3>Targets</h3>
            <ul className="targets">
              {targets.map((t) => (
                <li key={t}>
                  <code>{t}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <h3>Properties</h3>
        <Properties props={Object.fromEntries(Object.entries(selected.properties).filter(([k]) => k !== 'targets'))} />
      </div>
    );
  }

  const node = selected;
  const name = String(node.properties.name ?? '');
  return (
    <div className="details">
      <h2>
        <span className={`badge ${isCrate(node) ? 'crate' : isVersion(node) ? 'version' : ''}`}>{node.labels.join(':')}</span>{' '}
        {nodeTitle(node)}
      </h2>

      <div className="actions">
        {isCrate(node) && view === 'deps' && (
          <>
            <button disabled={busy} onClick={() => onExpandDeps(name, 'out')} title="Add direct crate-level dependencies">
              Dependencies
            </button>
            <button disabled={busy} onClick={() => onExpandDeps(name, 'in')} title="Add direct crate-level dependents">
              Dependents
            </button>
            <button disabled={busy} onClick={() => onLoadCrate(name)} title="Replace the canvas with this crate's full transitive chain">
              Chain from here
            </button>
          </>
        )}
        {isCrate(node) && view === 'default' && (
          <>
            <button disabled={busy} onClick={() => onLoadCrate(name)}>
              Load crate
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'both', ['VERSION_OF'])}>
              Versions
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'in', ['DEPENDS_ON'])}>
              Dependents
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'in', ['INVOKES'])}>
              Invoked by
            </button>
          </>
        )}
        {isVersion(node) && (
          <>
            <button disabled={busy} onClick={() => onExpand(node.id, 'out', ['DEPENDS_ON'])}>
              Dependencies
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'out', ['INVOKES'])}>
              Invokes
            </button>
            <button disabled={busy} onClick={() => onExpand(node.id, 'both', ['VERSION_OF'])}>
              Crate
            </button>
          </>
        )}
        {view === 'default' && (
          <button disabled={busy} onClick={() => onExpand(node.id, 'both', [])}>
            Expand all
          </button>
        )}
        <button disabled={busy} className="danger" onClick={() => onRemove(node.id)}>
          Remove
        </button>
      </div>

      <h3>Properties</h3>
      <Properties props={node.properties} />
      <p className="muted small">elementId {node.id}</p>
    </div>
  );
}
