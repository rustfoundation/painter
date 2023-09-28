# `llvm-ir-analysis`: Static analysis of LLVM IR

[![crates.io](https://img.shields.io/crates/v/llvm-ir-analysis.svg)](https://crates.io/crates/llvm-ir-analysis)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://raw.githubusercontent.com/cdisselkoen/llvm-ir-analysis/main/LICENSE)

This crate provides several simple static analyses of LLVM IR.
In particular, this crate computes the following on an [`llvm-ir`] `Module` or `Function`:

- [`CallGraph`](https://docs.rs/llvm-ir-analysis/latest/llvm_ir_analysis/struct.CallGraph.html)
- [`ControlFlowGraph`](https://docs.rs/llvm-ir-analysis/latest/llvm_ir_analysis/struct.ControlFlowGraph.html)
- [`DominatorTree`](https://docs.rs/llvm-ir-analysis/latest/llvm_ir_analysis/struct.DominatorTree.html)
- [`PostDominatorTree`](https://docs.rs/llvm-ir-analysis/latest/llvm_ir_analysis/struct.PostDominatorTree.html)
- [`ControlDependenceGraph`](https://docs.rs/llvm-ir-analysis/latest/llvm_ir_analysis/struct.ControlDependenceGraph.html)
- [`FunctionsByType`](https://docs.rs/llvm-ir-analysis/latest/llvm_ir_analysis/struct.FunctionsByType.html)

The above analyses are provided by the [`FunctionAnalysis`],
[`ModuleAnalysis`], and [`CrossModuleAnalysis`] objects, which lazily compute
each of these structures on demand and cache the results.

## Getting started

`llvm-ir-analysis` is on [crates.io](https://crates.io/crates/llvm-ir-analysis),
so you can simply add it as a dependency in your `Cargo.toml`, selecting the
feature corresponding to the LLVM version you want:
```toml
[dependencies]
llvm-ir-analysis = { version = "0.3.2", features = ["llvm-14"] }
```
Currently, the supported LLVM versions are `llvm-8`, `llvm-9`, `llvm-10`,
`llvm-11`, `llvm-12`, `llvm-13`, and `llvm-14`.
The corresponding LLVM library must be available on your system; see the
[`llvm-sys`] README for more details and instructions.

You'll also need some LLVM IR to analyze, in the form of an [`llvm-ir`]
[`Module`] or [`Function`].
This can be easily generated from an LLVM bitcode file; for more detailed
instructions, see [`llvm-ir`'s README](https://crates.io/crates/llvm-ir).

Once you have a `Module`, you can construct a [`ModuleAnalysis`] object:
```rust
let module = Module::from_bc_path(...)?;
let analysis = ModuleAnalysis::new(&module);
```

You can get `Module`-wide analyses such as `analysis.call_graph()`
directly from the `ModuleAnalysis` object.
You can also get `Function`-level analyses such as the control-flow
graph using `analysis.fn_analysis("my_func")`; or you can construct
a [`FunctionAnalysis`] directly with `FunctionAnalysis::new()`.

Finally, you can get multi-module analyses such as a cross-module
call graph by starting with a [`CrossModuleAnalysis`] instead of just
a [`ModuleAnalysis`]. The [`CrossModuleAnalysis`] also provides a
[`ModuleAnalysis`] for each of the included modules, again computed
lazily on demand.

[`llvm-ir`]: https://crates.io/crates/llvm-ir
[`llvm-sys`]: https://crates.io/crates/llvm-sys
[`Module`]: https://docs.rs/llvm-ir/latest/llvm_ir/module/struct.Module.html
[`Function`]: https://docs.rs/llvm-ir/latest/llvm_ir/function/struct.Function.html
[`ModuleAnalysis`]: https://docs.rs/llvm-ir-analysis/latest/llvm_ir_analysis/struct.ModuleAnalysis.html
[`FunctionAnalysis`]: https://docs.rs/llvm-ir-analysis/latest/llvm_ir_analysis/struct.FunctionAnalysis.html
[`CrossModuleAnalysis`]: https://docs.rs/llvm-ir-analysis/latest/llvm_ir_analysis/struct.CrossModuleAnalysis.html
