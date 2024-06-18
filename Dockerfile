FROM alpine:latest

RUN apk add --no-cache \
        ca-certificates \
        gcc

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    RUST_VERSION=nightly

RUN set -eux; \
    apkArch="$(apk --print-arch)"; \
    case "$apkArch" in \
        x86_64) rustArch='x86_64-unknown-linux-musl'; rustupSha256='1455d1df3825c5f24ba06d9dd1c7052908272a2cae9aa749ea49d67acbe22b47' ;; \
        aarch64) rustArch='aarch64-unknown-linux-musl'; rustupSha256='7087ada906cd27a00c8e0323401a46804a03a742bd07811da6dead016617cc64' ;; \
        *) echo >&2 "unsupported architecture: $apkArch"; exit 1 ;; \
    esac; \
    url="https://static.rust-lang.org/rustup/archive/1.27.1/${rustArch}/rustup-init"; \
    wget "$url"; \
    echo "${rustupSha256} *rustup-init" | sha256sum -c -; \
    chmod +x rustup-init; \
    ./rustup-init -y --no-modify-path --profile minimal --default-toolchain $RUST_VERSION --default-host ${rustArch}; \
    rm rustup-init; \
    chmod -R a+w $RUSTUP_HOME $CARGO_HOME; \
    rustup --version; \
    cargo --version; \
    rustc --version;

WORKDIR /app
ENV RUSTFLAGS="-Ctarget-feature=-crt-static -Lnative=/usr/lib"

RUN apk add --update pkgconf build-base musl-dev libc++-dev libc++-static openssl-dev llvm15-static llvm15-dev

COPY ./src src
COPY ./llvm-ir llvm-ir
COPY ./llvm-ir-analysis llvm-ir-analysis
COPY ./Cargo.toml Cargo.toml

RUN cargo install --path .

FROM alpine:latest

RUN apk add --update llvm15 libc++-static libgcc openssl

COPY --from=0 /usr/local/cargo/bin/painter /bin/painter

CMD ["painter"]