#   docker build -t painter .
#   docker run --rm --network host --cpus 12 --memory 16g --memory-swap 16g \
#       -v /storage/crates/index:/data/index -v /storage/crates/crates:/data/crates:ro \
#       -v "$PWD/sources":/data/sources -v "$PWD/bytecodes":/data/bytecodes \
#       -v painter-cargo-registry:/usr/local/cargo/registry \
#       painter compile-all --toolchain 1.96.1 --only serde \
#       -s /data/sources -c /data/crates -b /data/bytecodes
#
# Limits cannot live in an image; Rust's available_parallelism honors --cpus (nproc does not).
# --network host reaches the host neo4j at bolt://127.0.0.1:7687. Outputs are root-owned.
# Toolchain bitcode must be readable by LLVM 22 (what painter links): no toolchain that ships
# a newer LLVM (stable 1.99 ships LLVM 23).

ARG DEBIAN_CODENAME=bookworm
ARG LLVM_VERSION=22

FROM rust:1-${DEBIAN_CODENAME} AS builder
ARG DEBIAN_CODENAME
ARG LLVM_VERSION

# llvm-sys links LLVM statically: needs Polly and LLVM's system libs.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates gnupg wget; \
    wget -qO- https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /usr/share/keyrings/llvm.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/llvm.gpg] http://apt.llvm.org/${DEBIAN_CODENAME}/ llvm-toolchain-${DEBIAN_CODENAME}-${LLVM_VERSION} main" \
        > /etc/apt/sources.list.d/llvm.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        llvm-${LLVM_VERSION}-dev libpolly-${LLVM_VERSION}-dev \
        zlib1g-dev libzstd-dev libtinfo-dev libxml2-dev libssl-dev pkg-config cmake; \
    rm -rf /var/lib/apt/lists/*

ENV LLVM_SYS_221_PREFIX=/usr/lib/llvm-${LLVM_VERSION}

WORKDIR /src
# Cargo.lock is gitignored; the glob tolerates its absence.
COPY Cargo.toml Cargo.lock* ./
COPY llvm-ir llvm-ir
COPY llvm-ir-analysis llvm-ir-analysis
COPY src src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --bin painter \
    && install -D target/release/painter /out/bin/painter

FROM debian:${DEBIAN_CODENAME}-slim
ARG PAINTER_TOOLCHAINS="1.67 1.96.1"

# Compiled crates run their own build scripts and probe for -sys dev packages.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl git build-essential pkg-config cmake \
        libssl-dev zlib1g-dev libzstd-dev libxml2-dev libtinfo6; \
    rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN set -eux; \
    curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none; \
    for tc in ${PAINTER_TOOLCHAINS}; do rustup toolchain install "$tc" --profile minimal; done; \
    rustup default "${PAINTER_TOOLCHAINS##* }"; \
    rm -rf "$RUSTUP_HOME/downloads" "$RUSTUP_HOME/tmp"; \
    for tc in ${PAINTER_TOOLCHAINS}; do cargo "+$tc" --version; done

# sccache is inert unless RUSTC_WRAPPER=sccache. The analyzed crate (--emit=llvm-bc), proc
# macros, and build scripts are never cached.
ARG SCCACHE_VERSION=0.18.0
ARG SCCACHE_SHA256=45f1447fbe231e3037bde351ef70677dd212216c8d62ae7ca409fecc4d6acc89
RUN set -eux; \
    f="sccache-v${SCCACHE_VERSION}-x86_64-unknown-linux-musl"; \
    curl -sSfL -o /tmp/sccache.tar.gz \
        "https://github.com/mozilla/sccache/releases/download/v${SCCACHE_VERSION}/$f.tar.gz"; \
    echo "${SCCACHE_SHA256}  /tmp/sccache.tar.gz" | sha256sum -c -; \
    tar xzf /tmp/sccache.tar.gz -C /tmp; \
    install -m 755 "/tmp/$f/sccache" /usr/local/bin/sccache; \
    rm -rf /tmp/sccache.tar.gz "/tmp/$f"; \
    sccache --version

COPY --from=builder /out/bin/painter /usr/local/bin/

# The index is a bind-mounted git clone owned by the host user; let libgit2 open it as root.
RUN git config --system --add safe.directory '*'

# compile-all runs up to -j cargo processes (one per CPU), so cap rustc jobs per process:
# 12 CPUs make at most 24 rustc processes, not 144.
ENV PAINTER_INDEX_PATH=/data/index \
    RUST_LOG=info \
    CARGO_BUILD_JOBS=2
VOLUME ["/data/index", "/data/crates", "/data/sources", "/data/bytecodes"]
WORKDIR /data

ENTRYPOINT ["painter"]
CMD ["--help"]
