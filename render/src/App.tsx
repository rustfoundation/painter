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
  type GraphRel,
  type Health,
  type OverviewMeta,
  type OverviewPart,
  type Stats,
  type View,
} from './api';
import { emptyStore, isCrate, isVersion, mergePayload, removeNode, toNvl, type GraphStore } from './graph';
import { DEFAULT_DEPS_OPTIONS, type DepsOptions, type DepsStatus } from './deps';
import { clearOverviewLayout, mergeOverview, overviewLabels, placeOverview, shownCount, toNvlOverview } from './overview';
import { OverviewLabels } from './components/OverviewLabels';
import { useIsMobile, useTouchZoomPan } from './touch';
import { Toolbar } from './components/Toolbar';
import { DetailsPanel } from './components/DetailsPanel';
import { CypherPanel } from './components/CypherPanel';
import { StatusBar } from './components/StatusBar';
import { MapView } from './components/MapView';
import { DepsView } from './components/DepsView';
import { CallersView } from './components/CallersView';
import { UnsafeView } from './components/UnsafeView';
import { BuildView } from './components/BuildView';
import { NativeView } from './components/NativeView';
import { DiffsView } from './components/DiffsView';
import { PublishersView } from './components/PublishersView';
import { ReleasesView } from './components/ReleasesView';
import { SupplyView } from './components/SupplyView';

const DEFAULT_OPTIONS: CrateLoadOptions = { versions: 'latest', deps: true, invokes: true, dependents: false, limit: 200 };

const errorMessage = (err: unknown): string => {
  if (err instanceof ApiError) return err.code ? `${err.message} [${err.code}]` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
};

export function App() {
  const nvlRef = useRef<NVL>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  useTouchZoomPan(canvasEl, nvlRef);
  // On a phone the details sheet covers the canvas, so a fresh load leaves nothing selected there.
  const isMobile = useIsMobile();
  const [store, setStore] = useState<GraphStore>(emptyStore);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [options, setOptions] = useState<CrateLoadOptions>(DEFAULT_OPTIONS);
  // The Default view lays nodes out itself (src/overview.ts) on NVL's free layout; other graph views simulate.
  const [layout, setLayout] = useState<string>('free');
  const [overviewMeta, setOverviewMeta] = useState<(OverviewMeta & { elapsedMs: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [hiddenRelTypes, setHiddenRelTypes] = useState<Set<string>>(new Set());
  const [showRelCaptions, setShowRelCaptions] = useState(false);
  const [view, setView] = useState<View>('default');
  const [depsOptions, setDepsOptions] = useState<DepsOptions>(DEFAULT_DEPS_OPTIONS);
  const [depsTarget, setDepsTarget] = useState<{ name: string; nonce: number } | null>(null);
  const [depsStatus, setDepsStatus] = useState<DepsStatus | null>(null);
  const [mapTarget, setMapTarget] = useState<{ name: string; nonce: number } | null>(null);
  const [mapBudget, setMapBudget] = useState(600);
  const [mapMeta, setMapMeta] = useState<{ mode: string; level: number; inView: number; total: number; nodes: number; rels: number; elapsedMs: number } | null>(null);
  const [publisherTarget, setPublisherTarget] = useState<{ login: string; nonce: number } | null>(null);

  const fitAll = useCallback(() => {
    const nvl = nvlRef.current;
    if (!nvl) return;
    const ids = nvl.getNodes().map((n) => n.id);
    if (ids.length) nvl.fit(ids, { animated: true });
  }, []);

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

  // Resolved name: the server accepts partial input ("serd" loads "serde").
  const [loadedName, setLoadedName] = useState<string | null>(null);

  // Replaces the canvas: the overview is laid out around one root (src/overview.ts); expansions merge into it.
  const loadCrate = useCallback(
    async (input: string) => {
      setBusy(true);
      setError(null);
      try {
        const parts: OverviewPart[] = ['deps', 'versions'];
        if (options.invokes) parts.push('calls');
        if (options.dependents) parts.push('dependents');
        const payload = await api.overview({ name: input, parts, root: true });
        const name = payload.meta.resolvedName ?? input;
        setLoadedName(name);
        setOverviewMeta(payload.meta.overview ? { ...payload.meta.overview, elapsedMs: payload.meta.elapsedMs } : null);
        const crate = payload.nodes.find((n) => n.labels.includes('Crate') && n.properties.name === name);
        clearOverviewLayout();
        const next = mergePayload(emptyStore(), payload, name);
        placeOverview(next, crate?.id ?? null);
        setStore(next);
        setSelectedId(isMobile ? null : (crate?.id ?? null));
        window.setTimeout(fitAll, 150);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [options, fitAll, isMobile],
  );

  // One bounded part (deps / versions / calls / dependents) of one crate, hung off its node (or one of its
  // version nodes when `version` is given) and placed away from the root.
  const expandOverview = useCallback(
    async (name: string, part: OverviewPart, opts: { version?: string } = {}) => {
      setBusy(true);
      setError(null);
      try {
        const skip = part === 'versions' || part === 'dependents' ? shownCount(store, name, part) : 0;
        const payload = await api.overview({ name, parts: [part], version: opts.version ?? null, from: opts.version ? 'version' : 'crate', skip });
        const anchor = opts.version
          ? payload.nodes.find((n) => isVersion(n) && n.properties.name === name && n.properties.version === opts.version)
          : payload.nodes.find((n) => isCrate(n) && n.properties.name === name);
        setStore((s) => {
          const next = mergeOverview(s, payload);
          placeOverview(next, anchor?.id ?? null);
          return next;
        });
        if (payload.nodes.length <= 1 && payload.rels.length === 0) {
          setError(`${name}${opts.version ? `@${opts.version}` : ''}: nothing more to add for ${part}`);
        }
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [store],
  );

  const switchView = useCallback(
    (next: View) => {
      if (next === view) return;
      setView(next);
      setStore(emptyStore());
      setSelectedId(null);
      setError(null);
      setDepsStatus(null);
      setOverviewMeta(null);
      clearOverviewLayout();
      setLayout((l) => (next === 'default' ? 'free' : l === 'free' ? 'forceDirected' : l));
    },
    [view],
  );

  const load = useCallback(
    (input: string) => {
      if (view === 'map') {
        setMapTarget({ name: input, nonce: Date.now() });
        return Promise.resolve();
      }
      if (view === 'deps') {
        setDepsTarget({ name: input, nonce: Date.now() });
        return Promise.resolve();
      }
      return loadCrate(input);
    },
    [view, loadCrate],
  );

  const openInDeps = useCallback((name: string) => {
    setView('deps');
    setStore(emptyStore());
    setSelectedId(null);
    setError(null);
    setDepsTarget({ name, nonce: Date.now() });
  }, []);

  const openInGraph = useCallback(
    (name: string) => {
      setView('default');
      setStore(emptyStore());
      setSelectedId(null);
      setError(null);
      setLayout('free');
      void loadCrate(name);
    },
    [loadCrate],
  );

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
      setStore((s) => {
        const next = mergePayload(s, payload);
        // The Default view's free layout needs coordinates for owners / uploaders too.
        if (view === 'default') placeOverview(next, id);
        return next;
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [view]);

  const runCypher = useCallback(async (query: string) => {
    setBusy(true);
    setError(null);
    try {
      const payload = await api.cypher(query);
      setStore((s) => {
        const next = mergePayload(s, payload);
        // The free layout needs coordinates; ring the newcomers around whatever is drawn.
        if (view === 'default') placeOverview(next, null);
        return next;
      });
      window.setTimeout(fitAll, 400);
      return payload;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [fitAll, view]);

  const remove = useCallback((id: string) => {
    setStore((s) => removeNode(s, id));
    setSelectedId((sel) => (sel === id ? null : sel));
  }, []);

  const clear = useCallback(() => {
    setStore(emptyStore());
    setSelectedId(null);
    setError(null);
    setOverviewMeta(null);
    clearOverviewLayout();
  }, []);

  const { nodes, rels } = useMemo(
    () =>
      view === 'default'
        ? toNvlOverview(store, selectedId, { showRelCaptions, hiddenRelTypes })
        : toNvl(store, selectedId, { showRelCaptions, hiddenRelTypes }),
    [store, selectedId, showRelCaptions, hiddenRelTypes, view],
  );
  const labelSpecs = useMemo(() => (view === 'default' ? overviewLabels(store, overviewMeta?.version ?? null) : []), [store, view, overviewMeta]);

  const selected: GraphNode | GraphRel | null = selectedId ? (store.nodes.get(selectedId) ?? store.rels.get(selectedId) ?? null) : null;

  // Debug hook for headless checks.
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
        const n = store.nodes.get(node.id);
        if (view === 'default' && n && isCrate(n)) {
          void expandOverview(String(n.properties.name), 'deps');
        } else if (view === 'default' && n && isVersion(n)) {
          void expandOverview(String(n.properties.name), 'deps', { version: String(n.properties.version) });
        } else {
          void expand(node.id, 'both', []);
        }
      },
      onHover: true,
      onPan: true,
      // Key must be `onZoomAndPan`; any other name leaves NVL zoom unattached.
      onZoomAndPan: true,
      onDrag: true,
    }),
    [expand, expandOverview, view, store],
  );

  return (
    <div className="app">
      <Toolbar
        view={view}
        onViewChange={switchView}
        depsOptions={depsOptions}
        onDepsOptionsChange={setDepsOptions}
        mapBudget={mapBudget}
        onMapBudgetChange={setMapBudget}
        options={options}
        onOptionsChange={setOptions}
        onLoad={(n) => void load(n)}
        loadedName={loadedName}
        onClear={clear}
        onFit={fitAll}
        layout={layout}
        onLayoutChange={setLayout}
        busy={busy}
      />
      <div className="main">
        {view === 'callers' ? (
          <CallersView busy={busy} onBusy={setBusy} onError={setError} onOpenCrate={openInGraph} onOpenDeps={openInDeps} />
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
        ) : view === 'deps' ? (
          <DepsView
            target={depsTarget}
            options={depsOptions}
            onOptionsChange={setDepsOptions}
            onBusy={setBusy}
            onError={setError}
            onStatus={setDepsStatus}
            onRootChange={setLoadedName}
            onOpenInGraph={openInGraph}
          />
        ) : (
        <>
        <div className="canvas" ref={setCanvasEl}>
          {nodes.length === 0 ? (
            <div className="empty">
              <h1>crate overview</h1>
              <p>
                {busy
                  ? 'Loading…'
                  : 'Type a crate name and press Load. You get the crate in the middle, what its latest version depends on to the right (normal deps inside, build / dev outside, dimmer when optional, thicker when its code calls into them), its newest versions along the bottom, and, with the dependents option, the biggest crates that use it on the left.'}
              </p>
              <p className="muted">
                Click anything for details and bounded next steps (dependencies, dependents, older versions, calls, owners);
                double-click a crate or version to add its dependencies. The Cypher panel below merges any read query into the
                canvas.
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
          <OverviewLabels nvlRef={nvlRef} specs={labelSpecs} active={view === 'default'} />
        </div>
        <aside className={`sidebar${selected ? ' has-selection' : ''}`}>
          {selected && (
            <button type="button" className="sheet-close" aria-label="Close details" onClick={() => setSelectedId(null)}>
              ×
            </button>
          )}
          <DetailsPanel
            view={view}
            selected={selected}
            nodeById={(id) => store.nodes.get(id)}
            onExpand={(id, dir, types) => void expand(id, dir, types)}
            onOverview={(name, part, o) => void expandOverview(name, part, o)}
            shownCount={(name, part) => shownCount(store, name, part)}
            onRemove={remove}
            onLoadCrate={(n) => void loadCrate(n)}
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
        depsStatus={depsStatus}
        overviewMeta={overviewMeta}
        mapMeta={mapMeta}
        health={health}
        healthError={healthError}
        stats={stats}
        nodeCount={view === 'map' ? (mapMeta?.nodes ?? 0) : view === 'deps' ? (depsStatus?.nodes ?? 0) : nodes.length}
        relCount={view === 'map' ? (mapMeta?.rels ?? 0) : view === 'deps' ? (depsStatus?.edges ?? 0) : rels.length}
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
