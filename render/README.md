# painter-render

Web UI for the painter graph, built on the
[Neo4j Visualization Library](https://neo4j.com/docs/nvl/current/). Standalone from the Rust side;
the only contract is the graph schema painter writes.

- `server/`: Node + Express. Owns the Neo4j driver and runs every query read-only, so the browser
  never talks to Neo4j. Serves `/api` and the built UI from `dist/`.
- `src/`: React + NVL, built with Vite.
- `server/lod/`: Map precompute (layout, communities) and the in-memory viewport index.

## Run

Needs Node 22+ and a Neo4j with painter data.

```
docker compose up -d --build                 # neo4j on 7474/7687, UI on http://localhost:8080
docker compose up -d --build --no-deps render   # rebuild only the UI, leave neo4j (and imports) alone
```

The `render` service starts before Neo4j is ready and retries; `GET /api/health` says when it is
connected.

```
cd render && npm install
npm run dev                  # API on :8080 with --watch, Vite on :5173 proxying /api
npm run build && npm start   # single process serving the built UI
```

Settings are env vars read once at startup; defaults match the compose neo4j. See
`server/config.mjs` and `.env.example`. Notable ones: `NEO4J_URI` / `NEO4J_PASSWORD` (from a
container to a host Neo4j use `bolt://host.docker.internal:7687` plus
`--add-host=host.docker.internal:host-gateway`), `NEO4J_MAX_ROWS` (row cap on every query, Cypher
panel included), `RENDER_ALLOW_CYPHER=false` (disables the Cypher panel and `POST /api/cypher`),
`RENDER_LOD_WORKER_HEAP_MB` (heap for the in-server Map build), `RENDER_JOBS_URL` (hand background
work to the jobs service below).

## Background jobs

Every dashboard's overview tiles (unsafe, build scripts, native code, diffs, registry, publisher
leaderboards, and the status bar counts) aggregate the whole graph: label scans of 3.2M versions,
whole relationship types, seconds each and tens of seconds under import load. Rather than paying for
that on a request, `server/jobs/index.mjs` runs as its own service (`jobs` in `docker-compose.yaml`,
same image, `command: node server/jobs/index.mjs`) and is the only writer of derived data:

- every `JOBS_STATS_INTERVAL_MS` (15 min; 0 = on request only) it recomputes each payload in
  `server/stats.mjs` (`STATS_JOBS`: `overview`, `unsafe:{latest,all}`, `build:*`, `native:*`,
  `diffs:*`, `registry`, `leaderboards`), one scan at a time, and stores it as JSON on
  `(:Stats {id, payload, computed_at, elapsed_ms, bytes})` (constraint `const_stats_id`, created at
  start). A timer run skips ids another instance refreshed within half the interval.
- the Map build/update worker (below) runs here when asked, and `JOBS_LOD_UPDATE_INTERVAL_MS` can
  run the cheap update on a timer.

Control API on `$PORT` (compose publishes it on `127.0.0.1:8081`): `GET /api/health`,
`GET /api/status` (both runs plus the stored `computed_at` per id), `POST /api/stats/refresh`
(`{ids?: [...]}`, 202, 409 while one runs), `GET /api/lod/status`, `POST /api/lod/rebuild`,
`POST /api/lod/update`. Trigger a refresh when a painter stage finishes instead of waiting for the
timer:

```
curl -X POST http://127.0.0.1:8081/api/stats/refresh
curl -X POST http://127.0.0.1:8081/api/stats/refresh -H 'content-type: application/json' -d '{"ids":["registry","leaderboards"]}'
```

The render routes read the `Stats` node (one index seek) and report `computedAt` / `source:
"precomputed"`; the views print "totals computed N min ago". With no node yet (fresh database, no
jobs service) a route falls back to the live aggregate with its old 60 s / 10 min cache and
`source: "live"`. With `RENDER_JOBS_URL` set, render forwards `POST /api/stats/refresh` and
`POST /api/lod/{rebuild,update}` to the jobs service and shows its job status under
`/api/lod/status`, so the graph has one writer; without it, render still runs the Map worker itself
as before. `GET /api/stats/status` lists stored ages and the jobs service's view.

Locally: `npm run start:jobs` (port 8081) next to `RENDER_JOBS_URL=http://127.0.0.1:8081 npm run dev`.

## Indexes

Create the constraints and indexes in `docker/queries.md`; views are slow or unusable without them:

- `idx_crate_name_text`: partial-name hints in the search dropdowns.
- `const_symbol_name`, `idx_symbol_name_text`: Callers view (one seek per function name on `Symbol.name`,
  then its callers; the TEXT index backs the function search).
- `idx_has_build_script`, `idx_version_links`, `idx_has_native_code`, `idx_vendored_native`,
  `idx_diff_lines_added`: Build scripts / Native code / Diffs leaderboards.
- Registry indexes (`idx_user_login`, `idx_published_at`, `idx_owns_since`,
  `idx_version_published_at`, `idx_crate_created_at`, `idx_crate_downloads`): Publishers / Releases /
  Supply chain. `painter generate-metadata --job registry` creates them.
- The Map build creates its own `lod_*` indexes.

Default and Deps work as soon as the graph has data; Map needs the precompute below.

## Views

Graph views (Default, Deps, Map): wheel/pinch zooms, drag pans; click a node or edge for properties.

**Searching** (`server/match.mjs`, `src/match.ts`): every search box and table filter takes an exact
name, case-insensitive. Only `*` (any run of characters) and `?` (one character) make it a pattern:
`tokio*`, `*-sys`, `serde_?son`. The hint dropdowns still offer partial matches as you type, and
picking one sets that exact name. A pattern in a graph view's box (or the Callers function box) opens
the best match, by downloads (Map: importance, Callers: callers). In the table views (Unsafe, Build
scripts, Native code, Diffs, Releases, a publisher's crates, Callers) it returns every matching row,
and in the Publishers login box it lists every matching login. The version tables resolve the crate
names first (`crateNameScope`: one index lookup, or a regex over the crate names when at most 5,000
match) and start from those crates, so an exact or rare filter does not walk every version.

**Default**: one crate's overview (`GET /api/graph/overview/:name`, `server/overview.mjs`; the name
is exact, or a `*` / `?` pattern). One bounded Cypher round trip returns the
crate with degree-store counts, what its latest version depends on (folded to one `DEPENDS_ON` per
crate: strongest `kind`, `optional` only if every declaration is, all requirements, `via` = the
declaring version; ids `dep:`), its 12 newest versions, the crates its compiled code calls into
(`calls` on the dependency edge when declared, else a red `INVOKES` edge to a `callee` node; ids
`agg:`; self-calls dropped), and with the dependents option its 25 most-downloaded dependents from
`LOD_DEP`. The client (`src/overview.ts`) lays this out itself on NVL's `free` layout: root in the
middle, dependencies fanned right (normal / optional / called on the inner arc, build / dev outside,
size = downloads, colour = kind), dependents left, versions as an oldest → latest strip along the
bottom joined by a canvas-only `PRECEDES` chain, crates.io accounts on top. Captions are DOM labels
(`components/OverviewLabels.tsx`) that follow the canvas, with a detail line (requirement, kind,
calls; versions using it; publish date and ⊘ ☢ ⚙ C Δ badges) once zoomed past 0.7. Dragging keeps
positions; `layout` can switch back to force directed. The details panel pages bounded expansions
(`Latest deps`, `Dependents +N` 25 at a time, `Versions +N` 12 at a time, `Calls`, `Owners`,
`Publishers`), double-click adds a crate's or a version's dependencies, and new nodes fan out from
the node that was expanded. Inbound callers are not drawn (4-15 s even bounded); the panel shows
how many functions are called from other crates and the Callers view lists who. The Cypher panel
returns raw relationships and merges nodes, relationships, and paths into the canvas.

**Deps**: one crate's dependency tree, root on top and one row per hop (layered layout, not force).
By default it follows the root's current version (`Crate.default_version`, else `Version.latest`)
and its required normal dependencies, two hops deep, at most 300 crates. Toolbar toggles add
optional (drawn fainter), build (orange), and dev (purple) edges; "any version" switches to the
Map's crate-level `LOD_DEP` edges (width = versions declaring it); "dependents" walks `LOD_DEP`
backwards, keeping the 30 best-downloaded dependents of the root and 3 of each of those, and in
current-version mode checks each candidate's current version. Node size is crate-level in-degree.
Edges to a crate already reached by a shorter path are drawn faint unless they touch the selection.
The root's details say which declarations the toggles leave out (tokio: 20 dev, 15 optional). When the budget or depth cuts a
crate's children, it shows "+N"; double-click (or Show +N) fetches them, double-click again folds
them. Clicking a crate highlights its path from the root. The sidebar has the path, children, and
the legend. Reverse mode and node sizes need `LOD_DEP` (the Map build); without it, they show 0.

**Map**: the whole ecosystem on a precomputed layout. Each viewport shows the most important crates
in it as labelled landmarks (importance = log downloads + 1.5 log dependents, picked in global order
with a minimum on-screen spacing, so a landmark stays one at every deeper zoom), a smoothed density
shading for everything else, and the largest Louvain communities as translucent blobs labelled by
their dominant crates ("serde · serde_json · thiserror"). Only the 16 largest communities (by
downloads) get a colour; the rest are grey. The sidebar lists them as a clickable legend. Clicking a
crate shows downloads, dependents, dependencies, its most important neighbours (jump or "deps" to
open the Deps view), and draws its edges: orange from crates that use it, blue to what it depends
on. Other edges are drawn only when there are few enough to read (<= 220). The toolbar "density"
preset (sparse / normal / dense) sets how many landmarks fit on a screen. The view opens on the
populated core (1.5-98.5 percentile box); "Whole map" includes the ring of isolated crates.
`/api/lod/viewport` answers from memory in ~10-50 ms; `/api/lod/neighbours` and
`/api/lod/communities` are computed from the same in-memory index, no database query.

**Callers**: who calls a function. One search box takes `crate::path::fn`, `crate::` (that crate's
most-called functions), or a bare name, with suggestions grouped by crate and ranked by callers.
Suggestions are partial; with `*` / `?` the query is a full-name pattern (`serde_json::*from_str`:
a regex over that crate's symbols; a global pattern seeds from the TEXT index on its longest literal,
which must be at least 3 characters, then filters with the regex). Enter without a picked suggestion
opens plain text only as an exact function name ("no function named X" otherwise) and a pattern's
match with the most callers. The result is aggregated per caller crate (ordered by downloads, with
the calling versions and the number of calling functions) and paged server-side (100 crates a page,
up to 500; sort by downloads / functions / versions / crate). The server caches the per-version
aggregate (no function names) per (function, pin, cap) for 10 minutes, 20 entries, so paging,
sorting, and the caller crate filter (exact name, or a pattern like `tokio*`, with hints from the
cached list) never re-run the fan-in; calling function names (40 per crate) are fetched for the
page's crates only. A crate row opens into its calling functions, and a function opens into its own
callers one level further out (paged 50 at a time). The callee version is pinned to the latest (newest stable if that is a pre-release) by default: a caller counts
when its `DEPENDS_ON` requirement admits that version (`unverified` when it has no direct dependency,
dropped when the requirement excludes it). The graph pane draws the current page's crates (edge width = calling
functions, node size = downloads); `calls` flips to what the function calls. Hot symbols are answered
from the first 15,000 calling functions with an "expand all" link, since every calling function is a
random read. `focus` re-roots on any function; `graph` / `deps` open the crate in those views.

**Unsafe**, **Build scripts**, **Native code**, **Diffs**: leaderboards over the `generate-metadata`
properties (`docker/queries.md` lists them). Scope is latest versions (index-backed) or all
versions (full scan, seconds); sorting and filtering are server-side. A run of `generate-metadata`
may still be in progress, so versions a job has not reached are absent from its view. Native
"vendored" thresholds are in `docker/queries.md`. Diffs exclude first versions by default, since
everything counts as added there. Unsafe also shows unsafe carried in by dependencies (dev-dependencies
skipped, each dependency at its latest version).

**Publishers**, **Releases**, **Supply chain**: views over the registry job's data (`User`, `Team`,
`OWNS`, `PUBLISHED`, dates). Whole-type aggregations (registry coverage, prolific-publisher boards)
are cached for 10 minutes with the long timeout; everything else is index-backed and limited.
The index clone painter imports `Version` nodes from can lag the dump by days, so the newest
versions may have no node yet; crate-level `PUBLISHED.last` still reflects them. Version-level
`PUBLISHED` edges start in 2019 and are missing for trusted-publishing uploads, so timelines
undercount; `Version.published_at` is complete.

Graph captions show `⊘` yanked, `☢N` unsafe, `⚙` build script (`⚙→lib` with `links`), `C` native
code (`C!` vendored, `C+bin` prebuilt binaries), and `Δ+a/−r` lines changed since the previous
version. Side panels add crates.io, Unsafe, Build script, Native code, and Changes sections;
logins open Publishers.

## Map precompute

Stored in the database so every render instance shares it:

- `Crate.lod_x`, `Crate.lod_y` (ForceAtlas2), `Crate.lod_community` (Louvain), `Crate.lod_degree`
- `(Crate)-[:LOD_DEP {versions}]->(Crate)`: one edge per crate pair, `versions` = how many versions
  declare it
- `(:LodMeta {id:'default'})`: counts, bounds, timings, `built_at`

The render server loads all of that (plus `Crate.downloads`) into memory at start: ~4 min against a
remote database, during which the Map reports "loading". It then writes a JSON snapshot to
`RENDER_LOD_INDEX_CACHE` (default `/tmp/painter-lod-index.json`, ~65 MB, empty disables it) keyed on
`built_at`, so a restart loads in a couple of seconds until the next build or update.

A full build aggregates every `DEPENDS_ON`, runs Louvain and a single-threaded ForceAtlas2, and
writes it all back. On 340k crates / 37M `DEPENDS_ON` it takes ~30 min and ~2.5 GB, almost all of it
the layout. **Update** only places crates with no position yet (imported after the last build) at the
centroid of their positioned neighbours, in seconds; it does not move existing crates or refresh edges
between them, so a full build is needed after large imports.

```
npm run lod:build -- --iterations 300        # full build
npm run lod:build -- --reuse-edges --resume   # keep stored LOD_DEP, continue the layout
npm run lod:update
npm run lod:status
```

`--reuse-edges` skips re-aggregating `DEPENDS_ON` (drop it after a large import). `--resume` restarts
from the checkpoint file, else from stored positions, so a crash costs at most one checkpoint
interval. To keep it from starving the host:
`NODE_OPTIONS=--max-old-space-size=6144 nice -n 19 ionice -c 3 npm run lod:build -- --reuse-edges --resume`.

The UI (Rebuild/Update) and `POST /api/lod/rebuild` / `POST /api/lod/update` run the same jobs in a
worker thread, one at a time (409 if busy), heap-capped by `RENDER_LOD_WORKER_HEAP_MB`: in the jobs
service when `RENDER_JOBS_URL` is set (render forwards the request), else inside render. The server
reloads its viewport index when a job finishes or it sees a new `built_at`.

`GET /api/lod/viewport` picks the finest grid level whose cells in the bbox fit the budget and are at
least `minCell` layout units wide (the client derives it from zoom so clusters stay ~44 px apart).
Positions and `LOD_DEP` are held in typed arrays (~14 s to load).

## API

JSON throughout. Graph payloads are `{nodes: [{id, labels, properties}], rels: [{id, type, from, to,
properties}], meta}`; `id` is the Neo4j `elementId`, except synthetic edges (`agg:`, `dep:`) and Map
elements (`crate:<name>`, `cell:<level>:<ix>:<iy>`). Routes are in `server/index.mjs`; the less
obvious ones:

| Route | What |
| --- | --- |
| `GET /api/health` | connection state and effective config, no secrets |
| `GET /api/graph/overview/:name` | Default load; `parts=deps,versions,calls,dependents`, `version` + `from=version`, `skip`, `limit`, `root=1`; nodes carry `role` / `counts`, `meta.overview` the totals |
| `GET /api/graph/crate/:name` | older raw load (Crate, Versions, their edges); `name` is exact or a `*` / `?` pattern, `meta.resolvedName` says what was picked |
| `POST /api/graph/expand` | neighbours of a node (`VERSION_OF`, `DEPENDS_ON`, `INVOKES`, `OWNS`, `PUBLISHED`) |
| `GET /api/deps/tree?crate&direction=out\|in&mode=latest\|any&kinds&optional&depth&limit` | Deps tree keyed by crate name: nodes with `depth/downloads/dependents/hidden/unexpanded`, edges with `kinds/optional/req/versions` |
| `GET /api/deps/expand?crate&...` | one crate's direct neighbours for the Deps view (same options) |
| `GET /api/lod/*` | Map status, viewport, locate, search; viewport is 503 until a build is loaded |
| `GET /api/symbols/search?q&limit` | function search (`crate::` prefix scopes it); `symbols` grouped by `crate`, `crates` prefix matches; `*` / `?` make it a pattern (`pattern`, `hint`) |
| `GET /api/symbols/resolve?q` | what Enter opens: the exact symbol for plain text, the most-called pattern match, or `symbol: null` |
| `GET /api/symbols/callers?fn&versions&cap&localCrate&localVersions&offset&limit&sort&desc&filter` | one page of caller crates (cached aggregate), per-version requirement status, names for the page's crates; totals for the filtered set, `meta.hasMore`, `meta.truncated` when `total > cap` |
| `GET /api/symbols/callers/crates?fn&versions&cap&q&limit` | caller crate names containing `q` (filter hints), off the same cached aggregate |
| `GET /api/symbols/callees?fn&crate&version` | what a function calls, in the chosen or newest compiled copy |
| `GET /api/{unsafe,build,native,diffs}/{stats,top,crate/:name}` | leaderboard tiles, sorted/filtered rows (`hasMore` for paging), one crate's per-version history; stats come from the jobs service's `Stats` nodes (`computedAt`), live + cached 60 s without one |
| `GET /api/stats/status`, `POST /api/stats/refresh` | stored `Stats` ages; refresh forwarded to `RENDER_JOBS_URL` (503 without one) |
| `GET /api/registry/*`, `/api/publishers/*`, `/api/releases*`, `/api/supply/*` | registry, publisher, release, and supply-chain data |
| `POST /api/cypher` | `{query, params}`, read-only, row-capped; 403 when disabled |

Neo4j client errors return 400 with the Neo4j `code`; a query that exhausts its timeout returns 504.
