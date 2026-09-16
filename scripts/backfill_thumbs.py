#!/usr/bin/env python3
"""给所有资产生成真实模型缩略图（trimesh + matplotlib CPU 渲染）并推回资产库。

流程：遍历资产 → 下载 latest GLB → CPU 渲染 PNG（光照 + 深色底）→
      PUT versions/<v>/preview.png（服务端自动写回 contract.preview）
零 LLM 成本。

用法:
  ./scripts/backfill_thumbs.py            # 全量
  ./scripts/backfill_thumbs.py --limit 20
"""
import base64
import io
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers

WEB = os.environ.get("WEB_BASE", "http://localhost:8080")
DIR_OF = {"character": "characters", "animal": "animals", "prop": "props", "building": "buildings",
          "environment": "environments", "vegetation": "vegetation", "ground": "grounds",
          "sky": "skies", "vehicle": "vehicles", "material": "materials", "effect": "effects",
          "apparel": "apparel"}

sys.path.insert(0, os.path.dirname(__file__))
from thumbrender import render_png


def http_json(path, body=None, method="GET"):
    req = urllib.request.Request(
        f"{WEB}{path}",
        data=json.dumps(body).encode() if body else None, method=method,
        headers={"Content-Type": "application/json"})
    with _auth_urlopen(req, timeout=300) as resp:
        return json.loads(resp.read())


def process(a):
    d = DIR_OF.get(a["asset_type"])
    if not d:
        return ("skip", a["asset_id"], "unknown type")
    ver = a.get("version")
    if not ver:
        return ("skip", a["asset_id"], "no version")
    try:
        with _auth_urlopen(
                f"{WEB}/api/assets/{d}/{a['asset_id']}/file/versions/{ver}/model.glb",
                timeout=120) as r:
            glb = r.read()
        png = render_png(glb)
        if not png:
            return ("fail", a["asset_id"], "render failed")
        http_json(f"/api/assets/{d}/{a['asset_id']}/file/versions/{ver}/preview.png",
                  {"bytes_b64": base64.b64encode(png).decode()}, method="PUT")
        return ("ok", a["asset_id"], f"{len(png)//1024}KB")
    except Exception as e:  # noqa: BLE001
        return ("fail", a["asset_id"], str(e)[:80])


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    r = http_json("/api/assets")
    assets = r["assets"]
    if limit:
        assets = assets[:limit]
    print(f"[thumbs] 处理 {len(assets)} 个资产（4 并发渲染）")
    ok = fail = skip = 0
    with ThreadPoolExecutor(max_workers=4) as ex:
        for status, aid, info in ex.map(process, assets):
            if status == "ok":
                ok += 1
                print(f"  ✔ {aid} {info}")
            elif status == "fail":
                fail += 1
                print(f"  ✘ {aid}: {info}")
            else:
                skip += 1
    print(f"\n[thumbs] 完成：成功 {ok} / 失败 {fail} / 跳过 {skip}")


if __name__ == "__main__":
    main()
