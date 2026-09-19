# 部署指南

覆盖四种形态：**单容器**（最省事，推荐）、**多容器本机开发**、**可选工作器**（换用你自己的 Blender）、**公网自托管**。

---

## 0. 组件与端口

| 组件 | 端口 | 必需 | 说明 |
|---|---|---|---|
| `gateway` | `8080`（唯一对外） | ✅ | 统一鉴权；未登录跳 `/login.html` |
| `web` | 容器内 `8080` | ✅ | Rust + axum，不发布宿主端口 |
| `minio` | `9000` / `9001` | ✅ | 资产唯一事实来源 |
| `opencode` | 内部 `4097` | 可选 | AI 绑骨所需 |
| **Blender 5.2** | 容器内 `8788` | ✅（单容器自带） | 减面 / 重拓扑 / 部件编辑 / 自动绑骨 |
| OpenCode → Blender 桥接 | 容器内 `8791` | 可选 | AI 写 Blender 脚本 |
| Studio 执行器（含登录窗口） | 容器内 `8790` | 可选 | 网页订阅会话生成；登录窗口内嵌在网页里（Xvfb + Chromium + noVNC） |

**单容器版把 Blender 5.2 也打进镜像了** —— 减面、重拓扑、部件编辑、自动绑骨开箱可用，不用另装 Blender。
**订阅登录的浏览器也在容器里**：容器自带一块虚拟屏幕 + Chromium + VNC，「登录窗口」是内嵌在
网页对话框里的一幅画面，你直接在页面上点、输入、收验证码（见 [`STUDIO-SESSION.md`](STUDIO-SESSION.md)）。
**宿主机上不需要装任何东西。**

> ⚠ 镜像有 **amd64 / arm64** 两个版本（Docker 自动选）。差别只在 Blender：
> **amd64 版自带 Blender 5.2**（实测容器内 decimate 45s / remesh 18s / rig 20s）；
> **arm64 版不含**（Blender 官方没有 Linux arm64 版），此时容器自动改用宿主机的 Blender。

其余组件即使缺失也不会让服务起不来，界面会显示"不可达"，**不会伪造成功**。

---

## 1. 单容器（最快，推荐）

一个容器装齐存储、后端、鉴权与 AI 绑骨执行器，**不用本地编译、不用先配 `.env`**。

```bash
docker run -d --name aigccat -p 8080:8080 -v aigccat-data:/data \
  ghcr.io/rainnameless/aigccat:latest
```

> **关于 Blender**：amd64 版镜像**自带 Blender 5.2**，减面 / 重拓扑 / 部件编辑 / 自动绑骨
> 容器内直接可用。arm64 版不含 Blender —— Blender 官方只发布 Linux x64，没有 arm64 版
> （macOS 与 Windows 的 arm64 版都有，唯独 Linux 没有）。这种情况容器会自动改用
> **宿主机上的 Blender**，所以 Apple Silicon 上想用这些功能，装一个 Blender 即可。


打开 `http://localhost:8080`。初始管理员密码只在首次启动打印一次：

```bash
docker logs aigccat | grep -A2 初始账号
```

| 项 | 说明 |
|---|---|
| 数据 | 全在 `aigccat-data` 卷：对象存储 / 账号 / 配置 / AI 任务。**备份与迁移就是拷这一个卷** |
| 密钥 | MinIO 密码、机器令牌、初始账号在首次启动时自动生成，写入 `/data/aigccat.env`（权限 0600） |
| 固定密码 | 想自己指定就加 `-e AIGCCAT_ADMIN_PASSWORD=... -e MINIO_ROOT_PASSWORD=...` |
| 生成能力 | 加 `-e OPENAI_API_KEY=... -e OPENAI_BASE_URL=... -e OPENAI_MODEL=...`，`-e TRIPO_API_KEY=...`。不配也能跑，只是生成类功能不可用 |
| 公网反代 | 必须加 `-e AUTH_ORIGIN=https://你的域名`，否则鉴权只接受 localhost 与内网地址 |
| 架构 | `amd64` 与 `arm64` 都已发布；要固定版本把 `:latest` 换成 `:sha-xxxxxxx` |

用 compose 等价写法：

```bash
docker compose -f docker-compose.allinone.yml up -d          # 拉预构建镜像
docker compose -f docker-compose.allinone.yml up -d --build  # 或从源码本地构建
```

自己构建镜像时（国内直连 Debian 源偶尔 502，建议带 `APT_MIRROR`）：

```bash
docker build -f deploy/allinone/Dockerfile \
  --build-arg APT_MIRROR=mirrors.ustc.edu.cn -t aigccat:allinone .
```

amd64 镜像自带 Blender 5.2、AI 绑骨桥与订阅登录的浏览器（虚拟屏幕 + Chromium + noVNC），
**宿主机上不需要装任何东西**；arm64 镜像不含 Blender（官方没有 Linux arm64 版），减面/重拓扑/绑骨
会自动改用宿主机上装好的 Blender（见上方架构表）。

---

### 1.1 从多容器迁移到单容器

已经是多容器部署、想换成单容器（数据不丢）时按下面走。**先备份，别跳。**

```bash
# 0) 备份：三个 volume + 宿主账号库
BK=~/aigccat-migration-backup-$(date +%Y%m%d)
mkdir -p "$BK/volumes"
for v in minio_data services_config opencode_data; do
  docker run --rm -v aigccat_$v:/from:ro -v "$BK/volumes":/to alpine tar czf /to/$v.tgz -C /from .
done
cp -R ~/.config/aigccat/auth "$BK/host-auth"

# 1) 停旧栈（保留 volume，便于回滚）
docker compose -p aigccat -f docker-compose.yml down --remove-orphans

# 2) 建新卷，把旧数据并进同一个 /data
docker volume create aigccat-allinone_aigccat-data
docker run --rm \
  -v aigccat-allinone_aigccat-data:/data \
  -v aigccat_minio_data:/old-minio:ro -v aigccat_services_config:/old-config:ro \
  -v aigccat_opencode_data:/old-opencode:ro \
  -v "$HOME/.config/aigccat/auth/data":/old-auth-data:ro \
  -v "$HOME/.config/aigccat/auth/secrets":/old-auth-secrets:ro \
  alpine sh -c '
    mkdir -p /data/{minio,config,opencode,tasks,auth/data,auth/secrets}
    cp -a /old-minio/. /data/minio/;  cp -a /old-config/. /data/config/
    cp -a /old-opencode/. /data/opencode/
    cp -a /old-auth-data/. /data/auth/data/; cp -a /old-auth-secrets/. /data/auth/secrets/
    chmod 600 /data/auth/data/*.json /data/auth/secrets/*.token
    printf "AIGCCAT_PROXY_TOKEN=%s\nAIGCCAT_AUTOMATION_TOKEN=%s\n" \
      "$(cat /old-auth-secrets/proxy.token)" "$(cat /old-auth-secrets/automation.token)" > /data/aigccat.env
    chmod 600 /data/aigccat.env'

# 3) 起单容器（compose 会从根 .env 读 MINIO 密码与各服务 Key）
docker compose -f docker-compose.allinone.yml up -d
```

迁移后要确认的四件事：

1. **能登录**：用原来的账号密码（账号库是搬过来的，密码不变；启动器只在账号库为空时才会建新号并打印初始密码）
2. **资产数一致**：`curl -b cookies http://localhost:8080/api/assets | jq '.assets|length'`
3. **模型能下载**：取一个资产的 `.../file/versions/<ver>/model.glb` 应为 200 且是合法 GLB
4. **AI 绑骨桥活着**：进容器查 `http://127.0.0.1:4097/health`，`ready:true` 且 `blender` 有版本号（amd64 镜像里 Blender 就在容器内）

**回滚**：旧 volume 不会被动过。

```bash
docker compose -f docker-compose.allinone.yml down
docker compose -p aigccat -f docker-compose.yml up -d     # 回到多容器，数据还认得
```

> ⚠ 一个操作习惯要跟着改：多容器版把 `web/static` 和 `scripts/auth-server` **bind mount** 进容器，
> 改完刷新就生效；单容器里这些是**烤进镜像**的，改完要 `docker compose -f docker-compose.allinone.yml up -d --build` 才看得到。
> （想保留热更新，就继续用多容器版开发，单容器版专门用来分发/部署。）

---

## 2. 多容器：本机 / 内网

### 前置

- Docker Desktop
- 一个 OpenAI 兼容的文本模型端点（图片模型端点可选）、Tripo API Key（可选；Studio 链路另需你自己的订阅）

### 步骤

```bash
git clone https://github.com/RainNameless/aigccat.git
cd aigccat
cp .env.example .env
```

编辑 `.env`，至少设置：

```bash
MINIO_ROOT_PASSWORD=<一个强密码>
OPENAI_BASE_URL=<你的文本模型端点>
OPENAI_API_KEY=<...>
RIG_AGENT_TOKEN=<随机字符串，脚本与容器共用>
```

启动：

```bash
docker compose -p aigccat -f docker-compose.yml up -d
docker compose -p aigccat -f docker-compose.yml ps
```

打开 `http://localhost:8080`，首次访问会到登录页。初始管理员账号见部署时生成的
`~/.config/aigccat/cat-access.json`（权限 0600），**登录后请立即改密码**。

> 注册入口固定关闭。账号共享同一份资产库，**没有租户隔离**——这是单机自托管的设计取舍。

### 只重建 web（改后端时用）

```bash
docker compose -p aigccat -f docker-compose.yml build web && \
docker compose -p aigccat -f docker-compose.yml up -d --no-deps --no-build --pull never web
```

改 `web/static/` 下的前端**不需要重建**（已 bind mount），但**必须 bump 版本号**
（`index.html` 的 `?v=`，以及 `workbench.js` / `library.html` 里的 `viewer.js?v=`），否则浏览器用旧缓存。

---

## 3. 可选：改用你自己宿主上的 Blender

**单容器镜像里已经带了 Blender 5.2，这一节通常用不到。** 只有这几种情况才需要看：

- 你想用宿主上已经装好的 Blender（版本更新，或想共用同一份）
- 你在跑多容器版（`docker-compose.yml`）—— 它没有把 Blender 打进镜像

> ⚠ **arm64（Apple Silicon）镜像不含 Blender**：Blender 官方只发布 Linux x64，
> 没有 Linux arm64 构建。想要容器内自带 Blender，让 Docker 跑 **amd64** 那份镜像即可：
> Apple Silicon 上先在 Docker Desktop 打开 Rosetta 模拟（Settings → General 里那个
> "Use Rosetta for x86-64/amd64 emulation"），然后
> `DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose -f docker-compose.allinone.yml up -d`。
> **x86 的 Windows / Linux 服务器拉到的本来就是 amd64 那份，原生运行，什么都不用配。**

用宿主 Blender 覆盖容器内的默认（两个都要给，否则只会换掉一半）：

```bash
BLENDER_WORKER_URL=http://host.docker.internal:8788 \
RIG_HOST_URL=http://host.docker.internal:8791 \
  docker compose -f docker-compose.allinone.yml up -d
```

这样就得自己在宿主上把 Blender 工作器与绑骨桥跑起来。macOS 上历史做法是 launchd 常驻：

```bash
launchctl kickstart -k gui/$(id -u)/cn.aigccat.blender-worker
```

**不要把工作器当会话后台任务启动** —— 会话清理会带走进程，界面会显示"不可达"。
`kickstart` 前若端口被旧进程占用，需先 kill 真实 PID，否则新进程立即 `exited`。
不想再用宿主这份时，`python3 scripts/opencode-runner/install-host.py` 会把绑骨桥清退掉。

### 网页订阅的登录窗口：也在容器里，宿主机不需要装东西

早期版本要求先在宿主上装一个常驻执行器，因为「容器没屏幕，弹不出浏览器窗口」。
**这个限制已经不存在了**：单容器镜像内置了 Xvfb 虚拟屏幕 + Chromium + noVNC，
登录窗口是**网页里内嵌的一幅画面**（网关转发，复用 8080 端口，受现有登录鉴权保护）。

所以不需要执行任何安装命令 —— 起好容器，等界面出现 **「连接网页订阅」**，
点【打开登录窗口】直接在里面登录即可。

> 如果你以前装过宿主执行器（macOS 的 `cn.aigccat.studio-worker`），
> 跑 `python3 scripts/studio-runner/install.py` 会把旧的清退掉。
> 接入步骤与排查见 **[接入你自己的网页订阅会话](STUDIO-SESSION.md)**。

---

## 4. 公网自托管

链路：浏览器 → CDN → 服务器 Nginx（80）→ 回环 `18080` → 反向 SSH 隧道 → 本机 `8080`。

```bash
# 1) 安装隧道（生成受限密钥 + launchd 单元）
python3 scripts/deploy/cat-tunnel/install-tunnel.py

# 2) 在服务器上装 vhost（CDN 网段白名单 + 私有代理令牌）
python3 scripts/deploy/cat-tunnel/deploy-origin.py

# 3) 部署鉴权层
python3 scripts/auth-server/deploy-unified.py
```

模板见 `scripts/auth-server/nginx-unified.conf` 与
`scripts/deploy/cat-tunnel/public-entry.conf`——**里面的域名与地址都是占位符，必须替换成你自己的**。

注意：

- 服务跑在你的机器上，**机器关机或休眠公网即不可达**
- 无源站证书时为 HTTP 回源，**不要宣称端到端 TLS**
- Nginx 的 `client_max_body_size 768m` 不代表 CDN 侧允许同等体积，大文件上传受 CDN 套餐限制
- 不要开启 CDN 的 "Cache Everything"，会缓存动态接口

---

## 5. 常见问题

**Docker Hub 拉不到基础镜像**

改用镜像源拉取后 `docker tag` 成标准名，**不要改 Dockerfile**：

```bash
docker pull docker.m.daocloud.io/library/rust:1-slim-bookworm
docker tag  docker.m.daocloud.io/library/rust:1-slim-bookworm rust:1-slim-bookworm
docker pull docker.m.daocloud.io/library/debian:bookworm-slim
docker tag  docker.m.daocloud.io/library/debian:bookworm-slim debian:bookworm-slim
```

**所有 docker 命令都报 `docker-credential-desktop: executable file not found`**

凭据助手不在 PATH：

```bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
```

**后端测试报 multipart 编译错误**

必须同时挂载 `Cargo.toml`，只挂 `src/` 会误报：

```bash
docker run --rm --network none \
  -v ./web/src:/app/src:ro -v ./web/Cargo.toml:/app/Cargo.toml:ro \
  aigccat-web-builder:compression-check cargo test --offline
```

**查代码引用时 grep 结果不对**

macOS 自带 grep 不支持 `\b` 和 `\|`，`grep -c "\bfoo\b"` 会恒返回 0。用 `grep -oF "foo" | wc -l` 或 ripgrep。

**资产数据在哪**

MinIO 命名卷 `minio_data`。**备份必须包含该卷**，只备份仓库目录不够。

---

## 6. 升级

```bash
git pull
docker compose -p aigccat -f docker-compose.yml build web
docker compose -p aigccat -f docker-compose.yml up -d --no-deps --no-build --pull never web
```

升级前先确认 `minio_data` 卷有备份。
