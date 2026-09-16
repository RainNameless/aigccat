"""Publish real checkpoint states to each newly-created case; no synthetic success."""
import pathlib,json,urllib.request,base64,datetime,sys

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers
ROOT=pathlib.Path(__file__).resolve().parents[2];D=ROOT/'outputs/fullflow-30'
labels={'original':'原图生成','multiview':'四视图生成','geometry':'白模建模','texture':'贴图处理','texture-parts':'贴图处理','rig':'骨骼绑定','rig-v2':'骨骼绑定 · v2','walk':'行走动作','run':'跑步动作','export':'导出模型'}
def api(route,body=None):
 req=urllib.request.Request('http://127.0.0.1:8080'+route,data=json.dumps(body).encode() if body else None,headers={'Content-Type':'application/json'},method='PUT' if body else 'GET')
 with _auth_urlopen(req,timeout=30)as r:return json.load(r)
archived=api('/api/workbench/state').get('archived',[])
for d in D.glob('case-*'):
 if not (d/'local.json').exists():continue
 local=json.loads((d/'local.json').read_text());asset=local.get('asset')
 if not asset or asset in archived:continue
 steps=[]
 for p in d.glob('*.private.json'):
  x=json.loads(p.read_text());name=p.name.split('.')[0]
  if not x.get('submission'):continue
  at=datetime.datetime.fromisoformat(x['submission'].replace('Z','+00:00')).timestamp()
  status={'success':'done','submitted':'running','submitting':'running'}.get(x.get('status'),x.get('status'))
  if x.get('error') and status!='done':
   status='failed' if x.get('confirmed_failure') or str(x['error']).startswith('Studio HTTP 400') else 'unknown'
  steps.append({'job_id':'studio_'+name,'kind':'image_generate' if name in ['original','multiview'] else 'model_process' if name!='geometry' else 'model_build','provider':'tripo_studio','status':status,'created_at':int(at),'progress':{'phase':labels.get(name,name),'percent':x.get('progress',100 if status=='done' else 0)},'error':x.get('error'),'provider_task_id':x.get('operator_id')or x.get('asset_id')})
 if not steps:continue
 steps.sort(key=lambda x:x['created_at']);summary=steps[-1]
 body={'bytes_b64':base64.b64encode(json.dumps(summary,ensure_ascii=False).encode()).decode()}
 api('/api/assets/'+asset+'/file/source/studio_flow_activity.json',body)
 api('/api/assets/'+asset+'/file/source/studio_flow_history.json',{'bytes_b64':base64.b64encode(json.dumps(steps,ensure_ascii=False).encode()).decode()})
 report={'case':d.name,'asset':asset,'stages':steps,'versions':local.get('versions',{}),'complete':json.loads((d/'visual-review.json').read_text()).get('complete',False) if (d/'visual-review.json').exists() else False}
 (d/'progress.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('Synced real Studio checkpoints')
