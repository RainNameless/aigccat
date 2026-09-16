"""Install the persistent host bridge, without printing its shared token."""
from pathlib import Path
import os, plistlib, subprocess, sys, shutil
repo=Path(__file__).resolve().parents[2]
runtime=Path.home()/'Library/Application Support/aigccat/opencode'
runtime.mkdir(parents=True,exist_ok=True)
(runtime/'tasks').mkdir(exist_ok=True)
for name in ['host.py','inspect.py']: shutil.copy2(repo/'scripts/opencode-runner'/name,runtime/name)
entries=dict(line.split('=',1) for line in (repo/'.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line)
token=entries['RIG_AGENT_TOKEN'];label='cn.aigccat.opencode-blender'
plist=Path.home()/'Library/LaunchAgents'/f'{label}.plist'
config={'Label':label,'ProgramArguments':[sys.executable,str(runtime/'host.py')],'WorkingDirectory':str(runtime),'RunAtLoad':True,'KeepAlive':True,'EnvironmentVariables':{'RIG_AGENT_TOKEN':token,'RIG_TASK_ROOT':str(runtime/'tasks')},'StandardOutPath':'/tmp/aigccat-opencode-blender.log','StandardErrorPath':'/tmp/aigccat-opencode-blender.err.log'}
plist.write_bytes(plistlib.dumps(config));plist.chmod(0o600)
subprocess.run(['launchctl','bootout',f'gui/{os.getuid()}/{label}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],check=True)
print('Installed persistent OpenCode Blender bridge on 8791')
