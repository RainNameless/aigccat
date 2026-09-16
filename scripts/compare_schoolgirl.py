#!/usr/bin/env python3
"""真实三路线比较。默认生成；--execute-reviewed 在代理 Read 安全审查后执行直接脚本。禁止重试。"""
import argparse
import ast
import base64
import hashlib
import html
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import requests
from thumbrender import render_png
from blender.character_engine import validate, no_duplicates

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'outputs/schoolgirl-comparison'
PY = 'python3'
BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender'
WEB = os.environ.get('AIGCCAT_WEB', 'http://localhost:8080')
SECRETS = []
M = {}
DESC = '8岁小学生女孩，儿童正常体态，身高1.25米，黑色短发，白衬衣，蓝色及膝裙，白袜，平底鞋，红书包。完整着装、非成人体态。'


def clean(x):
    if isinstance(x, dict):
        return {k: ('[REDACTED]' if any(s in k.lower() for s in ('api_key', 'authorization', 'token_key')) else clean(v)) for k, v in x.items()}
    if isinstance(x, list):
        return [clean(v) for v in x]
    if isinstance(x, str):
        for key in SECRETS:
            x = x.replace(key, '[REDACTED]')
    return x


def save():
    (OUT / 'manifest.json').write_text(json.dumps(clean(M), ensure_ascii=False, indent=2))
    cards = []
    for r in M.get('routes', []):
        images = ''.join(f'<figure><img src="{r["slug"]}/{v}.png"><figcaption>{v}</figcaption></figure>' for v in ('front', 'side', 'back') if (OUT/r['slug']/f'{v}.png').exists())
        info = {k: v for k, v in r.items() if k not in ('model_response', 'final_asset')}
        cards.append('<article><h2>'+html.escape(r['name'])+'</h2>'+images+'<pre>'+html.escape(json.dumps(clean(info), ensure_ascii=False, indent=2))+'</pre></article>')
    refs = ''.join(f'<img width="180" src="reference_{v}.png" alt="模板参考 {v}">' for v in ('front', 'side', 'back'))
    (OUT/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>小学生角色三路线比较</title><style>body{background:#101827;color:#eee;font:15px sans-serif;margin:30px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}article{background:#202d40;padding:16px;border-radius:12px}img{max-width:100%}figure{margin:5px;display:inline-block;width:30%}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}</style><h1>真实三路线比较</h1><p>共同参考：template_render_reference，不是AI图片。仅渲染可信 character-engine-smoke.glb，未导入模板作为结果。参考图存在参数化造型限制与偏置，且可见表面条纹、简化面部；不能证明真实图生3D能力。job002 HTTP502 未重试。</p>'+refs+'<p>辅助路线单阶段同时返回 analysis + parameters，并非独立两步。辅助 Blender 5.2 与直接 Docker Blender 3.4.1 存在版本混杂；无金额估算。页面生成、GLB校验及导入成功不等于视觉合格。所有版本仅供人工审核，未批准或发布。</p><main>'+''.join(cards)+'</main><p>完整接口响应、模型响应与耗时：manifest.json</p>')


def request(method, url, body=None, key=None, label=None):
    rec = {'method': method, 'url': url, 'label': label, 'request': {k: ({'base64_length': len(v)} if k.endswith('_b64') else v) for k, v in (body or {}).items()}}
    if key:
        rec['request'] = {'model': body['model'], 'messages': '共同三图及本地保存提示词', 'stream': False}
    M['interfaces'].append(rec)
    save()
    start = time.monotonic()
    try:
        response = requests.request(method, url, json=body, headers=_auth_headers(url) or ({'Authorization': 'Bearer '+key} if key else {}), timeout=240, allow_redirects=False)
        rec['http_status'] = response.status_code
        try:
            data = response.json()
        except ValueError:
            data = {'raw_text': response.text}
        rec['response'] = clean(data)
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f'{label or url}: HTTP {response.status_code}')
        return data
    except Exception as exc:
        rec['error'] = clean(str(exc))
        raise
    finally:
        rec['elapsed_s'] = round(time.monotonic()-start, 3)
        save()


def api(method, path, body=None):
    return request(method, WEB+path, body, label=path)


def prefix(r):
    return '/api/assets/characters/'+r['asset_id']


def upload(r, key, data):
    return api('PUT', prefix(r)+'/file/'+key, {'bytes_b64': base64.b64encode(data).decode()})


def render(data, dest, reference=False):
    images = {}
    for view, axis in [('front', '-Z'), ('side', '+X'), ('back', '+Z')]:
        png = render_png(data, size=420, forward_axis=axis)
        if not png:
            raise RuntimeError('预览渲染失败：'+view)
        (dest / (('reference_' if reference else '')+view+'.png')).write_bytes(png)
        images[view] = png
    return images


def run(cmd, log, timeout=240):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    log.write_text(clean(p.stdout+'\n'+p.stderr))
    if p.returncode:
        raise RuntimeError(f'进程退出码 {p.returncode}，详见 {log}')


def deliver(r, path):
    r['glb'] = str(path)
    images = render(path.read_bytes(), OUT/r['slug'])
    r['preview_status'] = '三视图已渲染；视觉待人工验收'
    imported = api('POST', prefix(r)+'/versions/import', {'glb_b64': base64.b64encode(path.read_bytes()).decode(), 'provider': r['provider']})
    r['version'] = imported['version']
    r['validation'] = imported['validation']
    for view, data in images.items():
        upload(r, f'versions/{r["version"]}/qa/qa_{view}.png', data)
    upload(r, f'versions/{r["version"]}/preview.png', images['front'])
    r['final_asset'] = api('GET', prefix(r))
    r['status'] = '已生成、导入并上传预览；视觉未验收'


def guard_environment():
    p = subprocess.run(['docker','exec','aigccat-web-1','/bin/sh','-c','printenv AUTO_APPROVE; printenv AUTO_PUBLISH; true'], capture_output=True, text=True, check=True)
    if any(v.strip().lower() in ('1','true') for v in p.stdout.splitlines()):
        raise RuntimeError('自动审批/发布开启，禁止导入；未修改服务配置')


def generate(resume=False):
    if resume:
        M.update(json.loads((OUT/'manifest.json').read_text()))
        if any(r.get('request_attempted') for r in M['routes']):
            raise RuntimeError('已有模型调用，不允许该断点续行')
    if not resume and (OUT/'manifest.json').exists():
        raise RuntimeError('manifest 已存在，禁止重新付费运行')
    OUT.mkdir(exist_ok=True)
    if not resume:
        M.update(interfaces=[], routes=[], reference={'kind':'template_render_reference','not_ai_image':True,'source':str(ROOT/'outputs/character-engine-smoke.glb'),'failed_reference_job':'job002 HTTP502；禁止重试'}, fees={'currency_amount':None,'note':'仅记录返回的实际model、usage与实测耗时；资产创建也可能收费'}, blender_versions={'assisted':'5.2','direct':'Docker 3.4.1'})
    save()
    guard_environment()
    result = subprocess.run(['docker','exec','aigccat-web-1','/bin/cat','/srv/config/services.json'], capture_output=True, check=True, text=True)
    cfg = json.loads(result.stdout)
    SECRETS.extend(s['api_key'] for s in cfg.values() if isinstance(s,dict) and s.get('api_key'))
    refs = render((ROOT/'outputs/character-engine-smoke.glb').read_bytes(), OUT, True)
    M['reference']['sha256'] = {v:hashlib.sha256(b).hexdigest() for v,b in refs.items()}
    original = api('GET','/api/assets/characters/chr_hy4_107')
    spec = original['spec']
    settings = [('hy4','HY4辅助参数','hy4_character_params','vision','hy4-preview'),('gpt6_params','GPT6辅助参数','gpt6_character_params','text','gpt-6-astra'),('gpt6_direct','GPT6直接脚本','gpt6_direct_script','text','gpt-6-astra')]
    for slug,name,provider,service,model in settings:
        r = dict(slug=slug,name=name,provider=provider,requested_model=model,status='开始',stage='单阶段 analysis + parameters' if service=='vision' or slug=='gpt6_params' else '单阶段直接脚本')
        if resume:
            r = next(x for x in M['routes'] if x['slug']==slug)
            r['previous_blocker'] = r.pop('error', None)
            r['status'] = '修正PUT上传契约后继续；模型尚未调用'
        else:
            M['routes'].append(r)
        d = OUT/slug
        d.mkdir(exist_ok=True)
        try:
            if slug=='hy4':
                r['asset_id']='chr_hy4_107'
            elif not resume:
                created = api('POST','/api/assets',{'description':DESC,'name':'schoolgirl_'+slug,'asset_type':'character','height_m':1.25})
                r['asset_id']=created['asset_id']
                copied = dict(spec, asset_id=r['asset_id'])
                api('PUT',prefix(r)+'/spec',{'spec':copied,'note':'复用 chr_hy4_107 相同规格，仅替换资产ID；'+name})
            for view,data in refs.items():
                upload(r,'source/reference_'+view+'.png',data)
            upload(r,'source/reference_origin.json',json.dumps(M['reference'],ensure_ascii=False).encode())
            prompt = DESC+'\n三图依次正面、侧面、背面，均为 template_render_reference（不是AI图）。以文字目标为准；可指出模板参考偏差。'
            if slug!='gpt6_direct':
                prompt += '\n只输出严格JSON，顶层恰好 analysis 与 parameters。analysis为描述视觉观察、儿童比例、服装颜色与文字差异的JSON对象；parameters根据analysis与文字目标映射可信引擎，必须完整填写所有字段，不得返回代码。参数契约：age整数7或8；height_m数值[1.15,1.35]；head_ratio数值[4.8,5.8]；hair bob/short/pigtails；uniform skirt/trousers；shoes sneakers/mary_jane；socks ankle/knee；backpack布尔；materials含skin/hair/shirt/uniform/shoes/socks/backpack，均#RRGGBB。'
            else:
                prompt += '\n只输出可运行Blender3.4.1 Python代码，不要解释。CPU，不渲染，只导出GLB。Blender坐标Z-up front+Y，导出export_yup=True。身高1.25米，完整角色有眼睛鼻子嘴和头发，不要用头发遮住面部。材质含肤色黑发白衬衣蓝裙白袜平底鞋红书包。所有曲线显式转mesh以确保导出。只允许import bpy, math, mathutils, os, random；os只准读取os.environ["OUTPUT_GLB"]。不得网络、子进程、文件读写（唯一例外bpy.ops.export_scene.gltf(filepath=os.environ["OUTPUT_GLB"], export_format="GLB")）。不得保存blend，不得安装依赖，不得动态执行代码，不得渲染。使用Blender3.4兼容API。'
            (d/'prompt.txt').write_text(prompt)
            content = [{'type':'text','text':prompt}] + [{'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(b).decode()}} for b in refs.values()]
            s = cfg.get(service)
            if not s or not s.get('api_key'):
                raise RuntimeError('所需独立服务凭据缺失：'+service)
            r['request_attempted']=True
            save()
            response = request('POST',s['base_url'].rstrip('/')+'/chat/completions',{'model':model,'messages':[{'role':'user','content':content}],'stream':False},key=s['api_key'],label=slug)
            r['actual_model']=response.get('model')
            r['usage']=response.get('usage')
            r['model_elapsed_s']=M['interfaces'][-1]['elapsed_s']
            r['model_response']=clean(response)
            text = response['choices'][0]['message']['content'].strip()
            if text.startswith('```'):
                text=text.split('\n',1)[1].rsplit('```',1)[0].strip()
            if slug=='gpt6_direct':
                (d/'generated.py').write_text(clean(text))
                ast.parse(text)
                r['status']='待 Read 人工安全审查；尚未执行'
            else:
                obj=json.loads(text,object_pairs_hook=no_duplicates)
                if set(obj)!= {'analysis','parameters'} or not isinstance(obj['analysis'],dict):
                    raise ValueError('响应必须恰含 analysis对象与parameters')
                if set(obj['parameters']) != {'age','height_m','head_ratio','hair','uniform','shoes','socks','backpack','materials'}:
                    raise ValueError('参数字段不完整')
                validate(obj['parameters'])
                (d/'analysis.json').write_text(json.dumps(obj['analysis'],ensure_ascii=False,indent=2))
                inp=d/'parameters.json'
                inp.write_text(json.dumps(obj['parameters'],ensure_ascii=False,indent=2))
                run([BLENDER,'-b','--factory-startup','--disable-autoexec','--python-exit-code','73','--python',str(ROOT/'scripts/blender/character_engine.py'),'--','--input',str(inp),'--output',str(d/'model.glb')],d/'blender.log')
                deliver(r,d/'model.glb')
        except Exception as exc:
            r['status']='失败；未重试'
            r['error']=clean(str(exc))
        finally:
            save()
            print(r['name']+'：'+r['status'],flush=True)


def execute_reviewed():
    M.update(json.loads((OUT/'manifest.json').read_text()))
    for route in M['routes']:
        calls = [c for c in M['interfaces'] if c.get('label') == route['slug']]
        if calls:
            call = calls[-1]
            route['model_elapsed_s'] = call.get('elapsed_s')
            route['model_http_status'] = call.get('http_status')
            response = call.get('response', {})
            route['actual_model'] = response.get('model') if isinstance(response, dict) else None
            route['usage'] = response.get('usage') if isinstance(response, dict) else None
    M['limitations'] = ['共同参考来自可信模板，不是AI图片；存在表面条纹和简化造型', '辅助单阶段analysis+parameters，非独立两步', '辅助Blender5.2与直接Blender3.4.1版本混杂', 'POST创建资产内部文本请求固定120秒，编排HTTP与三路模型请求240秒', '资产创建接口只暴露配置模型及usage，不暴露原始模型响应；不将配置模型冒充服务返回模型', '模型HTTP失败时若无usage则费用未知，不记为零', '技术校验通过不等于视觉合格']
    guard_environment()
    r=next(r for r in M['routes'] if r['slug']=='gpt6_direct')
    if r['status']!='待 Read 人工安全审查；尚未执行':
        if 'invalid syntax' in r.get('error', ''):
            r['security_review'] = {'agent_read_review': True, 'result': '完整Read：未见网络或非导出文件操作；第35行语法错误，未执行，未修复', 'sandbox_executed': False}
        M['fees']['hy4_usage_note'] = 'HY4服务返回tokens全为0；不代表免费或无消耗，计费无法据此核实'
        M['limitations'].append(M['fees']['hy4_usage_note'])
        save()
        print('已更新最终报告；直接路线首次语法失败，未执行或重试')
        return
    d=OUT/r['slug']
    source=(d/'generated.py').read_text()
    tree=ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node,(ast.Import,ast.ImportFrom)):
            modules=[a.name for a in node.names] if isinstance(node,ast.Import) else [node.module]
            if any(m not in ('bpy','math','mathutils','os','random') for m in modules):
                raise ValueError('脚本导入超出白名单')
        if isinstance(node,ast.Name) and node.id in ('exec','eval','open','compile','__import__'):
            raise ValueError('危险操作被拒绝')
    r['security_review']={'agent_read_review':True,'sha256':hashlib.sha256(source.encode()).hexdigest(),'isolation':'run_docker_script.py；无宿主回退'}
    r['status']='直接脚本已提交执行；禁止重试'
    save()
    try:
        target=ROOT/'outputs/docker-sandbox'/('schoolgirl-'+str(time.time_ns()))/'output.glb'
        r['sandbox_output']=str(target)
        run([PY,str(ROOT/'scripts/blender/run_docker_script.py'),'--script',str(d/'generated.py'),'--output',str(target),'--timeout','240'],d/'sandbox.log',timeout=300)
        deliver(r,target)
    except Exception as exc:
        r['status']='失败；未重试'
        r['error']=str(exc)
    finally:
        save()
        print(r['name']+'：'+r['status'],flush=True)


def execute_mechanical_fix():
    started = time.monotonic()
    M.update(json.loads((OUT/'manifest.json').read_text()))
    r = next(x for x in M['routes'] if x['slug'] == 'gpt6_direct')
    assert r['asset_id'] == 'chr_schoolgirl_gpt6_109' and r['provider'] == 'gpt6_direct_script'
    if r.get('mechanical_fixes') or r.get('version'):
        raise RuntimeError('已有修复或导入记录，禁止盲目重复执行')
    others = json.dumps([x for x in M['routes'] if x is not r], sort_keys=True)
    other_hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for slug in ('hy4', 'gpt6_params') for p in (OUT/slug).rglob('*') if p.is_file()}
    d = OUT/r['slug']
    source = (d/'generated.py').read_text()
    before = '0. sixty if False else 0.63'
    after = '0.60 if False else 0.63'
    assert source.count(before) == 1
    corrected = source.replace(before, after)
    tree = ast.parse(corrected)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            modules = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module]
            assert all(m in ('bpy', 'math', 'mathutils', 'os', 'random') for m in modules)
        if isinstance(node, ast.Name):
            assert node.id not in ('exec', 'eval', 'open', 'compile', '__import__')
    for name, data in [('original.py', source), ('corrected.py', corrected)]:
        with (d/name).open('x') as stream:
            stream.write(data)
    r['previous_syntax_error'] = r.pop('error', None)
    r['mechanical_fixes'] = [{'classification': 'human mechanical fix', 'line': 35, 'before': before, 'after': after, 'reason': '明确数字拼写 sixty→60；保留 False 条件，运行值仍为0.63；无几何重写'}]
    r['fix_count'] = 1
    r['api_compatibility_fix_count'] = 0
    r['api_compatibility_fix_limit'] = 2
    r['security_review'] = {'agent_read_review': True, 'full_file_ast': 'passed', 'result': '完整291行审查：仅Blender建模、数学运算和指定GLB导出；os仅读取OUTPUT_GLB；无网络、子进程、动态执行或其他文件操作', 'original_sha256': hashlib.sha256(source.encode()).hexdigest(), 'corrected_sha256': hashlib.sha256(corrected.encode()).hexdigest(), 'isolation': 'run_docker_script.py；无网络、只读根、无权限、资源限制、仅任务目录挂载；无宿主执行或回退', 'sandbox_executed': False}
    r['continuation_policy'] = '不读key，不调用AI，不替换模型；仅目标资产导入与文件上传，不审批、不发布'
    r['runner_change'] = '仅允许corrected.py文件名；容器内仍复制为generated.py，隔离参数不变；不计入模型代码修复次数'
    save()
    try:
        guard_environment()
        initial = api('GET', prefix(r))
        r['latest_before'] = initial['latest']
        target = ROOT/'outputs/docker-sandbox'/('schoolgirl-mechanical-'+str(time.time_ns()))/'output.glb'
        r['sandbox_output'] = str(target)
        t = time.monotonic()
        r['sandbox_attempts'] = 1
        r['security_review']['sandbox_executed'] = True
        save()
        try:
            run([PY, str(ROOT/'scripts/blender/run_docker_script.py'), '--script', str(d/'corrected.py'), '--output', str(target), '--timeout', '240'], d/'sandbox-mechanical.log', timeout=300)
        finally:
            r['sandbox_elapsed_s'] = round(time.monotonic()-t, 3)
            log = (d/'sandbox-mechanical.log').read_text()
            report, _ = json.JSONDecoder().raw_decode(log[log.index('{'):])
            r['sandbox_report'] = report
            r['actual_blender_version'] = report['blender_version']
        t = time.monotonic()
        deliver(r, target)
        r['delivery_elapsed_s'] = round(time.monotonic()-t, 3)
        checks = []
        for key, view in [('preview.png', 'front'), ('qa/qa_front.png', 'front'), ('qa/qa_side.png', 'side'), ('qa/qa_back.png', 'back')]:
            response = requests.get(WEB+prefix(r)+'/file/versions/'+r['version']+'/'+key, headers=_auth_headers(WEB), timeout=60, allow_redirects=False)
            response.raise_for_status()
            digest = hashlib.sha256(response.content).hexdigest()
            assert digest == hashlib.sha256((d/(view+'.png')).read_bytes()).hexdigest()
            checks.append({'file': key, 'http_status': response.status_code, 'sha256': digest, 'matches_local': True})
        r['preview_qa_verification'] = checks
        latest = r['final_asset']['latest']
        assert all(latest.get(k) == initial['latest'].get(k) for k in ('approved', 'published'))
        r['approved_published_unchanged'] = True
        r['status'] = 'human mechanical fix 后隔离执行成功；已导入与上传真实预览QA；未审批未发布，视觉待验收'
    except Exception as exc:
        r['status'] = '机械修复续行失败；停止，未自动重试'
        r['error'] = str(exc)
        raise
    finally:
        r['continuation_elapsed_s'] = round(time.monotonic()-started, 3)
        r['other_routes_unchanged'] = others == json.dumps([x for x in M['routes'] if x is not r], sort_keys=True) and all(hashlib.sha256(Path(p).read_bytes()).hexdigest() == h for p, h in other_hashes.items())
        save()
        print(json.dumps({k: r.get(k) for k in ('status', 'error', 'version', 'glb', 'actual_blender_version', 'fix_count', 'sandbox_elapsed_s', 'delivery_elapsed_s', 'continuation_elapsed_s', 'other_routes_unchanged')}, ensure_ascii=False), flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--execute-reviewed',action='store_true')
    p.add_argument('--resume-before-model',action='store_true')
    p.add_argument('--execute-mechanical-fix', action='store_true')
    args=p.parse_args()
    if args.execute_mechanical_fix:
        execute_mechanical_fix()
    else:
        execute_reviewed() if args.execute_reviewed else generate(args.resume_before_model)
