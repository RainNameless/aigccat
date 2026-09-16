#!/usr/bin/env python3
"""把 i-cat（Unity 工程）的模型批量导入 aigccat。

流程：扫描 Unity 工程 Assets/ → 按路径关键词自动分类 → assimp 转 GLB → POST /api/assets/import
不调用任何 LLM，零 token 成本。

用法:
  ./scripts/import_icat.py --project ~/Documents/i-cat-rebuild --limit 60
  ./scripts/import_icat.py --project ~/Documents/i-cat-rebuild --all
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import uuid

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers

WEB = os.environ.get("WEB_BASE", "http://localhost:8080")
ASSIMP = os.environ.get("ASSIMP_BIN", "assimp")

# 路径/文件名关键词 → 资产类型（KICKOFF 5.2 的 11 类受控枚举）
RULES = [
    (("character", "char_", "npc", "people", "human", "girl", "boy"), "character"),
    (("animal", "cat", "dog", "bird", "fish", "horse", "cow", "chicken"), "animal"),
    (("ground", "terrain", "floor", "landscape", "hill", "mountain", "beach", "path"), "ground"),
    (("tree", "bush", "grass", "flower", "plant", "creeper", "crop", "vegetation", "forest"), "vegetation"),
    (("house", "building", "roof", "wall", "bridge", "fence", "stall", "shop", "tower"), "building"),
    (("water", "river", "lake", "sky", "cloud", "ocean"), "environment"),
    (("car", "boat", "vehicle", "cart", "bike"), "vehicle"),
    (("material", "texture_"), "material"),
    (("effect", "particle", "vfx"), "effect"),
]

SKIP_DIRS = {"Library", "Temp", "Logs", "obj", "Build", "Builds", ".git"}


def classify(rel: str) -> str:
    low = rel.lower()
    for keys, t in RULES:
        if any(k in low for k in keys):
            return t
    return "prop"


def find_models(root: str):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for f in filenames:
            if f.lower().endswith((".fbx", ".obj", ".dae", ".glb", ".gltf")):
                out.append(os.path.join(dirpath, f))
    return out


def to_glb(src: str) -> bytes | None:
    """用 assimp 转成 GLB；原生 glb 直接返回"""
    if src.lower().endswith(".glb"):
        return open(src, "rb").read()
    with tempfile.TemporaryDirectory() as td:
        dst = os.path.join(td, "out.glb")
        r = subprocess.run([ASSIMP, "export", src, dst, "-fbin"],
                           capture_output=True, timeout=180)
        if r.returncode != 0 or not os.path.exists(dst):
            return None
        return open(dst, "rb").read()


sys.path.insert(0, os.path.dirname(__file__))
from thumbrender import render_png as render_thumb


def upload(name: str, asset_type: str, description: str, source_path: str, glb: bytes):
    boundary = "----aigccat" + uuid.uuid4().hex
    def field(n, v):
        return (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{n}\"\r\n\r\n{v}\r\n").encode()
    body = b"".join([
        field("name", name), field("asset_type", asset_type),
        field("description", description), field("source_path", source_path),
        (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
         f"filename=\"model.glb\"\r\nContent-Type: model/gltf-binary\r\n\r\n").encode()
        + glb + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    req = urllib.request.Request(
        f"{WEB}/api/assets/import", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with _auth_urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=os.path.expanduser("~/Documents/i-cat-rebuild"))
    ap.add_argument("--dir", default="Assets", help="工程内相对目录，默认 Assets")
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--offset", type=int, default=0)
    args = ap.parse_args()

    scan_root = os.path.join(args.project, args.dir)
    models = find_models(scan_root)
    print(f"[import] 扫描到 {len(models)} 个模型文件（{scan_root}）")
    if not args.all:
        models = models[args.offset:args.offset + args.limit]
        print(f"[import] 本次导入 {len(models)} 个（--all 可全量）")

    ok, fail, skipped = 0, 0, []
    for i, m in enumerate(models, 1):
        rel = os.path.relpath(m, args.project)
        name = os.path.splitext(os.path.basename(m))[0]
        atype = classify(rel)
        try:
            glb = to_glb(m)
            if not glb:
                skipped.append((rel, "convert failed"))
                continue
            r = upload(name, atype, f"imported from i-cat: {rel}", rel, glb)
            # 立即渲染真实缩略图推送为 preview
            try:
                thumb = render_thumb(glb)
                if thumb:
                    d = {"character":"characters","animal":"animals","prop":"props","building":"buildings",
                         "environment":"environments","vegetation":"vegetation","ground":"grounds",
                         "sky":"skies","vehicle":"vehicles","material":"materials","effect":"effects",
                         "apparel":"apparel"}[atype]
                    _auth_urlopen(urllib.request.Request(
                        f"{WEB}/api/assets/{d}/{r['asset_id']}/file/versions/v001/preview.png",
                        data=json.dumps({"bytes_b64": __import__("base64").b64encode(thumb).decode()}).encode(),
                        headers={"Content-Type": "application/json"}, method="PUT"), timeout=60)
            except Exception:
                pass
            ok += 1
            print(f"  [{i}/{len(models)}] ✔ {r['asset_id']} ({atype}) tri={r.get('triangles')} ← {rel}")
        except Exception as e:  # noqa: BLE001
            fail += 1
            skipped.append((rel, str(e)[:80]))
    print(f"\n[import] 完成：成功 {ok} / 失败 {fail} / 跳过 {len(skipped)}")
    for rel, why in skipped[:20]:
        print(f"   skip {rel}: {why}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
