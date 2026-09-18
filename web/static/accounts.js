/* accounts.js —— 统一的「添加 AI 账号」弹窗 + 账号池操作（参考 sub2api 的账号管理交互）
   支持每家供应商多条账号：API Key 或订阅（登录会话）。
   · 添加：平台 logo 卡片 → 账号类型 → 名称 + 凭据（或登录窗口）→ 可反复添加
   · 切换：apikey = 换当前 Key（同步进供应商）；订阅 = 原子替换活跃会话文件（执行器每次请求重读，即时生效）
   · 开关 / 删除 / 捕获登录会话：均走 /api/settings/accounts 系列
   自包含：自带 dialog 元素与样式，工作台（import）与后台（window.AigccatAccounts）共用。 */

export const PROVIDERS = {
  tripo: {
    name: "Tripo", color: "#7C5CFF",
    svg: '<path d="M12 3 3 20h18Z"/><path d="M12 3v17"/><path d="M3 20 12 12l9 8"/>',
    keyHint: "platform.tripo3d.ai 开发者后台的 API Key",
    base_url: "https://openapi.tripo3d.ai/v3",
    subscription: true,
  },
  meshy: {
    name: "Meshy", color: "#22C55E",
    svg: '<path d="M4 4h16v16H4Z"/><path d="M4 12h16M12 4v16"/>',
    keyHint: "meshy.ai/settings/api 的 Key（msy_ 开头）",
    base_url: "https://api.meshy.ai/openapi/v2",
    subscription: false,
  },
  rodin: {
    name: "Rodin", color: "#F59E0B",
    svg: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c3.2 2.6 3.2 13.4 0 16"/><path d="M12 4c-3.2 2.6-3.2 13.4 0 16"/>',
    keyHint: "developer.hyper3d.ai 的 API Key",
    base_url: "https://api.hyper3d.com/api/v2",
    subscription: false,
  },
  hunyuan3d: {
    name: "Hunyuan3D", color: "#0052D9",
    svg: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7a5 5 0 1 0 5 5"/><circle cx="12" cy="12" r="1.4"/>',
    keyHint: "腾讯云 CAM 的 SecretId 与 SecretKey（两项分开填）",
    base_url: "https://ai3d.tencentcloudapi.com",
    subscription: false,
    twinKey: true,
  },
  hi3d: {
    name: "Hi3D", color: "#EC4899",
    svg: '<path d="M6 5v14"/><path d="M6 12h7"/><path d="M13 5v14"/><path d="M19 10v6"/>',
    keyHint: "Hitem3D 开放平台的 accessToken",
    base_url: "https://api.hitem3d.ai/open-api/v1",
    subscription: false,
  },
  custom: {
    name: "自定义", color: "#06B6D4",
    svg: '<path d="M9 7V3"/><path d="M15 7V3"/><path d="M7 7h10v4a5 5 0 0 1-10 0Z"/><path d="M12 12v4"/><path d="M8 20h8"/>',
    keyHint: "任何 OpenAI 兼容接口（自定义中转 / 本地服务等）",
    subscription: false,
    custom: true,
  },
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (r.status === 401) { location.replace("/login.html?next=" + encodeURIComponent(location.pathname)); throw Error("登录已过期"); }
  if (!r.ok) throw new Error(`请求失败（${r.status}）`);
  return r.json();
}
async function sendJSON(url, method, body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (r.status === 401) { location.replace("/login.html?next=" + encodeURIComponent(location.pathname)); throw Error("登录已过期"); }
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(t.slice(0, 300) || `请求失败（${r.status}）`); }
  return r.json().catch(() => ({}));
}

/* ---------- 账号池操作（admin / 顶栏快速切换共用） ---------- */
export const accountsApi = {
  list: () => getJSON("/api/settings/catalog"),
  add: (body) => sendJSON("/api/settings/accounts", "POST", body),
  patch: (id, body) => sendJSON(`/api/settings/accounts/${encodeURIComponent(id)}`, "PATCH", body),
  remove: (id) => sendJSON(`/api/settings/accounts/${encodeURIComponent(id)}`, "DELETE"),
  capture: (id) => sendJSON(`/api/settings/accounts/${encodeURIComponent(id)}/capture`, "POST", {}),
};

/* ---------- 弹窗骨架 ---------- */
let dialogEl = null;
function ensureDialog() {
  if (dialogEl?.isConnected) return dialogEl;
  if (!document.getElementById("acct-modal-styles")) {
    const style = document.createElement("style");
    style.id = "acct-modal-styles";
    style.textContent = `
.acct-dialog{border:1px solid rgba(128,128,128,.28);border-radius:12px;background:var(--surface,#1b1d23);color:var(--text,#e8e8ea);padding:20px;width:min(560px,94vw);max-height:88vh;overflow:auto;font:inherit}
.acct-dialog::backdrop{background:rgba(0,0,0,.55)}
.acct-dialog h2{margin:0 0 4px;font-size:16px}
.acct-dialog .acct-sub{margin:0 0 14px;font-size:12px;color:var(--muted,#9a9aa2)}
.acct-picker{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 4px}
.acct-picker button{flex:1 1 30%;min-width:96px;display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 6px 9px;border:1px solid rgba(128,128,128,.3);border-radius:10px;background:transparent;color:var(--muted,#9a9aa2);font-size:12.5px;line-height:1.3;cursor:pointer;transition:border-color .15s,color .15s,box-shadow .15s}
.acct-picker button svg{width:24px;height:24px}
.acct-picker button:hover{color:var(--text,#e8e8ea)}
.acct-picker button.active{color:var(--acct-color,#7C5CFF);border-color:var(--acct-color,#7C5CFF);box-shadow:inset 0 0 0 1px var(--acct-color,#7C5CFF);font-weight:600}
.acct-picker button em{font-style:normal;font-size:10px;opacity:.8}
.acct-types{display:flex;gap:10px;margin:6px 0 4px;flex-wrap:wrap}
.acct-types button{flex:1 1 40%;min-width:180px;display:flex;gap:10px;align-items:flex-start;text-align:left;padding:12px;border:1px solid rgba(128,128,128,.3);border-radius:10px;background:transparent;color:var(--muted,#9a9aa2);cursor:pointer;transition:border-color .15s,background .15s}
.acct-types button.active{border-color:var(--acct-color,#7C5CFF);background:color-mix(in srgb,var(--acct-color,#7C5CFF) 10%,transparent);color:var(--text,#e8e8ea)}
.acct-types button strong{display:block;font-size:13.5px;color:var(--text,#e8e8ea);margin-bottom:2px}
.acct-types button small{font-size:11.5px;line-height:1.45}
.acct-body{margin-top:12px;border-top:1px solid rgba(128,128,128,.22);padding-top:12px}
.acct-body label{display:block;font-size:12px;color:var(--muted,#9a9aa2);margin:10px 0 4px}
.acct-body input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:var(--input,#111216);color:var(--text,#e8e8ea);font:inherit;font-size:13px}
.acct-status{display:flex;align-items:center;gap:8px;font-size:12.5px;margin:2px 0 8px}
.acct-dot{width:8px;height:8px;border-radius:50%;background:#9a9aa2;flex:none}
.acct-dot.on{background:#22C55E}
.acct-dot.off{background:#ef4444}
.acct-actions{display:flex;gap:8px;margin-top:16px}
.acct-actions button{flex:1;padding:10px;border:1px solid rgba(128,128,128,.35);border-radius:7px;background:transparent;color:var(--text,#e8e8ea);font:inherit;font-size:13px;cursor:pointer}
.acct-actions button.primary{background:var(--acct-color,#7C5CFF);border-color:transparent;font-weight:600}
.acct-actions button:disabled{opacity:.55;cursor:default}
.acct-note{font-size:12px;color:var(--muted,#9a9aa2);line-height:1.6;margin:8px 0}
.acct-vnc{margin:10px 0;border:1px solid rgba(128,128,128,.3);border-radius:8px;overflow:hidden;background:#000;aspect-ratio:16/10;max-height:56vh}
.acct-vnc iframe{display:block;width:100%;height:100%;border:0}
.acct-step-tag{font-size:11px;color:var(--muted,#9a9aa2);letter-spacing:.04em;margin:10px 0 4px}
.acct-accounts{margin-top:4px}
.acct-accounts .acct-sub{margin:0 0 6px}`;
    document.head.append(style);
  }
  dialogEl = document.createElement("dialog");
  dialogEl.className = "acct-dialog";
  dialogEl.id = "acct-modal";
  dialogEl.addEventListener("close", stopSubTimer);  // 关窗即停轮询（只挂一次）
  document.body.append(dialogEl);
  return dialogEl;
}
function closeModal() { dialogEl?.close(); }
function openShell(title, sub) {
  const d = ensureDialog();
  d.innerHTML = `<h2>${esc(title)}</h2><p class="acct-sub">${esc(sub)}</p><div class="acct-content"></div>`;
  d.showModal();
  return d.querySelector(".acct-content");
}

/* ---------- 订阅账号（Tripo 网页登录，画面内嵌） ---------- */
const VNC_URL = "/studio/vnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=studio/vnc/websocket";
const subFlow = { timer: null, state: null, host: null, onDone: null };
function subNotice() {
  const s = subFlow.state;
  if (!s) return "正在读取状态…";
  if (s.state === "unavailable") return `执行器不可达 · ${s.error || "未知原因"}`;
  if (s.state === "waiting") return "登录窗口已打开，等你在画面里操作";
  return "未连接";
}
function renderSubscription() {
  const host = subFlow.host; if (!host) return;
  const s = subFlow.state || {};
  const waiting = s.state === "waiting";
  let html =
    `<p class="acct-note">这条链路用的是<strong>你自己账号</strong>的网页订阅积分，不是开发者 API 额度。凭据只写进<strong>服务容器的数据卷</strong>（<code>/data/studio/</code>），不上传、不入库。</p>
     <div class="acct-status"><span class="acct-dot ${waiting ? "on" : ""}"></span><span>当前状态：<strong>${esc(subNotice())}</strong>${s.notice ? ` · ${esc(s.notice)}` : ""}</span></div>` +
    (s.configured_proxy
      ? `<p class="acct-note">登录窗口经代理 <code>${esc(s.configured_proxy)}</code> 访问上游。</p>`
      : '<p class="acct-note">登录窗口<strong>直连，不走代理</strong>。若这台机器的网络需要代理才能访问上游，画面里会一直加载不出来 —— 在 <code>.env</code> 里设 <code>STUDIO_PROXY</code> 后重启容器即可。</p>');
  if (waiting) {
    html +=
      `<p class="acct-note">登录窗口就是<strong>下面这个画面</strong>，直接在里头操作（含邮箱验证码等步骤）。你登好了再点下面的按钮，我们才去取凭据。${s.timeout_seconds ? `窗口最多开 ${Math.round(s.timeout_seconds / 60)} 分钟。` : ""}</p>
       <div class="acct-vnc"><iframe src="${VNC_URL}" title="登录窗口"></iframe></div>
       <div class="acct-actions"><button data-sub="finish" class="primary">我已登录，取走凭据</button><button data-sub="cancel">取消并关闭窗口</button></div>`;
  } else {
    html +=
      `<ol class="acct-note" style="padding-left:18px;margin:6px 0">
        <li>点下面的按钮，登录画面会<strong>直接出现在这个对话框里</strong>（不用切窗口，也不用去别的机器）。</li>
        <li>在里面登录你自己的订阅账号（含邮箱验证码等步骤）。</li>
        <li>登录完点「我已登录」，我们就取走这次登录的凭据。</li></ol>
       <div class="acct-actions"><button data-sub="start" class="primary">打开登录窗口</button><button data-sub="close">关闭</button></div>`;
  }
  host.innerHTML = html;
  host.querySelectorAll("[data-sub]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        if (b.dataset.sub === "close") return closeModal();
        const result = await sendJSON("/api/studio/session", "POST", { action: b.dataset.sub });
        if (b.dataset.sub === "finish") {
          stopSubTimer();
          closeModal();
          subFlow.onDone?.(result);
          return;
        }
        subFlow.state = result;
        renderSubscription();
      } catch (e) {
        host.querySelectorAll("[data-sub]").forEach((x) => (x.disabled = false));
        const note = host.querySelector(".acct-note");
        if (note) note.textContent = String(e.message || e).slice(0, 200);
      }
    }));
}
function stopSubTimer() { if (subFlow.timer) { clearInterval(subFlow.timer); subFlow.timer = null; } }
function subSignature(s) { return s ? [s.state, s.session ?? "", s.notice || "", s.error || ""].join("|") : ""; }
async function pollSubscription(force) {
  const before = subSignature(subFlow.state);
  try { subFlow.state = await getJSON("/api/studio/session"); }
  catch (e) { subFlow.state = { state: "unavailable", error: String(e.message || e).slice(0, 160) }; }
  if (force || subSignature(subFlow.state) !== before) renderSubscription();
}
export async function openSubscription({ onConnected } = {}) {
  subFlow.onDone = onConnected;
  subFlow.state = null;
  subFlow.host = openShell("连接 Tripo 订阅", "用你自己的网页订阅账号登录，消耗订阅积分而非 API 额度");
  renderSubscription();
  await pollSubscription(true);
  stopSubTimer();
  subFlow.timer = setInterval(() => pollSubscription(false).catch(() => {}), 3000);
}

/* ---------- 统一的「添加 AI 账号」弹窗（可反复添加） ---------- */
export async function openAddAccount({ onSaved } = {}) {
  let catalog;
  try { catalog = await accountsApi.list(); }
  catch (e) { const host = openShell("添加 AI 账号", ""); host.innerHTML = `<p class="acct-note">${esc(String(e.message || e))}</p>`; return; }
  const host = openShell("添加 AI 账号", "选平台 → 选账号类型 → 命名并填凭据；可反复添加多条");
  const state = { pid: null, type: null };
  const providerCards = Object.entries(PROVIDERS).map(([pid, meta]) => {
    const n = pid === "custom"
      ? catalog.accounts.filter((a) => a.kind === "custom").length
      : catalog.accounts.filter((a) => a.provider === pid).length;
    return `<button type="button" data-pid="${pid}" style="--acct-color:${meta.color}" title="${esc(meta.keyHint)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${meta.svg}</svg>
      <span>${esc(meta.name)}</span><em>${n ? n + " 个账号" : "未添加"}</em></button>`;
  }).join("");

  function render() {
    const meta = state.pid ? PROVIDERS[state.pid] : null;
    let html = `<p class="acct-step-tag">① 选择平台</p><div class="acct-picker" role="group" aria-label="选择平台">${providerCards}</div>`;
    if (meta && !meta.custom) {
      const types = meta.subscription
        ? `<button type="button" data-type="subscription" style="--acct-color:${meta.color}"><strong>订阅账号 · 网页登录</strong><small>用你自己的订阅积分，消耗的是账号额度，不是 API 计费</small></button>
           <button type="button" data-type="apikey" style="--acct-color:${meta.color}"><strong>API Key · 开发者接口</strong><small>按官方 API 计费，适合程序化生成</small></button>`
        : `<button type="button" data-type="apikey" style="--acct-color:${meta.color}"><strong>API Key</strong><small>${esc(meta.keyHint)}</small></button>`;
      html += `<p class="acct-step-tag">② 账号类型</p><div class="acct-types">${types}</div>`;
    }
    host.innerHTML = html;
    host.querySelectorAll("[data-pid]").forEach((b) => b.addEventListener("click", () => {
      state.pid = b.dataset.pid; state.type = null; render();
      if (state.pid === "custom") mountCustomForm();
    }));
    host.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => {
      state.type = b.dataset.type; render();
      if (state.type === "subscription") mountSubscription();
      if (state.type === "apikey") mountKeyForm();
    }));
  }
  /* 自定义接入：OpenAI 兼容地址 + Key；保存时自动读取上游 /models 导入全部模型
     （名字像生图的归「图片创作」，其余归文字）；也可以手动指定模型名。 */
  function mountCustomForm() {
    const box = document.createElement("div");
    box.className = "acct-body";
    box.innerHTML =
      `<p class="acct-step-tag">② 自定义模型服务（OpenAI 兼容）</p>
       <label>账号名称<input data-acct="name" placeholder="默认：自定义接入" maxlength="40"></label>
       <label>API 地址（Base URL）<input data-cust="base_url" placeholder="https://你的中转或服务/v1" spellcheck="false"></label>
       <label>API Key<input data-cust="key" type="password" autocomplete="new-password" placeholder="服务的 API Key"></label>
       <label>指定文字模型名（可选）<input data-cust="text_model" placeholder="留空 = 自动导入上游全部模型" spellcheck="false"></label>
       <label>指定生图模型名（可选）<input data-cust="image_model" placeholder="留空 = 按名字自动归类" spellcheck="false"></label>
       <label>指定视觉模型名（可选）<input data-cust="vision_model" placeholder="识图模型（如 gpt-4o）；留空 = 不分配" spellcheck="false"></label>
       <p class="acct-note">保存时自动读取上游 /models 并全部导入：名字带 image / flux / seedream 等的归「生图」（进图片创作），其余归「文字」；识图模型识别不了，用上面的框显式指定。「设为当前」开启时，导入后平台立即切到它。</p>
       <label style="display:flex;align-items:center;gap:8px;margin-top:10px"><input data-cust="set_default" type="checkbox" checked style="width:auto">设为当前使用</label>
       <div class="acct-actions"><button data-save class="primary" disabled>保存账号</button><button data-close>关闭</button></div>`;
    host.append(box);
    const fields = box.querySelectorAll("[data-cust]");
    const save = box.querySelector("[data-save]");
    const check = () => {
      const v = Object.fromEntries([...fields].map((f) => [f.dataset.cust, f.value]));
      save.disabled = !(v.base_url.trim() && v.key.trim());
    };
    fields.forEach((f) => f.addEventListener("input", check));
    box.querySelector("[data-close]").addEventListener("click", closeModal);
    save.addEventListener("click", async () => {
      save.disabled = true;
      const v = Object.fromEntries([...fields].map((f) => [f.dataset.cust, f.value]));
      try {
        await accountsApi.add({
          name: box.querySelector('[data-acct="name"]').value,
          provider: "custom", kind: "custom",
          api_key: v.key.trim(), base_url: v.base_url.trim(),
          text_model: v.text_model.trim() || null, image_model: v.image_model.trim() || null,
          vision_model: v.vision_model.trim() || null,
          set_default: box.querySelector('[data-cust="set_default"]').checked,
        });
        closeModal();
        onSaved?.({ type: "custom", pid: "custom" });
      } catch (e) {
        save.disabled = false;
        box.querySelector(".acct-note").textContent = String(e.message || e).slice(0, 240);
      }
    });
  }
  /* 名称输入（两种类型都要，默认自动编号） */
  function nameField(count) {
    return `<label>账号名称<input data-acct="name" placeholder="默认：账号 ${count}" maxlength="40"></label>`;
  }
  function mountSubscription() {
    const box = document.createElement("div");
    box.className = "acct-body";
    const count = catalog.accounts.filter((a) => a.provider === "tripo" && a.kind === "subscription").length + 1;
    box.innerHTML = `<p class="acct-step-tag">③ 登录一份新的订阅账号</p>${nameField(count)}`;
    host.append(box);
    const subBox = document.createElement("div");
    box.append(subBox);
    subFlow.onDone = async () => {
      // 登录成功：建账号 → 把刚登录的会话捕获给它
      const name = box.querySelector('[data-acct="name"]').value.trim();
      try {
        const created = await accountsApi.add({ name, provider: "tripo", kind: "subscription" });
        const account = created.accounts?.find((a) => a.kind === "subscription" && a.name === (name || `账号 ${count}`)) || created.accounts?.at(-1);
        if (account) await accountsApi.capture(account.id);
        onSaved?.({ type: "subscription", pid: "tripo" });
      } catch (e) { onSaved?.({ type: "subscription", pid: "tripo", error: String(e.message || e) }); }
    };
    subFlow.state = null; subFlow.host = subBox;
    renderSubscription();
    pollSubscription(true).catch(() => {});
    stopSubTimer();
    subFlow.timer = setInterval(() => pollSubscription(false).catch(() => {}), 3000);
  }
  function mountKeyForm() {
    const box = document.createElement("div");
    box.className = "acct-body";
    const twin = PROVIDERS[state.pid]?.twinKey;
    const count = catalog.accounts.filter((a) => a.provider === state.pid).length + 1;
    const current = catalog.accounts.find((a) => a.provider === state.pid && a.kind === "apikey" && a.active);
    const official = PROVIDERS[state.pid]?.base_url || "";
    const liveUrl = catalog.providers.find((p) => p.id === state.pid)?.base_url || official;
    box.innerHTML =
      `<p class="acct-step-tag">③ 填入 API Key（当前账号：${current ? esc(current.name) : "无"}，新账号默认不切换）</p>` +
      nameField(count) +
      `<label>API 地址（默认官方；有中转/镜像就改成你自己的）<input data-key="url" value="${esc(liveUrl)}" spellcheck="false" placeholder="${esc(official)}"></label>` +
      (twin
        ? `<label>SecretId<input data-key="id" autocomplete="off" spellcheck="false" placeholder="腾讯云 CAM 的 SecretId"></label>
           <label>SecretKey<input data-key="secret" type="password" autocomplete="new-password" placeholder="腾讯云 CAM 的 SecretKey"></label>`
        : `<label>API Key<input data-key="one" type="password" autocomplete="new-password" placeholder="${esc(PROVIDERS[state.pid]?.keyHint || "")}"></label>`) +
      `<p class="acct-note">Key 仅保存在服务器（数据卷），不回显、不写入前端。地址留空或保持官方值都按官方接口调用。填完可继续添加下一条。</p>
       <div class="acct-actions"><button data-save class="primary" disabled>保存账号</button><button data-again disabled>保存并再添加一条</button><button data-close>关闭</button></div>`;
    host.append(box);
    const inputs = box.querySelectorAll("[data-key]");
    const save = box.querySelector("[data-save]"), again = box.querySelector("[data-again]");
    const keyInputs = [...inputs].filter((i) => i.dataset.key !== "url");
    const check = () => { const ok = keyInputs.every((i) => i.value.trim()); save.disabled = !ok; again.disabled = !ok; };
    keyInputs.forEach((i) => i.addEventListener("input", check));
    box.querySelector("[data-close]").addEventListener("click", closeModal);
    const submit = async (keepOpen) => {
      save.disabled = again.disabled = true;
      try {
        await accountsApi.add({
          name: box.querySelector('[data-acct="name"]').value,
          provider: state.pid,
          kind: "apikey",
          api_key: twin
            ? `${box.querySelector('[data-key="id"]').value.trim()}:${box.querySelector('[data-key="secret"]').value.trim()}`
            : box.querySelector('[data-key="one"]').value.trim(),
          base_url: box.querySelector('[data-key="url"]').value.trim() || null,
        });
        if (keepOpen) {
          // 反复添加：清空输入，刷新卡片上的计数
          try { catalog = await accountsApi.list(); } catch {}
          keyInputs.forEach((i) => (i.value = ""));
          const name = box.querySelector('[data-acct="name"]'); if (name) name.value = "";
          check();
          box.querySelector(".acct-note").textContent = "已保存，可继续添加下一条。";
          onSaved?.({ type: "apikey", pid: state.pid, added: true });
        } else {
          closeModal();
          onSaved?.({ type: "apikey", pid: state.pid });
        }
      } catch (e) {
        box.querySelector(".acct-note").textContent = String(e.message || e).slice(0, 240);
        check();
      }
    };
    save.addEventListener("click", () => submit(false));
    again.addEventListener("click", () => submit(true));
  }
  render();
}

/* 暴露给非模块脚本（admin.js 等经典脚本用 window.AigccatAccounts） */
window.AigccatAccounts = { PROVIDERS, openAddAccount, openSubscription, accountsApi };
