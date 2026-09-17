#!/usr/bin/env node
// 连接你自己的 Studio 网页订阅会话。
//
// 做三件事：
//   1) 打开一个真实浏览器，让你登录自己的订阅账号；
//   2) 把这台机器的本次登录 cookie 存成 .ai/browser-state/studio-session.auth.json（0600）；
//   3) 如果执行器令牌还不存在就生成一个。
//
// 之后常驻执行器就用这份会话提交生成，消耗的是你自己网页订阅里的积分，
// 不是开发者 API 的额度。凭据只落在这台机器上：.ai/ 在 .gitignore 里。
//
// 用法：
//   node scripts/studio-runner/connect-session.cjs                 登录并保存
//   node scripts/studio-runner/connect-session.cjs --verify        只校验现有会话
//   node scripts/studio-runner/connect-session.cjs --from a.json   导入已有的 storageState
//   node scripts/studio-runner/connect-session.cjs --proxy http://127.0.0.1:7897
//   node scripts/studio-runner/connect-session.cjs --timeout 600   等待登录的秒数
const { chromium, request } = require('playwright');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveProxy, options: proxyOptions } = require('./proxy.cjs');

const ROOT = process.env.STUDIO_ROOT || path.resolve(__dirname, '../..');
const STATE_DIR = path.join(ROOT, '.ai/browser-state');
const SESSION = process.env.STUDIO_SESSION_FILE || path.join(STATE_DIR, 'studio-session.auth.json');
const TOKEN_FILE = path.join(STATE_DIR, 'studio-runner-token');

const LOGIN_URL = 'https://studio.tripo3d.ai/';
const ORIGIN = 'https://studio.tripo3d.ai';
const WHOAMI = 'https://api.tripo3d.ai/v2/studio/studio/whoami?tokenizeAs=default_jwt';
const PAYMENT = 'https://api.tripo3d.ai/v2/studio/user/profile/payment';
const KEEP_DOMAIN = d => d === 'tripo3d.ai' || String(d).endsWith('.tripo3d.ai');

/* ─────────── 参数 ─────────── */
const argv = process.argv.slice(2);
function flag(name) { return argv.includes('--' + name); }
function value(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
if (flag('help')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 20).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}

const OUT = value('out', SESSION);
const FROM = value('from', '');
const TIMEOUT_SEC = Number(value('timeout', '300'));

/* ─────────── 只读校验 ─────────── */
// 与执行器 /health 用的是同一条链路：先用 cookie 换一次 JWT，再读一次钱包。
// 不提交任何生成，不消耗积分。
async function inspect(cookies, proxy) {
  const cookieClient = await request.newContext({
    proxy: proxyOptions(proxy), timeout: 60000,
    storageState: { cookies, origins: [] },
  });
  try {
    let response;
    try { response = await cookieClient.get(WHOAMI, { maxRetries: 0, maxRedirects: 0 }); }
    catch { return { ok: false, reason: '连不上上游（网络或代理不通）' }; }
    const body = await response.json().catch(() => ({}));
    if (!response.ok() || !body.tokenized) return { ok: false, reason: `登录已失效（HTTP ${response.status()}）` };
    const jwt = body.tokenized;
    let expires = null;
    try { expires = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).exp * 1000; } catch {}
    let credits = null;
    const api = await request.newContext({
      proxy: proxyOptions(proxy), timeout: 60000,
      extraHTTPHeaders: { origin: ORIGIN, referer: ORIGIN + '/' },
    });
    try {
      const pay = await api.get(PAYMENT, { headers: { authorization: 'Bearer ' + jwt }, maxRetries: 0, maxRedirects: 0 });
      const pj = await pay.json().catch(() => ({}));
      if (pay.ok()) credits = pj.data?.wallet?.total_credit ?? null;
    } catch {} finally { await api.dispose(); }
    return { ok: true, expires, credits };
  } finally { await cookieClient.dispose(); }
}

function readSession(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 兼容两种来源：本工具产出的 {storageState:{cookies}}，以及 Playwright 原生的 {cookies}
  const cookies = (raw.storageState?.cookies || raw.cookies || []).filter(c => KEEP_DOMAIN(c.domain));
  return cookies;
}

function report(result, file) {
  if (!result.ok) { console.log(`  ✘ 未连接：${result.reason}`); return false; }
  const when = result.expires ? new Date(result.expires).toLocaleString() : '未知';
  console.log('  ✔ 会话有效');
  console.log(`    换取到的令牌有效期至：${when}`);
  console.log(`    订阅剩余积分：${result.credits ?? '读取失败'}`);
  console.log(`    会话文件：${file}`);
  return true;
}

async function ensureToken() {
  if (fs.existsSync(TOKEN_FILE)) return null;
  await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  await fsp.writeFile(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

function nextSteps(token) {
  console.log('');
  console.log('  下一步：');
  if (token) {
    console.log('    1) 把执行器令牌写进仓库根目录的 .env（后端要用它调用本机执行器）：');
    console.log(`         STUDIO_WORKER_TOKEN=${token}`);
  } else {
    console.log(`    1) 确认 .env 里的 STUDIO_WORKER_TOKEN 与这个文件一致：${TOKEN_FILE}`);
  }
  console.log('    2) 安装/重启常驻执行器： python3 scripts/studio-runner/install.py');
  console.log('    3) 让容器重新读取环境变量： docker compose -f docker-compose.allinone.yml up -d');
  console.log('    4) 打开工作台的「模型构建」，服务状态应显示「网页订阅 · 已连接」');
  console.log('');
}

/* ─────────── 导入已有的 storageState ─────────── */
async function importFrom(file) {
  if (!fs.existsSync(file)) { console.log(`  ✘ 找不到文件：${file}`); process.exit(1); }
  const cookies = readSession(file);
  if (!cookies.length) { console.log('  ✘ 这个文件里没有 tripo3d.ai 的 cookie，可能不是 Studio 的登录态'); process.exit(1); }
  const proxy = await resolveProxy(value('proxy'));
  const result = await inspect(cookies, proxy);
  if (!result.ok) { console.log(`  ✘ 未通过校验：${result.reason}`); console.log('    请重新登录后导出，或直接不加 --from 走浏览器登录。'); process.exit(1); }
  await fsp.mkdir(path.dirname(OUT), { recursive: true, mode: 0o700 });
  await fsp.writeFile(OUT, JSON.stringify({ headers: { origin: ORIGIN, referer: ORIGIN + '/' }, storageState: { cookies, origins: [] } }, null, 1), { mode: 0o600 });
  console.log(`  ✔ 已导入 ${cookies.length} 个 cookie → ${OUT}`);
  report(result, OUT);
  nextSteps(await ensureToken());
}

/* ─────────── 浏览器登录 ─────────── */
async function connect() {
  const proxy = await resolveProxy(value('proxy'));
  console.log(proxy ? `  走代理：${proxy}` : '  直连（未使用代理）');
  if (!process.stdout.isTTY) console.log('  提示：当前不是交互终端，浏览器仍会打开，请在那里完成登录。');

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: false, proxy: proxyOptions(proxy) });
  } catch {
    console.log('  未找到系统 Chrome，改用 Playwright 自带的 Chromium');
    try { browser = await chromium.launch({ headless: false, proxy: proxyOptions(proxy) }); }
    catch (e) { console.log(`  ✘ 浏览器启动失败：${e.message.split('\n')[0]}`); console.log('    若提示缺少浏览器，先执行： npx playwright install chromium'); process.exit(1); }
  }

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(() => console.log('  页面打开较慢，如果你能看到登录页就继续登录即可'));

    console.log('');
    console.log('  浏览器已打开。请在那里登录你自己的订阅账号（含邮箱验证码等步骤）。');
    console.log(`  登录完成后本工具会自动检测，最多等 ${TIMEOUT_SEC} 秒。`);
    console.log('');

    const deadline = Date.now() + TIMEOUT_SEC * 1000;
    let result = { ok: false, reason: '等待登录超时' };
    process.stdout.write('  等待登录');
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      process.stdout.write('.');
      const state = await context.storageState().catch(() => null);
      if (!state) { result = { ok: false, reason: '浏览器已关闭，登录未完成' }; break; }
      const cookies = state.cookies.filter(c => KEEP_DOMAIN(c.domain));
      if (!cookies.length) continue;
      result = await inspect(cookies, proxy);
      if (result.ok) break;
    }
    process.stdout.write('\n\n');

    if (!result.ok) { console.log(`  ✘ ${result.reason}`); process.exit(1); }

    const state = await context.storageState();
    const cookies = state.cookies.filter(c => KEEP_DOMAIN(c.domain));
    await fsp.mkdir(path.dirname(OUT), { recursive: true, mode: 0o700 });
    await fsp.writeFile(OUT, JSON.stringify({ headers: { origin: ORIGIN, referer: ORIGIN + '/' }, storageState: { cookies, origins: [] } }, null, 1), { mode: 0o600 });
    console.log(`  ✔ 已保存 ${cookies.length} 个 cookie → ${OUT}（权限 600，只留 tripo3d.ai 域）`);
    report(result, OUT);
    nextSteps(await ensureToken());
  } finally { await browser.close(); }
}

/* ─────────── 入口 ─────────── */
(async () => {
  if (flag('verify')) {
    if (!fs.existsSync(SESSION)) {
      console.log(`  ✘ 还没有会话文件：${SESSION}`);
      console.log('    先运行： node scripts/studio-runner/connect-session.cjs');
      process.exit(1);
    }
    const cookies = readSession(SESSION);
    if (!cookies.length) { console.log('  ✘ 会话文件里没有 tripo3d.ai 的 cookie，建议重新登录'); process.exit(1); }
    const proxy = await resolveProxy(value('proxy'));
    if (!report(await inspect(cookies, proxy), SESSION)) {
      console.log('    重新登录： node scripts/studio-runner/connect-session.cjs');
      process.exit(1);
    }
    return;
  }
  if (FROM) return importFrom(FROM);
  return connect();
})().catch(e => { console.log(`  ✘ ${e.message}`); process.exit(1); });
