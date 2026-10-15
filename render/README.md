# painter-render

Web UI for the painter graph, built on the
[Neo4j Visualization Library](https://neo4j.com/docs/nvl/current/). Standalone
from the Rust side; the only contract is the graph schema painter writes
(`Crate`, `Version`, `VERSION_OF`, `DEPENDS_ON`, `INVOKES`).

Two pieces, one container:

- `server/`: Node + Express. Owns the Neo4j driver, runs every query read-only,
  serves the JSON API under `/api` and the built UI from `dist/`. The browser
  never talks to Neo4j.
- `src/`: React + NVL, built with Vite.

```
render/
  server/
    config.mjs        every setting, read from env at startup
    graph.mjs         neo4j records -> {nodes, rels, rows}
    callers.mjs       reverse call-graph walk for the Callers view, Cargo requirement matching
    index.mjs         routes
    lod/              Map view precompute (layout + communities) and viewport index
      build.mjs       full build / incremental update pipeline
      index.mjs       in-memory viewport index
      jobs.mjs        one-at-a-time job runner (worker thread)
      worker.mjs      worker entry
      cli.mjs         npm run lod:*
      neo4j-io.mjs    streaming reads, batched writes
  src/
    App.tsx           view switching, Default and Deps canvases
    components/       Toolbar, DetailsPanel, CypherPanel, StatusBar, MapView, CallersView
    api.ts            API client + types
    graph.ts          store -> NVL elements, colours
  Dockerfile          two-stage; final image runs `node server/index.mjs`
```

## From scratch

Prereqs: Node 22+, Docker with compose, a Neo4j with painter data (the repo's
`docker-compose.yaml` neo4j service, or any bolt endpoint).

Compose, everything:

```
docker compose up -d --build        # neo4j on 7474/7687, UI on http://localhost:8080
```

The `render` service points at `bolt://neo4j:7687` over the compose network.
It starts serving before Neo4j is ready and retries in the background; the
status bar and `GET /api/health` tell you when it is actually connected.

Rebuild and redeploy only the UI, leaving neo4j (and anything importing into
it) alone:

```
docker compose up -d --build --no-deps render
```

Local dev against the compose neo4j on localhost:

```
cd render
npm install
npm run dev          # API on :8080 with --watch, Vite on :5173 proxying /api
```

Single process serving the built UI:

```
npm run build && npm start
```

Any other Neo4j: set `NEO4J_URI` / `NEO4J_PASSWORD` (env or compose). From a
container to a Neo4j on the host, use `bolt://host.docker.internal:7687` and on
Linux add `--add-host=host.docker.internal:host-gateway`.

Database side: create the constraints and indexes in `docker/queries.md`.
`idx_crate_name_text` is what makes partial-name search fast;
`idx_invoke_target` is what makes the Callers view fast (without it each step
expands every `INVOKES` edge into the callee crate, seconds for tokio). The Map
build creates its own `lod_*` indexes.

To get the Map view working you also need the precompute, see below. The
Default and Deps views work as soon as the graph has data.

## Configuration

All env, read once at startup. Defaults match the compose neo4j exposed on
localhost. `.env.example` lists them.

| Variable | Default | What |
| --- | --- | --- |
| `NEO4J_URI` | `bolt://localhost:7687` | |
| `NEO4J_USER` | `neo4j` | |
| `NEO4J_PASSWORD` | `changeme123` | |
| `NEO4J_DATABASE` | `neo4j` | |
| `NEO4J_MAX_ROWS` | `2000` | row/limit cap on every query, Cypher panel included |
| `NEO4J_QUERY_TIMEOUT_MS` | `30000` | per-query transaction timeout |
| `NEO4J_CONNECT_RETRIES` | `0` (forever) | startup connect retries before exiting |
| `NEO4J_CONNECT_RETRY_DELAY_MS` | `3000` | |
| `RENDER_ALLOW_CYPHER` | `true` | `false` disables the Cypher panel and `POST /api/cypher` |
| `RENDER_DEPS_DEFAULT_EDGES` | `5000` | Deps edge cap when the request gives none |
| `RENDER_DEPS_MAX_EDGES` | `50000` | hard cap on Deps edges per response |
| `RENDER_DEPS_TIMEOUT_MS` | `180000` | timeout for the Deps queries |
| `RENDER_DEPS_CACHE_MS` | `600000` | cache for the whole-graph `/api/graph/deps` answer |
| `RENDER_LOD_ITERATIONS` | `300` | ForceAtlas2 iterations for a Map build |
| `RENDER_LOD_TIMEOUT_MS` | `3600000` | timeout for the build's streaming reads/writes |
| `RENDER_LOD_WORKER_HEAP_MB` | `8192` | heap cap for the in-server build worker |
| `RENDER_LOD_CHECKPOINT` | `/tmp/painter-lod-checkpoint.json` | layout checkpoint file |
| `RENDER_LOD_BUDGET` | `600` | default max elements per Map viewport |
| `RENDER_LOD_MAX_LEVEL` | `12` | finest grid level of the viewport index |
| `PORT` | `8080` | |
| `HOST` | `0.0.0.0` | |

## Views

The graph views (Default, Deps, Map): scroll wheel (or pinch) zooms, drag pans, Fit reframes,
Clear empties the canvas. Click a node or edge for its properties.

### Default

Crates, versions, and `VERSION_OF` / `DEPENDS_ON` / `INVOKES` edges.

Type a crate name or part of one and Load. Matching is case-insensitive
anywhere in the name, prefix first (`serd` -> serde, serde_json, ...); Load
takes the top match and shows the resolved name. The toggles next to the box
pick what comes back: latest version or all versions, outgoing `DEPENDS_ON`,
outgoing `INVOKES`, incoming dependents, and a per-type limit.

Side panel buttons expand one node (versions, dependencies, dependents,
invokes / invoked by). Double-click expands everything around a node. Status
bar checkboxes hide relationship types; "edge labels" draws requirement
strings on `DEPENDS_ON` and call counts on `INVOKES`.

"Latest" is `Version.latest = true` (from `painter set-latest-versions`) when
present, else the highest semver triple.

`INVOKES` is one relationship per call site in the graph. The server folds
them into one edge per (`Version`, `Crate`) with a `count` and up to ten
sample `targets`; ids of those edges start with `agg:`. The Cypher panel
returns raw relationships.

The Cypher panel at the bottom runs any read query. Nodes, relationships, and
paths in the result are merged into the canvas; scalar columns show as a
table.

### Deps

Crates only, as a transitive dependency chain. Versions are folded into their
crate; an edge A -> B means some version of A depends on B.

Type a name and Load. If a crate with exactly that name exists it is the only
root (`serde` is serde). Otherwise, with 3+ characters, every crate whose name
contains the text is a root (`serde_js` is serde_json, serde_json5, ...).
Shorter text has to match exactly.

The chain follows dependencies breadth-first until it ends, until **max
depth** (0 = unlimited), or until **max edges** (default 5000). The status bar
says which stopped it and how many roots there were. From the side panel:
add a crate's direct dependents or dependencies, or restart the chain from
that crate. Edge width is the number of versions declaring the dependency.

Full-depth chains of big crates hit the edge cap fast because every historical
version's dependencies are folded in. Depth 2 or 3 gives a readable picture.

### Map

The whole ecosystem on a precomputed layout, drawn at a level of detail that
keeps the element count under **max visible** (default 600). Zoomed out you
get clusters captioned with their crate count and largest crate; zoom in and
they split until you are looking at individual crates. Colour is Louvain
community. Click a cluster to zoom into it. "Go to" jumps to a crate. A
crate's panel can open its chain in Deps.

The side panel shows the build state and has **Update** and **Rebuild**.
Without a build the view just says so.

#### Map precompute

Stored in the database, so every render instance shares it:

- `Crate.lod_x`, `Crate.lod_y`: ForceAtlas2 position
- `Crate.lod_community`, `Crate.lod_degree`: Louvain community id, crate-level degree
- `(Crate)-[:LOD_DEP {versions}]->(Crate)`: one edge per crate pair, `versions` = how many versions declare it
- `(:LodMeta {id:'default'})`: counts, bounds, timings, `built_at`

Full build: stream every `DEPENDS_ON` once and aggregate to crate pairs,
replace the `LOD_DEP` edges, Louvain, ForceAtlas2 (Barnes-Hut), write
positions, write meta. Measured on 340k crates / 37M `DEPENDS_ON`:
aggregation 2.5 min, edge write 5 min, Louvain 8 s, layout 300 iterations in
25 min at about 2.5 GB. The layout is single-threaded.

Update: for crates with no position yet (anything imported after the last
build), aggregate just their edges, write their `LOD_DEP`, place them at the
centroid of positioned neighbours. Seconds. Does not move existing crates and
does not refresh edges between them; a full build does.

CLI, same env as the server:

```
npm run lod:build -- --iterations 300        # full build
npm run lod:build -- --reuse-edges --resume   # skip aggregation, continue the layout
npm run lod:update
npm run lod:status
```

`--reuse-edges` uses the `LOD_DEP` edges already stored instead of
re-aggregating `DEPENDS_ON`; drop it after a large import. `--resume` starts
from the checkpoint file (written every `--checkpoint-every` iterations,
default 20) or, failing that, from the positions in the database, and runs
only the remaining iterations. A crash costs at most one checkpoint interval.

Keep it from eating the box:

```
NODE_OPTIONS=--max-old-space-size=6144 nice -n 19 ionice -c 3 npm run lod:build -- --reuse-edges --resume
```

Same thing from the UI (Rebuild with the two checkboxes) or the API
(`POST /api/lod/rebuild` with `{iterations, reuseEdges, resume}`,
`POST /api/lod/update`). Those run in a worker thread inside the render
server, one job at a time (409 if one is running), heap-capped by
`RENDER_LOD_WORKER_HEAP_MB`. The server keeps answering requests, polls
progress into `GET /api/lod/status`, and reloads its viewport index when a
job finishes or when it sees a new `built_at` from a CLI run.

#### Map serving

The server loads positions and `LOD_DEP` into typed arrays (14 s for the
full graph). `GET /api/lod/viewport?x0&y0&x1&y1&budget&minCell` picks the
finest grid level whose cells inside the bbox fit the budget and are at least
`minCell` layout units wide (the client sets `minCell` from its zoom so
clusters stay about 44 px apart), returns crates instead of clusters once few
enough remain, and aggregates edges between visible elements, capped at the
budget, strongest first. A dense viewport covering a few hundred thousand
crates answers in 100-300 ms; the whole-map answer is cached per budget.

The browser polls NVL's zoom/pan and refetches 180 ms after it settles.
Element sizes are divided by the zoom so they stay constant on screen.
`window.__painterNvl` and `window.__painterMap` expose the NVL instance and
calibration for headless checks.

## API

JSON throughout. Graph payloads are
`{nodes: [{id, labels, properties}], rels: [{id, type, from, to, properties}], meta}`;
`id` is the Neo4j `elementId` except for synthetic aggregate edges (`agg:`,
`dep:`) and Map elements (`crate:<name>`, `cell:<level>:<ix>:<iy>`).

| Route | What |
| --- | --- |
| `GET /api/health` | connection state and effective config, no secrets |
| `GET /api/stats` | node and relationship counts |
| `GET /api/crates/search?q&limit` | crate names containing `q`, prefix first |
| `GET /api/graph/crate/:name?versions&deps&invokes&dependents&limit` | Default view load; `name` may be partial, `meta.resolvedName` says what was picked |
| `POST /api/graph/expand` | `{id, direction, types, limit}`: neighbours of a node |
| `GET /api/graph/deps?crate&direction&limit` | crate-level direct neighbours; no `crate` = whole graph, capped and cached |
| `GET /api/graph/deps/chain?q&limit&depth&exact` | Deps view: transitive chain, `meta.roots/depth/truncated` |
| `GET /api/lod/status` | job state, `LodMeta`, index state, unpositioned count |
| `POST /api/lod/rebuild` | `{iterations?, reuseEdges?, resume?}`; 202, or 409 if busy |
| `POST /api/lod/update` | place new crates; 202, or 409 if busy |
| `GET /api/lod/viewport?x0&y0&x1&y1&budget&minCell` | clusters or crates for a viewport; no bbox = whole map; 503 until a build is loaded |
| `GET /api/lod/locate?name` | a crate's map position |
| `GET /api/lod/search?q&limit` | crate names on the map, in memory |
| `GET /api/crates/:name/versions` | a crate's versions, newest first, with `latest` and `exported` (has `INVOKES`) |
| `GET /api/functions/search?crate&q&limit` | called functions of a crate containing `q`, most-called first |
| `GET /api/callers?crate&fn&match&version&depth&limit` | Callers view: `rows` of `{depth, crate, version, function, calls, verified, path}`; `match=exact` or `contains` |
| `GET /api/node/:id` | one node by `elementId` |
| `POST /api/cypher` | `{query, params}`, read-only, row-capped; 403 when disabled |

Neo4j client errors come back as 400 with the Neo4j `code`; a query that
exhausts its timeout comes back as 504.
