# 接入你自己的「网页订阅」会话

工作台上那句 **「网页订阅 · 已连接」** 的意思是：服务里有一份**你自己账号的网页登录态**，
它拿着这份登录态去提交生成，消耗的是**你网页订阅里的积分**，而不是开发者 API 的额度。

**整套交互都在网页里，宿主机上不需要装任何东西。** 单容器镜像自带一块虚拟屏幕 +
一个真浏览器 + VNC，所以「登录窗口」是**内嵌在对话框里**的一幅画面 ——
你在里面点、输入、收验证码，和在本机开一个浏览器完全一样。

**这件事只能由你做一次**，因为它需要的是你的账号凭据：

- 登录 cookie 等同于账号凭据，不可能随仓库分发 —— `.ai/` 已被 `.gitignore` 排除，我们本地那份也从未提交
- 凭据只写进**服务容器的数据卷**（`/data/studio/`），不上传、不入库
- 所以：一条命令能给你**资产管理与预览**；**要真的生成，得接一次会话**

---

## 1. 前提

| 项 | 要求 |
|---|---|
| 系统 | 任选（登录窗口在容器里跑，与宿主系统无关） |
| 账号 | **你自己的**、有可用额度的订阅账号 |
| 网络 | 能访问 `studio.tripo3d.ai` / `api.tripo3d.ai`；不能直连就在 `.env` 里配 `STUDIO_PROXY` |

> 早期版本需要先在宿主机上装一个常驻执行器（macOS 的 launchd 服务）。
> **现在不需要了**；如果你装过，跑 `python3 scripts/studio-runner/install.py` 会把旧的清退掉。

## 2. 接入

### 第 1 步：起容器

```bash
docker compose -f docker-compose.allinone.yml up -d
```

不需要 `npm install`，也不需要装任何宿主服务 —— 浏览器与执行器都在镜像里。

### 第 2 步：连接你的账号

**方式一 · 界面里点（推荐，也是唯一需要的方式）**

| 动作 | 说明 |
|---|---|
| 1. 打开工作台 | 顶栏右侧状态显示 **「网页订阅 · 未连接」**；「模型构建」面板里也会出现 **连接网页订阅 · 点击登录** |
| 2. 点它 → 点【打开登录窗口】 | 登录画面**直接出现在这个对话框里**（容器内浏览器的实时画面），不用切窗口 |
| 3. 在里面登录 | 用你自己的订阅账号，含邮箱验证码等步骤都在这幅画面里完成 |
| 4. 回到网页点【我已登录，取走凭据】 | 状态变成 **「网页订阅 · 已连接」**，弹窗里会显示剩余积分 |

![连接网页订阅](screenshots/studio-connect.png)

**这条链路刻意不轮询上游**：窗口打开后，我们不替你去试、也不反复请求站点 ——
那只会让 Cloudflare 的人机校验更容易盯上你。只有你点【我已登录】时，我们才去取一次凭据。

三点要说清楚，避免误会：

- 窗口出现在**运行执行器的那台机器**上。如果你是从别的设备访问界面，请到那台机器上完成登录。
- 取的是**这个窗口**里的登录凭据，不是你日常浏览器的登录态 —— 读你日常浏览器的 cookie 需要动系统钥匙串里的加密密钥，既不可靠也不该那么做。
- 窗口最多开 30 分钟，超时自动关闭；随时可以点【取消并关闭窗口】。取到凭据后窗口也会自动关掉。

**方式二 · 命令行**

```bash
node scripts/studio-runner/connect-session.cjs      # 打开浏览器登录并保存
```

做完后界面上的服务状态同样会变成「网页订阅 · 已连接」。

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

> **代理只在显式配置时使用**（环境变量 `STUDIO_PROXY`，或命令行的 `--proxy`）。不设置就是直连。
> 我们**不会**去猜某个本地端口是不是代理 —— 「端口在听」不等于「它是个能用的代理」，
> 把上游流量交给一个不相干的本地服务既不可靠也不安全。
>
> 需要代理的网络环境下，装常驻执行器时把同一行前面也带上它，代理才会写进服务配置：
>
> ```bash
> STUDIO_PROXY=http://127.0.0.1:7897 python3 scripts/studio-runner/install.py
> ```
>
> 判断代理是否真的能用（**注意端口在听 ≠ 能出网**）：
>
> ```bash
> curl -x http://127.0.0.1:7897 -o /dev/null -w '%{http_code}\n' https://api.tripo3d.ai/
> ```

## 3. 怎么算成功（三个都可自查）

| 检查 | 命令 | 期望 |
|---|---|---|
| 会话本身 | 界面里顶栏点服务状态，或看 `docker logs <容器> 2>&1 \| grep -i studio` | 无「登录已失效」报错 |
| 执行器 | `docker exec <容器> curl -s http://127.0.0.1:8790/health` | `{"ready":true,"mode":"session-http","credits":…}` |
| 界面 | 工作台 →「模型构建」→ 服务状态 | **网页订阅 · 已连接** |

## 4. 令牌与凭据边界

| 位置 | 作用 | 会进仓库吗 |
|---|---|---|
| 容器数据卷 `/data/studio/studio-session.auth.json` | 你的网页登录 cookie（只保留 tripo3d.ai 域） | **不会**（数据卷，不在仓库） |
| 容器数据卷 `/data/studio/studio-runner-token` | 执行器与后端的共享密钥 | **不会** |

令牌由容器启动器自动生成并同时交给执行器与后端，两边永远一致，不需要手工配置。
执行器只监听容器内回环，外部摸不到它。

## 5. 出问题了怎么查

| 现象 | 原因 | 处理 |
|---|---|---|
| 界面显示「网页订阅 · 未连接」 | 会话过期，或还没接过会话 | 先按第 2 步接一次会话；再 `docker exec <容器> curl -s http://127.0.0.1:8790/health` 看执行器 |
| 提示「Studio 执行器未配置」 | 容器内执行器没起来 | `docker logs <容器>` 查启动日志（正常情况它随容器自动起） |
| 弹窗里显示「执行器不可达」 | 同上 | 同上；容器内默认 `STUDIO_WORKER_URL=127.0.0.1:8790`，一般不需要动 |
| 登录窗口内嵌画面空白 | 容器内存不足，Chromium 起不来 | 给容器至少 2.5GB 内存；`docker logs <容器> 2>&1 \| grep -i chrom` 看报错 |
| 点【我已登录】提示「还没有检测到登录」 | 那个窗口里还没登录成功 | 回去把登录走完（有时要过邮箱验证码），再点一次【我已登录】 |
| 弹窗自己关了，提示「等待登录超时」 | 超过 10 分钟没完成 | 重新打开登录窗口 |
| `--verify` 报「登录已失效」 | 会话确实过期，**或**上游瞬时抖动 | 等十几秒重试；持续失效再重新登录（第 2 步） |
| 报「登录会话刷新连接失败」 | 网络不通 / 代理没生效 | 按上面那条命令先确认代理能不能出网；**代理端口在听不代表它通** |
| 界面显示「未连接 · 连不上上游（网络或代理不通）」 | 同上：上游真的连不上 | 同上。代理恢复后状态会自己变回「已连接」（界面每 30 秒会复查一次） |
| 生成中途失败 | 上游任务失败或超过 30 分钟 | 在任务记录里查原任务；**系统不会自动重发付费请求** |
| 窗口里一直显示 “Just a moment...” 或页面反复刷新 | Cloudflare 人机校验没过（出口 IP 被盯上，或中途换过代理节点） | 等十几秒让它自己走完；**反复挑战就换一个代理节点** —— `cf_clearance` 绑定出口 IP，节点一跳就作废 |
| 点「用 Google 登录」怎么都登不上 | 站点用的是 Google Identity Services（FedCM），在代理 / 自动化浏览器里常报 `NetworkError` | 改用**它自己的邮箱 / 密码或验证码**登录。第三方登录在自动化浏览器里成功率低，这不是本项目的 bug |
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

## 7. 给开发者：在本机手动跑执行器（进阶，普通用户不需要）

单容器镜像里执行器已经内置，上面所有步骤都不需要这一节。仅当你在做开发、
想在自己机器上单独跑一份执行器时才用得上：

```bash
cd scripts/studio-runner && npm install
STUDIO_ROOT="$PWD/../.." node server.cjs      # 监听 127.0.0.1:8790
```

再把容器的 `STUDIO_WORKER_URL` 与 `STUDIO_WORKER_TOKEN` 指过去即可。

---

# Connecting Your Own Web-Subscription Session (English)

The **"Web subscription · Connected"** badge means the service holds a web login session for
**your own account** and submits generations with it — spending credits from **your web
subscription**, not the developer API quota.

**Everything happens inside the web page; your host machine needs nothing installed.**
The single-container image ships a virtual display + a real Chromium + VNC, so the login
window is **embedded right in the dialog** — you click, type and receive verification codes
inside the page, exactly like a local browser.

**Only you can do this step once**, because the credential is yours:

- Login cookies are equivalent to your account credential and can never ship with the repo;
  they live only inside the container data volume (`/data/studio/`)
- The runner token is generated automatically by the container at startup — no manual config
- One command gets you asset management and preview; **actual generation requires connecting
  a session once**

## How to connect

1. Start the container (see the deployment guide).
2. In the workbench, click the service status ("Web subscription") and open the login window.
3. Complete the login inside the embedded window (verification codes included), then confirm.
4. The badge turns green with your remaining credits.

## Troubleshooting quick checks

| Check | Command | Expected |
|---|---|---|
| Runner | `docker exec <container> curl -s http://127.0.0.1:8790/health` | `{"ready":true,...}` |
| Session | top-bar service status | **Web subscription · Connected** |

Blank embedded window → the container likely needs more memory (Chromium needs ~2.5GB total).
"Login expired" → simply log in again; the old session is invalidated automatically — that is
the advantage of a web session over a long-lived API key.

## Boundaries

- This path uses the **web endpoints of your own subscription**, not the official developer
  API. The project bypasses no quota limits and never auto-retries paid requests.
- Upstream interfaces may change at any time; when it breaks we fix what we can.
- Only use accounts **you are entitled to use**. Whether this usage complies with the
  upstream ToS is your call — we provide no accounts and hold no credentials.
- For a more formal path, the **official developer API** is also supported (see
  [SPONSORSHIP.md](SPONSORSHIP.md)).
