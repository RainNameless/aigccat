"""本地 Blender 建模工作器（宿主机运行）。

容器里的 web 服务无法直接调用宿主机 Blender，因此这里提供一个最小 HTTP 服务：
  GET  /healthz              -> {"ok":true,"blender":"5.2.1"}
  POST /build                -> {"glb_b64":"...","stats":{...}}
  POST /part_edit            -> {"glb_b64":"...","bytes":N,"stats":{...}}
  POST /rig                  -> {"glb_b64":"...","bytes":N,"stats":{...}}

支持的 operation：
  build      依据 plan（视觉模型输出的部件数据）生成网格并导出 GLB
  decimate   对已有 GLB 减面（ratio 为目标比例）
  remesh     对已有 GLB 做体素重拓扑（voxel_size）
  part_edit  部件级编辑：请求 {source_glb_b64, edit_params:{...}, parts:[...]}，
             经 part_editor.py 重建指定部件；失败明确返回错误，不做 fallback
  rig        自动绑骨+待机动画：请求 {source_glb_b64}，经 rig_engine.py
             （--input rig.json 仅含 source_glb/output 绝对路径）生成 15 骨
             骨骼与 idle 动画；失败判定与 part_edit 相同三项综合，不做 fallback

启动：python3 scripts/blender/worker_server.py 8788
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

BLENDER = os.environ.get("BLENDER_BIN", "/Applications/Blender.app/Contents/MacOS/Blender")
SURFACE_BUILDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "surface_builder.py")
PIXEL_BUILDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pixel_builder.py")
PART_EDITOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "part_editor.py")
WORKBENCH_PROCESSOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workbench_process.py")
RENDER_PREVIEW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "render_preview.py")
RIG_ENGINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rig_engine.py")

BUILD_CODE = r'''
import bpy, bmesh, json, os, sys, math
from mathutils import Matrix, Euler

# Plan: right-handed Y-up, front -Z. Blender: Z-up.
# C maps (x,y,z) to (x,-z,y); the glTF exporter performs C^-1 once.
C = Matrix.Rotation(math.pi / 2, 4, 'X')

plan_path, out_path = sys.argv[-2], sys.argv[-1]
with open(plan_path) as handle:
    plan = json.load(handle)

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)


def add_mesh(name, bm):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_shape(spec):
    kind = (spec.get("shape") or "cube").lower()
    bm = bmesh.new()
    if kind in ("sphere", "uv_sphere", "ball"):
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=0.5)
    elif kind in ("cube", "box"):
        bmesh.ops.create_cube(bm, size=1.0)
    elif kind == "cone":
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=24,
                              radius1=0.5, radius2=0.0, depth=1.0)
    elif kind == "cylinder":
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=24,
                              radius1=0.5, radius2=0.5, depth=1.0)
    elif kind == "torus":
        # bmesh has no create_torus operator; build the periodic surface explicitly.
        rings = []
        for i in range(32):
            a = 2 * math.pi * i / 32
            ring = []
            for j in range(12):
                b = 2 * math.pi * j / 12
                r = 0.5 + 0.16 * math.cos(b)
                ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), 0.16 * math.sin(b))))
            rings.append(ring)
        for i in range(32):
            for j in range(12):
                bm.faces.new((rings[i][j], rings[(i+1)%32][j], rings[(i+1)%32][(j+1)%12], rings[i][(j+1)%12]))
    else:
        raise ValueError('unsupported shape: ' + kind)
    # Primitive axial direction is local Y in the plan, not Blender's local Z.
    if kind in ('cone', 'cylinder', 'torus'):
        for v in bm.verts:
            v.co = (v.co.x, v.co.z, -v.co.y)
    scale = spec.get("scale") or [1, 1, 1]
    pos = spec.get("position") or [0, 0, 0]
    rot = spec.get("rotation") or [0, 0, 0]
    for v in bm.verts:
        v.co = (v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2])
    bm.verts.ensure_lookup_table()
    obj = add_mesh(spec.get("name") or kind, bm)
    obj.matrix_world = C @ Matrix.Translation(pos) @ Euler(rot, 'XYZ').to_matrix().to_4x4()
    obj['aigccat_coordinate_system'] = 'right_handed_y_up_neg_z'
    color = spec.get("color")
    if color:
        mat = bpy.data.materials.new(spec.get("name", "mat"))
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs[0].default_value = (
                color[0], color[1], color[2], 1.0)
        obj.data.materials.append(mat)
    return obj


if plan.get('coordinate_system', 'right_handed_y_up_neg_z') != 'right_handed_y_up_neg_z':
    raise ValueError('unsupported coordinate_system')
parts = plan.get("parts") or []
if not 1 <= len(parts) <= 96:
    raise ValueError('plan must contain 1..96 parts')
for spec in parts:
    build_shape(spec)

if os.path.exists(out_path):
    os.remove(out_path)
bpy.ops.export_scene.gltf(filepath=out_path, export_format="GLB", export_apply=True, export_extras=True)

stats = {
    "parts": len(parts),
    "meshes": sum(1 for o in bpy.data.objects if o.type == "MESH"),
}
print("WORKER_STATS " + json.dumps(stats))
'''

PROCESS_CODE = r'''
import bpy, json, os, sys

params_path = sys.argv[-1]
with open(params_path) as handle:
    params = json.load(handle)
src, out_path = params["src"], params["out"]
op, ratio, voxel = params.get(
    "operation"), float(params.get("ratio", 0.5)), float(params.get("voxel_size", 0.05))

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)

before = 0
for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    before += len(obj.data.loop_triangles) or len(obj.data.polygons)
    if op == "decimate":
        mod = obj.modifiers.new("Decimate", "DECIMATE")
        mod.ratio = max(0.01, min(1.0, ratio))
    elif op == "remesh":
        mod = obj.modifiers.new("Remesh", "REMESH")
        mod.mode = "VOXEL"
        mod.voxel_size = max(0.005, voxel)
    if op in ("decimate", "remesh"):
        bpy.context.view_layer.objects.active = obj
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
        except Exception as exc:
            print("MODIFIER_FAIL", exc)

after = sum(len(o.data.loop_triangles) or len(o.data.polygons)
            for o in bpy.data.objects if o.type == "MESH")
if os.path.exists(out_path):
    os.remove(out_path)
bpy.ops.export_scene.gltf(filepath=out_path, export_format="GLB", export_apply=True, export_extras=True)
print("WORKER_STATS " + json.dumps({"tris_before": before, "tris_after": after}))
'''


def blender_run(code, *argv):
    with tempfile.TemporaryDirectory() as tmp:
        code_path = os.path.join(tmp, "job.py")
        with open(code_path, "w") as handle:
            handle.write(code)
        result = subprocess.run(
            [BLENDER, "-b", "--python", code_path, "--", *argv],
            capture_output=True, text=True, timeout=600,
            env={**os.environ, 'AIGCCAT_BLENDER_SCRIPTS': os.path.dirname(os.path.abspath(__file__))},
        )
        stats = None
        for line in result.stdout.splitlines():
            if line.startswith("WORKER_STATS "):
                stats = json.loads(line[len("WORKER_STATS "):])
        if result.returncode != 0 or stats is None:
            diagnostics = result.stderr + result.stdout
            errors = [line.strip() for line in diagnostics.splitlines()
                      if line.startswith(('ValueError:', 'RuntimeError:', 'KeyError:', 'TypeError:', 'OSError:'))]
            raise RuntimeError(errors[-1][:400] if errors else 'Blender 未完成构建，请查看工作器日志')
        return stats


def run_part_editor(src, edit_params, parts, out_path):
    """调用 part_editor.py（subprocess Blender 宿主），返回 stats。

    CLI 契约：blender -b --python part_editor.py -- --input edit.json，
    edit.json 仅含 source_glb/edit_params/parts/output 四个绝对路径字段。
    失败（非零退出码、无 stats、或校验未通过）时抛出明确错误，不回退到其他生成方式。
    注意：Blender 5.2 宿主下脚本未捕获异常时退出码仍可能为 0，
    因此以 stats 文件存在且 validation_ok 为准，并附带 stderr 细节。
    """
    with tempfile.TemporaryDirectory() as tmp:
        edit_path = os.path.join(tmp, "edit.json")
        with open(edit_path, "w") as handle:
            json.dump({"source_glb": src, "edit_params": edit_params,
                       "parts": parts, "output": out_path}, handle)
        result = subprocess.run(
            [BLENDER, "-b", "--factory-startup", "--disable-autoexec",
             "--python", PART_EDITOR, "--", "--input", edit_path],
            capture_output=True, text=True, timeout=600,
        )
        stats = None
        stats_path = os.path.splitext(out_path)[0] + ".stats.json"
        if os.path.exists(stats_path):
            with open(stats_path) as handle:
                stats = json.load(handle)
        if result.returncode != 0 or stats is None or not stats.get("validation_ok", False):
            detail = (result.stderr or result.stdout).strip()[-800:] or "no diagnostics"
            if stats is not None:
                detail = f"validation errors: {stats.get('errors')}; {detail}"
            raise RuntimeError(f"part_editor failed: {detail}")
        return stats


def run_rig_engine(src, out_path):
    """调用 rig_engine.py（subprocess Blender 宿主），返回 stats。

    CLI 契约：blender -b --factory-startup --disable-autoexec
    --python rig_engine.py -- --input rig.json，
    rig.json 仅含 source_glb/output 两个绝对路径字段。
    失败判定与 part_edit 相同三项综合：非零退出码、stats 文件缺失、
    stats.validation.validation_ok != true；此时抛出明确错误，
    不回退到其他生成方式。
    注意：Blender 5.2 宿主下脚本未捕获异常时退出码仍可能为 0，
    因此以 stats 文件存在且 validation_ok 为准，并附带 stderr 细节。
    """
    with tempfile.TemporaryDirectory() as tmp:
        rig_path = os.path.join(tmp, "rig.json")
        with open(rig_path, "w") as handle:
            json.dump({"source_glb": src, "output": out_path}, handle)
        result = subprocess.run(
            [BLENDER, "-b", "--factory-startup", "--disable-autoexec",
             "--python", RIG_ENGINE, "--", "--input", rig_path],
            capture_output=True, text=True, timeout=600,
        )
        stats = None
        stats_path = os.path.splitext(out_path)[0] + ".stats.json"
        if os.path.exists(stats_path):
            with open(stats_path) as handle:
                stats = json.load(handle)
        validation_ok = (stats or {}).get("validation", {}).get("validation_ok", False)
        if result.returncode != 0 or stats is None or not validation_ok:
            diagnostics = result.stderr + result.stdout
            errors = [line.strip() for line in diagnostics.splitlines() if line.startswith(('ValueError:', 'RuntimeError:'))]
            detail = errors[-1] if errors else "模板绑骨未完成，源模型可能不是受支持的模板"
            if stats is not None:
                detail = f"validation errors: {stats.get('validation')}; {detail}"
            raise RuntimeError(f"rig_engine failed: {detail}")
        return stats


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            try:
                version = subprocess.run([BLENDER, "--version"], capture_output=True,
                                         text=True, timeout=60).stdout.split("\n")[0]
            except Exception as exc:
                self._send(500, {"ok": False, "error": str(exc)})
                return
            self._send(200, {"ok": True, "blender": version})
        else:
            self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path not in ("/build", "/part_edit", "/rig"):
            self._send(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            self._send(400, {"error": f"invalid_json: {exc}"})
            return
        try:
            with tempfile.TemporaryDirectory() as tmp:
                if self.path == "/rig" or payload.get("operation") == "rig":
                    rig_source = payload.get("source_glb_b64") or payload.get("glb_b64")
                    if not rig_source:
                        raise RuntimeError("rig requires a source GLB")
                    src = os.path.join(tmp, "source.glb")
                    with open(src, "wb") as handle:
                        handle.write(base64.b64decode(rig_source))
                    out_path = os.path.join(tmp, "out.glb")
                    stats = run_rig_engine(src, out_path)
                elif "source_glb_b64" in payload or payload.get("operation") == "part_edit":
                    if not payload.get("source_glb_b64"):
                        raise RuntimeError("part_edit requires source_glb_b64")
                    if not payload.get("parts"):
                        raise RuntimeError("part_edit requires non-empty parts array")
                    src = os.path.join(tmp, "source.glb")
                    with open(src, "wb") as handle:
                        handle.write(base64.b64decode(payload["source_glb_b64"]))
                    out_path = os.path.join(tmp, "out.glb")
                    stats = run_part_editor(src, payload.get("edit_params") or {},
                                            payload["parts"], out_path)
                elif payload.get("glb_b64"):
                    src = os.path.join(tmp, "in.glb")
                    with open(src, "wb") as handle:
                        handle.write(base64.b64decode(payload["glb_b64"]))
                    params_path = os.path.join(tmp, "params.json")
                    with open(params_path, "w") as handle:
                        json.dump({"src": src, "out": os.path.join(tmp, "out.glb"),
                                   "operation": payload.get("operation", "decimate"),
                                   "ratio": payload.get("ratio", 0.5),
                                   "voxel_size": payload.get("voxel_size", 0.05),
                                   "options": payload.get("options") or {}}, handle)
                    with open(WORKBENCH_PROCESSOR) as handle:
                        stats = blender_run(handle.read(), params_path)
                else:
                    plan_path = os.path.join(tmp, "plan.json")
                    with open(plan_path, "w") as handle:
                        json.dump(payload.get("plan") or {}, handle)
                    out = os.path.join(tmp, "out.glb")
                    if payload.get('plan', {}).get('method') == 'pixel':
                        with open(PIXEL_BUILDER) as handle:
                            stats = blender_run(handle.read(), plan_path, out)
                    elif payload.get('plan', {}).get('method') == 'surface':
                        with open(SURFACE_BUILDER) as handle:
                            stats = blender_run(handle.read(), plan_path, out)
                    else:
                        stats = blender_run(BUILD_CODE, plan_path, out)
                out_path = os.path.join(tmp, "out.glb")
                if not os.path.exists(out_path):
                    self._send(500, {"error": "blender_no_output"})
                    return
                with open(out_path, "rb") as handle:
                    data = handle.read()
                # 顺带渲染正视图缩略图：有模型就该有预览，不该让用户手点"保存预览"。
                # 渲染失败不影响模型交付（preview_b64 缺省即无）。
                preview_b64 = None
                if stats.get('method') == 'pixel':
                    preview_b64 = stats['review_images']['front']
                try:
                    png_path = os.path.join(tmp, "preview.png")
                    with open(RENDER_PREVIEW) as handle:
                        render_stats = {} if preview_b64 else blender_run(handle.read(), out_path, png_path, "320")
                    if (render_stats.get("preview") or {}).get("ok") and os.path.exists(png_path):
                        with open(png_path, "rb") as handle:
                            preview_b64 = base64.b64encode(handle.read()).decode()
                        stats["preview"] = render_stats["preview"]
                except Exception as exc:
                    stats["preview"] = {"ok": False, "reason": str(exc)[:200]}
                self._send(200, {"glb_b64": base64.b64encode(data).decode(),
                                 "bytes": len(data), "stats": stats,
                                 **({"preview_b64": preview_b64} if preview_b64 else {})})
        except Exception as exc:
            self._send(500, {"error": str(exc)[:500]})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    print(f"blender worker on {port}")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
