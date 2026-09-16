"""仅在 Docker 中执行 generated.py，导出独立任务目录中的 output.glb。

脚本通过 --output /task/output.glb 接收输出路径，也可使用 OUTPUT_GLB 环境变量。
--output 只接受 outputs/docker-sandbox/<新任务名>/output.glb；绝不覆盖已有目录。
--probe-only 是环境验证，不属于用户生成成果。不读取密钥、不调用 AI。
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import uuid

PROJECT = Path(__file__).resolve().parents[2]
ROOT = PROJECT / 'outputs' / 'docker-sandbox'
IMAGE = 'aigccat-blender-sandbox:bookworm'

PROBE = '''import bpy, os, pathlib, sys
assert os.getuid() != 0
assert pathlib.Path('/proc/self/status').read_text().split('NoNewPrivs:')[1].split()[0] == '1'
assert int(pathlib.Path('/proc/self/status').read_text().split('CapEff:')[1].split()[0], 16) == 0
# Docker VM 可带有未启用的隧道接口，检查实际路由而非接口名称。
assert not pathlib.Path('/proc/net/route').read_text().splitlines()[1:]
try:
    pathlib.Path('/etc/aigccat-write-probe').write_text('probe')
except OSError:
    pass
else:
    raise RuntimeError('根文件系统可写')
assert not pathlib.Path('/Users').exists()
pathlib.Path('/tmp/probe').write_text('probe')
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add()
output = sys.argv[sys.argv.index('--output') + 1]
bpy.ops.export_scene.gltf(filepath=output, export_format='GLB')
'''


def docker(*args, timeout=30):
    try:
        return subprocess.run(['docker', *args], check=True, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              stdin=subprocess.DEVNULL, timeout=timeout).stdout
    except subprocess.CalledProcessError as exc:
        print(exc.stderr[-8000:], file=sys.stderr)
        raise


def output_parent(output):
    # 先校验路径，再创建目录或启动容器。禁止路径穿越、符号链接和覆盖。
    if any(path.is_symlink() for path in (ROOT, *ROOT.parents)):
        raise ValueError('输出根目录及其父目录不能是符号链接')
    if output is None:
        return None
    if '..' in output.parts:
        raise ValueError('输出路径不允许包含 ..')
    output = Path(os.path.abspath(output))
    if (output.name != 'output.glb' or output.parent.parent != ROOT
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', output.parent.name)):
        raise ValueError(f'输出必须为 {ROOT}/<新任务名>/output.glb')
    if output.parent.exists() or output.parent.is_symlink():
        raise ValueError('任务目录已存在，禁止覆盖或复用')
    return output.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--script', type=Path, help='需要执行的 generated.py')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--probe-only', action='store_true')
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    parent = output_parent(args.output)
    if not 10 <= args.timeout <= 600:
        raise ValueError('timeout 必须在 10–600 秒之间')
    if args.probe_only:
        if args.script is not None:
            parser.error('--probe-only 不接受 --script')
        source = PROBE.encode()
    else:
        if args.script is None or args.script.name not in ('generated.py', 'corrected.py'):
            parser.error('必须提供 --script .../generated.py 或 .../corrected.py')
        if args.script.is_symlink() or not args.script.is_file():
            raise ValueError('脚本必须是非符号链接的普通文件')
        if args.script.stat().st_size > 1_000_000:
            raise ValueError('脚本不能超过 1 MB')
        source = args.script.read_bytes()
    if shutil.which('docker') is None:
        raise RuntimeError('Docker 不可用，禁止宿主执行')
    image = json.loads(docker('image', 'inspect', IMAGE))[0]
    image_id = image['Id']
    uid = os.getuid() or 1000
    gid = os.getgid() or 1000
    restrictions = [
        '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '128',
        '--memory', '3g', '--memory-swap', '3g', '--cpus', '2',
        '--user', f'{uid}:{gid}', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
        '--env', 'HOME=/tmp', '--env', 'OUTPUT_GLB=/task/output.glb',
    ]
    # 在执行不可信代码之前，独立容器读取构建时的实际 Blender 版本。
    version = docker('run', '--rm', *restrictions, '--entrypoint', '/bin/cat',
                     image_id, '/opt/blender-version.txt').splitlines()[0]
    ROOT.mkdir(mode=0o700, exist_ok=True)
    if parent is None:
        parent = Path(tempfile.mkdtemp(prefix='probe-' if args.probe_only else 'task-', dir=ROOT))
    else:
        parent.mkdir(mode=0o700)
    (parent / 'generated.py').write_bytes(source)
    name = 'aigccat-blender-' + uuid.uuid4().hex
    created = False
    report = {'task_dir': str(parent), 'output': str(parent / 'output.glb'),
              'blender_version': version, 'image_id': image_id,
              'architecture': image['Architecture'], 'probe_only': args.probe_only,
              'user_artifact': False, 'sandbox': 'docker', 'success': False}
    try:
        docker('run', '-d', '--name', name, *restrictions,
               '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1',
               '--log-opt', 'compress=false',
               '--mount', f'type=bind,src={parent},dst=/task', image_id,
               '--background', '--factory-startup', '--disable-autoexec', '--threads', '2',
               '--python-exit-code', '73', '--python', '/task/generated.py',
               '--', '--output', '/task/output.glb')
        created = True
        try:
            code = int(docker('wait', name, timeout=args.timeout).strip())
        except subprocess.TimeoutExpired:
            docker('kill', name)
            raise RuntimeError('任务超时，已终止容器；禁止宿主重试')
        info = json.loads(docker('inspect', name))[0]
        report['isolation'] = {key: info['HostConfig'][key] for key in (
            'NetworkMode', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'PidsLimit',
            'Memory', 'MemorySwap', 'NanoCpus', 'Tmpfs')}
        report['container_user'] = info['Config']['User']
        report['mounts'] = info['Mounts']
        report['exit_code'] = code
        report['oom_killed'] = info['State']['OOMKilled']
        report['log_tail'] = docker('logs', '--tail', '200', name)[-32000:]
        if code != 0:
            raise RuntimeError(f'Blender 失败，退出码 {code}')
        output = parent / 'output.glb'
        mode = output.lstat().st_mode
        if not stat.S_ISREG(mode) or output.is_symlink():
            raise ValueError('输出不是普通 GLB 文件')
        size = output.stat().st_size
        if not 20 <= size <= 100_000_000:
            raise ValueError('GLB 大小不在允许范围 20 B–100 MB')
        with output.open('rb') as stream:
            magic, glb_version, length = struct.unpack('<4sII', stream.read(12))
        if magic != b'glTF' or glb_version != 2 or length != size:
            raise ValueError('无效的 GLB 2.0 文件头或长度')
        report.update(success=True, output_bytes=size, user_artifact=not args.probe_only)
    finally:
        try:
            # run 客户端超时也可能已创建容器，按本次唯一名称清理。
            docker('rm', '-f', name)
        except subprocess.CalledProcessError:
            if created:
                raise
        finally:
            # 报告仅写 stdout，避免不可信任务预先放置同名符号链接。
            print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'阻塞/失败：{exc}', file=sys.stderr)
        sys.exit(1)
