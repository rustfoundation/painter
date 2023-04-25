// opt -enable-new-pm=0 -dot-callgraph
// cargo rustc --release -- -g --emit=llvm-bc

use llvm_ir::Module;
use llvm_ir_analysis::ModuleAnalysis;
use rustc_demangle::demangle;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum PainterError {
    #[error("{0}")]
    IoError(#[from] std::io::Error),
    #[error("{0}")]
    DotParseError(String),
    #[error("UnsupportedDotFile")]
    UnsupportedDotFile,
    #[error("GraphConstructionError")]
    GraphConstructionError,
    #[error("{0}")]
    LLVMError(String),
}

pub type CallGraph = petgraph::Graph<String, ()>;

pub fn from_dot_file<P: AsRef<std::path::Path>>(path: P) -> Result<CallGraph, PainterError> {
    from_dot_str(&std::fs::read_to_string(path.as_ref())?)
}

pub fn from_dot_str(dot_str: &str) -> Result<CallGraph, PainterError> {
    let raw = graphviz_rust::parse(&dot_str).map_err(|e| PainterError::DotParseError(e))?;

    let mut graph: petgraph::Graph<String, ()> = petgraph::Graph::new();

    match raw {
        dot_structures::Graph::DiGraph {
            id: _,
            strict: _,
            stmts,
        } => {
            let mut nodes = HashMap::new();
            let mut edges = Vec::new();

            stmts.iter().for_each(|stmt| match stmt {
                dot_structures::Stmt::Node(node) => {
                    let name = node
                        .attributes
                        .iter()
                        .find_map(|attr| {
                            if let dot_structures::Id::Plain(aname) = &attr.0 {
                                if aname == "label" {
                                    if let dot_structures::Id::Escaped(escaped_name) = &attr.1 {
                                        let mut str = escaped_name.clone();
                                        str.remove_matches("\"{");
                                        str.remove_matches("}\"");
                                        return Some(format!("{:#}", demangle(&str)));
                                    }
                                }
                            }
                            None
                        })
                        .unwrap();

                    if let dot_structures::Id::Plain(id) = &node.id.0 {
                        let _ = nodes
                            .entry(id.clone())
                            .or_insert(graph.add_node(name.clone()));
                    }
                }
                dot_structures::Stmt::Edge(edge) => {
                    if let dot_structures::EdgeTy::Pair(a, b) = &edge.ty {
                        if let dot_structures::Vertex::N(a) = a {
                            if let dot_structures::Id::Plain(a) = &a.0 {
                                if let dot_structures::Vertex::N(b) = b {
                                    if let dot_structures::Id::Plain(b) = &b.0 {
                                        edges.push((a.clone(), b.clone()));
                                    }
                                }
                            }
                        }
                    }
                }

                _ => {}
            });

            for (a, b) in edges.iter() {
                let a_node = nodes.get(a).ok_or(PainterError::GraphConstructionError)?;
                let b_node = nodes.get(b).ok_or(PainterError::GraphConstructionError)?;
                graph.add_edge(*a_node, *b_node, ());
            }
        }
        _ => return Err(PainterError::UnsupportedDotFile),
    }

    Ok(graph)
}

pub fn from_bc<P: AsRef<std::path::Path>>(path: P) -> Result<CallGraph, PainterError> {
    let module = Module::from_bc_path(path.as_ref()).map_err(|s| PainterError::LLVMError(s))?;
    let analysis = ModuleAnalysis::new(&module);
    let graph = analysis.call_graph();

    let mut outgraph: petgraph::Graph<String, ()> = petgraph::Graph::new();
    let mut nodes = HashMap::new();

    graph.inner().nodes().for_each(|node| {
        nodes.insert(node.to_string(), outgraph.add_node(node.to_string()));
    });
    graph.inner().all_edges().for_each(|(src, dst, _)| {
        outgraph.add_edge(nodes[src], nodes[dst], ());
    });

    Ok(outgraph)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn simple_bc_graph() -> Result<(), PainterError> {
        use std::path::PathBuf;

        let graph = from_bc(PathBuf::from("test_data/simple_test-e469d082548e660f.bc"))?;

        Ok(())
    }

    #[test]
    fn serde_dot_callgraph() {
        use std::path::PathBuf;

        let dot_files = vec![PathBuf::from(
            "test_data/serde-076a07fe30dd676e.bc.callgraph.dot",
        )];

        for dot in &dot_files {
            let dot_str = std::fs::read_to_string(dot).unwrap();
            if let Ok(graph) = from_dot_str(&dot_str) {
                println!("Parsed {}", dot.display());
                graph.node_indices().for_each(|idx| {
                    println!("{}", graph[idx]);
                    graph.neighbors(idx).for_each(|nidx| {
                        println!("\t->{}", graph[nidx]);
                    });
                });
            } else {
                println!("Failed to parse {}", dot.display());
            }
        }
    }

    #[test]
    fn simple_test_dot_callgraph() {
        let dot_str =
            std::fs::read_to_string("test_data/simple_test-e181c865fbe6d4dd.ll.callgraph.dot")
                .unwrap();
        let graph = from_dot_str(&dot_str).unwrap();

        graph.node_indices().for_each(|idx| {
            if graph[idx] == "simple_test::main" {
                graph.neighbors(idx).for_each(|nidx| {
                    println!("main calls {}", graph[nidx]);
                });
            }
        });
    }

    #[test]
    fn llvm_ir_bc_read_simple_test() {
        let module = Module::from_bc_path("test_data/simple_test-e469d082548e660f.bc").unwrap();

        let analysis = ModuleAnalysis::new(&module);

        analysis.module().functions.iter().for_each(|f| {
            println!("{}={}", f.name, demangle(&f.name));
        });

        let graph = analysis.call_graph();
        graph
            .callers("_ZN11simple_test4main17hde4272ed2c35acb3E")
            .for_each(|fname| {
                println!("main is called by: {}={:#}", fname, demangle(&fname));
            });

        graph
            .callees("_ZN11simple_test4main17hde4272ed2c35acb3E")
            .for_each(|fname| {
                println!("calls {}={:#}", fname, demangle(&fname));
            });
    }
}
