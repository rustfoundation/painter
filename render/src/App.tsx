import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type NVL from '@neo4j-nvl/base';
import type { Node as NvlNode, Relationship as NvlRel, NvlOptions, Layout } from '@neo4j-nvl/base';
import { InteractiveNvlWrapper, type MouseEventCallbacks } from '@neo4j-nvl/react';
import { api, ApiError, type CrateLoadOptions, type ExpandType, type GraphNode, type GraphRel, type Health, type Stats } from './api';
import { emptyStore, mergePayload, removeNode, toNvl, type GraphStore } from './graph';
import { Toolbar } from './components/Toolbar';
import { DetailsPanel } from './components/DetailsPanel';
import { CypherPanel } from './components/CypherPanel';
import { StatusBar } from './components/StatusBar';

const DEFAULT_OPTIONS: CrateLoadOptions = { versions: 'latest', deps: true, invokes: true, dependents: false, limit: 200 };

const errorMessage = (err: unknown): string => {
  if (err instanceof ApiError) return err.code ? `${err.message} [${err.code}]` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
};

export function App() {
  const nvlRef = useRef<NVL>(null);
  const [store, setStore] = useState<GraphStore>(emptyStore);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [options, setOptions] = useState<CrateLoadOptions>(DEFAULT_OPTIONS);
  const [layout, setLayout] = useState<string>('forceDirected');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [hiddenRelTypes, setHiddenRelTypes] = useState<Set<string>>(new Set());
  const [showRelCaptions, setShowRelCaptions] = useState(false);

  const fitAll = useCallback(() => {
    const nvl = nvlRef.current;
    if (!nvl) return;
    const ids = nvl.getNodes().map((n) => n.id);
    if (ids.length) nvl.fit(ids, { animated: true });
  }, []);

  // Health / stats polling for the status bar.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const h = await api.health();
        if (cancelled) return;
        setHealth(h);
        setHealthError(null);
        if (h.ok && !stats) api.stats().then((s) => !cancelled && setStats(s)).catch(() => undefined);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 503) {
          // Server up, Neo4j down: the body is still a Health payload.
          api.health().catch(() => undefined);
        }
        setHealth(null);
        setHealthError(errorMessage(err));
      }
    };
    void tick();
    const id = window.setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load a crate's neighbourhood from the toolbar (or "Load crate" in details).
  const loadCrate = useCallback(
    async (name: string) => {
      setBusy(true);
      setError(null);
      try {
        const payload = await api.loadCrate(name, options);
        setStore((s) => mergePayload(s, payload, name));
        const crate = payload.nodes.find((n) => n.labels.includes('Crate') && n.properties.name === name);
        if (crate) setSelectedId(crate.id);
        window.setTimeout(fitAll, 400);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [options, fitAll],
  );

  const expand = useCallback(async (id: string, direction: 'in' | 'out' | 'both', types: ExpandType[]) => {
    setBusy(true);
    setError(null);
    try {
      const payload = await api.expand(id, direction, types, 100);
      setStore((s) => mergePayload(s, payload));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const runCypher = useCallback(async (query: string) => {
    setBusy(true);
    setError(null);
    try {
      const payload = await api.cypher(query);
      setStore((s) => mergePayload(s, payload));
      window.setTimeout(fitAll, 400);
      return payload;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [fitAll]);

  const remove = useCallback((id: string) => {
    setStore((s) => removeNode(s, id));
    setSelectedId((sel) => (sel === id ? null : sel));
  }, []);

  const clear = useCallback(() => {
    setStore(emptyStore());
    setSelectedId(null);
    setError(null);
  }, []);

  const { nodes, rels } = useMemo(
    () => toNvl(store, selectedId, { showRelCaptions, hiddenRelTypes }),
    [store, selectedId, showRelCaptions, hiddenRelTypes],
  );

  const selected: GraphNode | GraphRel | null = selectedId ? (store.nodes.get(selectedId) ?? store.rels.get(selectedId) ?? null) : null;

  const nvlOptions = useMemo<NvlOptions>(
    () => ({
      layout: layout as Layout,
      renderer: 'canvas',
      initialZoom: 1,
      styling: {
        defaultNodeColor: '#888888',
        defaultRelationshipColor: '#666666',
        selectedBorderColor: '#ffffff',
        selectedInnerBorderColor: '#111111',
        dropShadowColor: 'rgba(0,0,0,0.5)',
      },
    }),
    [layout],
  );

  const mouseEventCallbacks = useMemo<MouseEventCallbacks>(
    () => ({
      onNodeClick: (node: NvlNode) => setSelectedId(node.id),
      onRelationshipClick: (rel: NvlRel) => setSelectedId(rel.id),
      onCanvasClick: () => setSelectedId(null),
      onNodeDoubleClick: (node: NvlNode) => void expand(node.id, 'both', []),
      onHover: true,
      onPan: true,
      onZoom: true,
      onDrag: true,
    }),
    [expand],
  );

  return (
    <div className="app">
      <Toolbar
        options={options}
        onOptionsChange={setOptions}
        onLoad={(n) => void loadCrate(n)}
        onClear={clear}
        onFit={fitAll}
        layout={layout}
        onLayoutChange={setLayout}
        busy={busy}
      />
      <div className="main">
        <div className="canvas">
          {nodes.length === 0 ? (
            <div className="empty">
              <h1>painter graph</h1>
              <p>Search for a crate above to load it, its versions, and their dependency / invocation edges.</p>
              <p className="muted">
                Or open the Cypher panel at the bottom and run any read query: every node and relationship in the result is
                drawn.
              </p>
            </div>
          ) : null}
          <InteractiveNvlWrapper
            ref={nvlRef}
            nodes={nodes}
            rels={rels}
            nvlOptions={nvlOptions}
            mouseEventCallbacks={mouseEventCallbacks}
            interactionOptions={{ selectOnClick: false }}
            onInitializationError={(e) => setError(`NVL failed to initialise: ${errorMessage(e)}`)}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
        <aside className="sidebar">
          <DetailsPanel
            selected={selected}
            nodeById={(id) => store.nodes.get(id)}
            onExpand={(id, dir, types) => void expand(id, dir, types)}
            onRemove={remove}
            onLoadCrate={(n) => void loadCrate(n)}
            busy={busy}
          />
        </aside>
      </div>
      <CypherPanel enabled={health?.config.allowCypher ?? true} busy={busy} onRun={runCypher} />
      <StatusBar
        health={health}
        healthError={healthError}
        stats={stats}
        nodeCount={nodes.length}
        relCount={rels.length}
        hiddenRelTypes={hiddenRelTypes}
        onToggleRelType={(t) =>
          setHiddenRelTypes((h) => {
            const next = new Set(h);
            if (next.has(t)) next.delete(t);
            else next.add(t);
            return next;
          })
        }
        showRelCaptions={showRelCaptions}
        onToggleRelCaptions={() => setShowRelCaptions((v) => !v)}
        error={error}
      />
    </div>
  );
}
