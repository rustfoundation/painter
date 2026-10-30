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

- `idx_crate_name_text`: partial-name search.
- `const_symbol_name`: Callers view (one seek per function name on `Symbol.name`, then its callers).
- `idx_has_build_script`, `idx_version_links`, `idx_has_native_code`, `idx_vendored_native`,
  `idx_diff_lines_added`: Build scripts / Native code / Diffs leaderboards.
- Registry indexes (`idx_user_login`, `idx_published_at`, `idx_owns_since`,
  `idx_version_published_at`, `idx_crate_created_at`, `idx_crate_downloads`): Publishers / Releases /
  Supply chain. `painter generate-metadata --job registry` creates them.
- The Map build creates its own `lod_*` indexes.

Default and Deps work as soon as the graph has data; Map needs the precompute below.

## Views

Graph views (Default, Deps, Map): wheel/pinch zooms, drag pans; click a node or edge for properties.

**Default**: crates, versions, and `VERSION_OF` / `DEPENDS_ON` / `INVOKES` edges around a crate name
(case-insensitive substring, prefix first; Load takes the top match). "Latest" is
`Version.latest` when present, else the highest semver triple. `INVOKES` is not stored: the server
folds calls into one synthetic edge per (`Version`, `Crate`) with a `count` of distinct calls and up
to ten sample `targets` (ids start with `agg:`). The Cypher panel returns raw relationships and
merges nodes, relationships, and paths into the canvas.

**Deps**: crates only; an edge A -> B means some version of A depends on B, and its width is the
number of versions that declare it. An exact crate name is the only root; otherwise, with 3+
characters, every crate containing the text is a root. The walk stops at max depth (0 = unlimited)
or max edges (default 5000); the status bar says which. Full-depth chains of big crates hit the cap
fast because every historical version is folded in, so use depth 2-3.

**Map**: the whole ecosystem on a precomputed layout, drawn at a level of detail that keeps the
element count under max visible (default 600); colour is Louvain community.

**Callers**: a table of every crate version and function that calls a given function, directly or
transitively, with the call chain per row. Requirement checks are applied per hop.

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
| `GET /api/graph/crate/:name` | Default load; `name` may be partial, `meta.resolvedName` says what was picked |
| `POST /api/graph/expand` | neighbours of a node (`VERSION_OF`, `DEPENDS_ON`, `INVOKES`, `OWNS`, `PUBLISHED`) |
| `GET /api/graph/deps/chain` | Deps view; `meta.roots/depth/truncated` |
| `GET /api/lod/*` | Map status, viewport, locate, search; viewport is 503 until a build is loaded |
| `GET /api/callers?crate&fn&match&version&depth&limit` | Callers rows; `match=exact\|contains` |
| `GET /api/{unsafe,build,native,diffs}/{stats,top,crate/:name}` | leaderboard tiles, sorted/filtered rows (`hasMore` for paging), one crate's per-version history; stats come from the jobs service's `Stats` nodes (`computedAt`), live + cached 60 s without one |
| `GET /api/stats/status`, `POST /api/stats/refresh` | stored `Stats` ages; refresh forwarded to `RENDER_JOBS_URL` (503 without one) |
| `GET /api/registry/*`, `/api/publishers/*`, `/api/releases*`, `/api/supply/*` | registry, publisher, release, and supply-chain data |
| `POST /api/cypher` | `{query, params}`, read-only, row-capped; 403 when disabled |

Neo4j client errors return 400 with the Neo4j `code`; a query that exhausts its timeout returns 504.
