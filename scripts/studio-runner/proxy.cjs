// 代理：只在显式指定时使用。
// 优先级：显式参数 > 环境变量 STUDIO_PROXY > 直连。
//
// 刻意不做「探测本机某端口是否在听」的自动判断 —— 端口在听不等于它是一个可用代理：
// 可能是完全不相干的本地服务。把请求路由过去既不可靠，也等于把上游流量交给一个
// 我们不了解的程序。所以要代理就必须自己写清楚。
const LEGACY_PORT_HINT = 'http://127.0.0.1:7897';

function normalize(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

// explicit 传字符串（含空串=强制直连）；不传则看环境变量；都没有就是直连。
function resolveProxy(explicit) {
  if (explicit !== undefined) return normalize(explicit);
  return normalize(process.env.STUDIO_PROXY);
}

// 传给 Playwright 的 proxy 选项：空字符串代表「不要代理」
function options(proxy) {
  return proxy ? { server: proxy } : undefined;
}

module.exports = { resolveProxy, options, LEGACY_PORT_HINT };
