// 会话执行器与登录向导共用的代理解析。
//
// 代理是可选的。开发机上常年挂着一个本地代理（默认端口 7897）时能直连上游，
// 但别人的机器上通常没有这个端口 —— 如果写死成默认值，换一台机器就会连不上。
// 规则：
//   1) 显式传入（命令行或 STUDIO_PROXY）就照它走，空串 = 强制直连；
//   2) 都没设时，只在本机 7897 真的有进程监听才使用，否则直连。
// 这样本机既有行为不变，换台机器也不会因为一个不存在的代理而失败。
const net = require('node:net');

const LEGACY = 'http://127.0.0.1:7897';

function listening(port, host = '127.0.0.1', ms = 800) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(ms);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function resolveProxy(explicit) {
  if (explicit !== undefined) return String(explicit).trim();
  if (process.env.STUDIO_PROXY !== undefined) return String(process.env.STUDIO_PROXY).trim();
  try {
    const port = Number(new URL(LEGACY).port);
    if (port && await listening(port)) return LEGACY;
  } catch {}
  return '';
}

function options(proxy) {
  return proxy ? { server: proxy } : undefined;
}

module.exports = { resolveProxy, listening, options, LEGACY };
