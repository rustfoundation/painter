use llvm_ir::{Function, Name, Terminator};
use petgraph::prelude::{DiGraphMap, Direction};
use std::fmt;

/// The control flow graph for a particular function.
///
/// To construct a `ControlFlowGraph`, use
/// [`FunctionAnalysis`](struct.FunctionAnalysis.html), which you can get
/// from [`ModuleAnalysis`](struct.ModuleAnalysis.html).
pub struct ControlFlowGraph<'m> {
    /// The graph itself. Nodes are basic block names, and an edge from bbX to
    /// bbY indicates that control may (immediately) flow from bbX to bbY
    ///
    /// Or, an edge from bbX to `Return` indicates that the function may return
    /// from bbX
    pub(crate) graph: DiGraphMap<CFGNode<'m>, ()>,

    /// Entry node for the function
    pub(crate) entry_node: CFGNode<'m>,
}

/// A CFGNode represents a basic block, or the special node `Return`
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Hash)]
pub enum CFGNode<'m> {
    /// The block with the given `Name`
    Block(&'m Name),
    /// The special `Return` node indicating function return
    Return,
}

impl<'m> fmt::Display for CFGNode<'m> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            CFGNode::Block(block) => write!(f, "{}", block),
            CFGNode::Return => write!(f, "Return"),
        }
    }
}

impl<'m> ControlFlowGraph<'m> {
    pub(crate) fn new(function: &'m Function) -> Self {
        let mut graph: DiGraphMap<CFGNode<'m>, ()> = DiGraphMap::with_capacity(
            function.basic_blocks.len() + 1,
            2 * function.basic_blocks.len(), // arbitrary guess
        );

        for bb in &function.basic_blocks {
            match &bb.term {
                Terminator::Br(br) => {
                    graph.add_edge(CFGNode::Block(&bb.name), CFGNode::Block(&br.dest), ());
                }
                Terminator::CondBr(condbr) => {
                    graph.add_edge(
                        CFGNode::Block(&bb.name),
                        CFGNode::Block(&condbr.true_dest),
                        (),
                    );
                    graph.add_edge(
                        CFGNode::Block(&bb.name),
                        CFGNode::Block(&condbr.false_dest),
                        (),
                    );
                }
                Terminator::IndirectBr(ibr) => {
                    for dest in &ibr.possible_dests {
                        graph.add_edge(CFGNode::Block(&bb.name), CFGNode::Block(dest), ());
                    }
                }
                Terminator::Switch(switch) => {
                    graph.add_edge(
                        CFGNode::Block(&bb.name),
                        CFGNode::Block(&switch.default_dest),
                        (),
                    );
                    for (_, dest) in &switch.dests {
                        graph.add_edge(CFGNode::Block(&bb.name), CFGNode::Block(dest), ());
                    }
                }
                Terminator::Ret(_) | Terminator::Resume(_) => {
                    graph.add_edge(CFGNode::Block(&bb.name), CFGNode::Return, ());
                }
                Terminator::Invoke(invoke) => {
                    graph.add_edge(
                        CFGNode::Block(&bb.name),
                        CFGNode::Block(&invoke.return_label),
                        (),
                    );
                    graph.add_edge(
                        CFGNode::Block(&bb.name),
                        CFGNode::Block(&invoke.exception_label),
                        (),
                    );
                }
                Terminator::CleanupRet(cleanupret) => {
                    if let Some(dest) = &cleanupret.unwind_dest {
                        graph.add_edge(CFGNode::Block(&bb.name), CFGNode::Block(dest), ());
                    } else {
                        graph.add_edge(CFGNode::Block(&bb.name), CFGNode::Return, ());
                    }
                }
                Terminator::CatchRet(catchret) => {
                    // Despite its name, my reading of the LLVM 10 LangRef indicates that CatchRet cannot directly return from the function
                    graph.add_edge(
                        CFGNode::Block(&bb.name),
                        CFGNode::Block(&catchret.successor),
                        (),
                    );
                }
                Terminator::CatchSwitch(catchswitch) => {
                    if let Some(dest) = &catchswitch.default_unwind_dest {
                        graph.add_edge(CFGNode::Block(&bb.name), CFGNode::Block(dest), ());
                    } else {
                        graph.add_edge(CFGNode::Block(&bb.name), CFGNode::Return, ());
                    }
                    for handler in &catchswitch.catch_handlers {
                        graph.add_edge(CFGNode::Block(&bb.name), CFGNode::Block(handler), ());
                    }
                }
                #[cfg(not(feature = "llvm-8"))]
                Terminator::CallBr(_) => unimplemented!("CallBr instruction"),
                Terminator::Unreachable(_) => {
                    // no successors
                }
            }
        }

        Self {
            graph,
            entry_node: CFGNode::Block(&function.basic_blocks[0].name),
        }
    }

    /// Get the predecessors of the basic block with the given `Name`
    pub fn preds<'s>(&'s self, block: &'m Name) -> impl Iterator<Item = &'m Name> + 's {
        self.preds_of_cfgnode(CFGNode::Block(block))
    }

    /// Get the predecessors of the special `Return` node, i.e., get all blocks
    /// which may directly return
    pub fn preds_of_return<'s>(&'s self) -> impl Iterator<Item = &'m Name> + 's {
        self.preds_of_cfgnode(CFGNode::Return)
    }

    pub(crate) fn preds_of_cfgnode<'s>(
        &'s self,
        node: CFGNode<'m>,
    ) -> impl Iterator<Item = &'m Name> + 's {
        self.preds_as_nodes(node).map(|cfgnode| match cfgnode {
            CFGNode::Block(block) => block,
            CFGNode::Return => panic!("Shouldn't have CFGNode::Return as a predecessor"), // perhaps you tried to call this on a reversed CFG? In-crate users can use `preds_as_nodes()` if they need to account for the possibility of a reversed CFG
        })
    }

    pub(crate) fn preds_as_nodes<'s>(
        &'s self,
        node: CFGNode<'m>,
    ) -> impl Iterator<Item = CFGNode<'m>> + 's {
        self.graph.neighbors_directed(node, Direction::Incoming)
    }

    /// Get the successors of the basic block with the given `Name`.
    /// Here, `CFGNode::Return` indicates that the function may directly return
    /// from this basic block.
    pub fn succs<'s>(&'s self, block: &'m Name) -> impl Iterator<Item = CFGNode<'m>> + 's {
        self.graph
            .neighbors_directed(CFGNode::Block(block), Direction::Outgoing)
    }

    /// Get the `Name` of the entry block for the function
    pub fn entry(&self) -> &'m Name {
        match self.entry_node {
            CFGNode::Block(block) => block,
            CFGNode::Return => panic!("Return node should not be entry"), // perhaps you tried to call this on a reversed CFG? In-crate users can use the `entry_node` field directly if they need to account for the possibility of a reversed CFG
        }
    }

    /// Get the reversed CFG; i.e., the CFG where all edges have been reversed
    pub(crate) fn reversed(&self) -> Self {
        Self {
            graph: DiGraphMap::from_edges(self.graph.all_edges().map(|(a, b, _)| (b, a, ()))),
            entry_node: CFGNode::Return,
        }
    }
}
