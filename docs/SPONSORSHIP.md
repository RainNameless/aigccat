# 赞助与平台接入

**这个项目目前全部跑在一台个人电脑上：没有服务器，也没有任何一家生成平台的付费额度。**
如果你手里有用不完的 API 额度、闲置订阅，或者一台闲着的小服务器，欢迎赞助 —— 我们把接入做完、把预览站搭起来，并把验证过程公开。

Telegram：<https://t.me/aigccat>

---

## 1. 一句话背景

aigccat 是一条**自托管的 AI 3D 资产管线**：文字 / 图片 → 3D 模型 → 版本管理 → 后处理 → 绑骨动作 → 引擎交付。
接口层是按「可插拔多家生成服务」设计的，但目前**只有 Tripo 这一条链路真正跑通过**。
其余平台我们连**一次真实调用**都没付得起 —— 所以它们至今在 README 里都是「未接入」。

## 2. 现在的真实状态（不粉饰）

| 平台 | 代码状态 | 是否经过真实调用验证 |
|---|---|---|
| Tripo（网页订阅链路） | 已接入 | ✅ 实际出过模型 |
| Tripo（官方 API） | 代码就绪 | ❌ 账户余额为 0，**从未验收** |
| Meshy | 代码就绪 | ❌ 未完成端到端验收 |
| Rodin / Hyper3D | 代码就绪 | ❌ 未完成端到端验收 |
| Hunyuan3D（腾讯云） | 代码就绪 | ❌ 未完成端到端验收 |
| TRELLIS 2 | 未接入 | ❌ |
| Hi3D | 代码就绪 | ❌ 未完成端到端验收 |

这个项目有一条硬规矩：**没跑通就不写「支持」**。所以上面那些 ❌，在 README 里就如实标为「未接入」或「未完成验收」。
换句话说 —— 我们不是懒得接，是**没有额度就没有真实调用，没有真实调用就不能宣称支持**。

## 3. 我们需要什么

### 3.1 API 额度 / Key / 订阅（用于接入新平台）

| 平台 | 我们需要 | 说明 |
|---|---|---|
| **Meshy** | API Key（带 API 权益的档位） | 免费额度的模型**不能下载**，所以必须是订阅里含 API 额度的那档 |
| **Rodin / Hyper3D** | API Key，或按次 credit | 官网支持直接买 credit，约 $1.50 / 次 |
| **Hunyuan3D** | 腾讯云**子账号** SecretId / SecretKey + 资源包 | 请务必用**最小权限子账号**，不要给主账号密钥 |
| **Hi3D** | API Key / credit | 它的 API **独立计费**（约 $0.02 / credit），订阅额度与 API 不通用 |
| **TRELLIS 2** | 按次计费的**云端额度**（如 Replicate / fal.ai，约 $0.82 / 次） | 它没有自己的官方 SaaS，我们打算调云端，**不打算本地部署**（那需要 24GB 显存的卡，我们不做） |

> 补一句实话：我们优先想要的是**能跑几十次**的量，不是一整个月的订阅。
> 验证一家平台的接入，通常 20~50 次生成就够把主链路、失败分支、超时处理都覆盖一遍。

### 3.2 一台服务器（用于在线预览环境）

**这是除了额度之外我们最缺的东西。**

现状是：想试用 aigccat，得自己 clone、装 Docker、拉镜像、配 Key —— 对绝大多数路人来说门槛太高，
所以他们只会看 README，不会真的跑起来。

我们想要一台能常驻的小机器（家庭宽带 / 小 VPS / 闲置的旧电脑都行），来做这件事：

- **在线预览环境**：打开链接就能看到工作台、资产库、资产图谱的真实界面（可以直接用我们已发布的单容器镜像）
- **在线的样例资产库**：把随仓库发布的示例资产 + 对比数据挂上去，别人可以旋转查看、下载 GLB
- **接入结果的对比数据**：同一个参考图，各家平台出模的质量 / 耗时 / 面数并排展示 —— 这也是赞助者最想看到的东西
- 顺带让 demo 站**不再依赖我们个人电脑的开机时间**

**硬件要求很低**：不需要显卡。我们发布的是预构建镜像（arm64 / amd64 都有），
2 核 4G、能跑 Docker、能常驻，就够用了；磁盘建议留 20GB 以上（镜像约 4GB，再加样例资产）。

如果你更愿意给云资源而不是机器：**一台小 VPS 的额度、或者云主机代金券**同样有用。

## 4. 我们的承诺（请按这几条监督我们）

1. **只要官方 API 的 Key / 额度。**
   请**不要**给我们任何平台的账号密码、网页登录会话或 cookie —— 那既不安全，也可能违反平台条款。我们不会用这种方式接任何平台。
2. **密钥只用于本地联调**：不入库、不写进日志、不公开、不转售、不跑与接入无关的任务。你随时可以作废，作废后我们这边的调用会立刻失败（我们会照实报错，不会静默降级）。
3. **不绕过任何平台的额度与付费限制**，一律按官方 API 文档调用；失败不自动重试（避免悄悄花掉你的额度）。
4. **验证过程公开**：测试产生的资产与失败记录会留在 `outputs/` 里，包括「上游 failed」这种难看的结果。
   这样你捐的额度不会浪费在「看起来成功」的结论上 —— 失败也照实写进文档。
5. **如果赞助的是服务器**：那台机器上只跑这个项目的预览环境与相关 CI / 数据展示。
   不打广告、不跑无关任务、不做代理；你可以随时收回，我们会把数据迁走并下线预览站。
6. **署名**：README 的「赞助者」一节会写你的名字 / ID（或按你要求的匿名），并注明你资助的是哪个平台 / 哪台机器。
   如果你更希望匿名，我们就只写「一位社区成员」。

## 5. 怎么参与

- **在 Telegram 频道说一声**：<https://t.me/aigccat>
  例如「我有 Meshy 的 XX 额度，可以给你们测试」或「我有一台闲置小机器可以借你们跑预览」——
  我们会**先说清楚打算怎么用、用多少**，你同意了再动。
- 你也可以只赞助其中**一个平台**，甚至只赞助**十几次生成**、或一台最低配的 VPS，都很有用。

## 6. 用掉的额度会变成什么

每一笔赞助最终都会落到仓库里可查的东西上：

- 该平台的接入代码（provider 适配层）
- `outputs/` 下的真实产物与失败记录
- README 里那行状态从「未接入」改成「已接入并实测」，或者诚实地保留「接入但上游失败」
- 平台之间的横向对比数据（同一张参考图，各家出模质量 / 耗时 / 面数）
- 一个**在线的预览站**（如果赞助了服务器），别人不用装任何东西就能看到项目长什么样

---

# Sponsorship & Platform Integration

**This project currently runs entirely on one personal computer: no server, and no paid credits on
any generation platform.** If you have spare API credits, an idle subscription, or a spare little
server, we'd be grateful — we'll finish the integrations, stand up a preview site, and publish the
verification process.

Telegram: <https://t.me/aigccat>

## Background

aigccat is a self-hosted AI 3D asset pipeline: text / image → 3D model → versioning → post-processing
→ rigging & animation → engine delivery. The provider layer is designed to be pluggable, but only the
**Tripo** path has ever actually produced a model. We have not been able to pay for a single real call
on any other platform — which is why they are still listed as "not integrated" in the README.

## Current status (no sugar-coating)

| Platform | Code | Verified with real calls |
|---|---|---|
| Tripo (web subscription path) | integrated | ✅ has produced real models |
| Tripo (official API) | code ready | ❌ account balance is 0, never verified |
| Meshy / Rodin (Hyper3D) / Hunyuan3D / TRELLIS 2 / Hi3D | not integrated | ❌ |

We have one hard rule: **if it hasn't run, we don't write "supported."**

## What we need

### API credits / keys / subscriptions

| Platform | We need | Notes |
|---|---|---|
| **Meshy** | API key with API entitlement | free-tier models **cannot be downloaded**, so it must be a plan that includes API credits |
| **Rodin / Hyper3D** | API key, or pay-as-you-go credits | credits can be bought directly, ≈$1.50 per generation |
| **Hunyuan3D** | Tencent Cloud **sub-account** SecretId / SecretKey + a resource pack | please use a least-privilege sub-account, never your root key |
| **Hi3D** | API key / credits | its API is billed separately (≈$0.02/credit) and subscription credits don't apply |
| **TRELLIS 2** | pay-per-run **cloud credits** (e.g. Replicate / fal.ai, ≈$0.82/run) | it has no first-party SaaS; we'd call it via cloud. We are **not** planning a local deployment (that needs a 24 GB-VRAM GPU, which we're not doing) |

We'd rather have **a few dozen generations** than a whole month of subscription — 20–50 runs are
usually enough to cover the happy path, the failure branches and the timeout handling.

### A server, for an online preview environment

**This is what we lack most, besides credits.**

Right now, trying aigccat means cloning the repo, installing Docker, pulling images and configuring
keys — too high a bar for most passers-by, so they read the README and never run it.

We'd like one small always-on machine (a home box, a small VPS, an old PC — anything):

- **An online preview**: open a link and see the real workbench, asset library and asset graph
  (we already publish a single-container image, so this is straightforward)
- **An online sample library**: our 20 sample models plus comparison data, viewable and downloadable
- **Side-by-side integration results**: same reference image, different platforms — quality, latency,
  triangle counts. This is exactly what sponsors want to see
- And the demo stops depending on whether our laptop happens to be powered on

**Hardware requirements are low: no GPU.** We ship prebuilt images (arm64 and amd64), so 2 cores,
4 GB RAM, Docker and an always-on connection are enough; 20 GB+ of disk is advisable (the image is
~1.6 GB plus sample assets).

Cloud credits or a VPS voucher work just as well as physical hardware.

## Our commitments

1. **Official API keys / credits only.** Please do **not** send us account passwords, web sessions or
   cookies — that is unsafe and may violate platform terms. We will not integrate anything that way.
2. **Keys are used for local integration testing only**: never committed, never logged, never shared,
   never resold, never used for unrelated tasks. Revoke them any time — afterwards our calls will fail
   loudly, not silently degrade.
3. **No bypassing quotas or billing.** Official API endpoints only, and no automatic retries
   (so your credits are never spent silently).
4. **Public verification**: real outputs *and* failure records stay in `outputs/`.
5. **If you sponsor a server**: that machine hosts only this project's preview environment plus the
   related CI/data display. No ads, no unrelated workloads, no proxying. You can take it back at any
   time — we'll migrate the data and take the preview offline.
6. **Credit where it's due**: your name/handle (or "a community member" if you prefer anonymity) goes
   into the Sponsors section of the README, next to whatever you funded.

## How to help

Say hi in the Telegram channel: <https://t.me/aigccat> — e.g. "I can sponsor a Meshy API key" or
"I have an idle small server you can use for a preview". We'll tell you exactly what we plan to run
and roughly how much, before touching anything. Sponsoring a single platform, a dozen generations, or
one minimum-spec VPS is genuinely useful.
