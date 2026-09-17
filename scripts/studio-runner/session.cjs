// 网页订阅会话的共享逻辑：校验、保存，以及「按需拉起浏览器让用户登录」。
// 命令行工具 connect-session.cjs 与常驻执行器 server.cjs 都用这一份，避免两套实现漂移。
const {chromium,request}=require('playwright');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {resolveProxy,options:proxyOptions}=require('./proxy.cjs');

const ROOT=process.env.STUDIO_ROOT||path.resolve(__dirname,'../..');
const STATE_DIR=path.join(ROOT,'.ai/browser-state');
const SESSION=process.env.STUDIO_SESSION_FILE||path.join(STATE_DIR,'studio-session.auth.json');
const TOKEN_FILE=path.join(STATE_DIR,'studio-runner-token');
const LOGIN_URL='https://studio.tripo3d.ai/';
const ORIGIN='https://studio.tripo3d.ai';
const WHOAMI='https://api.tripo3d.ai/v2/studio/studio/whoami?tokenizeAs=default_jwt';
const PAYMENT='https://api.tripo3d.ai/v2/studio/user/profile/payment';
// 只留 tripo 域的 cookie：浏览器里往往还带着 bing/facebook/clarity 之类的跟踪 cookie，一律不存
const KEEP_DOMAIN=d=>d==='tripo3d.ai'||String(d).endsWith('.tripo3d.ai');
// 登录窗口不会无限开着，避免留下一个没人管的浏览器进程
const LOGIN_TIMEOUT_MS=Number(process.env.STUDIO_LOGIN_TIMEOUT_MS||10*60*1000);

/* ─────────── 校验与落盘 ─────────── */
// 与执行器 /health 同一条链路：先用 cookie 换 JWT，再读钱包。不提交任何生成。
async function inspect(cookies,proxy){
  const cookieClient=await request.newContext({proxy:proxyOptions(proxy),timeout:60000,storageState:{cookies,origins:[]}});
  try{
    let response;
    try{response=await cookieClient.get(WHOAMI,{maxRetries:0,maxRedirects:0});}
    catch{return {ok:false,reason:'连不上上游（网络或代理不通）'};}
    const body=await response.json().catch(()=>({}));
    if(!response.ok()||!body.tokenized)return {ok:false,reason:`登录已失效（HTTP ${response.status()}）`};
    const jwt=body.tokenized;
    let expires=null;
    try{expires=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url')).exp*1000;}catch{}
    let credits=null;
    const api=await request.newContext({proxy:proxyOptions(proxy),timeout:60000,extraHTTPHeaders:{origin:ORIGIN,referer:ORIGIN+'/'}});
    try{
      const pay=await api.get(PAYMENT,{headers:{authorization:'Bearer '+jwt},maxRetries:0,maxRedirects:0});
      const pj=await pay.json().catch(()=>({}));
      if(pay.ok())credits=pj.data?.wallet?.total_credit??null;
    }catch{} finally{await api.dispose();}
    return {ok:true,expires,credits};
  }finally{await cookieClient.dispose();}
}

// 兼容两种来源：本模块产出的 {storageState:{cookies}}，以及 Playwright 原生的 {cookies}
function readSession(file){
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  return (raw.storageState?.cookies||raw.cookies||[]).filter(c=>KEEP_DOMAIN(c.domain));
}

async function saveSession(cookies,file=SESSION){
  await fsp.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const payload={headers:{origin:ORIGIN,referer:ORIGIN+'/'},storageState:{cookies,origins:[]}};
  await fsp.writeFile(file,JSON.stringify(payload,null,1),{mode:0o600});
  return file;
}

/* ─────────── 浏览器登录（按需拉起，一次一个） ─────────── */
let pending=null;      // {browser,context,proxy,startedAt,detected,timer}
let notice=null;       // 上一次登录流程的结束原因，供界面展示

async function launchBrowser(proxy){
  try{
    return await chromium.launch({channel:'chrome',headless:false,proxy:proxyOptions(proxy)});
  }catch{
    try{return await chromium.launch({headless:false,proxy:proxyOptions(proxy)});}
    catch{throw new Error('没有可用的浏览器：请安装 Google Chrome，或执行 npx playwright install chromium');}
  }
}

function loginState(){
  if(!pending)return {state:'idle',session:fs.existsSync(SESSION),loginUrl:LOGIN_URL,notice};
  return {
    state:'waiting',session:fs.existsSync(SESSION),loginUrl:LOGIN_URL,
    detected:!!pending.detected,
    waited_seconds:Math.floor((Date.now()-pending.startedAt)/1000),
  };
}

async function closePending(){
  if(!pending)return;
  const current=pending;pending=null;
  clearInterval(current.timer);
  await current.browser.close().catch(()=>{});
}

// 后台探一次登录是否已经完成，只用于状态展示——保存仍然由用户点「我已登录」触发。
async function probe(){
  if(!pending||pending.detected)return;
  const state=await pending.context.storageState().catch(()=>null);
  if(!state)return;
  const cookies=state.cookies.filter(c=>KEEP_DOMAIN(c.domain));
  if(!cookies.length)return;
  const result=await inspect(cookies,pending.proxy);
  if(result.ok&&pending)pending.detected=true;
}

async function startLogin(explicitProxy){
  notice=null;
  if(pending)return loginState();
  const proxy=await resolveProxy(explicitProxy);
  const browser=await launchBrowser(proxy);
  const context=await browser.newContext();
  const page=await context.newPage();
  page.goto(LOGIN_URL,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
  pending={browser,context,proxy,startedAt:Date.now(),detected:false,timer:null};
  pending.timer=setInterval(async()=>{
    if(!pending)return;
    if(Date.now()-pending.startedAt>LOGIN_TIMEOUT_MS){await cancelLogin('等待登录超时，登录窗口已关闭');return;}
    await probe().catch(()=>{});
  },3000);
  pending.timer.unref?.();
  return loginState();
}

async function finishLogin(){
  if(!pending){const e=new Error('没有进行中的登录，请先打开登录窗口');e.code=409;throw e;}
  const state=await pending.context.storageState().catch(()=>null);
  if(!state){await closePending();const e=new Error('登录窗口已经关闭，请重新打开');e.code=409;throw e;}
  const cookies=state.cookies.filter(c=>KEEP_DOMAIN(c.domain));
  if(!cookies.length){const e=new Error('还没有登录信息，请先在打开的窗口里完成登录');e.code=409;throw e;}
  const result=await inspect(cookies,pending.proxy);
  if(!result.ok){
    // 未登录时上游也会回 401，所以这里要区分「还没登录」和「登录过期」，别让用户以为是自己掉线了
    const e=new Error(pending.detected
      ?'登录已失效，请重新登录'
      :`还没有检测到登录（${result.reason}）：请先在打开的登录窗口里完成登录`);
    e.code=409;throw e;
  }
  const file=await saveSession(cookies);
  await closePending();
  notice=null;
  return {saved:true,file,cookies:cookies.length,credits:result.credits??null,expires:result.expires??null};
}

async function cancelLogin(reason='已取消登录窗口'){
  if(!pending)return {state:'idle',cancelled:false};
  await closePending();
  notice=reason;
  return {state:'idle',cancelled:true,notice:reason};
}

function isBusy(){return !!pending;}

module.exports={inspect,readSession,saveSession,startLogin,finishLogin,cancelLogin,loginState,isBusy,
  SESSION,TOKEN_FILE,STATE_DIR,LOGIN_URL,KEEP_DOMAIN};
