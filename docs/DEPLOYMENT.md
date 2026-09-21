# 部署指南

覆盖两种形态：**单容器**（最省事，推荐）、**可选工作器**（换用你自己的 Blender）。

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
> **amd64 版自带 Blender 5.2**；
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


打开 `http://localhost:8080`，用默认账号 **admin** / 密码 **aigccat** 登录：

```bash
# 忘了密码？默认值就是 admin / aigccat；首次启动的日志里也会打印一次
docker logs aigccat | grep -A2 初始账号
```

| 项 | 说明 |
|---|---|
| 数据 | 全在数据卷里：对象存储 / 账号 / 配置 / AI 任务。**备份与迁移就是拷这一个卷** |
| 账号 | 初始管理员固定为 **admin / aigccat**，开箱即用。账号库一旦建立，改环境变量**不会**重置密码 |
| 其他密钥 | MinIO 密码、机器令牌在首次启动时自动生成，存进数据卷内的环境文件（权限 0600） |
| 覆盖密码 | 想自己指定初始密码就加 `-e AIGCCAT_ADMIN_PASSWORD=...`（仅账号库为空时生效）；`-e AIGCCAT_ADMIN_USER=...` 可改账号名 |
| 备份上传上限 | 单次导入的备份大小上限默认 **2 GiB**，可用 `-e AIGCCAT_MAX_BACKUP_UPLOAD_BYTES=...`（字节数）调整 |
| 生成能力 | 加 `-e OPENAI_API_KEY=... -e OPENAI_BASE_URL=... -e OPENAI_MODEL=...`，`-e TRIPO_API_KEY=...`。不配也能跑，只是生成类功能不可用 |
| 公网反代 | 必须加 `-e AUTH_ORIGIN=https://你的域名`，否则鉴权只接受 localhost 与内网地址 |
| 架构 | `amd64` 与 `arm64` 都已发布；要固定版本把 `:latest` 换成 `:sha-xxxxxxx` |

> ⚠️ **默认密码 `aigccat` 只图开箱即用；公网部署前务必用上表的「覆盖密码」换成强密码。**

用 compose 等价写法：

```bash
docker compose -f docker-compose.allinone.yml up -d          # 拉预构建镜像
docker compose -f docker-compose.allinone.yml up -d --build  # 或从源码本地构建
```

从源码构建时，若基础镜像或软件源拉取失败，可指定镜像源：

```bash
docker build -f deploy/allinone/Dockerfile \
  --build-arg APT_MIRROR=mirrors.ustc.edu.cn -t aigccat:allinone .
```

amd64 镜像自带 Blender 5.2、AI 绑骨桥与订阅登录的浏览器（虚拟屏幕 + Chromium + noVNC），
**宿主机上不需要装任何东西**；arm64 镜像不含 Blender（官方没有 Linux arm64 版），减面/重拓扑/绑骨
会自动改用宿主机上装好的 Blender（见上方架构表）。

---

## 2. 可选：改用你自己宿主上的 Blender

**单容器镜像里已经带了 Blender 5.2，这一节通常用不到。** 只有这几种情况才需要看：

- 你想用宿主上已经装好的 Blender（版本更新，或想共用同一份）

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

这样需要在宿主上自行常驻 Blender 工作器与绑骨桥（`scripts/opencode-runner/install-host.py` 负责安装与清退）。
工作器必须作为常驻服务运行 —— 挂成会话后台任务会随会话结束被带走，界面随即显示"不可达"。

### 网页订阅的登录窗口：也在容器里，宿主机不需要装东西

单容器镜像内置了 Xvfb 虚拟屏幕 + Chromium + noVNC，登录窗口是**网页里内嵌的一幅画面**
（网关转发，复用 8080 端口，受现有登录鉴权保护）。

不需要执行任何安装命令 —— 起好容器，等界面出现 **「连接网页订阅」**，
点【打开登录窗口】直接在里面登录即可。
接入步骤与排查见 **[接入你自己的网页订阅会话](STUDIO-SESSION.md)**。

---

## 3. 常见问题

**拉不到基础镜像**

改用镜像源拉取后 `docker tag` 成标准名，**不要改 Dockerfile**：

```bash
docker pull docker.m.daocloud.io/library/rust:1-slim-bookworm
docker tag  docker.m.daocloud.io/library/rust:1-slim-bookworm rust:1-slim-bookworm
docker pull docker.m.daocloud.io/library/debian:bookworm-slim
docker tag  docker.m.daocloud.io/library/debian:bookworm-slim debian:bookworm-slim
```

**资产数据在哪**

所有数据都在 compose 创建的命名数据卷里（`docker volume ls` 可查）。
**备份必须包含该卷**，只备份仓库目录不够。

---

## 4. 升级

```bash
git pull
docker compose -f docker-compose.allinone.yml up -d --build
```

升级前先确认数据卷有备份（见上一节）。
