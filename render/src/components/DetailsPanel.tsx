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

const UNSAFE_CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: 'functions', label: 'unsafe fns', color: '#E5484D' },
  { key: 'exprs', label: 'unsafe exprs', color: '#F5A623' },
  { key: 'impls', label: 'unsafe impls', color: '#B88BFF' },
  { key: 'traits', label: 'unsafe traits', color: '#4C8DFF' },
  { key: 'methods', label: 'unsafe methods', color: '#2BB673' },
];

/** `count-unsafe` metrics of a Version, when painter has scanned it. */
function UnsafeSummary({ p }: { p: Record<string, unknown> }) {
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : null);
  if (!p.unsafe_scanner) {
    return (
      <>
        <h3>Unsafe</h3>
        <p className="muted">Not scanned yet (run painter count-unsafe).</p>
      </>
    );
  }
  if (p.unsafe_error) {
    return (
      <>
        <h3>Unsafe</h3>
        <p className="muted">Could not scan: {String(p.unsafe_error)}</p>
      </>
    );
  }
  const total = num('unsafe_total') ?? 0;
  const lines = num('rs_lines') ?? 0;
  const exprs = num('unsafe_exprs') ?? 0;
  return (
    <>
      <h3>
        Unsafe <span className={`unsafe-total ${total ? 'hot' : ''}`}>{total.toLocaleString()}</span>
      </h3>
      <div className="unsafe-flags">
        {p.forbids_unsafe === true && (
          <span className="flag forbid" title="Crate root has #![forbid(unsafe_code)]">
            forbid(unsafe_code)
          </span>
        )}
        {p.has_build_script === true && (
          <span className="flag build" title="Has a build script">
            build.rs
          </span>
        )}
        {num('rs_files_failed') ? (
          <span className="flag failed" title="Files that could not be parsed and are not counted">
            {num('rs_files_failed')} unparsed
          </span>
        ) : null}
      </div>
      <table className="props unsafe-cats">
        <tbody>
          {UNSAFE_CATEGORIES.map((c) => {
            const u = num(`unsafe_${c.key}`) ?? 0;
            const s = num(`safe_${c.key}`) ?? 0;
            return (
              <tr key={c.key}>
                <th>
                  <span className="swatch" style={{ background: c.color }} /> {c.label}
                </th>
                <td>
                  <b className={u ? '' : 'muted'}>{u.toLocaleString()}</b>
                  <span className="muted"> / {(u + s).toLocaleString()}</span>
                  <span className="meter inline">
                    <span style={{ width: u + s ? `${(100 * u) / (u + s)}%` : 0, background: c.color }} />
                  </span>
                </td>
              </tr>
            );
          })}
          <tr>
            <th>source</th>
            <td>
              {(num('rs_files') ?? 0).toLocaleString()} files · {lines.toLocaleString()} lines
              {lines ? ` · ${((1000 * exprs) / lines).toFixed(1)} unsafe exprs / kloc` : ''}
            </td>
          </tr>
          <tr>
            <th>scanned</th>
            <td className="muted">
              {String(p.unsafe_scanner)}
              {p.unsafe_scanned_at ? `, ${new Date(String(p.unsafe_scanned_at)).toLocaleString()}` : ''}
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

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
            <span className="line" style={{ background: '#E5484D' }} /> INVOKES: calls into a crate (width = distinct calls)
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
            Aggregated: {fmt(selected.properties.count)} distinct calls (CALLS edges) collapsed into one. Showing up
            to 10 distinct targets.
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

      {isVersion(node) && <UnsafeSummary p={node.properties} />}
      <h3>Properties</h3>
      <Properties props={node.properties} />
      <p className="muted small">elementId {node.id}</p>
    </div>
  );
}
