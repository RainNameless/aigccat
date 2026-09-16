"""Authenticated local Blender bridge for OpenCode; launchd owns its lifetime."""
import json, os, re, signal, subprocess, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(os.environ['RIG_TASK_ROOT']).resolve()
TOKEN = os.environ['RIG_AGENT_TOKEN']
BLENDER = os.environ.get('BLENDER_BIN', '/Applications/Blender.app/Contents/MacOS/Blender')
VALIDATOR = Path(__file__).with_name('inspect.py')
GATE = threading.Lock()
PROCESSES = {}
CANCELLED = set()

def task_dir(task):
    if not re.fullmatch(r'rig_[0-9a-f]{24}', task): raise ValueError('Invalid task ID')
    folder = ROOT / task
    if folder.is_symlink() or not folder.is_dir(): raise ValueError('Task directory unavailable')
    return folder

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError): pass
    def auth(self): return self.headers.get('Authorization') == 'Bearer '+TOKEN
    def do_GET(self):
        if not self.auth(): return self.send(403, {'error':'Unauthorized'})
        if self.path != '/health': return self.send(404, {'error':'Not found'})
        try:
            result=subprocess.run([BLENDER,'--version'],capture_output=True,text=True,timeout=10)
            self.send(200, {'ready':result.returncode==0,'blender':result.stdout.splitlines()[0]})
        except Exception: self.send(503, {'ready':False,'error':'Blender unavailable'})
    def do_POST(self):
        if not self.auth(): return self.send(403, {'error':'Unauthorized'})
        try:
            n=int(self.headers.get('Content-Length',0))
            if n>65536: raise ValueError('Request too large')
            req=json.loads(self.rfile.read(n)); task=req['id']; folder=task_dir(task)
            if self.path=='/cancel':
                CANCELLED.add(task); (folder/'.cancelled').touch()
                p=PROCESSES.get(task)
                if p and p.poll() is None: os.killpg(p.pid,signal.SIGTERM)
                return self.send(200, {'cancelled':True})
            if self.path!='/run': return self.send(404,{'error':'Not found'})
            if task in CANCELLED or (folder/'.cancelled').exists(): raise ValueError('Task cancelled')
            if not GATE.acquire(blocking=False): return self.send(409,{'error':'Blender is busy; no execution started'})
            try:
                if req.get('mode')=='inspect':
                    source=req.get('source','source.glb')
                    if source not in ('source.glb','output.glb'): raise ValueError('Invalid inspect source')
                    script=VALIDATOR; args=[source, 'source' if source=='source.glb' else 'result']
                else:
                    script=(folder / req['script']).resolve()
                    if not script.is_relative_to(folder) or script.suffix!='.py' or not script.is_file(): raise ValueError('Script must be a Python file inside this task')
                    args=req.get('args',[])
                    if not isinstance(args,list) or len(args)>20 or any(not isinstance(a,str) or len(a)>2000 for a in args): raise ValueError('Invalid arguments')
                # No provider keys or browser state in Blender's environment.
                env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(folder),'TMPDIR':'/tmp','PYTHONUNBUFFERED':'1'}
                p=subprocess.Popen([BLENDER,'-b','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',str(script),'--',*args],cwd=folder,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
                PROCESSES[task]=p
                try: output,_=p.communicate(timeout=600)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid,signal.SIGKILL); output,_=p.communicate(); raise ValueError('Blender timed out after 600 seconds')
                (folder/('blender-'+str(time.time_ns())+'.log')).write_text(output)
                self.send(200, {'ok':p.returncode==0,'exit_code':p.returncode,'output':output[-18000:]})
            finally: PROCESSES.pop(task,None); GATE.release()
        except Exception as e: self.send(400,{'error':str(e)[:500]})

if __name__=='__main__': ThreadingHTTPServer(('0.0.0.0',8791),Handler).serve_forever()
