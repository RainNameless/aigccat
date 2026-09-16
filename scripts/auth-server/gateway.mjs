import http from 'node:http';
import {isIP} from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAuthServer} from './server.mjs';
const equal=(a,b)=>typeof a==='string'&&!!b&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
function localHost(host){return host==='localhost'||host==='[::1]'||isIP(host)===4&&(/^127\./.test(host)||/^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host));}
export async function createGateway({dir,proxyToken,automationToken,upstream,publicOrigin='https://<your-domain>',bootstrap}){
 if(!proxyToken||!automationToken)throw Error('Gateway credentials are required');
 const auth=await createAuthServer({dir,origin:publicOrigin,proxyToken,bootstrap,trustedOrigins:true});
 await new Promise(r=>auth.listen(0,'127.0.0.1',r));
 const authBase='http://127.0.0.1:'+auth.address().port;
 const publicURL=new URL(publicOrigin),target=new URL(upstream);
 const publicFiles=new Set(['/login.html','/login.js','/auth.css','/shell.css','/favicon.ico']);
 const json=(res,status,error)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'});res.end(JSON.stringify({error}));};
 const gateway=http.createServer(async(req,res)=>{
  try{
   // The public origin is trusted only when supplied by our authenticated SSH gateway.
   const host=String(req.headers.host||'');let location;try{location=new URL('http://'+host);}catch{return json(res,400,'地址无效');}
   if(location.host!==host||location.username||location.password)return json(res,400,'地址无效');
   const remote=host===publicURL.host;
   if(remote&&!equal(req.headers['x-aigccat-auth-proxy'],proxyToken))return json(res,403,'请通过本站入口访问');
   if(!remote&&!localHost(location.hostname))return json(res,403,'不支持此访问地址');
   const origin=remote?publicOrigin:location.origin;
   if(!req.url.startsWith('/')||req.url.startsWith('//'))return json(res,400,'路径无效');
   const url=new URL(req.url,origin);let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return json(res,400,'路径无效');}
   if(pathname.includes('\\')||pathname.includes('//')||pathname.split('/').includes('..'))return json(res,400,'路径无效');
   if(pathname.startsWith('/internal/')||pathname==='/_aigccat_auth')return json(res,404,'接口不存在');
   const authRoute=pathname.startsWith('/api/auth/')||pathname.startsWith('/api/admin/');
   const machine=!remote&&equal(req.headers.authorization,'Bearer '+automationToken)&&(!req.headers.origin||req.headers.origin===origin);
   const headers={...req.headers};
   for(const name of Object.keys(headers))if(name.startsWith('x-aigccat-')||name.startsWith('x-original-')||name.startsWith('x-forwarded-')||name==='x-real-ip')delete headers[name];
   const authHeaders={'x-aigccat-auth-proxy':proxyToken,'x-aigccat-origin':origin,'x-real-ip':remote?String(req.headers['x-real-ip']||''):req.socket.remoteAddress||'',cookie:req.headers.cookie||''};
   if(!authRoute&&!publicFiles.has(pathname)&&!machine){
    const check=await fetch(authBase+'/internal/check',{headers:{...authHeaders,'x-original-uri':req.url,'x-original-method':req.method,'x-original-origin':req.headers.origin||''},signal:AbortSignal.timeout(10000)});
    await check.arrayBuffer();
    if(!check.ok){
     if(check.status===401&&!pathname.startsWith('/api/')){res.writeHead(302,{Location:'/login.html?next='+encodeURIComponent(req.url),'Cache-Control':'private, no-store'});res.end();return;}
     return json(res,check.status,check.status===401?'请先登录':check.status===403?'没有权限执行此操作':'账号服务暂时不可用');
    }
   }
   const destination=authRoute?new URL(authBase):target;
   if(authRoute)Object.assign(headers,authHeaders);
   else{
    delete headers.authorization;delete headers.cookie;
    if(headers.origin===origin)headers.origin='http://'+host;
   }
   delete headers.connection;delete headers['proxy-authorization'];
   const outgoing=http.request({hostname:destination.hostname,port:destination.port,method:req.method,path:req.url,headers,timeout:600000},incoming=>{
    const h={...incoming.headers,'cache-control':'private, no-store','x-content-type-options':'nosniff'};delete h.connection;
    res.writeHead(incoming.statusCode,h);incoming.pipe(res);
    incoming.on('error',()=>res.destroy());
   });
   outgoing.on('timeout',()=>outgoing.destroy());outgoing.on('error',()=>{if(!res.headersSent)json(res,502,'工作台暂时不可达，请稍后重试');else res.destroy();});
   req.on('aborted',()=>outgoing.destroy());res.on('close',()=>{if(!res.writableEnded)outgoing.destroy();});req.pipe(outgoing);
  }catch{if(!res.headersSent)json(res,503,'账号服务暂时不可用，请稍后重试');else res.destroy();}
 });
 gateway.on('close',()=>auth.close());gateway.requestTimeout=600000;
 return gateway;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const secrets=process.env.AUTH_SECRETS_DIR||'/secrets',dir=process.env.AUTH_DATA_DIR||'/data';
 const gateway=await createGateway({dir,proxyToken:fs.readFileSync(path.join(secrets,'proxy.token'),'utf8').trim(),automationToken:fs.readFileSync(path.join(secrets,'automation.token'),'utf8').trim(),upstream:process.env.APP_UPSTREAM||'http://web:8080'});
 gateway.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('aigccat unified login gateway ready'));
}
