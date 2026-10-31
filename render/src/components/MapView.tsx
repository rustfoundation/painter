// NVL free layout: positions are exactly the server's. Screen <-> layout mapping is
// calibrated from NVL zoom/pan, not node client positions (they lag a frame behind pans).
// NVL draws the landmark crates (hit testing, zoom/pan, touch); a Canvas2D overlay on top
// (mapOverlay.ts) draws density, community blobs and labels, and the selection halo.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type NVL from '@neo4j-nvl/base';
import type { Node as NvlNode, Relationship as NvlRel, NvlOptions } from '@neo4j-nvl/base';
import { InteractiveNvlWrapper, type MouseEventCallbacks } from '@neo4j-nvl/react';
import { api, ApiError, type GraphNode, type LodBounds, type LodCommunity, type LodNeighbours, type LodStatus, type LodViewport } from '../api';
import { drawOverlay, makeColorOf, pulseActive } from '../mapOverlay';
import { useIsMobile, useTouchZoomPan } from '../touch';

const MAP_PX = 6000;
const FETCH_DEBOUNCE_MS = 150;
/** Fetch a bbox this much larger than the screen so small pans do not refetch. */
const VIEW_MARGIN = 0.25;
/** NVL draws a node roughly this many screen px per unit of `size` at zoom 1 (measured). */
const NVL_SIZE_PX = 2.75;
/** Landmark edges are only drawn when there are few enough to read; otherwise only the selection's. */
const EDGE_SHOW_MAX = 220;
const NEIGHBOUR_LIMIT = 40;
const LEGEND_SIZE = 16;
/** Edges are drawn by the overlay, never by NVL. */
const NO_RELS: NvlRel[] = [];

const compact = (n: number) =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)}B` : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

/** Minimum on-screen spacing between landmarks for a density preset (toolbar: sparse / normal / dense). */
const spacingFor = (budget: number) => (budget <= 300 ? 76 : budget <= 800 ? 52 : 36);

type Props = {
  /** Crate to jump to; a new object each time the user asks. */
  target: { name: string; nonce: number } | null;
  budget: number;
  onError: (message: string | null) => void;
  onBusy: (busy: boolean) => void;
  onOpenInDeps: (name: string) => void;
  onMeta: (m: { mode: string; level: number; inView: number; total: number; nodes: number; rels: number; elapsedMs: number } | null) => void;
};

interface Calibration {
  scale: number;
  offsetX: number;
  offsetY: number;
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));

export function MapView({ target, budget, onError, onBusy, onOpenInDeps, onMeta }: Props) {
  const nvlRef = useRef<NVL>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const canvasRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    setCanvasEl(el);
  }, []);
  useTouchZoomPan(canvasEl, nvlRef);
  const isMobile = useIsMobile();
  const [status, setStatus] = useState<LodStatus | null>(null);
  const [payload, setPayload] = useState<LodViewport | null>(null);
  const [communities, setCommunities] = useState<LodCommunity[] | null>(null);
  /** The selected crate as last known (from a landmark, a locate, or a neighbour row). */
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [neighbours, setNeighbours] = useState<LodNeighbours | null>(null);
  const [iterations, setIterations] = useState<number>(300);
  /** NVL zoom at the time of the last fetch; sizes are divided by it so they stay constant on screen. */
  const [viewScale, setViewScale] = useState(1);
  const [reuseEdges, setReuseEdges] = useState(true);
  const [resume, setResume] = useState(true);
  const boundsRef = useRef<LodBounds | null>(null);
  const coreRef = useRef<LodBounds | null>(null);
  const calib = useRef<Calibration | null>(null);
  const debounce = useRef<number | undefined>(undefined);
  const lastBbox = useRef<string>('');
  const inflight = useRef<AbortController | null>(null);
  /** False until the first payload has been centred; polling waits for it. */
  const centeredRef = useRef(false);
  const pulseRef = useRef<number | null>(null);
  const sceneDirty = useRef(true);

  const colorOf = useMemo(() => makeColorOf(communities), [communities]);

  const toPx = useCallback((x: number, y: number) => {
    const b = boundsRef.current!;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    return { px: ((x - b.minX) / span) * MAP_PX, py: ((y - b.minY) / span) * MAP_PX };
  }, []);
  const fromPx = useCallback((px: number, py: number) => {
    const b = boundsRef.current!;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    return { x: b.minX + (px / MAP_PX) * span, y: b.minY + (py / MAP_PX) * span };
  }, []);

  // NVL draws a node at client = x * zoom + w/2 - panX * zoom (pan = layout point at screen centre).
  const calibrate = useCallback(() => {
    const nvl = nvlRef.current;
    const el = containerRef.current;
    if (!nvl || !el) return calib.current;
    const scale = nvl.getScale();
    const pan = nvl.getPan?.();
    if (!Number.isFinite(scale) || scale <= 0 || !pan) return calib.current;
    calib.current = { scale, offsetX: el.clientWidth / 2 - pan.x * scale, offsetY: el.clientHeight / 2 - pan.y * scale };
    // Debug hook for headless checks: window.__painterMap / __painterNvl.
    (window as unknown as { __painterNvl?: unknown }).__painterNvl = nvl;
    (window as unknown as { __painterMap?: unknown }).__painterMap = {
      scale,
      pan,
      container: { w: el.clientWidth, h: el.clientHeight },
      calib: calib.current,
    };
    return calib.current;
  }, []);

  const screenBbox = useCallback(() => {
    const c = calibrate();
    const el = containerRef.current;
    if (!c || !el || !boundsRef.current) return null;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const mx = w * VIEW_MARGIN;
    const my = h * VIEW_MARGIN;
    const p0 = fromPx((-mx - c.offsetX) / c.scale, (-my - c.offsetY) / c.scale);
    const p1 = fromPx((w + mx - c.offsetX) / c.scale, (h + my - c.offsetY) / c.scale);
    return { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
  }, [calibrate, fromPx]);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await api.lodStatus();
      setStatus(s);
      if (s.index) {
        boundsRef.current = s.index.bounds;
        coreRef.current = s.index.core ?? s.index.bounds;
      }
      return s;
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [onError]);

  /** Fit a layout-space box on screen. */
  const fitBox = useCallback(
    (box: { x0: number; y0: number; x1: number; y1: number }, fill = 0.9) => {
      const nvl = nvlRef.current;
      const el = containerRef.current;
      if (!nvl || !el || !boundsRef.current) return;
      const a = toPx(box.x0, box.y0);
      const b = toPx(box.x1, box.y1);
      const w = Math.max(Math.abs(b.px - a.px), 1);
      const h = Math.max(Math.abs(b.py - a.py), 1);
      const scale = Math.min(el.clientWidth / w, el.clientHeight / h) * fill;
      nvl.setZoomAndPan(scale, (a.px + b.px) / 2, (a.py + b.py) / 2);
      calibrate();
      lastBbox.current = '';
      sceneDirty.current = true;
    },
    [toPx, calibrate],
  );

  const fetchViewport = useCallback(
    async (bbox: { x0: number; y0: number; x1: number; y1: number }) => {
      const key = [bbox.x0, bbox.y0, bbox.x1, bbox.y1].map((v) => v.toPrecision(5)).join(',') + `:${budget}`;
      if (key === lastBbox.current) return;
      lastBbox.current = key;
      inflight.current?.abort();
      const ctrl = new AbortController();
      inflight.current = ctrl;
      onBusy(true);
      try {
        const scaleNow = calib.current?.scale ?? 1;
        const b = boundsRef.current;
        const span = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY) : 0;
        const minCell = b ? (spacingFor(budget) / scaleNow / MAP_PX) * span : 0;
        const p = await api.lodViewport(bbox, budget, minCell, EDGE_SHOW_MAX);
        if (ctrl.signal.aborted) return;
        boundsRef.current = p.meta.bounds;
        setViewScale(calib.current?.scale ?? 1);
        setPayload(p);
        sceneDirty.current = true;
        onError(null);
        onMeta({ mode: p.mode, level: p.level, inView: p.meta.inView, total: p.meta.total, nodes: p.nodes.length, rels: p.rels.length, elapsedMs: p.meta.elapsedMs });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.status === 503) {
          // Not built / loading: show the status panel instead of an error.
          void fetchStatus();
        } else onError(err instanceof Error ? err.message : String(err));
      } finally {
        if (inflight.current === ctrl) {
          inflight.current = null;
          onBusy(false);
        }
      }
    },
    [budget, fetchStatus, onBusy, onError, onMeta],
  );

  const scheduleViewportFetch = useCallback(() => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      const bbox = screenBbox();
      if (bbox) void fetchViewport(bbox);
    }, FETCH_DEBOUNCE_MS);
  }, [screenBbox, fetchViewport]);

  /** Open on the populated core of the map (the whole bounds are mostly the ring of isolated crates). */
  const showCore = useCallback(() => {
    const core = coreRef.current ?? boundsRef.current;
    if (!core) return;
    fitBox({ x0: core.minX, y0: core.minY, x1: core.maxX, y1: core.maxY }, 0.95);
    scheduleViewportFetch();
  }, [fitBox, scheduleViewportFetch]);

  const showWholeMap = useCallback(() => {
    const b = boundsRef.current;
    if (!b) return;
    fitBox({ x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY }, 0.92);
    scheduleViewportFetch();
  }, [fitBox, scheduleViewportFetch]);

  const startOnIndex = useCallback(async () => {
    centeredRef.current = false;
    lastBbox.current = '';
    try {
      const c = await api.lodCommunities();
      setCommunities(c.communities);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 503)) onError(err instanceof Error ? err.message : String(err));
    }
    // NVL needs a frame with a mounted canvas before setZoomAndPan sticks.
    window.setTimeout(() => {
      showCore();
      centeredRef.current = true;
    }, 150);
  }, [onError, showCore]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await fetchStatus();
      if (cancelled || !s?.index) return;
      await startOnIndex();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!status?.running && !status?.indexLoading) return;
    const id = window.setInterval(async () => {
      const s = await fetchStatus();
      if (s && !s.running && !s.indexLoading && s.index) void startOnIndex();
    }, 3000);
    return () => window.clearInterval(id);
  }, [status?.running, status?.indexLoading, fetchStatus, startOnIndex]);

  /** Select a crate by its node (landmark click or neighbour row) and load its neighbourhood. */
  const selectCrate = useCallback(
    (node: GraphNode | null) => {
      setSelected(node);
      setNeighbours(null);
      sceneDirty.current = true;
      if (!node) return;
      const name = String(node.properties.name);
      api
        .lodNeighbours(name, NEIGHBOUR_LIMIT)
        .then((n) => {
          setNeighbours((prev) => (String(n.crate.properties.name) === name ? n : prev));
          setSelected((prev) => (prev && String(prev.properties.name) === name ? n.crate : prev));
          sceneDirty.current = true;
        })
        .catch((err) => onError(err instanceof Error ? err.message : String(err)));
    },
    [onError],
  );

  /** Centre on a crate at neighbourhood zoom, select it, and pulse. */
  const jumpTo = useCallback(
    async (name: string) => {
      try {
        const hit = await api.lodLocate(name);
        const nvl = nvlRef.current;
        const el = containerRef.current;
        if (!nvl || !el || !boundsRef.current) return;
        const { px, py } = toPx(num(hit.x), num(hit.y));
        const scale = Math.max(2, Math.min(6, el.clientWidth / 500));
        // NVL pan = layout coordinate shown at the screen centre. On a phone the details sheet covers
        // the lower half, so put the crate in the upper part instead.
        nvl.setZoomAndPan(scale, px, py + (isMobile ? (el.clientHeight * 0.22) / scale : 0));
        calibrate();
        lastBbox.current = '';
        scheduleViewportFetch();
        pulseRef.current = performance.now();
        selectCrate({ id: `crate:${hit.name}`, labels: ['Crate'], properties: { ...hit } });
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [toPx, calibrate, scheduleViewportFetch, selectCrate, onError, isMobile],
  );

  useEffect(() => {
    if (!target) return;
    void jumpTo(target.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // Poll zoom/pan instead of relying on NVL callbacks; refetch when it settles.
  useEffect(() => {
    let last = '';
    const id = window.setInterval(() => {
      const nvl = nvlRef.current;
      if (!nvl || !boundsRef.current || !centeredRef.current) return;
      const pan = nvl.getPan?.();
      const key = `${nvl.getScale().toFixed(4)}:${pan?.x.toFixed(1)}:${pan?.y.toFixed(1)}`;
      if (key !== last) {
        last = key;
        scheduleViewportFetch();
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [scheduleViewportFetch]);

  useEffect(() => {
    lastBbox.current = '';
    if (boundsRef.current && centeredRef.current) scheduleViewportFetch();
  }, [budget, scheduleViewportFetch]);


  const selectedName = selected ? String(selected.properties.name) : null;

  const { nodes, edges } = useMemo(() => {
    type Edge = { x1: number; y1: number; x2: number; y2: number; color: string; width: number };
    if (!payload || !boundsRef.current) return { nodes: [] as NvlNode[], edges: [] as Edge[] };
    // NVL sizes scale with zoom; divide by the zoom at fetch time for constant on-screen size.
    const k = 1 / (Math.max(viewScale, 1e-6) * NVL_SIZE_PX);
    const seen = new Set<string>();
    const nodeOf = (n: GraphNode, dim: boolean): NvlNode => {
      const p = n.properties;
      const { px, py } = toPx(num(p.x), num(p.y));
      const score = Math.log10(num(p.downloads) + 1) + 1.5 * Math.log10(num(p.dependents) + 1);
      const isSel = n.id === selected?.id;
      return {
        id: n.id,
        x: px,
        y: py,
        pinned: true,
        // Dots only; names are drawn by the overlay so they can sit beside the dot and avoid each other.
        size: Math.max(5, Math.min(22, 3 + score * 1.1)) * (dim ? 0.8 : 1) * k,
        color: colorOf(num(p.community)),
        selected: isSel,
        activated: isSel,
      };
    };
    const nodes: NvlNode[] = [];
    for (const n of payload.nodes) {
      seen.add(n.id);
      nodes.push(nodeOf(n, false));
    }
    // The selection and its neighbourhood are always drawn, even below the landmark cut.
    const extra: GraphNode[] = [];
    if (selected && !seen.has(selected.id)) extra.push(selected);
    if (neighbours && selected && neighbours.crate.id === selected.id) {
      for (const n of [...neighbours.dependents.top, ...neighbours.dependencies.top]) if (!seen.has(n.id)) extra.push(n);
    }
    for (const n of extra) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      nodes.push(nodeOf(n, n.id !== selected?.id));
    }
    const edges: Edge[] = [];
    const at = (n: GraphNode) => ({ x: num(n.properties.x), y: num(n.properties.y) });
    if (neighbours && selected && neighbours.crate.id === selected.id) {
      const s = at(selected);
      for (const n of neighbours.dependencies.top) {
        const t = at(n);
        edges.push({ x1: s.x, y1: s.y, x2: t.x, y2: t.y, color: 'rgba(76,141,255,0.7)', width: 1.4 });
      }
      for (const n of neighbours.dependents.top) {
        const t = at(n);
        edges.push({ x1: t.x, y1: t.y, x2: s.x, y2: s.y, color: 'rgba(245,166,35,0.65)', width: 1.4 });
      }
    } else if (payload.rels.length <= EDGE_SHOW_MAX) {
      const pos = new Map(payload.nodes.map((n) => [n.id, at(n)]));
      for (const r of payload.rels) {
        const a = pos.get(r.from);
        const b = pos.get(r.to);
        if (!a || !b) continue;
        const versions = num(r.properties.versions ?? 1);
        edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: 'rgba(150,170,210,0.35)', width: Math.min(0.6 + Math.log2(versions + 1) * 0.2, 2) });
      }
    }
    return { nodes, edges };
  }, [payload, selected, neighbours, toPx, viewScale, colorOf]);

  // Overlay: redraw on animation frames while the view moves, the scene changes, or a pulse runs.
  useEffect(() => {
    let raf = 0;
    let lastKey = '';
    const tick = () => {
      raf = window.requestAnimationFrame(tick);
      const cv = overlayRef.current;
      const el = containerRef.current;
      const c = calibrate();
      if (!cv || !el || !c || !boundsRef.current) return;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      const key = `${c.scale}:${c.offsetX}:${c.offsetY}:${w}:${h}:${dpr}`;
      const now = performance.now();
      if (key === lastKey && !sceneDirty.current && !pulseActive(pulseRef.current, now)) return;
      lastKey = key;
      sceneDirty.current = false;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const b = boundsRef.current;
      const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
      const toScreen = (x: number, y: number) => {
        const { px, py } = toPx(x, y);
        return { sx: px * c.scale + c.offsetX, sy: py * c.scale + c.offsetY };
      };
      const sel = selected ? { x: num(selected.properties.x), y: num(selected.properties.y) } : null;
      const weightOf = (p: GraphNode['properties']) => Math.log10(num(p.downloads) + 1) + 1.5 * Math.log10(num(p.dependents) + 1);
      const labels: { x: number; y: number; text: string; weight: number; selected?: boolean }[] = [];
      if (selected) labels.push({ x: num(selected.properties.x), y: num(selected.properties.y), text: String(selected.properties.name), weight: 99, selected: true });
      const nb = neighbours && selected && neighbours.crate.id === selected.id ? [...neighbours.dependents.top, ...neighbours.dependencies.top] : [];
      const seenLabel = new Set(selected ? [selected.id] : []);
      for (const n of [...(payload?.nodes ?? []), ...nb]) {
        if (seenLabel.has(n.id)) continue;
        seenLabel.add(n.id);
        labels.push({ x: num(n.properties.x), y: num(n.properties.y), text: String(n.properties.name), weight: weightOf(n.properties) });
      }
      // Landmarks arrive in importance order; neighbours are appended after, so sort once by weight.
      labels.sort((a, b) => b.weight - a.weight);
      drawOverlay(ctx, {
        width: w,
        height: h,
        toScreen,
        pxPerUnit: (MAP_PX / span) * c.scale,
        // Every in-view crate is already a labelled dot: shading would only duplicate them.
        density: payload && payload.meta.shown < payload.meta.inView ? payload.density : null,
        communities,
        colorOf,
        selected: sel,
        edges,
        labels,
        pulseAt: pulseRef.current,
        now,
      });
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [calibrate, toPx, payload, communities, colorOf, selected, neighbours, edges]);

  const nvlOptions = useMemo<NvlOptions>(
    () => ({
      layout: 'free',
      renderer: 'canvas',
      minZoom: 0.02,
      maxZoom: 120,
      allowDynamicMinZoom: true,
      styling: { selectedBorderColor: '#ffffff', selectedInnerBorderColor: '#111111', dropShadowColor: 'rgba(0,0,0,0.5)' },
    }),
    [],
  );

  const byId = useCallback(
    (id: string) => {
      const inPayload = payload?.nodes.find((n) => n.id === id);
      if (inPayload) return inPayload;
      if (selected?.id === id) return selected;
      return neighbours ? ([...neighbours.dependents.top, ...neighbours.dependencies.top].find((n) => n.id === id) ?? null) : null;
    },
    [payload, selected, neighbours],
  );

  const mouseEventCallbacks = useMemo<MouseEventCallbacks>(
    () => ({
      onNodeClick: (node: NvlNode) => {
        const n = byId(node.id);
        if (n) selectCrate(n);
      },
      onNodeDoubleClick: (node: NvlNode) => {
        const n = byId(node.id);
        if (n) void jumpTo(String(n.properties.name));
      },
      onCanvasClick: () => selectCrate(null),
      onZoomAndPan: () => scheduleViewportFetch(),
      onPan: () => scheduleViewportFetch(),
      onHover: true,
      onDrag: false,
    }),
    [byId, selectCrate, jumpTo, scheduleViewportFetch],
  );

  const zoomToCommunity = useCallback(
    (c: LodCommunity) => {
      fitBox(c.bbox, 0.85);
      scheduleViewportFetch();
    },
    [fitBox, scheduleViewportFetch],
  );

  const startJob = async (kind: 'build' | 'update') => {
    onError(null);
    try {
      const s = kind === 'build' ? await api.lodRebuild({ iterations, reuseEdges, resume }) : await api.lodUpdate();
      setStatus((prev) => ({ ...(prev ?? s), ...s }));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const meta = status?.meta ?? null;
  const fmt = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : v == null ? '—' : String(v));
  const selectedCommunity = selected ? (communities?.find((c) => c.id === num(selected.properties.community)) ?? null) : null;

  const neighbourList = (title: string, side: LodNeighbours['dependents'] | undefined, hint: string) => (
    <>
      <h3>
        {title} <span className="count">{side ? `${fmt(side.total)}${side.total > side.top.length ? `, top ${side.top.length}` : ''}` : '…'}</span>
      </h3>
      {side && side.top.length === 0 ? (
        <p className="muted small">{hint}</p>
      ) : (
        <ul className="map-neighbours">
          {(side?.top ?? []).map((n) => {
            const p = n.properties;
            return (
              <li key={n.id}>
                <span className="swatch" style={{ background: colorOf(num(p.community)) }} />
                <button type="button" className="link name" title={`${compact(num(p.downloads))} downloads · used by ${fmt(p.dependents)} crates`} onClick={() => void jumpTo(String(p.name))}>
                  {String(p.name)}
                </button>
                <span className="count" title="versions declaring the dependency">
                  {compact(num(p.versions ?? 0))}v
                </span>
                <button type="button" className="deps" title="Open this crate's dependency chain in the Deps view" onClick={() => onOpenInDeps(String(p.name))}>
                  deps
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  return (
    <>
      <div className="canvas" ref={canvasRef}>
        {!status?.index && (
          <div className="empty">
            <h1>ecosystem map</h1>
            <p>
              {status?.running
                ? `LOD ${status.running.kind} running: ${status.running.phase}${status.running.total ? ` ${fmt(status.running.done)}/${fmt(status.running.total)}` : ''}`
                : status?.indexLoading
                  ? 'Loading the map index from the database (a few minutes on a cold start; seconds from its snapshot)…'
                  : status?.indexError
                    ? `Map index failed to load: ${status.indexError}`
                    : status
                      ? 'No layout has been built yet. Use "Rebuild" in the panel to compute communities and positions for every crate.'
                      : 'Checking map status…'}
            </p>
          </div>
        )}
        <InteractiveNvlWrapper
          ref={nvlRef}
          nodes={nodes}
          rels={NO_RELS}
          positions={nodes}
          nvlOptions={nvlOptions}
          mouseEventCallbacks={mouseEventCallbacks}
          interactionOptions={{ selectOnClick: false }}
          onInitializationError={(e) => onError(`NVL failed to initialise: ${e instanceof Error ? e.message : String(e)}`)}
          style={{ width: '100%', height: '100%' }}
        />
        <canvas ref={overlayRef} className="map-overlay" />
      </div>
      <aside className={`sidebar${selected ? ' has-selection' : ''}`}>
        {selected && (
          <button type="button" className="sheet-close" aria-label="Close details" onClick={() => selectCrate(null)}>
            ×
          </button>
        )}
        <div className="details">
          {selected ? (
            <>
              <h2>
                <span className="badge crate">Crate</span> {selectedName}
              </h2>
              <table className="props">
                <tbody>
                  <tr>
                    <th>downloads</th>
                    <td>{selected.properties.downloads == null ? '—' : compact(num(selected.properties.downloads))}</td>
                  </tr>
                  <tr>
                    <th>used by</th>
                    <td>{fmt(selected.properties.dependents)} crates</td>
                  </tr>
                  <tr>
                    <th>depends on</th>
                    <td>{fmt(selected.properties.dependencies)} crates</td>
                  </tr>
                  <tr>
                    <th>neighbourhood</th>
                    <td className="map-neighbours">
                      {selectedCommunity ? (
                        <button type="button" className="link" onClick={() => zoomToCommunity(selectedCommunity)} title="Zoom to this community">
                          <span className="swatch" style={{ background: colorOf(num(selected.properties.community)) }} /> {selectedCommunity.top.slice(0, 3).join(' · ')}{' '}
                          <span className="count">({compact(selectedCommunity.size)} crates)</span>
                        </button>
                      ) : (
                        <span className="muted">
                          <span className="swatch" style={{ background: colorOf(num(selected.properties.community)) }} /> small community #{fmt(selected.properties.community)}
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="actions" style={{ marginTop: 10 }}>
                <button onClick={() => onOpenInDeps(selectedName!)}>Open chain in Deps view</button>
                <button onClick={() => void jumpTo(selectedName!)} title="Centre the map on this crate">
                  Centre
                </button>
              </div>
              <p className="muted small" style={{ marginTop: 8 }}>
                Orange edges: crates that use it. Blue edges: what it depends on. Click a name to jump there.
              </p>
              {neighbourList('Used by', neighbours?.dependents, 'No crate depends on it.')}
              {neighbourList('Depends on', neighbours?.dependencies, 'No dependencies on crates.io.')}
              <hr className="rule" />
            </>
          ) : (
            <>
              <h2>Ecosystem map</h2>
              <p className="muted">
                Every crate at a precomputed position; the most downloaded and most depended-on crates are the labelled landmarks, and shading
                shows where the rest are. Scroll to zoom, drag to pan, click a crate for its neighbourhood, double-click to centre on it.
              </p>
              <div className="actions">
                <button onClick={showCore}>Reset view</button>
                <button onClick={showWholeMap} title="Include the ring of isolated crates">
                  Whole map
                </button>
              </div>
              <h3>Largest neighbourhoods</h3>
              <p className="muted small">Louvain communities, named after their dominant crates. Click to zoom.</p>
              <ul className="map-legend">
                {(communities ?? []).slice(0, LEGEND_SIZE).map((c) => (
                  <li key={c.id}>
                    <span className="swatch" style={{ background: colorOf(c.id) }} />
                    <button type="button" className="names" title={c.top.join(', ')} onClick={() => zoomToCommunity(c)}>
                      {c.top.slice(0, 3).join(' · ')}
                    </button>
                    <span className="count">{compact(c.size)}</span>
                  </li>
                ))}
              </ul>
              {communities && status?.index && (
                <p className="muted small">
                  {fmt(status.index.communities)} communities in total; the rest are drawn grey.
                </p>
              )}
              <hr className="rule" />
            </>
          )}

          <details className="map-build">
            <summary>Layout build</summary>
            {status?.running ? (
              <p>
                <strong>{status.running.kind}</strong> running · {status.running.phase}
                {status.running.total ? ` ${fmt(status.running.done)} / ${fmt(status.running.total)}` : ''}
                {status.running.message ? <span className="muted"> · {status.running.message}</span> : null}
              </p>
            ) : meta ? (
              <table className="props">
                <tbody>
                  <tr>
                    <th>built</th>
                    <td>{fmt(meta.built_at)}</td>
                  </tr>
                  <tr>
                    <th>crates / edges</th>
                    <td>
                      {fmt(meta.crates)} / {fmt(meta.edges)}
                    </td>
                  </tr>
                  <tr>
                    <th>communities</th>
                    <td>{fmt(meta.communities)}</td>
                  </tr>
                  <tr>
                    <th>isolated</th>
                    <td>{fmt(meta.isolated)}</td>
                  </tr>
                  <tr>
                    <th>iterations</th>
                    <td>{fmt(meta.iterations)}</td>
                  </tr>
                  <tr>
                    <th>placed by update</th>
                    <td>{fmt(meta.updated_crates)}</td>
                  </tr>
                  <tr>
                    <th>unpositioned now</th>
                    <td>{fmt(status?.unpositionedCrates)}</td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p className="muted">No build yet.</p>
            )}
            {status?.last && !status.running && (
              <p className={`small ${status.last.ok ? 'muted' : 'error'}`}>
                last {status.last.kind}: {status.last.ok ? 'ok' : `failed: ${status.last.error}`} ({Math.round(status.last.elapsedMs / 1000)} s)
              </p>
            )}
            <div className="actions" style={{ marginTop: 8 }}>
              <button disabled={Boolean(status?.running)} onClick={() => void startJob('update')} title="Place crates added since the last build">
                Update
              </button>
              <button
                disabled={Boolean(status?.running)}
                className="danger"
                onClick={() => void startJob('build')}
                title="Recompute communities and the whole layout (minutes)"
              >
                Rebuild
              </button>
              <label className="opt">
                iterations
                <input type="number" min={10} max={5000} value={iterations} onChange={(e) => setIterations(Math.max(10, Number(e.target.value) || 10))} className="limit" />
              </label>
            </div>
            <div className="actions" style={{ marginTop: 6 }}>
              <label className="opt" title="Skip the DEPENDS_ON aggregation and reuse the LOD_DEP edges already stored (minutes faster); untick after a large import">
                <input type="checkbox" checked={reuseEdges} onChange={(e) => setReuseEdges(e.target.checked)} /> reuse stored edges
              </label>
              <label className="opt" title="Continue from the last checkpoint or stored positions instead of a fresh layout">
                <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} /> resume
              </label>
            </div>
            <p className="muted small">
              Update is cheap and places new crates next to their neighbours. Rebuild streams every DEPENDS_ON edge and runs the full
              layout; on a complete index that takes many minutes and a few GB of memory in the render server.
            </p>
          </details>
        </div>
      </aside>
    </>
  );
}
