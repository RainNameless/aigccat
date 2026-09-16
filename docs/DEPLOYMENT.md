# 部署指南

覆盖三种形态：**本机开发**（最快）、**公网自托管**、**宿主工作器**（可选能力）。

---

## 0. 组件与端口

| 组件 | 端口 | 必需 | 说明 |
|---|---|---|---|
| `gateway` | `8080`（唯一对外） | ✅ | 统一鉴权；未登录跳 `/login.html` |
| `web` | 容器内 `8080` | ✅ | Rust + axum，不发布宿主端口 |
| `minio` | `9000` / `9001` | ✅ | 资产唯一事实来源 |
| `opencode` | 内部 `4097` | 可选 | AI 绑骨所需 |
| Blender 工作器 | `127.0.0.1:8788` | 可选 | 减面 / 重拓扑 / 部件编辑 / 绑骨 |
| Studio 执行器 | `8790` | 可选 | Studio 网页订阅会话生成 |
| OpenCode 桥接 | `8791` | 可选 | AI 写 Blender 脚本 |

**不启动工作器也能跑**，只是相关功能显示为不可达，界面会给出明确提示，**不会伪造成功**。

---

## 1. 本机 / 内网

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

## 2. 宿主工作器（可选）

```bash
# Blender 5.2.1 执行层（macOS，launchd 常驻、开机自启）
launchctl kickstart -k gui/$(id -u)/cn.aigccat.blender-worker

# Studio 订阅会话执行器
python3 scripts/studio-runner/install.py

# AI 绑骨：先起容器，再起宿主桥接
docker compose -p aigccat -f docker-compose.yml build opencode
docker compose -p aigccat -f docker-compose.yml up -d --no-deps --no-build --pull never opencode
python3 scripts/opencode-runner/install-host.py
```

**不要把工作器当会话后台任务启动**——会话清理会带走进程，界面会显示"不可达"。
`kickstart` 前若端口被旧进程占用，需先 kill 真实 PID，否则新进程立即 `exited`。

Linux 上用 systemd 托管等价的常驻单元即可。

---

## 3. 公网自托管

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

## 4. 常见问题

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

## 5. 升级

```bash
git pull
docker compose -p aigccat -f docker-compose.yml build web
docker compose -p aigccat -f docker-compose.yml up -d --no-deps --no-build --pull never web
```

升级前先确认 `minio_data` 卷有备份。
