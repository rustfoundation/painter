use crate::control_flow_graph::{CFGNode, ControlFlowGraph};
use llvm_ir::Name;
use petgraph::prelude::{Dfs, DiGraphMap, Direction};
use petgraph::visit::Walker;
use std::cmp::Ordering;
use std::collections::HashMap;

/// The dominator tree for a particular function.
///
/// To construct a `DominatorTree`, use
/// [`FunctionAnalysis`](struct.FunctionAnalysis.html), which you can get
/// from [`ModuleAnalysis`](struct.ModuleAnalysis.html).
pub struct DominatorTree<'m> {
    /// The graph itself. An edge from bbX to bbY indicates that bbX is the
    /// immediate dominator of bbY.
    ///
    /// That is:
    ///   - bbX strictly dominates bbY, i.e., bbX appears on every control-flow
    ///     path from the entry block to bbY (but bbX =/= bbY)
    ///   - Of the blocks that strictly dominate bbY, bbX is the closest to bbY
    ///     (farthest from entry) along paths from the entry block to bbY
    pub(crate) graph: DiGraphMap<CFGNode<'m>, ()>,

    /// Entry node for the function
    pub(crate) entry_node: CFGNode<'m>,
}

/// The postdominator tree for a particular function.
///
/// To construct a `PostDominatorTree`, use
/// [`FunctionAnalysis`](struct.FunctionAnalysis.html), which you can get
/// from [`ModuleAnalysis`](struct.ModuleAnalysis.html).
pub struct PostDominatorTree<'m> {
    /// The graph itself. An edge from bbX to bbY indicates that bbX is the
    /// immediate postdominator of bbY.
    ///
    /// That is:
    ///   - bbX strictly postdominates bbY, i.e., bbX appears on every control-flow
    ///     path from bbY to the function exit (but bbX =/= bbY)
    ///   - Of the blocks that strictly postdominate bbY, bbX is the closest to bbY
    ///     (farthest from exit) along paths from bbY to the function exit
    pub(crate) graph: DiGraphMap<CFGNode<'m>, ()>,
}

/// Contains state used when constructing the `DominatorTree` or `PostDominatorTree`
struct DomTreeBuilder<'m, 'a> {
    /// The `ControlFlowGraph` we're working from
    cfg: &'a ControlFlowGraph<'m>,

    /// Map from `CFGNode` to its rpo number.
    ///
    /// Unreachable blocks won't be in this map; all reachable blocks will have
    /// positive rpo numbers.
    rpo_numbers: HashMap<CFGNode<'m>, usize>,

    /// Map from `CFGNode` to the current estimate for its immediate dominator
    /// (the entry node maps to `None`).
    ///
    /// Unreachable blocks won't be in this map.
    idoms: HashMap<CFGNode<'m>, Option<CFGNode<'m>>>,
}

impl<'m, 'a> DomTreeBuilder<'m, 'a> {
    /// Construct a new `DomTreeBuilder`.
    ///
    /// This will have no estimates for the immediate dominators.
    fn new(cfg: &'a ControlFlowGraph<'m>) -> Self {
        Self {
            cfg,
            rpo_numbers: Dfs::new(&cfg.graph, cfg.entry_node)
                .iter(&cfg.graph)
                .zip(1..)
                .collect(),
            idoms: HashMap::new(),
        }
    }

    /// Build the dominator tree
    fn build(mut self) -> DiGraphMap<CFGNode<'m>, ()> {
        // algorithm heavily inspired by the domtree algorithm in Cranelift,
        // which itself is Keith D. Cooper's "Simple, Fast, Dominator Algorithm"
        // according to comments in Cranelift's code.

        // first compute initial (preliminary) estimates for the immediate
        // dominator of each block
        for block in Dfs::new(&self.cfg.graph, self.cfg.entry_node).iter(&self.cfg.graph) {
            self.idoms.insert(block, self.compute_idom(block));
        }

        let mut changed = true;
        while changed {
            changed = false;
            for block in Dfs::new(&self.cfg.graph, self.cfg.entry_node).iter(&self.cfg.graph) {
                let idom = self.compute_idom(block);
                let prev_idom = self
                    .idoms
                    .get_mut(&block)
                    .expect("All nodes in the dfs should have an initialized idom by now");
                if idom != *prev_idom {
                    *prev_idom = idom;
                    changed = true;
                }
            }
        }

        DiGraphMap::from_edges(
            self.idoms
                .into_iter()
                .filter_map(|(block, idom)| Some((idom?, block))),
        )
    }

    /// Compute the immediate dominator for `block` using the current `idom`
    /// states for the nodes.
    ///
    /// `block` must be reachable in the CFG. Returns `None` only for the entry
    /// block.
    fn compute_idom(&self, block: CFGNode<'m>) -> Option<CFGNode<'m>> {
        if block == self.cfg.entry_node {
            return None;
        }
        // technically speaking, these are just the reachable preds which already have an idom estimate
        let mut reachable_preds = self
            .cfg
            .preds_as_nodes(block)
            .filter(|block| self.idoms.contains_key(block));

        let mut idom = reachable_preds
            .next()
            .expect("expected a reachable block to have at least one reachable predecessor");

        for pred in reachable_preds {
            idom = self.common_dominator(idom, pred);
        }

        Some(idom)
    }

    /// Compute the common dominator of two nodes.
    ///
    /// Both nodes are assumed to be reachable.
    fn common_dominator(&self, mut node_a: CFGNode<'m>, mut node_b: CFGNode<'m>) -> CFGNode<'m> {
        loop {
            match self.rpo_numbers[&node_a].cmp(&self.rpo_numbers[&node_b]) {
                Ordering::Less => {
                    node_b = self.idoms[&node_b]
                        .expect("entry node should have the smallest rpo number");
                }
                Ordering::Greater => {
                    node_a = self.idoms[&node_a]
                        .expect("entry node should have the smallest rpo number");
                }
                Ordering::Equal => break,
            }
        }

        node_a
    }
}

impl<'m> DominatorTree<'m> {
    pub(crate) fn new(cfg: &ControlFlowGraph<'m>) -> Self {
        Self {
            graph: DomTreeBuilder::new(cfg).build(),
            entry_node: cfg.entry_node,
        }
    }

    /// Get the immediate dominator of the basic block with the given `Name`.
    ///
    /// This will be `None` for the entry block or for any unreachable blocks,
    /// and `Some` for all other blocks.
    ///
    /// A block bbX is the immediate dominator of bbY if and only if:
    ///   - bbX strictly dominates bbY, i.e., bbX appears on every control-flow
    ///     path from the entry block to bbY (but bbX =/= bbY)
    ///   - Of the blocks that strictly dominate bbY, bbX is the closest to bbY
    ///     (farthest from entry) along paths from the entry block to bbY
    pub fn idom(&self, block: &'m Name) -> Option<&'m Name> {
        let mut parents = self
            .graph
            .neighbors_directed(CFGNode::Block(block), Direction::Incoming);
        let idom = parents.next()?;
        if let Some(_) = parents.next() {
            panic!("Block {:?} should have only one immediate dominator", block);
        }
        match idom {
            CFGNode::Block(block) => Some(block),
            CFGNode::Return => {
                panic!("Return node shouldn't be the immediate dominator of anything")
            }
        }
    }

    /// Get the immediate dominator of `CFGNode::Return`.
    ///
    /// This will be the block bbX such that:
    ///   - bbX strictly dominates `CFGNode::Return`, i.e., bbX appears on every
    ///     control-flow path through the function (but bbX =/= `CFGNode::Return`)
    ///   - Of the blocks that strictly dominate `CFGNode::Return`, bbX is the
    ///     closest to `CFGNode::Return` (farthest from entry) along paths through
    ///     the function
    ///
    /// If the return node is unreachable (e.g., due to an infinite loop in the
    /// function), then the return node has no immediate dominator, and `None` will
    /// be returned.
    pub fn idom_of_return(&self) -> Option<&'m Name> {
        let mut parents = self
            .graph
            .neighbors_directed(CFGNode::Return, Direction::Incoming);
        let idom = parents.next()?;
        if let Some(_) = parents.next() {
            panic!("Return node should have only one immediate dominator");
        }
        match idom {
            CFGNode::Block(block) => Some(block),
            CFGNode::Return => panic!("Return node shouldn't be its own immediate dominator"),
        }
    }

    /// Get the children of the given basic block in the dominator tree, i.e.,
    /// get all the blocks which are immediately dominated by `block`.
    ///
    /// See notes on `idom()`.
    pub fn children<'s>(&'s self, block: &'m Name) -> impl Iterator<Item = CFGNode<'m>> + 's {
        self.graph
            .neighbors_directed(CFGNode::Block(block), Direction::Outgoing)
    }

    /// Does `node_a` dominate `node_b`?
    ///
    /// Note that every node dominates itself by definition, so if
    /// `node_a == node_b`, this returns `true`.
    /// See also `strictly_dominates()`
    pub fn dominates(&self, node_a: CFGNode<'m>, node_b: CFGNode<'m>) -> bool {
        petgraph::algo::has_path_connecting(&self.graph, node_a, node_b, None)
    }

    /// Does `node_a` strictly dominate `node_b`?
    ///
    /// This is the same as `dominates()`, except that if
    /// `node_a == node_b`, this returns `false`.
    pub fn strictly_dominates(&self, node_a: CFGNode<'m>, node_b: CFGNode<'m>) -> bool {
        node_a != node_b && self.dominates(node_a, node_b)
    }

    /// Get the `Name` of the entry block for the function
    pub fn entry(&self) -> &'m Name {
        match self.entry_node {
            CFGNode::Block(block) => block,
            CFGNode::Return => panic!("Return node should not be entry"),
        }
    }
}

impl<'m> PostDominatorTree<'m> {
    pub(crate) fn new(cfg: &ControlFlowGraph<'m>) -> Self {
        // The postdominator relation for `cfg` is the dominator relation on
        // the reversed `cfg` (Cytron et al, p. 477)

        Self {
            graph: DomTreeBuilder::new(&cfg.reversed()).build(),
        }
    }

    /// Get the immediate postdominator of the basic block with the given `Name`.
    ///
    /// This will be `None` for unreachable blocks (or, in some cases, when the
    /// function return is unreachable, e.g. due to an infinite loop), and `Some`
    /// for all other blocks.
    ///
    /// A block bbX is the immediate postdominator of bbY if and only if:
    ///   - bbX strictly postdominates bbY, i.e., bbX appears on every control-flow
    ///     path from bbY to the function exit (but bbX =/= bbY)
    ///   - Of the blocks that strictly postdominate bbY, bbX is the closest to bbY
    ///     (farthest from exit) along paths from bbY to the function exit
    ///
    /// If the immediate postdominator is `CFGNode::Return`, that indicates that
    /// there is no single basic block that postdominates the given block.
    pub fn ipostdom(&self, block: &'m Name) -> Option<CFGNode<'m>> {
        self.ipostdom_of_cfgnode(CFGNode::Block(block))
    }

    /// See notes on `ipostdom()`, but in addition, this will be `None` for
    /// `CFGNode::Return`
    pub(crate) fn ipostdom_of_cfgnode(&self, node: CFGNode<'m>) -> Option<CFGNode<'m>> {
        let mut parents = self.graph.neighbors_directed(node, Direction::Incoming);
        let ipostdom = parents.next()?;
        if let Some(_) = parents.next() {
            panic!(
                "Block {:?} should have only one immediate postdominator",
                node
            );
        }
        Some(ipostdom)
    }

    /// Get the children of the given basic block in the postdominator tree, i.e.,
    /// get all the blocks which are immediately postdominated by `block`.
    ///
    /// See notes on `ipostdom()`.
    pub fn children<'s>(&'s self, block: &'m Name) -> impl Iterator<Item = CFGNode<'m>> + 's {
        self.children_of_cfgnode(CFGNode::Block(block))
    }

    pub(crate) fn children_of_cfgnode<'s>(
        &'s self,
        node: CFGNode<'m>,
    ) -> impl Iterator<Item = CFGNode<'m>> + 's {
        self.graph.neighbors_directed(node, Direction::Outgoing)
    }

    /// Get the children of `CFGNode::Return` in the postdominator tree, i.e.,
    /// get all the blocks which are immediately postdominated by `CFGNode::Return`.
    ///
    /// See notes on `ipostdom()`.
    pub fn children_of_return<'s>(&'s self) -> impl Iterator<Item = &'m Name> + 's {
        self.graph
            .neighbors_directed(CFGNode::Return, Direction::Outgoing)
            .map(|child| match child {
                CFGNode::Block(block) => block,
                CFGNode::Return => {
                    panic!("Return node shouldn't be the immediate postdominator of itself")
                }
            })
    }

    /// Does `node_a` postdominate `node_b`?
    ///
    /// Note that every node postdominates itself by definition, so if
    /// `node_a == node_b`, this returns `true`.
    /// See also `strictly_postdominates()`
    pub fn postdominates(&self, node_a: CFGNode<'m>, node_b: CFGNode<'m>) -> bool {
        petgraph::algo::has_path_connecting(&self.graph, node_a, node_b, None)
    }

    /// Does `node_a` strictly postdominate `node_b`?
    ///
    /// This is the same as `postdominates()`, except that if
    /// `node_a == node_b`, this returns `false`.
    pub fn strictly_postdominates(&self, node_a: CFGNode<'m>, node_b: CFGNode<'m>) -> bool {
        node_a != node_b && self.postdominates(node_a, node_b)
    }
}
