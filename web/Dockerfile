# ---- 构建阶段 ----
FROM rust:1-slim-bookworm AS builder

# 构建期代理（可选，由 compose build.args 注入；cargo/crates.io 走 HTTPS_PROXY）
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY="localhost,127.0.0.1"

# crates.io 国内镜像（rsproxy.cn，免代理直连；删掉本段即回官方源）
RUN mkdir -p /usr/local/cargo && printf '%s\n' \
    '[source.crates-io]' \
    'replace-with = "rsproxy-sparse"' \
    '[source.rsproxy-sparse]' \
    'registry = "sparse+https://rsproxy.cn/index/"' \
    '[net]' \
    'git-fetch-with-cli = true' \
    > /usr/local/cargo/config.toml

WORKDIR /app

# 先拷 Cargo.toml 编一层依赖缓存（dummy main）
COPY Cargo.toml ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src

# 再拷真实源码与分类目录全量构建
COPY src ./src
COPY assets ./assets
RUN touch src/main.rs && cargo build --release

# ---- 运行阶段（单静态二进制） ----
FROM debian:bookworm-slim
RUN useradd -r -u 10001 aigccat && mkdir -p /srv/config && chown aigccat:aigccat /srv/config && chmod 700 /srv/config
WORKDIR /srv
COPY --from=builder /app/target/release/aigccat-web /srv/aigccat-web
COPY static /srv/static
USER aigccat
EXPOSE 8080
ENV PORT=8080
CMD ["/srv/aigccat-web"]
