"""Migrate public accounts once, deploy one authenticated entry for all networks."""
from pathlib import Path
import json, os, secrets, shlex, shutil, subprocess, time, urllib.request, urllib.error
root=Path(__file__).resolve().parents[2]
private=Path.home()/'.config/aigccat/auth'
for folder in [private,private/'data',private/'secrets']:
 folder.mkdir(parents=True,exist_ok=True,mode=0o700);folder.chmod(0o700)
ssh=['ssh','-i',str(Path.home()/'Documents/ops_all'),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','root@<vps-ip>']
def remote(code,**kwargs):return subprocess.run(ssh+['python3 -c '+shlex.quote(code)],text=True,check=True,**kwargs)
first=not (private/'data/accounts.json').exists()
if first:
 # Freeze the old writer before copying so no account/session updates are lost.
 code="""import pathlib,json,subprocess
subprocess.run(['systemctl','stop','aigccat-auth'],check=True)
data=pathlib.Path('/var/lib/aigccat-auth/accounts.json').read_text()
env=dict(l.split('=',1) for l in pathlib.Path('/etc/aigccat-auth.env').read_text().splitlines() if '=' in l)
print(json.dumps({'accounts':json.loads(data),'proxy':env['AUTH_PROXY_TOKEN']}))
"""
 try:
  snapshot=json.loads(remote(code,capture_output=True).stdout)
  for name,value in [('data/accounts.json',json.dumps(snapshot['accounts'])),('secrets/proxy.token',snapshot['proxy'])]:
   p=private/name;p.write_text(value);p.chmod(0o600)
 except Exception:
  subprocess.run(ssh+['systemctl start aigccat-auth'],check=False)
  raise
p=private/'secrets/automation.token'
if not p.exists():p.write_text(secrets.token_hex(32));p.chmod(0o600)
client=Path.home()/'.config/aigccat/client';client.mkdir(parents=True,exist_ok=True,mode=0o700)
shutil.copy2(root/'scripts/auth-server/client.py',client/'aigccat_auth.py')
env={**os.environ,'AUTH_UID':str(os.getuid()),'AUTH_GID':str(os.getgid())}
compose=['docker','compose','-p','aigccat','-f',str(root/'docker-compose.yml')]
# Only web port publishing changes; the existing image and other workers are kept.
subprocess.run(compose+['up','-d','--no-deps','--no-build','--pull','never','web'],env=env,check=True,cwd=root)
subprocess.run(compose+['up','-d','--no-deps','--no-build','--pull','never','gateway'],env=env,check=True,cwd=root)
for _ in range(40):
 try:
  urllib.request.urlopen('http://127.0.0.1:8080/api/auth/me',timeout=2)
 except urllib.error.HTTPError as e:
  if e.code==401:break
 except Exception:pass
 time.sleep(.25)
else:raise SystemExit('Local gateway not healthy; private migrated data retained for recovery')
config=(root/'scripts/auth-server/nginx-unified.conf').read_text()
code="""import pathlib,sys,subprocess,shutil,time
p=pathlib.Path('/etc/nginx/sites-available/<your-domain>')
backup=pathlib.Path('/root/aigccat-tunnel-backup')/('unified-'+str(int(time.time())))
backup.mkdir(parents=True);shutil.copy2(p,backup/p.name)
p.write_text(sys.stdin.read())
if subprocess.run(['nginx','-t']).returncode:
 shutil.copy2(backup/p.name,p);raise SystemExit('Invalid Nginx configuration; restored previous file')
subprocess.run(['systemctl','reload','nginx'],check=True)
subprocess.run(['systemctl','disable','--now','aigccat-auth'],check=True)
print('Public proxy now uses the unified local gateway; old account writer disabled')
"""
remote(code,input=config)
print('Unified gateway deployed; existing accounts preserved, registration closed')
