"""Import only this manifest's new cases, preserving native reference and model stages."""
import json,sys,pathlib,urllib.request,base64,hashlib

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers
ROOT=pathlib.Path(__file__).resolve().parents[2];DIR=ROOT/'outputs/fullflow-30'
case=sys.argv[1];stage=sys.argv[2] if len(sys.argv)>2 else 'references'
item=next(x for x in json.loads((DIR/'manifest.json').read_text())['cases'] if x['id']==case)
d=DIR/case;receipt=d/'local.json'
def api(route,body=None,method=None):
 data=json.dumps(body).encode() if body is not None else None
 req=urllib.request.Request('http://127.0.0.1:8080'+route,data=data,headers={'Content-Type':'application/json'},method=method or ('POST' if data else 'GET'))
 with _auth_urlopen(req,timeout=180) as r:return json.load(r)
def save():receipt.write_text(json.dumps(local,ensure_ascii=False,indent=2))
local=json.loads(receipt.read_text()) if receipt.exists() else {}
if not local:
 local={'creating':True};save()
 kind={'characters':'character','animals':'animal','buildings':'building','props':'prop'}[item['asset_type']]
 r=api('/api/assets',{'draft':True,'name':item['name'],'description':item['prompt'],'asset_type':kind})
 local={'asset':item['asset_type']+'/'+r['asset_id'],'versions':{}};save()
if not local.get('asset'):raise RuntimeError('Unresolved asset creation; inspect before repeat')
state=api('/api/workbench/state')
if local['asset'] in state.get('archived',[]):raise RuntimeError('User archived this case; do not restore or modify')
api('/api/workbench/state',{'project_folders':{'fullflow30':'全流程案例 · 30'},'asset_projects':{local['asset']:'fullflow30'}},'PUT')
base='/api/assets/'+local['asset']
def put(key,data):return api(base+'/file/'+key,{'bytes_b64':base64.b64encode(data).decode()},'PUT')
if stage=='draft':
 put('source/tags.json',json.dumps({'tags':['demo','fullflow30']}).encode())
elif stage=='references':
 put('source/input_reference.png',(d/'original-0.png').read_bytes())
 for i,v in enumerate(['front','side','back','right']):
  data=(d/f'multiview-{i}.png').read_bytes();put('source/reference_'+v+'.png',data);put(f'source/images/job_002_set1_{v}.png',data)
 put('source/tags.json',json.dumps({'tags':['demo','fullflow30']}).encode())
else:
 model=d/(stage+'.glb' if stage!='final' else 'final.glb');data=model.read_bytes();sha=hashlib.sha256(data).hexdigest()
 if stage not in local['versions']:
  head=api(base+'/history').get('head')
  local['versions'][stage]={'submitting':True,'sha256':sha};save()
  r=api(base+'/versions/import',{'glb_b64':base64.b64encode(data).decode(),'provider':'tripo_studio','expected_history_node_id':head})
  local['versions'][stage]={'version':r['version'],'sha256':sha};save()
 v=local['versions'][stage].get('version')
 if not v:raise RuntimeError('Unresolved import; inspect history instead of repeating')
 meta=api(base+'/file/versions/'+v+'/meta.json');meta.update(stage_name={'geometry':'白模','texture-parts':'贴图','texture':'贴图','final':'成品 · 行走与跑步' if item['rig_type'] else '成品','final-centered':'成品 · 原地行走与跑步'}[stage],studio_project_id=json.loads((d/'geometry.private.json').read_text())['result']['project_id'])
 put('versions/'+v+'/meta.json',json.dumps(meta).encode())
 preview=d/(stage+'-preview.png')
 if preview.exists():put('versions/'+v+'/preview.png',preview.read_bytes())
print(json.dumps(local,ensure_ascii=False))
