import { useEffect, useRef, useState } from 'react';
import { api, VIEWS, type CrateLoadOptions, type View } from '../api';

interface Props {
  view: View;
  onViewChange: (v: View) => void;
  /** Deps view: edge cap for the transitive chain. */
  depsLimit: number;
  depsMaxLimit: number;
  onDepsLimitChange: (n: number) => void;
  /** Deps view: max hops from the roots, 0 = unlimited. */
  depsDepth: number;
  onDepsDepthChange: (n: number) => void;
  options: CrateLoadOptions;
  onOptionsChange: (o: CrateLoadOptions) => void;
  /** `exact` is set when the user picked a suggestion, so a 3+ character name is not treated as a partial filter. */
  onLoad: (name: string, exact: boolean) => void;
  /** Crate the last load resolved to; shown in the box when it differs from what was typed. */
  loadedName: string | null;
  onClear: () => void;
  onFit: () => void;
  layout: string;
  onLayoutChange: (l: string) => void;
  busy: boolean;
}

export function Toolbar(props: Props) {
  const { view, onViewChange, depsLimit, depsMaxLimit, onDepsLimitChange, depsDepth, onDepsDepthChange } = props;
  /** Deps view: partial matching (and suggestions) only from this many characters. */
  const MIN_PARTIAL = 3;
  const { options, onOptionsChange, onLoad, loadedName, onClear, onFit, layout, onLayoutChange, busy } = props;
  const [query, setQuery] = useState('');

  // After a partial name loads, show the crate that was actually picked.
  useEffect(() => {
    if (loadedName) setQuery(loadedName);
  }, [loadedName]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(debounce.current);
    if (!query.trim() || (view === 'deps' && query.trim().length < MIN_PARTIAL)) {
      setSuggestions([]);
      return;
    }
    debounce.current = window.setTimeout(() => {
      api
        .searchCrates(query.trim())
        .then((names) => {
          setSuggestions(names);
          setActive(-1);
        })
        .catch(() => setSuggestions([]));
    }, 120);
    return () => window.clearTimeout(debounce.current);
  }, [query, view]);

  const submit = (name: string, exact = false) => {
    const n = name.trim();
    if (!n) return;
    setOpen(false);
    setQuery(n);
    onLoad(n, exact);
  };

  const set = <K extends keyof CrateLoadOptions>(key: K, value: CrateLoadOptions[K]) =>
    onOptionsChange({ ...options, [key]: value });

  return (
    <div className="toolbar">
      <div className="views" role="group" aria-label="Views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={v.id === view ? 'active' : ''}
            title={v.title}
            disabled={busy}
            onClick={() => onViewChange(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div className="search">
        <input
          type="text"
          placeholder={view === 'deps' ? 'Crate name, or 3+ chars to match many…' : 'Crate name or part of one… (e.g. serd)'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, suggestions.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, -1));
            } else if (e.key === 'Enter') {
              if (active >= 0) submit(suggestions[active], true);
              else submit(query);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          spellCheck={false}
          autoFocus
        />
        {open && suggestions.length > 0 && (
          <ul className="suggestions">
            {suggestions.map((s, i) => (
              <li key={s} className={i === active ? 'active' : ''} onMouseDown={() => submit(s, true)}>
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        className="primary"
        disabled={busy || !query.trim()}
        onClick={() => submit(query)}
        title={view === 'deps' ? 'Exact crate name if one exists; otherwise (3+ chars) every crate containing the text' : undefined}
      >
        {busy ? 'Loading…' : 'Load'}
      </button>

      {view === 'deps' && (
        <>
          <label className="opt" title="0 = follow the chain to the end">
            max depth
            <input
              type="number"
              min={0}
              max={64}
              value={depsDepth}
              onChange={(e) => onDepsDepthChange(Math.max(0, Number(e.target.value) || 0))}
              className="limit"
            />
          </label>
          <label className="opt">
            max edges
            <input
              type="number"
              min={1}
              max={depsMaxLimit}
              step={500}
              value={depsLimit}
              onChange={(e) => onDepsLimitChange(Math.min(depsMaxLimit, Math.max(1, Number(e.target.value) || 1)))}
              className="limit wide"
            />
          </label>
        </>
      )}

      {view === 'default' && (
      <>
      <label className="opt">
        <select value={options.versions} onChange={(e) => set('versions', e.target.value as 'latest' | 'all')}>
          <option value="latest">latest version</option>
          <option value="all">all versions</option>
        </select>
      </label>
      <label className="opt">
        <input type="checkbox" checked={options.deps} onChange={(e) => set('deps', e.target.checked)} /> deps
      </label>
      <label className="opt">
        <input type="checkbox" checked={options.invokes} onChange={(e) => set('invokes', e.target.checked)} /> invokes
      </label>
      <label className="opt">
        <input type="checkbox" checked={options.dependents} onChange={(e) => set('dependents', e.target.checked)} /> dependents
      </label>
      <label className="opt">
        limit
        <input
          type="number"
          min={1}
          max={2000}
          value={options.limit}
          onChange={(e) => set('limit', Math.max(1, Number(e.target.value) || 1))}
          className="limit"
        />
      </label>
      </>
      )}

      <span className="spacer" />

      <label className="opt">
        layout
        <select value={layout} onChange={(e) => onLayoutChange(e.target.value)}>
          <option value="forceDirected">force directed</option>
          <option value="d3Force">d3 force</option>
          <option value="hierarchical">hierarchical</option>
          <option value="circular">circular</option>
          <option value="grid">grid</option>
        </select>
      </label>
      <button onClick={onFit}>Fit</button>
      <button onClick={onClear} className="danger">
        Clear
      </button>
    </div>
  );
}
