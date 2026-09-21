import http from 'node:http';
import net from 'node:net';
import {isIP} from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAuthServer} from './server.mjs';
const equal=(a,b)=>typeof a==='string'&&!!b&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
function localHost(host){return host==='localhost'||host==='[::1]'||isIP(host)===4&&(/^127\./.test(host)||/^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host));}
// 公开 Origin 的默认值必须是「合法的 URL」，否则 new URL() 会直接抛错把进程带崩。
// 选定 .invalid（RFC 2606 保留域名）：永远不会等于任何真实请求的 Host，
// 于是默认状态下 remote 分支恒为 false —— 公开入口关闭，本地/内网访问照常。
const DEFAULT_PUBLIC_ORIGIN='http://aigccat.invalid';
function normalizeOrigin(v){
 if(!v)return DEFAULT_PUBLIC_ORIGIN;
 try{const u=new URL(v);if(u.protocol!=='http:'&&u.protocol!=='https:')throw Error('must be http(s)');return u.origin;}catch(e){console.warn(`[gateway] AUTH_ORIGIN 不是合法的 http(s) 地址，已忽略：${v}（${e.message}）`);return DEFAULT_PUBLIC_ORIGIN;}
}
export async function createGateway({dir,proxyToken,automationToken,upstream,publicOrigin=DEFAULT_PUBLIC_ORIGIN,bootstrap,novnc}){
 if(!proxyToken||!automationToken)throw Error('Gateway credentials are required');
 publicOrigin=normalizeOrigin(publicOrigin);
 const auth=await createAuthServer({dir,origin:publicOrigin,proxyToken,bootstrap,trustedOrigins:true});
 await new Promise(r=>auth.listen(0,'127.0.0.1',r));
 const authBase='http://127.0.0.1:'+auth.address().port;
 const publicURL=new URL(publicOrigin),target=new URL(upstream);
 // 登录画面（noVNC）的转发目标。它只监听容器内回环，靠这里转发出去 ——
 // 于是「看登录窗口」不用再对外多开一个端口，也天然受现有登录鉴权保护。
 const vncTarget=new URL(novnc||process.env.NOVNC_UPSTREAM||'http://127.0.0.1:6081');
 const VNC_PREFIX='/studio/vnc';
 const publicFiles=new Set(['/login.html','/login.js','/auth.css','/shell.css','/favicon.ico']);
 // HOTFIX(public-static): 前端静态资源不参与登录校验。
 // 它们的内容与开源仓库中的代码一致、不含任何用户数据；放开后 Cloudflare 才能按 URL
 // 缓存它们（否则匿名请求被 302 到登录页，一旦缓存就是对所有人发登录页）。
 // 数据类路径（/api/*、示例图、HTML、模型）仍然要求登录。
 const HOTFIX_STATIC=/\.(?:js|mjs|css|woff2?|ttf|eot|svg|ico|wasm)$/i;
 // HOTFIX_PUBLIC_DIRS: 应用自带的示例图目录（对所有人同一份字节，可进 CDN）。
 // 只认目录前缀，**不按 .png 扩展名放开** —— 用户资产的预览图也是 .png，那是数据。
 const HOTFIX_PUBLIC_DIRS=['/creative-examples/'];
 const isPublicPath=p=>publicFiles.has(p)||HOTFIX_STATIC.test(p)
   ||HOTFIX_PUBLIC_DIRS.some(d=>p.startsWith(d));
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
   if(!authRoute&&!isPublicPath(pathname)&&!machine){
    const check=await fetch(authBase+'/internal/check',{headers:{...authHeaders,'x-original-uri':req.url,'x-original-method':req.method,'x-original-origin':req.headers.origin||''},signal:AbortSignal.timeout(10000)});
    await check.arrayBuffer();
    if(!check.ok){
     if(check.status===401&&!pathname.startsWith('/api/')){res.writeHead(302,{Location:'/login.html?next='+encodeURIComponent(req.url),'Cache-Control':'private, no-store'});res.end();return;}
     return json(res,check.status,check.status===401?'请先登录':check.status===403?'没有权限执行此操作':'账号服务暂时不可用');
    }
   }
   const destination=authRoute?new URL(authBase):pathname.startsWith(VNC_PREFIX)?vncTarget:target;
   // 转发到 noVNC 时要剥掉前缀：/studio/vnc/vnc.html → /vnc.html
   const destPath=(pathname.startsWith(VNC_PREFIX)&&!authRoute)?(req.url.slice(VNC_PREFIX.length)||'/'):req.url;
   if(authRoute)Object.assign(headers,authHeaders);
   else{
    delete headers.authorization;delete headers.cookie;
    if(headers.origin===origin)headers.origin='http://'+host;
   }
   delete headers.connection;delete headers['proxy-authorization'];
   const outgoing=http.request({hostname:destination.hostname,port:destination.port,method:req.method,path:destPath,headers,timeout:600000},incoming=>{
    const h={...incoming.headers,'cache-control':'private, no-store','x-content-type-options':'nosniff'};delete h.connection;
    res.writeHead(incoming.statusCode,h);incoming.pipe(res);
    incoming.on('error',()=>res.destroy());
   });
   outgoing.on('timeout',()=>outgoing.destroy());outgoing.on('error',()=>{if(!res.headersSent)json(res,502,'工作台暂时不可达，请稍后重试');else res.destroy();});
   req.on('aborted',()=>outgoing.destroy());res.on('close',()=>{if(!res.writableEnded)outgoing.destroy();});req.pipe(outgoing);
  }catch{if(!res.headersSent)json(res,503,'账号服务暂时不可用，请稍后重试');else res.destroy();}
 });
 // ── WebSocket：noVNC 的画面通道 ──
 // 只用 node 自带的 net 做字节中继，不引入 ws 依赖：
 // 握手请求原样转发给 websockify，之后两个方向直接对拷。
 gateway.on('upgrade',async(req,socket,head)=>{
  try{
   const host=String(req.headers.host||'');let location;try{location=new URL('http://'+host);}catch{return socket.destroy();}
   if(location.host!==host||location.username||location.password)return socket.destroy();
   const remote=host===publicURL.host;
   if(remote&&!equal(req.headers['x-aigccat-auth-proxy'],proxyToken))return socket.destroy();
   if(!remote&&!localHost(location.hostname))return socket.destroy();
   if(!String(req.url||'').startsWith(VNC_PREFIX+'/'))return socket.destroy();
   // 归一化路径：noVNC 各版本拼接 websocket 地址的方式不完全一致（可能拼出重复前缀），
   // 一律从最后一个 /studio/vnc/ 处截断，避免因为版本差异整条链路失效。
   const wsPath=String(req.url).slice(String(req.url).lastIndexOf(VNC_PREFIX+'/'));
   const origin=remote?publicOrigin:location.origin;
   // 与普通请求同一套判定：持机器令牌的自动化调用免登录，其余一律要过鉴权
   const machine=!remote&&equal(req.headers.authorization,'Bearer '+automationToken)&&(!req.headers.origin||req.headers.origin===origin);
   if(!machine){
    const checkHeaders={'x-aigccat-auth-proxy':proxyToken,'x-aigccat-origin':origin,
     'x-real-ip':remote?String(req.headers['x-real-ip']||''):req.socket.remoteAddress||'',
     cookie:req.headers.cookie||'',
     'x-original-uri':req.url,'x-original-method':'GET','x-original-origin':req.headers.origin||''};
    const check=await fetch(authBase+'/internal/check',{headers:checkHeaders,signal:AbortSignal.timeout(10000)});
    await check.arrayBuffer();
    if(!check.ok)return socket.destroy();
   }
   const upstreamSocket=net.connect(Number(vncTarget.port)||80,vncTarget.hostname,()=>{
    let raw=req.method+' '+wsPath+' HTTP/1.1\r\n';
    for(let i=0;i<req.rawHeaders.length;i+=2)raw+=req.rawHeaders[i]+': '+req.rawHeaders[i+1]+'\r\n';
    upstreamSocket.write(raw+'\r\n');
    if(head&&head.length)upstreamSocket.write(head);
    socket.pipe(upstreamSocket);upstreamSocket.pipe(socket);
   });
   upstreamSocket.on('error',()=>socket.destroy());
   socket.on('error',()=>upstreamSocket.destroy());
  }catch{socket.destroy();}
 });
 gateway.on('close',()=>auth.close());gateway.requestTimeout=600000;
 return gateway;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const secrets=process.env.AUTH_SECRETS_DIR||'/secrets',dir=process.env.AUTH_DATA_DIR||'/data';
 // 公开 Origin（HTTPS 反代部署时设置）与首次启动的初始账号。
 // 初始账号由 supervisor 传入（默认 admin / aigccat，可用 AIGCCAT_ADMIN_USER /
 // AIGCCAT_ADMIN_PASSWORD 覆盖）；两者都不设时行为与之前完全一致（账号库为空才建号）。
 const publicOrigin=process.env.AUTH_ORIGIN||undefined;
 const u=process.env.AUTH_BOOTSTRAP_USER,p=process.env.AUTH_BOOTSTRAP_PASSWORD;
 const bootstrap=u&&p?{username:u,password:p}:undefined;
 const gateway=await createGateway({dir,proxyToken:fs.readFileSync(path.join(secrets,'proxy.token'),'utf8').trim(),automationToken:fs.readFileSync(path.join(secrets,'automation.token'),'utf8').trim(),upstream:process.env.APP_UPSTREAM||'http://web:8080',publicOrigin,bootstrap});
 gateway.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('aigccat unified login gateway ready'));
}
