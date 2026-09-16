# aigccat MCP 接入指南

> 给 Codex / Claude / Cursor / 任意支持 MCP 的 AI：
> **你不需要任何 OpenAI / Tripo API key。你自己就是生成引擎**——生成图片或模型后，
> 通过这里的工具把产物推进 aigccat，由 aigccat 负责归类、版本管理、审核、编译、回滚。

## 1. 启动 MCP Server

```bash
cd /path/to/aigccat                    # 本仓库根目录
pip install mcp                      # 或 pip install 'mcp<2'
AIGCCAT_WEB=http://localhost:8080 python3 mcp_server/aigccat_mcp.py   # stdio
```

前提：`docker compose up -d`，web 服务在 :8080 可用。

## 2. 客户端配置

### Codex（`~/.codex/config.toml`）
```toml
[mcp_servers.aigccat]
command = "python3"
args = ["/path/to/aigccat/mcp_server/aigccat_mcp.py"]
env = { AIGCCAT_WEB = "http://localhost:8080" }
```

### Claude Desktop（`claude_desktop_config.json`）
```json
{
  "mcpServers": {
    "aigccat": {
      "command": "python3",
      "args": ["/path/to/aigccat/mcp_server/aigccat_mcp.py"],
      "env": { "AIGCCAT_WEB": "http://localhost:8080" }
    }
  }
}
```

## 3. 工具清单（17 个）

| 分类 | 工具 | 说明 |
|---|---|---|
| 查询 | `list_assets` | 按类型列出资产 |
| 查询 | `get_asset(dir_name, asset_id)` | 详情：contract + spec + 三态指针 + jobs |
| 查询 | `taxonomy()` | 层级分类树（大类 → 性别/年龄/服装类型） |
| 查询 | `model_outline(dir, id, version)` | 模型大纲：节点树/网格/材质/三角面 |
| 创建 | `create_asset(description, name?, asset_type?, style?)` | 自然语言创建（服务端 LLM 生成 spec + 自动分类） |
| 管线 | `generate_references` / `approve_references` | 三视图生成 / 快速批准 |
| 管线 | `generate_model(candidates=1..5)` / `approve_version` / `publish_version` | 3D 生成 / 批准 / 发布 |
| 管线 | `set_anchor` / `rollback(to_version)` | 选锚点 / 回滚 published 指针 |
| **推送** | `push_image(dir, id, kind, image_path \| image_b64, version?)` | **把你生成的图片推进资产库并自动归类** |
| **推送** | `push_model(dir, id, model_path \| model_b64, provider?)` | **把你生成的 GLB 推成新版本（自动校验）** |
| 批量 | `batch(op, assets[], style?)` | approve_references / approve_models / auto_publish / regenerate_* / publish / rollback / global_style_apply |
| 交付 | `compile_bundle(dir, id, version)` | 编译引擎包（GLB + Contract + 大纲 + manifest） |
| 修改 | `ai_modify(dir, id, instruction)` | 自然语言改 spec（服务端 LLM，返回 diff） |

> 合成体 `create_composition` 已不再提供：后端路由、MCP 工具与前端入口均已删除。

## 4. 图片推送协议：`kind` 决定归类位置

| kind | 落盘位置 | 语义 |
|---|---|---|
| `reference_front` / `reference_side` / `reference_back` | `source/reference_*.png` | 三视图（模型的生成依据） |
| `preview`（需 `version`） | `versions/<v>/preview.png` | 版本缩略图，同时写回 `asset.json.preview` |
| `qa_front` / `qa_side` / `qa_back` / `qa_34`（需 `version`） | `versions/<v>/qa/*.png` | 标准渲染集（审核必看多视角） |

推送即**自动归类进知产**：文件落在资产的固定目录树里，版本号只增不改，
变更写进 `jobs/*.json`（谁在什么时候推的），版本三态指针（latest/approved/published）由审核动作推进。

## 5. 归类规则（AI 必须遵守）

- **大类（12 类受控枚举）**：`character` `animal` `prop` `building` `environment`
  `vegetation` `ground` `sky` `vehicle` `material` `effect` `apparel`
  - 人 → `character`；衣服/鞋帽 → `apparel`（独立分类，不与角色混）
- **taxonomy 子维度**：`gender`（male/female/unisex）、`age_group`（infant/child/teen/adult/elder）、
  `apparel_type`（top/bottom/dress/shoes/hat/accessory）
- **目录映射**（`dir_name` 参数）：characters / animals / props / buildings / environments /
  vegetation / grounds / skies / vehicles / materials / effects / **apparel**
- **asset_id 规则**：`<前缀>_<英文slug>_<三位序号>`，如 `chr_npc_villager_001`、`app_winter_coat_001`

## 6. 典型对话示例（无 key 的 AI 怎么用）

> 用户：给我做一个穿冬季外套的村民角色，再配一顶毛线帽

AI 的执行序列（全部走 MCP，零 API key）：

1. `create_asset("村民角色，冬季外套，1.7 米", name="冬装村民", asset_type="character")`
   → 拿到 `chr_npc_villager_001`（若 AI 自己有描述能力，也可直接 `ai_modify` 精修 spec）
2. AI 自己画三张图（本地生成/其他工具）→
   `push_image("characters","chr_npc_villager_001","reference_front", image_path="/tmp/front.png")` 同理 side/back
3. `approve_references("characters","chr_npc_villager_001")`（或 `batch("approve_references", [...])` 快速批）
4. AI 自己生成/拿到 GLB →
   `push_model("characters","chr_npc_villager_001", model_path="/tmp/girl.glb", provider="codex")`
   → 自动校验（结构/网格/身高 ±20%）→ 生成 `v001`
5. `approve_version(...)` → `publish_version(...)`（或 `batch("auto_publish", [...])` 一条龙）
6. `compile_bundle(...)` → 下载引擎包交付 Unity/Godot

## 7. 免人工审核（快速批）

- 单次：`batch("approve_references"|"approve_models"|"auto_publish", ["characters/chr_x_001", ...])`
- 全局免审：compose 里给 web 服务加环境变量

```yaml
web:
  environment:
    AUTO_APPROVE: "1"   # 生成后自动通过两个审核点
    AUTO_PUBLISH: "1"   # 校验通过即自动发布
```
