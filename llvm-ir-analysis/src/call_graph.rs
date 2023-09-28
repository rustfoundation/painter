use crate::functions_by_type::FunctionsByType;
use either::Either;
use llvm_ir::{
    instruction::{Call, InlineAssembly},
    terminator::Invoke,
    Constant, Instruction, Module, Operand, Terminator, TypeRef,
};
use petgraph::prelude::*;

/// The call graph for the analyzed `Module`(s): which functions may call which
/// other functions.
///
/// To construct a `CallGraph`, use [`ModuleAnalysis`](struct.ModuleAnalysis.html)
/// or [`CrossModuleAnalysis`](struct.CrossModuleAnalysis.html).
pub struct CallGraph<'m> {
    /// the call graph itself. Nodes are function names, and an edge from F to G
    /// indicates F may call G
    graph: DiGraphMap<&'m str, ()>,
}

impl<'m> CallGraph<'m> {
    pub(crate) fn new(
        modules: impl IntoIterator<Item = &'m Module>,
        functions_by_type: &FunctionsByType<'m>,
    ) -> Self {
        let mut graph: DiGraphMap<&'m str, ()> = DiGraphMap::new();

        let add_edge_for_call = |graph: &mut DiGraphMap<_, _>,
                                 caller: &'m str,
                                 call: CallOrInvoke<'m>| {
            match call.callee() {
                Either::Right(Operand::ConstantOperand(cref)) => {
                    match cref.as_ref() {
                        Constant::GlobalReference { name, .. } => {
                            graph.add_edge(caller, name, ());
                        }
                        _ => {
                            // a constant function pointer.
                            // Assume that this function pointer could point
                            // to any function in the current module that has
                            // the appropriate type
                            for target in functions_by_type.functions_with_type(&call.callee_ty()) {
                                graph.add_edge(caller, target, ());
                            }
                        }
                    }
                }
                Either::Right(_) => {
                    // Assume that this function pointer could point to any
                    // function in the current module that has the
                    // appropriate type
                    for target in functions_by_type.functions_with_type(&call.callee_ty()) {
                        graph.add_edge(caller, target, ());
                    }
                }
                Either::Left(_) => {} // ignore calls to inline assembly
            }
        };

        // Find all call (and Invoke) instructions and add the appropriate edges
        for module in modules {
            for f in &module.functions {
                graph.add_node(&f.name); // just to ensure all functions end up getting nodes in the graph by the end
                for bb in &f.basic_blocks {
                    for inst in &bb.instrs {
                        if let Instruction::Call(call) = inst {
                            add_edge_for_call(
                                &mut graph,
                                &f.name,
                                CallOrInvoke::Call { call, module },
                            );
                        }
                    }
                    if let Terminator::Invoke(invoke) = &bb.term {
                        add_edge_for_call(
                            &mut graph,
                            &f.name,
                            CallOrInvoke::Invoke { invoke, module },
                        );
                    }
                }
            }
        }

        Self { graph }
    }

    /// Get the names of functions in the analyzed `Module`(s) which may call the
    /// given function.
    ///
    /// This analysis conservatively assumes that function pointers may point to
    /// any function in the analyzed `Module`(s) that has the appropriate type.
    ///
    /// Panics if the given function is not found in the analyzed `Module`(s).
    pub fn callers<'s>(&'s self, func_name: &'m str) -> impl Iterator<Item = &'m str> + 's {
        if !self.graph.contains_node(func_name) {
            panic!(
                "callers(): function named {:?} not found in the Module(s)",
                func_name
            )
        }
        self.graph
            .neighbors_directed(func_name, Direction::Incoming)
    }

    /// Get the names of functions in the analyzed `Module`(s) which may be
    /// called by the given function.
    ///
    /// This analysis conservatively assumes that function pointers may point to
    /// any function in the analyzed `Module`(s) that has the appropriate type.
    ///
    /// Panics if the given function is not found in the analyzed `Module`(s).
    pub fn callees<'s>(&'s self, func_name: &'m str) -> impl Iterator<Item = &'m str> + 's {
        if !self.graph.contains_node(func_name) {
            panic!(
                "callees(): function named {:?} not found in the Module(s)",
                func_name
            )
        }
        self.graph
            .neighbors_directed(func_name, Direction::Outgoing)
    }

    pub fn inner(&self) -> &DiGraphMap<&'m str, ()> {
        &self.graph
    }
}

enum CallOrInvoke<'a> {
    Call {
        #[cfg_attr(feature = "llvm-15-or-greater", allow(dead_code))]
        module: &'a Module,
        call: &'a Call,
    },
    Invoke {
        #[cfg_attr(feature = "llvm-15-or-greater", allow(dead_code))]
        module: &'a Module,
        invoke: &'a Invoke,
    },
}

impl<'a> CallOrInvoke<'a> {
    #[cfg(feature = "llvm-14-or-lower")]
    fn module(&self) -> &'a Module {
        match self {
            Self::Call { module, .. } => module,
            Self::Invoke { module, .. } => module,
        }
    }

    fn callee(&self) -> &'a Either<InlineAssembly, Operand> {
        match self {
            Self::Call { call, .. } => &call.function,
            Self::Invoke { invoke, .. } => &invoke.function,
        }
    }

    fn callee_ty(&self) -> TypeRef {
        #[cfg(feature = "llvm-14-or-lower")]
        match self.module().type_of(self.callee()).as_ref() {
            llvm_ir::Type::PointerType { pointee_type, .. } => pointee_type.clone(),
            ty => panic!(
                "Expected function pointer to have pointer type, but got {:?}",
                ty
            ),
        }
        #[cfg(feature = "llvm-15-or-greater")]
        match self {
            Self::Call { call, .. } => call.function_ty.clone(),
            Self::Invoke { invoke, .. } => invoke.function_ty.clone(),
        }
    }
}
