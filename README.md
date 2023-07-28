# Painter

Painter is an implementation of methodologies to build a graph database of dependencies and invocations between all crates within the crates.io ecosystem.

![serde](/poc/serde.png)

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
1. Build the crate with default features and flags with `--emit=llvm-bc`
2. We then analyze the bytecode of every successfully compiled crate, extracting all
   invoke instruction variants in the LLVM bitcode. This renders a complete list of all
   `(function)->(function)` invocations within a given crate. We also demangle these and
   then filter out various cases such as runtimes, the std and core libraries, and other cases.
3. This list of `(function)->(function)` relationships is then imported into the database,
   represented as a given `(Version)` node of a crate `[:INVOKES]` a specific `(Crate)` node.
   In the future, we hope to be able to group or narrow versions of crates being invoked but
   this has not been implemented.

# Database Representation

Nodes:
- `(Version { name, version, major, minor, patch, build, pre })`
- `(Crate {name })`

Relationships:
- `(Version)-[:VERSION_OF]->(Crate)`
- `(Version)-[:DEPENDS_ON {requirement, features, kind, optional}]->(Crate)`
- `(Version)-[:INVOKES { caller, callee }]->(Crate)`

## Current Limitations
- Only crates which can have a local build complete are currently imported. Work is underway to expand support, but this greatly limits us in cases such as local dependency requirements, custom build steps, etc.
- We do not currently determine the version of a invoked callee
- LTO and optimizers are disabled to prevent inlining, but many cases exist in which the invocation is lost at a bytecode level. Source analysis can improve this. Examples of cases where an invoke is likely lost:
    - Dynamic function calls (pointers, vtables, etc.)
    - Inlining

## Future Work
- Enable real-time incremental updates triggered by new crate publishes
- Disable filtering out the standard library for analyzing `std` and `core` library usage
- Additional methods of invocation detection
    - Source analysis via `syn`
    - Debug symbol analysis
    - Addition of metadata to `rustc` for better reliability
- UI Frontend for graph exploration
- Better parameters around best-guess of invoked crate version, or grouping possible versions in the graph

# Quick Start

See [BUILDING.md](BUILDING.md) for build specific instructions.

**NOTE**: Requires rustc 1.60 for building the crate ecosystem and painter itself requires `nightly`; this is needed due to matching the LLVM IR version with the currently 
supported LLVM version of `llvm-sys` and `llvm-ir`. This will be updated as work to integrate newer LLVM versions is done.

## Start the docker neo4j instance
A docker-compose is available for a default Neo4j instance that can be used for testing and local use. 
Note or change the default testing username/password.
- `docker compose up`

## Populating the crate index database
The first step is populating your neo4j database with the up-to-date crate index. This is pulled from the live
crate index and populates the appropriate nodes and relationships. Crates, versions and dependency relationships 
are populated at this step.
- `cargo +nightly run -- create-fresh-db -d 127.0.0.1:7687 -u neo4j -p changeme123`

## Run the analysis
This will populate the database with all invocation relationships. These exist as a representation of a given 
version calling a given crate. We cannot definitively say what version of what crate is invoked, so the node relationshp
exists at `(Version)-[INVOKES]->(Crate)`
- Extract all crate files to a working folder, where names are {crate}-{version}. This can be done with any number of tools
in the ecosystem for mirroring. For this project we wrote [walterhpearce/crates-spider](https://github.com/walterhpearce/crates-spider.git)
- `cargo +nightly run -- compile-all -s cargo_sources -b cargo_bytecodes`
- `cargo +nightly run -- export-all-neo4j -s cargo_sources -b cargo_bytecodes -d 127.0.0.1:7687 -u neo4j -p changeme123` 

### Database 

Current `crates.io` graph snapshot: *Coming Soon*

Nodes:
- `(Version { name, version, major, minor, patch, build, pre })`
- `(Crate {name })`

Relationships:
- `(Version)-[:VERSION_OF]->(Crate)`
- `(Version)-[:DEPENDS_ON {requirement, features, kind, optional}]->(Crate)`
- `(Version)-[:INVOKES { caller, callee }]->(Crate)`

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
