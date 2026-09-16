"""Run exactly ten candidates per direction; persist failures, never auto retry.

Only local Blender and local asset import/upload APIs are used. No API secrets.
Restarting skips any attempted candidate, including failures. Imports are serial.
"""
import argparse
import base64
import hashlib
import json
import subprocess
import time
from pathlib import Path
import requests

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'outputs/test-models-100'
WEB='http://127.0.0.1:8080'
BLENDER='/Applications/Blender.app/Contents/MacOS/Blender'
NAMES=['截面放样','细分曲面','体素融合','轮廓拟合','服装结构','发片结构','面部雕形','参考投影','低模保形','混合构建']


def api(method,path,**kw):
    r=requests.request(method,WEB+path,headers={**_auth_headers(WEB),**kw.pop("headers",{})},timeout=120,allow_redirects=False,**kw)
    if not r.ok:raise RuntimeError(f'{method} {path}: HTTP {r.status_code}: {r.text[:400]}')
    return r.json()


def save(manifest):
    tmp=OUT/'manifest.tmp'
    tmp.write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    tmp.replace(OUT/'manifest.json')


def upload(asset,path,data):
    return api('PUT',f'/api/assets/characters/{asset}/file/{path}',json={'bytes_b64':base64.b64encode(data).decode()})


def main():
    p=argparse.ArgumentParser();p.add_argument('--direction',type=int,choices=range(1,11));args=p.parse_args()
    OUT.mkdir(exist_ok=True)
    reference=OUT/'reference.png'
    if not reference.exists():
        r=requests.get(WEB+'/api/assets/characters/chr_schoolgirl_with_111/file/source/reference_front.png',headers=_auth_headers(WEB),timeout=30);r.raise_for_status();reference.write_bytes(r.content)
    manifest=json.loads((OUT/'manifest.json').read_text()) if (OUT/'manifest.json').exists() else {
        'target':100,'directions':NAMES,'max_iterations_per_direction':10,'records':[],
        'reference_sha256':hashlib.sha256(reference.read_bytes()).hexdigest(),
        'method':'Codex-authored procedural algorithm comparison, no supplier API calls',
        'assessment':'All candidates pending joint evaluation; file success is not visual quality approval'}
    for direction in ([args.direction] if args.direction else range(1,11)):
        for iteration in range(1,11):
            name=f'test_d{direction:02}_{iteration:02}'
            if any(r['name']==name for r in manifest['records']):continue
            record={'name':name,'direction':direction,'direction_name':NAMES[direction-1],'iteration':iteration,'status':'running','started_at':time.time()}
            manifest['records'].append(record);save(manifest)
            directory=OUT/name;directory.mkdir(exist_ok=True)
            try:
                # The prototype is adopted as candidate 1; do not silently rebuild it.
                if not (directory/'stats.json').exists():
                    with (directory/'blender.log').open('w') as log:
                        result=subprocess.run([BLENDER,'-b','--factory-startup','--disable-autoexec','--python-exit-code','73','--python',str(ROOT/'scripts/blender/test_model_directions.py'),'--',
                            '--direction',str(direction),'--iteration',str(iteration),'--out',str(directory),'--reference',str(reference)],stdout=log,stderr=subprocess.STDOUT,timeout=180)
                    if result.returncode:raise RuntimeError('Blender failed; see blender.log')
                stats=json.loads((directory/'stats.json').read_text())
                data=(directory/'model.glb').read_bytes()
                if not all((directory/(v+'.png')).exists() for v in ['front','side','back']):raise RuntimeError('Missing review renders')
                record['stats']=stats;record['sha256']=hashlib.sha256(data).hexdigest();record['bytes']=len(data)
                record['status']='importing';save(manifest)
                # Names/recipes are unique; check server to recover an uncertain import without duplication.
                existing=api('GET','/api/assets')['assets']
                found=next((a for a in existing if a.get('name')==name),None)
                if found:record['asset_id']=found['asset_id']
                else:
                    imported=api('POST','/api/assets/import',data={'name':name,'asset_type':'character','description':f'test · {NAMES[direction-1]} · 第 {iteration}/10 个候选；待评估',
                        'source_path':str(directory/'model.glb')},files={'file':('model.glb',data,'model/gltf-binary')})
                    record['asset_id']=imported['asset_id']
                save(manifest)
                for view in ['front','side','back']:
                    upload(record['asset_id'],f'versions/v001/qa/qa_{view}.png',(directory/(view+'.png')).read_bytes())
                upload(record['asset_id'],'versions/v001/preview.png',(directory/'front.png').read_bytes())
                upload(record['asset_id'],'source/reference_front.png',reference.read_bytes())
                upload(record['asset_id'],'source/experiment.json',(directory/'recipe.json').read_bytes())
                record['status']='generated';record['visual_status']='pending_joint_evaluation'
            except Exception as error:
                record['status']='failed';record['error']=str(error)
            finally:
                record['elapsed_s']=round(time.time()-record['started_at'],2);save(manifest)
                print(json.dumps({k:record.get(k) for k in ['name','status','asset_id','elapsed_s','error']},ensure_ascii=False),flush=True)


if __name__=='__main__':main()
