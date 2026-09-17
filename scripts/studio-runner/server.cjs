// Studio subscription transport. 平时不带任何浏览器进程；只有在接入/重新连接会话时
// 才按需拉起一个有界面的浏览器窗口（见 /session/* 路由与 session.cjs）。
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {client,payload,ROOT}=require('./client.cjs');
const {normalize}=require('./normalize.cjs');
const {preview}=require('./preview.cjs');
const {exportGenerated}=require('./export-generated.cjs');
const {processModel,validateProcess}=require('./process.cjs');
const {startLogin,finishLogin,cancelLogin,loginState}=require('./session.cjs');
const DIR=path.join(ROOT,'.ai/browser-state/studio-jobs');
const SECRET=path.join(ROOT,'.ai/browser-state/studio-runner-token');
const valid=s=>/^[a-zA-Z0-9_-]{1,200}$/.test(s);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let active=null;
async function read(id){return JSON.parse(await fs.readFile(path.join(DIR,id,'job.json'),'utf8'));}
async function save(id,p){const old=await read(id).catch(()=>({id})),record={...old,...p};const file=path.join(DIR,id,'job.json');await fs.writeFile(file+'.tmp',JSON.stringify(record),{mode:0o600});await fs.rename(file+'.tmp',file);return record;}
async function execute(id,input,resume=false){
 let c;
 try{
  c=await client();let record=await read(id);
  if(input?.request?.operation || record.process_request){
   const raw=await processModel(c,id,input,read,save),bytes=await normalize(raw);
   await fs.writeFile(path.join(DIR,id,'model.glb'),bytes);
   let previewWarning=null;try{await fs.writeFile(path.join(DIR,id,'preview.png'),await preview(bytes));}catch{previewWarning='缩略图未生成，可在模型画布保存';}
   const account=await c.call('/v2/studio/user/profile/payment');
   await save(id,{status:'done',stage:'done',phase:'处理完成',percent:100,bytes:bytes.length,credits_after:account.wallet?.total_credit,finished_at:Date.now(),preview_warning:previewWarning,error:null});return;
  }
  if(!resume){
   await save(id,{stage:'uploading',phase:'上传参考图',percent:2});
   const images={};for(const [view,value] of Object.entries(input.images||{}))images[view]=await c.upload(Buffer.from(value,'base64'));
   const p=payload(input.request,images);
   const account=await c.call('/v2/studio/user/profile/payment');
   await save(id,{texture_size:input.request.texture?input.request.texture_size:null,stage:'submitting',phase:'提交 Studio 生成',percent:5,credits_before:account.wallet?.total_credit,submitted_at:Date.now(),request:p.body});
   const result=await c.call(p.route,p.body);
   // IDs are persisted before polling. No automatic repeat of the paid POST.
   if(!valid(result.project_id)||!valid(result.operator_id))throw Error('Studio 未返回项目或任务编号，请核对原任务');
   record=await save(id,{project_id:result.project_id,operator_id:result.operator_id,stage:'polling',phase:'Studio 生成中'});
  }
  const deadline=Date.now()+30*60*1000;
  while(Date.now()<deadline){
   const progress=await c.call('/v2/studio/progress',{ids:[record.operator_id]});
   const task=Array.isArray(progress)?progress.find(t=>t.operator_id===record.operator_id):null;
   if(!task)throw Error('Studio 未返回原任务状态');
   if(['failed','cancelled','banned','expired'].includes(task.status)){await save(id,{status:'failed',error:`Studio 任务${task.status}`,finished_at:Date.now()});return;}
   if(task.status==='success'){
    await save(id,{stage:'downloading',phase:'下载并校验 GLB',percent:95,generated_at:Date.now()});
    const detail=await c.call(`/v2/studio/project/detail/v3/${record.project_id}?operator_id=${record.operator_id}`);
    if(detail.operator?.operator_id!==record.operator_id)throw Error('返回版本与任务编号不一致');
    const raw=await exportGenerated(c,id,await read(id),save)||await c.model(detail.operator.model_url||detail.model_url);
    const bytes=await normalize(raw);
    const dest=path.join(DIR,id,'model.glb');await fs.writeFile(dest+'.tmp',bytes);await fs.rename(dest+'.tmp',dest);
    let previewWarning=null;try{await fs.writeFile(path.join(DIR,id,'preview.png'),await preview(bytes));}catch{previewWarning='模型已保存，自动缩略图失败；打开模型后可补存';}
    const wallet=await c.call('/v2/studio/user/profile/payment').catch(()=>null);
    await save(id,{status:'done',stage:'done',phase:'模型已下载',percent:100,bytes:bytes.length,finished_at:Date.now(),credits_after:wallet?.wallet?.total_credit,preview_warning:previewWarning,error:null});return;
   }
   await save(id,{stage:'polling',phase:task.status==='queued'?'Studio 排队中':'Studio 生成中',percent:Math.max(5,Math.min(94,Number(task.progress)||5)),last_checked_at:Date.now()});
   await sleep(3000);
  }
  throw Error('Studio 等待超过30分钟，请查询原任务');
 }catch(e){let r=await read(id);await save(id,{status:e.confirmed?'failed':r.operator_id?'waiting':r.stage==='submitting'&&!e.confirmed?'unknown':'failed',error:String(e.message).replace(/https?:\/\/\S+/g,'[链接]').slice(0,500),finished_at:Date.now()});}
 finally{await c?.close();active=null;}
}
async function main(){
 await fs.mkdir(DIR,{recursive:true,mode:0o700});const token=(await fs.readFile(SECRET,'utf8')).trim();
 // Interrupted jobs never resubmit themselves.
 for(const id of await fs.readdir(DIR)){if(!valid(id))continue;let r=await read(id).catch(()=>null);if(r?.status==='running')await save(id,{status:r.operator_id?'waiting':'unknown',error:'执行器已重启，请查询原任务'});}
 const server=http.createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  const supplied=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);
  if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return send(401,{error:'unauthorized'});
  let reserved=false;
  try{
   const parts=new URL(req.url,'http://localhost').pathname.split('/').filter(Boolean);
   if(req.method==='GET'&&parts[0]==='health'){
    let c;try{c=await client();const a=await c.call('/v2/studio/user/profile/payment');send(200,{ready:true,mode:'session-http',credits:a.wallet?.total_credit,active});}finally{await c?.close();}return;
   }
   // 会话接入：让界面能「点一下打开登录窗口 → 用户登录 → 点我已登录 → 抓 cookie」。
   // 只有按需时才拉起浏览器；平时这个服务不带任何浏览器进程。
   if(parts[0]==='session'){
    if(req.method==='GET'&&parts.length===1)return send(200,loginState());
    if(req.method!=='POST')return send(405,{error:'method'});
    try{
     if(parts[1]==='start')return send(200,await startLogin());
     if(parts[1]==='finish')return send(200,{ok:true,...(await finishLogin())});
     if(parts[1]==='cancel')return send(200,await cancelLogin());
     return send(404,{error:'not found'});
    }catch(e){return send(e.code===409?409:400,{error:String(e.message).replace(/https?:\/\/\S+/g,'[链接]').slice(0,300)});}
   }
   const id=parts[1];if(parts[0]!=='jobs'||!valid(id))return send(404,{error:'not found'});
   if(req.method==='GET'){
    const r=await read(id);if(parts[2]==='model'||parts[2]==='preview'){if(r.status!=='done')return send(409,{error:'model not ready'});const b=await fs.readFile(path.join(DIR,id,parts[2]==='preview'?'preview.png':'model.glb'));res.writeHead(200,{'Content-Type':parts[2]==='preview'?'image/png':'model/gltf-binary','Content-Length':b.length});res.end(b);}else send(200,r);return;
   }
   if(req.method!=='POST')return send(405,{error:'method'});
   if(parts[2]==='resume'){
    const r=await read(id);if(r.status==='done'||r.status==='running')return send(200,r);
    if(!r.operator_id||r.status==='failed')return send(409,{error:'没有可恢复的原任务，不能自动重新生成'});
    if(active)return send(409,{error:'执行器忙'});active=id;reserved=true;await save(id,{status:'running',error:null});send(202,{id,status:'running'});void execute(id,null,true);return;
   }
   let size=0,chunks=[];for await(const b of req){size+=b.length;if(size>210*1024*1024){send(413,{error:'too large'});req.destroy();return;}chunks.push(b);}
   const input=JSON.parse(Buffer.concat(chunks));
   const fingerprint=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
   const existing=await read(id).catch(()=>null);if(existing)return send(existing.fingerprint===fingerprint?200:409,existing.fingerprint===fingerprint?existing:{error:'任务编号已用于其他输入'});
   if(active)return send(409,{error:'已有 Studio 任务运行中'});
   if(input.request?.operation)validateProcess(input);else payload(input.request,Object.fromEntries(Object.keys(input.images||{}).map(k=>[k,{placeholder:true}])));
   active=id;reserved=true;
   await fs.mkdir(path.join(DIR,id),{recursive:true,mode:0o700});await save(id,{status:'running',stage:'prepared',phase:'准备 Studio 任务',percent:0,started_at:Date.now(),fingerprint});
   send(202,{id,status:'running'});void execute(id,input);
  }catch(e){if(reserved)active=null;send(e.code==='ENOENT'?404:400,{error:String(e.message).replace(/https?:\/\/\S+/g,'[链接]').slice(0,400)});}
 });
 server.listen(8790,'0.0.0.0',()=>console.log('Studio session worker listening on 8790; no browser'));
}
main().catch(()=>{console.error('Studio worker initialization failed');process.exit(1);});
