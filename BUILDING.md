# Requirements

- Rust nightly (2013-07-26)
- Rust 1.60 toolchain 
- LLVM 14.x
- Docker 

# Installing Rust toolchains
Note that we require using nightly for some features, *as well as* having rustc 1.60 installed for analysis. This means 
you'll need to install two rust toolchains.

```
rustup toolchain install nightly
rustup toolchain install 1.60
```

# Building and using LLVM

Different environments will run into issues with the local version of llvm. Using painter requires llvm 14.x to be installed
for the current version of `rustc` we operate with (1.60). If painter does not work with your OS version of LLVM,
you may need to build a local vendored copy of LLVM to use. 

Assumed Example Build Directory Layout
```
    /tmp/llvm14-src
    /tmp/llvm14-bin
    /tmp/llvm14-build
```

*Building and Installing LLVM*
```
cd /tmp
git clone --depth=1 -b release/14.x https://github.com/llvm/llvm-project.git llvm14-src
mkdir llvm14-build && mkdir llvm14-bin
pushd llvm14-build
  cmake ../llvm14-src/llvm
  cmake --build .
  cmake -DCMAKE_INSTALL_PREFIX=../llvm14-bin -P cmake_install.cmake
popd
```

## Build Painter

Once you have a local built copy of LLVM, you'll need to specify the location of the installation via 
the `LLVM_SYS_140_PREFIX` environment variable.

```
git clone --recurse-submodules https://github.com/rustfoundation/painter
cd painter
LLVM_SYS_140_PREFIX=/tmp/llvm14-bin cargo build
```