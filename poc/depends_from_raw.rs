use super::CrateCollection;
use petgraph::Graph;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DependsError {
    #[error("{0}")]
    IoError(#[from] std::io::Error),
    #[error("{0}")]
    TomlError(#[from] toml::de::Error),
    #[error("ManifestError")]
    ManifestError,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CrateNode {
    name: String,
    version: String,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum DependType {
    Build,
    Runtime,
    Dev,
}

#[derive(Debug, PartialEq, Eq, Hash)]
pub struct DependsEdge {
    ty: DependType,
}

pub type DependsGraph = petgraph::Graph<CrateNode, DependsEdge>;

fn from_manifest<P: AsRef<Path>>(toml: P) -> Result<Vec<(CrateNode, DependType)>, DependsError> {
    fn import_depends_from_table(
        depends: &mut Vec<(CrateNode, DependType)>,
        table: &toml::Table,
        ty: DependType,
    ) -> Result<usize, DependsError> {
        let mut count = 0;

        for (name, inner) in table.iter() {
            let version = if let Some(version) = inner.as_str() {
                version
            } else {
                inner
                    .as_table()
                    .ok_or(DependsError::ManifestError)?
                    .get("version")
                    .ok_or(DependsError::ManifestError)?
                    .as_str()
                    .ok_or(DependsError::ManifestError)?
            };

            depends.push((
                CrateNode {
                    name: name.clone(),
                    version: version.to_string(),
                },
                ty,
            ));
            count += 1;
        }

        Ok(count)
    }

    let mut depends = vec![];

    let raw_toml = std::fs::read_to_string(toml)?;
    let manifest: toml::Table = toml::from_str(&raw_toml)?;

    if let Some(runtime_depends) = manifest.get("dependencies") {
        let table = runtime_depends
            .as_table()
            .ok_or(DependsError::ManifestError)?;

        import_depends_from_table(&mut depends, &table, DependType::Runtime)?;
    }

    if let Some(dev_depends) = manifest.get("dev-dependencies") {
        let table = dev_depends.as_table().ok_or(DependsError::ManifestError)?;

        import_depends_from_table(&mut depends, &table, DependType::Dev)?;
    }

    if let Some(build_depends) = manifest.get("build-dependencies") {
        let table = build_depends
            .as_table()
            .ok_or(DependsError::ManifestError)?;

        import_depends_from_table(&mut depends, &table, DependType::Build)?;
    }

    Ok(depends)
}

pub fn build_depends_graph<'a>(sources: &'a CrateCollection) -> Result<DependsGraph, DependsError> {
    use petgraph::graph::{EdgeIndex, NodeIndex};

    let mut nodes = HashSet::<CrateNode>::new();
    let mut edges = HashMap::<CrateNode, Vec<(CrateNode, DependType)>>::new();

    for (_, info) in sources {
        let node = CrateNode {
            name: info.name.clone(),
            version: info.version.clone(),
        };
        nodes.insert(node.clone());

        match from_manifest(info.path.join("Cargo.toml")) {
            Ok(depends) => {
                for (dnode, ty) in depends {
                    nodes.insert(dnode.clone());
                    edges.entry(node.clone()).or_default().push((dnode, ty));
                }
            }
            Err(err) => println!("Failed depends on {}", info.path.display()),
        }
    }

    fn calculate_hash<T: std::hash::Hash>(t: &T) -> u64 {
        use std::hash::Hasher;

        let mut s = std::collections::hash_map::DefaultHasher::new();
        t.hash(&mut s);
        s.finish()
    }

    let mut graph = DependsGraph::new();
    let mut existing_nodes: HashMap<u64, NodeIndex> = HashMap::new();

    fn get_or_insert(
        node: &CrateNode,
        graph: &mut DependsGraph,
        existing_nodes: &mut HashMap<u64, NodeIndex>,
    ) -> NodeIndex {
        if let Some(idx) = existing_nodes.get(&calculate_hash(node)) {
            *idx
        } else {
            let idx = graph.add_node(node.clone());
            existing_nodes.insert(calculate_hash(node), idx);
            idx
        }
    }

    nodes.iter().for_each(|node| {
        let node_idx = get_or_insert(node, &mut graph, &mut existing_nodes);
        if let Some(edges) = edges.get(node) {
            edges.iter().for_each(|(target, ty)| {
                let target_idx = get_or_insert(target, &mut graph, &mut existing_nodes);
                graph.add_edge(node_idx, target_idx, DependsEdge { ty: *ty });
            });
        }
    });

    Ok(graph)
}

pub fn to_json<'a>(sources: &'a CrateCollection) -> Result<(), DependsError> {
    use rayon::prelude::*;

    //(CrateSource, Vec<(CrateNode, DependType)>)
    let all: HashMap<_, _> = sources
        .par_iter()
        .filter_map(|(name, info)| {
            from_manifest(info.path.join("Cargo.toml")).ok().map(|v| {
                (
                    CrateNode {
                        name: info.name.clone(),
                        version: info.version.clone(),
                    },
                    v,
                )
            })
        })
        .collect();

    let mut nodes = HashSet::new();
    let mut edges = HashSet::new();
    all.iter().for_each(|(src, depends)| {
        nodes.insert(src.clone());
        depends.iter().for_each(|(target, ty)| {
            nodes.insert(target.clone());
            edges.insert((src, target, ty));
        });
    });

    let json_nodes: Vec<_> = nodes
        .par_iter()
        .map(|node| {
            json::object! {
                ty: "crate",
                name: node.name.clone(),
                version: node.version.clone(),
            }
        })
        .collect();

    let json_edges: Vec<_> = edges
        .par_iter()
        .map(|edge| {
            json::object! {
                ty: "depends",
                src: {
                    name: edge.0.name.clone(),
                    version: edge.0.version.clone(),
                },
            s    dst: {
                    name: edge.1.name.clone(),
                    version: edge.0.version.clone(),
                }
            }
        })
        .collect();

    std::fs::write(
        crate_bc_dir.join("/tmp/nodes.json"),
        json::stringify_pretty(json_nodes, 4),
    );
    std::fs::write(
        crate_bc_dir.join("/tmp/edges.json"),
        json::stringify_pretty(json_edges, 4),
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::get_crate_sources;

    #[test]
    fn test_json() {
        let sources = get_crate_sources(&Path::new("/tmp/cargo_sources")).unwrap();
        //let limited = sources.into_iter().take(100).collect();
        to_json(&sources).unwrap();
    }

    #[ignore]
    #[test]
    fn one() {
        let sources = get_crate_sources(&Path::new("/tmp/cargo_sources")).unwrap();
        let sources = sources.into_iter().take(100).collect();
        let graph = build_depends_graph(&sources).unwrap();
    }
}
