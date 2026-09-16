"""Checkpointed one-pass batch. Failed submissions are never automatically retried.

Does not mark cases complete: actual visual/animation review is a separate gate.
Run under launchd so closing the development session does not kill the batch.
"""
import pathlib,json,subprocess,time,fcntl,sys,datetime
ROOT=pathlib.Path(__file__).resolve().parents[2];D=ROOT/'outputs/highquality-10';S=ROOT/'scripts/highquality-runner'
NODE='node';PY='/usr/bin/python3';BLENDER='/Applications/Blender.app/Contents/MacOS/Blender'
lock=open(D/'batch.lock','w')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:sys.exit('Batch already running')
def sync():
 subprocess.run([PY,str(S/'fullflow-sync.py')],cwd=ROOT,stdout=subprocess.DEVNULL,timeout=90)
def run(*args):
 p=subprocess.Popen(list(map(str,args)),cwd=ROOT)
 while p.poll() is None:
  try:sync()
  except Exception as e:print('Progress publish delayed:',type(e).__name__,flush=True)
  try:p.wait(timeout=8)
  except subprocess.TimeoutExpired:pass
 if p.returncode:raise RuntimeError('Stage command failed; checkpoint preserved')
def stage(case,name):
 file=D/case/(name+'.private.json')
 if file.exists():
  state=json.loads(file.read_text())
  if state.get('status') in ['failed','expired','cancelled','banned']:raise RuntimeError(name+' previously failed; no automatic retry')
  if state.get('status')=='success':return
 script='fullflow.cjs' if name in ['original','multiview'] else 'fullflow-model.cjs'
 args=[NODE,S/script,case,name]
 if name in ['walk','run']:args.append('preset:biped:'+name)
 run(*args)
def model(case,name):
 d=D/case
 if not (d/(name+'.source')).exists():run(NODE,S/'fullflow-download.cjs',case,name)
 if not (d/(name+'.glb')).exists():run(BLENDER,'--background','--python',S/'fullflow-convert.py','--',d,name)
 if not (d/(name+'-preview.png')).exists():run(NODE,S/'fullflow-prepare.cjs',case,name)
 run(PY,S/'fullflow-import.py',case,name)
items=json.loads((D/'manifest.json').read_text())['cases']
# First human and animal are under interactive QA; never race their operations.
for item in items:
 case=item['id'];d=D/case
 # All ten independent high-quality cases are included.
 d.mkdir(exist_ok=True)
 report=d/'batch-state.json'
 if report.exists() and json.loads(report.read_text()).get('status') in ['verified','failed','awaiting_visual_review','awaiting_quadruped_run']:continue
 try:
  print('BEGIN',case,item['name'],flush=True)
  report.write_text(json.dumps({'status':'running','started_at':datetime.datetime.now().isoformat()}))
  for name in ['original','multiview']:
   stage(case,name)
   if not (d/(name+'-0.png')).exists():run(NODE,S/'fullflow-download.cjs',case,name)
  run(PY,S/'fullflow-import.py',case,'references')
  stage(case,'geometry');model(case,'geometry')
  stage(case,'texture');model(case,'texture')
  if item['rig_type']=='quadruped':
   # No grounded quadruped run preset: do not substitute biped or fake completion.
   report.write_text(json.dumps({'status':'awaiting_quadruped_run','complete':False}));continue
  if item['rig_type']:
   for name in ['rig','walk','run']:stage(case,name)
  stage(case,'export')
  if not (d/'final.glb').exists():run(NODE,S/'fullflow-model.cjs',case,'export')
  if not (d/'final-preview.png').exists():run(NODE,S/'fullflow-prepare.cjs',case,'final')
  run(PY,S/'fullflow-import.py',case,'final')
  report.write_text(json.dumps({'status':'awaiting_visual_review','complete':False}))
 except Exception as e:
  report.write_text(json.dumps({'status':'failed','error':str(e),'complete':False}));print('STOP CASE',case,str(e),flush=True)
 finally:
  try:sync()
  except Exception:pass
print('Batch pass finished; visual review and any unresolved animal animation remain.',flush=True)
