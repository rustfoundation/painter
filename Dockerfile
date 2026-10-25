# painter: every subcommand, including compile-all, inside one image.
#
#   docker build -t painter .
#   docker run --rm --network host --cpus 12 --memory 16g --memory-swap 16g \
#       -v /storage/crates/index:/data/index -v /storage/crates/crates:/data/crates:ro \
#       -v "$PWD/sources":/data/sources -v "$PWD/bytecodes":/data/bytecodes \
#       -v painter-cargo-registry:/usr/local/cargo/registry \
#       painter compile-all --toolchain 1.96.1 --only serde \
#       -s /data/sources -c /data/crates -b /data/bytecodes
#
# CPU and memory limits cannot live in an image; pass them to `docker run` as above.
# --memory-swap equal to --memory forbids extra swap. Rust's available_parallelism honors
# --cpus, so compile-all's default -j and cargo's job count follow it (nproc does not).
# --network host reaches the host neo4j at bolt://127.0.0.1:7687. Outputs are root-owned.
#
# compile-all shells out to `cargo +<toolchain> rustc`, so the runtime image carries rustup and
# the ecosystem compile toolchains (PAINTER_TOOLCHAINS) next to the painter binary. Their
# bitcode must be readable by LLVM 22 (what painter links), so do not add toolchains that ship
# a newer LLVM (stable 1.99 ships LLVM 23).

ARG DEBIAN_CODENAME=bookworm
ARG LLVM_VERSION=22

FROM rust:1-${DEBIAN_CODENAME} AS builder
ARG DEBIAN_CODENAME
ARG LLVM_VERSION

# llvm-sys links LLVM statically: it needs the dev package, Polly, and LLVM's system libs.
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

RUN cargo install --locked --root /out count-unsafe

WORKDIR /src
# Cargo.lock is gitignored; the glob copies it when present and builds unlocked otherwise.
COPY Cargo.toml Cargo.lock* ./
COPY llvm-ir llvm-ir
COPY llvm-ir-analysis llvm-ir-analysis
COPY src src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --bin painter \
    && cp target/release/painter /out/bin/painter

FROM debian:${DEBIAN_CODENAME}-slim
ARG PAINTER_TOOLCHAINS="1.67 1.96.1"

# Crates compiled by compile-all run their own build scripts, so give them the usual native
# toolchain and the -dev packages most -sys crates probe for.
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

COPY --from=builder /out/bin/painter /out/bin/count-unsafe /usr/local/bin/

# The index is a bind-mounted git clone owned by the host user; let libgit2 open it as root.
RUN git config --system --add safe.directory '*'

# Mount points: index clone, .crate store, extracted sources,
# bytecode output. CARGO_HOME/registry is worth a volume too so dependency downloads persist.
# CARGO_BUILD_JOBS caps rustc jobs per cargo process: compile-all runs up to -j cargo
# processes (one per CPU by default), so 12 CPUs make at most 24 rustc processes, not 144.
# Override with -e CARGO_BUILD_JOBS=N.
ENV PAINTER_INDEX_PATH=/data/index \
    RUST_LOG=info \
    CARGO_BUILD_JOBS=2
VOLUME ["/data/index", "/data/crates", "/data/sources", "/data/bytecodes"]
WORKDIR /data

ENTRYPOINT ["painter"]
CMD ["--help"]
