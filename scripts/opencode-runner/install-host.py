"""清退「装在宿主机上的」OpenCode Blender 桥（旧方案）。

背景：早期版本把绑骨桥做成 macOS LaunchAgent 常驻（`cn.aigccat.opencode-blender`，
监听 127.0.0.1:8791），并要求宿主机上另跑一个 Blender 工作器（8788）。
现在单容器（amd64 镜像）自带 Blender 5.2，绑骨桥也是容器内的子进程，
宿主机上不需要任何东西 —— 这个脚本用来把旧的那份清干净。

默认动作就是清退：
    python3 scripts/opencode-runner/install-host.py

可选：
    --legacy-install   仍然按老方式装成常驻服务（仅在你确实要脱离容器运行时使用）

注意：本脚本只管上面这一个服务；宿主机上的 Blender 工作器（8788）由
`scripts/blender/install-host.py` 或手工 launchd 配置管理，清退方式同理。
"""
from pathlib import Path
import os, plistlib, shutil, subprocess, sys

LABEL = 'cn.aigccat.opencode-blender'
DOMAIN = f'gui/{os.getuid()}'
repo = Path(__file__).resolve().parents[2]
plist_path = Path.home() / 'Library/LaunchAgents' / f'{LABEL}.plist'
runtime = Path.home() / 'Library/Application Support/aigccat/opencode'


def uninstall():
    removed = []
    if subprocess.run(['launchctl', 'print', f'{DOMAIN}/{LABEL}'],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        subprocess.run(['launchctl', 'bootout', f'{DOMAIN}/{LABEL}'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        removed.append('已卸载 launchd 服务')
    if plist_path.exists():
        plist_path.unlink()
        removed.append(f'已删除 {plist_path}')
    if runtime.exists():
        # tasks/ 里可能有历史任务记录，先提醒再删，避免悄悄丢东西
        tasks = runtime / 'tasks'
        n = len([p for p in tasks.iterdir()]) if tasks.is_dir() else 0
        if n:
            print(f'  ⚠ {tasks} 里还有 {n} 条任务记录，删除前请确认（本次一并删除）')
        shutil.rmtree(runtime, ignore_errors=True)
        removed.append(f'已删除运行副本 {runtime}')
    print('  宿主机上的绑骨桥已清退' if removed else '  宿主机上没有装过绑骨桥，无需清理')
    for line in removed:
        print(f'    · {line}')
    print('')
    print('  现在绑骨桥是容器内的子进程：打开工作台 → 模型构建，')
    print('  减面/重拓扑/绑骨都由容器自带的 Blender 完成，宿主机上不需要跑任何东西。')


def legacy_install():
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / 'tasks').mkdir(exist_ok=True)
    for name in ('host.py', 'inspect.py'):
        shutil.copy2(repo / 'scripts/opencode-runner' / name, runtime / name)
    entries = dict(line.split('=', 1) for line in (repo / '.env').read_text().splitlines()
                   if line and not line.startswith('#') and '=' in line)
    token = entries['RIG_AGENT_TOKEN']
    config = {'Label': LABEL, 'ProgramArguments': [sys.executable, str(runtime / 'host.py')],
              'WorkingDirectory': str(runtime), 'RunAtLoad': True, 'KeepAlive': True,
              'EnvironmentVariables': {'RIG_AGENT_TOKEN': token, 'RIG_TASK_ROOT': str(runtime / 'tasks')},
              'StandardOutPath': '/tmp/aigccat-opencode-blender.log',
              'StandardErrorPath': '/tmp/aigccat-opencode-blender.err.log'}
    plist_path.write_bytes(plistlib.dumps(config))
    plist_path.chmod(0o600)
    # 必须先 bootout 再 bootstrap：kickstart 不会重读 plist
    subprocess.run(['launchctl', 'bootout', f'{DOMAIN}/{LABEL}'],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['launchctl', 'bootstrap', DOMAIN, str(plist_path)], check=True)
    print('Installed persistent OpenCode Blender bridge on 8791')


if __name__ == '__main__':
    if '--legacy-install' in sys.argv:
        legacy_install()
    elif '--help' in sys.argv or '-h' in sys.argv:
        print(__doc__)
    else:
        uninstall()
