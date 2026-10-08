import { useEffect, useRef, useState } from 'react';
import { api, type CrateLoadOptions } from '../api';

interface Props {
  options: CrateLoadOptions;
  onOptionsChange: (o: CrateLoadOptions) => void;
  onLoad: (name: string) => void;
  onClear: () => void;
  onFit: () => void;
  layout: string;
  onLayoutChange: (l: string) => void;
  busy: boolean;
}

export function Toolbar({ options, onOptionsChange, onLoad, onClear, onFit, layout, onLayoutChange, busy }: Props) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(debounce.current);
    if (!query.trim()) {
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
  }, [query]);

  const submit = (name: string) => {
    const n = name.trim();
    if (!n) return;
    setOpen(false);
    setQuery(n);
    onLoad(n);
  };

  const set = <K extends keyof CrateLoadOptions>(key: K, value: CrateLoadOptions[K]) =>
    onOptionsChange({ ...options, [key]: value });

  return (
    <div className="toolbar">
      <div className="search">
        <input
          type="text"
          placeholder="Crate name… (e.g. serde)"
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
              submit(active >= 0 ? suggestions[active] : query);
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
              <li key={s} className={i === active ? 'active' : ''} onMouseDown={() => submit(s)}>
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button className="primary" disabled={busy || !query.trim()} onClick={() => submit(query)}>
        {busy ? 'Loading…' : 'Load'}
      </button>

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
