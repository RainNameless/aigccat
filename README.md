# aigccat

一个通用的 3D 游戏建模平台 —— 输入一句自然语言，产出可交付给 Unity / Godot 的 3D 资产（GLB + Asset Contract）。

![license](https://img.shields.io/badge/license-Apache--2.0-blue)

**[Telegram 社区 · 交流与反馈](https://t.me/aigccat)** · [English](README.en.md) · [部署指南](docs/DEPLOYMENT.md) · [文档索引](docs/README.md)

---

## 这是什么

aigccat 是一条**自托管的 AI 3D 资产管线**：从文字或图片生成模型，带版本管理、校验、后处理、绑骨动作和引擎交付，全部跑在你自己的机器上，资产存在你自己的 MinIO 里。

它不是"能生成模型"的 demo，而是为了解决真实游戏项目里的一堆脏问题：脸型雷同、微调要全量重生成、导出到引擎后变品红、清理脚本误删已发布资产、API 成本无感、审核只看一张图看不准。

## 界面

### 多账号池与自定义模型接入

**AI 账号页统一管理所有模型凭据** —— sub2api 式账号池：每家供应商可存多条账号
（订阅 / API Key / 自定义模型服务），绿点标识可用状态，一键切换「当前」、启停、删除。

**自定义模型服务**：任何 OpenAI 兼容接口都能接入 —— 填地址和 Key，保存时自动读取
上游模型清单全量导入；文字与生图模型可以在同一个账号里，生图模型直接进入「图片创作」。
**模型分配**：生图（四视图）、文字 LLM（AI 绑骨）、识图（多模态）、3D 建模四条用途
各自指定一条模型，跨多家供应商随意挑选，改完立即生效。页底还有对话测试，
选一个模型直接试文字或图片，验证账号通不通。

![添加 AI 账号](docs/screenshots/add-account.png)

### 工作台

11 个工具、3D 预览与朝向控制、右侧资产面板；顶部是六步流程指示。

![工作台](docs/screenshots/workbench.png)

初次使用从一句描述开始，也可以直接上传参考图：

![新建草稿](docs/screenshots/workbench-new.png)

### 模型构建与回收站

建模不区分「网页订阅 / API」两套界面 —— 选哪家就是哪家；Tripo 用订阅还是 API
由「当前账号」决定，卡片上直接标出来。每个参数旁有 ? 说明按钮（面数 / 几何精度 /
四边面 / 纹理 / PBR / 贴图质量 / 导出尺寸），右下角还有面向新手的向导。
回收站里除了恢复，还可以**连 MinIO 数据一起真删**（双重确认，不可恢复）。

### 工具

| 图片创作：文字 + 可选图片，一次生成四视图 | 贴图处理：AI 贴图 / 已有贴图 / 平铺 / 手绘 |
|---|---|
| ![图片创作](docs/screenshots/tool-image.png) | ![贴图处理](docs/screenshots/tool-texture.png) |

| 网格整理：减面 / 重拓扑 / 四边面 | UV 展开：智能 / 角度 |
|---|---|
| ![网格整理](docs/screenshots/tool-remesh.png) | ![UV 展开](docs/screenshots/tool-uv.png) |

动作制作：101 个动作模板，可直接应用到模型

![动作制作](docs/screenshots/tool-animation.png)

### 资产

| 资产库：分类聚合、搜索筛选、批量操作、回收站 | 资产图谱：五级节点、四种布局 |
|---|---|
| ![资产库](docs/screenshots/library.png) | ![资产图谱](docs/screenshots/canvas.png) |

图片资源：每个资产的四视图独立成组，可下载原图

![图片资源](docs/screenshots/images-four-views.png)

### 面板

| 属性：流水线阶段、资产信息、参考图 | 历史：版本历史与操作记录 |
|---|---|
| ![属性](docs/screenshots/panel-properties.png) | ![历史](docs/screenshots/panel-history.png) |

## 能力

**资产管理**

- 12 类受控枚举自动分类，Job 与资产分离
- 版本三态 `latest` / `approved` / `published`，published 锁定 + 一键回滚
- append-only 历史树：可检出任意历史版本，只移动 HEAD 不删节点
- 增量 Spec 编辑与 diff、候选批次与锚点选择

**生成与后处理**

- 建模输入：文字 / 单图 / 多视图 / 批量
- 后处理 10 种操作：减面、重拓扑、四边面、拆分、UV 展开、材质、放大、绑骨、动画、变换
- 绑骨与动作：Studio 动作模板应用；本地 AI 绑骨（AI 写 Blender 脚本，由容器内的 OpenCode 桥接执行）

**质量与可追溯**

- GLB 结构校验：包围盒、身高比例、拓扑统计
- QA 多视角渲染集，版本可并排对比
- 成本账本与预算熔断
- 引擎包编译（GLB + Contract + 大纲 + manifest）

**界面**

- 11 个工具的工作台、无限画布资产图谱（5 级节点 / 4 种布局）
- 多账号池：订阅 / API Key / 自定义模型服务统一管理，可切换、可启停、可获取上游模型清单
- 模型分配：生图 / 文字 LLM / 识图 / 3D 四条用途跨供应商指定模型，即时生效
- 参数帮助：7 个生成参数的悬浮说明 + 面向新手的新手向导
- 资产库、图片台账、项目归档与回收站（支持永久删除，连 MinIO 数据一起清）
- 本机 / 内网 / 公网统一登录，后台含概览、账号、AI 账号、安全、界面主题、审计

**交付**

- Unity / Godot 导入适配器
- MCP 通道（17 个工具）

## 架构

```
浏览器 ──► gateway :8080   （唯一对外入口，统一鉴权）
              │
              ▼
          web :8080        （Rust / axum，单静态二进制，不发布宿主端口）
              │
              ├── MinIO    （资产唯一事实来源）
              │
              ├── :8788  Blender 5.2.1   （减面 / 重拓扑 / 部件编辑 / 自动绑骨）
              ├── :4097  OpenCode        （AI 写 Blender 脚本）
              └── :8791  OpenCode → Blender 桥接
```
**上面这些都在同一个容器里**，`docker run` 一条命令即可，不用另装 Blender。

**订阅登录的浏览器也在容器里**：容器内自己起一块虚拟屏幕 + Chromium + VNC，
网页里内嵌显示，你在页面上点一下就能完成平台登录，宿主机不需要装任何浏览器。

- **后端**：Rust + axum，全部路由注册在 `web/src/main.rs`，各模块只提供 handler
- **前端**：无框架、无构建步骤的原生 HTML/JS/CSS，Three.js 本地 vendored
- **存储**：MinIO（S3 兼容），对象 key 采用路径形态，与本地文件系统 1:1 对应
- **执行器**：amd64 镜像自带 Blender 5.2（arm64 自动回落宿主机）；
  订阅登录的 Chromium 与 AI 绑骨的 OpenCode 也都在容器内

## 社区与反馈

**Telegram 群是本项目的主场** —— [加入社区](https://t.me/aigccat)

- 想知道这东西实际用起来怎么样、适不适合你的项目 → 来聊
- 用着不顺手、有想砍掉或想加的功能 → **直接提，我们按反馈排优先级**
- 部署卡住、平台接入有疑问 → 甩报错进来，看到就回

## 关于赞助

项目目前全部跑在一台个人电脑上，没有服务器也没有生成平台的付费额度，
部分平台接入因此尚未实测（我们的规矩：没跑通就不写「支持」）。
如果你恰好有闲置的 API 额度、Key 或小服务器愿意支持，细节见
**[赞助与平台接入](docs/SPONSORSHIP.md)** —— 没有也完全没关系，来群里提意见就是最大的帮助。

## 快速开始

**方式 A · 一键部署（推荐）**

```bash
mkdir -p aigccat-deploy && cd aigccat-deploy
curl -sSL https://raw.githubusercontent.com/RainNameless/aigccat/main/deploy/docker-deploy.sh | bash
```

脚本会下载 compose 配置、启动容器并打印初始账号密码（默认 **admin / aigccat**；首次启动自动
生成其余密钥、种入 4 个示例资产，不需要先配 .env）。

**方式 B · 单容器 docker run（零编译）**

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

> ⚠️ 默认密码只为「开箱即用」，**公网部署务必改掉**。部署前设
> `-e AIGCCAT_ADMIN_PASSWORD=你的强密码`（只在账号库为空时生效）；
> 已有账号库后再改这个环境变量**不会**重置密码，请到后台「账号安全」里改。

一个容器里装齐存储（MinIO）、后端、鉴权网关与 AI 绑骨执行器，**不需要本地编译，也不需要先配 .env**——
初始账号固定为 **admin / aigccat**，其余密钥（MinIO 密码、机器令牌等）在首次启动时自动生成并保存在数据卷里。
所有状态都在 `aigccat-data` 这一个卷，备份/迁移就是拷它。

> Apple Silicon 与 x86 服务器都有对应架构的镜像。想固定版本就把 `:latest` 换成 `:sha-xxxxxxx`。

完整步骤、可选工作器、常见问题见 **[部署指南](docs/DEPLOYMENT.md)**。

> 想用「网页订阅」真的跑出模型（消耗你自己账号的积分）？这条链路需要在你自己的机器上接一次会话：
> **[接入你自己的网页订阅会话](docs/STUDIO-SESSION.md)**。

## 接入状态

- Tripo **API** 建模链路代码就绪，但因账户余额为 0 **从未完成真实验收**；实际产出全部来自 Studio 网页订阅链路
- Studio **自由提示词动作**、**任意形体绑骨**未接入（人形已实测，其他形体不作通用保证）
- **AI 贴图**（Studio texture）上游持续失败，前端入口暂禁用
- 提示词→骨骼动画、Unity 适配器实机冒烟 未完成

**其他生成平台的接入状态**：Meshy、Rodin / Hyper3D、Hunyuan3D、Hi3D 的传输层代码已就绪，
但都**未完成真实验收**（缺少可用密钥或额度），因此不计入「已支持」。
正在寻找赞助以完成验收，见 **[关于赞助](docs/SPONSORSHIP.md)**。

## 已知限制

- 面向**单机自托管、单用户**设计：并发固定为 1，账号共享同一份资产库，**没有租户隔离**
- 付费上游调用**一律不自动重试**（上游可能已计费），失败如实报错
- 涉及 AI 生成结果的环节需你自己准备并承担相应服务额度与费用
- 资产管理依赖 MinIO，不启动则无法读写资产

## 目录结构

```
web/src/        Rust 后端（axum + MinIO）
web/static/     前端（index=工作台 / library=资产库 / admin=后台）
scripts/        auth-server=鉴权网关  blender=Blender 执行层
                studio-runner=Studio 执行器  opencode-runner=AI 绑骨
docs/           文档（README.md 是分类索引）
adapters/       Unity / Godot 导入适配器
mcp_server/     MCP 服务
```

文档入口见 [`docs/README.md`](docs/README.md)。

## 关于第三方服务

本项目是**自托管工具**，不附带任何第三方服务的额度：

- `scripts/studio-runner/` 通过**使用者本人已登录的 Studio 网页会话**调用接口，需要你自己的有效订阅。本项目不提供、不代充、不绕过任何付费额度
- Tripo 等生成能力同理，需要你自己配置 Key 并承担费用
- 使用前请自行确认遵守相应服务的条款

第三方组件许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 赞助者

**目前还没有 —— 你可以是第一个。**

这一节会随赞助增加，写明资助者（或匿名的「一位社区成员」）以及他资助了哪个平台 / 哪台机器。

我们需要的是：[API 额度与平台订阅](docs/SPONSORSHIP.md)（Meshy / Rodin / Hunyuan3D / TRELLIS 2 / Hi3D），
以及**一台跑在线预览环境的小服务器**（不需要显卡）。来 [Telegram 社区](https://t.me/aigccat) 说一声就行。

## 许可证

[Apache License 2.0](LICENSE)
