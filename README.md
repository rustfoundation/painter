# Painter

Painter is an implementation of methodologies to build a graph database of dependencies and invocations between all crates within the crates.io ecosystem.

The graph can be explored with the web UI in `render/` (`docker compose up -d`,
then http://localhost:8080; see [render/README.md](render/README.md)).

**Default**: a crate's latest version with its dependencies and invocations.
Clicking an `INVOKES` edge (calls from a version into a crate, aggregated by the UI) shows how
many distinct calls it stands for and which functions are called.

![Default view: rocket and its DEPENDS_ON / INVOKES edges](docs/screenshots/default.png)

**Deps**: the transitive crate-level dependency chain (here `axum`, two levels deep).

![Deps view: transitive dependency chain of axum](docs/screenshots/deps.png)

**Map**: all 339,715 crates on a precomputed layout, coloured by community;
clusters split into individual crates as you zoom in.

![Map view: the whole ecosystem clustered by community](docs/screenshots/map.png)

**Callers**: every crate version and function that calls a given function,
directly or through other functions, with the call chain for each row (here
callers of `bytes::bytes::Bytes::copy_from_slice`).

![Callers view: transitive callers of bytes::Bytes::copy_from_slice](docs/screenshots/callers.png)

## Index Importing
The index is imported leveraging the `crates-index` crate. We iterate all version of
all crates in the index and their dependencies, building out the crate and version
nodes and relationships within the database. Alternative methods are available in the
POC directory where imports were done directly from the csv dump of the crates.io
database. Regardless, this is meant to build out an initial graph representation of
the entire crates.io ecosystem and mapping out all dependencies of all versions in
all history.

### Alternatives
The index can also be imported from the crates.io SQL database dump with a set of scripts
in the graph-imports directory.


## Bytecode Analysis
We then determine the call graph of every crate by these steps:
1. Build the crate's library with default features, in release mode with debug info and LTO off,
   emitting LLVM bitcode: `cargo +<toolchain> rustc --release --lib -- -g --emit=llvm-bc -C lto=off --cap-lints=warn`
2. We then analyze the bytecode of every successfully compiled crate, extracting all
   invoke instruction variants in the LLVM bitcode. This renders a complete list of all
   `(function)->(function)` invocations within a given crate. We also demangle these and
   then filter out various cases such as runtimes, the std and core libraries, and other cases.
3. This list of `(function)->(function)` relationships is then imported into the database: each
   calling function of a `(Version)` becomes an `(Fn)` that `[:CALLS]` the `(Symbol)` of each
   function it calls, and a called symbol is `[:IN]` a `(Crate)`. The callee crate is the first
   path segment of the demangled callee symbol. In the future, we hope to be able to group or narrow versions of crates being invoked but
   this has not been implemented.

# Database Representation

Nodes:
- `(Crate { name })`
- `(Version { name, version, semver_major, semver_minor, semver_patch, semver_build, semver_pre })`,
  plus `latest` (from `set-latest-versions`) and `unsafe_*` / `safe_*` counts (from `count-unsafe`)

Relationships:
- `(Crate)-[:VERSION_OF]->(Version)` (note the direction: from the crate to its version)
- `(Version)-[:DEPENDS_ON { requirement, features, kind, optional }]->(Crate)`
- `(Version)-[:HAS_FN]->(Fn)-[:IS]->(Symbol { name })`: a function of the version (the caller)
- `(Fn)-[:CALLS { copies }]->(Symbol { name })-[:IN]->(Crate)`: a function it calls, in the crate
  its path names. One `Fn` per (version, calling function), one `CALLS` per distinct call, one
  `Symbol` per demangled function name shared by every version; `copies` counts the compiled
  (caller, callee) pairs behind the call (monomorphised generics demangle to the same name)

Re-running the export for a version that already has a call graph replaces it:
its `Fn` nodes are deleted and the new set created, so re-importing never
duplicates and a version with no cross-crate calls ends up with none. Databases
built before 2026-10-25 used `(Version)-[:INVOKES { callsite, target }]->(Crate)`,
one edge per compiled pair; `painter export-for-import` converts them
(see CLAUDE.md).

## Current Limitations
- Only crates which can have a local build complete are currently imported. Work is underway to expand support, but this greatly limits us in cases such as local dependency requirements, custom build steps, etc.
- We do not currently determine the version of a invoked callee
- LTO is disabled to limit inlining, but crates are built in release mode, so the optimizer still inlines and many invocations are lost at the bytecode level. Generic code is only present where it is instantiated, so a mostly generic library records few calls of its own. Source analysis can improve this. Examples of cases where an invoke is likely lost:
    - Dynamic function calls (pointers, vtables, etc.)
    - Inlining

## Future Work
- Enable real-time incremental updates triggered by new crate publishes
- Disable filtering out the standard library for analyzing `std` and `core` library usage
- Additional methods of invocation detection
    - Source analysis via `syn`
    - Debug symbol analysis
    - Addition of metadata to `rustc` for better reliability
- Better parameters around best-guess of invoked crate version, or grouping possible versions in the graph

# Quick Start

## Requirements
- Rust stable or nightly to build painter itself.
- LLVM 22 with development headers. `llvm-sys` finds `llvm-config` on `PATH`; point it elsewhere
  with `LLVM_SYS_221_PREFIX=/path/to/llvm-22`. The LLVM version is selected by the `llvm-22`
  feature of `llvm-ir-analysis` in `Cargo.toml` and must match the installed LLVM major version.
- A second Rust toolchain, with the `cargo` component, to compile the ecosystem (`--toolchain`,
  default `1.67`). Its bitcode must be readable by LLVM 22, so it must not ship a newer LLVM:
  Rust 1.96 works, Rust 1.99 (LLVM 23) does not.
- A git clone of the crates.io index (`https://github.com/rust-lang/crates.io-index`), passed with
  `PAINTER_INDEX_PATH`. Without it, painter clones the full git index under `~/.cargo`.
- The `.crate` files to analyse, either flat (`serde-1.0.0.crate`) or sharded like the index
  (`se/rd/serde/serde-1.0.0.crate`), for example a mirror made with
  [walterhpearce/crates-spider](https://github.com/walterhpearce/crates-spider.git).
- Docker, for Neo4j and the graph UI.
- [`count-unsafe`](https://crates.io/crates/count-unsafe) on `PATH`, only for the `count-unsafe` step.

## Build
```
git clone --recurse-submodules https://github.com/rustfoundation/painter
cd painter
cargo build --release
rustup toolchain install 1.96.1   # or any toolchain for --toolchain, see above
```

The `llvm-ir` and `llvm-ir-analysis` directories are git submodules; in an existing clone run
`git submodule update --init`. [BUILDING.md](BUILDING.md) has more on installing LLVM.

## Start the docker neo4j instance
A docker-compose is available for a default Neo4j instance that can be used for testing and local use.
The default credentials are `neo4j` / `changeme123`; change them in `docker-compose.yaml`
(`NEO4J_AUTH` for neo4j, `NEO4J_PASSWORD` for the UI).
- `docker compose up -d`

This also starts the graph UI on http://localhost:8080 (the `render` service).
See [render/README.md](render/README.md) for the views, the Map precompute,
and how to rebuild just the UI container without touching neo4j.

Before the first import, create the constraints and indexes listed at the top of
[docker/queries.md](docker/queries.md) (in the Neo4j browser at http://localhost:7474, or
`cypher-shell`). The import relies on the `Crate.name` uniqueness constraint to avoid duplicates.

## Graph UI
`render/` is a standalone web UI over the graph: a Node server that owns the
Neo4j connection and serves a React/NVL front end. Four views: Default
(crates, versions, dependency and invoke edges around a crate), Deps
(transitive crate-level dependency chain for a name or partial name), Map
(the whole ecosystem on a precomputed ForceAtlas2 layout with Louvain
communities, drawn at a zoom-dependent level of detail), and Callers (a table
of every crate version and function that calls a given function, directly or
transitively). The Map needs a one-off precompute that writes `lod_*` properties
and `LOD_DEP` edges into the database; `render/README.md` covers it, including
the incremental update for crates imported after the build.

## Populating the crate index database
The first step is populating your neo4j database from the crate index. Crates, versions and
dependency relationships are populated at this step. Every command below reads the index from
`PAINTER_INDEX_PATH`; keep that clone current with `git pull`.
```
export PAINTER_INDEX_PATH=/path/to/crates.io-index
cargo run --release -- create-fresh-db -d bolt://127.0.0.1:7687 -u neo4j -p changeme123
cargo run --release -- set-latest-versions -d bolt://127.0.0.1:7687 -u neo4j -p changeme123
```
`create-fresh-db` skips versions that already exist, so an interrupted run can be restarted; add
`--only <CRATE>` (repeatable) to import specific crates. `import-crates <CRATE>...` refreshes
named crates in an existing database. `set-latest-versions` marks each crate's highest version
with `latest = true`, which the UI and the queries below use; re-run it after importing new versions.

## Run the analysis
This will populate the database with all invocation relationships. These exist as a representation of a given
version calling a given crate. We cannot definitively say what version of what crate is invoked, so the relationship
exists as `(Version)-[:HAS_FN]->(Fn)-[:CALLS]->(Symbol)-[:IN]->(Crate)`.

Painter extracts each `.crate` file from `-c` into `-s` as `{crate}-{version}/` itself and writes
bitcode to `-b` in the same layout. `-s`, `-b`, and `-c` are the same three roots for every command.
```
export PAINTER_INDEX_PATH=/path/to/crates.io-index
cargo run --release -- compile-all --toolchain 1.96.1 -s sources -c crates -b bytecodes
cargo run --release -- export-all-neo4j -s sources -c crates -b bytecodes -d bolt://127.0.0.1:7687 -u neo4j -p changeme123
cargo run --release -- count-unsafe -s sources -c crates -d bolt://127.0.0.1:7687 -u neo4j -p changeme123
```
- `compile-all` builds the highest version of every crate in the index by default. Narrow or widen
  it with `--only <CRATE>` (repeatable), `--all-versions`, `--top-downloads N`, `--top-reverse-deps N`,
  `--top-maintainers N`, and `--newer-than YYYY-MM-DD` (the `--top-*` and `--newer-than` rules query
  [ecosyste.ms](https://packages.ecosyste.ms)); `-j N` caps concurrent crates. Versions that already have
  a directory under `-b` are skipped; delete it to rebuild. `plan` with the same flags prints the selection without compiling.
- `export-all-neo4j` exports every bytecode directory under `-b`. Each version logs
  `imported N invocations`; failures are logged at ERROR.
- `compile-check` takes the same roots, database, and rule flags as `compile-all` and prints how many
  selected crates/versions have bytecode, a `Version` node, and a call graph (`HAS_FN`); `-v` lists every
  incomplete version:
  `cargo run --release -- compile-check -s sources -c crates -b bytecodes -d bolt://127.0.0.1:7687 -u neo4j -p changeme123`

Set `RUST_LOG=info` to see progress.

## Querying
Open the Neo4j browser at http://localhost:7474 (or use `cypher-shell`, or the Cypher panel in
the graph UI). Some starting points:
```
// Crates that depend on serde in any version
MATCH (c:Crate)-[:VERSION_OF]->(:Version)-[:DEPENDS_ON]->(:Crate {name: 'serde'})
RETURN count(DISTINCT c) AS dependents

// Latest version of a crate
MATCH (:Crate {name: 'serde'})-[:VERSION_OF]->(v:Version) WHERE v.latest RETURN v.version

// Crates a version calls into, by number of distinct calls
MATCH (:Version {name: 'rocket', version: '0.5.1'})-[:HAS_FN]->(:Fn)-[:CALLS]->(:Symbol)-[:IN]->(t:Crate)
RETURN t.name AS crate, count(*) AS calls ORDER BY calls DESC

// Direct callers of one function
MATCH (:Symbol {name: 'bytes::bytes::Bytes::copy_from_slice'})<-[:CALLS]-(f:Fn)<-[:HAS_FN]-(v:Version)
MATCH (f)-[:IS]->(caller:Symbol)
RETURN v.name, v.version, caller.name

// Latest versions with the most unsafe code (after count-unsafe)
MATCH (v:Version) WHERE v.latest AND v.unsafe_total > 0
RETURN v.name, v.version, v.unsafe_total ORDER BY v.unsafe_total DESC LIMIT 20
```
Remember the `VERSION_OF` direction, `(Crate)-[:VERSION_OF]->(Version)`. To reach a crate's versions,
go through its `Crate` node as above: matching `(:Version {name: ...})` without a version cannot use
the `(name, version)` index and scans every version. [docker/queries.md](docker/queries.md) has more
examples.

## Continuous integration
GitHub Actions runs three workflows on every push to `main` and every pull request: `lint`
(`cargo fmt -- --check`, `cargo clippy --all-targets -- -D warnings`), `build` (debug and release,
all targets), and `test` (`cargo test --all-targets`). They install LLVM 22 from apt.llvm.org and
stable Rust; the compile tests additionally use Rust 1.96.1 because its LLVM matches the one
`llvm-ir` links against. Run the same commands locally before pushing.

### Database 

Current `crates.io` graph snapshot: *Coming Soon*

## [Code of Conduct][code-of-conduct]

The Rust Foundation has adopted a Code of Conduct that we expect project 
participants to adhere to. Please read 
[the full text][code-of-conduct]
so that you can understand what actions will and will not be tolerated.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licenses

Painter is primarily distributed under the terms of both the MIT license and the
Apache License (Version 2.0), with documentation portions covered by the
Creative Commons Attribution 4.0 International license..

See [LICENSE-APACHE](LICENSE-APACHE), [LICENSE-MIT](LICENSE-MIT), 
[LICENSE-documentation](LICENSE-documentation), and 
[COPYRIGHT](COPYRIGHT) for details.

You can also read more under the Foundation's [intellectual property policy][ip-policy].

## Other Policies

You can read about other Rust Fondation policies in the footer of the Foundation [website][foundation-website].

[rust-foundation]: https://foundation.rust-lang.org/
[media-guide]: https://foundation.rust-lang.org/policies/logo-policy-and-media-guide/
[ip-policy]: https://foundation.rust-lang.org/policies/intellectual-property-policy/
[foundation-website]: https://foundation.rust-lang.org
[code-of-conduct]: https://foundation.rust-lang.org/policies/code-of-conduct/
