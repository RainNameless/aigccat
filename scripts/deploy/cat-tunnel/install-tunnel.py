"""Install one restricted reverse SSH key and a reconnecting launchd service."""
import os, pathlib, plistlib, subprocess
HOME_PATH=pathlib.Path.home()
key=HOME_PATH/'.ssh/aigccat_cat_tunnel'
admin=HOME_PATH/'Documents/ops_all'
ssh=['ssh','-i',str(admin),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=15','root@<vps-ip>']
if not key.exists(): subprocess.run(['ssh-keygen','-t','ed25519','-N','','-C','aigccat-cat-reverse-tunnel','-f',str(key)],check=True,stdout=subprocess.DEVNULL)
key.chmod(0o600)
pub=key.with_suffix('.pub').read_text().strip()
line='restrict,port-forwarding,permitlisten="127.0.0.1:18080",permitopen="127.0.0.1:1",command="/bin/false" '+pub
remote="""import pathlib,sys
p=pathlib.Path('/root/.ssh/authorized_keys');p.parent.mkdir(mode=0o700,exist_ok=True)
line=sys.stdin.read().strip();s=p.read_text() if p.exists() else ''
if line not in s.splitlines(): p.write_text(s.rstrip()+'\\n'+line+'\\n')
p.chmod(0o600)
"""
import shlex
subprocess.run(ssh+['python3 -c '+shlex.quote(remote)],input=line,text=True,check=True)
label='cn.aigccat.cat-tunnel'
p=HOME_PATH/'Library/LaunchAgents'/f'{label}.plist'
args=['/usr/bin/ssh','-N','-T','-i',str(key),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-R','127.0.0.1:18080:127.0.0.1:8080','root@<vps-ip>']
p.write_bytes(plistlib.dumps({'Label':label,'ProgramArguments':args,'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,'StandardOutPath':'/tmp/aigccat-cat-tunnel.log','StandardErrorPath':'/tmp/aigccat-cat-tunnel.err.log'}));p.chmod(0o600)
subprocess.run(['launchctl','bootout',f'gui/{os.getuid()}/{label}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(p)],check=True)
print('Installed dedicated restricted SSH key and launchd reverse tunnel on server loopback 18080')
