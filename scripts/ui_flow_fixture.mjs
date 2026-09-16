// Isolated browser-flow fixture. Mutations stay in memory; only image GETs use localhost:8080.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const machineToken=(await fs.readFile(path.join(os.homedir(),'.config/aigccat/auth/secrets/automation.token'),'utf8')).trim();
const root = path.resolve(import.meta.dirname, '../web/static');
const failImages = process.argv.includes('--fail-images');
let state = {}, asset = null, spec = {}, jobs = [], files = new Set(), calls = [];
const imageSource = 'http://localhost:8080/api/assets/characters/chr_function_110/file/source/reference_front.png';
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), p = url.pathname;
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const send = data => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
    if (p === '/qa/calls') return send(calls);
    if (p.startsWith('/api/')) {
      if(req.method !== 'GET') calls.push({method:req.method,path:p,body:{...body,bytes_b64:body.bytes_b64 ? '[image]' : undefined}});
      if(p === '/api/auth/me') return send({user:{username:'fixture',display_name:'隔离测试',role:'admin'}});
      if(p === '/api/settings/services') return send({blender:{reachable:true},image:{model:'fixture'}});
      if(p === '/api/workbench/state') {if(req.method==='PUT') state={...state,...body};return send(state);}
      if(p === '/api/assets') {
        if(req.method==='POST') {await new Promise(resolve=>setTimeout(resolve,2000));spec={description:body.description};asset={asset_id:'prop_qa_flow',asset_type:'prop',name:'流程测试图片',status:'spec_ready'};return send({asset_id:asset.asset_id});}
        return send({assets:asset?[asset]:[]});
      }
      if(p === '/api/media/images') return send({images:[...files].map(file=>({asset:'props/prop_qa_flow',path:file,kind:file.includes('/images/')?'generated':file.includes('/uploads/')?'uploaded':'reference'}))});
      if(p === '/api/assets/props/prop_qa_flow') return send({asset,spec,latest:{latest:asset?.version},jobs:jobs.map(j=>j.job_id+'.json')});
      if(p.endsWith('/spec') && req.method==='PUT') {spec=body.spec;return send({ok:true});}
      if(p.endsWith('/references/approve') || p.endsWith('/plan')) return send({ok:true});
      if(p.endsWith('/model') && req.method==='POST') {
        asset.version='v001';asset.status='model_review';
        const job_id='job_model';jobs.push({job_id,kind:'model_generate',status:'done',version:'v001'});
        return send({job_id});
      }
      if(p.endsWith('/history')) return send({nodes:[],head:null});
      if(p.endsWith('/images') && req.method==='POST') {
        const job_id='job_'+(jobs.length+1);
        jobs.push({job_id,kind:'image_generate',status:'running',images:[],progress:{percent:0},started:Date.now()});
        return send({job_id,status:'running'});
      }
      if(p.includes('/jobs/')) {
        const job=jobs.find(j=>j.job_id===p.split('/').at(-1));
        if(!job) {res.statusCode=404;return send({error:'Missing job'});}
        if(job.kind==='model_generate') return send(job);
        const elapsed=Date.now()-job.started;
        job.images=elapsed>2500?[`source/images/${job.job_id}_0.png`]:[];
        if(elapsed>7000) {
          if(failImages) {job.status='failed';job.error='provider_capacity: 供应商没有可用的兼容账号（HTTP 503）';}
          else {job.images.push(`source/images/${job.job_id}_1.png`);job.status='done';}
        }
        asset.generation={...job};
        job.images.forEach(f=>files.add(f));job.progress.percent=job.status==='done'?100:job.images.length?50:0;
        return send(job);
      }
      if(p.includes('/file/')) {
        const key=p.split('/file/')[1];
        if(req.method==='PUT') {files.add(key);return send({ok:true});}
        const model=key.endsWith('.glb');
        const r=await fetch(model?'http://localhost:8080/api/assets/characters/chr_function_110/file/versions/v003/model.glb':imageSource,{headers:{Authorization:'Bearer '+machineToken},redirect:'error'});
        res.setHeader('Content-Type',model?'model/gltf-binary':'image/png');return res.end(Buffer.from(await r.arrayBuffer()));
      }
      res.statusCode=400;return send({error:'Unimplemented fixture endpoint: '+p});
    }
    const file=path.resolve(root,'.'+(p==='/'?'/index.html':p));
    if(!file.startsWith(root+path.sep)) {res.statusCode=403;return res.end();}
    res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');
    res.end(await fs.readFile(file));
  } catch(error) {res.statusCode=500;res.end(String(error));}
});
server.listen(8082,'127.0.0.1',()=>console.log('Isolated UI fixture: http://127.0.0.1:8082'));
