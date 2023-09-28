use itertools::Itertools;
use llvm_ir::Module;
use llvm_ir_analysis::*;

fn init_logging() {
    // capture log messages with test harness
    let _ = env_logger::builder().is_test(true).try_init();
}

/// call.c / call.bc, functionptr.c / functionptr.bc, and crossmod.c /
/// crossmod.bc are all taken from [`haybale`]'s test suite
///
/// [`haybale`]: https://crates.io/crates/haybale
const CALL_BC_PATH: &'static str = "tests/bcfiles/call.bc";
const FUNCTIONPTR_BC_PATH: &'static str = "tests/bcfiles/functionptr.bc";
const CROSSMOD_BC_PATH: &'static str = "tests/bcfiles/crossmod.bc";

#[test]
fn call_graph() {
    init_logging();
    let module = Module::from_bc_path(CALL_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let callgraph = analysis.call_graph();

    let callers: Vec<&str> = callgraph.callers("simple_callee").sorted().collect();
    assert_eq!(
        callers,
        vec![
            "caller_with_loop",
            "conditional_caller",
            "recursive_and_normal_caller",
            "simple_caller",
            "twice_caller",
        ]
    );
    let callees: Vec<&str> = callgraph.callees("simple_callee").sorted().collect();
    assert!(callees.is_empty());

    let callers: Vec<&str> = callgraph.callers("simple_caller").sorted().collect();
    assert_eq!(callers, vec!["nested_caller"]);
    let callees: Vec<&str> = callgraph.callees("simple_caller").sorted().collect();
    assert_eq!(callees, vec!["simple_callee"]);

    let callers: Vec<&str> = callgraph.callers("conditional_caller").sorted().collect();
    assert!(callers.is_empty());
    let callees: Vec<&str> = callgraph.callees("conditional_caller").sorted().collect();
    assert_eq!(callees, vec!["simple_callee"]);

    let callers: Vec<&str> = callgraph.callers("twice_caller").sorted().collect();
    assert!(callers.is_empty());
    let callees: Vec<&str> = callgraph.callees("twice_caller").sorted().collect();
    assert_eq!(callees, vec!["simple_callee"]);

    let callers: Vec<&str> = callgraph.callers("nested_caller").sorted().collect();
    assert!(callers.is_empty());
    let callees: Vec<&str> = callgraph.callees("nested_caller").sorted().collect();
    assert_eq!(callees, vec!["simple_caller"]);

    let callers: Vec<&str> = callgraph.callers("callee_with_loop").sorted().collect();
    assert_eq!(callers, vec!["caller_of_loop"]);
    let callees: Vec<&str> = callgraph.callees("callee_with_loop").sorted().collect();
    assert_eq!(
        callees,
        vec!["llvm.lifetime.end.p0i8", "llvm.lifetime.start.p0i8"]
    );

    let callers: Vec<&str> = callgraph.callers("caller_of_loop").sorted().collect();
    assert!(callers.is_empty());
    let callees: Vec<&str> = callgraph.callees("caller_of_loop").sorted().collect();
    assert_eq!(callees, vec!["callee_with_loop"]);

    let callers: Vec<&str> = callgraph.callers("caller_with_loop").sorted().collect();
    assert!(callers.is_empty());
    let callees: Vec<&str> = callgraph.callees("caller_with_loop").sorted().collect();
    assert_eq!(
        callees,
        vec![
            "llvm.lifetime.end.p0i8",
            "llvm.lifetime.start.p0i8",
            "simple_callee"
        ]
    );

    let callers: Vec<&str> = callgraph.callers("recursive_simple").sorted().collect();
    assert_eq!(callers, vec!["recursive_simple"]);
    let callees: Vec<&str> = callgraph.callees("recursive_simple").sorted().collect();
    assert_eq!(callees, vec!["recursive_simple"]);

    let callers: Vec<&str> = callgraph.callers("recursive_double").sorted().collect();
    assert_eq!(callers, vec!["recursive_double"]);
    let callees: Vec<&str> = callgraph.callees("recursive_double").sorted().collect();
    assert_eq!(callees, vec!["recursive_double"]);

    let callers: Vec<&str> = callgraph
        .callers("recursive_and_normal_caller")
        .sorted()
        .collect();
    assert_eq!(callers, vec!["recursive_and_normal_caller"]);
    let callees: Vec<&str> = callgraph
        .callees("recursive_and_normal_caller")
        .sorted()
        .collect();
    assert_eq!(
        callees,
        vec!["recursive_and_normal_caller", "simple_callee"]
    );

    let callers: Vec<&str> = callgraph.callers("mutually_recursive_a").sorted().collect();
    assert_eq!(callers, vec!["mutually_recursive_b"]);
    let callees: Vec<&str> = callgraph.callees("mutually_recursive_a").sorted().collect();
    assert_eq!(callees, vec!["mutually_recursive_b"]);

    let callers: Vec<&str> = callgraph.callers("mutually_recursive_b").sorted().collect();
    assert_eq!(callers, vec!["mutually_recursive_a"]);
    let callees: Vec<&str> = callgraph.callees("mutually_recursive_b").sorted().collect();
    assert_eq!(callees, vec!["mutually_recursive_a"]);
}

#[test]
fn functionptr_call_graph() {
    init_logging();
    let module = Module::from_bc_path(FUNCTIONPTR_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let fbt = analysis.functions_by_type();
    let callgraph = analysis.call_graph();

    let footype_functions: Vec<&str> = fbt
        .functions_with_type(&module.types.func_type(
            module.types.i32(),
            vec![module.types.i32(), module.types.i32()],
            false,
        ))
        .sorted()
        .collect();
    assert_eq!(footype_functions, vec!["bar", "foo"]);

    let callers: Vec<&str> = callgraph.callers("foo").sorted().collect();
    assert_eq!(callers, vec!["calls_fptr", "calls_through_struct"]);
    let callees: Vec<&str> = callgraph.callees("foo").sorted().collect();
    assert!(callees.is_empty());

    let callers: Vec<&str> = callgraph.callers("bar").sorted().collect();
    assert_eq!(callers, vec!["calls_fptr", "calls_through_struct"]);
    let callees: Vec<&str> = callgraph.callees("bar").sorted().collect();
    assert!(callees.is_empty());

    let callers: Vec<&str> = callgraph.callers("calls_fptr").sorted().collect();
    assert_eq!(callers, vec!["fptr_driver"]);
    let callees: Vec<&str> = callgraph.callees("calls_fptr").sorted().collect();
    assert_eq!(callees, vec!["bar", "foo"]);

    let callers: Vec<&str> = callgraph.callers("get_function_ptr").sorted().collect();
    assert_eq!(callers, vec!["fptr_driver", "struct_driver"]);
    let callees: Vec<&str> = callgraph.callees("get_function_ptr").sorted().collect();
    assert!(callees.is_empty());

    let callers: Vec<&str> = callgraph.callers("calls_through_struct").sorted().collect();
    assert_eq!(callers, vec!["struct_driver"]);
    let callees: Vec<&str> = callgraph.callees("calls_through_struct").sorted().collect();
    assert_eq!(callees, vec!["bar", "foo"]);

    let callers: Vec<&str> = callgraph.callers("struct_driver").sorted().collect();
    assert!(callers.is_empty());
    let callees: Vec<&str> = callgraph.callees("struct_driver").sorted().collect();
    assert_eq!(
        callees,
        vec![
            "calls_through_struct",
            "get_function_ptr",
            "llvm.lifetime.end.p0i8",
            "llvm.lifetime.start.p0i8",
            "llvm.memset.p0i8.i64"
        ]
    );
}

#[test]
fn crossmod_call_graph() {
    init_logging();
    let call_module = Module::from_bc_path(CALL_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let crossmod_module = Module::from_bc_path(CROSSMOD_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let modules = [call_module, crossmod_module];
    let analysis = CrossModuleAnalysis::new(&modules);
    let callgraph = analysis.call_graph();

    // this function isn't involved in cross-module calls, it should still have the same results
    let callers: Vec<&str> = callgraph.callers("conditional_caller").sorted().collect();
    assert!(callers.is_empty());
    let callees: Vec<&str> = callgraph.callees("conditional_caller").sorted().collect();
    assert_eq!(callees, vec!["simple_callee"]);

    // this function also isn't involved in cross-module calls; it sits in the other module
    let callers: Vec<&str> = callgraph
        .callers("cross_module_nested_near_caller")
        .sorted()
        .collect();
    assert!(callers.is_empty());
    let callees: Vec<&str> = callgraph
        .callees("cross_module_nested_near_caller")
        .sorted()
        .collect();
    assert_eq!(callees, vec!["cross_module_simple_caller"]);

    // this function is called cross-module
    let callers: Vec<&str> = callgraph.callers("simple_callee").sorted().collect();
    assert_eq!(
        callers,
        vec![
            "caller_with_loop",
            "conditional_caller",
            "cross_module_simple_caller",
            "cross_module_twice_caller",
            "recursive_and_normal_caller",
            "simple_caller",
            "twice_caller",
        ]
    );
    let callees: Vec<&str> = callgraph.callees("simple_callee").sorted().collect();
    assert!(callees.is_empty());
}
