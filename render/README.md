# painter-render

Web UI for the painter graph, built on the
[Neo4j Visualization Library](https://neo4j.com/docs/nvl/current/). Standalone
from the Rust side; the only contract is the graph schema painter writes
(`Crate`, `Version`, `VERSION_OF`, `DEPENDS_ON`, and the call graph `HAS_FN` / `Fn` / `IS` /
`CALLS` / `Symbol` / `IN`).

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
    unsafe.mjs        Unsafe view queries over the generate-metadata unsafe properties
    metadata.mjs      Build scripts / Native code / Diffs view queries over the build / native / diff properties
    registry.mjs      Publishers / Releases / Supply chain view queries over the registry job's User, Team, OWNS, PUBLISHED, dates
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
    components/       Toolbar, DetailsPanel, CypherPanel, StatusBar, MapView, CallersView, UnsafeView,
                      BuildView, NativeView, DiffsView, PublishersView, ReleasesView, SupplyView
                      (+ meta.tsx: tiles, histogram, leaderboard hook, history strip, date helpers, UserLink they share)
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
`const_symbol_name` is what makes the Callers view fast: each step is one seek
per function name on `Symbol.name`, then its callers. The Map build creates its
own `lod_*` indexes. The Build scripts / Native code / Diffs leaderboards use
`idx_has_build_script`, `idx_version_links`, `idx_has_native_code`,
`idx_vendored_native`, and `idx_diff_lines_added` (each builds in seconds).
The Publishers / Releases / Supply chain views need the registry job's indexes
(`painter generate-metadata --job registry` creates them): `idx_user_login`,
`idx_published_at` (a relationship range index on `PUBLISHED.at`),
`idx_owns_since`, `idx_version_published_at`, `idx_crate_created_at`, and
`idx_crate_downloads`.

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

`INVOKES` is not stored: the graph holds calls as
`(Version)-[:HAS_FN]->(Fn)-[:CALLS]->(Symbol)-[:IN]->(Crate)`. The server
folds them into one synthetic `INVOKES` edge per (`Version`, `Crate`) with a
`count` of distinct calls and up to ten sample `targets`; ids of those edges
start with `agg:`. The Cypher panel returns raw relationships.

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

### Unsafe

A leaderboard of crate versions by the unsafe-code metrics `painter generate-metadata`
stores on `Version` nodes (geiger's counters per category, source size,
`#![forbid(unsafe_code)]` on the crate root, build scripts). Tiles at the top give
scan coverage, the share of versions with any unsafe, the totals per category
(click one to sort by it), and a histogram of unsafe totals. Scope is latest
versions (fast, index-backed) or all versions (a full scan, seconds). Filters:
crate name, forbid(unsafe_code) yes/no, build script yes/no, minimum lines,
minimum unsafe. Every column header sorts server-side; `/kloc` is unsafe
expressions per thousand lines and `share` their fraction of all expressions.
The `mix` bar shows the category breakdown of each row.

Clicking a row opens the crate's history (one bar per version, latest
highlighted; click a bar to filter to that crate), the safe/unsafe split per
category, "Open in graph", and "Unsafe in dependencies": the unsafe carried in
by every dependency reachable from that version in N hops (dev-dependencies
skipped, each dependency at its latest version), most unsafe first.

In the graph views a scanned version's caption shows `☢N` when it has unsafe
code, and the side panel has an Unsafe section with the same breakdown.

### Build scripts, Native code, Diffs

Three more leaderboards over what `painter generate-metadata` stores on
`Version` nodes (jobs `build`, `native`, `diff`; see `docker/queries.md` for the
property list). They share the Unsafe view's shape: coverage and total tiles at
the top (click a tile to sort or filter by it), scope latest / all versions,
server-side sort on every column, filters, paging, Copy TSV, and clicking a row
opens the crate's per-version history (one bar per version, oldest left, latest
outlined; click a bar to filter to that crate) plus "Open in graph". A run of
`generate-metadata` may still be in progress: coverage says how many versions
each job has reached, and versions it has not reached are simply absent.

**Build scripts**: versions Cargo would run a build script for, with the
script's path (`package.build`, normally `build.rs`), its line count, and the
`package.links` library it claims. Tiles: coverage (the unsafe scanner also
stored `has_build_script`, so "with a build script" is over every version where
it is known), share declaring `links`, custom script paths, total script lines,
a size histogram, and the most-linked libraries by distinct crate (click one, or
a `links` cell, to filter to it). Filters: name, links yes/no, exact links name,
custom path, min lines. Flags show native / vendored code.

**Native code**: versions shipping C / C++ / Objective-C / assembly sources or
headers, or prebuilt binaries. Columns: native lines (sources + headers,
non-blank), source-only lines, files, bytes, largest file, lines under
`vendor/`-style directories, prebuilt binary count, top-level directories, and
language chips. Tiles: coverage, share with native code, share that is a
vendored library (the thresholds are in `docker/queries.md`), prebuilt binaries,
native + build script, one tile per language (click to filter), a lines
histogram, and where the code lives. Filters: name, vendored, prebuilt,
language, min lines. The history bar is native lines, orange when vendored.

**Diffs**: what changed between consecutive versions (semver order,
pre-releases before their release). Columns: churn (lines added + removed),
lines added / removed, files added / removed / modified, files in the version,
the base version. Tiles: coverage, lines added / removed (net), files changed,
unchanged republishes (identical to the previous version), approximate diffs
(a file hit the 2 s per-file bound), and a churn histogram. First versions are
excluded by default (everything counts as added); `first versions` can include
or isolate them. The expanded row shows the crate's history (bar height =
churn, green added / red removed, first version grey; click a bar to switch)
and the changed files of the shown version, biggest first, with `+ − ~` status
and `binary` where there are no line counts.

Captions in the graph views carry the same facts: `⚙` build script
(`⚙→lib` when it declares `links`), `C` native code (`C!` vendored, `C+bin`
with prebuilt binaries), `Δ+a/−r` lines changed since the previous version.
The side panel of a `Version` has Build script, Native code, and Changes
sections (the latter lists the eight biggest file changes; the per-file
`diff_*` lists are left out of the raw property table).

### Publishers, Releases, Supply chain

Three views over the crates.io registry data `painter generate-metadata --job
registry` loads from a crates.io database dump: `User` / `Team` nodes,
`OWNS {since, added_by}` and `PUBLISHED {at, last, versions}` edges, categories
and keywords, and the registry properties on `Crate` (downloads, dates,
description, links, `trustpub_only`) and `Version` (`published_at`, `yanked`,
license, size, downloads, edition, MSRV, targets). Dates come from the API as
ISO strings. Every query is index-backed and LIMITed; the only whole-type
aggregations (coverage, the prolific-publisher boards) are cached for 10
minutes and run with the long timeout, like the other views' stats. Note that
the crates.io index clone painter imports `Version` nodes from can lag the
dump by days, so the newest versions in a dump may have no node yet; the
crate-level `PUBLISHED.last` still reflects them.

**Publishers**: type a login (prefix match on `User.login`, teams by substring)
and Open, or click any login anywhere in the UI. Without a login the view shows
registry coverage tiles (users, teams, ownerships, publisher pairs, yanked,
trusted-publishing-only crates) and four leaderboards: most crates published,
most uploads, owners of the top 5,000 crates by downloads (with how many they
own alone), and publishers of those crates. A publisher page has totals
(crates published and their downloads, uploads with first / last date, crates
owned and sole ownerships, downloads of owned crates, and among the latest
versions of their crates how many have unsafe code, build scripts, native code,
or are yanked), an upload timeline (per month or year, from the version-level
`PUBLISHED` edges, so nothing before 2017), and one table of every crate they
published or own: role, downloads, versions, their uploads with first / last
date, owner since and who added them, owner count (1 = sole owner, highlighted),
latest version with its metadata badges. Client-side sort and role filter,
Copy TSV; a crate row opens the crate in the Default graph. Teams have no
uploads, only ownerships.

**Releases**: crates or versions published in a date range (inclusive dates,
presets for the last 24 h to 1 y). Crates by `Crate.created_at` (first-ever
release) or by `PUBLISHED.at` on crate edges (a user's first upload of the
crate; `joined` marks crates that existed before, i.e. a new publisher joining).
Versions by `PUBLISHED.at` on version edges (uploader known) or by
`Version.published_at` (every version, uploader when recorded). A strip above
the table counts releases per day (ranges up to 92 days) or per month; click a
bar to zoom the range to it. Filters: name contains, minimum downloads. Sorting
by date walks the index in order and is fast for any range; sorting by
downloads or name materialises the range (long timeout). Rows show publisher /
owners (clickable), downloads, description or license / size / edition / MSRV
and the metadata badges, `yanked`, `trustpub`.

**Supply chain**: three boards of ownership signals, nothing precomputed, each
bounded by a top-N of crates by downloads (`idx_crate_downloads`, 500 to
20,000) or by an `OWNS.since` range. *Single-owner crates*: owned by exactly one
user and no team, with when and by whom they became owner, how many other
crates that account owns, how many distinct uploaders the crate has, the latest
version and date, and the crate's dependency degree from the Map precompute.
*Recent owner additions*: owners added since a date to crates above a download
floor, by default only when added by someone else, with the new owner's
account age, how many crates they publish, and whether they ever uploaded the
crate. *New uploader shipped latest*: crates with more than one version whose
latest version was uploaded by a user whose only upload of the crate it is,
with whether they are an owner and their account age.

In the graph views a `Crate`'s side panel has crates.io facts (description,
downloads, versions, created / updated, repository / homepage / documentation
links, trusted publishing), its owners (since, added by), publishers (uploads,
first / last), categories and keywords; a `Version`'s panel shows published
date, uploader, downloads, license, crate size, edition / MSRV, yanked, and
lib / bin targets. Logins open the Publishers view. "Owners" / "Publishers"
(crate) and "Uploader" (version) buttons add `User` (pink) and `Team` (teal)
nodes with `OWNS` / `PUBLISHED` edges; from a user, "Owns" / "Published" expand
the other way. Yanked versions carry a `⊘` caption badge.

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
| `POST /api/graph/expand` | `{id, direction, types, limit}`: neighbours of a node (`VERSION_OF`, `DEPENDS_ON`, `INVOKES`, `OWNS`, `PUBLISHED`) |
| `GET /api/graph/deps?crate&direction&limit` | crate-level direct neighbours; no `crate` = whole graph, capped and cached |
| `GET /api/graph/deps/chain?q&limit&depth&exact` | Deps view: transitive chain, `meta.roots/depth/truncated` |
| `GET /api/lod/status` | job state, `LodMeta`, index state, unpositioned count |
| `POST /api/lod/rebuild` | `{iterations?, reuseEdges?, resume?}`; 202, or 409 if busy |
| `POST /api/lod/update` | place new crates; 202, or 409 if busy |
| `GET /api/lod/viewport?x0&y0&x1&y1&budget&minCell` | clusters or crates for a viewport; no bbox = whole map; 503 until a build is loaded |
| `GET /api/lod/locate?name` | a crate's map position |
| `GET /api/lod/search?q&limit` | crate names on the map, in memory |
| `GET /api/crates/:name/versions` | a crate's versions, newest first, with `latest` and `exported` (has a call graph) |
| `GET /api/functions/search?crate&q&limit` | called functions of a crate containing `q`, most-called first |
| `GET /api/callers?crate&fn&match&version&depth&limit` | Callers view: `rows` of `{depth, crate, version, function, calls, verified, path}`; `match=exact` or `contains` |
| `GET /api/unsafe/stats?scope` | Unsafe view tiles: coverage, per-category totals, unsafe_total histogram (`scope=latest\|all`, cached 60 s) |
| `GET /api/unsafe/top?scope&sort&dir&q&forbids&build&minLines&minUnsafe&limit&offset` | Unsafe leaderboard rows, sorted and filtered server-side; `hasMore` for paging |
| `GET /api/unsafe/crate/:name` | every version of a crate with its unsafe metrics, oldest first |
| `GET /api/unsafe/deps?crate&version&depth&limit` | unsafe in a version's dependency closure (`depth` hops, dev-deps skipped, latest version of each dependency) |
| `GET /api/build/stats?scope` | Build scripts tiles: coverage, links / custom-path counts, script-size histogram, top `links` (cached 60 s) |
| `GET /api/build/top?scope&sort&dir&q&links&link&custom&minLines&limit&offset` | Build scripts leaderboard; `links` yes/no/any, `link` exact name, `custom` = not `build.rs`; `hasMore` for paging |
| `GET /api/build/links?scope&limit` | `package.links` values by distinct crates, with sample crate names |
| `GET /api/build/crate/:name` | every version of a crate with its build-script facts, oldest first |
| `GET /api/native/stats?scope` | Native code tiles: coverage, vendored / prebuilt counts, totals, per-language and per-directory breakdowns, lines histogram (cached 60 s) |
| `GET /api/native/top?scope&sort&dir&q&vendored&prebuilt&lang&minLines&limit&offset` | Native code leaderboard; `lang` is `c`, `c++`, `objc`, or `asm` |
| `GET /api/native/crate/:name` | every version of a crate with its native-code facts, oldest first |
| `GET /api/diffs/stats?scope` | Diffs tiles: coverage, lines / files totals over non-first versions, unchanged and approximate counts, churn histogram (cached 60 s) |
| `GET /api/diffs/top?scope&sort&dir&q&firsts&approximate&minChurn&limit&offset` | Diffs leaderboard; `firsts` = `exclude` (default), `include`, `only` |
| `GET /api/diffs/crate/:name` | every version of a crate with its diff totals, oldest first |
| `GET /api/diffs/version?crate&version` | one version's changed files (`{path, status, added, removed, binary}`), biggest first; `files` null until diffed |
| `GET /api/registry/stats` | registry coverage: users, teams, ownerships, publisher pairs, uploads, crates / versions reached by the dump, yanked, trustpub-only (cached 10 min) |
| `GET /api/publishers/search?q&limit` | `{users, teams}`: logins starting with `q` (index seek; the typed, lowercase, and capitalised spellings), teams containing it |
| `GET /api/publishers/user/:login` | a User or Team: properties, `crates` (published / owned merged by name with downloads and latest-version metadata), `timeline` (uploads per month), `totals` |
| `GET /api/publishers/leaderboards` | `byCrates`, `byUploads` (all users), `owners`, `publishers` (over the top 5,000 crates by downloads), top 100 each (cached 10 min) |
| `GET /api/releases?kind&source&from&to&q&minDownloads&sort&dir&limit&offset` | crates (`source=created\|publisher`) or versions (`source=publisher\|published_at`) published in `[from, to]`; `sort=date\|downloads\|name`; `hasMore` for paging |
| `GET /api/releases/histogram?kind&source&from&to` | releases per day (≤ 92 days) or month in the range, with the total (cached 10 min per range) |
| `GET /api/supply/bus-factor?top&limit&offset` | among the top N crates by downloads, those with one User owner and no Team |
| `GET /api/supply/owner-additions?since&minDownloads&self&limit&offset` | owners added since a date to crates above a download floor; `self=exclude` (default) drops self-added |
| `GET /api/supply/new-uploaders?top&limit&offset` | among the top N crates with > 1 version, latest versions uploaded by a first-time uploader of the crate |
| `GET /api/registry/crate/:name` | owners, publishers, categories, keywords of one crate |
| `GET /api/registry/version?crate&version` | uploader and dates of one version |
| `GET /api/node/:id` | one node by `elementId` |
| `POST /api/cypher` | `{query, params}`, read-only, row-capped; 403 when disabled |

Neo4j client errors come back as 400 with the Neo4j `code`; a query that
exhausts its timeout comes back as 504.
