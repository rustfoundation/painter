export interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphRel {
  id: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, unknown>;
}

export interface GraphPayload {
  nodes: GraphNode[];
  rels: GraphRel[];
  rows?: Record<string, unknown>[];
  columns?: string[];
  meta: {
    records: number;
    elapsedMs: number;
    truncated?: boolean;
    resolvedName?: string;
    limit?: number;
    totalPairs?: number | null;
    cached?: boolean;
    query?: string;
    partial?: boolean;
    roots?: string[];
    depth?: number;
    maxDepth?: number;
    crates?: number;
    edges?: number;
  };
}

export interface Health {
  ok: boolean;
  error: string | null;
  server: { agent: string; address: string; protocolVersion: { major: number; minor: number } } | null;
  config: {
    neo4j: { uri: string; user: string; database: string; maxRows: number; queryTimeoutMs: number };
    allowCypher: boolean;
    depsMaxEdges: number;
    depsDefaultEdges: number;
  };
}

export type View = 'default' | 'deps' | 'map' | 'callers' | 'unsafe' | 'build' | 'native' | 'diffs' | 'publishers' | 'releases' | 'supply';

export const VIEWS: { id: View; label: string; title: string }[] = [
  { id: 'default', label: 'Default', title: 'Crates, versions, and their DEPENDS_ON / INVOKES edges' },
  { id: 'deps', label: 'Deps', title: 'Transitive crate-level dependency chain of every crate matching the filter' },
  { id: 'map', label: 'Map', title: 'Whole ecosystem on a precomputed layout; zoom in to resolve clusters into crates' },
  { id: 'callers', label: 'Callers', title: 'Table of every crate version and function that calls a function, directly or through other functions' },
  { id: 'unsafe', label: 'Unsafe', title: 'Leaderboard of crate versions by unsafe code: per-category counts, density, forbid(unsafe_code), build scripts, and the unsafe in their dependencies' },
  { id: 'build', label: 'Build scripts', title: 'Crate versions with a build script: where it is, how big, what native library it links, and the most-linked libraries' },
  { id: 'native', label: 'Native code', title: 'Crate versions shipping C / C++ / Objective-C / assembly sources, headers, or prebuilt binaries; vendored libraries' },
  { id: 'diffs', label: 'Diffs', title: 'What changed between consecutive versions: files and lines added / removed, per crate history, per file' },
  { id: 'publishers', label: 'Publishers', title: 'crates.io users and teams: who publishes and owns what, upload timelines, the most prolific publishers and the owners of the most-downloaded crates' },
  { id: 'releases', label: 'Releases', title: 'Crates and versions published in a timeframe, with a per-day / per-month timeline' },
  { id: 'supply', label: 'Supply chain', title: 'Ownership signals on popular crates: single-owner crates, recent owner additions, first-time uploaders of the latest version' },
];

export const TABLE_VIEWS: ReadonlySet<View> = new Set<View>(['callers', 'unsafe', 'build', 'native', 'diffs', 'publishers', 'releases', 'supply']);
export const isTableView = (v: View) => TABLE_VIEWS.has(v);

export interface CallerRow {
  depth: number;
  crate: string;
  version: string;
  function: string;
  calls: string;
  /** False when a version was pinned but the caller has no direct DEPENDS_ON to check it against. */
  verified: boolean;
  path: string[];
}

export interface CallersResult {
  rows: CallerRow[];
  meta: {
    crate: string;
    version: string | null;
    fn: string;
    exact: boolean;
    targets: string[];
    maxDepth: number;
    depth: number;
    limit: number;
    truncated: boolean;
    exhausted: boolean;
    unverified: number;
    /** Edges dropped because the caller's requirement excludes the pinned version. */
    rejected: number;
    elapsedMs: number;
  };
}

export interface CallersQuery {
  crate: string;
  version: string | null;
  fn: string;
  exact: boolean;
  depth: number;
  limit: number;
}

export interface CrateVersion {
  version: string;
  latest: boolean;
  exported: boolean;
}

export interface LodViewport {
  mode: 'crates' | 'cells';
  level: number;
  nodes: GraphNode[];
  rels: GraphRel[];
  meta: {
    inView: number;
    total: number;
    cells?: number;
    elapsedMs: number;
    relsTruncated: boolean;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
  };
}

export interface LodJob {
  kind: 'build' | 'update';
  startedAt: string;
  phase: string;
  done: number | null;
  total: number | null;
  message: string | null;
}

export interface LodStatus {
  running: LodJob | null;
  last: { kind: string; startedAt: string; finishedAt: string; ok: boolean; error: string | null; elapsedMs: number } | null;
  meta: Record<string, unknown> | null;
  unpositionedCrates: number | null;
  index: { loadedAt: string; crates: number; edges: number; bounds: LodViewport['meta']['bounds']; maxLevel: number } | null;
  indexLoading: boolean;
  indexError: string | null;
  config: { iterations: number; budget: number; maxLevel: number };
}

export type UnsafeScope = 'latest' | 'all';
export type UnsafeTri = 'any' | 'yes' | 'no';
export type UnsafeCategory = 'functions' | 'exprs' | 'impls' | 'traits' | 'methods';
export type UnsafeSort = UnsafeCategory | 'total' | 'density' | 'share' | 'lines' | 'files' | 'forbidFiles' | 'failed' | 'name';

export interface UnsafeRow {
  name: string;
  version: string;
  latest: boolean;
  /** Null for versions never scanned (crate history rows). */
  total: number | null;
  functions: number | null;
  exprs: number | null;
  impls: number | null;
  traits: number | null;
  methods: number | null;
  safeFunctions: number | null;
  safeExprs: number | null;
  safeImpls: number | null;
  safeTraits: number | null;
  safeMethods: number | null;
  files: number | null;
  filesFailed: number | null;
  lines: number | null;
  bytes: number | null;
  forbidFiles: number | null;
  /** Crate root has `#![forbid(unsafe_code)]`; null when no root file was parsed. */
  forbidsUnsafe: boolean | null;
  hasBuildScript: boolean;
  scanner: string | null;
  scannedAt: string | null;
  error: string | null;
  density: number;
  share: number;
}

export interface UnsafeStats {
  scope: UnsafeScope;
  versions: number;
  scanned: number;
  unreadable: number;
  withUnsafe: number;
  forbids: number;
  buildScripts: number;
  functions: number;
  exprs: number;
  impls: number;
  traits: number;
  methods: number;
  safeFunctions: number;
  safeExprs: number;
  safeImpls: number;
  safeTraits: number;
  safeMethods: number;
  lines: number;
  files: number;
  filesFailed: number;
  histogram: number[];
  elapsedMs: number;
  cached: boolean;
}

export interface UnsafeTopQuery {
  scope: UnsafeScope;
  sort: UnsafeSort;
  desc: boolean;
  q: string;
  forbids: UnsafeTri;
  build: UnsafeTri;
  minLines: number;
  minUnsafe: number;
  limit: number;
  offset: number;
}

export interface UnsafeTopResult {
  rows: UnsafeRow[];
  hasMore: boolean;
  meta: { elapsedMs: number; sort: UnsafeSort; scope: UnsafeScope };
}

export interface UnsafeDepsResult {
  crate: string;
  version: string;
  depth: number;
  summary: {
    crates: number;
    scanned: number;
    total: number;
    functions: number;
    exprs: number;
    impls: number;
    traits: number;
    methods: number;
    lines: number;
    forbids: number;
    buildScripts: number;
  };
  deps: {
    name: string;
    version: string | null;
    total: number | null;
    exprs: number | null;
    lines: number | null;
    forbidsUnsafe: boolean | null;
    hasBuildScript: boolean;
    scanned: boolean;
  }[];
  meta: { elapsedMs: number };
}

export interface BuildRow {
  name: string;
  version: string;
  latest: boolean;
  hasBuildScript: boolean | null;
  path: string | null;
  lines: number | null;
  links: string | null;
  revision: string | null;
  error: string | null;
  rsLines: number | null;
  unsafeTotal: number | null;
  hasNativeCode: boolean;
  vendoredNative: boolean;
}

export type BuildSort = 'lines' | 'name' | 'path' | 'links' | 'rsLines' | 'unsafe';

export interface LinksRow {
  links: string;
  versions: number;
  crates: number;
  sample: string[];
}

export interface BuildStats {
  scope: UnsafeScope;
  versions: number;
  scanned: number;
  /** Versions where has_build_script is set at all (the unsafe scanner stored it too). */
  known: number;
  unreadable: number;
  withBuild: number;
  withBuildScanned: number;
  withLinks: number;
  custom: number;
  missingScript: number;
  scriptLines: number;
  histogram: number[];
  topLinks: LinksRow[];
  elapsedMs: number;
  cached: boolean;
}

export interface BuildTopQuery {
  scope: UnsafeScope;
  sort: BuildSort;
  desc: boolean;
  q: string;
  links: UnsafeTri;
  link: string;
  custom: UnsafeTri;
  minLines: number;
  limit: number;
  offset: number;
}

export type NativeLang = 'c' | 'c++' | 'objc' | 'asm';

export interface NativeRow {
  name: string;
  version: string;
  latest: boolean;
  hasNativeCode: boolean | null;
  vendored: boolean | null;
  sourceFiles: number | null;
  headerFiles: number | null;
  sourceLines: number | null;
  lines: number | null;
  bytes: number | null;
  largestBytes: number | null;
  vendorDirLines: number | null;
  langs: string[];
  dirs: string[];
  prebuilt: number | null;
  revision: string | null;
  error: string | null;
  hasBuildScript: boolean;
  links: string | null;
}

export type NativeSort = 'lines' | 'sourceLines' | 'files' | 'bytes' | 'largest' | 'vendorDirLines' | 'prebuilt' | 'name';

export interface NativeStats {
  scope: UnsafeScope;
  versions: number;
  scanned: number;
  unreadable: number;
  withNative: number;
  vendored: number;
  withPrebuilt: number;
  nativeWithBuild: number;
  nativeWithLinks: number;
  sourceFiles: number;
  headerFiles: number;
  sourceLines: number;
  lines: number;
  bytes: number;
  prebuiltFiles: number;
  histogram: number[];
  langs: { lang: string; versions: number; crates: number; lines: number }[];
  dirs: { dir: string; versions: number; crates: number }[];
  elapsedMs: number;
  cached: boolean;
}

export interface NativeTopQuery {
  scope: UnsafeScope;
  sort: NativeSort;
  desc: boolean;
  q: string;
  vendored: UnsafeTri;
  prebuilt: UnsafeTri;
  lang: NativeLang | '';
  minLines: number;
  limit: number;
  offset: number;
}

export interface DiffRow {
  name: string;
  version: string;
  latest: boolean;
  base: string | null;
  filesAdded: number | null;
  filesRemoved: number | null;
  filesModified: number | null;
  filesTotal: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  /** Some file hit the per-file diff timeout; counts are an upper bound. */
  approximate: boolean | null;
  revision: string | null;
  error: string | null;
  churn: number;
  filesChanged: number;
  rsLines: number | null;
}

export type DiffSort = 'churn' | 'added' | 'removed' | 'filesChanged' | 'filesAdded' | 'filesRemoved' | 'filesModified' | 'filesTotal' | 'name';
export type DiffFirsts = 'exclude' | 'include' | 'only';

export interface DiffFile {
  path: string;
  status: 'added' | 'removed' | 'modified' | null;
  added: number;
  removed: number;
  binary: boolean;
}

export interface DiffVersion extends DiffRow {
  files: DiffFile[] | null;
}

export interface DiffStats {
  scope: UnsafeScope;
  versions: number;
  scanned: number;
  unreadable: number;
  firsts: number;
  approximate: number;
  unchanged: number;
  linesAdded: number;
  linesRemoved: number;
  filesAdded: number;
  filesRemoved: number;
  filesModified: number;
  filesTotal: number;
  histogram: number[];
  elapsedMs: number;
  cached: boolean;
}

export interface DiffTopQuery {
  scope: UnsafeScope;
  sort: DiffSort;
  desc: boolean;
  q: string;
  firsts: DiffFirsts;
  approximate: UnsafeTri;
  minChurn: number;
  limit: number;
  offset: number;
}

export interface RegistryStats {
  users: number;
  teams: number;
  owns: number;
  cratePublishers: number;
  versionUploads: number;
  categories: number;
  keywords: number;
  crates: number;
  cratesInRegistry: number;
  trustpubOnly: number;
  cratesWithoutOwner: number;
  latestVersions: number;
  latestInRegistry: number;
  latestYanked: number;
  dump: string | null;
  versions: number;
  versionsInRegistry: number;
  versionsWithDate: number;
  versionsMissing: number;
  yanked: number;
  elapsedMs: number;
  cached: boolean;
}

export interface UserHit {
  login: string;
  name: string | null;
  crates: number;
  owns: number;
}

export interface PublisherCrate {
  name: string;
  downloads: number | null;
  numVersions: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  description: string | null;
  trustpubOnly: boolean | null;
  owners: number;
  publishers: number;
  latestVersion: string | null;
  yanked: boolean;
  unsafeTotal: number | null;
  hasBuildScript: boolean;
  hasNativeCode: boolean;
  vendoredNative: boolean;
  published: { first: string; last: string; versions: number } | null;
  owns: { since: string | null; addedBy: string | null } | null;
}

export interface PublisherProfile {
  kind: 'User' | 'Team';
  id: number;
  login: string;
  name: string | null;
  ghId: number | null;
  createdAt: string | null;
  avatar: string | null;
  crates: PublisherCrate[];
  timeline: { year: number; month: number; uploads: number }[];
  totals: {
    crates: number;
    published: number;
    uploads: number;
    owned: number;
    ownedDownloads: number;
    publishedDownloads: number;
    soleOwner: number;
    unsafe: number;
    buildScripts: number;
    native: number;
    yanked: number;
    withLatest: number;
    firstUpload: string | null;
    lastUpload: string | null;
    truncated: boolean;
  };
  meta: { elapsedMs: number };
}

export interface ProlificRow {
  login: string;
  name: string | null;
  crates: number;
  uploads: number;
  first: string | null;
  last: string | null;
}

export interface TopOwnerRow {
  kind: 'User' | 'Team';
  login: string;
  name: string | null;
  crates: number;
  sole: number;
  downloads: number;
  sample: string[];
}

export interface TopPublisherRow {
  login: string;
  name: string | null;
  crates: number;
  uploads: number;
  downloads: number;
  sample: string[];
}

export interface PublisherLeaderboards {
  byCrates: ProlificRow[];
  byUploads: ProlificRow[];
  owners: TopOwnerRow[];
  publishers: TopPublisherRow[];
  topCrates: number;
  elapsedMs: number;
  cached: boolean;
}

export type ReleaseKind = 'crates' | 'versions';
export type ReleaseSource = 'created' | 'publisher' | 'published_at';
export type ReleaseSort = 'date' | 'downloads' | 'name';

export interface ReleaseRow {
  name: string;
  version: string | null;
  /** Uploader; null when crates.io did not record one (or for Crate.created_at rows). */
  login: string | null;
  at: string;
  downloads: number | null;
  numVersions?: number | null;
  defaultVersion?: string | null;
  createdAt?: string | null;
  description?: string | null;
  trustpubOnly?: boolean | null;
  owners?: string[];
  ownerCount?: number;
  publisherCount?: number;
  latest?: boolean;
  yanked?: boolean;
  license?: string | null;
  crateSize?: number | null;
  edition?: string | null;
  rustVersion?: string | null;
  unsafeTotal?: number | null;
  hasBuildScript?: boolean;
  hasNativeCode?: boolean;
  vendoredNative?: boolean;
  /** source=publisher crate rows: uploads by this user, their last upload, and whether the crate existed before them. */
  extra: { uploads?: number; last?: string; joined?: boolean };
}

export interface ReleasesQuery {
  kind: ReleaseKind;
  source: ReleaseSource;
  from: string;
  to: string;
  q: string;
  minDownloads: number;
  sort: ReleaseSort;
  desc: boolean;
  limit: number;
  offset: number;
}

export interface ReleasesResult {
  rows: ReleaseRow[];
  hasMore: boolean;
  meta: { kind: ReleaseKind; source: ReleaseSource; from: string; to: string; sort: ReleaseSort; elapsedMs: number };
}

export interface ReleasesHistogram {
  kind: ReleaseKind;
  source: ReleaseSource;
  from: string;
  to: string;
  unit: 'day' | 'month';
  buckets: { bucket: string; n: number }[];
  total: number;
  elapsedMs: number;
  cached: boolean;
}

export interface BusFactorRow {
  name: string;
  downloads: number;
  numVersions: number | null;
  updatedAt: string | null;
  degree: number | null;
  trustpubOnly: boolean | null;
  repository: string | null;
  login: string;
  ownerName: string | null;
  since: string | null;
  addedBy: string | null;
  ownerCrates: number;
  publishers: number;
  latestVersion: string | null;
  yanked: boolean;
  latestAt: string | null;
}

export interface OwnerAdditionRow {
  name: string;
  downloads: number | null;
  numVersions: number | null;
  createdAt: string | null;
  kind: 'User' | 'Team';
  login: string;
  ownerName: string | null;
  addedBy: string | null;
  since: string;
  owners: number;
  hasPublished: boolean;
  ownerPublished: number | null;
  ownerCreatedAt: string | null;
}

export interface NewUploaderRow {
  name: string;
  downloads: number;
  numVersions: number | null;
  version: string;
  yanked: boolean;
  at: string;
  login: string;
  uploaderName: string | null;
  uploaderCreatedAt: string | null;
  owner: boolean;
  publishers: number;
  uploaderCrates: number;
  owners: string[];
}

export interface SupplyResult<Row> {
  rows: Row[];
  hasMore: boolean;
  meta: { elapsedMs: number; top?: number; since?: string; minDownloads?: number; self?: string };
}

export interface CrateRegistry {
  name: string;
  inRegistry: boolean;
  owners: { kind: 'User' | 'Team'; login: string; name: string | null; since: string | null; addedBy: string | null }[];
  publishers: { login: string; name: string | null; first: string | null; last: string | null; versions: number }[];
  categories: { slug: string; name: string; crates: number | null }[];
  keywords: string[];
}

export interface VersionPublisher {
  name: string;
  version: string;
  login: string | null;
  publisherName: string | null;
  at: string | null;
  publishedAt: string | null;
  inRegistry: boolean;
}

export interface TopResult<Row, Sort> {
  rows: Row[];
  hasMore: boolean;
  meta: { elapsedMs: number; sort: Sort; scope: UnsafeScope };
}

export interface Stats {
  crates: number;
  versions: number;
  dependsOn: number;
  invokes: number;
}

export interface CrateLoadOptions {
  versions: 'latest' | 'all';
  deps: boolean;
  invokes: boolean;
  dependents: boolean;
  limit: number;
}

export type ExpandType = 'VERSION_OF' | 'DEPENDS_ON' | 'INVOKES' | 'OWNS' | 'PUBLISHED';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string | null = null,
  ) {
    super(message);
  }
}

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body ?? {}) as { error?: string; code?: string | null };
    throw new ApiError(err.error ?? `${res.status} ${res.statusText}`, res.status, err.code ?? null);
  }
  return body as T;
};

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  health: () => request<Health>('/api/health'),
  stats: () => request<Stats>('/api/stats'),
  searchCrates: (q: string, limit = 15) =>
    request<{ names: string[] }>(`/api/crates/search?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) => r.names),
  loadCrate: (name: string, opts: CrateLoadOptions) => {
    const params = new URLSearchParams({
      versions: opts.versions,
      deps: String(opts.deps),
      invokes: String(opts.invokes),
      dependents: String(opts.dependents),
      limit: String(opts.limit),
    });
    return request<GraphPayload>(`/api/graph/crate/${encodeURIComponent(name)}?${params}`);
  },
  /** Partial match from 3 characters, exact below. */
  loadDepsChain: (q: string, limit: number, depth: number, exact = false) =>
    request<GraphPayload>(
      `/api/graph/deps/chain?${new URLSearchParams({ q, limit: String(limit), depth: String(depth), exact: exact ? '1' : '0' })}`,
    ),
  loadDeps: (crate: string | null, direction: 'in' | 'out' | 'both', limit: number) => {
    const params = new URLSearchParams({ direction, limit: String(limit) });
    if (crate) params.set('crate', crate);
    return request<GraphPayload>(`/api/graph/deps?${params}`);
  },
  lodStatus: () => request<LodStatus>('/api/lod/status'),
  lodRebuild: (opts: { iterations?: number; reuseEdges?: boolean; resume?: boolean } = {}) =>
    request<LodStatus>('/api/lod/rebuild', json(opts)),
  lodUpdate: () => request<LodStatus>('/api/lod/update', json({})),
  lodViewport: (bbox: { x0: number; y0: number; x1: number; y1: number } | null, budget: number, minCell = 0) => {
    const params = new URLSearchParams({ budget: String(budget), minCell: String(minCell) });
    if (bbox) for (const k of ['x0', 'y0', 'x1', 'y1'] as const) params.set(k, String(bbox[k]));
    return request<LodViewport>(`/api/lod/viewport?${params}`);
  },
  lodLocate: (name: string) =>
    request<{ name: string; x: number; y: number; community: number; degree: number }>(`/api/lod/locate?name=${encodeURIComponent(name)}`),
  lodSearch: (q: string, limit = 15) =>
    request<{ names: string[] }>(`/api/lod/search?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) => r.names),
  searchFunctions: (crate: string, q: string, limit = 20) =>
    request<{ functions: { name: string; calls: number }[] }>(
      `/api/functions/search?${new URLSearchParams({ crate, q, limit: String(limit) })}`,
    ).then((r) => r.functions),
  crateVersions: (name: string) =>
    request<{ versions: CrateVersion[] }>(`/api/crates/${encodeURIComponent(name)}/versions`).then((r) => r.versions),
  callers: (q: CallersQuery) => {
    const params = new URLSearchParams({ crate: q.crate, fn: q.fn, match: q.exact ? 'exact' : 'contains', depth: String(q.depth), limit: String(q.limit) });
    if (q.version) params.set('version', q.version);
    return request<CallersResult>(`/api/callers?${params}`);
  },
  unsafeStats: (scope: UnsafeScope) => request<UnsafeStats>(`/api/unsafe/stats?scope=${scope}`),
  unsafeTop: (q: UnsafeTopQuery) =>
    request<UnsafeTopResult>(
      `/api/unsafe/top?${new URLSearchParams({
        scope: q.scope,
        sort: q.sort,
        dir: q.desc ? 'desc' : 'asc',
        q: q.q,
        forbids: q.forbids,
        build: q.build,
        minLines: String(q.minLines),
        minUnsafe: String(q.minUnsafe),
        limit: String(q.limit),
        offset: String(q.offset),
      })}`,
    ),
  unsafeCrate: (name: string) => request<{ name: string; versions: UnsafeRow[] }>(`/api/unsafe/crate/${encodeURIComponent(name)}`).then((r) => r.versions),
  unsafeDeps: (crate: string, version: string | null, depth: number, limit: number) => {
    const params = new URLSearchParams({ crate, depth: String(depth), limit: String(limit) });
    if (version) params.set('version', version);
    return request<UnsafeDepsResult>(`/api/unsafe/deps?${params}`);
  },
  buildStats: (scope: UnsafeScope) => request<BuildStats>(`/api/build/stats?scope=${scope}`),
  buildTop: (q: BuildTopQuery) =>
    request<TopResult<BuildRow, BuildSort>>(
      `/api/build/top?${new URLSearchParams({
        scope: q.scope,
        sort: q.sort,
        dir: q.desc ? 'desc' : 'asc',
        q: q.q,
        links: q.links,
        link: q.link,
        custom: q.custom,
        minLines: String(q.minLines),
        limit: String(q.limit),
        offset: String(q.offset),
      })}`,
    ),
  buildLinks: (scope: UnsafeScope, limit = 50) =>
    request<{ rows: LinksRow[]; meta: { elapsedMs: number } }>(`/api/build/links?scope=${scope}&limit=${limit}`).then((r) => r.rows),
  buildCrate: (name: string) => request<{ name: string; versions: BuildRow[] }>(`/api/build/crate/${encodeURIComponent(name)}`).then((r) => r.versions),
  nativeStats: (scope: UnsafeScope) => request<NativeStats>(`/api/native/stats?scope=${scope}`),
  nativeTop: (q: NativeTopQuery) =>
    request<TopResult<NativeRow, NativeSort>>(
      `/api/native/top?${new URLSearchParams({
        scope: q.scope,
        sort: q.sort,
        dir: q.desc ? 'desc' : 'asc',
        q: q.q,
        vendored: q.vendored,
        prebuilt: q.prebuilt,
        lang: q.lang,
        minLines: String(q.minLines),
        limit: String(q.limit),
        offset: String(q.offset),
      })}`,
    ),
  nativeCrate: (name: string) => request<{ name: string; versions: NativeRow[] }>(`/api/native/crate/${encodeURIComponent(name)}`).then((r) => r.versions),
  diffStats: (scope: UnsafeScope) => request<DiffStats>(`/api/diffs/stats?scope=${scope}`),
  diffTop: (q: DiffTopQuery) =>
    request<TopResult<DiffRow, DiffSort> & { meta: { firsts: DiffFirsts } }>(
      `/api/diffs/top?${new URLSearchParams({
        scope: q.scope,
        sort: q.sort,
        dir: q.desc ? 'desc' : 'asc',
        q: q.q,
        firsts: q.firsts,
        approximate: q.approximate,
        minChurn: String(q.minChurn),
        limit: String(q.limit),
        offset: String(q.offset),
      })}`,
    ),
  diffCrate: (name: string) => request<{ name: string; versions: DiffRow[] }>(`/api/diffs/crate/${encodeURIComponent(name)}`).then((r) => r.versions),
  diffVersion: (crate: string, version: string) => request<DiffVersion>(`/api/diffs/version?${new URLSearchParams({ crate, version })}`),
  registryStats: () => request<RegistryStats>('/api/registry/stats'),
  searchUsers: (q: string, limit = 15) => request<{ users: UserHit[]; teams: UserHit[] }>(`/api/publishers/search?${new URLSearchParams({ q, limit: String(limit) })}`),
  publisher: (login: string) => request<PublisherProfile>(`/api/publishers/user/${encodeURIComponent(login)}`),
  publisherLeaderboards: () => request<PublisherLeaderboards>('/api/publishers/leaderboards'),
  releases: (q: ReleasesQuery) =>
    request<ReleasesResult>(
      `/api/releases?${new URLSearchParams({
        kind: q.kind,
        source: q.source,
        from: q.from,
        to: q.to,
        q: q.q,
        minDownloads: String(q.minDownloads),
        sort: q.sort,
        dir: q.desc ? 'desc' : 'asc',
        limit: String(q.limit),
        offset: String(q.offset),
      })}`,
    ),
  releasesHistogram: (kind: ReleaseKind, source: ReleaseSource, from: string, to: string) =>
    request<ReleasesHistogram>(`/api/releases/histogram?${new URLSearchParams({ kind, source, from, to })}`),
  busFactor: (q: { top: number; limit: number; offset: number }) =>
    request<SupplyResult<BusFactorRow>>(`/api/supply/bus-factor?${new URLSearchParams({ top: String(q.top), limit: String(q.limit), offset: String(q.offset) })}`),
  ownerAdditions: (q: { since: string; minDownloads: number; self: 'exclude' | 'include'; limit: number; offset: number }) =>
    request<SupplyResult<OwnerAdditionRow>>(
      `/api/supply/owner-additions?${new URLSearchParams({ since: q.since, minDownloads: String(q.minDownloads), self: q.self, limit: String(q.limit), offset: String(q.offset) })}`,
    ),
  newUploaders: (q: { top: number; limit: number; offset: number }) =>
    request<SupplyResult<NewUploaderRow>>(`/api/supply/new-uploaders?${new URLSearchParams({ top: String(q.top), limit: String(q.limit), offset: String(q.offset) })}`),
  crateRegistry: (name: string) => request<CrateRegistry>(`/api/registry/crate/${encodeURIComponent(name)}`),
  versionPublisher: (crate: string, version: string) => request<VersionPublisher>(`/api/registry/version?${new URLSearchParams({ crate, version })}`),
  expand: (id: string, direction: 'in' | 'out' | 'both', types: ExpandType[], limit = 100) =>
    request<GraphPayload>('/api/graph/expand', json({ id, direction, types, limit })),
  cypher: (query: string, params: Record<string, unknown> = {}) =>
    request<GraphPayload>('/api/cypher', json({ query, params })),
};
