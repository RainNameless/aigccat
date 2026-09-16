# aigccat

一个通用的 3D 游戏建模平台 —— 输入一句自然语言，产出可交付给 Unity / Godot 的 3D 资产（GLB + Asset Contract）。

![license](https://img.shields.io/badge/license-Apache--2.0-blue)

[English](README.en.md) · [部署指南](docs/DEPLOYMENT.md) · [文档索引](docs/README.md)

---

## 这是什么

aigccat 是一条**自托管的 AI 3D 资产管线**：从文字或图片生成模型，带版本管理、校验、后处理、绑骨动作和引擎交付，全部跑在你自己的机器上，资产存在你自己的 MinIO 里。

它不是"能生成模型"的 demo，而是为了解决真实游戏项目里的一堆脏问题：脸型雷同、微调要全量重生成、导出到引擎后变品红、清理脚本误删已发布资产、API 成本无感、审核只看一张图看不准。

## 界面

### 工作台

11 个工具、3D 预览与朝向控制、右侧资产面板；顶部是六步流程指示。

![工作台](docs/screenshots/workbench.png)

初次使用从一句描述开始，也可以直接上传参考图：

![新建草稿](docs/screenshots/workbench-new.png)

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
- 绑骨与动作：Studio 动作模板应用；本地 AI 绑骨（AI 写 Blender 脚本，走 OpenCode 容器）

**质量与可追溯**

- GLB 结构校验：包围盒、身高比例、拓扑统计
- QA 多视角渲染集，版本可并排对比
- 成本账本与预算熔断
- 引擎包编译（GLB + Contract + 大纲 + manifest）

**界面**

- 11 个工具的工作台、无限画布资产图谱（5 级节点 / 4 种布局）
- 资产库、图片台账、项目归档与回收站
- 本机 / 内网 / 公网统一登录，后台含账号、安全、模型与创作设置、主题、审计

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
              └── 宿主工作器（可选，按需）
                    ├─ :8788  Blender 5.2.1 执行层
                    ├─ :8790  Studio 订阅会话执行器
                    └─ :8791  OpenCode → Blender 桥接
```

- **后端**：Rust + axum，全部路由注册在 `web/src/main.rs`，各模块只提供 handler
- **前端**：无框架、无构建步骤的原生 HTML/JS/CSS，Three.js 本地 vendored
- **存储**：MinIO（S3 兼容），对象 key 采用路径形态，与本地文件系统 1:1 对应
- **执行器**：Blender 相关能力跑在宿主机上，容器只负责编排

## 快速开始

```bash
git clone https://github.com/RainNameless/aigccat.git
cd aigccat
cp .env.example .env          # 填入 MINIO_ROOT_PASSWORD 与各服务 Key
docker compose -p aigccat -f docker-compose.yml up -d
```

打开 `http://localhost:8080`。

完整步骤、可选工作器、公网部署、常见问题见 **[部署指南](docs/DEPLOYMENT.md)**。

## 未接入 / 未验收（如实标注）

- Tripo **API** 建模链路代码就绪，但因账户余额为 0 **从未完成真实验收**；实际产出全部来自 Studio 网页订阅链路
- Studio **自由提示词动作**、**任意形体绑骨**未接入（人形已实测，其他形体不作通用保证）
- **AI 贴图**（Studio texture）3 次上游失败，前端已暂禁用
- HY3D、提示词→骨骼动画、Unity 适配器实机冒烟 未完成

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
                deploy/cat-tunnel=公网隧道
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

## 许可证

[Apache License 2.0](LICENSE)
