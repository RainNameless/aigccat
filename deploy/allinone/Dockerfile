# aigccat 单容器镜像
#
# 一个镜像装齐四件事：MinIO（存储）+ web（Rust 后端）+ gateway（鉴权入口）
# + opencode（AI 绑骨执行器）。进程编排与首次启动自举见 deploy/allinone/supervisor.mjs。
#
# 构建（在仓库根目录，context 必须是根目录）：
#   docker build -f deploy/allinone/Dockerfile -t aigccat:allinone .
#
# 基础镜像选 debian bookworm 是必须的：web 的 Rust 二进制编译自 rust:1-slim-bookworm
# （glibc 动态链接），换 Alpine(musl) 这个二进制直接跑不起来；opencode 侧原本也基于 bookworm。

# 全局 ARG：必须在第一个 FROM 之前声明，否则 FROM 取不到它的值。
# 用 quay.io 而不是 Docker Hub —— MinIO 已把 `minio/minio` 从 Docker Hub 下架（实测该仓库 404）。
ARG MINIO_IMAGE=quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z

# ───────────────────────── 阶段 1：编译 Rust 后端 ─────────────────────────
FROM rust:1-slim-bookworm AS webbuilder

ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY="localhost,127.0.0.1"

# crates.io 镜像（rsproxy.cn，免代理直连；删掉本段即回官方源）
RUN mkdir -p /usr/local/cargo && printf '%s\n' \
    '[source.crates-io]' \
    'replace-with = "rsproxy-sparse"' \
    '[source.rsproxy-sparse]' \
    'registry = "sparse+https://rsproxy.cn/index/"' \
    '[net]' \
    'git-fetch-with-cli = true' \
    > /usr/local/cargo/config.toml

WORKDIR /app
# 先只拷 Cargo.toml 编一层依赖缓存（dummy main），改业务代码时不必重编依赖
COPY web/Cargo.toml ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src
COPY web/src ./src
COPY web/assets ./assets
RUN touch src/main.rs && cargo build --release

# ───────────────────────── 阶段 2：取 MinIO 二进制 ─────────────────────────
# 直接搬官方镜像里的静态二进制（105MB），避免用户构建时还要另外下载。
#
# ⚠ 必须用 quay.io 而不是 Docker Hub：MinIO 已把 `minio/minio` 从 Docker Hub 下架
# （2026-09 实测 hub.docker.com 上该仓库返回 404，而 library/nginx 正常），
# 在 CI 上会直接报 `pull access denied ... insufficient_scope`。quay.io 是官方发布源，匿名可拉。
# 版本号固定是为了可复现，要升级改文件顶部的 MINIO_IMAGE。
FROM ${MINIO_IMAGE} AS minio

# ───────────────────────── 阶段 3：运行时 ─────────────────────────
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.18.31
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
# Debian 源默认用官方源；国内构建可传 --build-arg APT_MIRROR=mirrors.aliyun.com
# 另外装了重试：直连官方源偶尔会 502，重试几次即可。
ARG APT_MIRROR=""

RUN set -eux; \
    if [ -n "$APT_MIRROR" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        [ -f "$f" ] && sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" "$f"; \
      done; \
    fi; \
    apt-get update -o Acquire::Retries=8; \
    apt-get install -y --no-install-recommends --fix-missing \
      ca-certificates curl git ripgrep python3 tini; \
    rm -rf /var/lib/apt/lists/*

# 存储
COPY --from=minio /usr/bin/minio /usr/local/bin/minio

# 后端与前端（前端直接烤进镜像，不依赖 bind mount，别人怎么跑都一致）
COPY --from=webbuilder /app/target/release/aigccat-web /srv/aigccat-web
COPY web/static /srv/static

# 鉴权网关。放在 /srv/auth-server 而不是 /app —— /app 要留给 opencode-runner，
# 它的 server.cjs 硬编码了 /app/node_modules 与 /app/blender.ts。
COPY scripts/auth-server /srv/auth-server

# AI 绑骨执行器（必须在 /app）
WORKDIR /app
COPY scripts/opencode-runner/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY scripts/opencode-runner/ ./
RUN npm install -g opencode-ai@${OPENCODE_VERSION} --no-audit --no-fund

# 启动器
COPY deploy/allinone/supervisor.mjs /srv/supervisor.mjs

ENV NODE_ENV=production \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    AIGCCAT_DATA=/data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/login.html >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/srv/supervisor.mjs"]
