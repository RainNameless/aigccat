const {request}=require('playwright');
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const path=require('node:path');
const ROOT=process.env.STUDIO_ROOT||path.resolve(__dirname,'../..');
const SESSION=process.env.STUDIO_SESSION_FILE||path.join(ROOT,'.ai/browser-state/studio-session.auth.json');
const PROXY=process.env.STUDIO_PROXY||'http://127.0.0.1:7897';
class StudioError extends Error { constructor(message,confirmed=false){super(message);this.confirmed=confirmed;} }
async function client(){
 const session=JSON.parse(await fs.readFile(SESSION,'utf8').catch(()=>{throw new StudioError('Studio 登录会话未连接',true)}));
 let auth=session.headers?.authorization||'';let tokenExpires=0;
 const options={proxy:PROXY?{server:PROXY}:undefined,timeout:120000};
 const cookieClient=await request.newContext({...options,storageState:{cookies:(session.storageState?.cookies||[]).filter(c=>c.domain==='tripo3d.ai'||c.domain.endsWith('.tripo3d.ai')),origins:[]}});
 const api=await request.newContext({...options,extraHTTPHeaders:{origin:'https://studio.tripo3d.ai',referer:'https://studio.tripo3d.ai/'}});
 const download=await request.newContext(options);
 async function refresh(){
  if(tokenExpires>Date.now()+60000)return;
  let response;try{response=await cookieClient.get('https://api.tripo3d.ai/v2/studio/studio/whoami?tokenizeAs=default_jwt',{maxRetries:0,maxRedirects:0});}catch{throw new StudioError('登录会话刷新连接失败，未提交生成',true);}
  const v=await response.json().catch(()=>({}));
  if(!response.ok()||!v.tokenized)throw new StudioError('Studio 登录已失效，请重新连接会话',true);
  auth='Bearer '+v.tokenized;
  try{tokenExpires=JSON.parse(Buffer.from(v.tokenized.split('.')[1],'base64url')).exp*1000;}catch{tokenExpires=Date.now()+60000;}
 }
 async function callOnce(route,body){
  await refresh();
  let r;try{r=await api.fetch('https://api.tripo3d.ai'+route,{method:body===undefined?'GET':'POST',headers:{authorization:auth},data:body,maxRetries:0,maxRedirects:0});}catch{throw new StudioError('Studio 网络连接中断；不会自动重发生成请求');}
  let j;try{j=await r.json();}catch{throw new StudioError(`Studio HTTP ${r.status()}，${r.status()>=500?'上游服务暂不可用':'响应格式异常'}`,r.status()>=400&&r.status()<500);}
  if(!r.ok()||j.code!==0){let message=String(j.message||'请求失败').replaceAll(auth,'[hidden]').replace(/https?:\/\/\S+/g,'[链接]').slice(0,300);throw new StudioError(`Studio HTTP ${r.status()} / ${j.code}：${message}`,r.status()<500);}
  return j.data;
 }
 async function call(route,body){
  const readOnly=body===undefined||route==='/v2/studio/progress'||route==='/v2/studio/storage/temporary_token';
  for(let attempt=0;;attempt++)try{return await callOnce(route,body);}catch(e){
   if(!readOnly||e.confirmed||attempt>=2||!(/网络|HTTP 50[234]/.test(e.message)))throw e;
   await new Promise(r=>setTimeout(r,500*(attempt+1)));
  }
 }
 async function upload(bytes,format='png'){
  if(!['png','glb'].includes(format))throw new StudioError('上传格式不支持',true);
  const t=await call('/v2/studio/storage/temporary_token',{client:'aws',format});
  const host=`${t.resource_bucket}.s3-accelerate.amazonaws.com`;
  if(!/^[a-z0-9.-]+$/.test(t.resource_bucket))throw new StudioError('上传存储桶无效',true);
  const uri='/'+t.resource_uri.split('/').map(encodeURIComponent).join('/');
  const stamp=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),day=stamp.slice(0,8);
  const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
  const hmac=(k,x)=>crypto.createHmac('sha256',k).update(x).digest();
  const headers={'host':host,'x-amz-content-sha256':hash(bytes),'x-amz-date':stamp,'x-amz-security-token':t.session_token};
  const names=Object.keys(headers).sort(),signed=names.join(';'),canonical=names.map(k=>`${k}:${headers[k].trim()}\n`).join('');
  const scope=`${day}/us-west-2/s3/aws4_request`;
  const toSign=`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hash(`PUT\n${uri}\n\n${canonical}\n${signed}\n${hash(bytes)}`)}`;
  const signing=hmac(hmac(hmac(hmac('AWS4'+t.sts_sk,day),'us-west-2'),'s3'),'aws4_request');
  headers.authorization=`AWS4-HMAC-SHA256 Credential=${t.sts_ak}/${scope}, SignedHeaders=${signed}, Signature=${hmac(signing,toSign).toString('hex')}`;
  const r=await download.put(`https://${host}${uri}`,{headers,data:bytes,maxRetries:0,maxRedirects:0});
  if(!r.ok())throw new StudioError(`图片上传失败 HTTP ${r.status()}`,true);
  const image={bucket:t.resource_bucket,key:t.resource_uri};
  if(format==='glb')return image;
  const audit=await call('/v2/studio/audit/image',{image});
  if(audit.result!=='pass')throw new StudioError(`图片审核未通过：${audit.result}`,true);
  return {...image,image_audit_result:audit.result,image_source:'upload'};
 }
 async function model(url){
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||!['.tripo3d.ai','.tripo3d.com'].some(s=>u.hostname.endsWith(s)))throw new StudioError('模型下载域名不受信任',true);
  const r=await download.get(url,{maxRetries:0,maxRedirects:0});
  if(!r.ok())throw new StudioError(`模型下载失败 HTTP ${r.status()}`);
  const b=await r.body();
  if(b.length>150*1024*1024||b.length<20||b.toString('utf8',0,4)!=='glTF'||b.readUInt32LE(4)!==2||b.readUInt32LE(8)!==b.length)throw new StudioError('下载结果不是完整的 GLB 2 模型');
  return b;
 }
 return {call,upload,model,close:async()=>{await api.dispose();await download.dispose();await cookieClient.dispose();}};
}
function payload(input,images){
 const models=['v3.0-20250812','v3.1-20260211','v2.5-20250123'];
 if(!models.includes(input.model_id))throw new StudioError('请选择 Studio v3.0 / v3.1 / v2.5',true);
 if(!['text','single','multi'].includes(input.mode))throw new StudioError('无效输入模式',true);
 if(input.mode==='text'&&(!input.prompt?.trim()||[...input.prompt].length>1000))throw new StudioError('文字描述需 1–1000 字',true);
 const max={'v2.5-20250123':500000,'v3.0-20250812':1000000,'v3.1-20260211':2000000}[input.model_id];
 if(input.face_limit!=null&&(!Number.isInteger(input.face_limit)||input.face_limit<500||input.face_limit>max))throw new StudioError('目标面数超出当前模型范围',true);
 if(input.geometry_quality!=null&&(input.geometry_quality!=='detailed'||input.model_id!=='v3.1-20260211'))throw new StudioError('高精度几何需要v3.1',true);
 if(input.texture_quality!=null&&!['standard','extreme'].includes(input.texture_quality))throw new StudioError('贴图质量无效',true);
 if(input.texture_size!=null&&![2048,4096,8192].includes(input.texture_size))throw new StudioError('贴图尺寸无效',true);
 if(!input.texture&&(input.texture_quality!=null||input.texture_size!=null))throw new StudioError('请先开启生成纹理',true);
 const value={quad:!!input.quad,visibility:'shareable',model_version:input.model_id,generate_parts:false,smart_poly:false,texture:!!input.texture,delight:true,pbr:!!input.texture&&!!input.pbr,texture_alignment:'original_image',texture_quality:input.texture_quality||'standard'};
 if(input.face_limit!=null)value.face_limit=input.face_limit;
 if(input.geometry_quality)value.geometry_quality=input.geometry_quality;
 if(input.mode==='text')Object.assign(value,{prompt:input.prompt.trim(),gen_image_model_version:'flux.1_dev',sketch_to_render:false,t_pose:false});
 else if(input.mode==='single'){if(!images.front)throw new StudioError('缺少正面图片',true);value.image=images.front;}
 else{if(!images.front||Object.keys(images).length<2)throw new StudioError('多视图需要正面和另一个视角',true);value.image=['front','side','back','right'].map(k=>images[k]||null);}
 return {route:'/v2/studio/operation/'+({text:'text_to_model',single:'image_to_model',multi:'multiview_to_model'})[input.mode],body:value};
}
module.exports={client,payload,ROOT,StudioError};
