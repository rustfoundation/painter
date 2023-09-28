use itertools::Itertools;
use llvm_ir::{Module, Name};
use llvm_ir_analysis::*;

fn init_logging() {
    // capture log messages with test harness
    let _ = env_logger::builder().is_test(true).try_init();
}

/// loop.c and loop.bc are taken from [`haybale`]'s test suite
///
/// [`haybale`]: https://crates.io/crates/haybale
const LOOP_BC_PATH: &'static str = "tests/bcfiles/loop.bc";

#[test]
fn while_loop_cfg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let cfg = analysis.fn_analysis("while_loop").control_flow_graph();

    // CFG:
    //  1
    //  |   _
    //  | /   \   (self-loop on 6)
    //  6 -- /
    //  |
    //  |
    //  12

    let bb1_name = Name::from(1);
    let _bb1_node = CFGNode::Block(&bb1_name);
    let bb6_name = Name::from(6);
    let bb6_node = CFGNode::Block(&bb6_name);
    let bb12_name = Name::from(12);
    let bb12_node = CFGNode::Block(&bb12_name);

    let bb1_preds: Vec<&Name> = cfg.preds(&bb1_name).sorted().collect();
    assert!(bb1_preds.is_empty());
    let bb1_succs: Vec<CFGNode> = cfg.succs(&bb1_name).sorted().collect();
    assert_eq!(bb1_succs, vec![bb6_node]);

    let bb6_preds: Vec<&Name> = cfg.preds(&bb6_name).sorted().collect();
    assert_eq!(bb6_preds, vec![&bb1_name, &bb6_name]);
    let bb6_succs: Vec<CFGNode> = cfg.succs(&bb6_name).sorted().collect();
    assert_eq!(bb6_succs, vec![bb6_node, bb12_node]);

    let bb12_preds: Vec<&Name> = cfg.preds(&bb12_name).sorted().collect();
    assert_eq!(bb12_preds, vec![&bb6_name]);
    let bb12_succs: Vec<CFGNode> = cfg.succs(&bb12_name).sorted().collect();
    assert_eq!(bb12_succs, vec![CFGNode::Return]);
}

#[test]
fn for_loop_cfg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let cfg = analysis.fn_analysis("for_loop").control_flow_graph();

    // CFG:
    //  1      _
    //  | \  /   \
    //  |  9 -- /
    //  | /
    //  6

    let bb1_name = Name::from(1);
    let _bb1_node = CFGNode::Block(&bb1_name);
    let bb6_name = Name::from(6);
    let bb6_node = CFGNode::Block(&bb6_name);
    let bb9_name = Name::from(9);
    let bb9_node = CFGNode::Block(&bb9_name);

    let bb1_preds: Vec<&Name> = cfg.preds(&bb1_name).sorted().collect();
    assert!(bb1_preds.is_empty());
    let bb1_succs: Vec<CFGNode> = cfg.succs(&bb1_name).sorted().collect();
    assert_eq!(bb1_succs, vec![bb6_node, bb9_node]);

    let bb6_preds: Vec<&Name> = cfg.preds(&bb6_name).sorted().collect();
    assert_eq!(bb6_preds, vec![&bb1_name, &bb9_name]);
    let bb6_succs: Vec<CFGNode> = cfg.succs(&bb6_name).sorted().collect();
    assert_eq!(bb6_succs, vec![CFGNode::Return]);

    let bb9_preds: Vec<&Name> = cfg.preds(&bb9_name).sorted().collect();
    assert_eq!(bb9_preds, vec![&bb1_name, &bb9_name]);
    let bb9_succs: Vec<CFGNode> = cfg.succs(&bb9_name).sorted().collect();
    assert_eq!(bb9_succs, vec![bb6_node, bb9_node]);
}

#[test]
fn loop_zero_iterations_cfg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let cfg = analysis
        .fn_analysis("loop_zero_iterations")
        .control_flow_graph();

    // CFG:
    //   1
    //   | \
    //   |  5     _
    //   |  | \ /   \
    //   |  | 11 - /
    //   |  | /
    //   |  8
    //   | /
    //  18

    let bb1_name = Name::from(1);
    let _bb1_node = CFGNode::Block(&bb1_name);
    let bb5_name = Name::from(5);
    let bb5_node = CFGNode::Block(&bb5_name);
    let bb8_name = Name::from(8);
    let bb8_node = CFGNode::Block(&bb8_name);
    let bb11_name = Name::from(11);
    let bb11_node = CFGNode::Block(&bb11_name);
    let bb18_name = Name::from(18);
    let bb18_node = CFGNode::Block(&bb18_name);

    let bb1_preds: Vec<&Name> = cfg.preds(&bb1_name).sorted().collect();
    assert!(bb1_preds.is_empty());
    let bb1_succs: Vec<CFGNode> = cfg.succs(&bb1_name).sorted().collect();
    assert_eq!(bb1_succs, vec![bb5_node, bb18_node]);

    let bb5_preds: Vec<&Name> = cfg.preds(&bb5_name).sorted().collect();
    assert_eq!(bb5_preds, vec![&bb1_name]);
    let bb5_succs: Vec<CFGNode> = cfg.succs(&bb5_name).sorted().collect();
    assert_eq!(bb5_succs, vec![bb8_node, bb11_node]);

    let bb8_preds: Vec<&Name> = cfg.preds(&bb8_name).sorted().collect();
    assert_eq!(bb8_preds, vec![&bb5_name, &bb11_name]);
    let bb8_succs: Vec<CFGNode> = cfg.succs(&bb8_name).sorted().collect();
    assert_eq!(bb8_succs, vec![bb18_node]);

    let bb11_preds: Vec<&Name> = cfg.preds(&bb11_name).sorted().collect();
    assert_eq!(bb11_preds, vec![&bb5_name, &bb11_name]);
    let bb11_succs: Vec<CFGNode> = cfg.succs(&bb11_name).sorted().collect();
    assert_eq!(bb11_succs, vec![bb8_node, bb11_node]);

    let bb18_preds: Vec<&Name> = cfg.preds(&bb18_name).sorted().collect();
    assert_eq!(bb18_preds, vec![&bb1_name, &bb8_name]);
    let bb18_succs: Vec<CFGNode> = cfg.succs(&bb18_name).sorted().collect();
    assert_eq!(bb18_succs, vec![CFGNode::Return]);
}

#[test]
fn loop_with_cond_cfg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let cfg = analysis.fn_analysis("loop_with_cond").control_flow_graph();

    // CFG:
    //   1
    //   |
    //   6 <---
    //   | \    \
    //   |  10   |
    //   | / |   |
    //  13  /    |
    //   | /    /
    //  16 --->
    //   |
    //  20

    let bb1_name = Name::from(1);
    let _bb1_node = CFGNode::Block(&bb1_name);
    let bb6_name = Name::from(6);
    let bb6_node = CFGNode::Block(&bb6_name);
    let bb10_name = Name::from(10);
    let bb10_node = CFGNode::Block(&bb10_name);
    let bb13_name = Name::from(13);
    let bb13_node = CFGNode::Block(&bb13_name);
    let bb16_name = Name::from(16);
    let bb16_node = CFGNode::Block(&bb16_name);
    let bb20_name = Name::from(20);
    let bb20_node = CFGNode::Block(&bb20_name);

    let bb1_preds: Vec<&Name> = cfg.preds(&bb1_name).sorted().collect();
    assert!(bb1_preds.is_empty());
    let bb1_succs: Vec<CFGNode> = cfg.succs(&bb1_name).sorted().collect();
    assert_eq!(bb1_succs, vec![bb6_node]);

    let bb6_preds: Vec<&Name> = cfg.preds(&bb6_name).sorted().collect();
    assert_eq!(bb6_preds, vec![&bb1_name, &bb16_name]);
    let bb6_succs: Vec<CFGNode> = cfg.succs(&bb6_name).sorted().collect();
    assert_eq!(bb6_succs, vec![bb10_node, bb13_node]);

    let bb10_preds: Vec<&Name> = cfg.preds(&bb10_name).sorted().collect();
    assert_eq!(bb10_preds, vec![&bb6_name]);
    let bb10_succs: Vec<CFGNode> = cfg.succs(&bb10_name).sorted().collect();
    assert_eq!(bb10_succs, vec![bb13_node, bb16_node]);

    let bb13_preds: Vec<&Name> = cfg.preds(&bb13_name).sorted().collect();
    assert_eq!(bb13_preds, vec![&bb6_name, &bb10_name]);
    let bb13_succs: Vec<CFGNode> = cfg.succs(&bb13_name).sorted().collect();
    assert_eq!(bb13_succs, vec![bb16_node]);

    let bb16_preds: Vec<&Name> = cfg.preds(&bb16_name).sorted().collect();
    assert_eq!(bb16_preds, vec![&bb10_name, &bb13_name]);
    let bb16_succs: Vec<CFGNode> = cfg.succs(&bb16_name).sorted().collect();
    assert_eq!(bb16_succs, vec![bb6_node, bb20_node]);

    let bb20_preds: Vec<&Name> = cfg.preds(&bb20_name).sorted().collect();
    assert_eq!(bb20_preds, vec![&bb16_name]);
    let bb20_succs: Vec<CFGNode> = cfg.succs(&bb20_name).sorted().collect();
    assert_eq!(bb20_succs, vec![CFGNode::Return]);
}

#[test]
fn loop_inside_cond_cfg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let cfg = analysis
        .fn_analysis("loop_inside_cond")
        .control_flow_graph();

    // CFG:
    //      1      _
    //    /   \  /   \
    //  11     5 -- /
    //    \   /
    //     12

    let bb1_name = Name::from(1);
    let _bb1_node = CFGNode::Block(&bb1_name);
    let bb5_name = Name::from(5);
    let bb5_node = CFGNode::Block(&bb5_name);
    let bb11_name = Name::from(11);
    let bb11_node = CFGNode::Block(&bb11_name);
    let bb12_name = Name::from(12);
    let bb12_node = CFGNode::Block(&bb12_name);

    let bb1_preds: Vec<&Name> = cfg.preds(&bb1_name).sorted().collect();
    assert!(bb1_preds.is_empty());
    let bb1_succs: Vec<CFGNode> = cfg.succs(&bb1_name).sorted().collect();
    assert_eq!(bb1_succs, vec![bb5_node, bb11_node]);

    let bb5_preds: Vec<&Name> = cfg.preds(&bb5_name).sorted().collect();
    assert_eq!(bb5_preds, vec![&bb1_name, &bb5_name]);
    let bb5_succs: Vec<CFGNode> = cfg.succs(&bb5_name).sorted().collect();
    assert_eq!(bb5_succs, vec![bb5_node, bb12_node]);

    let bb11_preds: Vec<&Name> = cfg.preds(&bb11_name).sorted().collect();
    assert_eq!(bb11_preds, vec![&bb1_name]);
    let bb11_succs: Vec<CFGNode> = cfg.succs(&bb11_name).sorted().collect();
    assert_eq!(bb11_succs, vec![bb12_node]);

    let bb12_preds: Vec<&Name> = cfg.preds(&bb12_name).sorted().collect();
    assert_eq!(bb12_preds, vec![&bb5_name, &bb11_name]);
    let bb12_succs: Vec<CFGNode> = cfg.succs(&bb12_name).sorted().collect();
    assert_eq!(bb12_succs, vec![CFGNode::Return]);
}

#[test]
fn search_array_cfg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let cfg = analysis.fn_analysis("search_array").control_flow_graph();

    // CFG:
    //      1   _
    //      | /   \
    //      4 -- /
    //      |
    //     11 <---- \
    //    /  \       |
    //  19    16 --> /
    //    \  /
    //     21

    let bb1_name = Name::from(1);
    let _bb1_node = CFGNode::Block(&bb1_name);
    let bb4_name = Name::from(4);
    let bb4_node = CFGNode::Block(&bb4_name);
    let bb11_name = Name::from(11);
    let bb11_node = CFGNode::Block(&bb11_name);
    let bb16_name = Name::from(16);
    let bb16_node = CFGNode::Block(&bb16_name);
    let bb19_name = Name::from(19);
    let bb19_node = CFGNode::Block(&bb19_name);
    let bb21_name = Name::from(21);
    let bb21_node = CFGNode::Block(&bb21_name);

    let bb1_preds: Vec<&Name> = cfg.preds(&bb1_name).sorted().collect();
    assert!(bb1_preds.is_empty());
    let bb1_succs: Vec<CFGNode> = cfg.succs(&bb1_name).sorted().collect();
    assert_eq!(bb1_succs, vec![bb4_node]);

    let bb4_preds: Vec<&Name> = cfg.preds(&bb4_name).sorted().collect();
    assert_eq!(bb4_preds, vec![&bb1_name, &bb4_name]);
    let bb4_succs: Vec<CFGNode> = cfg.succs(&bb4_name).sorted().collect();
    assert_eq!(bb4_succs, vec![bb4_node, bb11_node]);

    let bb11_preds: Vec<&Name> = cfg.preds(&bb11_name).sorted().collect();
    assert_eq!(bb11_preds, vec![&bb4_name, &bb16_name]);
    let bb11_succs: Vec<CFGNode> = cfg.succs(&bb11_name).sorted().collect();
    assert_eq!(bb11_succs, vec![bb16_node, bb19_node]);

    let bb16_preds: Vec<&Name> = cfg.preds(&bb16_name).sorted().collect();
    assert_eq!(bb16_preds, vec![&bb11_name]);
    let bb16_succs: Vec<CFGNode> = cfg.succs(&bb16_name).sorted().collect();
    assert_eq!(bb16_succs, vec![bb11_node, bb21_node]);

    let bb19_preds: Vec<&Name> = cfg.preds(&bb19_name).sorted().collect();
    assert_eq!(bb19_preds, vec![&bb11_name]);
    let bb19_succs: Vec<CFGNode> = cfg.succs(&bb19_name).sorted().collect();
    assert_eq!(bb19_succs, vec![bb21_node]);

    let bb21_preds: Vec<&Name> = cfg.preds(&bb21_name).sorted().collect();
    assert_eq!(bb21_preds, vec![&bb16_name, &bb19_name]);
    let bb21_succs: Vec<CFGNode> = cfg.succs(&bb21_name).sorted().collect();
    assert_eq!(bb21_succs, vec![CFGNode::Return]);
}

#[test]
fn nested_loop_cfg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let cfg = analysis.fn_analysis("nested_loop").control_flow_graph();

    // CFG:
    //  1
    //  | \
    //  |  5 <----
    //  |  |   _   \
    //  |  | /  |   |
    //  | 13 -- /   |
    //  |  |       /
    //  | 10 ---->
    //  | /
    //  7

    let bb1_name = Name::from(1);
    let _bb1_node = CFGNode::Block(&bb1_name);
    let bb5_name = Name::from(5);
    let bb5_node = CFGNode::Block(&bb5_name);
    let bb7_name = Name::from(7);
    let bb7_node = CFGNode::Block(&bb7_name);
    let bb10_name = Name::from(10);
    let bb10_node = CFGNode::Block(&bb10_name);
    let bb13_name = Name::from(13);
    let bb13_node = CFGNode::Block(&bb13_name);

    let bb1_preds: Vec<&Name> = cfg.preds(&bb1_name).sorted().collect();
    assert!(bb1_preds.is_empty());
    let bb1_succs: Vec<CFGNode> = cfg.succs(&bb1_name).sorted().collect();
    assert_eq!(bb1_succs, vec![bb5_node, bb7_node]);

    let bb5_preds: Vec<&Name> = cfg.preds(&bb5_name).sorted().collect();
    assert_eq!(bb5_preds, vec![&bb1_name, &bb10_name]);
    let bb5_succs: Vec<CFGNode> = cfg.succs(&bb5_name).sorted().collect();
    assert_eq!(bb5_succs, vec![bb13_node]);

    let bb7_preds: Vec<&Name> = cfg.preds(&bb7_name).sorted().collect();
    assert_eq!(bb7_preds, vec![&bb1_name, &bb10_name]);
    let bb7_succs: Vec<CFGNode> = cfg.succs(&bb7_name).sorted().collect();
    assert_eq!(bb7_succs, vec![CFGNode::Return]);

    let bb10_preds: Vec<&Name> = cfg.preds(&bb10_name).sorted().collect();
    assert_eq!(bb10_preds, vec![&bb13_name]);
    let bb10_succs: Vec<CFGNode> = cfg.succs(&bb10_name).sorted().collect();
    assert_eq!(bb10_succs, vec![bb5_node, bb7_node]);

    let bb13_preds: Vec<&Name> = cfg.preds(&bb13_name).sorted().collect();
    assert_eq!(bb13_preds, vec![&bb5_name, &bb13_name]);
    let bb13_succs: Vec<CFGNode> = cfg.succs(&bb13_name).sorted().collect();
    assert_eq!(bb13_succs, vec![bb10_node, bb13_node]);
}

#[test]
fn while_loop_domtree() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let fn_analysis = analysis.fn_analysis("while_loop");

    // CFG:
    //  1
    //  |   _
    //  | /   \   (self-loop on 6)
    //  6 -- /
    //  |
    //  |
    //  12

    let domtree = fn_analysis.dominator_tree();
    assert_eq!(domtree.idom(&Name::from(1)), None);
    assert_eq!(domtree.idom(&Name::from(6)), Some(&Name::from(1)));
    assert_eq!(domtree.idom(&Name::from(12)), Some(&Name::from(6)));
    assert_eq!(domtree.idom_of_return(), Some(&Name::from(12)));

    let postdomtree = fn_analysis.postdominator_tree();
    assert_eq!(
        postdomtree.ipostdom(&Name::from(1)),
        Some(CFGNode::Block(&Name::from(6)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(6)),
        Some(CFGNode::Block(&Name::from(12)))
    );
    assert_eq!(postdomtree.ipostdom(&Name::from(12)), Some(CFGNode::Return));
}

#[test]
fn for_loop_domtree() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let fn_analysis = analysis.fn_analysis("for_loop");

    // CFG:
    //  1      _
    //  | \  /   \
    //  |  9 -- /
    //  | /
    //  6

    let domtree = fn_analysis.dominator_tree();
    assert_eq!(domtree.idom(&Name::from(1)), None);
    assert_eq!(domtree.idom(&Name::from(6)), Some(&Name::from(1)));
    assert_eq!(domtree.idom(&Name::from(9)), Some(&Name::from(1)));
    assert_eq!(domtree.idom_of_return(), Some(&Name::from(6)));

    let postdomtree = fn_analysis.postdominator_tree();
    assert_eq!(
        postdomtree.ipostdom(&Name::from(1)),
        Some(CFGNode::Block(&Name::from(6)))
    );
    assert_eq!(postdomtree.ipostdom(&Name::from(6)), Some(CFGNode::Return));
    assert_eq!(
        postdomtree.ipostdom(&Name::from(9)),
        Some(CFGNode::Block(&Name::from(6)))
    );
}

#[test]
fn loop_zero_iterations_domtree() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let fn_analysis = analysis.fn_analysis("loop_zero_iterations");

    // CFG:
    //   1
    //   | \
    //   |  5     _
    //   |  | \ /   \
    //   |  | 11 - /
    //   |  | /
    //   |  8
    //   | /
    //  18

    let domtree = fn_analysis.dominator_tree();
    assert_eq!(domtree.idom(&Name::from(1)), None);
    assert_eq!(domtree.idom(&Name::from(5)), Some(&Name::from(1)));
    assert_eq!(domtree.idom(&Name::from(8)), Some(&Name::from(5)));
    assert_eq!(domtree.idom(&Name::from(11)), Some(&Name::from(5)));
    assert_eq!(domtree.idom(&Name::from(18)), Some(&Name::from(1)));
    assert_eq!(domtree.idom_of_return(), Some(&Name::from(18)));

    let postdomtree = fn_analysis.postdominator_tree();
    assert_eq!(
        postdomtree.ipostdom(&Name::from(1)),
        Some(CFGNode::Block(&Name::from(18)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(5)),
        Some(CFGNode::Block(&Name::from(8)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(8)),
        Some(CFGNode::Block(&Name::from(18)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(11)),
        Some(CFGNode::Block(&Name::from(8)))
    );
    assert_eq!(postdomtree.ipostdom(&Name::from(18)), Some(CFGNode::Return));
}

#[test]
fn loop_with_cond_domtree() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let fn_analysis = analysis.fn_analysis("loop_with_cond");

    // CFG:
    //   1
    //   |
    //   6 <---
    //   | \    \
    //   |  10   |
    //   | / |   |
    //  13  /    |
    //   | /    /
    //  16 --->
    //   |
    //  20

    let domtree = fn_analysis.dominator_tree();
    assert_eq!(domtree.idom(&Name::from(1)), None);
    assert_eq!(domtree.idom(&Name::from(6)), Some(&Name::from(1)));
    assert_eq!(domtree.idom(&Name::from(10)), Some(&Name::from(6)));
    assert_eq!(domtree.idom(&Name::from(13)), Some(&Name::from(6)));
    assert_eq!(domtree.idom(&Name::from(16)), Some(&Name::from(6)));
    assert_eq!(domtree.idom(&Name::from(20)), Some(&Name::from(16)));
    assert_eq!(domtree.idom_of_return(), Some(&Name::from(20)));

    let postdomtree = fn_analysis.postdominator_tree();
    assert_eq!(
        postdomtree.ipostdom(&Name::from(1)),
        Some(CFGNode::Block(&Name::from(6)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(6)),
        Some(CFGNode::Block(&Name::from(16)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(10)),
        Some(CFGNode::Block(&Name::from(16)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(13)),
        Some(CFGNode::Block(&Name::from(16)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(16)),
        Some(CFGNode::Block(&Name::from(20)))
    );
    assert_eq!(postdomtree.ipostdom(&Name::from(20)), Some(CFGNode::Return));
}

#[test]
fn loop_inside_cond_domtree() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let fn_analysis = analysis.fn_analysis("loop_inside_cond");

    // CFG:
    //      1      _
    //    /   \  /   \
    //  11     5 -- /
    //    \   /
    //     12

    let domtree = fn_analysis.dominator_tree();
    assert_eq!(domtree.idom(&Name::from(1)), None);
    assert_eq!(domtree.idom(&Name::from(5)), Some(&Name::from(1)));
    assert_eq!(domtree.idom(&Name::from(11)), Some(&Name::from(1)));
    assert_eq!(domtree.idom(&Name::from(12)), Some(&Name::from(1)));
    assert_eq!(domtree.idom_of_return(), Some(&Name::from(12)));

    let postdomtree = fn_analysis.postdominator_tree();
    assert_eq!(
        postdomtree.ipostdom(&Name::from(1)),
        Some(CFGNode::Block(&Name::from(12)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(5)),
        Some(CFGNode::Block(&Name::from(12)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(11)),
        Some(CFGNode::Block(&Name::from(12)))
    );
    assert_eq!(postdomtree.ipostdom(&Name::from(12)), Some(CFGNode::Return));
}

#[test]
fn search_array_domtree() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let fn_analysis = analysis.fn_analysis("search_array");

    // CFG:
    //      1   _
    //      | /   \
    //      4 -- /
    //      |
    //     11 <---- \
    //    /  \       |
    //  19    16 --> /
    //    \  /
    //     21

    let domtree = fn_analysis.dominator_tree();
    assert_eq!(domtree.idom(&Name::from(1)), None);
    assert_eq!(domtree.idom(&Name::from(4)), Some(&Name::from(1)));
    assert_eq!(domtree.idom(&Name::from(11)), Some(&Name::from(4)));
    assert_eq!(domtree.idom(&Name::from(16)), Some(&Name::from(11)));
    assert_eq!(domtree.idom(&Name::from(19)), Some(&Name::from(11)));
    assert_eq!(domtree.idom(&Name::from(21)), Some(&Name::from(11)));
    assert_eq!(domtree.idom_of_return(), Some(&Name::from(21)));

    let postdomtree = fn_analysis.postdominator_tree();
    assert_eq!(
        postdomtree.ipostdom(&Name::from(1)),
        Some(CFGNode::Block(&Name::from(4)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(4)),
        Some(CFGNode::Block(&Name::from(11)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(11)),
        Some(CFGNode::Block(&Name::from(21)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(16)),
        Some(CFGNode::Block(&Name::from(21)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(19)),
        Some(CFGNode::Block(&Name::from(21)))
    );
    assert_eq!(postdomtree.ipostdom(&Name::from(21)), Some(CFGNode::Return));
}

#[test]
fn nested_loop_domtree() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let fn_analysis = analysis.fn_analysis("nested_loop");

    // CFG:
    //  1
    //  | \
    //  |  5 <----
    //  |  |   _   \
    //  |  | /  |   |
    //  | 13 -- /   |
    //  |  |       /
    //  | 10 ---->
    //  | /
    //  7

    let domtree = fn_analysis.dominator_tree();
    assert_eq!(domtree.idom(&Name::from(1)), None);
    assert_eq!(domtree.idom(&Name::from(5)), Some(&Name::from(1)));
    assert_eq!(domtree.idom(&Name::from(10)), Some(&Name::from(13)));
    assert_eq!(domtree.idom(&Name::from(13)), Some(&Name::from(5)));
    assert_eq!(domtree.idom(&Name::from(7)), Some(&Name::from(1)));
    assert_eq!(domtree.idom_of_return(), Some(&Name::from(7)));

    let postdomtree = fn_analysis.postdominator_tree();
    assert_eq!(
        postdomtree.ipostdom(&Name::from(1)),
        Some(CFGNode::Block(&Name::from(7)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(5)),
        Some(CFGNode::Block(&Name::from(13)))
    );
    assert_eq!(postdomtree.ipostdom(&Name::from(7)), Some(CFGNode::Return));
    assert_eq!(
        postdomtree.ipostdom(&Name::from(10)),
        Some(CFGNode::Block(&Name::from(7)))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from(13)),
        Some(CFGNode::Block(&Name::from(10)))
    );
}

#[test]
fn infinite_loop_cfg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let fn_analysis = analysis.fn_analysis("infinite_loop");

    let domtree = fn_analysis.dominator_tree();
    assert_eq!(domtree.idom(&Name::from(1)), Some(&Name::from(0)));
    assert_eq!(domtree.idom_of_return(), None);

    let postdomtree = fn_analysis.postdominator_tree();
    assert_eq!(postdomtree.ipostdom(&Name::from(0)), None);
    assert_eq!(postdomtree.ipostdom(&Name::from(1)), None);
}

#[test]
fn while_loop_cdg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);

    // CFG:
    //  1
    //  |   _
    //  | /   \   (self-loop on 6)
    //  6 -- /
    //  |
    //  |
    //  12

    let cdg = analysis
        .fn_analysis("while_loop")
        .control_dependence_graph();

    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(6))
            .collect::<Vec<_>>(),
        vec![&Name::from(6)]
    );
    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(12)).count(), 0);

    assert_eq!(cdg.get_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(6))
            .collect::<Vec<_>>(),
        vec![&Name::from(6)]
    );
    assert_eq!(cdg.get_control_dependencies(&Name::from(12)).count(), 0);

    assert_eq!(
        cdg.is_control_dependent(&Name::from(6), &Name::from(1)),
        false
    );
    assert_eq!(
        cdg.is_control_dependent(&Name::from(1), &Name::from(6)),
        false
    );
    assert_eq!(
        cdg.is_control_dependent(&Name::from(1), &Name::from(1)),
        false
    );
    assert_eq!(
        cdg.is_control_dependent(&Name::from(6), &Name::from(6)),
        true
    );
}

#[test]
fn for_loop_cdg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);

    // CFG:
    //  1      _
    //  | \  /   \
    //  |  9 -- /
    //  | /
    //  6

    let cdg = analysis.fn_analysis("for_loop").control_dependence_graph();

    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(6)).count(), 0);
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(9))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(9)]
    );

    assert_eq!(cdg.get_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(cdg.get_control_dependencies(&Name::from(6)).count(), 0);
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(9))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(9)]
    );
}

#[test]
fn loop_zero_iterations_cdg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);

    // CFG:
    //   1
    //   | \
    //   |  5     _
    //   |  | \ /   \
    //   |  | 11 - /
    //   |  | /
    //   |  8
    //   | /
    //  18

    let cdg = analysis
        .fn_analysis("loop_zero_iterations")
        .control_dependence_graph();

    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(5))
            .collect::<Vec<_>>(),
        vec![&Name::from(1)]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(8))
            .collect::<Vec<_>>(),
        vec![&Name::from(1)]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(11))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(5), &Name::from(11)]
    );
    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(18)).count(), 0);

    assert_eq!(cdg.get_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(5))
            .collect::<Vec<_>>(),
        vec![&Name::from(1)]
    );
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(8))
            .collect::<Vec<_>>(),
        vec![&Name::from(1)]
    );
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(11))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(5), &Name::from(11)]
    );
    assert_eq!(cdg.get_control_dependencies(&Name::from(18)).count(), 0);
}

#[test]
fn loop_with_cond_cdg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);

    // CFG:
    //   1
    //   |
    //   6 <---
    //   | \    \
    //   |  10   |
    //   | / |   |
    //  13  /    |
    //   | /    /
    //  16 --->
    //   |
    //  20

    let cdg = analysis
        .fn_analysis("loop_with_cond")
        .control_dependence_graph();

    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(6))
            .collect::<Vec<_>>(),
        vec![&Name::from(16)]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(10))
            .collect::<Vec<_>>(),
        vec![&Name::from(6)]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(13))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(6), &Name::from(10)]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(16))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(16)]
    );
    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(20)).count(), 0);

    assert_eq!(cdg.get_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(6))
            .collect::<Vec<_>>(),
        vec![&Name::from(16)]
    );
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(10))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(6), &Name::from(16)]
    );
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(13))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(6), &Name::from(10), &Name::from(16)]
    );
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(16))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(16)]
    );
    assert_eq!(cdg.get_control_dependencies(&Name::from(20)).count(), 0);

    assert_eq!(
        cdg.is_control_dependent(&Name::from(10), &Name::from(6)),
        true
    );
    assert_eq!(
        cdg.is_control_dependent(&Name::from(10), &Name::from(16)),
        true
    );
    assert_eq!(
        cdg.is_control_dependent(&Name::from(16), &Name::from(16)),
        true
    );
    assert_eq!(
        cdg.is_control_dependent(&Name::from(6), &Name::from(6)),
        false
    );
    assert_eq!(
        cdg.is_control_dependent(&Name::from(6), &Name::from(10)),
        false
    );
}

#[test]
fn loop_inside_cond_cdg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);

    // CFG:
    //      1      _
    //    /   \  /   \
    //  11     5 -- /
    //    \   /
    //     12

    let cdg = analysis
        .fn_analysis("loop_inside_cond")
        .control_dependence_graph();

    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(5))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(5)]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(11))
            .collect::<Vec<_>>(),
        vec![&Name::from(1)]
    );
    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(12)).count(), 0);

    assert_eq!(cdg.get_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(5))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(5)]
    );
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(11))
            .collect::<Vec<_>>(),
        vec![&Name::from(1)]
    );
    assert_eq!(cdg.get_control_dependencies(&Name::from(12)).count(), 0);
}

#[test]
fn search_array_cdg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);

    // CFG:
    //      1   _
    //      | /   \
    //      4 -- /
    //      |
    //     11 <---- \
    //    /  \       |
    //  19    16 --> /
    //    \  /
    //     21

    let cdg = analysis
        .fn_analysis("search_array")
        .control_dependence_graph();

    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(4))
            .collect::<Vec<_>>(),
        vec![&Name::from(4)]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(11))
            .collect::<Vec<_>>(),
        vec![&Name::from(16)]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(16))
            .collect::<Vec<_>>(),
        vec![&Name::from(11)]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(19))
            .collect::<Vec<_>>(),
        vec![&Name::from(11)]
    );
    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(21)).count(), 0);

    assert_eq!(cdg.get_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(4))
            .collect::<Vec<_>>(),
        vec![&Name::from(4)]
    );
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(11))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(11), &Name::from(16)]
    );
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(16))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(11), &Name::from(16)]
    );
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(19))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(11), &Name::from(16)]
    );
    assert_eq!(cdg.get_control_dependencies(&Name::from(21)).count(), 0);
}

#[test]
fn nested_loop_cdg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);

    // CFG:
    //  1
    //  | \
    //  |  5 <----
    //  |  |   _   \
    //  |  | /  |   |
    //  | 13 -- /   |
    //  |  |       /
    //  | 10 ---->
    //  | /
    //  7

    let cdg = analysis
        .fn_analysis("nested_loop")
        .control_dependence_graph();

    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(5))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(10)]
    );
    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(7)).count(), 0);
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(10))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(10)]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from(13))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(10), &Name::from(13)]
    );

    assert_eq!(cdg.get_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(5))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(10)]
    );
    assert_eq!(cdg.get_control_dependencies(&Name::from(7)).count(), 0);
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(10))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(10)]
    );
    assert_eq!(
        cdg.get_control_dependencies(&Name::from(13))
            .sorted()
            .collect::<Vec<_>>(),
        vec![&Name::from(1), &Name::from(10), &Name::from(13)]
    );
}

#[test]
fn infinite_loop_cdg() {
    init_logging();
    let module = Module::from_bc_path(LOOP_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);

    let cdg = analysis
        .fn_analysis("infinite_loop")
        .control_dependence_graph();

    assert_eq!(cdg.get_imm_control_dependencies(&Name::from(1)).count(), 0);
    assert_eq!(cdg.get_control_dependencies(&Name::from(1)).count(), 0);
}
