#!/usr/bin/env python3
"""Regenerate imported NPC previews without overwriting previous images or models."""
import base64
import io
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image, ImageDraw
from thumbrender import render_png

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers

BASE = "http://localhost:8080"
OUT = Path(__file__).resolve().parents[1] / "outputs"

def get(path):
    with _auth_urlopen(BASE + path, timeout=120) as r:
        return r.read()

def main():
    assets = json.loads(get("/api/assets"))["assets"]
    assets = [a for a in assets if a["asset_type"] == "character" and a["asset_id"].startswith("chr_npc_")]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    sheet = Image.new("RGB", (880, ((len(assets) + 3) // 4) * 245), "#eef2f8")
    draw = ImageDraw.Draw(sheet)
    results = []
    for i, a in enumerate(assets):
        aid = a["asset_id"]
        root = f"/api/assets/characters/{aid}"
        # Imported contracts hardcode -Z; actual imported NPC faces were checked at +Z.
        model = get(f"{root}/file/versions/{a['version']}/model.glb")
        png = render_png(model, 220, "+Z")
        if not png:
            raise RuntimeError(f"Rendering failed: {aid}")
        key = f"versions/{a['version']}/preview_front_{stamp}/preview.png"
        body = json.dumps({"bytes_b64": base64.b64encode(png).decode()}).encode()
        req = urllib.request.Request(BASE + root + "/file/" + key, data=body, method="PUT", headers={"Content-Type": "application/json"})
        with _auth_urlopen(req, timeout=120) as r:
            if r.status != 200:
                raise RuntimeError(f"Upload failed: {aid}")
        contract = json.loads(get(root))["asset"]
        assert contract["preview"]["path"] == key, aid
        assert get(root + "/file/" + key) == png, aid
        results.append({"asset_id": aid, "previous_preview": a.get("preview"), "preview": key, "camera_axis": "+Z", "verified": True})
        x, y = (i % 4) * 220, (i // 4) * 245
        sheet.paste(Image.open(io.BytesIO(png)).convert("RGB"), (x, y))
        draw.text((x + 4, y + 222), aid, fill="black")
        print(f"{i+1}/{len(assets)} {aid} verified", flush=True)
        (OUT / "npc-preview-repair.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    sheet.save(OUT / "npc-front-contact-sheet.png")

if __name__ == "__main__":
    main()
