# Painter
Library and tools for managing ecosystem wide call graphs and llvm-ir analysis

Deatils of the design can be found in [DESIGN.md](DESIGN.md)

# Quick Start

*Note: Updating the database is not currently supported. To update, a fresh instance and analysis needs to be done.*

## Start the docker neo4j instance
A docker-compose is available for a default Neo4j instance that can be used for testing and local use. 
Note or change the default testing username/password.
- `docker compose -f docker/docker-compose.yml up`

## Populating the crate index database
The first step is populating your neo4j database with the up-to-date crate index. This is pulled from the live
crate index and populates the appropriate nodes and relationships. Crates, versions and dependency relationships 
are populated at this step.
- `cargo run create-fresh-db -s 127.0.0.1:7687 -u neo4j -p changeme123!@#`

## Run the analysis
This will populate the database with all invocation relationships. These exist as a representation of a given 
version calling a given crate. We cannot definitively say what version of what crate is invoked, so the node relationshp
exists at `(Version)-[INVOKES]->(Crate)`
- Extract all crate files to a working folder, where names are {crate}-{version}
- `cargo run -s cargo_sources -b cargo_bytecodes compile-all`
- `cargo run -s cargo_sources -b cargo_bytecodes export-all-neo4j -s 127.0.0.1:7687 -u neo4j -p changeme123!@#` 

### Database Representation

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

Rust is primarily distributed under the terms of both the MIT license and the
Apache License (Version 2.0), with documentation portions covered by the
Creative Commons Attribution 4.0 International license..

See [LICENSE-APACHE](LICENSE-APACHE), [LICENSE-MIT](LICENSE-MIT), 
[LICENSE-documentation](LICENSE-documentation), and 
[COPYRIGHT](COPYRIGHT) for details.

You can also read more under the Foundation's [intellectual property policy][ip-policy].

## Trademark

[The Rust Foundation][rust-foundation] owns and protects the Rust and Cargo
trademarks and logos (the "Rust Trademarks").

If you want to use these names or brands, please read the
[media guide][media-guide].

## Access to this repo

Until the code is made public, access to this repo should be limited to those 
participating in the Rust Foundation's security initaitive. Please contact
@walterhpearce to request access.

## Other Policies

You can read about other Rust Fondation policies in the footer of the Foundation [website][foundation-website].

[rust-foundation]: https://foundation.rust-lang.org/
[media-guide]: https://foundation.rust-lang.org/policies/logo-policy-and-media-guide/
[ip-policy]: https://foundation.rust-lang.org/policies/intellectual-property-policy/
[foundation-website]: https://foundation.rust-lang.org
[code-of-conduct]: https://foundation.rust-lang.org/policies/code-of-conduct/
