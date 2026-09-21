# aigccat 界面规范

> 本文件描述**当前**界面结构与约定。界面变更的逐次记录不写在这里。

## 1. 页面与路由

| 页面 | 路径 | 用途 | hash 参数 |
|---|---|---|---|
| 主工作台 | `/index.html` | 三栏工作台，11 个工具 | `#tool=<id>&asset=<dir>/<id>&new=1` |
| 资产库 | `/library.html` | 资产列表 / 图片资源 / 资产图谱 | `#canvas`、`#images`；`#<dir>/<id>` 会**重定向到工作台** |
| 后台管理 | `/admin.html` | 概览 / 账号 / 安全 / 模型 / 主题 / 审计 | `#overview\|users\|security\|models\|appearance\|audit` |
| 模型配置 | `/model-chat.html` | 模型测试对话 + 目录管理（`?embed=1` 供后台内嵌） | — |
| 登录 | `/login.html` | 登录，`?next=` 回跳 | — |
| 兼容跳转 | `/account.html`→`#security`、`/settings.html`→`#models`、`/comparison.html`→`/library.html` | 保旧收藏链接不 404 | — |

**顶部导航由 `shell.js` 统一注入**：`index.html` 里的 `<header>` 是占位，会被整体替换。
主导航只有两项（资产库、资产图谱）+ 右侧「后台管理 / 退出登录」。
`shell.js` 还 monkey-patch 了 `fetch`：任何同源 `/api/` 返回 401 就跳登录页。

## 2. 主题与 CSS 变量

- 键：`localStorage['aigccat.theme']`，值 `light` / `dark`，写到 `document.documentElement.dataset.theme`。
- 切换后广播 `window` 事件 `aigccat-theme`；Three.js 查看器监听它同步 `--stage` / `--grid`。
- 共享变量：`--bg` `--panel` `--surface` `--input` `--text` `--muted` `--border` `--accent` `--stage` `--grid`。
- **不要新增独立配色主题**，一律走变量。

## 3. 工作台布局

三栏 grid `320px minmax(260px,1fr) 264px`（`workbench.css`）：

- **左**：工具轨 `#tool-rail`（76px）+ 参数面板 `#tool-title` / `#parameters` / `#run-tool`
- **中**：`#model-stage` / `#image-stage` / `#empty-stage` + 底部 `#selection-info`、撤销重做、`#job-progress`
- **右**：资产面板 5 个 tab —— 资产 / 属性 / 历史 / 图片 / 构建
- 浮层：通用弹窗 `#dialog`、`#toast`、视口内 `.viewport-dock`（显示模式/朝向/骨骼/下载）、`.axis-gizmo` 方位罗盘

## 4. 工具清单（11 个）

定义在 `workbench.js` 的 `TOOLS` 常量，完整清单见下表。

| # | id | 名称 | 说明 |
|---|---|---|---|
| 1 | `image` | 图片创作 | 文字 + 可选图片；`four_views` 出前/后/左/右四张独立图 |
| 2 | `model` | 模型构建 | 文字 / 单图 / 多视图 / 批量 → Tripo 或 Studio |
| 3 | `split` | 部件管理 | 锐边 > 35° 拆分，含预分割档 |
| 4 | `remesh` | 网格整理 | 减面 / 重拓扑 / 四边面 |
| 5 | `uv` | UV 展开 | 智能 / 角度（66° 极限角） |
| 6 | `texture` | 贴图处理 | 4 种模式：AI 贴图 / 应用上传纹理 / 打开贴图绘制 |
| 7 | `paint` | 贴图绘制 | `texture` 子工具，保存为 `workbench_paint` 版本 |
| 8 | `upscale` | 贴图尺寸 | `texture` 子工具，仅本地重采样（AI 超分未接入） |
| 9 | `pbr` | 材质参数 | `texture` 子工具，颜色 / 粗糙度 / 金属度 |
| 10 | `rig` | 绑骨蒙皮 | 打开 AI 绑骨助手（OpenCode → Blender） |
| 11 | `animation` | 动作制作 | 模型动作（clips）+ Studio 动作模板两种面板 |

**工具栏可见性**：无模型时只显示 `image` / `model`；子工具仅在同族工具下显示。

**前置条件校验**：`split/remesh/uv/texture/paint/upscale/pbr/rig/animation` 需要「已有资产 + 有模型版本」，不满足时渲染 `.tool-requirement` 引导横幅并禁用运行按钮。

### 模型构建参数说明

参数标题或开关旁的 `?` 不额外占行。鼠标悬停或键盘聚焦显示浮层；点击（含触屏）可固定，再次点击、Escape、点击外部或滚动参数栏关闭。帮助操作不修改参数或提交生成请求。

模型构建页右下角提供可开启的猫咪新手向导，使用具体例子、开关／档位对比和网格示意图解释术语。默认关闭，开启状态保存在本机；开启后可选择话题，也可随参数问号切换内容。话题跟随当前可用参数。猫咪是轻量 SVG 占位形象，不是 Live2D 模型。

覆盖目标面数、几何精度、四边面拓扑、生成纹理、PBR、贴图质量与导出尺寸，分别说明含义、用途和限制。四边面请求不保证 GLB 保留四边面，导出尺寸也不等于生成细节质量。

此阶段不提供报价：网页订阅积分与 API 额度分别标注「当前配置费用待确认」。

文案依据：

- [Tripo v3.1 官方说明](https://developers.tripo3d.ai/en/models/v3-1) 与 [生成接口文档](https://platform.tripo3d.ai/docs/generation)：面数、几何、纹理与拓扑参数的一般语义。Studio 档位不套用 API 枚举或价格。
- [glTF 2.0 网格规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#meshes) 与 [材质规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials)：网格原语及 metallic-roughness 材质。
- 当前接入范围和参数传递以 `web/src/tripo.rs`、`scripts/studio-runner/client.cjs` 和 `scripts/studio-runner/export-generated.cjs` 为准；`texture_size` 用于后续导出。界面隐藏某项表示当前工作台未提供，不代表上游服务没有该能力。

## 5. 顶部流程指示

`FLOW_STEPS` 定义 **6 步**：参考 → 建模 → 整理 → 贴图 → 绑骨 → 动作。
无模型时退化为**精简 3 步**（准备参考 / 生成模型 / 完善模型）。

完成态由 `flowDone()` 按**真实产物**判定（不看操作顺序）：例如绑骨看 `meshes.some(m => m.isSkinnedMesh)`、动作看 `viewer.clips.length`、贴图看材质是否带 `map`。

## 6. 查看器（`viewer.js`）

- 5 种显示模式：白模 / 线框叠加 / 纹理 / 反照率 / 法线；独立骨骼开关；下载按钮。
- 视角预设：front / back / left / right / top / 34°（`camFor`）。
- 动画时间轴：上一帧 / 播放暂停 / 下一帧 / scrub / 帧计数（fps=24）。
- 对外事件：`viewer-load-progress`、`viewer-model-state`、`viewer-download`（可取消，被拦截后改为弹导出对话框）。
- **`on()` 是 `createViewer` 的局部函数**，作用域外用 `v.events.signal`。

## 7. 前端文件职责

| 文件 | 职责 |
|---|---|
| `index.html` | 纯 shell 骨架（~185 行），业务全在 `workbench.js` |
| `workbench.js` | 工作台主逻辑：11 个工具、资产 CRUD、版本历史、图片台账 |
| `library.html` | 资产库 + 图片资源页（单文件内联 module，~870 行） |
| `canvas.js` | 资产图谱：5 级节点、4 种布局（tree/radial/grid/scatter） |
| `viewer.js` | 共享 Three.js 预览器（library 与 workbench 共用） |
| `shell.js` / `shell.css` | 统一导航注入、主题、401 兜底 |
| `model-actions.js` | 模型动作面板（clips） |
| `rig-agent.js` | AI 绑骨助手 UI（操作记录、检查图、停止、历史） |
| `studio-motions.js` | Studio 动作模板库（101 条硬编码记录） |
| `model-download.js` | 已打开模型的缓存（内存 384MiB + IndexedDB 2GiB，ETag 校验） |
| `image-interactions.js` | 全站图片拖拽与大图预览 |
| `project-folders.js` / `asset-trash.js` | 项目归档 / 回收站软删除（只接受 `archive_add` \| `archive_remove` 增量） |
| `creation-settings.js` / `creative-examples.js` | 图片创作比例与多组开关 / 六张图文案例 |
| `generation-indicator.js` | 生成进度环（300 秒为**预估**，不是真实进度） |

> 资产详情页定义在 `workbench.js`；`library.html` 只包含资产库与图片资源。

## 8. 改前端时的硬性约定

1. **必须 bump 版本号**：`index.html` 的 `?v=`，以及 `workbench.js` / `library.html` 里的 `viewer.js?v=`。否则浏览器用旧缓存。
2. **模块加载顺序变更必须 Firefox + Chrome 双验收**（Chrome 通过不代表 Firefox 通过）。
3. **两套 `api()` 错误模型并存**：`workbench.js` **不设** `err.status`（状态码只在 message 字符串里）；`library.html` **设了** `err.status`。改错误分支前先确认自己在哪个文件。
4. `asset_type` 是单数、URL 目录是复数，必须经 `dirOf()` / `DIR_OF` 映射。
5. `GET /api/assets/{dir}/{id}` 返回的是**信封** `{asset, spec, latest, jobs, flow_activity}`，且 `latest` 本身是三元组 → 出现双重 `.latest` 取值。
6. `jobs` 字段是**文件名数组**（`["job_001.json", ...]`），必须剥 `.json` 再逐个 GET。
7. `PUT /api/workbench/state` 字段白名单极严；回收站必须用 `archive_add` / `archive_remove` 增量，直接 PUT `archived` 会被 409 拒绝。
8. 409 `stale_head` 的 body 是 JSON，但经 `api()` 后变成字符串 → 需 `JSON.parse(e.message)`。
