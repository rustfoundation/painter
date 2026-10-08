# painter-render

A small web UI that renders the painter crates.io graph with the
[Neo4j Visualization Library (NVL)](https://neo4j.com/docs/nvl/current/).
It is self-contained: nothing here depends on the Rust code, only on the graph
schema painter writes (`Crate`, `Version`, `VERSION_OF`, `DEPENDS_ON`,
`INVOKES`).

```
render/
  server/          Node (Express) server: owns the Neo4j driver, exposes /api, serves dist/
    config.mjs     all runtime configuration, read from the environment
    graph.mjs      neo4j-driver records -> JSON {nodes, rels, rows}
    index.mjs      routes
  src/             React + NVL frontend (Vite, TypeScript)
  Dockerfile       two-stage build, final image runs `node server/index.mjs`
```

The browser never talks to Neo4j directly. The server holds the credentials
and runs every query in a read-only transaction.

## Configuration

Everything is an environment variable, read once at startup
(`server/config.mjs`). Defaults match the `neo4j` service in the repo's
`docker-compose.yaml` exposed on localhost.

| Variable                      | Default                   | Meaning                                                     |
| ----------------------------- | ------------------------- | ----------------------------------------------------------- |
| `NEO4J_URI`                   | `bolt://localhost:7687`   | Bolt URI of the Neo4j instance                              |
| `NEO4J_USER`                  | `neo4j`                   |                                                             |
| `NEO4J_PASSWORD`              | `changeme123`             |                                                             |
| `NEO4J_DATABASE`              | `neo4j`                   |                                                             |
| `NEO4J_MAX_ROWS`              | `2000`                    | Hard cap on rows/limits for every query, including ad-hoc   |
| `NEO4J_QUERY_TIMEOUT_MS`      | `30000`                   | Transaction timeout                                         |
| `NEO4J_CONNECT_RETRIES`       | `0` (forever)             | Startup connectivity retries before exiting                 |
| `NEO4J_CONNECT_RETRY_DELAY_MS`| `3000`                    |                                                             |
| `RENDER_ALLOW_CYPHER`         | `true`                    | Set `false` to disable the ad-hoc Cypher panel              |
| `PORT`                        | `8080`                    | HTTP port                                                   |
| `HOST`                        | `0.0.0.0`                 | Bind address                                                |

See `.env.example`.

## Running against localhost (development)

Requires Node 22+. With the repo's Neo4j up (`docker compose up -d neo4j`):

```
cd render
npm install
npm run dev
```

`npm run dev` starts the API server on `:8080` (with `node --watch`) and the
Vite dev server on `:5173`, which proxies `/api` to the server. Open
http://localhost:5173. Override the server address for Vite with
`RENDER_API_URL`, and the Neo4j address for the server with `NEO4J_URI`, e.g.

```
NEO4J_URI=bolt://some-host:7687 NEO4J_PASSWORD=secret npm run dev
```

Production-style, single process on `:8080` serving the built UI:

```
npm run build
npm start
```

## Running with Docker Compose

The repo's `docker-compose.yaml` defines a `render` service built from this
directory and pointed at the `neo4j` service over the compose network:

```
docker compose up -d --build
# UI on http://localhost:8080, Neo4j Browser still on :7474
```

To point the container at a different Neo4j, override the environment in
compose or at run time:

```
docker build -t painter-render ./render
docker run --rm -p 8080:8080 \
  -e NEO4J_URI=bolt://host.docker.internal:7687 \
  -e NEO4J_PASSWORD=changeme123 \
  painter-render
```

(`--add-host=host.docker.internal:host-gateway` on Linux if you want the
container to reach a Neo4j on the host.)

The server starts serving immediately and keeps retrying the database in the
background, so `render` can come up before `neo4j` is ready. The status bar
in the UI (and `GET /api/health`) shows the real connection state.

## Using the UI

- Type a crate name (autocomplete) and press Load. Options next to the box
  control what is fetched: latest or all versions, outgoing `DEPENDS_ON`,
  outgoing `INVOKES`, incoming dependents, and a per-type limit.
- Click a node or edge to see its properties. The side panel offers targeted
  expansions (versions, dependencies, dependents, invokes/invoked-by).
  Double-click a node to expand everything around it.
- Relationship types can be hidden with the checkboxes in the status bar;
  "edge labels" draws captions (requirement for `DEPENDS_ON`, call count for
  `INVOKES`).
- The Cypher panel at the bottom runs any read query. Every node,
  relationship, or path in the result is merged into the current view, and
  scalar columns are shown as a table.

"Latest" prefers `Version.latest = true` (written by
`painter set-latest-versions`) and otherwise falls back to the highest semver
triple, so it works on a graph where that stage has not run.

`INVOKES` is stored as one relationship per call site. The server collapses
them into one edge per (`Version`, `Crate`) pair with a `count` and up to ten
sample `targets`; those synthetic edges have ids starting with `agg:`. Ad-hoc
Cypher returns the raw relationships.

## API

All responses are JSON. Graph payloads are
`{ nodes: [{id, labels, properties}], rels: [{id, type, from, to, properties}], meta }`
where `id` is the Neo4j `elementId`.

| Route                              | Description                                                   |
| ---------------------------------- | ------------------------------------------------------------- |
| `GET /api/health`                  | Connection state plus the effective (secret-free) config      |
| `GET /api/stats`                   | Node and relationship counts                                  |
| `GET /api/crates/search?q=&limit=` | Crate names starting with `q`                                 |
| `GET /api/graph/crate/:name`       | Crate neighbourhood; see query params in `server/index.mjs`   |
| `POST /api/graph/expand`           | `{id, direction, types, limit}` neighbours of a node          |
| `GET /api/node/:id`                | Single node by elementId                                      |
| `POST /api/cypher`                 | `{query, params}` read-only, row-capped                       |
