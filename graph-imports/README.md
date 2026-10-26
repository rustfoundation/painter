# graph-imports

Legacy `neo4j-admin import` CSVs from the crates.io Postgres dump. They use an older schema
(`CrateVersion` label), not the one painter writes.

- `cargo install xsv`
- `graph-imports/transform_cratesio_db.sh`
- `graph-imports/bc_merge.sh cargo_bytecodes cargo_bytecodes/calls.csv`
