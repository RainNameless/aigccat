# 接入你自己的「网页订阅」会话

工作台上那句 **「网页订阅 · 已连接」** 的意思是：你这台机器上有一个常驻执行器，
它拿着一份**你自己账号的网页登录态**去提交生成，消耗的是**你网页订阅里的积分**，
而不是开发者 API 的额度。

**这件事只能由你在自己的机器上做一次**，因为它需要的是你的账号凭据：

- 登录 cookie 等同于账号凭据，不可能随仓库分发 —— `.ai/` 已被 `.gitignore` 排除，我们本地那份也从未提交
- 执行器用真实浏览器会话访问上游，容器里跑不了（单容器镜像也一样）
- 所以：一条命令能给你**资产管理与预览**；**要真的生成，得接一次会话**

---

## 1. 前提

| 项 | 要求 |
|---|---|
| 系统 | macOS 会用 launchd 常驻；其他系统可手动跑（见第 7 节） |
| Node.js | 22 或更高（`install.py` 默认优先用 `node@22`） |
| 账号 | **你自己的**、有可用额度的订阅账号 |
| 网络 | 能访问 `studio.tripo3d.ai` / `api.tripo3d.ai`；不能直连就先准备好本地代理 |

## 2. 四步接入

```bash
# 1) 安装依赖（只需一次）
cd scripts/studio-runner && npm install && cd ../..

# 2) 连接会话 —— 会打开一个真实浏览器，请在里面登录你的账号
node scripts/studio-runner/connect-session.cjs

# 3) 装成常驻执行器（会把令牌写进 .env）
python3 scripts/studio-runner/install.py

# 4) 让容器重新读取环境变量
docker compose -f docker-compose.allinone.yml up -d      # 单容器
docker compose -p aigccat -f docker-compose.yml up -d     # 多容器
```

做完打开工作台的「模型构建」，服务状态应显示 **「网页订阅 · 已连接」**。

### 连接工具的其他用法

```bash
# 只校验现有会话，不打开浏览器（会打印令牌有效期与剩余积分）
node scripts/studio-runner/connect-session.cjs --verify

# 你已经有 Playwright 的 storageState 文件（例如 playwright codegen --save-storage 导出的）
node scripts/studio-runner/connect-session.cjs --from ~/auth.json

# 网络需要代理；或反过来强制不使用代理（空串）
STUDIO_PROXY=http://127.0.0.1:7897 node scripts/studio-runner/connect-session.cjs
STUDIO_PROXY= node scripts/studio-runner/connect-session.cjs

# 等待登录的秒数（默认 300）
node scripts/studio-runner/connect-session.cjs --timeout 600
```

> **代理是可选的，而且是自动判断的。** 没有设置 `STUDIO_PROXY` 时，代码只在本机
> `127.0.0.1:7897` 真的有人监听才使用它，否则直连 —— 所以别人的机器上不会因为
> 一个不存在的代理端口而失败。代理只在需要时才配。

## 3. 怎么算成功（三个都可自查）

| 检查 | 命令 | 期望 |
|---|---|---|
| 会话本身 | `node scripts/studio-runner/connect-session.cjs --verify` | `✔ 会话有效` + 有效期 + 剩余积分 |
| 执行器 | `curl -H "Authorization: Bearer $(cat .ai/browser-state/studio-runner-token)" http://127.0.0.1:8790/health` | `{"ready":true,"mode":"session-http","credits":…}` |
| 界面 | 工作台 →「模型构建」→ 服务状态 | **网页订阅 · 已连接** |

## 4. 令牌与凭据边界

| 文件 | 作用 | 权限 | 会进仓库吗 |
|---|---|---|---|
| `.ai/browser-state/studio-session.auth.json` | 你的网页登录 cookie（只保留 tripo3d.ai 域） | `600` | **不会**（`.ai/` 已被忽略） |
| `.ai/browser-state/studio-runner-token` | 本机执行器与本后端的共享密钥 | `600` | **不会** |
| `.env` 的 `STUDIO_WORKER_TOKEN` | 上面那个密钥，供容器读取 | — | **不会**（`.env` 已被忽略） |

令牌由 `install.py` 自动生成并同步；两边不一致时后端会报「Studio 执行器未配置」或直接 401。
执行器监听 `0.0.0.0:8790`，靠这个 Bearer 令牌保护；如果不需要容器以外的机器访问，
建议在防火墙层面只放行本机。

## 5. 出问题了怎么查

| 现象 | 原因 | 处理 |
|---|---|---|
| 界面显示「网页订阅 · 未连接」 | 执行器没起或令牌对不上 | `launchctl print gui/$(id -u)/cn.aigccat.studio-worker`；日志在 `~/Library/Application Support/aigccat/studio-worker/.ai/browser-state/error.log` |
| 提示「Studio 执行器未配置」 | 容器没读到 `STUDIO_WORKER_TOKEN` | 按第 2 步第 4 条重建容器（改 `.env` 后必须重建，不是 restart） |
| `--verify` 报「登录已失效」 | 会话确实过期，**或**上游瞬时抖动 | 等十几秒重试；持续失效再重新登录（第 2 步第 2 条） |
| 报「登录会话刷新连接失败」 | 网络不通 / 代理没生效 | 设置 `STUDIO_PROXY` 后重试 |
| 生成中途失败 | 上游任务失败或超过 30 分钟 | 在任务记录里查原任务；**系统不会自动重发付费请求** |
| 登录页要求验证码 | 正常的风控 | 在打开的浏览器里手动完成，工具会等你 |

## 6. 边界与风险（请看完再用）

- 这条链路用的是**你订阅对应的网页接口**，不是官方开发者 API。本项目**不绕过任何额度限额**，
  也不会在失败后自动重发付费请求（避免替你花掉额度）。
- 上游接口随时可能变化。我们能做的是跟着修；**它失效不代表本项目其他部分失效**。
- 请只使用**你自己有权使用**的账号。使用方式是否符合上游服务条款、账号是否受影响，
  由使用者自行判断和承担 —— 我们不提供账号，也不代持凭据。
- 会话文件不要外传、不要提交进 git。**一旦泄露，重新登录一次即可**（旧会话随之失效）；
  这是选网页会话而不是长期 API Key 的一个好处：可以随时作废。
- 想更稳妥、更省心的话，**官方开发者 API 是更正规的路子**（本项目也支持，见
  [`SPONSORSHIP.md`](SPONSORSHIP.md) 里的说明）。

## 7. 不用 macOS / 不想装成常驻服务

执行器本体是纯 Node 脚本，任何有 Node 22 的机器都能手动跑：

```bash
cd scripts/studio-runner && npm install
STUDIO_ROOT="$PWD/../.." node server.cjs      # 监听 127.0.0.1:8790
```

再把后端指过去（`STUDIO_WORKER_URL` + `STUDIO_WORKER_TOKEN`）即可。
`install.py` 只负责 macOS 下的 launchd 常驻，不做别的事。

---

# Connecting Your Own Web-Subscription Session

The **"Web subscription · Connected"** badge means a resident worker on *your* machine holds a web
login session for *your own* account and submits generations with it. It spends credits from **your
web subscription**, not from the developer API quota.

**This step can only be done by you, on your machine**, because the credential is yours:

- The login cookies are equivalent to your account credential and can never ship with the repo —
  `.ai/` is git-ignored and our own copy was never committed
- The worker drives a real browser session against the upstream service, so it cannot run inside a
  container (the single-container image included)
- One command gets you **asset management and preview**; **actual generation requires connecting a
  session once**

## Prerequisites

| Item | Requirement |
|---|---|
| OS | macOS installs it as a launchd service; other systems can run it manually (see below) |
| Node.js | 22 or newer (`install.py` prefers `node@22`) |
| Account | **Your own** subscription account with available credits |
| Network | Reachable `studio.tripo3d.ai` / `api.tripo3d.ai`; set up a local proxy first if not |

## Four steps

```bash
cd scripts/studio-runner && npm install && cd ../..          # 1) dependencies, once
node scripts/studio-runner/connect-session.cjs               # 2) log in in the opened browser
python3 scripts/studio-runner/install.py                     # 3) install the resident worker
docker compose -f docker-compose.allinone.yml up -d           # 4) let the container pick up the token
```

Then open the workbench → "Model build"; the status should read **Web subscription · Connected**.

Extra options:

```bash
node scripts/studio-runner/connect-session.cjs --verify                 # check only, no browser
node scripts/studio-runner/connect-session.cjs --from ~/auth.json       # import an existing storageState
node scripts/studio-runner/connect-session.cjs --timeout 600            # wait longer for login
STUDIO_PROXY=http://127.0.0.1:7897 node scripts/studio-runner/connect-session.cjs
STUDIO_PROXY= node scripts/studio-runner/connect-session.cjs            # force direct connection
```

> **The proxy is optional and auto-detected.** With `STUDIO_PROXY` unset, the code uses
> `127.0.0.1:7897` only if something is actually listening there, and otherwise connects directly —
> so a machine without that local proxy port does not fail.

## Verifying it works

| Check | Command | Expected |
|---|---|---|
| Session | `connect-session.cjs --verify` | `✔ 会话有效` plus expiry and remaining credits |
| Worker | `curl -H "Authorization: Bearer $(cat .ai/browser-state/studio-runner-token)" http://127.0.0.1:8790/health` | `{"ready":true,"mode":"session-http","credits":…}` |
| UI | Workbench → Model build → service status | **Web subscription · Connected** |

## Credentials boundary

| File | Purpose | Mode | Committed? |
|---|---|---|---|
| `.ai/browser-state/studio-session.auth.json` | Your web login cookies (tripo3d.ai domains only) | `600` | **No** |
| `.ai/browser-state/studio-runner-token` | Shared secret between the worker and this backend | `600` | **No** |
| `STUDIO_WORKER_TOKEN` in `.env` | The same secret, read by the container | — | **No** |

Troubleshooting, limits and risks are the same as in the Chinese section above: session expiry
(try again after a few seconds, re-login if persistent), missing `STUDIO_WORKER_TOKEN`
(recreate the container, don't just restart), network issues (set `STUDIO_PROXY`), and failed
generations (check the original task; **paid requests are never retried automatically**).

**Boundaries:** this path uses the web endpoints behind your own subscription, not the official
developer API. We do **not** bypass any quota and we never resend paid requests automatically.
Upstream endpoints may change at any time. Use only an account you are entitled to use, and judge
for yourself whether the usage fits the upstream terms. Never share or commit the session file —
if it leaks, log in again and the old session dies. If you want the well-trodden route, the
official developer API is also supported (see [`SPONSORSHIP.md`](SPONSORSHIP.md)).

**Not on macOS?** The worker is plain Node:

```bash
cd scripts/studio-runner && npm install
STUDIO_ROOT="$PWD/../.." node server.cjs      # listens on 127.0.0.1:8790
```

Point the backend at it with `STUDIO_WORKER_URL` + `STUDIO_WORKER_TOKEN`.
