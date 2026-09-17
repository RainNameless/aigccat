# coding: utf-8
"""清退「装在宿主机上的」网页订阅执行器（旧方案），把登录窗口交还给容器。

背景：早期版本把会话执行器做成 macOS LaunchAgent 常驻（`cn.aigccat.studio-worker`，
监听 127.0.0.1:8790），于是宿主机上必须留一个进程，还得开一个真窗口给你点。
现在登录窗口整套都在容器里（Xvfb + 浏览器 + noVNC，网页里内嵌显示），
宿主机上不再需要任何东西 —— 这个脚本用来把旧的那份清干净。

默认动作就是清退：
    python3 scripts/studio-runner/install.py

可选：
    --keep-session   保留 .ai/browser-state/ 里的登录会话文件（默认也保留，只是提示你）
    --legacy-install 仍然按老方式装成常驻服务（仅在你确实要脱离容器运行时使用）

清退之后，登录会话要么在界面里重连一次，要么把旧会话文件拷进容器数据卷：
    docker cp .ai/browser-state/studio-session.auth.json <容器名>:/data/studio/
"""
import os, plistlib, shutil, subprocess, sys
from pathlib import Path

LABEL = 'cn.aigccat.studio-worker'
DOMAIN = f'gui/{os.getuid()}'
root = Path(__file__).resolve().parents[2]
plist_path = Path.home() / 'Library/LaunchAgents' / f'{LABEL}.plist'
runtime = Path.home() / 'Library/Application Support/aigccat/studio-worker'
private = root / '.ai/browser-state'


def uninstall():
    removed = []
    if subprocess.run(['launchctl', 'print', f'{DOMAIN}/{LABEL}'], capture_output=True).returncode == 0:
        subprocess.run(['launchctl', 'bootout', f'{DOMAIN}/{LABEL}'], capture_output=True)
        removed.append('已卸载 launchd 服务')
    if plist_path.exists():
        plist_path.unlink()
        removed.append(f'已删除 {plist_path}')
    if runtime.exists():
        shutil.rmtree(runtime, ignore_errors=True)
        removed.append(f'已删除运行副本 {runtime}')
    print('  宿主机上的 Studio 执行器已清退' if removed else '  宿主机上没有装过 Studio 执行器，无需清理')
    for line in removed:
        print(f'    · {line}')
    if private.exists():
        print(f'  登录会话文件仍保留在 {private}（没有它也能用，重连一次即可）')
    print('')
    print('  现在登录窗口完全在容器里：打开工作台 → 服务状态 → 连接网页订阅 → 打开登录窗口，')
    print('  画面会直接出现在对话框里，不需要宿主机上跑任何东西。')
    print('  宿主机上的检查：launchctl print ' + f'{DOMAIN}/{LABEL}' + ' → 应当报找不到；lsof -iTCP:8790 应当为空。')


def legacy_install():
    """按老方式装成常驻服务。只在脱离容器单独跑这个功能时才需要。"""
    import plistlib as _pl, secrets, re, time, json, urllib.request
    source = root / 'scripts/studio-runner'
    if not (source / 'node_modules').is_dir():
        raise SystemExit('缺少依赖。先执行：\n  cd scripts/studio-runner && npm install')
    node = os.environ.get('NODE_BIN')
    if not node:
        pinned = Path('/opt/homebrew/opt/node@22/bin/node')
        node = str(pinned) if pinned.exists() else shutil.which('node')
    if not node:
        raise SystemExit('找不到 node。请安装 Node.js 22+，或用 NODE_BIN=/path/to/node 指定。')

    private.mkdir(parents=True, exist_ok=True)
    token_file = private / 'studio-runner-token'
    if not token_file.exists():
        token_file.write_text(secrets.token_hex(32) + '\n', encoding='utf-8')
        token_file.chmod(0o600)
    token = token_file.read_text(encoding='utf-8').strip()

    runtime.mkdir(parents=True, exist_ok=True)
    runtime.chmod(0o700)
    for name in ('export-generated.cjs', 'client.cjs', 'proxy.cjs', 'state.cjs', 'session.cjs',
                 'process.cjs', 'server.cjs', 'normalize.cjs', 'preview.cjs',
                 'package.json', 'package-lock.json'):
        shutil.copy2(source / name, runtime / name)
    shutil.copytree(source / 'node_modules', runtime / 'node_modules', dirs_exist_ok=True)
    dst = runtime / '.ai/browser-state'
    dst.mkdir(parents=True, exist_ok=True)
    dst.chmod(0o700)
    for name in ('studio-session.auth.json', 'studio-runner-token'):
        src = private / name
        if src.exists():
            shutil.copy2(src, dst / name)
            (dst / name).chmod(0o600)

    env = {'STUDIO_ROOT': str(runtime)}
    if os.environ.get('STUDIO_PROXY') is not None:
        env['STUDIO_PROXY'] = os.environ['STUDIO_PROXY']
    plist = {'Label': LABEL, 'ProgramArguments': [node, str(runtime / 'server.cjs')],
             'WorkingDirectory': str(runtime), 'EnvironmentVariables': env,
             'RunAtLoad': True, 'KeepAlive': True,
             'StandardOutPath': str(private / 'worker.log'),
             'StandardErrorPath': str(private / 'error.log')}
    plist_path.write_bytes(_pl.dumps(plist))
    # 必须 bootout + bootstrap：kickstart 用的是 launchd 内存里的旧配置，不重读 plist
    if subprocess.run(['launchctl', 'print', f'{DOMAIN}/{LABEL}'], capture_output=True).returncode == 0:
        subprocess.run(['launchctl', 'bootout', f'{DOMAIN}/{LABEL}'], capture_output=True)
        time.sleep(1)
    if subprocess.run(['launchctl', 'bootstrap', DOMAIN, str(plist_path)], capture_output=True).returncode != 0:
        raise SystemExit(f'注册服务失败。手动试试：\n  launchctl bootout {DOMAIN}/{LABEL}\n  launchctl bootstrap {DOMAIN} {plist_path}')
    # 自检：launchd 真的按新配置加载了环境变量吗
    out = subprocess.run(['launchctl', 'print', f'{DOMAIN}/{LABEL}'], capture_output=True, text=True).stdout
    mismatch = [k for k in env if f'{k} =>' not in out]
    if mismatch:
        raise SystemExit('launchd 没有按新配置加载这些环境变量：' + ', '.join(mismatch))
    for _ in range(20):
        try:
            req = urllib.request.Request('http://127.0.0.1:8790/session',
                                         headers={'Authorization': 'Bearer ' + token})
            with urllib.request.urlopen(req, timeout=5) as response:
                json.load(response)
            break
        except Exception:
            time.sleep(1)
    else:
        raise SystemExit(f'执行器没有就绪，看日志：{private/"error.log"}')
    print('  已按老方式装成常驻服务：http://127.0.0.1:8790')
    print(f'  令牌：{token_file}')


if __name__ == '__main__':
    if '--legacy-install' in sys.argv:
        legacy_install()
    elif '--help' in sys.argv or '-h' in sys.argv:
        print(__doc__)
    else:
        uninstall()
