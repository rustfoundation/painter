// NVL free layout: positions are exactly the server's. Screen <-> layout mapping is
// calibrated from NVL zoom/pan, not node client positions (they lag a frame behind pans).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type NVL from '@neo4j-nvl/base';
import type { Node as NvlNode, Relationship as NvlRel, NvlOptions } from '@neo4j-nvl/base';
import { InteractiveNvlWrapper, type MouseEventCallbacks } from '@neo4j-nvl/react';
import { api, ApiError, type GraphNode, type LodStatus, type LodViewport } from '../api';
import { communityColor } from '../graph';
import { useTouchZoomPan } from '../touch';

const MAP_PX = 6000;
const FETCH_DEBOUNCE_MS = 180;
/** Fetch a bbox this much larger than the screen so small pans do not refetch. */
const VIEW_MARGIN = 0.35;
/** NVL draws a node roughly this many screen px per unit of `size` at zoom 1 (measured). */
const NVL_SIZE_PX = 2.75;
const MIN_CELL_PX = 44;

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

interface Props {
  /** Crate to jump to; a new object each time the user asks. */
  target: { name: string; nonce: number } | null;
  budget: number;
  onError: (message: string | null) => void;
  onBusy: (busy: boolean) => void;
  onOpenInDeps: (name: string) => void;
  onMeta: (m: { mode: string; level: number; inView: number; total: number; nodes: number; rels: number; elapsedMs: number } | null) => void;
}

interface Calibration {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function MapView({ target, budget, onError, onBusy, onOpenInDeps, onMeta }: Props) {
  const nvlRef = useRef<NVL>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const canvasRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    setCanvasEl(el);
  }, []);
  useTouchZoomPan(canvasEl, nvlRef);
  const [status, setStatus] = useState<LodStatus | null>(null);
  const [payload, setPayload] = useState<LodViewport | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [iterations, setIterations] = useState<number>(300);
  /** NVL zoom at the time of the last fetch; sizes are divided by it so they stay constant on screen. */
  const [viewScale, setViewScale] = useState(1);
  const [reuseEdges, setReuseEdges] = useState(true);
  const [resume, setResume] = useState(true);
  const boundsRef = useRef<LodViewport['meta']['bounds'] | null>(null);
  const calib = useRef<Calibration | null>(null);
  const debounce = useRef<number | undefined>(undefined);
  const lastBbox = useRef<string>('');
  const inflight = useRef<AbortController | null>(null);
  /** False until the first whole-map payload has been centred; polling waits for it. */
  const centeredRef = useRef(false);

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
      if (s.index) boundsRef.current = s.index.bounds;
      return s;
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [onError]);

  const fetchViewport = useCallback(
    async (bbox: { x0: number; y0: number; x1: number; y1: number } | null) => {
      const key = bbox ? [bbox.x0, bbox.y0, bbox.x1, bbox.y1].map((v) => v.toPrecision(5)).join(',') : 'all';
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
        const minCell = b ? (MIN_CELL_PX / scaleNow / MAP_PX) * span : 0;
        const p = await api.lodViewport(bbox, budget, minCell);
        if (ctrl.signal.aborted) return;
        boundsRef.current = p.meta.bounds;
        setViewScale(calib.current?.scale ?? 1);
        setPayload(p);
        if (!centeredRef.current && bbox === null) {
          // First whole-map payload: centre once, then the poll refetches for the real bbox.
          window.setTimeout(() => {
            showWholeMapRef.current();
            setViewScale(calib.current?.scale ?? 1);
            centeredRef.current = true;
            lastBbox.current = '';
          }, 250);
        }
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

  const showWholeMapRef = useRef<() => void>(() => {});
  const showWholeMap = useCallback(() => {
    const nvl = nvlRef.current;
    const el = containerRef.current;
    if (!nvl || !el) return;
    const scale = (Math.min(el.clientWidth, el.clientHeight) / MAP_PX) * 0.92;
    nvl.setZoomAndPan(scale, MAP_PX / 2, MAP_PX / 2);
    calibrate();
  }, [calibrate]);
  showWholeMapRef.current = showWholeMap;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await fetchStatus();
      if (cancelled || !s?.index) return;
      await fetchViewport(null);
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
      if (s && !s.running && !s.indexLoading && s.index) {
        lastBbox.current = '';
        centeredRef.current = false;
        void fetchViewport(null);
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [status?.running, status?.indexLoading, fetchStatus, fetchViewport]);

  useEffect(() => {
    if (!target) return;
    (async () => {
      try {
        const hit = await api.lodLocate(target.name);
        const nvl = nvlRef.current;
        const el = containerRef.current;
        if (!nvl || !el) return;
        const { px, py } = toPx(hit.x, hit.y);
        const scale = Math.max(1, el.clientWidth / 600);
        // NVL pan = layout coordinate shown at the screen centre.
        nvl.setZoomAndPan(scale, px, py);
        calibrate();
        lastBbox.current = '';
        scheduleViewportFetch();
        setSelected({ id: `crate:${hit.name}`, labels: ['Crate'], properties: { ...hit } });
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    })();
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
    if (boundsRef.current) scheduleViewportFetch();
  }, [budget, scheduleViewportFetch]);

  const { nodes, rels } = useMemo(() => {
    if (!payload || !boundsRef.current) return { nodes: [] as NvlNode[], rels: [] as NvlRel[] };
    // NVL sizes scale with zoom; divide by the zoom at fetch time for constant on-screen size.
    const k = 1 / (Math.max(viewScale, 1e-6) * NVL_SIZE_PX);
    const cellPx = (MAP_PX / 2 ** payload.level) * viewScale;
    const nodes: NvlNode[] = payload.nodes.map((n) => {
      const p = n.properties as Record<string, number | string | string[]>;
      const { px, py } = toPx(p.x as number, p.y as number);
      const community = Number(p.community ?? -1);
      if (n.labels.includes('Cluster')) {
        const count = Number(p.count);
        const top = (p.top as string[]) ?? [];
        return {
          id: n.id,
          x: px,
          y: py,
          pinned: true,
          size: Math.min(30 + Math.log2(count + 1) * 3.5, 72, cellPx * 1.05) * k,
          color: communityColor(community),
          captions: [{ value: `${compact(count)} crates`, styles: ['bold'] }, ...(top.length ? [{ value: top[0] }] : [])],
          selected: selected?.id === n.id,
        } as NvlNode;
      }
      const degree = Number(p.degree ?? 0);
      return {
        id: n.id,
        x: px,
        y: py,
        pinned: true,
        size: Math.min(18 + Math.log2(degree + 1) * 2, 44) * k,
        color: communityColor(community),
        caption: String(p.name),
        selected: selected?.id === n.id,
      };
    });
    const rels: NvlRel[] = payload.rels.map((r) => {
      const count = Number(r.properties.count ?? 1);
      return {
        id: r.id,
        from: r.from,
        to: r.to,
        color: 'rgba(120,140,180,0.22)',
        width: Math.min(0.3 + Math.log2(count + 1) * 0.15, 1.4) * k * NVL_SIZE_PX,
      };
    });
    return { nodes, rels };
  }, [payload, selected, toPx, viewScale]);

  const nvlOptions = useMemo<NvlOptions>(
    () => ({
      layout: 'free',
      renderer: 'canvas',
      minZoom: 0.02,
      maxZoom: 40,
      allowDynamicMinZoom: true,
      styling: { selectedBorderColor: '#ffffff', selectedInnerBorderColor: '#111111', dropShadowColor: 'rgba(0,0,0,0.5)' },
    }),
    [],
  );

  const zoomToCluster = useCallback(
    (node: GraphNode) => {
      const nvl = nvlRef.current;
      const el = containerRef.current;
      const bbox = node.properties.bbox as { x0: number; y0: number; x1: number; y1: number } | undefined;
      if (!nvl || !el || !bbox) return;
      const a = toPx(bbox.x0, bbox.y0);
      const b = toPx(bbox.x1, bbox.y1);
      const w = Math.abs(b.px - a.px);
      const h = Math.abs(b.py - a.py);
      const scale = Math.min(el.clientWidth / w, el.clientHeight / h) * 0.75;
      const cx = (a.px + b.px) / 2;
      const cy = (a.py + b.py) / 2;
      nvl.setZoomAndPan(scale, cx, cy);
      calibrate();
      scheduleViewportFetch();
    },
    [toPx, scheduleViewportFetch, calibrate],
  );

  const byId = useCallback((id: string) => payload?.nodes.find((n) => n.id === id) ?? null, [payload]);

  const mouseEventCallbacks = useMemo<MouseEventCallbacks>(
    () => ({
      onNodeClick: (node: NvlNode) => {
        const n = byId(node.id);
        setSelected(n);
        if (n?.labels.includes('Cluster')) zoomToCluster(n);
      },
      onNodeDoubleClick: (node: NvlNode) => {
        const n = byId(node.id);
        if (n?.labels.includes('Cluster')) zoomToCluster(n);
      },
      onCanvasClick: () => setSelected(null),
      onZoomAndPan: () => scheduleViewportFetch(),
      onPan: () => scheduleViewportFetch(),
      onHover: true,
      onDrag: false,
    }),
    [byId, zoomToCluster, scheduleViewportFetch],
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
                  ? 'Loading the map index from the database…'
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
          rels={rels}
          positions={nodes}
          nvlOptions={nvlOptions}
          mouseEventCallbacks={mouseEventCallbacks}
          interactionOptions={{ selectOnClick: false }}
          onInitializationError={(e) => onError(`NVL failed to initialise: ${e instanceof Error ? e.message : String(e)}`)}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      <aside className={`sidebar${selected ? ' has-selection' : ''}`}>
        {selected && (
          <button type="button" className="sheet-close" aria-label="Close details" onClick={() => setSelected(null)}>
            ×
          </button>
        )}
        <div className="details">
          {selected ? (
            <>
              <h2>
                <span className={`badge ${selected.labels.includes('Cluster') ? 'rel' : 'crate'}`}>{selected.labels.join(':')}</span>{' '}
                {selected.labels.includes('Cluster')
                  ? `${fmt(selected.properties.count)} crates`
                  : String(selected.properties.name)}
              </h2>
              {selected.labels.includes('Cluster') ? (
                <>
                  <p className="muted">
                    Grid level {fmt(selected.properties.level)} · dominant community {fmt(selected.properties.community)}. Click to zoom
                    in.
                  </p>
                  <h3>Largest crates here</h3>
                  <ul className="targets">
                    {((selected.properties.top as string[]) ?? []).map((t) => (
                      <li key={t}>
                        <code>{t}</code>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <table className="props">
                    <tbody>
                      <tr>
                        <th>community</th>
                        <td>
                          <span className="swatch" style={{ background: communityColor(Number(selected.properties.community)) }} />{' '}
                          {fmt(selected.properties.community)}
                        </td>
                      </tr>
                      <tr>
                        <th>crate-level degree</th>
                        <td>{fmt(selected.properties.degree)}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div className="actions" style={{ marginTop: 10 }}>
                    <button onClick={() => onOpenInDeps(String(selected.properties.name))}>Open chain in Deps view</button>
                  </div>
                </>
              )}
              <hr className="rule" />
            </>
          ) : (
            <>
              <h2>Ecosystem map</h2>
              <p className="muted">
                Every crate at a precomputed position (ForceAtlas2), coloured by Louvain community. Scroll to zoom, drag to pan.
                Clusters show how many crates they hold and resolve into crates as you zoom in.
              </p>
              <hr className="rule" />
            </>
          )}

          <h3>Layout build</h3>
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
        </div>
      </aside>
    </>
  );
}
