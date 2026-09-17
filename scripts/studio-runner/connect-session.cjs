#!/usr/bin/env node
// 连接你自己的 Studio 网页订阅会话（命令行方式）。
//
// 做三件事：
//   1) 打开一个真实浏览器，让你登录自己的订阅账号；
//   2) 把这台机器的本次登录 cookie 存成 .ai/browser-state/studio-session.auth.json（0600）；
//   3) 如果执行器令牌还不存在就生成一个。
//
// 之后常驻执行器就用这份会话提交生成，消耗的是你自己网页订阅里的积分，
// 不是开发者 API 的额度。凭据只落在这台机器上：.ai/ 在 .gitignore 里。
//
// 界面上也能做同一件事（工作台 → 服务状态 → 连接网页订阅），见 docs/STUDIO-SESSION.md。
//
// 用法：
//   node scripts/studio-runner/connect-session.cjs                 登录并保存
//   node scripts/studio-runner/connect-session.cjs --verify        只校验现有会话
//   node scripts/studio-runner/connect-session.cjs --from a.json   导入已有的 storageState
//   node scripts/studio-runner/connect-session.cjs --proxy http://127.0.0.1:7897
//   node scripts/studio-runner/connect-session.cjs --timeout 600   等待登录的秒数
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const session=require('./session.cjs');
const {resolveProxy}=require('./proxy.cjs');

const SESSION=session.SESSION;
const TOKEN_FILE=session.TOKEN_FILE;
const STATE_DIR=session.STATE_DIR;

/* ─────────── 参数 ─────────── */
const argv=process.argv.slice(2);
const flag=name=>argv.includes('--'+name);
function value(name,fallback){const i=argv.indexOf('--'+name);return i>=0&&argv[i+1]&&!argv[i+1].startsWith('--')?argv[i+1]:fallback;}
if(flag('help')){
  console.log(fs.readFileSync(__filename,'utf8').split('\n').slice(2,20).join('\n').replace(/^\/\/ ?/gm,''));
  process.exit(0);
}
const OUT=value('out',SESSION);
const FROM=value('from','');
const TIMEOUT_SEC=Number(value('timeout','300'));

function report(result,file){
  if(!result.ok){console.log(`  ✘ ${result.reason}`);return false;}
  console.log('  ✔ 会话有效');
  console.log(`    换取到的令牌有效期至：${result.expires?new Date(result.expires).toLocaleString():'未知'}`);
  console.log(`    订阅剩余积分：${result.credits??'读取失败'}`);
  console.log(`    会话文件：${file}`);
  return true;
}

async function ensureToken(){
  if(fs.existsSync(TOKEN_FILE))return null;
  await fsp.mkdir(STATE_DIR,{recursive:true,mode:0o700});
  const token=crypto.randomBytes(32).toString('hex');
  await fsp.writeFile(TOKEN_FILE,token+'\n',{mode:0o600});
  return token;
}

function nextSteps(token){
  console.log('');
  console.log('  下一步：');
  if(token){
    console.log('    1) 把执行器令牌写进仓库根目录的 .env（后端要用它调用容器内的执行器）：');
    console.log(`         STUDIO_WORKER_TOKEN=${token}`);
  }else{
    console.log(`    1) 确认 .env 里的 STUDIO_WORKER_TOKEN 与这个文件一致：${TOKEN_FILE}`);
  }
  console.log('    2) 让容器重新读取环境变量： docker compose -f docker-compose.allinone.yml up -d');
  console.log('    3) 打开工作台的「模型构建」，服务状态应显示「网页订阅 · 已连接」');
  console.log('');
  console.log('  提示：单容器版里登录窗口就在网页上（容器内自带浏览器 + VNC），');
  console.log('        通常不需要跑这个命令行工具 —— 界面里点「打开登录窗口」即可。');
  console.log('');
}

/* ─────────── 导入已有的 storageState ─────────── */
async function importFrom(file){
  if(!fs.existsSync(file)){console.log(`  ✘ 找不到文件：${file}`);process.exit(1);}
  let cookies;
  try{cookies=session.readSession(file);}
  catch(e){console.log(`  ✘ 读不了这个文件：${e.message}`);process.exit(1);}
  if(!cookies.length){console.log('  ✘ 这个文件里没有 tripo3d.ai 的 cookie，可能不是 Studio 的登录态');process.exit(1);}
  const proxy=await resolveProxy(value('proxy'));
  const result=await session.inspect(cookies,proxy);
  if(!result.ok){
    console.log(`  ✘ 未通过校验：${result.reason}`);
    console.log('    请重新登录后导出，或直接不加 --from 走浏览器登录。');
    process.exit(1);
  }
  await session.saveSession(cookies,OUT);
  console.log(`  ✔ 已导入 ${cookies.length} 个 cookie → ${OUT}`);
  report(result,OUT);
  nextSteps(await ensureToken());
}

/* ─────────── 浏览器登录 ─────────── */
async function connect(){
  const proxy=await resolveProxy(value('proxy'));
  console.log(proxy?`  走代理：${proxy}`:'  直连（未使用代理）');
  if(!process.stdout.isTTY)console.log('  提示：当前不是交互终端，浏览器仍会打开，请在那里完成登录。');

  console.log('');
  console.log('  即将打开浏览器。请在那里登录你自己的订阅账号（含邮箱验证码等步骤）。');
  console.log(`  登录完成后本工具会自动检测，最多等 ${TIMEOUT_SEC} 秒。`);
  console.log('');

  try{
    await session.startLogin(proxy);
  }catch(e){
    console.log(`  ✘ ${e.message}`);
    process.exit(1);
  }

  const deadline=Date.now()+TIMEOUT_SEC*1000;
  let detected=false;
  process.stdout.write('  等待登录');
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,3000));
    process.stdout.write('.');
    if((await session.loginState()).detected){detected=true;break;}
  }
  process.stdout.write('\n\n');

  if(!detected){
    await session.cancelLogin('等待登录超时，登录窗口已关闭');
    console.log('  ✘ 没有检测到登录，已关闭登录窗口。重试或加大 --timeout。');
    process.exit(1);
  }

  let info;
  try{info=await session.finishLogin();}
  catch(e){console.log(`  ✘ ${e.message}`);process.exit(1);}

  console.log(`  ✔ 已保存 ${info.cookies} 个 cookie → ${info.file}（权限 600，只留 tripo3d.ai 域）`);
  report({ok:true,expires:info.expires,credits:info.credits},info.file);
  nextSteps(await ensureToken());
}

/* ─────────── 入口 ─────────── */
(async()=>{
  if(flag('verify')){
    if(!fs.existsSync(SESSION)){
      console.log(`  ✘ 还没有会话文件：${SESSION}`);
      console.log('    先运行： node scripts/studio-runner/connect-session.cjs');
      process.exit(1);
    }
    let cookies;
    try{cookies=session.readSession(SESSION);}
    catch(e){console.log(`  ✘ 会话文件读不了：${e.message}`);process.exit(1);}
    if(!cookies.length){console.log('  ✘ 会话文件里没有 tripo3d.ai 的 cookie，建议重新登录');process.exit(1);}
    const proxy=await resolveProxy(value('proxy'));
    if(!report(await session.inspect(cookies,proxy),SESSION)){
      console.log('    重新登录： node scripts/studio-runner/connect-session.cjs');
      process.exit(1);
    }
    return;
  }
  if(FROM)return importFrom(FROM);
  return connect();
})().catch(e=>{console.log(`  ✘ ${e.message}`);process.exit(1);});
