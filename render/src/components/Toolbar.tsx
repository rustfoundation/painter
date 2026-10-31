import { useEffect, useRef, useState } from 'react';
import { api, isTableView, VIEWS, type CrateLoadOptions, type View } from '../api';
import { DEP_KINDS, type DepsOptions } from '../deps';
import { useIsMobile } from '../touch';

interface Props {
  view: View;
  onViewChange: (v: View) => void;
  depsOptions: DepsOptions;
  onDepsOptionsChange: (o: DepsOptions) => void;
  mapBudget: number;
  onMapBudgetChange: (n: number) => void;
  options: CrateLoadOptions;
  onOptionsChange: (o: CrateLoadOptions) => void;
  /** `exact` is set when the user picked a suggestion. Typed text must name a crate exactly unless it has `*` / `?`. */
  onLoad: (name: string, exact: boolean) => void;
  loadedName: string | null;
  onClear: () => void;
  onFit: () => void;
  layout: string;
  onLayoutChange: (l: string) => void;
  busy: boolean;
}

export function Toolbar(props: Props) {
  const { view, onViewChange, depsOptions, onDepsOptionsChange, mapBudget, onMapBudgetChange } = props;
  const { options, onOptionsChange, onLoad, loadedName, onClear, onFit, layout, onLayoutChange, busy } = props;
  const [query, setQuery] = useState('');
  const isMobile = useIsMobile();
  const [optsOpen, setOptsOpen] = useState(false);
  const activeTab = useRef<HTMLButtonElement>(null);

  // On a phone the view buttons are a scrolling strip; keep the current one visible.
  useEffect(() => {
    activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [view]);

  useEffect(() => {
    if (loadedName) setQuery(loadedName);
  }, [loadedName]);
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
      (view === 'map' ? api.lodSearch(query.trim()) : api.searchCrates(query.trim()))
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
            ref={v.id === view ? activeTab : undefined}
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
      {!isTableView(view) && (
      <>
      <div className="search">
        <input
          type="text"
          placeholder={
            view === 'map' ? 'Find a crate on the map: exact name, or a pattern like tokio*' : 'Crate: exact name, or a pattern like serde* (picks the most downloaded)'
          }
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
          // Focusing on load pops the on-screen keyboard over the page.
          autoFocus={!isMobile}
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
      >
        {busy ? 'Loading…' : view === 'map' ? 'Go to' : 'Load'}
      </button>
      </>
      )}

      {!isTableView(view) && (
        <button type="button" className={`opts-toggle${optsOpen ? ' active' : ''}`} aria-expanded={optsOpen} onClick={() => setOptsOpen((o) => !o)}>
          Options
        </button>
      )}

      {/* `display: contents` on desktop, a collapsible row on phones. */}
      <div className={`toolbar-opts${optsOpen ? ' open' : ''}`}>
      {view === 'map' && (
        <label className="opt" title="How many labelled crates to show per screen">
          density
          <select value={mapBudget <= 300 ? 250 : mapBudget <= 800 ? 600 : 1200} onChange={(e) => onMapBudgetChange(Number(e.target.value))}>
            <option value={250}>sparse</option>
            <option value={600}>normal</option>
            <option value={1200}>dense</option>
          </select>
        </label>
      )}

      {view === 'deps' && (
        <>
          <label className="opt" title="What the root depends on, or what depends on the root">
            <select value={depsOptions.direction} onChange={(e) => onDepsOptionsChange({ ...depsOptions, direction: e.target.value as DepsOptions['direction'] })}>
              <option value="out">dependencies</option>
              <option value="in">dependents</option>
            </select>
          </label>
          <label className="opt" title="Declared by the current version only, or by any version ever published (crate-level)">
            <select value={depsOptions.mode} onChange={(e) => onDepsOptionsChange({ ...depsOptions, mode: e.target.value as DepsOptions['mode'] })}>
              <option value="latest">current version</option>
              <option value="any">any version</option>
            </select>
          </label>
          {depsOptions.mode === 'latest' && (
            <>
              {DEP_KINDS.map((k) => (
                <label key={k} className="opt" title={`${k} dependencies`}>
                  <input
                    type="checkbox"
                    checked={depsOptions.kinds[k]}
                    onChange={(e) => onDepsOptionsChange({ ...depsOptions, kinds: { ...depsOptions.kinds, [k]: e.target.checked } })}
                  />{' '}
                  {k}
                </label>
              ))}
              <label className="opt" title="Include optional (feature-gated) dependencies; they are drawn fainter">
                <input type="checkbox" checked={depsOptions.optional} onChange={(e) => onDepsOptionsChange({ ...depsOptions, optional: e.target.checked })} /> optional
              </label>
            </>
          )}
          <label className="opt" title="Hops fetched up front; expand a crate for more">
            depth
            <input
              type="number"
              min={1}
              max={8}
              value={depsOptions.depth}
              onChange={(e) => onDepsOptionsChange({ ...depsOptions, depth: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })}
              className="limit"
            />
          </label>
          <label className="opt" title="Most crates drawn; the best-downloaded ones are kept and the rest show as +N">
            max crates
            <input
              type="number"
              min={20}
              max={2000}
              step={50}
              value={depsOptions.limit}
              onChange={(e) => onDepsOptionsChange({ ...depsOptions, limit: Math.min(2000, Math.max(20, Number(e.target.value) || 20)) })}
              className="limit wide"
            />
          </label>
        </>
      )}

      {view === 'default' && (
      <>
      <label className="opt" title="Crates the latest version's compiled code calls into (red when not a declared dependency)">
        <input type="checkbox" checked={options.invokes} onChange={(e) => set('invokes', e.target.checked)} /> calls
      </label>
      <label className="opt" title="Also load the 25 most-downloaded crates that depend on it (left side)">
        <input type="checkbox" checked={options.dependents} onChange={(e) => set('dependents', e.target.checked)} /> dependents
      </label>
      </>
      )}

      <span className="spacer" />

      {!isTableView(view) && (
      <>
      {view !== 'deps' && view !== 'map' && (
      <label className="opt">
        layout
        <select value={layout} onChange={(e) => onLayoutChange(e.target.value)}>
          {view === 'default' && <option value="free">radial</option>}
          <option value="forceDirected">force directed</option>
          <option value="d3Force">d3 force</option>
          <option value="hierarchical">hierarchical</option>
          <option value="circular">circular</option>
          <option value="grid">grid</option>
        </select>
      </label>
      )}
      <button onClick={onFit}>Fit</button>
      <button onClick={onClear} className="danger">
        Clear
      </button>
      </>
      )}
      </div>
    </div>
  );
}
