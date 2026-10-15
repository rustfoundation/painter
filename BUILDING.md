# Requirements

- Rust stable or nightly, to build painter
- A second Rust toolchain with the `cargo` component, to compile the ecosystem (`--toolchain`, default `1.67`)
- LLVM 22 with development headers
- Docker

# Installing Rust toolchains

Painter itself builds on stable. Crates are compiled with a separate toolchain chosen with
`--toolchain`; its bitcode must be readable by the LLVM painter links against, so it must not ship a
newer LLVM than 22. Rust 1.96.1 (LLVM 22) works; Rust 1.99 (LLVM 23) does not, and reading its
bitcode makes `llvm-ir` print `error: Invalid record` and exit.

```
rustup toolchain install stable
rustup toolchain install 1.96.1
```

# Installing LLVM

`Cargo.toml` enables the `llvm-22` feature of `llvm-ir-analysis`, which uses `llvm-sys` 221. The
feature must match the major version of the installed LLVM. `llvm-sys` finds `llvm-config` on
`PATH`, or under `LLVM_SYS_221_PREFIX` when that is set.

Debian / Ubuntu, from [apt.llvm.org](https://apt.llvm.org) (what CI uses):

```
wget https://apt.llvm.org/llvm.sh
sudo bash llvm.sh 22
sudo apt-get install llvm-22-dev libpolly-22-dev zlib1g-dev libzstd-dev libtinfo-dev libxml2-dev
export LLVM_SYS_221_PREFIX=/usr/lib/llvm-22
```

To build LLVM from source instead:

```
git clone --depth=1 -b release/22.x https://github.com/llvm/llvm-project.git llvm22-src
cmake -S llvm22-src/llvm -B llvm22-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$PWD/llvm22-bin
cmake --build llvm22-build --target install
export LLVM_SYS_221_PREFIX=$PWD/llvm22-bin
```

The vendored `llvm-ir` fork has features `llvm-9` through `llvm-22`; to use another LLVM, change
the `llvm-22` feature in `Cargo.toml` and the matching `LLVM_SYS_<ver>_PREFIX` variable.

# Build Painter

`llvm-ir` and `llvm-ir-analysis` are git submodules, so clone recursively (or run
`git submodule update --init` in an existing clone).

```
git clone --recurse-submodules https://github.com/rustfoundation/painter
cd painter
cargo build --release
```

Checks CI runs on every pull request:

```
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
PAINTER_TEST_TOOLCHAIN=1.96.1 cargo test --all-targets
```
