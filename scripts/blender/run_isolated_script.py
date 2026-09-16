"""macOS 专用、失败即关闭的 Blender 模型脚本运行器。

python3 run_isolated_script.py --script character_engine.py --input params.json
结果仅保存在打印的独立任务目录；不接受自定义沙箱规则或无隔离模式。
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

BLENDER = Path('/Applications/Blender.app/Contents/MacOS/Blender')
SANDBOX = '/usr/bin/sandbox-exec'


def profile(task):
    quote = lambda p: json.dumps(str(p))
    return '\n'.join([
        '(version 1)', '(deny default)',
        '(allow process-exec (literal ' + quote(BLENDER) + '))',
        '(allow sysctl-read)',
        # 不开放 Mach 代理或 GPU user-client；它们不是只读文件权限。
        '(allow file-read-metadata (literal "/private") (literal "/private/tmp"))',
        '(allow file-read* (subpath "/System") (subpath "/usr/lib") '
        '(subpath "/usr/share") (literal "/") '
        '(subpath "/Applications/Blender.app") '
        '(literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
        '(allow file-read* file-write* (subpath ' + quote(task) + '))',
        '(allow file-write* (literal "/dev/null"))',
        '(deny network*)',
    ])


def run(task, script, args, timeout):
    env = {
        'PATH': '/usr/bin:/bin', 'HOME': str(task), 'TMPDIR': str(task) + '/',
        'TMP': str(task), 'TEMP': str(task),
        'USER': 'isolated', 'LOGNAME': 'isolated', 'LANG': 'en_US.UTF-8',
        'BLENDER_USER_CONFIG': str(task / 'config'),
        'BLENDER_USER_SCRIPTS': str(task / 'user_scripts'),
        'BLENDER_USER_DATAFILES': str(task / 'datafiles'),
        'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
    }
    command = [SANDBOX, '-p', profile(task), str(BLENDER), '--background',
               '--factory-startup', '--disable-autoexec', '--offline-mode',
               '--console-crash-handler', '--threads', '2',
               '--python-exit-code', '73', '--python', str(script), '--', *args]
    log = task / (script.stem + '.log')
    try:
        result = subprocess.run(command, cwd=task, env=env, timeout=timeout,
                                stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout or b''
        log.write_text(output.decode('utf-8', errors='replace')
                       if isinstance(output, bytes) else output)
        raise RuntimeError(f'沙箱任务超时；日志：{log}；禁止无隔离重试') from exc
    log.write_text(result.stdout)
    if result.returncode:
        if result.returncode == -11 and any(symbol in result.stdout for symbol in (
                'supports_barycentric_whitelist', 'metal_is_supported')):
            raise RuntimeError(
                f'Metal 初始化 SIGSEGV；日志：{log}。本机 Blender 5.2 的 CPU 渲染参数'
                '不能跳过 Metal 启动检测，只读 IOKit 属性授权无效；'
                '不开放 GPU user-client，不关闭沙箱，禁止继续执行模型')
        raise RuntimeError(f'沙箱任务失败（{result.returncode}）；日志：{log}：{result.stdout[-8000:]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe-only', action='store_true', help='仅执行内置无害探针，不读取模型或输入')
    parser.add_argument('--script', type=Path)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    if sys.platform != 'darwin' or not Path(SANDBOX).is_file() or not BLENDER.is_file():
        raise RuntimeError('阻塞：缺少 macOS sandbox-exec 或指定 Blender；禁止无隔离执行')
    if not 10 <= args.timeout <= 600:
        raise ValueError('timeout 必须为 10–600 秒')
    if args.probe_only:
        if args.script is not None or args.input is not None:
            parser.error('--probe-only 不接受 --script 或 --input')
    else:
        if args.script is None or args.input is None:
            parser.error('模型运行需要 --script 和 --input')
        script, source = args.script.resolve(strict=True), args.input.resolve(strict=True)
        if script.suffix != '.py' or source.suffix != '.json':
            raise ValueError('仅接收 .py 模型脚本和 .json 输入')
        if script.stat().st_size > 1_000_000 or source.stat().st_size > 65536:
            raise ValueError('输入文件过大')
    task = Path(tempfile.mkdtemp(prefix='aigccat-blender-', dir='/private/tmp')).resolve()
    task.chmod(0o700)
    print(f'任务目录：{task}', flush=True)
    probe = task / 'sandbox_probe.py'
    probe.write_text('''import bpy, json, pathlib, socket
root = pathlib.Path.cwd()
assert bpy.app.version[:2] == (5, 2), '需要 Blender 5.2 宿主'
(root / 'probe_write.txt').write_text('无害沙箱测试')
assert (root / 'probe_write.txt').read_text() == '无害沙箱测试'
def blocked(name, action):
    try:
        action()
    except PermissionError:
        return
    raise RuntimeError('隔离失败：' + name)
blocked('系统非运行库读取', lambda: open('/etc/passwd', 'rb'))
blocked('个人目录读取', lambda: open(PERSONAL_SOURCE, 'rb'))
blocked('个人目录写入', lambda: open(str(pathlib.Path(PERSONAL_SOURCE).parent / (root.name + '-forbidden')), 'x'))
blocked('任务外写入', lambda: open(str(root.parent / (root.name + '-forbidden')), 'w'))
def network():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
blocked('网络', network)
(root / 'sandbox_verified.json').write_text(json.dumps({'sandbox': True, 'version': bpy.app.version_string}))
'''.replace('PERSONAL_SOURCE', repr(str(Path(__file__).resolve()))))
    run(task, probe, [], args.timeout)
    if not (task / 'sandbox_verified.json').is_file():
        raise RuntimeError('阻塞：沙箱探针未通过；禁止执行模型')
    if args.probe_only:
        print((task / 'sandbox_verified.json').read_text())
        return
    shutil.copyfile(script, task / 'model.py')
    shutil.copyfile(source, task / 'input.json')
    run(task, task / 'model.py', ['--input', str(task / 'input.json'),
                                 '--output', str(task / 'character.glb')], args.timeout)
    for name in ('character.glb', 'character.blend', 'character.stats.json'):
        path = task / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError('缺少有效输出：' + name)
    print(json.dumps({'task_dir': str(task), 'sandbox': True,
                      'glb': str(task / 'character.glb'),
                      'blend': str(task / 'character.blend'),
                      'stats': str(task / 'character.stats.json')}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'阻塞/失败：{exc}', file=sys.stderr)
        sys.exit(1)
