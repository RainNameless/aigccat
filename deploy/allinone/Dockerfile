# aigccat 单容器镜像
#
# 一个镜像装齐：MinIO（存储）+ web（Rust 后端）+ gateway（鉴权入口）
# + opencode（AI 绑骨执行器）+ Blender 5.2（几何处理：减面/重拓扑/部件编辑/绑骨）。
# 进程编排与首次启动自举见 deploy/allinone/supervisor.mjs。
#
# 构建（在仓库根目录，context 必须是根目录）：
#   docker build -f deploy/allinone/Dockerfile -t aigccat:allinone .
#
# 基础镜像选 debian bookworm 是必须的：web 的 Rust 二进制编译自 rust:1-slim-bookworm
# （glibc 动态链接），换 Alpine(musl) 这个二进制直接跑不起来；opencode 侧原本也基于 bookworm。

# 全局 ARG：必须在第一个 FROM 之前声明，否则 FROM 取不到它的值。
# 用 quay.io 而不是 Docker Hub —— MinIO 已把 `minio/minio` 从 Docker Hub 下架（实测该仓库 404）。
ARG MINIO_IMAGE=quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z
ARG BLENDER_VERSION=5.2.1

# 基础镜像默认取官方；国内网络拉 Docker Hub 困难时可以指向镜像站，例如：
#   --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim \
#   --build-arg RUST_IMAGE=docker.m.daocloud.io/library/rust:1-slim-bookworm \
#   --build-arg DEBIAN_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim
# CI（GitHub runner）不传这些，走官方源。
ARG RUST_IMAGE=rust:1-slim-bookworm
ARG DEBIAN_IMAGE=debian:bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

# ───────────────────────── 阶段 1：编译 Rust 后端 ─────────────────────────
FROM ${RUST_IMAGE} AS webbuilder

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

# ───────────────────────── 阶段 3：取 Blender 5.2 ─────────────────────────
# 减面 / 体素重拓扑 / 部件编辑 / 自动绑骨都由 Blender 完成，而项目代码**硬要求 5.2**：
#   run_isolated_script.py:100  assert bpy.app.version[:2] == (5, 2)
#   character_engine.py:66      同上
#   rig_engine.py:344           用了 5.2 才有的 slotted actions（legacy fcurves 已移除）
# 实测 Debian 自带的 Blender 3.4.1：能启动、能建网格，但 decimate/remesh 报 Traceback、rig 直接拒绝
# —— 版本不对一行都跑不通，所以必须装官方版。
#
# ⚠ Blender 官方**只有 Linux x64**：5.2 目录里 linux 只有 `-linux-x64.tar.xz`，
# 而 macos-arm64 / windows-arm64 都有 —— 也就是说**没有 Linux arm64 版**。
#
# 所以按架构分支：amd64 装官方 Blender（容器内跑，实测 decimate 45s / remesh 18s / rig 20s）；
# arm64 装不了 → 镜像里不含 Blender，运行时由 supervisor 自动改用宿主机的 Blender。
# 两种镜像共用同一份 supervisor，靠「Blender 二进制在不在」判断，不维护两套代码。
#
# ⚠ 试过「整个镜像做 amd64、Apple Silicon 走 Rosetta」，**行不通**：
#   MinIO 是 Go 写的，在 Rosetta 下会崩 ——
#   `runtime: lfstack.push invalid packing: node=0xffff... -> node=0xffffffff...`
#   （Go runtime 指针在 Rosetta 下的已知问题）。Blender 是 C++，反而能在 Rosetta 下跑。
FROM ${DEBIAN_IMAGE} AS blender

ARG BLENDER_VERSION
ARG TARGETARCH
ARG APT_MIRROR=""
# download.blender.org 会挡某些网络的直连（实测直连 403、走代理 200），
# 所以单独给它一个可选的代理参数，不影响其余阶段（apt 走国内源、npm 直连都正常）。
#   --build-arg CURL_PROXY=http://host.docker.internal:7897
ARG CURL_PROXY=""

RUN set -eux; \
    if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get update -o Acquire::Retries=8; \
    apt-get install -y --no-install-recommends curl xz-utils ca-certificates; \
    mkdir -p /opt/blender; \
    if [ "$TARGETARCH" = "amd64" ]; then \
      curl -fsSL --retry 3 ${CURL_PROXY:+--proxy "$CURL_PROXY"} -o /tmp/blender.tar.xz \
        "https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/blender-${BLENDER_VERSION}-linux-x64.tar.xz"; \
      tar xf /tmp/blender.tar.xz -C /tmp; \
      rm -f /tmp/blender.tar.xz; \
      rm -rf /opt/blender; \
      mv "/tmp/blender-${BLENDER_VERSION}-linux-x64" /opt/blender; \
      /opt/blender/blender --version | head -1; \
    else \
      echo "Blender 官方没有 Linux ${TARGETARCH} 版，本镜像不含 Blender；运行时将用宿主机的"; \
      touch /opt/blender/.no-local-blender; \
    fi

# ───────────────────────── 阶段 4：运行时 ─────────────────────────
FROM ${NODE_IMAGE}

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
    apt-get install -y --no-install-recommends --fix-missing \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxinerama1 libxrandr2 libxcursor1 \
      libxkbcommon0 libxkbcommon-x11-0 libegl1 libegl-mesa0 libgl1 libgl1-mesa-dri \
      libsm6 libice6 libgomp1 libdbus-1-3 libfontconfig1 libfreetype6 libharfbuzz0b \
      libpulse0 libasound2 libsndfile1 \
      libx11-xcb1 libxcb1 libxcb-glx0 libxcb-xfixes0 libxcb-shape0 libxcb-xkb1 \
      libxcb-icccm4 libxcb-keysyms1 libxcb-randr0 libxcb-render0 libxcb-render-util0 \
      libxcb-shm0 libxcb-sync1 libxcb-xinerama0 libxcb-image0 libxcb-util1; \
    rm -rf /var/lib/apt/lists/*

# Blender 5.2（上面那批是它无头运行需要的图形库；容器里没有 GPU，渲染走软件实现）
COPY --from=blender /opt/blender /opt/blender
RUN if [ -x /opt/blender/blender ]; then \
      ln -sf /opt/blender/blender /usr/local/bin/blender; \
      blender --version | head -1; \
    else \
      echo "本镜像不含 Blender（该架构没有官方构建），运行时用宿主机上的"; \
    fi

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

# ─────────────── 内置浏览器：网页订阅登录用 ───────────────
# 原来「打开登录窗口」是让**宿主机**弹一个真窗口，于是宿主机上必须常驻一个执行器进程。
# 这里改成在容器内自己造一块虚拟屏幕 + 一个真浏览器 + VNC 服务，
# 画面经 gateway 转发到网页里内嵌显示 —— 宿主机上不再需要任何东西。
# 容器没有物理显示器，所以用 Xvfb 提供 DISPLAY，浏览器仍以「有头」方式跑
# （headless 会被 Cloudflare 识破；有头 + 真显示才是能过校验的组合）。
ARG PLAYWRIGHT_DOWNLOAD_HOST=""
ENV DISPLAY=:99
RUN set -eux; \
    apt-get update -o Acquire::Retries=10; \
    apt-get install -y --no-install-recommends --fix-missing \
      -o Acquire::Retries=10 -o Acquire::http::Pipeline-Depth=0 \
      xvfb x11vnc novnc websockify \
      fonts-liberation fonts-noto-cjk; \
    rm -rf /var/lib/apt/lists/*

# 会话执行器（Playwright 驱动的登录窗口 + 会话校验）。
# 与宿主机用的是同一份代码：靠 STUDIO_STATE_DIR / DISPLAY 环境变量切换，不改业务逻辑。
WORKDIR /srv/studio-runner
COPY scripts/studio-runner/package.json scripts/studio-runner/package-lock.json ./
RUN set -eux; \
    if [ -n "$PLAYWRIGHT_DOWNLOAD_HOST" ]; then export PLAYWRIGHT_DOWNLOAD_HOST="$PLAYWRIGHT_DOWNLOAD_HOST"; fi; \
    npm install --omit=dev --no-audit --no-fund
COPY scripts/studio-runner/ ./
RUN set -eux; \
    if [ -n "$PLAYWRIGHT_DOWNLOAD_HOST" ]; then export PLAYWRIGHT_DOWNLOAD_HOST="$PLAYWRIGHT_DOWNLOAD_HOST"; fi; \
    npx playwright install --with-deps chromium; \
    node -e "const {chromium}=require('playwright');console.log('chromium:',chromium.executablePath())"

# 启动器
COPY deploy/allinone/supervisor.mjs /srv/supervisor.mjs

# Blender 工作器的脚本（减面/重拓扑/部件编辑/绑骨）。
# worker_server.py 用 BLENDER_BIN 环境变量定位 Blender，所以同一份代码
# 在宿主上指向 Blender.app、在容器里指向 /opt/blender —— 不用改一行。
COPY scripts/blender /srv/blender

ENV NODE_ENV=production \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    AIGCCAT_DATA=/data \
    BLENDER_BIN=/opt/blender/blender \
    STUDIO_STATE_DIR=/data/studio

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/login.html >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/srv/supervisor.mjs"]
