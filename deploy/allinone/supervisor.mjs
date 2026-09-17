#!/usr/bin/env node
// aigccat 单容器启动器
//
// 一个容器里跑四件事：
//   1. minio    —— 资产存储（S3 兼容，只监听容器内回环）
//   2. web      —— Rust 后端（只监听容器内回环）
//   3. gateway  —— 鉴权网关，容器里唯一对外发布的端口（8080）
//   4. opencode —— AI 绑骨执行器（需宿主 Blender 桥接，没有就是"不可达"，不影响其它功能）
//
// 首次启动自动生成密钥与初始管理员账号，所以 `docker run` 之后不用改任何配置。
// 本文件同时负责：目录与软链自举、启动顺序与就绪等待、崩溃重启、日志前缀、优雅退出。

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA = process.env.AIGCCAT_DATA || '/data';
const ENV_FILE = path.join(DATA, 'aigccat.env');
const FIRST_BOOT = !fs.existsSync(path.join(DATA, '.initialized'));

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`${ts()} [aigccat]`, ...a);
const warn = (...a) => console.warn(`${ts()} [aigccat]`, ...a);

/* ─────────── 1. 目录与软链 ───────────
   代码里有一批路径是硬编码的（服务配置在 /srv/config、opencode 任务在 /tasks、
   会话状态在 /root/.local/share/opencode）。单容器把它们统一指到同一个数据卷，
   于是「备份 = 备份一个 /data」。 */
const DIR = {
  minio:    path.join(DATA, 'minio'),
  authData: path.join(DATA, 'auth', 'data'),
  authSec:  path.join(DATA, 'auth', 'secrets'),
  config:   path.join(DATA, 'config'),
  opencode: path.join(DATA, 'opencode'),
  tasks:    path.join(DATA, 'opencode-tasks'),
};
for (const d of Object.values(DIR)) fs.mkdirSync(d, {recursive: true});

function relink(target, link) {
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() && fs.readlinkSync(link) === target) return;
    fs.rmSync(link, {recursive: true, force: true});
  } catch {}
  fs.mkdirSync(path.dirname(link), {recursive: true});
  fs.symlinkSync(target, link);
  log(`软链 ${link} → ${target}`);
}
relink(DIR.config, '/srv/config');
relink(DIR.tasks, '/tasks');
relink(DIR.opencode, '/root/.local/share/opencode');

/* ─────────── 2. 密钥自举 ───────────
   用户没提供就生成一份并存到 /data/aigccat.env（0600），重启保持不变。 */
const saved = {};
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) saved[m[1]] = m[2];
  }
}
const generated = [];
function secret(name, len = 24) {
  if (process.env[name]) return process.env[name];
  if (!saved[name]) { saved[name] = crypto.randomBytes(len).toString('hex'); generated.push(name); }
  return saved[name];
}

// 如果卷里已经有令牌文件（典型场景：从多容器版迁移过来，或复用旧数据卷），
// 必须沿用它们，否则下面会生成新值并覆盖，导致外部脚本 / 网关 / CI 里
// 正在使用的旧令牌全部失效。
for (const [name, file] of [['AIGCCAT_PROXY_TOKEN', 'proxy.token'], ['AIGCCAT_AUTOMATION_TOKEN', 'automation.token']]) {
  const p = path.join(DIR.authSec, file);
  if (!process.env[name] && !saved[name] && fs.existsSync(p)) {
    const v = fs.readFileSync(p, 'utf8').trim();
    if (v) { saved[name] = v; log(`沿用卷里已有的 ${file}`); }
  }
}

const MINIO_USER = process.env.MINIO_ROOT_USER || 'aigccat';
const MINIO_PASS = secret('MINIO_ROOT_PASSWORD');
const RIG_TOKEN  = secret('RIG_AGENT_TOKEN');
const ADMIN_USER = process.env.AIGCCAT_ADMIN_USER || 'admin';
const ADMIN_PASS = secret('AIGCCAT_ADMIN_PASSWORD', 9);

// gateway 从文件读令牌，保持与原多容器部署一致
for (const [file, value] of [['proxy.token', secret('AIGCCAT_PROXY_TOKEN')], ['automation.token', secret('AIGCCAT_AUTOMATION_TOKEN')]]) {
  const p = path.join(DIR.authSec, file);
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8').trim() !== value) fs.writeFileSync(p, value + '\n', {mode: 0o600});
}

if (generated.length) {
  fs.writeFileSync(ENV_FILE, Object.entries(saved).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', {mode: 0o600});
  log(`已生成密钥并保存到 ${ENV_FILE}：${generated.join(', ')}`);
}

// 容器里有没有自带 Blender？
// amd64 镜像装了官方 Blender；arm64 装不了（官方没有 Linux arm64 版），
// 这时自动改用宿主机上的 Blender —— 两个镜像共用这一份代码。
const LOCAL_BLENDER = process.env.BLENDER_BIN || '/opt/blender/blender';
const HAS_LOCAL_BLENDER = fs.existsSync(LOCAL_BLENDER);
const BLENDER_URL = process.env.BLENDER_WORKER_URL
  || (HAS_LOCAL_BLENDER ? 'http://127.0.0.1:8788' : 'http://host.docker.internal:8788');
const RIG_URL = process.env.RIG_HOST_URL
  || (HAS_LOCAL_BLENDER ? 'http://127.0.0.1:8791' : 'http://host.docker.internal:8791');

const WEB_PORT = 8081;   // 只在容器内回环，对外只有 gateway 的 8080
const WEB = `http://127.0.0.1:${WEB_PORT}`;

/* ─────────── 3. 进程定义 ─────────── */
const children = [
  {
    name: 'minio', critical: true,
    cmd: '/usr/local/bin/minio',
    args: ['server', DIR.minio, '--address', '127.0.0.1:9000', '--console-address', '127.0.0.1:9001'],
    env: {MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASS},
    ready: {url: 'http://127.0.0.1:9000/minio/health/live', label: '存储就绪'},
  },
  {
    // 容器内自带的 Blender 5.2 工作器：减面 / 体素重拓扑 / 部件编辑 / 自动绑骨。
    // 与宿主机上跑的是同一份 worker_server.py —— 它用 BLENDER_BIN 定位 Blender，
    // 所以这里只是把路径指到镜像里的 /opt/blender。
    // 设为非 critical：起不来也不该让整个容器退出，界面会显示"不可达"。
    name: 'blender', critical: false,
    cmd: '/usr/bin/python3',
    args: ['/srv/blender/worker_server.py', '8788'],
    cwd: '/srv/blender',
    env: {
      ...process.env,
      BLENDER_BIN: process.env.BLENDER_BIN || '/opt/blender/blender',
      // 容器里没有 GPU，EEVEE 起不来（EGL 报错），缩略图改用 Cycles CPU
      AIGCCAT_RENDER_ENGINE: process.env.AIGCCAT_RENDER_ENGINE || 'CYCLES',
    },
    ready: {url: 'http://127.0.0.1:8788/healthz', label: 'Blender 就绪'},
  },
  {
    // AI 写 Blender 脚本的执行桥（原来在宿主 8791）。同一份 host.py。
    name: 'rig-bridge', critical: false,
    cmd: '/usr/bin/python3',
    args: ['/app/host.py'],
    cwd: '/app',
    env: {
      ...process.env,
      BLENDER_BIN: process.env.BLENDER_BIN || '/opt/blender/blender',
    },
    ready: {url: 'http://127.0.0.1:8791/health', label: '绑骨桥就绪'},
  },
  {
    name: 'web', critical: true,
    cmd: '/srv/aigccat-web',
    // 必须从 /srv 启动：main.rs 里是 ServeDir::new("static")（相对路径），
    // CWD 不对的话前端会整体 404。
    cwd: '/srv',
    // 全量透传用户传入的环境变量（OPENAI_* / TRIPO_* / IMAGE_* …），只覆盖容器内必须改的几项
    env: {
      ...process.env,
      PORT: String(WEB_PORT),
      MINIO_ENDPOINT: '127.0.0.1:9000',
      MINIO_ACCESS_KEY: MINIO_USER,
      MINIO_SECRET_KEY: MINIO_PASS,
      MINIO_BUCKET: process.env.MINIO_BUCKET || 'game-assets',
      RIG_AGENT_URL: 'http://127.0.0.1:4097',
      RIG_AGENT_TOKEN: RIG_TOKEN,
      SERVICES_PUBLIC_ORIGIN: process.env.AUTH_ORIGIN || '',
      BLENDER_WORKER_URL: BLENDER_URL,
      STUDIO_WORKER_URL: process.env.STUDIO_WORKER_URL || 'http://host.docker.internal:8790',
    },
    ready: {url: `${WEB}/api/assets`, label: '后端就绪', anyStatus: true},
  },
  {
    name: 'gateway', critical: true,
    cmd: process.execPath,
    args: ['/srv/auth-server/gateway.mjs'],
    env: {
      PORT: '8080',
      APP_UPSTREAM: WEB,
      AUTH_DATA_DIR: DIR.authData,
      AUTH_SECRETS_DIR: DIR.authSec,
      AUTH_ORIGIN: process.env.AUTH_ORIGIN || '',
      AUTH_BOOTSTRAP_USER: ADMIN_USER,
      AUTH_BOOTSTRAP_PASSWORD: ADMIN_PASS,
    },
    ready: {url: 'http://127.0.0.1:8080/login.html', label: '入口就绪'},
  },
  {
    // 非关键：没有宿主 Blender 桥接时它照样能跑，只是界面会提示"桥接不可达"
    name: 'opencode', critical: false,
    cmd: process.execPath, args: ['/app/server.cjs'], cwd: '/app',
    env: {
      ...process.env,
      AIGCCAT_URL: WEB,
      RIG_AGENT_TOKEN: RIG_TOKEN,
      OPENCODE_SERVER_PASSWORD: RIG_TOKEN,
      RIG_HOST_URL: RIG_URL,
    },
  },
];

/* ─────────── 4. 启动、就绪等待、重启 ─────────── */
let stopping = false;
const procs = new Map();

function launch(def) {
  const p = spawn(def.cmd, def.args || [], {
    cwd: def.cwd || '/',
    // 注意：一旦给子进程传 env，就会整个替换掉它的环境；不显式带上 PATH
    // 的话 Node 会用默认的 /bin:/usr/bin 去找可执行文件，/usr/local/bin 下的
    // minio / node 就会变成 ENOENT。
    env: {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: process.env.HOME || '/root',
      ...def.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${def.name}]`;
  const pump = (stream, to, isErr) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) if (line.trim()) to.call(console, `${ts()} ${prefix}`, line);
    });
  };
  pump(p.stdout, console.log, false);
  pump(p.stderr, console.warn, true);

  const rec = procs.get(def.name) || {restarts: []};
  rec.proc = p;
  rec.def = def;
  procs.set(def.name, rec);

  p.on('exit', (code, signal) => {
    if (stopping) return;
    warn(`${def.name} 退出（code=${code} signal=${signal}）`);
    const now = Date.now();
    rec.restarts = rec.restarts.filter((t) => now - t < 60_000);
    rec.restarts.push(now);
    if (rec.restarts.length > 5) {
      warn(`${def.name} 一分钟内反复退出，容器将退出交由 Docker 重启策略处理`);
      shutdown(1);
      return;
    }
    setTimeout(() => { if (!stopping) { log(`重启 ${def.name}`); launch(def); } }, 1500);
  });
  return p;
}

async function waitReady(def, timeoutMs = 120_000) {
  if (!def.ready) return;
  const started = Date.now();
  const {url, label, anyStatus} = def.ready;
  while (Date.now() - started < timeoutMs) {
    if (stopping) return;
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(3000)});
      if (anyStatus || r.ok) { log(`${label}（${def.name}）`); return; }
    } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  warn(`${def.name} 在 ${Math.round(timeoutMs / 1000)} 秒内未就绪，继续启动其余组件`);
}

function shutdown(code = 0, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  log('正在停止…');
  for (const {proc} of procs.values()) { try { proc.kill(signal); } catch {} }
  setTimeout(() => {
    for (const {proc} of procs.values()) { try { proc.kill('SIGKILL'); } catch {} }
    process.exit(code);
  }, 5000).unref();
}
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGINT',  () => shutdown(0, 'SIGINT'));

/* ─────────── 5. 主流程 ─────────── */
log(`aigccat 单容器启动，数据目录 ${DATA}`);

// ⚠ 必须在启动 gateway 之前判定账号库是否为空。
// gateway 启动时会 bootstrap 建号并创建 accounts.json，若把判定放在它启动之后，
// 结果恒为「已有账号库」—— 首次部署的人就永远看不到初始密码（只能去 /data/aigccat.env 翻）。
const freshAccounts = FIRST_BOOT && !fs.existsSync(path.join(DIR.authData, 'accounts.json'));

// 必须按依赖顺序串起来起：minio → web → gateway。
// web 启动时会调 ensure_bucket() 建 bucket，只跑一次；如果 minio 还没就绪，
// 建桶会失败并且不会重试 —— 表现为「能用但一存资产就报 NoSuchBucket」。
const byName = (n) => children.find((c) => c.name === n);
// Blender 工作器与绑骨桥只在「镜像自带 Blender」时启动；没有就跳过，由宿主那份顶上。
const order = ['minio'];
if (HAS_LOCAL_BLENDER) order.push('blender', 'rig-bridge');
order.push('web', 'gateway');
log(HAS_LOCAL_BLENDER
  ? `容器自带 Blender（${LOCAL_BLENDER}），减面/重拓扑/绑骨在容器内执行`
  : '容器内没有 Blender（该架构无官方构建），改用宿主机上的 —— 请确保宿主 Blender 工作器在跑');
for (const name of order) {
  const def = byName(name);
  if (!def) continue;
  launch(def);
  await waitReady(def);
}

// opencode 不阻塞启动：它没就绪只影响 AI 绑骨面板，不影响其它功能
launch(byName('opencode'));

if (FIRST_BOOT) {
  fs.writeFileSync(path.join(DATA, '.initialized'), new Date().toISOString() + '\n');
  // freshAccounts 已在启动 gateway 之前算好（见上方主流程开头）：
  // 只有账号库确实是空的（gateway 会走 bootstrap 建号）才打印初始账号密码。
  // 否则（典型场景：数据卷是从多容器版迁移过来的）会打印一个根本没生效的随机密码，
  // 让人以为登录密码被改了。
  console.log('');
  console.log('  ────────────────────────────────────────────────');
  console.log('   aigccat 已就绪');
  console.log('   访问地址：http://localhost:8080');
  if (freshAccounts) {
    console.log(`   初始账号：${ADMIN_USER}`);
    console.log(`   初始密码：${ADMIN_PASS}`);
    console.log('   （上面这行只在首次启动打印一次，也会存到 /data/aigccat.env）');
  } else {
    console.log('   检测到数据卷里已有账号库，沿用其中的账号与密码，未创建新账号。');
  }
  console.log('  ────────────────────────────────────────────────');
  console.log('');
} else {
  log('aigccat 已就绪：http://localhost:8080');
}
