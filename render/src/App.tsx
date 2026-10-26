import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type NVL from '@neo4j-nvl/base';
import type { Node as NvlNode, Relationship as NvlRel, NvlOptions, Layout } from '@neo4j-nvl/base';
import { InteractiveNvlWrapper, type MouseEventCallbacks } from '@neo4j-nvl/react';
import {
  api,
  ApiError,
  type CrateLoadOptions,
  type ExpandType,
  type GraphNode,
  type GraphPayload,
  type GraphRel,
  type Health,
  type Stats,
  type View,
} from './api';
import { emptyStore, mergePayload, removeNode, toNvl, type GraphStore } from './graph';
import { Toolbar } from './components/Toolbar';
import { DetailsPanel } from './components/DetailsPanel';
import { CypherPanel } from './components/CypherPanel';
import { StatusBar } from './components/StatusBar';
import { MapView } from './components/MapView';
import { CallersView } from './components/CallersView';
import { UnsafeView } from './components/UnsafeView';
import { BuildView } from './components/BuildView';
import { NativeView } from './components/NativeView';
import { DiffsView } from './components/DiffsView';
import { PublishersView } from './components/PublishersView';
import { ReleasesView } from './components/ReleasesView';
import { SupplyView } from './components/SupplyView';

const DEFAULT_OPTIONS: CrateLoadOptions = { versions: 'latest', deps: true, invokes: true, dependents: false, limit: 200 };
const DEFAULT_DEPS_LIMIT = 5000;

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
  const [view, setView] = useState<View>('default');
  const [depsLimit, setDepsLimit] = useState(DEFAULT_DEPS_LIMIT);
  /** Deps view: max hops from the roots, 0 = unlimited. */
  const [depsDepth, setDepsDepth] = useState(0);
  /** meta of the last deps-view load, for the status bar. */
  const [depsMeta, setDepsMeta] = useState<GraphPayload['meta'] | null>(null);
  /** Map view: crate to jump to, element budget per viewport, last viewport meta. */
  const [mapTarget, setMapTarget] = useState<{ name: string; nonce: number } | null>(null);
  const [mapBudget, setMapBudget] = useState(600);
  const [mapMeta, setMapMeta] = useState<{ mode: string; level: number; inView: number; total: number; nodes: number; rels: number; elapsedMs: number } | null>(null);
  /** Publishers view: login to open, set from the details panel and the other registry views. */
  const [publisherTarget, setPublisherTarget] = useState<{ login: string; nonce: number } | null>(null);

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

  // Name of the crate the last load resolved to (partial input like "serd" loads "serde").
  const [loadedName, setLoadedName] = useState<string | null>(null);

  // Load a crate's neighbourhood from the toolbar (or "Load crate" in details).
  // The server accepts partial names and reports the crate it picked.
  const loadCrate = useCallback(
    async (input: string) => {
      setBusy(true);
      setError(null);
      try {
        const payload = await api.loadCrate(input, options);
        const name = payload.meta.resolvedName ?? input;
        setLoadedName(name);
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

  // Deps view: crate-level graph. `crate` null loads the whole (capped) graph.
  const loadDeps = useCallback(
    async (crate: string | null, direction: 'in' | 'out' | 'both' = 'both', replace = false) => {
      setBusy(true);
      setError(null);
      try {
        const payload = await api.loadDeps(crate, direction, depsLimit);
        const name = payload.meta.resolvedName ?? crate ?? null;
        if (name) setLoadedName(name);
        setDepsMeta(payload.meta);
        setStore((s) => mergePayload(replace ? emptyStore() : s, payload, name ?? undefined));
        if (name) {
          const node = payload.nodes.find((n) => n.labels.includes('Crate') && n.properties.name === name);
          if (node) setSelectedId(node.id);
        } else {
          setSelectedId(null);
        }
        window.setTimeout(fitAll, 600);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [depsLimit, fitAll],
  );

  // Deps view: full transitive dependency chain of every crate matching the filter.
  // Replaces the canvas; expansions from the details panel merge via loadDeps.
  const loadChain = useCallback(
    async (q: string, exact = false) => {
      setBusy(true);
      setError(null);
      try {
        const payload = await api.loadDepsChain(q, depsLimit, depsDepth, exact);
        setDepsMeta(payload.meta);
        let next = emptyStore();
        for (const r of payload.meta.roots ?? []) next.roots.add(r);
        next = mergePayload(next, payload);
        setStore(next);
        setLoadedName(null);
        const roots = payload.meta.roots ?? [];
        const single = roots.length === 1 ? payload.nodes.find((n) => n.properties.name === roots[0]) : undefined;
        setSelectedId(single?.id ?? null);
        window.setTimeout(fitAll, 600);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [depsLimit, depsDepth, fitAll],
  );

  // Switching views starts from an empty canvas.
  const switchView = useCallback(
    (next: View) => {
      if (next === view) return;
      setView(next);
      setStore(emptyStore());
      setSelectedId(null);
      setError(null);
      setDepsMeta(null);
    },
    [view],
  );

  /** Toolbar Load: per-view behaviour. */
  const load = useCallback(
    (input: string, exact = false) => {
      if (view === 'map') {
        setMapTarget({ name: input, nonce: Date.now() });
        return Promise.resolve();
      }
      return view === 'deps' ? loadChain(input, exact) : loadCrate(input);
    },
    [view, loadChain, loadCrate],
  );

  /** From the map: switch to Deps and draw the chain of one crate. */
  const openInDeps = useCallback(
    (name: string) => {
      setView('deps');
      setStore(emptyStore());
      setSelectedId(null);
      setError(null);
      setDepsMeta(null);
      // loadChain reads view-independent state, so it can run right after the switch.
      void loadChain(name, true);
    },
    [loadChain],
  );

  /** From the Unsafe / Build scripts / Native code / Diffs views: switch to Default and load one crate. */
  const openInGraph = useCallback(
    (name: string) => {
      setView('default');
      setStore(emptyStore());
      setSelectedId(null);
      setError(null);
      void loadCrate(name);
    },
    [loadCrate],
  );

  /** From anywhere: switch to Publishers and open one crates.io login. */
  const openUser = useCallback((login: string) => {
    setView('publishers');
    setError(null);
    setPublisherTarget({ login, nonce: Date.now() });
  }, []);

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

  // Debug hook for headless checks (same name the Map view uses).
  useEffect(() => {
    (window as unknown as { __painterNvl?: unknown }).__painterNvl = nvlRef.current;
  });

  const nvlOptions = useMemo<NvlOptions>(
    () => ({
      layout: layout as Layout,
      renderer: 'canvas',
      initialZoom: 1,
      minZoom: 0.05,
      maxZoom: 20,
      allowDynamicMinZoom: true,
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
      onNodeDoubleClick: (node: NvlNode) => {
        if (view === 'deps') {
          const n = store.nodes.get(node.id);
          if (n) void loadDeps(String(n.properties.name), 'both');
        } else {
          void expand(node.id, 'both', []);
        }
      },
      onHover: true,
      onPan: true,
      // Mouse-wheel / pinch zoom. The key must be `onZoomAndPan`; any other
      // name leaves NVL's zoom interaction unattached.
      onZoomAndPan: true,
      onDrag: true,
    }),
    [expand, view, store, loadDeps],
  );

  return (
    <div className="app">
      <Toolbar
        view={view}
        onViewChange={switchView}
        depsLimit={depsLimit}
        depsMaxLimit={health?.config.depsMaxEdges ?? 50_000}
        onDepsLimitChange={setDepsLimit}
        depsDepth={depsDepth}
        onDepsDepthChange={setDepsDepth}
        mapBudget={mapBudget}
        onMapBudgetChange={setMapBudget}
        options={options}
        onOptionsChange={setOptions}
        onLoad={(n, exact) => void load(n, exact)}
        loadedName={loadedName}
        onClear={clear}
        onFit={fitAll}
        layout={layout}
        onLayoutChange={setLayout}
        busy={busy}
      />
      <div className="main">
        {view === 'callers' ? (
          <CallersView busy={busy} onBusy={setBusy} onError={setError} />
        ) : view === 'unsafe' ? (
          <UnsafeView busy={busy} onBusy={setBusy} onError={setError} onOpenCrate={openInGraph} />
        ) : view === 'build' ? (
          <BuildView busy={busy} onBusy={setBusy} onError={setError} onOpenCrate={openInGraph} />
        ) : view === 'native' ? (
          <NativeView busy={busy} onBusy={setBusy} onError={setError} onOpenCrate={openInGraph} />
        ) : view === 'diffs' ? (
          <DiffsView busy={busy} onBusy={setBusy} onError={setError} onOpenCrate={openInGraph} />
        ) : view === 'publishers' ? (
          <PublishersView busy={busy} onBusy={setBusy} onError={setError} onOpenCrate={openInGraph} onOpenUser={openUser} target={publisherTarget} />
        ) : view === 'releases' ? (
          <ReleasesView busy={busy} onBusy={setBusy} onError={setError} onOpenCrate={openInGraph} onOpenUser={openUser} />
        ) : view === 'supply' ? (
          <SupplyView busy={busy} onBusy={setBusy} onError={setError} onOpenCrate={openInGraph} onOpenUser={openUser} />
        ) : view === 'map' ? (
          <MapView
            target={mapTarget}
            budget={mapBudget}
            onError={setError}
            onBusy={setBusy}
            onOpenInDeps={openInDeps}
            onMeta={setMapMeta}
          />
        ) : (
        <>
        <div className="canvas">
          {nodes.length === 0 && view === 'deps' ? (
            <div className="empty">
              <h1>crate dependency chain</h1>
              <p>
                {busy
                  ? 'Resolving the transitive dependency chain…'
                  : 'Type a crate name and press Load to draw its full transitive dependency chain. If no crate has exactly that name, 3 or more characters make every crate whose name contains the text a root.'}
              </p>
              <p className="muted">
                Versions are folded into their crate: an edge A → B means some version of A depends on B. Max edges and max depth
                (0 = unlimited) bound the chain.
              </p>
            </div>
          ) : nodes.length === 0 ? (
            <div className="empty">
              <h1>painter graph</h1>
              <p>
                Type part of a crate name above and press Load. Partial names match anywhere in the name and load the
                closest crate, with its versions and their dependency / invocation edges.
              </p>
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
            view={view}
            onExpandDeps={(name, dir) => void loadDeps(name, dir)}
            selected={selected}
            nodeById={(id) => store.nodes.get(id)}
            onExpand={(id, dir, types) => void expand(id, dir, types)}
            onRemove={remove}
            onLoadCrate={(n) => void (view === 'deps' ? loadChain(n, true) : loadCrate(n))}
            onOpenUser={openUser}
            busy={busy}
          />
        </aside>
        </>
        )}
      </div>
      <CypherPanel enabled={health?.config.allowCypher ?? true} busy={busy} onRun={runCypher} />
      <StatusBar
        view={view}
        depsMeta={depsMeta}
        mapMeta={mapMeta}
        health={health}
        healthError={healthError}
        stats={stats}
        nodeCount={view === 'map' ? (mapMeta?.nodes ?? 0) : nodes.length}
        relCount={view === 'map' ? (mapMeta?.rels ?? 0) : rels.length}
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
