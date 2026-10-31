// Callers view: one search box for a function, then its callers aggregated per crate (a tree that
// expands into functions, and from a function into its own callers), mirrored by an NVL graph of
// crate -> crate call edges. The callee's version is never resolved in the graph, so a pinned version
// is checked against each caller's DEPENDS_ON requirement (verified / unverified / excluded).

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type NVL from '@neo4j-nvl/base';
import type { Node as NvlNode, Relationship as NvlRel, NvlOptions } from '@neo4j-nvl/base';
import { InteractiveNvlWrapper, type MouseEventCallbacks } from '@neo4j-nvl/react';
import {
  api,
  ApiError,
  type CallerCrate,
  type CallerSort,
  type CalleesResult,
  type CallersQuery,
  type CallersResult,
  type CrateVersion,
  type SymbolHit,
  type SymbolSearchResult,
} from '../api';
import { COLORS } from '../graph';
import { hasWildcard } from '../match';
import { fmtCompact } from './meta';
import { useIsMobile, useTouchZoomPan } from '../touch';

interface Props {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  /** Open a crate in the Default graph. */
  onOpenCrate: (name: string) => void;
  /** Open a crate in the Deps view. */
  onOpenDeps: (name: string) => void;
}

type Mode = 'callers' | 'callees';

const EXAMPLES = ['serde_json::from_str', 'regex::Regex::new', 'tokio::spawn', 'openssl::ssl::SslRef', 'libc::'];
/** Caller crates drawn per expanded node, from the current page; the table pages through them all. */
const GRAPH_NODES_ROOT = 60;
const GRAPH_NODES_CHILD = 20;
/** Caller crates per page (server max 500); a function's own callers page in smaller steps. */
const PAGE_SIZES = [50, 100, 200, 500];
const DEFAULT_PAGE = 100;
const CHILD_PAGE = 50;
const NOT_FOUND_HINT = 'pick a suggestion or use * (e.g. serde_json::*from_str)';
const UNVERIFIED_COLOR = '#6b7280';

const errorMessage = (err: unknown) =>
  err instanceof ApiError ? (err.code ? `${err.message} [${err.code}]` : err.message) : err instanceof Error ? err.message : String(err);

/** Same rule as `analysis::crate_of`: the first path segment, underscored. */
const crateOf = (symbol: string) => /[A-Za-z0-9_]+(?=::)/.exec(symbol)?.[0] ?? null;
const normCrate = (name: string) => name.replace(/-/g, '_');
/** `serde_json::de::from_str` -> `from_str`; trait impls keep their last two segments. */
const shortName = (symbol: string) => {
  const parts = symbol.split('::');
  return parts.length > 2 ? parts.slice(-2).join('::') : symbol;
};

// ---------------------------------------------------------------------------
// Search box with suggestions grouped by crate.

function SymbolSearch({ value, onChange, onPick, autoFocus }: { value: string; onChange: (v: string) => void; onPick: (hit: SymbolHit) => void; autoFocus?: boolean }) {
  const [result, setResult] = useState<SymbolSearchResult | null>(null);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(-1);
  /** Why Enter opened nothing (no exact symbol, no pattern match). */
  const [notice, setNotice] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    window.clearTimeout(timer.current);
    abort.current?.abort();
    const q = value.trim();
    if (!open || q.length < 2) {
      setResult(null);
      setSearching(false);
      return;
    }
    timer.current = window.setTimeout(() => {
      const ctl = new AbortController();
      abort.current = ctl;
      setSearching(true);
      api
        .searchSymbols(q, 30, ctl.signal)
        .then((r) => {
          if (ctl.signal.aborted) return;
          setResult(r);
          setActive(-1);
        })
        .catch(() => undefined)
        .finally(() => !ctl.signal.aborted && setSearching(false));
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [value, open]);

  // Flat list for keyboard navigation: crate prefixes first, then symbols in crate groups (a pattern
  // keeps its most-callers-first order instead of grouping).
  const items = useMemo(() => {
    if (!result) return [] as { kind: 'crate' | 'symbol'; hit?: SymbolHit; crate: string }[];
    const out: { kind: 'crate' | 'symbol'; hit?: SymbolHit; crate: string }[] = result.crates.map((c) => ({ kind: 'crate' as const, crate: c }));
    if (result.pattern) {
      for (const hit of result.symbols) out.push({ kind: 'symbol', hit, crate: hit.crate });
      return out;
    }
    const groups = new Map<string, SymbolHit[]>();
    for (const s of result.symbols) {
      if (!groups.has(s.crate)) groups.set(s.crate, []);
      groups.get(s.crate)!.push(s);
    }
    for (const [crate, hits] of groups) for (const hit of hits) out.push({ kind: 'symbol', hit, crate });
    return out;
  }, [result]);

  const pick = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'crate') {
      onChange(`${it.crate}::`);
      setOpen(true);
      return;
    }
    setOpen(false);
    onPick(it.hit!);
  };

  // Enter without a highlighted suggestion: plain text opens only that exact function, a pattern its
  // match with the most callers. Never the first fuzzy suggestion.
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    if (/::$/.test(text)) return setOpen(true);
    setResolving(true);
    setNotice(null);
    api
      .resolveSymbol(text)
      .then((r) => {
        if (r.symbol) {
          setOpen(false);
          onPick(r.symbol);
        } else {
          setNotice(r.pattern ? `no function matches the pattern “${text}”${r.hint ? ` · ${r.hint}` : ''}` : `no function named “${text}” · ${NOT_FOUND_HINT}`);
          setOpen(true);
        }
      })
      .catch((err) => setNotice(errorMessage(err)))
      .finally(() => setResolving(false));
  };

  const pattern = hasWildcard(value);
  let lastGroup: string | null = null;
  return (
    <div className="search fn">
      <input
        type="text"
        placeholder="Function, e.g. serde_json::de::from_str, or a pattern like serde_json::*from_str"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          setNotice(null);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, -1));
          } else if (e.key === 'Enter') {
            if (active >= 0) pick(active);
            else submit();
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        spellCheck={false}
      />
      {open && (notice || resolving || searching || items.length > 0 || (result && value.trim().length >= 2)) && (
        <ul className="suggestions grouped">
          {notice && <li className="group notice">{notice}</li>}
          {resolving && <li className="group">opening…</li>}
          {result?.pattern && result.symbols.length > 0 && (
            <li className="group">
              pattern matches, most callers first{result.seed ? <span className="muted"> · checked the first {result.scan?.toLocaleString()} names containing “{result.seed}”</span> : null}
            </li>
          )}
          {items.map((it, i) => {
            const header = !result?.pattern && it.kind === 'symbol' && it.crate !== lastGroup ? it.crate : null;
            if (it.kind === 'symbol') lastGroup = it.crate;
            return (
              <Fragment key={it.kind === 'crate' ? `c:${it.crate}` : `s:${it.hit!.name}`}>
                {it.kind === 'crate' && i === 0 && <li className="group">crates · pick one to list its functions</li>}
                {header && (
                  <li className="group">
                    {header}
                    {result?.scope && i === result.crates.length ? <span className="muted"> · functions of this crate matching the rest</span> : null}
                  </li>
                )}
                <li className={`${i === active ? 'active' : ''} ${it.kind}`} onMouseDown={() => pick(i)} title={it.hit?.name ?? `${it.crate}::`}>
                  {it.kind === 'crate' ? (
                    <span className="mono">{it.crate}::</span>
                  ) : (
                    <>
                      <span className="mono name">{it.hit!.name}</span>
                      <span className="calls">{it.hit!.calls ? `${fmtCompact(it.hit!.calls)} callers` : 'no callers'}</span>
                    </>
                  )}
                </li>
              </Fragment>
            );
          })}
          {searching && <li className="group">searching…</li>}
          {!searching && result && items.length === 0 && !notice && (
            <li className="group">
              {result.hint
                ? result.hint
                : result.pattern
                  ? <>no function matches the pattern “{value.trim()}” · patterns match the whole demangled path; try <span className="mono">*{value.trim().replace(/^\*+/, '')}</span></>
                  : <>no function contains “{value.trim()}” · names are case-sensitive demangled paths; try <span className="mono">crate::</span> to list a crate's functions</>}
            </li>
          )}
          {!searching && result && result.symbols.length >= 30 && !result.scope && <li className="group">top 30 by callers · add a crate:: prefix to narrow</li>}
          {!searching && result && items.length > 0 && !pattern && !notice && <li className="group muted">Enter opens only an exact name · ↑↓ to pick a suggestion · * and ? for patterns</li>}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Caller crate filter: exact name or pattern, with hints from the cached caller list.

function CrateFilter({ value, query, onChange, onApply }: { value: string; query: CallersQuery | null; onChange: (v: string) => void; onApply: (v: string) => void }) {
  const [hints, setHints] = useState<{ names: { crate: string; downloads: number; fns: number }[]; matches: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const queryKey = query ? JSON.stringify([query.fn, query.versions, query.local, query.cap]) : '';

  useEffect(() => {
    const text = value.trim();
    if (!open || !text || !query) {
      setHints(null);
      return;
    }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api
        .callerCrates(query, text, 12, ctl.signal)
        .then((r) => {
          if (ctl.signal.aborted) return;
          setHints(r);
          setActive(-1);
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, open, queryKey]);

  const pick = (name: string) => {
    onChange(name);
    onApply(name);
    setOpen(false);
  };

  return (
    <div className="search callers-filter">
      <input
        type="text"
        placeholder="Caller crate, or a pattern like tokio*"
        title="Exact caller crate name (case-insensitive); * and ? make it a pattern. Hints list caller crates containing what you type."
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          const n = hints?.names.length ?? 0;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, n - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, -1));
          } else if (e.key === 'Enter') {
            if (active >= 0 && hints?.names[active]) pick(hints.names[active].crate);
            else {
              onApply(value);
              setOpen(false);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        spellCheck={false}
      />
      {value && (
        <button className="link clear" title="Clear the filter" onMouseDown={(e) => e.preventDefault()} onClick={() => pick('')}>
          ×
        </button>
      )}
      {open && hints && (
        <ul className="suggestions">
          <li className="group">
            {hints.matches
              ? `${hints.matches.toLocaleString()} caller crate${hints.matches === 1 ? '' : 's'} ${hasWildcard(value) ? 'match' : 'contain'} “${value.trim()}”${hints.matches > hints.names.length ? ` · top ${hints.names.length}` : ''}`
              : `no caller crate ${hasWildcard(value) ? 'matches' : 'contains'} “${value.trim()}”`}
          </li>
          {hints.names.map((h, i) => (
            <li key={h.crate} className={i === active ? 'active' : ''} onMouseDown={() => pick(h.crate)}>
              <span className="mono name">{h.crate}</span>
              <span className="calls">{h.fns.toLocaleString()} fn · {fmtCompact(h.downloads)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree state: one node per (function, pinned versions) whose callers were fetched.

interface TreeNode {
  key: string;
  fn: string;
  /** Crate the function belongs to (symbol path), once known. */
  crate: string | null;
  versions: string[] | null;
  local: { crate: string; versions: string[] } | null;
  /** Graph node the callers attach to: the root symbol or the crate whose function this is. */
  parentGraphId: string;
  depth: number;
  result: CallersResult | null;
  loading: boolean;
  error: string | null;
  openCrates: Set<string>;
  openFns: Set<string>;
  /** Page of caller crates (sorted and filtered server-side). */
  offset: number;
  limit: number;
  /** Request sequence: a response for an older page / sort is dropped. */
  req: number;
  /** Calling functions to expand; undefined = server default, raised by "expand all". */
  cap?: number;
}

const ROOT = 'root';
const fnKey = (parent: string, crate: string, fn: string) => `${parent}/${crate}/${fn}`;

let reqSeq = 0;

const makeNode = (key: string, fn: string, parentGraphId: string, depth: number, versions: string[] | null, local: TreeNode['local'], limit = depth ? CHILD_PAGE : DEFAULT_PAGE): TreeNode => ({
  key,
  fn,
  crate: crateOf(fn),
  versions,
  local,
  parentGraphId,
  depth,
  result: null,
  loading: true,
  error: null,
  openCrates: new Set(),
  openFns: new Set(),
  offset: 0,
  limit,
  req: ++reqSeq,
});

const nodeQuery = (n: TreeNode): CallersQuery => ({ fn: n.fn, versions: n.versions, local: n.local, cap: n.cap });

/** `1–100 of 1,853 crates` with prev / next. */
function Pager({ meta, onPage, busy }: { meta: CallersResult['meta']; onPage: (offset: number) => void; busy?: boolean }) {
  if (!meta.crates) return null;
  const from = meta.offset + 1;
  const to = Math.min(meta.offset + meta.limit, meta.crates);
  return (
    <span className="callers-pager">
      <button className="link" disabled={busy || meta.offset === 0} onClick={() => onPage(Math.max(0, meta.offset - meta.limit))} title="Previous page">
        ‹ prev
      </button>
      <span>
        {from.toLocaleString()}–{to.toLocaleString()} of {meta.crates.toLocaleString()} crate{meta.crates === 1 ? '' : 's'}
      </span>
      <button className="link" disabled={busy || !meta.hasMore} onClick={() => onPage(meta.offset + meta.limit)} title="Next page">
        next ›
      </button>
    </span>
  );
}

/**
 * Version to pin by default: the latest, unless that is a pre-release (libc's latest is 1.0.0-alpha,
 * which no `^0.2` requirement admits); then the newest stable release. `vs` is newest first.
 */
const defaultPin = (vs: CrateVersion[]) => {
  const latest = vs.find((v) => v.latest) ?? vs[0];
  if (!latest) return '';
  if (!latest.version.includes('-')) return latest.version;
  return vs.find((v) => !v.version.includes('-'))?.version ?? latest.version;
};

const statusBadge = (c: CallerCrate, pinned: boolean) => {
  if (!pinned) return null;
  if (c.unverified && !c.verified) return <span className="badge unverified" title="No direct dependency on the callee crate to check the requirement against (the call came through a generic instantiated elsewhere)">unverified</span>;
  if (c.unverified) return <span className="badge unverified" title={`${c.unverified} of ${c.versions.length} calling versions have no direct dependency to check`}>{c.unverified} unverified</span>;
  if (c.versions.some((v) => v.status === 'same')) return <span className="badge same" title="Calls inside the callee crate itself, same version">same crate</span>;
  return null;
};

const versionsSummary = (c: CallerCrate) => {
  const latest = c.versions.find((v) => v.latest);
  const newest = c.versions[0];
  if (c.versions.length === 1) return <span>{newest.version}{latest ? <span className="muted"> latest</span> : null}</span>;
  return (
    <span title={c.versions.map((v) => `${v.version}${v.latest ? ' (latest)' : ''}: ${v.fns} fn`).join('\n')}>
      {c.versions.length} versions <span className="muted">to {newest.version}{latest ? ' (latest)' : ''}</span>
    </span>
  );
};

export function CallersView({ busy, onBusy, onError, onOpenCrate, onOpenDeps }: Props) {
  const isMobile = useIsMobile();
  const [query, setQuery] = useState('');
  const [root, setRoot] = useState<{ fn: string; crate: string } | null>(null);
  const [versions, setVersions] = useState<CrateVersion[]>([]);
  /** '' = any version. */
  const [pin, setPin] = useState('');
  const [mode, setMode] = useState<Mode>('callers');
  const [tree, setTree] = useState<Map<string, TreeNode>>(new Map());
  const [callees, setCallees] = useState<CalleesResult | null>(null);
  const [calleesLoading, setCalleesLoading] = useState(false);
  /** Filter box text, and the caller crate filter applied server-side (debounced from it). */
  const [filterText, setFilterText] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: CallerSort; desc: boolean }>({ key: 'downloads', desc: true });
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE);
  // fetchNode reads the current sort / filter without being recreated (open / back capture it).
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const [selectedCrate, setSelectedCrate] = useState<string | null>(null);
  const [history, setHistory] = useState<{ fn: string; crate: string; pin: string }[]>([]);
  const [showGraph, setShowGraph] = useState(true);
  const nvlRef = useRef<NVL>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  useTouchZoomPan(canvasEl, nvlRef);
  const treeRef = useRef<HTMLDivElement>(null);
  const run = useRef(0);

  const updateNode = useCallback((key: string, patch: (n: TreeNode) => TreeNode) => {
    setTree((t) => {
      const n = t.get(key);
      if (!n) return t;
      const next = new Map(t);
      next.set(key, patch(n));
      return next;
    });
  }, []);

  const fetchNode = useCallback(
    async (node: TreeNode, isRoot: boolean) => {
      if (isRoot) {
        onBusy(true);
        onError(null);
      }
      try {
        const result = await api.callers({
          ...nodeQuery(node),
          offset: node.offset,
          limit: node.limit,
          sort: sortRef.current.key,
          desc: sortRef.current.desc,
          // The filter narrows the root's caller crates; a function's own callers are never filtered.
          filter: isRoot ? filterRef.current : undefined,
        });
        updateNode(node.key, (n) =>
          n.req !== node.req
            ? n
            : {
                ...n,
                result,
                crate: result.target.crate ?? n.crate,
                loading: false,
                error: null,
                openCrates: isRoot && result.meta.crates === 1 && result.callers.length === 1 ? new Set([result.callers[0].crate]) : n.openCrates,
              },
        );
      } catch (err) {
        updateNode(node.key, (n) => (n.req !== node.req ? n : { ...n, loading: false, error: errorMessage(err) }));
        if (isRoot) onError(errorMessage(err));
      } finally {
        if (isRoot) onBusy(false);
      }
    },
    [onBusy, onError, updateNode],
  );

  /** Re-query a node (new page, sort, filter, cap), keeping its rows on screen until the answer arrives. */
  const refetch = useCallback(
    (node: TreeNode, patch: Partial<TreeNode> = {}) => {
      const next: TreeNode = { ...node, ...patch, loading: true, error: null, req: ++reqSeq };
      setTree((t) => (t.has(node.key) ? new Map(t).set(node.key, next) : t));
      void fetchNode(next, node.key === ROOT);
    },
    [fetchNode],
  );

  // Sort applies to every loaded node (each answers from the server's cached aggregate), back to page 1.
  const sortKey = `${sort.key}:${sort.desc}`;
  const lastSort = useRef(sortKey);
  useEffect(() => {
    if (lastSort.current === sortKey) return;
    lastSort.current = sortKey;
    for (const n of tree.values()) if (n.result || n.loading) refetch(n, { offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey]);

  // The filter box applies after a pause; picking a hint or Enter applies at once.
  useEffect(() => {
    const t = window.setTimeout(() => setFilter(filterText.trim()), 400);
    return () => window.clearTimeout(t);
  }, [filterText]);
  const lastFilter = useRef(filter);
  useEffect(() => {
    if (lastFilter.current === filter) return;
    lastFilter.current = filter;
    const n = tree.get(ROOT);
    if (n) refetch(n, { offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  /** Start over from a function: pinned to `pinTo` (undefined = latest once the versions load). */
  const open = useCallback(
    (fn: string, crate: string, pinTo?: string, pushHistory = true) => {
      const id = ++run.current;
      if (pushHistory && root) setHistory((h) => [...h.slice(-19), { fn: root.fn, crate: root.crate, pin }]);
      setRoot({ fn, crate });
      setQuery(fn);
      setSelectedCrate(null);
      setCallees(null);
      setFilterText('');
      setFilter('');
      lastFilter.current = '';
      filterRef.current = '';
      setVersions([]);
      setPin(pinTo ?? '');
      if (pinTo !== undefined) {
        const node = makeNode(ROOT, fn, 'sym:root', 0, pinTo ? [pinTo] : null, null, pageSize);
        setTree(new Map([[ROOT, node]]));
        void fetchNode(node, true);
      } else {
        setTree(new Map());
        onBusy(true);
      }
      api
        .crateVersions(crate)
        .then((vs) => {
          if (id !== run.current) return;
          setVersions(vs);
          if (pinTo === undefined) {
            const latest = defaultPin(vs);
            setPin(latest);
            const node = makeNode(ROOT, fn, 'sym:root', 0, latest ? [latest] : null, null, pageSize);
            setTree(new Map([[ROOT, node]]));
            void fetchNode(node, true);
          }
        })
        .catch(() => {
          if (id !== run.current || pinTo !== undefined) return;
          const node = makeNode(ROOT, fn, 'sym:root', 0, null, null, pageSize);
          setTree(new Map([[ROOT, node]]));
          void fetchNode(node, true);
        });
    },
    [fetchNode, onBusy, pin, root, pageSize],
  );

  const changePin = (value: string) => {
    if (!root) return;
    setPin(value);
    const node = makeNode(ROOT, root.fn, 'sym:root', 0, value ? [value] : null, null, pageSize);
    setTree(new Map([[ROOT, node]]));
    setSelectedCrate(null);
    void fetchNode(node, true);
    if (mode === 'callees') setCallees(null);
  };

  const expandAll = () => {
    const node = tree.get(ROOT);
    if (!node?.result) return;
    refetch(node, { cap: node.result.meta.total + 1000, offset: 0 });
  };

  const changePageSize = (limit: number) => {
    setPageSize(limit);
    const node = tree.get(ROOT);
    if (node) refetch(node, { limit, offset: 0 });
  };

  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    open(prev.fn, prev.crate, prev.pin, false);
  };

  // Callees of the root function, for the chosen version when it is exported, else the newest exported.
  const calleesKey = root ? `${root.fn}@${pin}` : '';
  const calleesFor = useRef('');
  useEffect(() => {
    if (mode !== 'callees' || !root || calleesFor.current === calleesKey) return;
    calleesFor.current = calleesKey;
    setCallees(null);
    setCalleesLoading(true);
    const pinnedExported = pin && versions.find((v) => v.version === pin)?.exported;
    api
      .callees(root.fn, root.crate, pinnedExported ? pin : null)
      .then((r) => calleesFor.current === calleesKey && setCallees(r))
      .catch((err) => calleesFor.current === calleesKey && onError(errorMessage(err)))
      .finally(() => calleesFor.current === calleesKey && setCalleesLoading(false));
  }, [mode, root, calleesKey, pin, versions, onError]);

  const toggleCrate = (node: TreeNode, crate: string) =>
    updateNode(node.key, (n) => {
      const openCrates = new Set(n.openCrates);
      if (openCrates.has(crate)) openCrates.delete(crate);
      else openCrates.add(crate);
      return { ...n, openCrates };
    });

  const toggleFn = (node: TreeNode, c: CallerCrate, fn: string) => {
    const key = fnKey(node.key, c.crate, fn);
    const wasOpen = node.openFns.has(key);
    updateNode(node.key, (n) => {
      const openFns = new Set(n.openFns);
      if (wasOpen) openFns.delete(key);
      else openFns.add(key);
      return { ...n, openFns };
    });
    if (wasOpen || tree.has(key)) return;
    const vs = c.versions.map((v) => v.version);
    const own = crateOf(fn);
    const local = own && normCrate(own) !== normCrate(c.crate) ? { crate: c.crate, versions: vs } : null;
    const child = makeNode(key, fn, `crate:${c.crate}`, node.depth + 1, vs, local);
    setTree((t) => new Map(t).set(key, child));
    void fetchNode(child, false);
  };

  const rootNode = tree.get(ROOT) ?? null;
  const pinned = Boolean(pin);

  // ---- graph -------------------------------------------------------------
  const graph = useMemo(() => {
    const nodes = new Map<string, NvlNode>();
    const rels: NvlRel[] = [];
    if (!root) return { nodes: [], rels: [], hidden: 0 };
    nodes.set('sym:root', { id: 'sym:root', caption: shortName(root.fn), color: COLORS.INVOKES, size: 56, selected: selectedCrate === null });
    let hidden = 0;
    const edgeFns = new Map<string, { fns: number; unverifiedOnly: boolean; index: number }>();
    const crateNode = (name: string, downloads: number, depth: number) => {
      const id = `crate:${name}`;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          caption: name,
          color: depth > 1 ? '#7FB0FF' : COLORS.crate,
          // Captions are drawn inside the node, so small nodes get unreadable labels: 26 px minimum.
          size: Math.min(26 + Math.log10(downloads + 1) * 4, 64),
          selected: selectedCrate === name,
        });
      }
      return id;
    };
    if (mode === 'callees') {
      for (const c of callees?.callees ?? []) {
        const id = crateNode(c.crate, c.downloads, 1);
        rels.push({ id: `callee:${c.crate}`, from: 'sym:root', to: id, color: COLORS.versionLatest, width: Math.min(1 + Math.log2(c.functions.length + 1), 8) });
      }
      return { nodes: [...nodes.values()], rels, hidden: 0 };
    }
    for (const node of tree.values()) {
      // A child whose parent crate is not drawn (hidden past the budget) would float unattached.
      if (!node.result || !nodes.has(node.parentGraphId)) continue;
      const budget = node.key === ROOT ? GRAPH_NODES_ROOT : GRAPH_NODES_CHILD;
      // The current page only, in its sort order; expanded crates first so they stay visible.
      const list = node.result.callers;
      const picked = [...list.filter((c) => node.openCrates.has(c.crate)), ...list.filter((c) => !node.openCrates.has(c.crate))].slice(0, budget);
      hidden += node.result.meta.crates - picked.length;
      for (const c of picked) {
        const id = crateNode(c.crate, c.downloads, node.depth + 1);
        if (id === node.parentGraphId) continue; // calls inside the same crate: no self-loop
        const onlyUnverified = c.unverified > 0 && c.verified === 0;
        // Two expanded functions of one crate can share a caller crate: one edge, summed.
        const relId = `calls:${id}->${node.parentGraphId}`;
        const prev = edgeFns.get(relId);
        const fns = (prev?.fns ?? 0) + c.fns;
        const rel: NvlRel = {
          id: relId,
          from: id,
          to: node.parentGraphId,
          color: onlyUnverified && (!prev || prev.unverifiedOnly) ? UNVERIFIED_COLOR : node.depth === 0 ? COLORS.INVOKES : COLORS.crate,
          width: Math.min(1 + Math.log2(fns + 1), 8),
          // Width carries the count; numeric captions on 60 converging edges were unreadable noise.
          caption: undefined,
        };
        edgeFns.set(relId, { fns, unverifiedOnly: onlyUnverified && (!prev || prev.unverifiedOnly), index: prev?.index ?? rels.length });
        if (prev) rels[prev.index] = rel;
        else rels.push(rel);
      }
    }
    return { nodes: [...nodes.values()], rels, hidden };
  }, [tree, root, selectedCrate, mode, callees]);

  const fitAll = useCallback(() => {
    const nvl = nvlRef.current;
    if (!nvl) return;
    const ids = nvl.getNodes().map((n) => n.id);
    if (ids.length) nvl.fit(ids, { animated: true });
  }, []);

  const graphCount = graph.nodes.length;
  useEffect(() => {
    const t = window.setTimeout(fitAll, 500);
    return () => window.clearTimeout(t);
  }, [graphCount, fitAll]);

  const nvlOptions = useMemo<NvlOptions>(
    () => ({
      // A star of 60 callers is one column in the hierarchical layout; force-directed spreads it and
      // puts second-level callers around the crate they reach.
      layout: 'forceDirected',
      renderer: 'canvas',
      initialZoom: 1,
      minZoom: 0.05,
      maxZoom: 20,
      allowDynamicMinZoom: true,
      styling: { defaultNodeColor: '#888888', defaultRelationshipColor: '#666666', selectedBorderColor: '#ffffff', selectedInnerBorderColor: '#111111' },
    }),
    [],
  );

  const scrollToCrate = (name: string) => {
    const el = treeRef.current?.querySelector(`[data-crate="${CSS.escape(name)}"]`);
    el?.scrollIntoView({ block: 'center' });
  };

  const mouseEventCallbacks = useMemo<MouseEventCallbacks>(
    () => ({
      onNodeClick: (n: NvlNode) => {
        if (n.id.startsWith('crate:')) {
          const name = n.id.slice(6);
          setSelectedCrate(name);
          scrollToCrate(name);
        } else setSelectedCrate(null);
      },
      onNodeDoubleClick: (n: NvlNode) => {
        if (!n.id.startsWith('crate:')) return;
        const name = n.id.slice(6);
        const node = rootNode?.result?.callers.some((c) => c.crate === name) ? rootNode : [...tree.values()].find((t) => t.result?.callers.some((c) => c.crate === name));
        if (node && !node.openCrates.has(name)) toggleCrate(node, name);
        scrollToCrate(name);
      },
      onCanvasClick: () => setSelectedCrate(null),
      onHover: true,
      onPan: true,
      onZoomAndPan: true,
      onDrag: true,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootNode, tree],
  );

  // ---- rendering ---------------------------------------------------------
  const renderNode = (node: TreeNode): ReactElement[] => {
    const indent = { paddingLeft: `${10 + node.depth * 22}px` };
    if (!node.result && node.loading) return [<tr key={`${node.key}:loading`} className="info"><td colSpan={5} style={indent}>Loading callers of <span className="mono">{shortName(node.fn)}</span>…</td></tr>];
    if (node.error) return [<tr key={`${node.key}:err`} className="info"><td colSpan={5} style={indent} className="danger">{node.error}</td></tr>];
    const r = node.result!;
    const isRoot = node.key === ROOT;
    if (!r.meta.allCrates) {
      return [
        <tr key={`${node.key}:none`} className="info">
          <td colSpan={5} style={indent}>
            {r.meta.total === 0
              ? `No exported crate calls ${shortName(node.fn)}${r.meta.definitions ? ` (defined in ${r.meta.definitions} version${r.meta.definitions === 1 ? '' : 's'})` : ''}.`
              : `${r.meta.total.toLocaleString()} calling function${r.meta.total === 1 ? '' : 's'}, but none in a version that can use ${node.versions?.join(', ') ?? 'it'} (${r.meta.rejected} excluded by requirement).`}
          </td>
        </tr>,
      ];
    }
    if (!r.callers.length && r.meta.filter) {
      return [
        <tr key={`${node.key}:nomatch`} className="info">
          <td colSpan={5} style={indent}>
            {hasWildcard(r.meta.filter) ? (
              <>No caller crate matches <span className="mono">{r.meta.filter}</span></>
            ) : (
              <>
                No caller crate named <span className="mono">{r.meta.filter}</span> · pick a hint or use * (e.g. <span className="mono">{r.meta.filter}*</span>)
              </>
            )}{' '}
            <span className="muted">({r.meta.allCrates.toLocaleString()} caller crates in all)</span>
          </td>
        </tr>,
      ];
    }
    const rows: ReactElement[] = [];
    for (const c of r.callers) {
      const openC = node.openCrates.has(c.crate);
      rows.push(
        <tr key={`${node.key}:${c.crate}`} className={`crate-row${selectedCrate === c.crate ? ' selected' : ''}${openC ? ' open' : ''}${node.loading ? ' stale' : ''}`} data-crate={c.crate} onClick={() => { toggleCrate(node, c.crate); setSelectedCrate(c.crate); }}>
          <td className="crate" style={indent}>
            <span className="caret">{openC ? '▾' : '▸'}</span>
            <b>{c.crate}</b>
            {statusBadge(c, pinned)}
          </td>
          <td className="num" title="Distinct calling functions across the calling versions">{c.fns.toLocaleString()}</td>
          <td className="versions">{versionsSummary(c)}</td>
          <td className="num muted" title={c.downloads.toLocaleString()}>{fmtCompact(c.downloads)}</td>
          <td className="row-actions">
            <button className="link" title="Open this crate in the Default graph" onClick={(e) => { e.stopPropagation(); onOpenCrate(c.crate); }}>graph</button>
            <button className="link" title="Open this crate's dependency chain" onClick={(e) => { e.stopPropagation(); onOpenDeps(c.crate); }}>deps</button>
          </td>
        </tr>,
      );
      if (!openC) continue;
      const fnIndent = { paddingLeft: `${10 + (node.depth + 1) * 22}px` };
      for (const f of c.functions) {
        const key = fnKey(node.key, c.crate, f.name);
        const openF = node.openFns.has(key);
        const child = tree.get(key);
        const foreign = (() => { const own = crateOf(f.name); return own !== null && normCrate(own) !== normCrate(c.crate); })();
        rows.push(
          <tr key={key} className={`fn-row${openF ? ' open' : ''}`}>
            <td className="function" style={fnIndent} colSpan={2}>
              <button className="caret" title={openF ? 'Hide the callers of this function' : 'Who calls this function? (one more level)'} onClick={() => toggleFn(node, c, f.name)}>
                {openF ? '▾' : '▸'}
              </button>
              <span className="mono name" title={f.name}>{f.name}</span>
              {foreign && <span className="badge foreign" title={`Defined in ${crateOf(f.name)}, monomorphised inside ${c.crate}; only these versions of ${c.crate} can call it`}>copy of {crateOf(f.name)}</span>}
            </td>
            <td className="versions muted">{f.versions === c.versions.length ? (c.versions.length > 1 ? 'all versions' : '') : `${f.versions} of ${c.versions.length} versions`}</td>
            <td />
            <td className="row-actions">
              <button className="link" title="Make this function the root: its callers, its callees, its own version pin" onClick={() => open(f.name, foreign ? crateOf(f.name)! : c.crate)}>
                focus
              </button>
            </td>
          </tr>,
        );
        if (openF && child) rows.push(...renderNode(child));
      }
      if (c.functionCount > c.functions.length) {
        rows.push(
          <tr key={`${node.key}:${c.crate}:more`} className="info">
            <td colSpan={5} style={fnIndent} className="muted">+{(c.functionCount - c.functions.length).toLocaleString()} more functions in {c.crate} (showing the {c.functions.length} present in most versions)</td>
          </tr>,
        );
      }
    }
    // The root pages from the summary bar; a function's own callers page in place.
    if (!isRoot && (r.meta.offset > 0 || r.meta.hasMore)) {
      rows.push(
        <tr key={`${node.key}:pager`} className="info">
          <td colSpan={5} style={indent}>
            <Pager meta={r.meta} busy={node.loading} onPage={(offset) => refetch(node, { offset })} />
          </td>
        </tr>,
      );
    }
    if (isRoot && r.meta.hasMore) {
      rows.push(
        <tr key={`${node.key}:next`} className="info">
          <td colSpan={5} style={indent}>
            <Pager meta={r.meta} busy={node.loading} onPage={(offset) => { refetch(node, { offset }); treeRef.current?.scrollTo({ top: 0 }); }} />
          </td>
        </tr>,
      );
    }
    if (isRoot && r.meta.crates < r.meta.allCrates) {
      rows.push(<tr key={`${node.key}:filtered`} className="info"><td colSpan={5} style={indent} className="muted">{(r.meta.allCrates - r.meta.crates).toLocaleString()} caller crates hidden by the filter</td></tr>);
    }
    return rows;
  };

  const renderCallees = () => {
    if (calleesLoading || !callees) return <p className="muted pad">Loading what {root ? shortName(root.fn) : 'it'} calls…</p>;
    if (!callees.from) return <p className="muted pad">No exported version of {root?.crate} defines {root ? shortName(root.fn) : 'this function'} (painter only has bitcode for compiled versions).</p>;
    return (
      <table>
        <thead>
          <tr>
            <th className="crate">callee crate / function</th>
            <th className="num" title="How many distinct functions across the ecosystem call this callee">callers</th>
            <th className="num" title="Compiled call sites in this function (monomorphised copies)">copies</th>
            <th className="num">downloads</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {callees.callees.map((c) => (
            <Fragment key={c.crate}>
              <tr className={`crate-row${selectedCrate === c.crate ? ' selected' : ''}`} data-crate={c.crate} onClick={() => setSelectedCrate(c.crate)}>
                <td className="crate"><b>{c.crate}</b> <span className="muted">{c.functions.length} function{c.functions.length === 1 ? '' : 's'}</span></td>
                <td />
                <td />
                <td className="num muted">{fmtCompact(c.downloads)}</td>
                <td className="row-actions">
                  <button className="link" onClick={(e) => { e.stopPropagation(); onOpenCrate(c.crate); }}>graph</button>
                  <button className="link" onClick={(e) => { e.stopPropagation(); onOpenDeps(c.crate); }}>deps</button>
                </td>
              </tr>
              {c.functions.map((f) => (
                <tr key={f.name} className="fn-row">
                  <td className="function" style={{ paddingLeft: 32 }}><span className="mono name" title={f.name}>{f.name}</span></td>
                  <td className="num muted">{f.calls.toLocaleString()}</td>
                  <td className="num muted">{f.copies}</td>
                  <td />
                  <td className="row-actions">
                    <button className="link" title="Who calls this function?" onClick={() => open(f.name, c.crate)}>focus</button>
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    );
  };

  const m = rootNode?.result?.meta;
  const header = (key: CallerSort, label: string, title: string, cls = '') => (
    <th className={`${cls} ${sort.key === key ? 'sorted' : ''}`} title={title} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'crate' }))}>
      {label}
      {sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''}
    </th>
  );

  return (
    <div className="callers">
      <div className="callers-form">
        {history.length > 0 && (
          <button onClick={back} title={`Back to ${shortName(history[history.length - 1].fn)}`}>
            ‹ back
          </button>
        )}
        <SymbolSearch value={query} onChange={setQuery} onPick={(hit) => open(hit.name, hit.crate)} autoFocus={!root && !isMobile} />
        {root && (
          <>
            <label className="opt" title="Pin the callee crate's version: a caller counts when it is that version or declares a dependency requirement that admits it">
              {root.crate} @
              <select value={pin} onChange={(e) => changePin(e.target.value)} disabled={busy}>
                <option value="">any version</option>
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.version}
                    {v.latest ? ' (latest)' : ''}
                    {v.exported ? ' ·bitcode' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="views">
              <button className={mode === 'callers' ? 'active' : ''} onClick={() => setMode('callers')} title="Crates and functions that call it">
                callers
              </button>
              <button className={mode === 'callees' ? 'active' : ''} onClick={() => setMode('callees')} title="What it calls (other crates only; std/core/alloc are not recorded)">
                calls
              </button>
            </div>
          </>
        )}
      </div>

      {!root ? (
        <div className="callers-empty">
          <h1>who calls this function?</h1>
          <p>
            Type a function and pick it from the suggestions; Enter opens an exact name, or with <span className="mono">*</span> / <span className="mono">?</span> the
            best match of a pattern. You get every crate whose compiled code calls it, grouped by crate and ordered by downloads, a page at a
            time; open a crate to see the calling functions, and open a function to walk one more level out. The graph on the right draws
            the page's crates, edge width = number of calling functions, node size = downloads.
          </p>
          <p className="muted">
            Try{' '}
            {EXAMPLES.map((e, i) => (
              <Fragment key={e}>
                {i > 0 && ', '}
                <button className="link mono" onClick={() => setQuery(e)}>
                  {e}
                </button>
              </Fragment>
            ))}
            . Names are demangled paths (<span className="mono">serde_json::de::from_str</span>), case-sensitive; <span className="mono">crate::</span> lists a crate's most-called
            functions. Only versions painter has compiled appear, and <span className="mono">std</span>/<span className="mono">core</span>/<span className="mono">alloc</span> calls are
            never recorded.
          </p>
        </div>
      ) : (
        <>
          <div className="callers-summary">
            {mode === 'callers' ? (
              m ? (
                <span>
                  <b>{m.total.toLocaleString()}</b> function{m.total === 1 ? '' : 's'} call <code title={root.fn}>{root.fn}</code>
                  {m.truncated ? <>; the first {m.scanned.toLocaleString()} come from</> : <>, from</>} <b>{m.versions.toLocaleString()}</b> version{m.versions === 1 ? '' : 's'} of{' '}
                  <b>{m.crates.toLocaleString()}</b> crate{m.crates === 1 ? '' : 's'}
                  {m.filter ? <span className="muted"> {hasWildcard(m.filter) ? 'matching' : 'named'} {m.filter} (of {m.allCrates.toLocaleString()})</span> : null}
                  {pinned ? <span className="muted"> that can use {root.crate} {pin}</span> : null}
                </span>
              ) : (
                <span>Searching callers of <code>{root.fn}</code>…</span>
              )
            ) : (
              <span>
                <code title={root.fn}>{root.fn}</code>
                {callees?.from ? (
                  <>
                    {' '}in <b>{callees.from.crate} {callees.from.version}</b> calls <b>{callees.meta.functions}</b> function{callees.meta.functions === 1 ? '' : 's'} of{' '}
                    <b>{callees.meta.crates}</b> crate{callees.meta.crates === 1 ? '' : 's'}
                  </>
                ) : null}
              </span>
            )}
            {m && mode === 'callers' && (
              <span className="muted small">
                {m.truncated ? (
                  <>
                    only the first {m.scanned.toLocaleString()} calling functions were expanded (
                    <button className="link" disabled={busy} title="Expand every calling function; cold database pages make this take tens of seconds for the hottest symbols" onClick={() => expandAll()}>
                      expand all {m.total.toLocaleString()}
                    </button>
                    ) ·{' '}
                  </>
                ) : null}
                {m.rejected ? (
                  <>
                    {m.rejected.toLocaleString()} version{m.rejected === 1 ? '' : 's'} excluded by requirement (
                    <button className="link" disabled={busy} title="Drop the version pin and count callers of every version" onClick={() => changePin('')}>
                      any version
                    </button>
                    ) ·{' '}
                  </>
                ) : null}
                {m.unverified ? `${m.unverified.toLocaleString()} unverified · ` : ''}
                <span title={m.cached ? `page served from the cached caller list (first computed in ${m.aggregateMs.toLocaleString()} ms)` : `caller list computed in ${m.aggregateMs.toLocaleString()} ms`}>
                  {m.elapsedMs.toLocaleString()} ms{m.cached ? ' (cached)' : ''}
                </span>
              </span>
            )}
            <span className="spacer" />
            {mode === 'callers' && m && m.allCrates > 0 && (
              <>
                <Pager meta={m} busy={busy || rootNode?.loading} onPage={(offset) => rootNode && refetch(rootNode, { offset })} />
                <select className="callers-page-size" value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))} title="Caller crates per page">
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n} / page
                    </option>
                  ))}
                </select>
                <CrateFilter value={filterText} query={rootNode ? nodeQuery(rootNode) : null} onChange={setFilterText} onApply={(v) => { setFilterText(v); setFilter(v.trim()); }} />
              </>
            )}
            {!isMobile && (
              <button onClick={() => setShowGraph((v) => !v)} title="Show or hide the graph">
                {showGraph ? 'hide graph' : 'show graph'}
              </button>
            )}
          </div>
          <div className="callers-body">
            <div className="callers-tree callers-table" ref={treeRef}>
              {mode === 'callees' ? (
                renderCallees()
              ) : (
                <table>
                  <thead>
                    <tr>
                      {header('crate', 'caller crate', 'Crates whose compiled code calls the function; open one for its functions', 'crate')}
                      {header('functions', 'functions', 'Distinct calling functions summed over the calling versions', 'num')}
                      {header('versions', 'versions', 'Versions of the crate that call it (painter compiles the latest version of every crate, older ones for selected crates)', 'versions')}
                      {header('downloads', 'downloads', 'crates.io downloads of the caller crate', 'num')}
                      <th />
                    </tr>
                  </thead>
                  <tbody>{rootNode ? renderNode(rootNode) : null}</tbody>
                </table>
              )}
            </div>
            {showGraph && !isMobile && (
              <div className="callers-graph" ref={setCanvasEl}>
                <div className="graph-info">
                  {mode === 'callers' ? (
                    <>
                      <span className="swatch" style={{ background: COLORS.INVOKES }} /> {shortName(root.fn)} ·{' '}
                      <span className="swatch" style={{ background: COLORS.crate }} /> callers{graph.hidden ? ` (top ${graph.nodes.length - 1} of this page, +${graph.hidden.toLocaleString()} in the table pages)` : ''}
                      {pinned && m?.unverified ? <> · <span className="swatch" style={{ background: UNVERIFIED_COLOR }} /> unverified</> : null}
                      <span className="muted"> · click a crate to find it, double-click to open it · edge = calling functions, size = downloads</span>
                    </>
                  ) : (
                    <>
                      <span className="swatch" style={{ background: COLORS.INVOKES }} /> {shortName(root.fn)} →{' '}
                      <span className="swatch" style={{ background: COLORS.versionLatest }} /> callee crates · edge = functions called
                    </>
                  )}
                </div>
                <InteractiveNvlWrapper
                  ref={nvlRef}
                  nodes={graph.nodes}
                  rels={graph.rels}
                  nvlOptions={nvlOptions}
                  mouseEventCallbacks={mouseEventCallbacks}
                  interactionOptions={{ selectOnClick: false }}
                  onInitializationError={(e) => onError(`NVL failed to initialise: ${errorMessage(e)}`)}
                  style={{ width: '100%', height: '100%' }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
