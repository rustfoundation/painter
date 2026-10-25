import { useState } from 'react';
import type { GraphPayload } from '../api';

interface Props {
  enabled: boolean;
  busy: boolean;
  onRun: (query: string) => Promise<GraphPayload | null>;
}

const EXAMPLES: { label: string; query: string }[] = [
  {
    label: 'Top 10 most depended-on crates',
    query: `MATCH (v:Version)-[d:DEPENDS_ON]->(c:Crate)
WITH c, count(d) AS n ORDER BY n DESC LIMIT 10
MATCH (v:Version)-[d:DEPENDS_ON]->(c)
WITH c, n, collect(v)[0..5] AS sample
UNWIND sample AS v
MATCH (v)-[d:DEPENDS_ON]->(c)
RETURN c, v, d`,
  },
  {
    label: 'serde: who calls it (aggregated)',
    query: `MATCH (c:Crate {name: 'serde'})<-[:IN]-(:Symbol)<-[k:CALLS]-(:Fn)<-[:HAS_FN]-(v:Version)
WITH c, v, count(k) AS calls ORDER BY calls DESC LIMIT 50
MATCH (v)-[vo:VERSION_OF]-(vc:Crate)
RETURN c, v, vc, vo, calls`,
  },
  {
    label: 'Dependency path serde -> libc (max 3 hops)',
    query: `MATCH p = (a:Crate {name: 'serde'})-[:VERSION_OF]-(:Version)-[:DEPENDS_ON]->(:Crate)
  -[:VERSION_OF]-(:Version)-[:DEPENDS_ON]->(b:Crate {name: 'libc'})
RETURN p LIMIT 25`,
  },
  {
    label: 'Versions with unsafe counts',
    query: `MATCH (v:Version)-[vo:VERSION_OF]-(c:Crate)
WHERE v.unsafe_total IS NOT NULL
RETURN c, v, vo ORDER BY v.unsafe_total DESC LIMIT 50`,
  },
];

export function CypherPanel({ enabled, busy, onRun }: Props) {
  const [query, setQuery] = useState(EXAMPLES[0].query);
  const [result, setResult] = useState<GraphPayload | null>(null);
  const [open, setOpen] = useState(false);

  const run = async () => {
    const r = await onRun(query);
    setResult(r);
  };

  if (!enabled) {
    return (
      <div className="cypher collapsed">
        <span className="muted">Ad-hoc Cypher disabled on the server (RENDER_ALLOW_CYPHER=false)</span>
      </div>
    );
  }

  return (
    <div className={`cypher ${open ? 'open' : 'collapsed'}`}>
      <div className="cypher-header" onClick={() => setOpen((o) => !o)}>
        <strong>{open ? '▾' : '▸'} Cypher</strong>
        <span className="muted">
          read-only · returned nodes and relationships are merged into the graph
          {result && (
            <>
              {' '}
              · last run: {result.nodes.length} nodes, {result.rels.length} rels, {result.meta.records} records in{' '}
              {result.meta.elapsedMs} ms{result.meta.truncated ? ' (truncated)' : ''}
            </>
          )}
        </span>
      </div>
      {open && (
        <div className="cypher-body">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
          />
          <div className="cypher-controls">
            <button className="primary" disabled={busy || !query.trim()} onClick={() => void run()}>
              Run (Ctrl+Enter)
            </button>
            <select
              value=""
              onChange={(e) => {
                const ex = EXAMPLES.find((x) => x.label === e.target.value);
                if (ex) setQuery(ex.query);
              }}
            >
              <option value="">examples…</option>
              {EXAMPLES.map((ex) => (
                <option key={ex.label} value={ex.label}>
                  {ex.label}
                </option>
              ))}
            </select>
          </div>
          {result && result.rows && result.rows.length > 0 && result.columns && (
            <div className="rows">
              <table>
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 100).map((row, i) => (
                    <tr key={i}>
                      {result.columns!.map((c) => (
                        <td key={c}>{cell(row[c])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.rows.length > 100 && <p className="muted small">showing first 100 of {result.rows.length} rows</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.labels) && o.properties) {
      const p = o.properties as Record<string, unknown>;
      return `(${(o.labels as string[]).join(':')} ${p.name ?? ''}${p.version ? '@' + p.version : ''})`;
    }
    if (typeof o.type === 'string' && o.from && o.to) return `[:${o.type}]`;
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  }
  return String(v);
};
