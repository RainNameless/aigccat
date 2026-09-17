# coding: utf-8
"""把网页订阅执行器装成常驻的 macOS 用户服务（不启动供应商浏览器）。

首次安装前必须先连接会话（一次即可）：
    node scripts/studio-runner/connect-session.cjs

再执行：
    python3 scripts/studio-runner/install.py

可选：
    NODE_BIN=/path/to/node  指定运行时（默认优先用 node@22，其次 PATH 里的 node）
    --force                 执行器正在跑任务时也强制重启（会打断任务，积分不退）
"""
import json,os,plistlib,re,secrets,shutil,subprocess,sys,time,urllib.request
from pathlib import Path

FILES=('export-generated.cjs','client.cjs','proxy.cjs','session.cjs','process.cjs','server.cjs','normalize.cjs','preview.cjs','package.json','package-lock.json')
root=Path(__file__).resolve().parents[2]
source=root/'scripts/studio-runner'
runtime=Path.home()/'Library/Application Support/aigccat/studio-worker'

# ── 1. 前置检查：缺什么就说清楚缺什么，不要等 launchd 起来才失败 ──
node=shutil.which('node')
if not node:
    raise SystemExit('找不到 node。请先安装 Node.js 22 或更高版本（https://nodejs.org），再重试。')
if not (source/'node_modules').is_dir():
    raise SystemExit('缺少依赖。先执行：\n  cd scripts/studio-runner && npm install')

private_src=root/'.ai/browser-state'
private_src.mkdir(parents=True,exist_ok=True)
# 会话可以晚于安装：装好之后在界面里点「连接网页订阅」，或跑 connect-session.cjs 都行。
# 这里只提醒，不阻断 —— 否则「先装执行器才能用界面连会话」会变成死锁。
session_src=private_src/'studio-session.auth.json'
has_session=session_src.exists()
if not has_session:
    print('  还没有登录会话：装好后请二选一')
    print('    · 界面：工作台 → 服务状态（或模型面板）→ 连接网页订阅 → 打开登录窗口')
    print('    · 命令行：node scripts/studio-runner/connect-session.cjs')

# 执行器令牌：缺失就生成。后端用 STUDIO_WORKER_TOKEN 调它，两边必须一致。
token_src=private_src/'studio-runner-token'
generated_token=None
if not token_src.exists():
    generated_token=secrets.token_hex(32)
    token_src.write_text(generated_token+'\n',encoding='utf-8')
    token_src.chmod(0o600)
token_value=token_src.read_text(encoding='utf-8').strip()

env_note=[]
env_file=root/'.env'
if env_file.exists():
    text=env_file.read_text(encoding='utf-8')
    if re.search(r'^STUDIO_WORKER_TOKEN=[ \t]*$',text,re.M):
        env_file.write_text(re.sub(r'^STUDIO_WORKER_TOKEN=[ \t]*$','STUDIO_WORKER_TOKEN='+token_value,text,count=1,flags=re.M),encoding='utf-8')
        env_note.append('已把令牌写入 .env 的 STUDIO_WORKER_TOKEN')
    elif re.search(r'^STUDIO_WORKER_TOKEN=',text,re.M):
        current=re.search(r'^STUDIO_WORKER_TOKEN=(.*)$',text,re.M).group(1).strip()
        if current!=token_value: env_note.append('注意：.env 里的 STUDIO_WORKER_TOKEN 与执行器令牌不一致，需要改成同一个值')
    else:
        sep='' if (not text or text.endswith('\n')) else '\n'
        env_file.write_text(text+sep+'STUDIO_WORKER_TOKEN='+token_value+'\n',encoding='utf-8')
        env_note.append('已把 STUDIO_WORKER_TOKEN 追加到 .env')
else:
    env_note.append('没有 .env：容器启动前请自行设置 STUDIO_WORKER_TOKEN='+token_value)

# ── 2. 拷贝代码与私有文件到运行目录 ──
runtime.mkdir(parents=True,exist_ok=True);runtime.chmod(0o700)
for name in FILES:
    shutil.copy2(source/name,runtime/name)
shutil.copytree(source/'node_modules',runtime/'node_modules',dirs_exist_ok=True)
private=runtime/'.ai/browser-state';private.mkdir(parents=True,exist_ok=True);private.chmod(0o700)
for name in (['studio-session.auth.json'] if has_session else [])+['studio-runner-token']:
    shutil.copy2(private_src/name,private/name);(private/name).chmod(0o600)

# ── 3. 选一个确定的 node：优先显式指定，其次 node@22（本项目长期验证的运行时），
#      最后才用 PATH 里碰到的任意 node —— 免得某台机器上装了新版 node 就把服务换到未验证的运行时。
def pick_node():
    if os.environ.get('NODE_BIN'):
        return os.environ['NODE_BIN']
    pinned=Path('/opt/homebrew/opt/node@22/bin/node')
    if pinned.exists():
        return str(pinned)
    found=shutil.which('node')
    if not found:
        raise SystemExit('找不到 node。请安装 Node.js 22 或更高版本（https://nodejs.org），或用 NODE_BIN=/path/to/node 指定。')
    return found
node=Path(pick_node()).resolve()
print(f'  使用 node：{node}')

# ── 4. 正在跑任务时不要重启：已消耗的积分不会退回 ──
label='cn.aigccat.studio-worker';domain=f'gui/{os.getuid()}'
def probe(path):
    req=urllib.request.Request('http://127.0.0.1:8790'+path,headers={'Authorization':'Bearer '+token_value})
    with urllib.request.urlopen(req,timeout=5) as response:
        return json.load(response)
# /health 依赖登录会话，没有会话时会返回 400；就绪判定必须用不依赖会话的 /session
def ready():
    return probe('/session')
active=None
try:
    active=probe('/health').get('active')
except Exception:
    pass
if active and '--force' not in sys.argv:
    raise SystemExit(
        f'执行器正在执行任务（{active}），重启会打断它，且已消耗的积分不会退回。\n'
        '等它跑完再装，或者确认要打断就加 --force。')

# ── 5. 注册并启动 ──
loaded=subprocess.run(['launchctl','print',f'{domain}/{label}'],capture_output=True).returncode==0
env={'STUDIO_ROOT':str(runtime)}
# 代理只在显式设置时写进服务环境，避免把某台机器上的私有代理端口固化给别人
if os.environ.get('STUDIO_PROXY') is not None:
    env['STUDIO_PROXY']=os.environ['STUDIO_PROXY']
plist={'Label':label,'ProgramArguments':[str(node),str(runtime/'server.cjs')],'WorkingDirectory':str(runtime),'EnvironmentVariables':env,'RunAtLoad':True,'KeepAlive':True,'StandardOutPath':str(private/'worker.log'),'StandardErrorPath':str(private/'error.log')}
p=Path.home()/'Library/LaunchAgents'/f'{label}.plist';p.write_bytes(plistlib.dumps(plist))

# 必须 bootout + bootstrap —— 不能只用 kickstart -k。
# 服务已经加载时，kickstart 用的是 launchd 内存里的旧配置，不会重读 plist，
# 于是改了 EnvironmentVariables（比如新加 STUDIO_PROXY）进程里也看不到。
# 这个坑实测踩过：plist 里明明有代理，进程环境里没有，导致登录窗口直连、页面一直转。
if loaded:
    subprocess.run(['launchctl','bootout',f'{domain}/{label}'],capture_output=True)
    time.sleep(1)
ok=False
for _ in range(6):
    if subprocess.run(['launchctl','bootstrap',domain,str(p)],capture_output=True).returncode==0:
        ok=True;break
    subprocess.run(['launchctl','bootout',f'{domain}/{label}'],capture_output=True)
    time.sleep(1)
if not ok:
    raise SystemExit(f'注册服务失败。手动试试：\n  launchctl bootout {domain}/{label}\n  launchctl bootstrap {domain} {p}')

# 自检：launchd 真的按新配置加载了环境变量吗（这是刚踩过的坑，必须当场验）
def loaded_env():
    out=subprocess.run(['launchctl','print',f'{domain}/{label}'],capture_output=True,text=True).stdout
    return out
mismatch=[k for k,v in env.items() if f'{k} =>' not in loaded_env()]
if mismatch:
    raise SystemExit(
        'launchd 没有按新配置加载这些环境变量：'+', '.join(mismatch)+'\n'
        '这类情况通常是旧的任务还在加载状态，稍等几秒重跑一次本脚本即可。')

# ── 5. 等它就绪，并把结果讲清楚 ──
for attempt in range(20):
    try:
        if ready():
            break
    except Exception:
        if attempt==19:
            raise SystemExit(f'执行器没有就绪，看日志： {private/"error.log"}')
        time.sleep(1)

print('Studio worker installed in Application Support; login data private; no browser launched')
print('')
print('  执行器已就绪：http://127.0.0.1:8790')
print(f'  运行副本：{runtime}')
print(f'  私有目录（登录态与令牌，权限 600）：{private}')
print('  登录会话：'+('已接入' if has_session else '未接入 —— 到界面里点「连接网页订阅」，或跑 connect-session.cjs'))
if 'STUDIO_PROXY' not in env:
    print('  代理：未配置（直连）。需要代理的网络环境，重装时在前面带上 STUDIO_PROXY=http://主机:端口')
if generated_token:
    print('')
    print(f'  已生成执行器令牌：{token_src}')
    print(f'    STUDIO_WORKER_TOKEN={generated_token}')
for note in env_note:
    print(f'  {note}')
print('')
print('  记着让容器重新读取环境变量：')
print('    docker compose -f docker-compose.allinone.yml up -d      # 单容器')
print('    docker compose -p aigccat -f docker-compose.yml up -d   # 多容器')
