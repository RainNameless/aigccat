# Third-Party Notices

## Three.js 0.160.0

工作台查看器、模型导入导出使用 Three.js 及其官方 addons，MIT 许可证见 `web/static/vendor/three-0.160.0/LICENSE`。项目：https://github.com/mrdoob/three.js。

## Lucide 0.468.0

工作台图标使用 Lucide，ISC 许可证见 `web/static/vendor/lucide-LICENSE`。项目：https://github.com/lucide-icons/lucide。

## psd2live

本仓库的以下架构设计参考了 [psd2live](https://github.com/tsunehimatoi/psd2live)（许可证：GPL-3.0）：

- **历史树**（`web/src/history.rs` 中的 append-only 分支保留历史树）：
  参考 psd2live 的 `WorkspaceHistoryTree` —— 不可变历史节点、HEAD 指针只移动不改节点、
  checkout 后提交产生分支、`expected_history_node_id` 乐观锁（stale head 冲突检测）。
- **任务检查点**（`web/src/history.rs` 中的任务计划 + 事件流）：
  参考 psd2live 的 `AgentTaskManager` —— 任务由标题与计划步骤构成，
  事件按 append-only 日志追加，旧事件永不改写。

本仓库中的实现为适配自身技术栈（Rust / axum / MinIO，历史持久化为
`history/index.json` + `history/head.json` + `tasks/{task_id}.json`）的独立重写，
并非对参考源码的逐行翻译。
