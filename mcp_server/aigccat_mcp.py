#!/usr/bin/env python3
"""aigccat MCP Server —— 让 Codex / Claude / Cursor 等任意支持 MCP 的 AI 直接驱动资产管线。

核心价值：AI 客户端不需要任何 OpenAI/Tripo API key，AI 自己就是"生成引擎"，
它调用本服务提供的工具，把自己生成的图片/模型推送进 aigccat，由 aigccat 负责：
  资产归类 → 版本管理 → 三态指针（latest/approved/published）→ 编译成引擎包 → 回滚

启动（stdio）：
  python3 mcp_server/aigccat_mcp.py
环境变量：
  AIGCCAT_WEB=http://localhost:8080
"""
import base64
import json
import os
import urllib.error
import urllib.request

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers

WEB = os.environ.get("AIGCCAT_WEB", "http://localhost:8080")

try:  # mcp 2.x: FastMCP 改名为 MCPServer
    from mcp.server.mcpserver import MCPServer as _Server
except ImportError:  # pragma: no cover - mcp 1.x
    try:
        from mcp.server.fastmcp import FastMCP as _Server
    except ImportError:
        raise SystemExit("需要安装 mcp: pip install 'mcp<2' 或 pip install mcp")

mcp = _Server("aigccat", instructions=(
    "aigccat 是 AI 游戏资产管线。你可以不持有任何 API key：你负责生成内容（图片/模型/描述），"
    "调用这里的工具把产物推入资产库，由 aigccat 完成归类、版本管理、审核流与引擎包编译。 "
    "分类为 12 类受控枚举：character/animal/prop/building/environment/vegetation/ground/sky/"
    "vehicle/material/effect/apparel；taxonomy 维度：gender / age_group / apparel_type。"
))


# ---------- HTTP helper ----------
def _req(method, path, body=None, raw=False):
    url = f"{WEB}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"})
    try:
        with _auth_urlopen(req, timeout=600) as resp:
            payload = resp.read()
            return payload if raw else json.loads(payload)
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:400]
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None


# ---------- 发现 / 查询 ----------
@mcp.tool()
def list_assets(asset_type: str = "") -> str:
    """列出资产库。asset_type 留空=全部，可填 character/prop/ground/apparel 等 12 类之一。"""
    r = _req("GET", "/api/assets")
    items = r.get("assets", [])
    if asset_type:
        items = [a for a in items if a.get("asset_type") == asset_type]
    return json.dumps({"count": len(items), "assets": items}, ensure_ascii=False)


@mcp.tool()
def get_asset(dir_name: str, asset_id: str) -> str:
    """查看资产详情（contract + spec + 版本三态 + job 列表）。
    dir_name 是类目复数目录：characters/props/grounds/apparel/..."""
    return json.dumps(_req("GET", f"/api/assets/{dir_name}/{asset_id}"), ensure_ascii=False)


@mcp.tool()
def taxonomy() -> str:
    """查看层级分类编排：大类 → 性别 / 年龄 / 服装类型 及各类数量。"""
    return json.dumps(_req("GET", "/api/taxonomy"), ensure_ascii=False)


@mcp.tool()
def model_outline(dir_name: str, asset_id: str, version: str) -> str:
    """查看某版本的模型大纲：节点树 / 网格 / 材质 / 三角面 / 顶点。"""
    return json.dumps(_req("GET", f"/api/assets/{dir_name}/{asset_id}/versions/{version}/outline"),
                      ensure_ascii=False)


# ---------- 创建与推进管线 ----------
@mcp.tool()
def create_asset(description: str, name: str = "", asset_type: str = "", style: str = "") -> str:
    """用自然语言创建资产（服务端调 LLM 生成 spec 并自动分类）。返回 asset_id。"""
    body = {"description": description}
    if name: body["name"] = name
    if asset_type: body["asset_type"] = asset_type
    if style: body["style"] = style
    return json.dumps(_req("POST", "/api/assets", body), ensure_ascii=False)


@mcp.tool()
def generate_references(dir_name: str, asset_id: str) -> str:
    """生成（或重生成）三视图。AUTO_APPROVE=1 时会自动跳过人工审核点。"""
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/references"), ensure_ascii=False)


@mcp.tool()
def approve_references(dir_name: str, asset_id: str) -> str:
    """快速批准参考图（审核点 1）。"""
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/references/approve"),
                      ensure_ascii=False)


@mcp.tool()
def generate_model(dir_name: str, asset_id: str, candidates: int = 1) -> str:
    """生成 3D 模型（1-5 个候选）。无 Tripo key 时返回内置 stub 供流程验证。"""
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/model",
                           {"candidates": max(1, min(5, candidates))}), ensure_ascii=False)


@mcp.tool()
def approve_version(dir_name: str, asset_id: str, version: str) -> str:
    """批准某版本（审核点 2）。"""
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/versions/{version}/approve"),
                      ensure_ascii=False)


@mcp.tool()
def publish_version(dir_name: str, asset_id: str, version: str) -> str:
    """发布某版本（需先批准）。"""
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/versions/{version}/publish"),
                      ensure_ascii=False)


@mcp.tool()
def rollback(dir_name: str, asset_id: str, to_version: str) -> str:
    """把 published 指针回滚到历史版本（不删文件）。"""
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/rollback",
                           {"to_version": to_version}), ensure_ascii=False)


@mcp.tool()
def set_anchor(dir_name: str, asset_id: str, version: str) -> str:
    """在候选批次中选定锚点版本（latest 指针随之移动）。"""
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/versions/{version}/anchor"),
                      ensure_ascii=False)


# ---------- 外部 AI 产物推送（核心：无 key 也能入库归类）----------
@mcp.tool()
def push_image(
    dir_name: str,
    asset_id: str,
    kind: str,
    image_path: str = "",
    image_b64: str = "",
    version: str = "",
) -> str:
    """把 AI 生成的图片推送进资产库并自动归类。

    kind 决定存放位置与语义：
      reference_front / reference_side / reference_back → source/reference_*.png（三视图）
      preview                                          → versions/<version>/preview.png（版本缩略图）
      qa_front / qa_side / qa_back / qa_34             → versions/<version>/qa/*.png（标准渲染集）
    image_path 与 image_b64 二选一（本地文件或 base64）。
    返回存放 key，服务端会同步更新 asset.json 的 preview 字段（kind=preview 时）。
    """
    if not image_path and not image_b64:
        raise RuntimeError("需要提供 image_path 或 image_b64")
    data = open(image_path, "rb").read() if image_path else base64.b64decode(image_b64)
    if kind.startswith("reference_"):
        key = f"source/{kind}.png"
    elif kind == "preview":
        if not version:
            raise RuntimeError("kind=preview 需要 version")
        key = f"versions/{version}/preview.png"
    elif kind.startswith("qa_"):
        if not version:
            raise RuntimeError("kind=qa_* 需要 version")
        key = f"versions/{version}/qa/{kind}.png"
    else:
        raise RuntimeError(f"未知 kind: {kind}")
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/file/{key}",
                           {"bytes_b64": base64.b64encode(data).decode()}), ensure_ascii=False)


@mcp.tool()
def push_model(dir_name: str, asset_id: str, model_path: str = "", model_b64: str = "",
               provider: str = "external_ai") -> str:
    """把 AI/工具生成的 GLB 推送成新版本（自动校验 + 版本号递增 + latest 指针前进）。

    校验内容：GLB 结构 / 网格存在 / 包围盒 / 与 spec 身高偏差 ±20%。
    返回新版本号与校验结果。
    """
    data = open(model_path, "rb").read() if model_path else base64.b64decode(model_b64 or "")
    if not data:
        raise RuntimeError("需要提供 model_path 或 model_b64")
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/versions/import",
                           {"glb_b64": base64.b64encode(data).decode(), "provider": provider}),
                      ensure_ascii=False)


# ---------- 批量 / 编译 / 导入 ----------
@mcp.tool()
def batch(op: str, assets: list, style: str = "") -> str:
    """批量操作（顺序执行，允许部分成功）。

    op 可选：
      approve_references（批量批准参考图）
      approve_models（批量批准 latest 版本）
      auto_publish（快速通道：批准 + 直接发布）
      regenerate_references / regenerate_models / publish / rollback / global_style_apply
    assets 形如 ["characters/chr_asset_001", "grounds/grd_town_008"]
    """
    body = {"op": op, "assets": assets}
    if style: body["style"] = style
    return json.dumps(_req("POST", "/api/batch", body), ensure_ascii=False)


@mcp.tool()
def compile_bundle(dir_name: str, asset_id: str, version: str) -> str:
    """编译引擎交付包（GLB + Asset Contract + 大纲 + manifest），返回下载 URL。"""
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/versions/{version}/compile"),
                      ensure_ascii=False)


@mcp.tool()
def ai_modify(dir_name: str, asset_id: str, instruction: str) -> str:
    """用自然语言修改某资产的 spec（服务端调 LLM，返回 diff 与 token 消耗）。"""
    return json.dumps(_req("POST", f"/api/assets/{dir_name}/{asset_id}/modify",
                           {"instruction": instruction}), ensure_ascii=False)


if __name__ == "__main__":
    mcp.run()
