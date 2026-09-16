"""Deploy the named vhost without modifying the server's existing gateway."""
from pathlib import Path
import subprocess,urllib.request,ipaddress,secrets,json,shlex
root=Path(__file__).resolve().parent
private=Path.home()/'.config/aigccat'
private.mkdir(parents=True,exist_ok=True);private.chmod(0o700)
creds=private/'cat-access.json'
if not creds.exists():
 creds.write_text(json.dumps({'url':'https://<your-domain>','username':'rain','password':secrets.token_urlsafe(24)},indent=2)+'\n');creds.chmod(0o600)
auth=json.loads(creds.read_text())
hashed=subprocess.run(['openssl','passwd','-6','-stdin'],input=auth['password']+'\n',text=True,capture_output=True,check=True).stdout.strip()
data=json.loads(subprocess.check_output(['curl','-fsS','--max-time','20','https://api.cloudflare.com/client/v4/ips']))
assert data['success']
networks=[str(ipaddress.ip_network(n)) for key in ['ipv4_cidrs','ipv6_cidrs'] for n in data['result'][key]]
assert len(networks)>=15
allow='# Official Cloudflare edge networks; loopback is for SSH-only verification.\nallow 127.0.0.1;\nallow ::1;\n'+''.join('allow '+n+';\n' for n in networks)+'deny all;\n'
payload={'config':(root/'<your-domain>.conf').read_text(),'allow':allow,'auth':auth['username']+':'+hashed+'\n'}
remote='''import pathlib,sys,json,os,time,subprocess,shutil
j=json.load(sys.stdin);backup=pathlib.Path('/root/aigccat-tunnel-backup')/str(int(time.time()));backup.mkdir(parents=True)
site=pathlib.Path('/etc/nginx/sites-available/<your-domain>')
if site.exists() and any(marker in site.read_text() for marker in ['auth_request /_aigccat_auth', 'aigccat unified gateway']): j['config']=site.read_text()
paths={'config':'/etc/nginx/sites-available/<your-domain>','allow':'/etc/nginx/aigccat-cloudflare-allow.conf','auth':'/etc/nginx/aigccat.htpasswd'}
for k,v in paths.items():
 p=pathlib.Path(v)
 if p.exists(): shutil.copy2(p,backup/p.name)
 p.write_text(j[k]);p.chmod(0o640 if k=='auth' else 0o644)
os.chown(paths['auth'],0,__import__('grp').getgrnam('www-data').gr_gid)
link=pathlib.Path('/etc/nginx/sites-enabled/<your-domain>')
if not link.exists(): link.symlink_to(paths['config'])
subprocess.run(['nginx','-t'],check=True)
subprocess.run(['systemctl','reload','nginx'],check=True)
print('<your-domain> deployed; existing default vhost preserved')
'''
ssh=['ssh','-i',str(Path.home()/'Documents/ops_all'),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','root@<vps-ip>']
subprocess.run(ssh+['python3 -c '+shlex.quote(remote)],input=json.dumps(payload),text=True,check=True)
print('Access credentials stored privately at '+str(creds))
