# 3D 生成供应商官方接口对照（2026-09-17 逐家核对；09-18 五家全部接入）

> 这是 `web/src/providers.rs` 注册表的依据。五家的端点、鉴权、任务模型均按官方文档核实，
> 且**全部接入生成链路**（Tripo 走 `tripo.rs`，其余四家各有独立传输层）。

## 总览

| 供应商 | 官方端点 | 鉴权 | Key 格式 / 获取 | 传输层 |
|---|---|---|---|---|
| Tripo 3D | `https://openapi.tripo3d.ai/v3` | `Authorization: Bearer <key>` | platform.tripo3d.ai 开发者后台 | ✅ `tripo.rs` |
| Meshy | `https://api.meshy.ai/openapi/v2` | `Authorization: Bearer msy_…` | meshy.ai/settings/api | ✅ `meshy.rs` |
| Rodin (Hyper3D) | `https://api.hyper3d.com/api/v2` | `Authorization: Bearer <key>` | developer.hyper3d.ai 的 API Key 管理 | ✅ `rodin.rs` |
| Hunyuan3D | `https://ai3d.tencentcloudapi.com` | **腾讯云 TC3 签名**（SecretId + SecretKey） | 腾讯云 CAM 密钥（需 QcloudAI3DFullAccess）；**后台 Key 栏填 `SecretId:SecretKey`（英文冒号）** | ✅ `hunyuan.rs` |
| Hi3D (Hitem3D) | `https://api.hitem3d.ai/open-api/v1` | `Authorization: Bearer <accessToken>` | Hitem3D 开放平台 | ✅ `hi3d.rs` |

后台「模型配置管理」可以为全部五家填写 Key 并启停模型；环境变量只作为
**首次登记时的初值**（`TRIPO_API_KEY`、`MESHY_API_KEY`、`RODIN_API_KEY`、
`HUNYUAN_SECRET_ID` + `HUNYUAN_SECRET_KEY`（两段都要有）、`HITEM3D_API_KEY`），
保存过一次后以目录里存的为准。混元的服务地域用 `HUNYUAN_REGION` 覆盖（默认 `ap-guangzhou`）。

## 各家能力与限制（生成入口会如实校验）

| | 文字→3D | 单图→3D | 多视图 | 备注 |
|---|---|---|---|---|
| Tripo | ✅ | ✅ | ✅（四视图） | 订阅模式另有高质量选项 |
| Meshy | ✅ | ✅ | ❌ | 资产只保留 3 天，完成即落盘；有官方测试 Key |
| Rodin | ✅ | ✅ | ❌ | tier 必须显式传（缺省会回落到 Gen-1/1.5） |
| Hunyuan3D | ✅（≤200 字） | ✅ | ❌ | 图片编码后 ≤6MB；任务号 24 小时有效 |
| Hi3D | ❌（官方要求必须有输入图片） | ✅ | ❌ | 下载链接 1 小时有效；PBR 仅 v2.0/v2.1/v3.0 |

## 逐家说明

### Tripo 3D（已接入，`web/src/tripo.rs`）

- 提交：`POST /text-to-model`、`POST /image-to-model`（body 为 JSON，图片先 `POST /files` 换 file_token）
- 查询：`GET /tasks/{task_id}` → `data.status`（queued/running/success/failed/cancelled）
- 结果：`data.output.model_url`（GLB）、`data.output.rendered_image_url`（预览）
- 状态：`code==0` 才算成功；余额 `GET /account/balance`
- 官方文档：<https://platform.tripo3d.ai/docs>

### Meshy（已接入，`web/src/meshy.rs`）

- 提交：`POST /text-to-3d`（`{prompt, mode:"preview", enable_pbr, topology:"quad"}`）
  / `POST /image-to-3d`（`{image_url: "data:image/png;base64,…"}`，也接受公网 URL）
- 查询：`GET /text-to-3d/{task_id}`、`GET /image-to-3d/{task_id}`
  → `status`：`PENDING → IN_PROGRESS → SUCCEEDED / FAILED / CANCELED`
- 结果：`model_urls.glb`（另有 fbx/obj/usdz/stl/mtl）、`thumbnail_url`、`consumed_credits`
- 模型：`latest`（当前=Meshy 6）/ `meshy-6` / `meshy-5`
- 官方测试 Key（不扣积分、返回样例结果）：`msy_dummy_api_key_for_test_mode_12345678`
- 注意：非企业用户的生成资产**只保留 3 天**，必须立刻落盘（本链路已这样做）
- 官方文档：<https://docs.meshy.ai>

### Rodin / Hyper3D（待接入）

- 提交：`POST /v2/rodin`，**multipart 表单**：`prompt`（文生）或 `images`（图生，1–5 张）、
  `tier`（Gen-2.5-Medium / Gen-2 / Regular / Sketch / Detail / Smooth）、`mesh_mode`（Quad/Raw）、
  `quality`（high 50000 / medium 18000 / low 8000 / extra-low 4000，或 `quality_override` 500–200000）、
  `geometry_file_format`、`material`
- 响应：`{uuid, jobs:{uuids, subscription_key}, consumed}`
- 查询：`POST /v2/status`，body `{"subscription_key": …}` → 每个 job 的状态（Done/Failed）
- 下载：`POST /v2/download`，body `{"task_uuid": …}` → 结果 URL 列表
- 官方文档：<https://docs.hyper3d.ai>（快速入门：<https://docs.hyper3d.ai/en/get-started/quick-start>）

### Hunyuan3D / 腾讯混元生3D（待接入）

**鉴权与其它四家不同**：走腾讯云 API 3.0 的 **TC3-HMAC-SHA256 签名**
（SecretId + SecretKey，公共参数 X-TC-Action / X-TC-Timestamp / X-TC-Version / X-TC-Region）。

三个产品面（按需选一，推荐极速版）：

| 产品面 | 端点域名 | 提交 Action | 查询 Action |
|---|---|---|---|
| 极速版（推荐） | `ai3d.tencentcloudapi.com`，Version `2025-05-13` | `SubmitHunyuanTo3DRapidJob` | `QueryHunyuanTo3DRapidJob` |
| 专业版 | 腾讯云混元（product 1284） | `SubmitHunyuanTo3DJob` | `QueryHunyuanTo3DProJob` |
| MPS 托管版 | `mps.tencentcloudapi.com`，Version `2019-06-12` | `SubmitHunyuan3DTask` | `QueryHunyuan3DTask` |

- 极速版参数：`Prompt`（文生，≤200 字）或 `ImageBase64` / `ImageUrl`（图生，二选一）、
  `ResultFormat`（OBJ/GLB/STL/USDZ/FBX/MP4）、`EnablePBR`、`EnableGeometry`
- 专业版状态：`WAIT / RUN / FAIL / DONE`，结果在 `ResultFile3Ds`
- 额度：新用户 1000 积分体验；默认并发 1
- 官方文档：<https://cloud.tencent.com/document/product/1804/123463>

### Hi3D / Hitem3D（待接入）

- 提交：`POST /open-api/v1/submit-task`，**multipart 表单**：
  `images`（单图）或 `multi_images`（≤4 张，顺序为 front/back/left/right）、
  `request_type`（1=仅几何 / 2=仅纹理 / 3=几何+纹理）、`model`（hi3dv3.0 / hitem3dv2.1 / v2.0 / v1.5）、
  `resolution`、`face`（100000–2000000）、`pbr`、`format`（1=OBJ/2=GLB/3=STL/4=FBX/5=USDZ）、`callback_url`
- 查询：`GET /open-api/v1/query-task?task_id=…` → `data.state`：
  `created → queueing → processing → success / failed`
- 结果：`data.url`（GLB）、`data.cover_url`；**下载链接 1 小时有效**
- 官方文档：<https://docs.hitem3d.ai/zh/api/api-reference/list/create-task>

## 补齐传输层的固定套路（照 meshy.rs）

1. `Client::new(Service, …)`：校验 Key、建 HTTP 客户端；
2. `create_*`：唯一一次付费 POST，拿到任务号；
3. `task(id)`：轮询（不重发）；
4. `normalize_status`：把各家状态机归一成 running/failed/success（未知状态一律继续轮询，不误判失败）；
5. `download(url, limit)`：无鉴权头、只允许公开 HTTPS，先落盘再展示；
6. `model_jobs.rs::generate` 里加一个 match 分支 + `finish_poll_*`。

## 订阅与 API 的关系（网页订阅那边的开关）

- 生成请求带 `source: "studio" | "api"`：`studio` = 网页订阅会话（凭据在容器数据卷，
  界面「连接网页订阅」处开关），`api` = 开发者 API（Key 在后台「模型配置管理」）。
- 目前订阅链路只有 Tripo 一家；其余四家均为 API 模式。
- 「账号密码换 AK / 浏览器提取凭据」等订阅级复用方案尚未定案，
  候选：外放服务 + 外网访问 + 容器内浏览器登录（复用现有 noVNC 链路）。
