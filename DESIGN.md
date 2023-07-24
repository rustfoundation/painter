# Overview

Painter is an implementation of methodologies to build a graph database of dependencies and invocations between all crates within the crates.io ecosystem.

## Index Importing
The index is imported leveraging the `crates-index` crate. We iterate all version of 
all crates in the index and their dependencies, building out the crate and version 
nodes and relationships within the database. Alternative methods are available in the 
POC directory where imports were done directly from the csv dump of the crates.io 
database. Regardless, this is meant to build out an initial graph representation of 
the entire crates.io ecosystem and mapping out all dependencies of all versions in 
all history.

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
- LTO and optimizers are disabled to prevent inlining, but many cases exist in which the invocation is lost at a bytecode level. Source analysis can improve this. Exmaples of cases where an invoke is likely lost:
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