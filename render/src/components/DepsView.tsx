// Deps view: one crate's dependency (or dependent) tree, layered by hop count with the root on top,
// fetched a bounded number of hops at a time and expanded per crate on demand. Positions come from
// deps.ts layoutTree and are pinned (NVL free layout), as in MapView.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type NVL from '@neo4j-nvl/base';
import type { Node as NvlNode, NvlOptions, Relationship as NvlRel } from '@neo4j-nvl/base';
import { InteractiveNvlWrapper, type MouseEventCallbacks } from '@neo4j-nvl/react';
import { ApiError } from '../api';
import { useTouchZoomPan } from '../touch';
import {
  buildGraph,
  childOf,
  childrenOf,
  collapseNode,
  compact,
  DEP_KINDS,
  DEPS_COLORS,
  depsApi,
  describeEdge,
  edgeColor,
  edgeWidth,
  excludedDeclarations,
  isTreeEdge,
  layoutTree,
  mergeExpansion,
  nodeSize,
  notShown,
  parentOf,
  pathFromRoot,
  type DepsEdge,
  type DepsGraph,
  type DepsNode,
  type DepsOptions,
  type DepsPath,
  type DepsStatus,
  type DepsTreeMeta,
} from '../deps';

interface Props {
  /** Crate to load; a new nonce reloads the same name. */
  target: { name: string; nonce: number } | null;
  options: DepsOptions;
  onOptionsChange: (o: DepsOptions) => void;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onStatus: (status: DepsStatus | null) => void;
  /** The resolved root, so the toolbar's search box can follow "tree from here". */
  onRootChange: (name: string) => void;
  onOpenInGraph: (name: string) => void;
}

const errorMessage = (err: unknown): string => {
  if (err instanceof ApiError) return err.code ? `${err.message} [${err.code}]` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
};

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toLocaleString());

export function DepsView({ target, options, onOptionsChange, onBusy, onError, onStatus, onRootChange, onOpenInGraph }: Props) {
  const nvlRef = useRef<NVL>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  useTouchZoomPan(canvasEl, nvlRef);
  const [graph, setGraph] = useState<DepsGraph | null>(null);
  const [meta, setMeta] = useState<DepsTreeMeta | null>(null);
  /** A crate name or an edge key. */
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<string | null>(null);
  const reqId = useRef(0);

  const fitAll = useCallback(() => {
    const nvl = nvlRef.current;
    if (!nvl) return;
    const ids = nvl.getNodes().map((n) => n.id);
    if (ids.length) nvl.fit(ids, { animated: true });
  }, []);

  // Debug hook for headless checks.
  useEffect(() => {
    (window as unknown as { __painterNvl?: unknown }).__painterNvl = nvlRef.current;
  });

  const load = useCallback(
    async (name: string, opts: DepsOptions) => {
      reqId.current += 1;
      const id = reqId.current;
      setLoading(true);
      onBusy(true);
      onError(null);
      try {
        const tree = await depsApi.tree(name, opts);
        if (id !== reqId.current) return;
        rootRef.current = tree.root;
        onRootChange(tree.root);
        setGraph(buildGraph(tree));
        setMeta(tree.meta);
        setSelected(tree.root);
        window.setTimeout(fitAll, 250);
      } catch (err) {
        if (id === reqId.current) onError(errorMessage(err));
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          onBusy(false);
        }
      }
    },
    [fitAll, onBusy, onError, onRootChange],
  );

  useEffect(() => {
    if (target) void load(target.name, options);
    // Options are handled below so a target change does not load twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, load]);

  // Changing an option redraws the current tree with it.
  const firstOptions = useRef(true);
  useEffect(() => {
    if (firstOptions.current) {
      firstOptions.current = false;
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const t = window.setTimeout(() => void load(root, options), 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  useEffect(() => {
    if (!graph || !meta) {
      onStatus(null);
      return;
    }
    let missing = 0;
    for (const n of graph.nodes.values()) missing += notShown(n);
    onStatus({
      root: graph.root,
      version: graph.rootInfo.latest,
      direction: graph.direction,
      mode: meta.mode,
      kinds: meta.kinds,
      optional: meta.optional,
      depth: meta.depth,
      depthReached: meta.depthReached,
      nodes: graph.nodes.size,
      edges: graph.edges.size,
      notShown: missing,
      truncated: meta.truncated,
      elapsedMs: meta.elapsedMs,
    });
  }, [graph, meta, onStatus]);

  const expand = useCallback(
    async (name: string) => {
      setLoading(true);
      onBusy(true);
      onError(null);
      try {
        // Reverse expansions stop at the 60 best-downloaded dependents; a popular crate has 10^4+.
        const exp = await depsApi.expand(name, { ...options, limit: options.direction === 'in' ? 60 : Math.max(options.limit, 200) });
        setGraph((g) => (g ? mergeExpansion(g, exp) : g));
        setSelected(name);
        window.setTimeout(fitAll, 250);
      } catch (err) {
        onError(errorMessage(err));
      } finally {
        setLoading(false);
        onBusy(false);
      }
    },
    [options, fitAll, onBusy, onError],
  );

  const collapse = useCallback(
    (name: string) => {
      setGraph((g) => (g ? collapseNode(g, name) : g));
      setSelected(name);
      window.setTimeout(fitAll, 250);
    },
    [fitAll],
  );

  const treeFrom = useCallback((name: string) => void load(name, options), [load, options]);
  const flip = useCallback(
    (name: string) => {
      // The options effect reloads the current root, so point the root at `name` first.
      rootRef.current = name;
      onOptionsChange({ ...options, direction: options.direction === 'out' ? 'in' : 'out' });
    },
    [options, onOptionsChange],
  );

  const positions = useMemo(() => (graph ? layoutTree(graph) : new Map()), [graph]);
  const path = useMemo(() => (graph && selected && graph.nodes.has(selected) ? pathFromRoot(graph, selected) : null), [graph, selected]);

  const { nodes, rels } = useMemo(() => {
    if (!graph) return { nodes: [] as NvlNode[], rels: [] as NvlRel[] };
    const onPath = new Set(path?.names ?? []);
    const nodes: NvlNode[] = [...graph.nodes.values()].map((n) => {
      const p = positions.get(n.name) ?? { x: 0, y: 0 };
      const isRoot = n.name === graph.root;
      const more = notShown(n);
      return {
        id: n.name,
        x: p.x,
        y: p.y,
        pinned: true,
        size: nodeSize(n, isRoot),
        color: isRoot ? DEPS_COLORS.root : onPath.has(n.name) ? DEPS_COLORS.onPath : DEPS_COLORS.crate,
        captions: more > 0 ? [{ value: n.name, styles: ['bold'] }, { value: `+${compact(more)}` }] : [{ value: n.name }],
        selected: n.name === selected,
      } as NvlNode;
    });
    const rels: NvlRel[] = [...graph.edges.entries()].map(([key, e]) => {
      const highlighted = path?.edges.has(key) ?? false;
      // Shortcuts to crates already reached by a shorter path fade unless they touch the selection.
      const faint = !isTreeEdge(graph, e) && e.from !== selected && e.to !== selected;
      return {
        id: key,
        from: e.from,
        to: e.to,
        color: highlighted ? DEPS_COLORS.pathEdge : edgeColor(e, options.mode, faint),
        width: highlighted ? 3.5 : edgeWidth(e, options.mode),
        selected: key === selected,
      };
    });
    return { nodes, rels };
  }, [graph, positions, path, selected, options.mode]);

  const nvlOptions = useMemo<NvlOptions>(
    () => ({
      layout: 'free',
      renderer: 'canvas',
      initialZoom: 1,
      minZoom: 0.03,
      maxZoom: 20,
      allowDynamicMinZoom: true,
      styling: {
        defaultNodeColor: DEPS_COLORS.crate,
        defaultRelationshipColor: DEPS_COLORS.kind.normal,
        selectedBorderColor: '#ffffff',
        selectedInnerBorderColor: '#111111',
        dropShadowColor: 'rgba(0,0,0,0.5)',
      },
    }),
    [],
  );

  const mouseEventCallbacks = useMemo<MouseEventCallbacks>(
    () => ({
      onNodeClick: (node: NvlNode) => setSelected(node.id),
      onRelationshipClick: (rel: NvlRel) => setSelected(rel.id),
      onCanvasClick: () => setSelected(null),
      onNodeDoubleClick: (node: NvlNode) => {
        const n = graph?.nodes.get(node.id);
        if (!n || !graph) return;
        if (notShown(n) > 0) void expand(n.name);
        else if (childrenOf(graph, n.name).length > 0 && n.name !== graph.root) collapse(n.name);
        else void expand(n.name);
      },
      onHover: true,
      onPan: true,
      // Key must be `onZoomAndPan`; any other name leaves NVL zoom unattached.
      onZoomAndPan: true,
      onDrag: true,
    }),
    [graph, expand, collapse],
  );

  const selectedNode = graph && selected ? (graph.nodes.get(selected) ?? null) : null;
  const selectedEdge = graph && selected && !selectedNode ? (graph.edges.get(selected) ?? null) : null;
  const hasSelection = Boolean(selectedNode || selectedEdge);
  const dirWord = options.direction === 'out' ? 'dependencies' : 'dependents';

  return (
    <>
      <div className="canvas" ref={setCanvasEl}>
        {!graph && (
          <div className="empty">
            <h1>crate dependency tree</h1>
            <p>
              {loading
                ? 'Loading the dependency tree…'
                : 'Type a crate name and press Load. The root sits on top; each row below is one hop further away. Double-click a crate to fetch what it pulls in, click one to see the path from the root.'}
            </p>
            <p className="muted">
              By default the tree follows the current version's required normal dependencies, two hops deep. The
              options add optional (feature-gated, drawn fainter) or build/dev dependencies, switch to any version ever published, or to the crates that depend on the root.
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
          onInitializationError={(e) => onError(`NVL failed to initialise: ${errorMessage(e)}`)}
          style={{ width: '100%', height: '100%' }}
        />
        {graph && (
          <div className="deps-legend" aria-label="Legend">
            {options.mode === 'latest' ? (
              <>
                {DEP_KINDS.filter((k) => options.kinds[k]).map((k) => (
                  <span key={k}>
                    <span className="line" style={{ background: DEPS_COLORS.kind[k] }} /> {k}
                  </span>
                ))}
                {options.optional && (
                  <span>
                    <span className="line faint" style={{ background: DEPS_COLORS.kind.normal }} /> optional
                  </span>
                )}
              </>
            ) : (
              <span>
                <span className="line" style={{ background: DEPS_COLORS.kind.normal }} /> width = versions declaring it
              </span>
            )}
            <span>
              <span className="line faint" style={{ background: DEPS_COLORS.kind.normal, opacity: 0.25 }} /> shortcut (already reached)
            </span>
            <span>
              <span className="swatch" style={{ background: DEPS_COLORS.root }} /> root · size = crates depending on it · +N not shown
            </span>
          </div>
        )}
      </div>
      <aside className={`sidebar${hasSelection ? ' has-selection' : ''}`}>
        {hasSelection && (
          <button type="button" className="sheet-close" aria-label="Close details" onClick={() => setSelected(null)}>
            ×
          </button>
        )}
        <div className="details">
          {selectedNode && graph ? (
            <NodeDetails
              graph={graph}
              node={selectedNode}
              path={path}
              options={options}
              busy={loading}
              onSelect={setSelected}
              onExpand={(n) => void expand(n)}
              onCollapse={collapse}
              onTreeFrom={treeFrom}
              onFlip={flip}
              onOpenInGraph={onOpenInGraph}
            />
          ) : selectedEdge && graph ? (
            <EdgeDetails graph={graph} edge={selectedEdge} options={options} onSelect={setSelected} />
          ) : graph ? (
            <>
              <h2>
                <span className="badge crate">Crate</span> {graph.root}
                {graph.rootInfo.latest ? <span className="muted"> {graph.rootInfo.latest}</span> : null}
              </h2>
              {graph.rootInfo.description && <p className="muted">{graph.rootInfo.description}</p>}
              <p>
                {fmt(graph.nodes.size)} crates and {fmt(graph.edges.size)} edges: {dirWord} of{' '}
                {options.mode === 'latest' ? 'the current version' : 'any version ever published'}
                {options.mode === 'latest' ? `, ${DEP_KINDS.filter((k) => options.kinds[k]).join('/')}${options.optional ? ' incl. optional' : ''}` : ''}, up to{' '}
                {meta?.depthReached ?? options.depth} hop{(meta?.depthReached ?? options.depth) === 1 ? '' : 's'} from the root.
              </p>
              <ExcludedHint graph={graph} options={options} />
              <p className="muted">
                Click a crate for its path from the root and details; double-click to fetch what it pulls in (or fold it back). "+N" is how many
                direct {dirWord} of that crate are not drawn.
              </p>
              <Legend options={options} />
            </>
          ) : (
            <>
              <h2>Nothing loaded</h2>
              <p className="muted">Load a crate to draw its dependency tree.</p>
              <Legend options={options} />
            </>
          )}
        </div>
      </aside>
    </>
  );
}

/** What the root's current version declares that the toolbar toggles leave out. */
function ExcludedHint({ graph, options }: { graph: DepsGraph; options: DepsOptions }) {
  if (options.mode !== 'latest' || graph.direction !== 'out') return null;
  const parts = Object.entries(excludedDeclarations(graph, options));
  if (parts.length === 0) return null;
  return (
    <p className="deps-hint">
      Not drawn: the current version also declares {parts.map(([k, n]) => `${fmt(n)} ${k}`).join(', ')} dependenc
      {parts.length === 1 && parts[0][1] === 1 ? 'y' : 'ies'}. Turn on {parts.map(([k]) => k).join(' / ')} in the toolbar to include them.
    </p>
  );
}

function Legend({ options }: { options: DepsOptions }) {
  return (
    <>
      <h3>Legend</h3>
      <ul className="legend">
        <li>
          <span className="swatch" style={{ background: DEPS_COLORS.root }} /> root crate (top row)
        </li>
        <li>
          <span className="swatch" style={{ background: DEPS_COLORS.crate }} /> crate; size = how many crates depend on it
        </li>
        <li>
          <span className="swatch" style={{ background: DEPS_COLORS.onPath }} /> on the path from the root to the selection
        </li>
        {options.mode === 'latest' ? (
          <>
            <li>
              <span className="line" style={{ background: DEPS_COLORS.kind.normal }} /> normal dependency
            </li>
            <li>
              <span className="line" style={{ background: DEPS_COLORS.kind.build }} /> build dependency
            </li>
            <li>
              <span className="line" style={{ background: DEPS_COLORS.kind.dev }} /> dev dependency
            </li>
            <li>
              <span className="line faint" style={{ background: DEPS_COLORS.kind.normal }} /> optional (feature-gated), drawn fainter
            </li>
          </>
        ) : (
          <li>
            <span className="line" style={{ background: DEPS_COLORS.kind.normal }} /> some version declared it; width = how many versions
          </li>
        )}
        <li>
          <span className="line" style={{ background: DEPS_COLORS.pathEdge }} /> path from the root to the selected crate
        </li>
        <li>
          <span className="line" style={{ background: DEPS_COLORS.kind.normal, opacity: 0.25 }} /> shortcut: an edge to a crate already reached by a
          shorter path (full strength when it touches the selection)
        </li>
      </ul>
    </>
  );
}

interface NodeDetailsProps {
  graph: DepsGraph;
  node: DepsNode;
  path: DepsPath | null;
  options: DepsOptions;
  busy: boolean;
  onSelect: (id: string) => void;
  onExpand: (name: string) => void;
  onCollapse: (name: string) => void;
  onTreeFrom: (name: string) => void;
  onFlip: (name: string) => void;
  onOpenInGraph: (name: string) => void;
}

function NodeDetails({ graph, node, path, options, busy, onSelect, onExpand, onCollapse, onTreeFrom, onFlip, onOpenInGraph }: NodeDetailsProps) {
  const isRoot = node.name === graph.root;
  const children = childrenOf(graph, node.name).sort(
    (a, b) => (graph.nodes.get(childOf(b, graph.direction))?.downloads ?? 0) - (graph.nodes.get(childOf(a, graph.direction))?.downloads ?? 0),
  );
  const parents = [...graph.edges.values()].filter((e) => childOf(e, graph.direction) === node.name);
  const more = notShown(node);
  const dirWord = graph.direction === 'out' ? 'dependencies' : 'dependents';
  const otherWord = graph.direction === 'out' ? 'dependents' : 'dependencies';
  return (
    <>
      <h2>
        <span className="badge crate">Crate</span> {node.name}
        {isRoot && graph.rootInfo.latest ? <span className="muted"> {graph.rootInfo.latest}</span> : null}
      </h2>
      {isRoot && <ExcludedHint graph={graph} options={options} />}
      <div className="actions deps-actions">
        {more > 0 ? (
          <button disabled={busy} onClick={() => onExpand(node.name)} title={`Fetch the ${fmt(more)} direct ${dirWord} not drawn`}>
            Show +{compact(more)}
          </button>
        ) : (
          !isRoot && (
            <button disabled={busy} onClick={() => onExpand(node.name)} title={`Fetch this crate's direct ${dirWord}`}>
              Expand
            </button>
          )
        )}
        {children.length > 0 && !isRoot && (
          <button disabled={busy} onClick={() => onCollapse(node.name)} title="Fold its subtree back into +N">
            Collapse
          </button>
        )}
        {!isRoot && (
          <button disabled={busy} onClick={() => onTreeFrom(node.name)} title="Make this crate the root">
            Tree from here
          </button>
        )}
        <button disabled={busy} onClick={() => onFlip(node.name)} title={`Root the tree here and show its ${otherWord} instead`}>
          {graph.direction === 'out' ? 'Who depends on it' : 'What it depends on'}
        </button>
        <button disabled={busy} onClick={() => onOpenInGraph(node.name)} title="Open in the Default graph view (versions, calls)">
          Open in graph
        </button>
      </div>
      <table className="props">
        <tbody>
          <tr>
            <th>hops from root</th>
            <td>{node.depth}</td>
          </tr>
          <tr>
            <th>downloads</th>
            <td>{fmt(node.downloads)}</td>
          </tr>
          <tr>
            <th>crates depending on it</th>
            <td title="crate-level, any version (LOD_DEP in-degree)">{fmt(node.dependents)}</td>
          </tr>
          <tr>
            <th>{dirWord} drawn</th>
            <td>
              {fmt(children.length)}
              {more > 0 ? ` (+${fmt(more)} not drawn)` : ''}
            </td>
          </tr>
          <tr>
            <th>crates.io</th>
            <td>
              <a className="ext" href={`https://crates.io/crates/${encodeURIComponent(node.name)}`} target="_blank" rel="noreferrer">
                crates.io/crates/{node.name}
              </a>
            </td>
          </tr>
        </tbody>
      </table>
      {path && path.names.length > 1 && (
        <>
          <h3>Path from {graph.root}</h3>
          <ol className="deps-path">
            {path.names.map((n, i) => {
              const edge = i > 0 ? path.steps[i - 1] : null;
              return (
                <li key={n}>
                  <button type="button" className="link" onClick={() => onSelect(n)}>
                    {n}
                  </button>
                  {edge && options.mode === 'latest' && (
                    <span className="muted small">
                      {' '}
                      {edge.kinds.join('+') || 'normal'}
                      {edge.optional ? ', optional' : ''}
                      {edge.req ? ` ${edge.req}` : ''}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {children.length > 0 && (
        <>
          <h3>
            {dirWord} ({children.length})
          </h3>
          <ul className="deps-children">
            {children.slice(0, 40).map((e) => {
              const c = childOf(e, graph.direction);
              const cn = graph.nodes.get(c);
              return (
                <li key={c}>
                  <button type="button" className="link" onClick={() => onSelect(c)}>
                    {c}
                  </button>
                  <span className="muted small">
                    {options.mode === 'latest'
                      ? ` ${e.kinds.join('+') || 'normal'}${e.optional ? ', optional' : ''}${e.req ? ` ${e.req}` : ''}`
                      : ` ${e.versions ?? '?'} versions`}
                    {cn && cn.dependents > 0 ? ` · ${compact(cn.dependents)} dependents` : ''}
                  </span>
                </li>
              );
            })}
            {children.length > 40 && <li className="muted">… {children.length - 40} more</li>}
          </ul>
        </>
      )}
      {parents.length > 1 && (
        <>
          <h3>Also reached from</h3>
          <ul className="deps-children">
            {parents.slice(0, 20).map((e) => {
              const p = parentOf(e, graph.direction);
              return (
                <li key={p}>
                  <button type="button" className="link" onClick={() => onSelect(p)}>
                    {p}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

function EdgeDetails({ graph, edge, options, onSelect }: { graph: DepsGraph; edge: DepsEdge; options: DepsOptions; onSelect: (id: string) => void }) {
  return (
    <>
      <h2>
        <span className="badge rel">DEPENDS_ON</span>{' '}
        <button type="button" className="link" onClick={() => onSelect(edge.from)}>
          {edge.from}
        </button>{' '}
        →{' '}
        <button type="button" className="link" onClick={() => onSelect(edge.to)}>
          {edge.to}
        </button>
      </h2>
      <p className="muted">{describeEdge(edge, options.mode)}</p>
      <table className="props">
        <tbody>
          {options.mode === 'latest' ? (
            <>
              <tr>
                <th>kind</th>
                <td>{edge.kinds.join(', ') || 'normal'}</td>
              </tr>
              <tr>
                <th>optional</th>
                <td>{edge.optional ? 'yes (feature-gated)' : 'no'}</td>
              </tr>
              <tr>
                <th>requirement</th>
                <td>{edge.req ?? '–'}</td>
              </tr>
            </>
          ) : (
            <tr>
              <th>versions declaring it</th>
              <td>{fmt(edge.versions)}</td>
            </tr>
          )}
          <tr>
            <th>hops</th>
            <td>
              {graph.nodes.get(edge.from)?.depth ?? '?'} → {graph.nodes.get(edge.to)?.depth ?? '?'}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        {options.mode === 'latest'
          ? 'From the current version of the dependent, as declared in its manifest (not a resolved lock file).'
          : 'Crate-level: aggregated over every version the dependent ever published.'}
      </p>
    </>
  );
}

