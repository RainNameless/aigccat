#!/bin/bash
# aigccat 引擎冒烟测试（阶段 7）：Godot headless 无头导入 published GLB
# 用法: ./scripts/godot_smoke.sh <dir>/<asset_id>   例: ./scripts/godot_smoke.sh characters/chr_asset_001
# 依赖: 宿主机安装 Godot 4（/opt/homebrew/bin/godot 或 /Applications/Godot.app）
set -euo pipefail

WEB_BASE="${WEB_BASE:-http://localhost:8080}"
ASSET_REF="${1:?usage: godot_smoke.sh <dir>/<asset_id>}"
GODOT_BIN="${GODOT_BIN:-$(command -v godot || echo /Applications/Godot.app/Contents/MacOS/Godot)}"

echo "[smoke] asset=$ASSET_REF godot=$GODOT_BIN"

# Use the local machine credential without exposing it in command arguments.
fetch_local() {
  python3 - "$1" <<'PYCLIENT'
import sys
from pathlib import Path
sys.path.insert(0, str(Path.home()/'.config/aigccat/client'))
from aigccat_auth import urlopen
with urlopen(sys.argv[1], timeout=180) as response:
    while chunk := response.read(1024*1024):
        sys.stdout.buffer.write(chunk)
PYCLIENT
}

# 1. 取 published 版本
PUBLISHED=$(fetch_local "$WEB_BASE/api/assets/$ASSET_REF" | python3 -c "import json,sys; print(json.load(sys.stdin)['latest'].get('published') or '')")
if [ -z "$PUBLISHED" ]; then
  echo "[smoke] FAIL: $ASSET_REF 没有 published 版本" >&2
  exit 1
fi
echo "[smoke] published=$PUBLISHED"

# 2. 搭临时 Godot 工程并下载 GLB
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/project/assets"
cat > "$TMP/project/project.godot" <<'EOF'
; Engine configuration file.
; It's best edited using the editor UI and not directly
config_version=5

[application]
config/name="aigccat-smoke"
EOF
GLB="$TMP/project/assets/model.glb"
fetch_local "$WEB_BASE/api/assets/$ASSET_REF/file/versions/$PUBLISHED/model.glb" > "$GLB"
echo "[smoke] downloaded $(stat -f%z "$GLB") bytes"

# 3. Godot headless 导入（--import 会扫描并导入全部资源，报错即非零退出）
LOG="$TMP/import.log"
"$GODOT_BIN" --headless --path "$TMP/project" --import > "$LOG" 2>&1 || {
  echo "[smoke] FAIL: godot import exit non-zero" >&2
  tail -20 "$LOG" >&2
  exit 1
}
if grep -qiE "error|failed" "$LOG"; then
  echo "[smoke] FAIL: import log contains errors" >&2
  grep -iE "error|failed" "$LOG" | head -10 >&2
  exit 1
fi

# 4. 导入产物必须存在（.godot/imported/*.glb-*）
if ! ls "$TMP/project/.godot/imported/"*model.glb* >/dev/null 2>&1; then
  echo "[smoke] FAIL: no imported artifact for model.glb" >&2
  exit 1
fi
echo "[smoke] PASS: $ASSET_REF@$PUBLISHED godot import clean"
