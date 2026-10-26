# Requirements

- Rust stable or nightly, to build painter
- LLVM 22 with development headers
- A second Rust toolchain with the `cargo` component for `--toolchain` (default `1.67`)
- Docker

# Toolchains

Crates are compiled with the `--toolchain` toolchain, and its bitcode must be readable by the LLVM
painter links against, so it must not ship a newer LLVM than 22. Rust 1.96.1 (LLVM 22) works; Rust
1.99 (LLVM 23) does not, and `llvm-ir` prints `error: Invalid record` and exits on its bitcode.

```
rustup toolchain install stable
rustup toolchain install 1.96.1
```

# LLVM

The `llvm-22` feature of `llvm-ir-analysis` (`Cargo.toml`) must match the installed LLVM major
version. `llvm-sys` finds `llvm-config` on `PATH`, or under `LLVM_SYS_221_PREFIX`.

Debian / Ubuntu ([apt.llvm.org](https://apt.llvm.org), as CI does):

```
wget https://apt.llvm.org/llvm.sh
sudo bash llvm.sh 22
sudo apt-get install llvm-22-dev libpolly-22-dev zlib1g-dev libzstd-dev libtinfo-dev libxml2-dev
export LLVM_SYS_221_PREFIX=/usr/lib/llvm-22
```

From source:

```
git clone --depth=1 -b release/22.x https://github.com/llvm/llvm-project.git llvm22-src
cmake -S llvm22-src/llvm -B llvm22-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$PWD/llvm22-bin
cmake --build llvm22-build --target install
export LLVM_SYS_221_PREFIX=$PWD/llvm22-bin
```

The `llvm-ir` fork has features `llvm-9` through `llvm-22`; for another LLVM change the feature and
the `LLVM_SYS_<ver>_PREFIX` variable.

# Build

`llvm-ir` and `llvm-ir-analysis` are submodules: clone with `--recurse-submodules` or run
`git submodule update --init`.

```
git clone --recurse-submodules https://github.com/rustfoundation/painter
cd painter
cargo build --release
```

CI runs:

```
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
PAINTER_TEST_TOOLCHAIN=1.96.1 cargo test --all-targets
```
