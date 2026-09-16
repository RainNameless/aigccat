# coding: utf-8
"""Install the session worker as a persistent macOS user service (no browser)."""
import os,plistlib,shutil,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2]
runtime=Path.home()/'Library/Application Support/aigccat/studio-worker'
runtime.mkdir(parents=True,exist_ok=True);runtime.chmod(0o700)
for name in ('export-generated.cjs','client.cjs','process.cjs','server.cjs','normalize.cjs','preview.cjs','package.json','package-lock.json'):
 shutil.copy2(root/'scripts/studio-runner'/name,runtime/name)
shutil.copytree(root/'scripts/studio-runner/node_modules',runtime/'node_modules',dirs_exist_ok=True)
private=runtime/'.ai/browser-state';private.mkdir(parents=True,exist_ok=True);private.chmod(0o700)
for name in ('studio-session.auth.json','studio-runner-token'):
 shutil.copy2(root/'.ai/browser-state'/name,private/name);(private/name).chmod(0o600)
label='cn.aigccat.studio-worker';domain=f'gui/{os.getuid()}'
loaded=subprocess.run(['launchctl','print',f'{domain}/{label}'],capture_output=True).returncode==0
node=Path(shutil.which('node')).resolve()
plist={'Label':label,'ProgramArguments':[str(node),str(runtime/'server.cjs')],'WorkingDirectory':str(runtime),'EnvironmentVariables':{'STUDIO_ROOT':str(runtime)},'RunAtLoad':True,'KeepAlive':True,'StandardOutPath':str(private/'worker.log'),'StandardErrorPath':str(private/'error.log')}
p=Path.home()/'Library/LaunchAgents'/f'{label}.plist';p.write_bytes(plistlib.dumps(plist))
subprocess.run(['launchctl','kickstart','-k',f'{domain}/{label}'] if loaded else ['launchctl','bootstrap',domain,str(p)],check=True)
print('Studio worker installed in Application Support; login data private; no browser launched')

# Wait for launchd to finish restarting before the caller can submit work.
import time, urllib.request
for attempt in range(20):
 try:
  req=urllib.request.Request('http://127.0.0.1:8790/health',headers={'Authorization':'Bearer '+(private/'studio-runner-token').read_text().strip()})
  with urllib.request.urlopen(req,timeout=10) as response:
   if response.status==200:break
 except Exception:
  if attempt==19:raise SystemExit('Worker did not become ready; check the private service log')
  time.sleep(1)
print('Studio worker health verified')
