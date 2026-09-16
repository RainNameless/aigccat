import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const scrypt=promisify(crypto.scrypt), now=()=>Math.floor(Date.now()/1000);
export async function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const hash=await scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});return `scrypt:${salt}:${hash.toString('hex')}`;}
export async function verifyPassword(password,encoded){try{const [,salt,expected]=encoded.split(':');const hash=await scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});return crypto.timingSafeEqual(hash,Buffer.from(expected,'hex'));}catch{return false;}}
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const publicUser=u=>({id:u.id,username:u.username,display_name:u.display_name,role:u.role,enabled:u.enabled,created_at:u.created_at,last_login:u.last_login||null});
const username=s=>typeof s==='string'&&/^[a-zA-Z0-9_][a-zA-Z0-9_-]{2,31}$/.test(s);
const password=s=>typeof s==='string'&&s.length>=12&&s.length<=128;
function fail(code,message){throw Object.assign(new Error(message),{code});}
export async function createAuthServer({dir,origin,proxyToken,bootstrap,loginLimit=8,trustedOrigins=false}){
 if(!proxyToken||!origin)throw Error('Auth proxy token and origin are required');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,'accounts.json');
 let data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
 if(!data){if(!bootstrap||!username(bootstrap.username)||!password(bootstrap.password))throw Error('Valid initial administrator required');data={users:[{id:crypto.randomUUID(),username:bootstrap.username.toLowerCase(),display_name:'管理员',role:'admin',enabled:true,password_hash:await hashPassword(bootstrap.password),created_at:now()}],sessions:[],audit:[]};}
 function save(){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o600});fs.renameSync(tmp,file);fs.chmodSync(file,0o600);}
 save();const dummy=await hashPassword(crypto.randomBytes(24).toString('hex')),attempts=new Map();let hashing=0;
 const requestOrigin=req=>trustedOrigins?String(req.headers['x-aigccat-origin']||origin):origin;
 const cookieName=req=>requestOrigin(req).startsWith('https:')?'__Host-aigccat_session':'aigccat_session';
 const cookie=(req,token,remember=false)=>`${cookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Lax${requestOrigin(req).startsWith('https:')?'; Secure':''}${token?(remember?'; Max-Age=2592000':''):'; Max-Age=0'}`;
 function audit(action,actor,target,ip){data.audit.push({id:crypto.randomUUID(),time:now(),action,actor:actor?.username||'访客',target:target||'',ip:String(ip||'').slice(0,64)});data.audit=data.audit.slice(-500);}
 function clean(){data.sessions=data.sessions.filter(s=>s.expires>now());for(const [k,v]of attempts)if(v.until<=now())attempts.delete(k);}
 function session(req){const name=cookieName(req);const raw=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);if(!raw||raw.length!==64)return null;const s=data.sessions.find(s=>s.hash===digest(raw)&&s.expires>now()),u=s&&data.users.find(u=>u.id===s.user_id&&u.enabled);return u?{s,u}:null;}
 function actor(req,admin=false){const a=session(req);if(!a)fail(401,'请先登录');if(admin&&a.u.role!=='admin')fail(403,'需要管理员权限');return a;}
 function issue(req,u,remember){const token=crypto.randomBytes(32).toString('hex');data.sessions.push({id:crypto.randomUUID(),hash:digest(token),user_id:u.id,created_at:now(),last_seen:now(),expires:now()+(remember?2592000:43200),agent:String(req.headers['user-agent']||'未知设备').slice(0,180)});const own=data.sessions.filter(s=>s.user_id===u.id);if(own.length>20){const remove=new Set(own.slice(0,own.length-20).map(s=>s.id));data.sessions=data.sessions.filter(s=>!remove.has(s.id));}return cookie(req,token,remember);}
 function reply(res,status,value,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(value));}
 async function body(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)fail(413,'请求过大');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{fail(400,'请求格式无效');}}
 async function work(fn){if(hashing>=4)fail(429,'操作较多，请稍后重试');hashing++;try{return await fn();}finally{hashing--;}}
 const server=http.createServer(async(req,res)=>{try{
  const supplied=String(req.headers['x-aigccat-auth-proxy']||'');if(supplied.length!==proxyToken.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(proxyToken)))return reply(res,403,{error:'内部接口'});
  clean();const url=new URL(req.url,'http://auth'),p=url.pathname,method=req.method,ip=req.headers['x-real-ip'];
  if(p==='/internal/check'){
   const a=actor(req),original=req.headers['x-original-uri']||'/',verb=req.headers['x-original-method']||'GET';
   let pathname;try{pathname=decodeURIComponent(new URL(original,origin).pathname);}catch{fail(400,'路径无效');}
   if(pathname.includes('\\')||pathname.includes('//')||pathname.split('/').includes('..'))fail(400,'路径无效');
   if(a.u.role!=='admin'&&(pathname.startsWith('/api/admin')||['/model-chat.html'].includes(pathname)||pathname.startsWith('/api/settings/')&&pathname!=='/api/settings/catalog'))fail(403,'需要管理员权限');
   if(a.u.role!=='admin'&&pathname.startsWith('/api/settings/')&&!['GET','HEAD'].includes(verb))fail(403,'需要管理员权限');
   if(!['GET','HEAD','OPTIONS'].includes(verb)&&req.headers['x-original-origin']!==requestOrigin(req))fail(403,'请从本站提交操作');
   if(now()-a.s.last_seen>60){a.s.last_seen=now();save();}return reply(res,200,{ok:true});
  }
  if(p==='/api/auth/register')return reply(res,403,{error:'注册暂未开放，请联系管理员创建账号',registration_open:false});
  if(!['GET','HEAD'].includes(method)&&req.headers.origin!==requestOrigin(req))fail(403,'请从本站提交操作');
  if(p==='/api/auth/login'&&method==='POST'){
   const b=await body(req),name=typeof b.username==='string'?b.username.trim().toLowerCase():'',ipKey='ip:'+String(ip||'unknown'),userKey='user:'+name.slice(0,32);
   if((attempts.get(ipKey)?.count||0)>=loginLimit*3||(attempts.get(userKey)?.count||0)>=loginLimit)fail(429,'尝试次数过多，请在15分钟后重试');
   if(attempts.size>10000)fail(429,'登录服务繁忙，请稍后重试');
   for(const k of [ipKey,userKey]){const v=attempts.get(k)||{count:0,until:now()+900};v.count++;attempts.set(k,v);}
   const u=data.users.find(u=>u.username===name),hash=u?.password_hash||dummy;
   const ok=typeof b.password==='string'&&b.password.length<=128&&await work(()=>verifyPassword(b.password,hash));
   if(!ok||!u?.enabled||u.password_hash!==hash){audit('登录失败',null,username(name)?name:'未知账号',ip);save();fail(401,'账号或密码不正确');}
   attempts.delete(userKey);u.last_login=now();audit('登录成功',u,'',ip);const c=issue(req,u,b.remember===true);save();return reply(res,200,{user:publicUser(u),registration_open:false},{'Set-Cookie':c});
  }
  const a=actor(req,p.startsWith('/api/admin/'));
  if(p==='/api/auth/me'&&method==='GET')return reply(res,200,{user:publicUser(a.u),registration_open:false});
  if(p==='/api/auth/logout'&&method==='POST'){data.sessions=data.sessions.filter(s=>s.id!==a.s.id);audit('退出登录',a.u,'',ip);save();return reply(res,200,{ok:true},{'Set-Cookie':cookie(req,'')});}
  if(p==='/api/auth/password'&&method==='POST'){
   const b=await body(req);if(!password(b.new_password))fail(400,'新密码需要12–128个字符');const hash=a.u.password_hash;
   if(typeof b.old_password!=='string'||b.old_password.length>128||!await work(()=>verifyPassword(b.old_password,hash)))fail(400,'当前密码不正确');
   const next=await work(()=>hashPassword(b.new_password));actor(req);if(hash!==a.u.password_hash)fail(409,'密码已变更，请重新登录');a.u.password_hash=next;data.sessions=data.sessions.filter(s=>s.user_id!==a.u.id);const c=issue(req,a.u,false);audit('修改密码',a.u,'所有旧会话已退出',ip);save();return reply(res,200,{ok:true},{'Set-Cookie':c});
  }
  if(p==='/api/auth/sessions'&&method==='GET')return reply(res,200,{sessions:data.sessions.filter(s=>s.user_id===a.u.id).map(({hash,...s})=>({...s,current:s.id===a.s.id}))});
  if(p==='/api/auth/sessions/revoke'&&method==='POST'){const b=await body(req);data.sessions=data.sessions.filter(s=>s.user_id!==a.u.id||s.id===a.s.id||b.id&&s.id!==b.id);audit('退出其他设备',a.u,'',ip);save();return reply(res,200,{ok:true});}
  if(p==='/api/admin/overview'&&method==='GET')return reply(res,200,{users:data.users.length,enabled:data.users.filter(u=>u.enabled).length,sessions:data.sessions.length,registration_open:false});
  if(p==='/api/admin/audit'&&method==='GET')return reply(res,200,{events:data.audit.slice(-100).reverse()});
  if(p==='/api/admin/users'&&method==='GET')return reply(res,200,{users:data.users.map(publicUser)});
  if(p==='/api/admin/users'&&method==='POST'){
   const b=await body(req);if(!username(b.username)||!password(b.password)||!['admin','member'].includes(b.role||'member'))fail(400,'账号需3–32位字母、数字或下划线，密码需12–128个字符');const name=b.username.toLowerCase();if(data.users.some(u=>u.username===name))fail(409,'账号已存在');
   const hash=await work(()=>hashPassword(b.password));actor(req,true);if(data.users.some(u=>u.username===name))fail(409,'账号已存在');const u={id:crypto.randomUUID(),username:name,display_name:String(b.display_name||name).trim().slice(0,40),role:b.role||'member',enabled:true,password_hash:hash,created_at:now()};data.users.push(u);audit('创建账号',a.u,name,ip);save();return reply(res,201,{user:publicUser(u)});
  }
  const match=p.match(/^\/api\/admin\/users\/([a-f0-9-]{36})(?:\/(password|sessions))?$/);
  if(match){const u=data.users.find(u=>u.id===match[1]);if(!u)fail(404,'账号不存在');const b=await body(req);
   if(match[2]==='password'&&method==='POST'){if(u.id===a.u.id)fail(400,'请在账号安全中修改自己的密码');if(!password(b.password))fail(400,'密码需12–128个字符');const hash=await work(()=>hashPassword(b.password));actor(req,true);u.password_hash=hash;data.sessions=data.sessions.filter(s=>s.user_id!==u.id);audit('重置密码',a.u,u.username,ip);save();return reply(res,200,{ok:true});}
   if(match[2]==='sessions'&&method==='POST'){data.sessions=data.sessions.filter(s=>s.user_id!==u.id);audit('撤销账号会话',a.u,u.username,ip);save();return reply(res,200,{ok:true});}
   if(!match[2]&&method==='PATCH'){
    if(b.role!==undefined&&!['admin','member'].includes(b.role)||b.enabled!==undefined&&typeof b.enabled!=='boolean')fail(400,'账号参数无效');
    const role=b.role??u.role,enabled=b.enabled??u.enabled;
    if(u.id===a.u.id&&(!enabled||role!=='admin'))fail(400,'不能停用或降级当前管理员');
    if(u.enabled&&u.role==='admin'&&(!enabled||role!=='admin')&&data.users.filter(x=>x.enabled&&x.role==='admin').length<=1)fail(400,'至少保留一个启用的管理员');
    const changed=u.role!==role||u.enabled!==enabled;u.role=role;u.enabled=enabled;if(b.display_name!==undefined)u.display_name=String(b.display_name).trim().slice(0,40)||u.username;if(changed)data.sessions=data.sessions.filter(s=>s.user_id!==u.id);audit('更新账号',a.u,u.username,ip);save();return reply(res,200,{user:publicUser(u)});
   }
  }
  fail(404,'接口不存在');
 }catch(e){if(!res.headersSent)reply(res,e.code||500,{error:e.code?e.message:'服务暂时不可用，请稍后重试'});}});
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const dir=process.env.AUTH_DATA_DIR||'/var/lib/aigccat-auth',bootstrapFile=path.join(dir,'bootstrap.json');
 const bootstrap=fs.existsSync(bootstrapFile)?JSON.parse(fs.readFileSync(bootstrapFile)):null;
 // 默认值必须是合法 URL（原来写的占位串会让 new URL() 每次都失败 → 所有请求 400）。
 // .invalid 是 RFC 2606 保留域名，不会等于任何真实 Host。
 const server=await createAuthServer({dir,origin:process.env.AUTH_ORIGIN||'http://aigccat.invalid',proxyToken:process.env.AUTH_PROXY_TOKEN,bootstrap});
 if(bootstrap)fs.unlinkSync(bootstrapFile);
 server.listen(Number(process.env.PORT||18081),'127.0.0.1',()=>console.log('aigccat account service ready'));
}
