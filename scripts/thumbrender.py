#!/usr/bin/env python3
"""GLB → 高质量缩略图（纯 CPU：trimesh + matplotlib，无 GPU/无窗口依赖）。

特性：
- 自动 Z-up → Y-up 纠偏（FBX 转换常见问题，模型不再"躺着"）
- 双光源 + 负面法线补偿，阴影更立体
- 世界空间合并网格（bake node transforms）
- 深色主题背景，抗锯齿输出
"""
import io

import numpy as np

import trimesh
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection


def render_png(glb_bytes: bytes, size: int = 220, forward_axis: str = "+Z") -> bytes | None:
    if forward_axis not in ("+Z", "-Z", "+X", "-X"):
        raise ValueError(f"Unsupported forward axis: {forward_axis}")
    with _LOCK:
        return _render(glb_bytes, size, forward_axis)


import threading
_LOCK = threading.Lock()


def _face_colors(g):
    visual = g.visual
    if isinstance(visual, trimesh.visual.ColorVisuals):
        if visual.kind == "face":
            return np.asarray(visual.face_colors)[:, :3] / 255.0
        if visual.kind == "vertex":
            return (np.asarray(visual.vertex_colors)[g.faces, :3] / 255.0).mean(axis=1)
        return None
    if not isinstance(visual, trimesh.visual.texture.TextureVisuals):
        return None

    # 必须在 mesh.copy() 前读取：TextureVisuals.copy() 不保留 COLOR_0 属性。
    source = visual.vertex_attributes.get("color")
    material = visual.material
    image = getattr(material, "baseColorTexture", None)
    if image is None:
        image = getattr(material, "image", None)
    if image is not None and visual.uv is not None:
        cv = np.asarray(visual.to_color().vertex_colors)[:, :3] / 255.0
        # PBRMaterial.to_color() 采样纹理但不乘 baseColorFactor。
        factor = getattr(material, "baseColorFactor", None)
        if factor is not None:
            cv = cv * (np.asarray(factor)[:3] / 255.0)
    else:
        if isinstance(material, trimesh.visual.material.PBRMaterial):
            factor = material.baseColorFactor
            base = np.ones(3) if factor is None else np.asarray(factor)[:3] / 255.0
        else:
            base = np.asarray(material.main_color)[:3] / 255.0
        cv = np.tile(base, (len(g.vertices), 1))
    if source is not None:
        source = np.asarray(source)
        if source.shape[0] != len(g.vertices):
            raise ValueError("COLOR_0 顶点数量不匹配")
        # glTF 浮点颜色已归一化；整数颜色按分量类型归一化。
        scale = np.iinfo(source.dtype).max if np.issubdtype(source.dtype, np.integer) else 1.0
        cv = cv * np.clip(source[:, :3] / scale, 0, 1)
    return cv[g.faces].mean(axis=1)


def _render(glb_bytes: bytes, size: int, forward_axis: str = "+Z") -> bytes | None:
    try:
        scene = trimesh.load(io.BytesIO(glb_bytes), file_type="glb", force="scene", process=False)

        # 逐节点烘焙变换 + 提取材质/顶点色（成品预览的关键）
        parts = []  # (vertices, faces, face_colors)
        for node_name in scene.graph.nodes_geometry:
            try:
                T, geom_name = scene.graph[node_name]
                source = scene.geometry[geom_name]
                if len(source.faces) == 0:
                    continue
                fc = _face_colors(source)
                g = source.copy()
                g.apply_transform(T)
                parts.append((g.vertices.copy(), g.faces.copy(), fc))
            except Exception:
                continue
        if not parts:
            return None
        v = np.vstack([p[0] for p in parts])
        f = np.vstack([p[1] + (0 if i == 0 else sum(len(x[0]) for x in parts[:i]))
                       for i, p in enumerate(parts)])
        fcs = [p[2] for p in parts]
        has_color = any(c is not None for c in fcs)

        fig = plt.figure(figsize=(size / 100, size / 100), dpi=100)
        ax = fig.add_subplot(111, projection="3d")

        # glTF 是 Y-up，matplotlib 3D 是 Z-up → 交换 Y/Z 轴，模型才站得正
        merged = trimesh.Trimesh(vertices=v, faces=f, process=False)
        n = merged.face_normals
        v = np.column_stack([v[:, 0], v[:, 2], v[:, 1]])
        n = np.column_stack([n[:, 0], n[:, 2], n[:, 1]])
        # 双光源光照：主光 + 补光，避免背面全黑
        l1 = np.array([0.45, 0.35, 0.82]); l1 /= np.linalg.norm(l1)
        l2 = np.array([-0.6, 0.2, 0.4]); l2 /= np.linalg.norm(l2)
        inten = 0.38 + 0.52 * np.clip(n @ l1, 0, 1) + 0.18 * np.clip(n @ l2, 0, 1)
        fallback = np.array([0.70, 0.74, 0.84])
        if has_color:
            base = np.vstack([c if c is not None else np.tile(fallback, (len(parts[i][1]), 1))
                              for i, c in enumerate(fcs)])
        else:
            base = np.tile(fallback, (len(f), 1))
        colors = np.clip(base * inten[:, None], 0, 1)

        ax.add_collection3d(Poly3DCollection(
            v[f], facecolors=colors, edgecolors="none", antialiased=True))

        c = (v.max(0) + v.min(0)) / 2
        r = (((v.max(0) - v.min(0)).max() / 2) or 1) * 1.08
        ax.set_xlim(c[0] - r, c[0] + r)
        ax.set_ylim(c[1] - r, c[1] + r)
        ax.set_zlim(c[2] - r, c[2] + r)
        # 按资产正面轴选择相机；Y/Z 交换后原 Z 轴对应 matplotlib Y 轴。
        ax.set_proj_type("ortho")
        ax.set_box_aspect((1, 1, 1), zoom=1.45)
        ax.view_init(elev=0, azim={"+Z": 90, "-Z": -90, "+X": 0, "-X": 180}[forward_axis])
        ax.set_axis_off()
        ax.set_facecolor("#0a0f1d")
        fig.patch.set_facecolor("#0a0f1d")
        plt.tight_layout(pad=0)
        buf = io.BytesIO()
        plt.savefig(buf, format="png", dpi=100)
        plt.close(fig)
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        return None
