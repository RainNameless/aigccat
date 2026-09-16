"""无头启动 BlenderMCP 插件的 socket 服务（9876），供自动化建模调用。

用法：blender -b --python scripts/blender/boot_server.py
启动后保持进程运行；用 TCP 发送 {"type":"execute_code","params":{"code":"..."}}。
"""
import bpy
import os
import sys
import time
import traceback

LOG = "/tmp/blender_mcp_gui.log"
ADDON_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "blender_mcp_addon.py")


def log(*parts):
    line = " ".join(str(p) for p in parts)
    print(line)
    with open(LOG, "a") as handle:
        handle.write(line + "\n")


log("BOOT background=", bpy.app.background)
try:
    bpy.ops.preferences.addon_install(filepath=ADDON_PATH, overwrite=True)
    log("INSTALL_OK")
except Exception as exc:  # 已安装时会失败，忽略
    log("INSTALL_SKIP", exc)

try:
    bpy.ops.preferences.addon_enable(module="blender_mcp_addon")
    log("ENABLE_OK")
except Exception as exc:
    log("ENABLE_FAIL", exc, traceback.format_exc())
    sys.exit(1)

try:
    # 重新启用插件后场景里可能残留 server_running 标记，导致 start() 认为已在运行而跳过监听。
    try:
        bpy.ops.blendermcp.stop_server()
        log("STOPPED_STALE")
    except Exception as exc:
        log("STOP_SKIP", exc)
    result = bpy.ops.blendermcp.start_server()
    log("START_RESULT", result)
except Exception as exc:
    log("START_FAIL", exc, traceback.format_exc())
    sys.exit(1)

print("BOOTED background=", bpy.app.background)
sys.stdout.flush()
# 插件依赖 GUI 主循环定时器执行命令；无头模式（blender -b）它自己会拒绝启动。
# GUI 模式下脚本执行完即可返回，服务线程与定时器继续工作，不能用死循环阻塞界面。
if bpy.app.background:
    print("HEADLESS_UNSUPPORTED: 请用 GUI 或虚拟显示启动")
