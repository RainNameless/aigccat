import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from './gateway.mjs';
test('all entrances require login; shared users, separate cookies, CSRF and machine access',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aigccat-gateway-'));
 const upstream=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');let size=0;req.on('data',c=>size+=c.length);req.on('end',()=>res.end(JSON.stringify({url:req.url,origin:req.headers.origin,authorization:req.headers.authorization,cookie:req.headers.cookie,size})));});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const gateway=await createGateway({dir,upstream:'http://127.0.0.1:'+upstream.address().port,proxyToken:'private-proxy',automationToken:'private-machine',bootstrap:{username:'admin',password:'Example-test-password-2026'}});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 const port=gateway.address().port;
 const request=(url,{host='localhost:8080',method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:url,method,headers:{host,...headers}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:data,json:()=>JSON.parse(data)}));});req.on('error',reject);req.end(body);
 });
 try{
  for(const host of ['localhost:8080','127.0.0.1:8080','192.168.1.10:8080']){
   assert.equal((await request('/',{host})).status,302);
   assert.equal((await request('/api/assets',{host})).status,401);
   assert.equal((await request('/login.html',{host})).status,200);
   assert.equal((await request('/api/auth/register',{host,method:'POST'})).status,403);
  }
  assert.equal((await request('/',{host:'evil.example'})).status,403);
  assert.equal((await request('/',{host:'192.168.evil.example'})).status,403);
  assert.equal((await request('/',{host:'<your-domain>'})).status,403);
  const remote={'x-aigccat-auth-proxy':'private-proxy'};
  assert.equal((await request('/',{host:'<your-domain>',headers:remote})).status,302);
  assert.equal((await request('/api/assets',{headers:{'x-aigccat-auth-proxy':'private-proxy','x-original-uri':'/login.html'}})).status,401);
  assert.equal((await request('/internal/check')).status,404);
  const login=async(host,headers={})=>request('/api/auth/login',{host,method:'POST',headers:{origin:host==='<your-domain>'?'https://<your-domain>':'http://'+host,'Content-Type':'application/json',...headers},body:JSON.stringify({username:'admin',password:'Example-test-password-2026'})});
  const local=await login('localhost:8080');assert.equal(local.status,200);const cookie=local.headers['set-cookie'][0].split(';')[0];assert.match(cookie,/^aigccat_session=/);assert.ok(!local.headers['set-cookie'][0].includes('Secure'));
  const lan=await login('192.168.1.10:8080');assert.equal(lan.status,200);assert.equal(lan.json().user.id,local.json().user.id);
  const pub=await login('<your-domain>',remote);assert.equal(pub.status,200);assert.match(pub.headers['set-cookie'][0],/^__Host-aigccat_session=.*Secure/);assert.equal(pub.json().user.id,local.json().user.id);
  assert.equal((await request('/api/admin/users',{headers:{cookie}})).status,200);
  const asset=await request('/api/assets',{headers:{cookie}});assert.equal(asset.status,200);assert.equal(asset.json().cookie,undefined);
  assert.equal((await request('/api/workbench/state',{method:'PUT',headers:{cookie,origin:'http://evil.example'},body:'{}'})).status,403);
  assert.equal((await request('/api/workbench/state',{method:'PUT',headers:{cookie,origin:'http://localhost:8080'},body:'{}'})).status,200);
  const payload=Buffer.alloc(1024*1024,65);
  const upload=await request('/api/assets/import',{method:'POST',headers:{authorization:'Bearer private-machine'},body:payload});assert.equal(upload.status,200);assert.equal(upload.json().size,payload.length);assert.equal(upload.json().authorization,undefined);
  assert.equal((await request('/api/admin/users',{headers:{authorization:'Bearer private-machine'}})).status,401);
  assert.equal((await request('/api/assets',{host:'<your-domain>',headers:{...remote,authorization:'Bearer private-machine'}})).status,401);
  const pubCookie=pub.headers['set-cookie'][0].split(';')[0];
  const publicWrite=await request('/api/workbench/state',{host:'<your-domain>',method:'PUT',headers:{...remote,cookie:pubCookie,origin:'https://<your-domain>'},body:'{}'});assert.equal(publicWrite.status,200);assert.equal(publicWrite.json().origin,'http://<your-domain>');
  assert.equal((await request('/api/auth/logout',{method:'POST',headers:{cookie,origin:'http://localhost:8080'}})).status,200);
  assert.equal((await request('/api/auth/me',{headers:{cookie}})).status,401);
 }finally{gateway.closeAllConnections();await new Promise(r=>gateway.close(r));await new Promise(r=>upstream.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
