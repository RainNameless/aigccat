"""向本地 BlenderMCP 服务（9876）发送命令并执行。

用法：python3 scripts/blender/mcp_call.py <code文件>
协议：纯 UTF-8 JSON，无长度前缀；命令 {"type":"execute_code","params":{"code":"..."}}
"""
import json
import socket
import sys
import time


def call(code, host="localhost", port=9876, timeout=180.0):
    """发送命令后持续读取直到拿到完整 JSON；服务端响应是异步的，不能收一次就断开。"""
    payload = json.dumps({"type": "execute_code", "params": {"code": code}})
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(payload.encode("utf-8"))
        buffer = b""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                data = sock.recv(65536)
            except socket.timeout:
                return {"status": "error", "message": "timeout_waiting_response"}
            if not data:
                break
            buffer += data
            try:
                return json.loads(buffer.decode("utf-8"))
            except json.JSONDecodeError:
                continue  # 响应可能分片，继续等
    return {"status": "error", "message": "no_complete_response"}


if __name__ == "__main__":
    source = sys.argv[1]
    with open(source) as handle:
        result = call(handle.read())
    print(json.dumps(result, ensure_ascii=False)[:2000])
