//! This crate provides various analyses of LLVM IR, such as control-flow
//! graphs, dominator trees, control dependence graphs, etc.
//!
//! For a more thorough introduction to the crate and how to get started,
//! see the [crate's README](https://github.com/cdisselkoen/llvm-ir-analysis/blob/main/README.md).

mod call_graph;
mod control_dep_graph;
mod control_flow_graph;
mod dominator_tree;
mod functions_by_type;

pub use crate::call_graph::CallGraph;
pub use crate::control_dep_graph::ControlDependenceGraph;
pub use crate::control_flow_graph::{CFGNode, ControlFlowGraph};
pub use crate::dominator_tree::{DominatorTree, PostDominatorTree};
pub use crate::functions_by_type::FunctionsByType;
use llvm_ir::{Function, Module};
use log::debug;
use std::cell::{Ref, RefCell};
use std::collections::HashMap;

// Re-export the llvm-ir crate so that our consumers can have only one Cargo.toml entry and don't
// have to worry about matching versions.
pub use llvm_ir;

/// Computes (and caches the results of) various analyses on a given `Module`
pub struct ModuleAnalysis<'m> {
    /// Reference to the `llvm-ir` `Module`
    module: &'m Module,
    /// Call graph for the module
    call_graph: SimpleCache<CallGraph<'m>>,
    /// `FunctionsByType`, which allows you to iterate over the module's
    /// functions by type
    functions_by_type: SimpleCache<FunctionsByType<'m>>,
    /// Map from function name to the `FunctionAnalysis` for that function
    fn_analyses: HashMap<&'m str, FunctionAnalysis<'m>>,
}

impl<'m> ModuleAnalysis<'m> {
    /// Create a new `ModuleAnalysis` for the given `Module`.
    ///
    /// This method itself is cheap; individual analyses will be computed lazily
    /// on demand.
    pub fn new(module: &'m Module) -> Self {
        Self {
            module,
            call_graph: SimpleCache::new(),
            functions_by_type: SimpleCache::new(),
            fn_analyses: module
                .functions
                .iter()
                .map(|f| (f.name.as_str(), FunctionAnalysis::new(f)))
                .collect(),
        }
    }

    /// Get a reference to the `Module` which the `ModuleAnalysis` was created
    /// with.
    pub fn module(&self) -> &'m Module {
        self.module
    }

    /// Get the `CallGraph` for the `Module`.
    pub fn call_graph(&self) -> Ref<CallGraph<'m>> {
        self.call_graph.get_or_insert_with(|| {
            let functions_by_type = self.functions_by_type();
            debug!("computing single-module call graph");
            CallGraph::new(std::iter::once(self.module), &functions_by_type)
        })
    }

    /// Get the `FunctionsByType` for the `Module`.
    pub fn functions_by_type(&self) -> Ref<FunctionsByType<'m>> {
        self.functions_by_type.get_or_insert_with(|| {
            debug!("computing single-module functions-by-type");
            FunctionsByType::new(std::iter::once(self.module))
        })
    }

    /// Get the `FunctionAnalysis` for the function with the given name.
    ///
    /// Panics if no function of that name exists in the `Module` which the
    /// `ModuleAnalysis` was created with.
    pub fn fn_analysis<'s>(&'s self, func_name: &str) -> &'s FunctionAnalysis<'m> {
        self.fn_analyses
            .get(func_name)
            .unwrap_or_else(|| panic!("Function named {:?} not found in the Module", func_name))
    }
}

/// Analyzes multiple `Module`s, providing a `ModuleAnalysis` for each; and also
/// provides a few additional cross-module analyses (e.g., a cross-module call
/// graph)
pub struct CrossModuleAnalysis<'m> {
    /// Reference to the `llvm-ir` `Module`s
    modules: Vec<&'m Module>,
    /// Cross-module call graph
    call_graph: SimpleCache<CallGraph<'m>>,
    /// `FunctionsByType`, which allows you to iterate over functions by type
    functions_by_type: SimpleCache<FunctionsByType<'m>>,
    /// Map from module name to the `ModuleAnalysis` for that module
    module_analyses: HashMap<&'m str, ModuleAnalysis<'m>>,
}

impl<'m> CrossModuleAnalysis<'m> {
    /// Create a new `CrossModuleAnalysis` for the given set of `Module`s.
    ///
    /// This method itself is cheap; individual analyses will be computed lazily
    /// on demand.
    pub fn new(modules: impl IntoIterator<Item = &'m Module>) -> Self {
        let modules: Vec<&'m Module> = modules.into_iter().collect();
        let module_analyses = modules
            .iter()
            .copied()
            .map(|m| (m.name.as_str(), ModuleAnalysis::new(m)))
            .collect();
        Self {
            modules,
            call_graph: SimpleCache::new(),
            functions_by_type: SimpleCache::new(),
            module_analyses,
        }
    }

    /// Iterate over the analyzed `Module`(s).
    pub fn modules<'s>(&'s self) -> impl Iterator<Item = &'m Module> + 's {
        self.modules.iter().copied()
    }

    /// Iterate over all the `Function`s in the analyzed `Module`(s).
    pub fn functions<'s>(&'s self) -> impl Iterator<Item = &'m Function> + 's {
        self.modules().map(|m| m.functions.iter()).flatten()
    }

    /// Get the full `CallGraph` for the `Module`(s).
    ///
    /// This will include both cross-module and within-module calls.
    pub fn call_graph(&self) -> Ref<CallGraph<'m>> {
        self.call_graph.get_or_insert_with(|| {
            let functions_by_type = self.functions_by_type();
            debug!("computing multi-module call graph");
            CallGraph::new(self.modules(), &functions_by_type)
        })
    }

    /// Get the `FunctionsByType` for the `Module`(s).
    pub fn functions_by_type(&self) -> Ref<FunctionsByType<'m>> {
        self.functions_by_type.get_or_insert_with(|| {
            debug!("computing multi-module functions-by-type");
            FunctionsByType::new(self.modules())
        })
    }

    /// Get the `ModuleAnalysis` for the module with the given name.
    ///
    /// Panics if no module of that name exists in the `Module`(s) which the
    /// `CrossModuleAnalysis` was created with.
    pub fn module_analysis<'s>(&'s self, mod_name: &str) -> &'s ModuleAnalysis<'m> {
        self.module_analyses.get(mod_name).unwrap_or_else(|| {
            panic!(
                "Module named {:?} not found in the CrossModuleAnalysis",
                mod_name
            )
        })
    }

    /// Get the `Function` with the given name from the analyzed `Module`(s).
    ///
    /// Returns both the `Function` and the `Module` it was found in, or `None`
    /// if no function was found with that name.
    pub fn get_func_by_name(&self, func_name: &str) -> Option<(&'m Function, &'m Module)> {
        let mut retval = None;
        for &module in &self.modules {
            if let Some(func) = module.get_func_by_name(func_name) {
                match retval {
                    None => retval = Some((func, module)),
                    Some((_, retmod)) => panic!("Multiple functions found with name {:?}: one in module {:?}, another in module {:?}", func_name, &retmod.name, &module.name),
                }
            }
        }
        retval
    }
}

/// Computes (and caches the results of) various analyses on a given `Function`
pub struct FunctionAnalysis<'m> {
    /// Reference to the `llvm-ir` `Function`
    function: &'m Function,
    /// Control flow graph for the function
    control_flow_graph: SimpleCache<ControlFlowGraph<'m>>,
    /// Dominator tree for the function
    dominator_tree: SimpleCache<DominatorTree<'m>>,
    /// Postdominator tree for the function
    postdominator_tree: SimpleCache<PostDominatorTree<'m>>,
    /// Control dependence graph for the function
    control_dep_graph: SimpleCache<ControlDependenceGraph<'m>>,
}

impl<'m> FunctionAnalysis<'m> {
    /// Create a new `FunctionAnalysis` for the given `Function`.
    ///
    /// This method itself is cheap; individual analyses will be computed lazily
    /// on demand.
    pub fn new(function: &'m Function) -> Self {
        Self {
            function,
            control_flow_graph: SimpleCache::new(),
            dominator_tree: SimpleCache::new(),
            postdominator_tree: SimpleCache::new(),
            control_dep_graph: SimpleCache::new(),
        }
    }

    /// Get the `ControlFlowGraph` for the function.
    pub fn control_flow_graph(&self) -> Ref<ControlFlowGraph<'m>> {
        self.control_flow_graph.get_or_insert_with(|| {
            debug!("computing control flow graph for {}", &self.function.name);
            ControlFlowGraph::new(self.function)
        })
    }

    /// Get the `DominatorTree` for the function.
    pub fn dominator_tree(&self) -> Ref<DominatorTree<'m>> {
        self.dominator_tree.get_or_insert_with(|| {
            let cfg = self.control_flow_graph();
            debug!("computing dominator tree for {}", &self.function.name);
            DominatorTree::new(&cfg)
        })
    }

    /// Get the `PostDominatorTree` for the function.
    pub fn postdominator_tree(&self) -> Ref<PostDominatorTree<'m>> {
        self.postdominator_tree.get_or_insert_with(|| {
            let cfg = self.control_flow_graph();
            debug!("computing postdominator tree for {}", &self.function.name);
            PostDominatorTree::new(&cfg)
        })
    }

    /// Get the `ControlDependenceGraph` for the function.
    pub fn control_dependence_graph(&self) -> Ref<ControlDependenceGraph<'m>> {
        self.control_dep_graph.get_or_insert_with(|| {
            let cfg = self.control_flow_graph();
            let postdomtree = self.postdominator_tree();
            debug!(
                "computing control dependence graph for {}",
                &self.function.name
            );
            ControlDependenceGraph::new(&cfg, &postdomtree)
        })
    }
}

struct SimpleCache<T> {
    /// `None` if not computed yet
    data: RefCell<Option<T>>,
}

impl<T> SimpleCache<T> {
    fn new() -> Self {
        Self {
            data: RefCell::new(None),
        }
    }

    /// Get the cached value, or if no value is cached, compute the value using
    /// the given closure, then cache that result and return it
    fn get_or_insert_with(&self, f: impl FnOnce() -> T) -> Ref<T> {
        // borrow mutably only if it's empty. else don't even try to borrow mutably
        let need_mutable_borrow = self.data.borrow().is_none();
        if need_mutable_borrow {
            let old_val = self.data.borrow_mut().replace(f());
            debug_assert!(old_val.is_none());
        }
        // now, either way, it's populated, so we borrow immutably and return.
        // future users can also borrow immutably using this function (even
        // while this borrow is still outstanding), since it won't try to borrow
        // mutably in the future.
        Ref::map(self.data.borrow(), |o| {
            o.as_ref().expect("should be populated now")
        })
    }
}
