#!/usr/bin/env python3
"""Import a downloaded Studio GLB without provider keys or paid calls.
Caches the result by SHA256 to avoid duplicate imports; ambiguous POST failure is
recorded and never retried automatically. Only talks to the local workbench.
"""
import argparse, hashlib, json, struct, time, urllib.request, urllib.parse
from pathlib import Path

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers


def project_assignment(state, name, ref):
    folders = {'test': 'test', 'demo': 'Demo', **state.get('project_folders', {})}
    name = name.strip()
    if not name:
        return {'asset_projects': {ref: ''}}
    matches = [key for key, label in folders.items()
               if key.casefold() == name.casefold() or str(label).casefold() == name.casefold()]
    project = next((key for key in matches if key == name.lower()), matches[0] if matches else name)
    patch = {'asset_projects': {ref: project}}
    if not matches:
        patch['project_folders'] = {project: name}
    return patch


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('file',type=Path)
    p.add_argument('--name',default='')
    p.add_argument('--type',default='character')
    p.add_argument('--source',default='')
    p.add_argument('--project',default='test')
    p.add_argument('--base',default='http://127.0.0.1:8080')
    args=p.parse_args()
    if urllib.parse.urlparse(args.base).hostname not in ('localhost','127.0.0.1','::1'):p.error('base 必须是本地工作台')
    data=args.file.read_bytes()
    if len(data)<20 or data[:4]!=b'glTF' or struct.unpack_from('<I',data,8)[0]!=len(data):p.error('不是完整 GLB 文件')
    digest=hashlib.sha256(data).hexdigest()
    output=Path(__file__).resolve().parents[1]/'outputs/studio-flow'
    output.mkdir(parents=True,exist_ok=True)
    receipt=output/(digest+'.json')
    if receipt.exists():
        previous=json.loads(receipt.read_text())
        if previous.get('result'):print(json.dumps(previous,ensure_ascii=False));return
        p.error('上次提交结果待核实，禁止自动重复导入；检查记录 '+str(receipt))
    record={'sha256':digest,'file':str(args.file.resolve()),'source':args.source,'status':'submitting','started_at':time.time()}
    receipt.write_text(json.dumps(record,ensure_ascii=False,indent=2))
    def request(path,body,ctype='application/json',method='POST'):
        req=urllib.request.Request(args.base+path,data=body,headers={'Content-Type':ctype},method=method)
        with _auth_urlopen(req,timeout=180) as r:return json.load(r)
    boundary='aigccat_'+digest[:24]
    body=bytearray()
    for key,value in {'name':args.name,'asset_type':args.type,'source_path':args.source}.items():
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="model.glb"\r\nContent-Type: model/gltf-binary\r\n\r\n'.encode())
    body.extend(data);body.extend(f'\r\n--{boundary}--\r\n'.encode())
    try:
        result=request('/api/assets/import',bytes(body),'multipart/form-data; boundary='+boundary)
        record.update(result=result,status='imported',import_seconds=round(time.time()-record['started_at'],3))
        receipt.write_text(json.dumps(record,ensure_ascii=False,indent=2))
        ref=result['dir']+'/'+result['asset_id']
        state=request('/api/workbench/state',None,method='GET')
        request('/api/workbench/state',json.dumps(project_assignment(state,args.project,ref)).encode(),method='PUT')
        record['url']=args.base+'/#tool=model&asset='+urllib.parse.quote(ref,safe='')
        record['status']='complete'
    except Exception as e:
        record.update(error=str(e),status='imported_metadata_failed' if record.get('result') else 'submission_unconfirmed')
        raise
    finally:
        receipt.write_text(json.dumps(record,ensure_ascii=False,indent=2))
        print(json.dumps(record,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
