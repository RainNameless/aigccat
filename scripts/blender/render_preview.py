"""渲染 GLB 缩略图（正视图），供资产预览自动使用。

CLI: blender -b --python render_preview.py -- <src.glb> <out.png> [size]
输出: PNG（透明背景）+ 末行 WORKER_STATS {"preview": {...}}

要点（Blender 5.2.1）：
- 渲染引擎 ID 是 BLENDER_EEVEE（4.x 的 BLENDER_EEVEE_NEXT 已废弃）
- 默认 AgX 色彩变换会冲淡材质本色，这里用 Standard 还原
- GLB 为 Y-up，glTF 的 +Z（正面）导入 Blender 后落在 -Y 方向
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector


def scene_bounds():
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not objs:
        return None
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for obj in objs:
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, world.x), min(lo.y, world.y), min(lo.z, world.z)))
            hi = Vector((max(hi.x, world.x), max(hi.y, world.y), max(hi.z, world.z)))
    return lo, hi


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    src, out = argv[0], argv[1]
    size = int(argv[2]) if len(argv) > 2 else 320

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    bounds = scene_bounds()
    if bounds is None:
        print("WORKER_STATS " + json.dumps({"preview": {"ok": False, "reason": "no_mesh"}}))
        return
    lo, hi = bounds
    center = (lo + hi) / 2
    dims = hi - lo
    height = max(dims.z, 0.2)

    scene = bpy.context.scene
    # 引擎可切换：EEVEE 需要 GL 上下文，容器里没有 GPU 时起不来
    # （实测报 EGL_BAD_MATCH，就算强制软件 GL 也 Aborted）。容器里用 Cycles 纯 CPU 渲染，
    # 由 AIGCCAT_RENDER_ENGINE 控制（默认仍是 EEVEE，宿主机行为不变）。
    engine = os.environ.get("AIGCCAT_RENDER_ENGINE", "BLENDER_EEVEE")
    scene.render.engine = engine
    if engine == "CYCLES":
        scene.cycles.device = "CPU"
        scene.cycles.samples = int(os.environ.get("AIGCCAT_CYCLES_SAMPLES", "16"))
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = out
    # 还原本色（AgX 会把彩色材质洗淡）
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    # 正视图相机：Blender 里角色面朝 +Y（glTF 正视方向导入后的落位），
    # 因此相机放在 +Y 侧朝中心看；用 look-at 计算朝向避免手推欧拉角出错。
    cam_data = bpy.data.cameras.new("preview_cam")
    cam_data.type = "ORTHO"
    margin = 1.12
    cam_data.ortho_scale = max(dims.x, height) * margin
    cam = bpy.data.objects.new("preview_cam", cam_data)
    cam.location = (center.x, center.y + height * 3.0, center.z)
    cam.rotation_euler = (center - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(cam)
    scene.camera = cam

    # 三点照明：主光在相机左前上方，补光在右前，背光在后
    def add_light(name, energy, loc, kind="AREA", size_hint=3.0):
        data = bpy.data.lights.new(name, type=kind)
        data.energy = energy
        if kind == "AREA":
            data.size = size_hint
        obj = bpy.data.objects.new(name, data)
        obj.location = loc
        direction = center - Vector(loc)
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(obj)

    span = max(height, 0.5)
    # 能量按模型尺寸线性缩放并保持克制：过曝会把深色头发洗成粉白、黑衣服洗成灰，
    # 缩略图就失去了区分材质的作用。EEVEE + Standard 变换下这套值不易过曝。
    scale = span / 1.8
    add_light("key", 190 * scale, (center.x - span * 1.4, center.y - span * 2.0, center.z + span * 1.2))
    add_light("fill", 70 * scale, (center.x + span * 1.6, center.y - span * 1.6, center.z + span * 0.4))
    add_light("rim", 110 * scale, (center.x, center.y + span * 2.2, center.z + span * 1.6))

    # 世界背景给一点环境光，避免背面全黑
    world = bpy.data.worlds.new("preview_world")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.05, 0.06, 0.08, 1)
        bg.inputs[1].default_value = 1.0
    scene.world = world

    bpy.ops.render.render(write_still=True)

    ok = os.path.exists(out) and os.path.getsize(out) > 0
    tris = 0
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            obj.data.calc_loop_triangles()
            tris += len(obj.data.loop_triangles)
    print("WORKER_STATS " + json.dumps({
        "preview": {"ok": ok, "path": out, "bytes": os.path.getsize(out) if ok else 0,
                    "size": size, "engine": "BLENDER_EEVEE"},
        "triangles": tris,
    }))


main()
