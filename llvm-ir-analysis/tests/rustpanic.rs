use itertools::Itertools;
use llvm_ir::{Module, Name};
use llvm_ir_analysis::*;

fn init_logging() {
    // capture log messages with test harness
    let _ = env_logger::builder().is_test(true).try_init();
}

/// panic.c and panic.bc are taken from [`haybale`]'s test suite
///
/// [`haybale`]: https://crates.io/crates/haybale
const PANIC_BC_PATH: &'static str = "tests/bcfiles/panic.bc";

#[test]
fn begin_panic_cfg() {
    init_logging();
    let module = Module::from_bc_path(PANIC_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let cfg = analysis
        .fn_analysis("_ZN3std9panicking11begin_panic17h5ae0871c3ba84f98E")
        .control_flow_graph();

    // CFG:
    //         start
    //        /     \
    //  cleanup     bb2
    //     |        /  \
    //     |       /    bb4
    //     |      |    /   \
    //     |      |   /     \
    //     |   cleanup1   unreachable
    //     |     /            |
    //     |   bb3       (unreachable)
    //     |  /
    //    bb6
    //     | \
    //     | bb5
    //     | /
    //    bb1
    //     |
    //   (ret)

    let bbstart_name = Name::from("start");
    let _bbstart_node = CFGNode::Block(&bbstart_name);
    let bb1_name = Name::from("bb1");
    let bb1_node = CFGNode::Block(&bb1_name);
    let bb2_name = Name::from("bb2");
    let bb2_node = CFGNode::Block(&bb2_name);
    let bb3_name = Name::from("bb3");
    let bb3_node = CFGNode::Block(&bb3_name);
    let bb4_name = Name::from("bb4");
    let bb4_node = CFGNode::Block(&bb4_name);
    let bb5_name = Name::from("bb5");
    let bb5_node = CFGNode::Block(&bb5_name);
    let bb6_name = Name::from("bb6");
    let bb6_node = CFGNode::Block(&bb6_name);
    let bbcleanup_name = Name::from("cleanup");
    let bbcleanup_node = CFGNode::Block(&bbcleanup_name);
    let bbcleanup1_name = Name::from("cleanup1");
    let bbcleanup1_node = CFGNode::Block(&bbcleanup1_name);
    let bbunreachable_name = Name::from("unreachable");
    let bbunreachable_node = CFGNode::Block(&bbunreachable_name);

    let bbstart_preds: Vec<&Name> = cfg.preds(&bbstart_name).sorted().collect();
    assert!(bbstart_preds.is_empty());
    let bbstart_succs: Vec<CFGNode> = cfg.succs(&bbstart_name).sorted().collect();
    assert_eq!(bbstart_succs, vec![bb2_node, bbcleanup_node]);

    let bb1_preds: Vec<&Name> = cfg.preds(&bb1_name).sorted().collect();
    assert_eq!(bb1_preds, vec![&bb5_name, &bb6_name]);
    let bb1_succs: Vec<CFGNode> = cfg.succs(&bb1_name).sorted().collect();
    assert_eq!(bb1_succs, vec![CFGNode::Return]);

    let bb2_preds: Vec<&Name> = cfg.preds(&bb2_name).sorted().collect();
    assert_eq!(bb2_preds, vec![&bbstart_name]);
    let bb2_succs: Vec<CFGNode> = cfg.succs(&bb2_name).sorted().collect();
    assert_eq!(bb2_succs, vec![bb4_node, bbcleanup1_node]);

    let bb3_preds: Vec<&Name> = cfg.preds(&bb3_name).sorted().collect();
    assert_eq!(bb3_preds, vec![&bbcleanup1_name]);
    let bb3_succs: Vec<CFGNode> = cfg.succs(&bb3_name).sorted().collect();
    assert_eq!(bb3_succs, vec![bb6_node]);

    let bb4_preds: Vec<&Name> = cfg.preds(&bb4_name).sorted().collect();
    assert_eq!(bb4_preds, vec![&bb2_name]);
    let bb4_succs: Vec<CFGNode> = cfg.succs(&bb4_name).sorted().collect();
    assert_eq!(bb4_succs, vec![bbcleanup1_node, bbunreachable_node]);

    let bb5_preds: Vec<&Name> = cfg.preds(&bb5_name).sorted().collect();
    assert_eq!(bb5_preds, vec![&bb6_name]);
    let bb5_succs: Vec<CFGNode> = cfg.succs(&bb5_name).sorted().collect();
    assert_eq!(bb5_succs, vec![bb1_node]);

    let bb6_preds: Vec<&Name> = cfg.preds(&bb6_name).sorted().collect();
    assert_eq!(bb6_preds, vec![&bb3_name, &bbcleanup_name]);
    let bb6_succs: Vec<CFGNode> = cfg.succs(&bb6_name).sorted().collect();
    assert_eq!(bb6_succs, vec![bb1_node, bb5_node]);

    let bbcleanup_preds: Vec<&Name> = cfg.preds(&bbcleanup_name).sorted().collect();
    assert_eq!(bbcleanup_preds, vec![&bbstart_name]);
    let bbcleanup_succs: Vec<CFGNode> = cfg.succs(&bbcleanup_name).sorted().collect();
    assert_eq!(bbcleanup_succs, vec![bb6_node]);

    let bbcleanup1_preds: Vec<&Name> = cfg.preds(&bbcleanup1_name).sorted().collect();
    assert_eq!(bbcleanup1_preds, vec![&bb2_name, &bb4_name]);
    let bbcleanup1_succs: Vec<CFGNode> = cfg.succs(&bbcleanup1_name).sorted().collect();
    assert_eq!(bbcleanup1_succs, vec![bb3_node]);

    let bbunreachable_preds: Vec<&Name> = cfg.preds(&bbunreachable_name).sorted().collect();
    assert_eq!(bbunreachable_preds, vec![&bb4_name]);
    let bbunreachable_succs: Vec<CFGNode> = cfg.succs(&bbunreachable_name).sorted().collect();
    assert!(bbunreachable_succs.is_empty());

    let return_preds: Vec<&Name> = cfg.preds_of_return().sorted().collect();
    assert_eq!(return_preds, vec![&bb1_name]);
}

#[test]
fn begin_panic_domtree() {
    init_logging();
    let module = Module::from_bc_path(PANIC_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);
    let fn_analysis = analysis.fn_analysis("_ZN3std9panicking11begin_panic17h5ae0871c3ba84f98E");

    // CFG:
    //         start
    //        /     \
    //  cleanup     bb2
    //     |        /  \
    //     |       /    bb4
    //     |      |    /   \
    //     |      |   /     \
    //     |   cleanup1   unreachable
    //     |     /            |
    //     |   bb3       (unreachable)
    //     |  /
    //    bb6
    //     | \
    //     | bb5
    //     | /
    //    bb1
    //     |
    //   (ret)

    let domtree = fn_analysis.dominator_tree();
    assert_eq!(domtree.idom(&Name::from("start")), None);
    assert_eq!(domtree.idom(&Name::from("bb1")), Some(&Name::from("bb6")));
    assert_eq!(domtree.idom(&Name::from("bb2")), Some(&Name::from("start")));
    assert_eq!(
        domtree.idom(&Name::from("bb3")),
        Some(&Name::from("cleanup1"))
    );
    assert_eq!(domtree.idom(&Name::from("bb4")), Some(&Name::from("bb2")));
    assert_eq!(domtree.idom(&Name::from("bb5")), Some(&Name::from("bb6")));
    assert_eq!(domtree.idom(&Name::from("bb6")), Some(&Name::from("start")));
    assert_eq!(
        domtree.idom(&Name::from("cleanup")),
        Some(&Name::from("start"))
    );
    assert_eq!(
        domtree.idom(&Name::from("cleanup1")),
        Some(&Name::from("bb2"))
    );
    assert_eq!(
        domtree.idom(&Name::from("unreachable")),
        Some(&Name::from("bb4"))
    );

    let postdomtree = fn_analysis.postdominator_tree();
    // especially relevant for postdomtree (and CDG below): our algorithm
    // doesn't consider unreachable blocks, so postdominators are calculated
    // considering only the subset of the CFG which is reachable.
    // This seems like a feature and not a bug.
    assert_eq!(
        postdomtree.ipostdom(&Name::from("start")),
        Some(CFGNode::Block(&Name::from("bb6")))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from("bb1")),
        Some(CFGNode::Return)
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from("bb2")),
        Some(CFGNode::Block(&Name::from("cleanup1")))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from("bb3")),
        Some(CFGNode::Block(&Name::from("bb6")))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from("bb4")),
        Some(CFGNode::Block(&Name::from("cleanup1")))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from("bb5")),
        Some(CFGNode::Block(&Name::from("bb1")))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from("bb6")),
        Some(CFGNode::Block(&Name::from("bb1")))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from("cleanup")),
        Some(CFGNode::Block(&Name::from("bb6")))
    );
    assert_eq!(
        postdomtree.ipostdom(&Name::from("cleanup1")),
        Some(CFGNode::Block(&Name::from("bb3")))
    );
    assert_eq!(postdomtree.ipostdom(&Name::from("unreachable")), None);
}

#[test]
fn begin_panic_cdg() {
    init_logging();
    let module = Module::from_bc_path(PANIC_BC_PATH)
        .unwrap_or_else(|e| panic!("Failed to parse module: {}", e));
    let analysis = ModuleAnalysis::new(&module);

    // CFG:
    //         start
    //        /     \
    //  cleanup     bb2
    //     |        /  \
    //     |       /    bb4
    //     |      |    /   \
    //     |      |   /     \
    //     |   cleanup1   unreachable
    //     |     /            |
    //     |   bb3       (unreachable)
    //     |  /
    //    bb6
    //     | \
    //     | bb5
    //     | /
    //    bb1
    //     |
    //   (ret)

    let cdg = analysis
        .fn_analysis("_ZN3std9panicking11begin_panic17h5ae0871c3ba84f98E")
        .control_dependence_graph();
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from("start"))
            .count(),
        0
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from("bb1")).count(),
        0
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from("bb2"))
            .collect::<Vec<_>>(),
        vec![&Name::from("start")]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from("bb3"))
            .collect::<Vec<_>>(),
        vec![&Name::from("start")]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from("bb4"))
            .collect::<Vec<_>>(),
        vec![&Name::from("bb2")]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from("bb5"))
            .collect::<Vec<_>>(),
        vec![&Name::from("bb6")]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from("bb6")).count(),
        0
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from("cleanup"))
            .collect::<Vec<_>>(),
        vec![&Name::from("start")]
    );
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from("cleanup1"))
            .collect::<Vec<_>>(),
        vec![&Name::from("start")]
    );
    // our algorithm doesn't consider unreachable blocks, so they are reported
    // as having no control dependencies
    assert_eq!(
        cdg.get_imm_control_dependencies(&Name::from("unreachable"))
            .count(),
        0
    );
}
