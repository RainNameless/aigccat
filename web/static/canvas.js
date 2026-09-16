// aigccat 无限画布 v2 —— 思维导图式资产图谱
// 五级分级：资产库 → 大类 → 细分类目 → 资产 → 版本 → 网格
// 节点带缩略图预览；缩放按钮 + 滚轮；四种布局（树形/径向/网格/打散）+ 搜索定位
export function mountCanvas(ctx) {
  const { host, api, DIR_OF, THREE, GLTFLoader, OrbitControls, RoomEnvironment, modelBounds, fitCamera } = ctx;

  host.innerHTML = `
  <div class="card" style="padding:12px 16px">
    <div class="ops" style="margin:0; align-items:center; flex-wrap:wrap">
      <button class="sm" id="cv-fit">适应视图</button>
      <button class="sm ghost" id="cv-zin">＋</button>
      <button class="sm ghost" id="cv-zout">－</button>
      <span class="stat" id="cv-zoom" style="min-width:46px">100%</span>
      <span style="border-left:1px solid var(--line); height:22px"></span>
      <button class="sm ghost" id="cv-tree">树形</button>
      <button class="sm ghost" id="cv-radial">径向</button>
      <button class="sm ghost" id="cv-grid">网格</button>
      <button class="sm ghost" id="cv-scatter">打散</button>
      <span style="border-left:1px solid var(--line); height:22px"></span>
      <input id="cv-search" placeholder="搜索资产…" style="width:150px">
      <button class="sm ghost" id="cv-go">定位</button>
      <span style="border-left:1px solid var(--line); height:22px"></span>
      <button class="sm ghost" id="cv-note">＋便签</button>
      <button class="sm ghost" id="cv-expand">展开二级</button>
      <button class="sm ghost" id="cv-collapse">全部折叠</button>
      <button class="sm" id="cv-save">保存布局</button>
      <span class="muted" id="cv-info"></span>
    </div>
  </div>
  <div style="display:flex; gap:16px; align-items:flex-start">
    <div class="card" style="flex:1; min-width:0; padding:0; overflow:hidden; position:relative">
      <svg id="cv-svg" style="width:100%; height:1px; display:block; cursor:grab;
        background:radial-gradient(circle at 20% 20%, rgba(34,211,238,.05), transparent 40%), #0a0f1d"></svg>
    </div>
    <div class="card" style="width:340px; max-width:40%; flex-shrink:0; box-sizing:border-box; overflow-y:auto; min-height:0" id="cv-panel">
      <h2>节点属性</h2>
      <div class="muted">未选择节点</div>
    </div>
  </div>`;

  for (const [id, name, label] of [['cv-fit','scan','适应视图'],['cv-zin','plus','放大'],['cv-zout','minus','缩小'],['cv-save','save','保存布局']]) {
    const button = document.getElementById(id); button.title = label; button.setAttribute('aria-label',label); button.innerHTML = `<i data-lucide="${name}"></i>`;
  }
  window.lucide?.createIcons();
  const svg = document.getElementById('cv-svg');
  const NS = 'http://www.w3.org/2000/svg';
  const el = (t, a = {}) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };

  // ---------- 状态 ----------
  let view = { x: 0, y: 0, k: 1 };
  let nodes = [];
  const byId = new Map();
  let selected = null, drag = null, panning = null;
  const metaById = {};
  let itemsByDir = {};
  const STORAGE_KEY = 'aigccat.canvas.v3';
  const layouts = ['tree', 'radial', 'grid', 'scatter'];
  let layout = 'tree', ready = false, persistTimer;
  const snapshot = () => ({ schema: 3, nodes: nodes.map(n => ({ ...n })), layout, view: { ...view }, selected });
  function persist() {
    if (!ready) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); }
    catch (e) { console.warn('画布本地保存失败', e); }
  }
  function resizeCanvas() {
    if (!svg.isConnected) return;
    const bottom = window.visualViewport
      ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight;
    svg.style.height = Math.max(1, bottom - svg.getBoundingClientRect().top) + 'px';
    const panel = document.getElementById('cv-panel');
    panel.style.maxHeight = Math.max(1, bottom - panel.getBoundingClientRect().top) + 'px';
  }
  const resizeObserver = new ResizeObserver(() => {
    if (!svg.isConnected) { resizeObserver.disconnect(); return; }
    resizeCanvas();
  });
  resizeObserver.observe(host);
  resizeObserver.observe(host.firstElementChild);
  window.addEventListener('resize', resizeCanvas);
  window.visualViewport?.addEventListener('resize', resizeCanvas);
  window.addEventListener('pagehide', persist);

  const gRoot = el('g');
  const gEdge = el('g'); const gNode = el('g');
  gRoot.appendChild(gEdge); gRoot.appendChild(gNode);
  svg.appendChild(gRoot);

  // ---------- 数据 ----------
  async function loadLibrary() {
    const r = await api('/api/assets');
    const groups = {};
    (r.assets || []).forEach(a => {
      const dir = DIR_OF[a.asset_type] || 'props';
      metaById[a.asset_id] = { dir, preview: a.preview, name: a.name, status: a.status, version: a.version };
      (groups[dir] = groups[dir] || []).push(a.asset_id);
    });
    return groups;
  }
  async function loadTaxonomy() {
    try {
      const t = await api('/api/taxonomy');
      itemsByDir = {};
      for (const [dir, v] of Object.entries(t)) itemsByDir[dir] = v._items || [];
    } catch { itemsByDir = {}; }
  }
  async function versionsOf(dir, id) {
    const out = [];
    for (let i = 1; i <= 20; i++) {
      const v = 'v' + String(i).padStart(3, '0');
      try { const m = await api(`/api/assets/${dir}/${id}/file/versions/${v}/meta.json`); out.push({ v, meta: m }); }
      catch { break; }
    }
    return out;
  }
  async function meshesOf(dir, id, ver) {
    try {
      const o = await api(`/api/assets/${dir}/${id}/versions/${ver}/outline`);
      return (o.meshes || []).map(m => ({ name: m.name, triangles: m.triangles, vertices: m.vertices }));
    } catch { return []; }
  }

  // ---------- 构建：root → 大类 →（懒）细分类目 →（懒）资产 →（懒）版本 →（懒）网格 ----------
  function add(n) { nodes.push(n); byId.set(n.id, n); return n; }
  const childrenOf = id => nodes.filter(n => n.parent === id);
  const hasChildren = n => ['root', 'cat', 'sub', 'asset', 'version'].includes(n.type)
    && (n.type === 'root' || n.type === 'cat' || childrenOf(n.id).length > 0 || !n.loaded);

  async function build() {
    const groups = await loadLibrary();
    await loadTaxonomy();
    nodes = []; byId.clear();
    add({ id: 'root', parent: null, type: 'root', label: '资产库图谱', x: 0, y: 0, collapsed: false });
    const cats = Object.keys(groups);
    cats.forEach((dir, i) => {
      const ang = (i / Math.max(1, cats.length)) * Math.PI * 2;
      add({ id: 'cat:' + dir, parent: 'root', type: 'cat',
        label: `${dir} (${groups[dir].length})`, dir,
        x: Math.cos(ang) * 620, y: Math.sin(ang) * 420, collapsed: true, loaded: false });
    });
    let saved = null;
    try {
      const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (local?.schema === 3 && Array.isArray(local.nodes)) saved = local;
    } catch {}
    if (!saved) {
      try { saved = await api('/api/canvas'); } catch {}
    }
    const records = Array.isArray(saved?.nodes) ? saved.nodes : [];
    if (saved?.schema === 3 && records.some(n => n.id === 'root')) {
      nodes = []; byId.clear();
      records.forEach(n => add({ ...n }));
      // 完整还原所有已加载节点，包括折叠枝条下的版本与网格。
      // 未加载但展开的节点继续逐级懒加载，不能伪造 loaded 状态。
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n.collapsed && !n.loaded && hasChildren(n)) await expand(n);
      }
    } else if (records.length) {
      // 旧记录缺少懒加载元数据：先沿真实数据链构建，再覆盖坐标和折叠状态。
      const pending = new Map(records.map(n => [n.id, n]));
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i], sn = pending.get(n.id);
        if (!sn) continue;
        if (sn.collapsed === false || records.some(c => c.parent === n.id)) await expand(n);
        Object.assign(n, { x: sn.x ?? n.x, y: sn.y ?? n.y,
          label: sn.label ?? n.label, collapsed: sn.collapsed ?? n.collapsed });
      }
      records.filter(n => n.type === 'note' && !byId.has(n.id))
        .forEach(n => add({ ...n, parent: n.parent ?? 'root', loaded: true }));
    }
    layout = layouts.includes(saved?.layout) ? saved.layout : 'tree';
    selected = byId.has(saved?.selected) ? saved.selected : null;
    resizeCanvas();
    if (!records.length) applyLayout();
    const restoredView = saved?.view;
    if (restoredView && [restoredView.x, restoredView.y, restoredView.k].every(Number.isFinite) && restoredView.k > 0) {
      view = { ...restoredView };
    } else fit();
    ready = true;
    render();
    if (selected) select(byId.get(selected));
    persist();
  }

  const expanding = new Map();
  async function expand(n) {
    if (expanding.has(n.id)) return expanding.get(n.id);
    const work = loadChildren(n);
    expanding.set(n.id, work);
    try { await work; } finally { expanding.delete(n.id); }
  }
  async function loadChildren(n) {
    if (n.type === 'cat' && !n.loaded) {
      const items = itemsByDir[n.dir] || [];
      const subs = {};
      items.forEach(it => (subs[it.subcategory || '其他'] = subs[it.subcategory || '其他'] || []).push(it));
      const keys = Object.keys(subs);
      keys.forEach((sub, i) => {
        const ang = (i / Math.max(1, keys.length)) * Math.PI * 2;
        add({ id: `sub:${n.dir}/${sub}`, parent: n.id, type: 'sub',
          label: `${sub} (${subs[sub].length})`, dir: n.dir, sub,
          x: n.x + Math.cos(ang) * 300, y: n.y + Math.sin(ang) * 240,
          collapsed: true, loaded: false });
      });
      n.loaded = true; n.collapsed = false;
    } else if (n.type === 'sub' && !n.loaded) {
      const items = (itemsByDir[n.dir] || []).filter(it => (it.subcategory || '其他') === n.sub);
      items.forEach((it, i) => {
        const meta = metaById[it.asset_id] || {};
        add({ id: `asset:${n.dir}/${it.asset_id}`, parent: n.id, type: 'asset',
          label: it.name || it.asset_id, dir: n.dir, asset_id: it.asset_id,
          status: meta.status, version: meta.version,
          x: n.x + 200 + (i % 2) * 40, y: n.y - 90 + i * 62,
          collapsed: true, loaded: false });
      });
      n.loaded = true; n.collapsed = false;
    } else if (n.type === 'asset' && !n.loaded) {
      const vers = await versionsOf(n.dir, n.asset_id);
      vers.forEach((v, i) => {
        add({ id: `ver:${n.dir}/${n.asset_id}/${v.v}`, parent: n.id, type: 'version',
          label: `${v.v} · ${v.meta.provider ?? '?'}`, x: n.x + 210, y: n.y - 50 + i * 58,
          dir: n.dir, asset_id: n.asset_id, ver: v.v, meta: v.meta, collapsed: true, loaded: false });
      });
      n.loaded = true; n.collapsed = false;
    } else if (n.type === 'version' && !n.loaded) {
      const ms = await meshesOf(n.dir, n.asset_id, n.ver);
      ms.forEach((m, i) => {
        add({ id: `mesh:${n.id}/${i}`, parent: n.id, type: 'mesh',
          label: `${m.name} · ${m.triangles} tri`, x: n.x + 190, y: n.y - 34 + i * 50,
          mesh: m, collapsed: true, loaded: true });
      });
      n.loaded = true; n.collapsed = false;
    } else { n.collapsed = false; }
    render();
  }

  // 可见性只由祖先的折叠状态决定，与缩放无关。
  function visibleNodes() {
    const out = [];
    const walk = n => {
      out.push(n);
      if (!n.collapsed) childrenOf(n.id).forEach(walk);
    };
    nodes.filter(n => !n.parent).forEach(walk);
    return out;
  }
  async function toggle(n) {
    if (n.collapsed) await expand(n);
    else n.collapsed = true;
    applyLayout(n);
  }

  // ---------- 渲染 ----------
  const COLORS = {
    root: ['var(--accent)', 'var(--panel)'],
    cat: ['var(--accent)', 'var(--panel)'],
    sub: ['var(--muted)', 'var(--panel)'],
    asset: ['var(--muted)', 'var(--panel)'],
    version: ['var(--ok)', 'var(--panel)'],
    mesh: ['var(--accent)', 'var(--panel)'],
    note: ['var(--warn)', 'var(--panel)']
  };
  function nodeSize(n) {
    if (n.type === 'root') return [200, 48];
    if (n.type === 'asset') return [216, 56];
    if (n.type === 'mesh') return [200, 42];
    return [178, 42];
  }

  function render() {
    for (const mode of layouts) {
      const button = document.getElementById('cv-' + mode);
      button.classList.toggle('ghost', mode !== layout);
      button.setAttribute('aria-pressed', String(mode === layout));
    }
    if (ready) { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 150); }
    gRoot.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    gEdge.innerHTML = ''; gNode.innerHTML = '';
    document.getElementById('cv-zoom').textContent = Math.round(view.k * 100) + '%';
    const vis = visibleNodes();
    document.getElementById('cv-info').textContent = `可见 ${vis.length} / 总 ${nodes.length}`;

    vis.forEach(n => {
      if (!n.parent) return;
      const p = byId.get(n.parent);
      if (!p) return;
      const [pw, ph] = nodeSize(p);
      const x1 = p.x + pw, y1 = p.y + ph / 2, x2 = n.x, y2 = n.y + nodeSize(n)[1] / 2;
      const mx = (x1 + x2) / 2;
      gEdge.appendChild(el('path', {
        d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        fill: 'none', stroke: COLORS[n.type]?.[0] || '#334155',
        'stroke-opacity': view.k > 0.8 ? 0.45 : 0.2, 'stroke-width': 1.6 / Math.max(0.6, view.k)
      }));
    });

    vis.forEach(n => {
      const [stroke, fill] = COLORS[n.type] || ['#94a3b8', 'rgba(148,163,184,.08)'];
      const [w, h] = nodeSize(n);
      const g = el('g', { transform: `translate(${n.x},${n.y})`, style: 'cursor:pointer' });
      g.appendChild(el('rect', { width: w, height: h, rx: 6, fill,
        stroke: selected === n.id ? 'var(--text)' : stroke, 'stroke-width': selected === n.id ? 2.4 : 1.3 }));
      let tx = 12;
      if (n.type === 'asset' && n.asset_id && metaById[n.asset_id]?.preview) {
        const url = `/api/assets/${n.dir}/${n.asset_id}/file/${metaById[n.asset_id].preview}`;
        g.appendChild(el('image', { href: url, x: 5, y: 5, width: 46, height: 46,
          preserveAspectRatio: 'xMidYMid slice' }));
        tx = 58;
      }
      const t = el('text', { x: tx, y: 17, fill: '#e2e8f0', 'font-size': 11.5, 'font-weight': 600 });
      const names = {characters:'角色',props:'道具',effects:'特效',vegetation:'植物',grounds:'地面',environments:'环境',buildings:'建筑',vehicles:'载具'};
      t.textContent = (n.type === 'cat' ? (n.label || '').replace(/^\w+/, value => names[value] || value) : n.label || '').slice(0, 20); g.appendChild(t);
      const s = el('text', { x: tx, y: 32, fill: '#64748b', 'font-size': 10 });
      s.textContent = ({root:'资产图谱',cat:'分类',sub:'子分类',asset:'资产',version:'版本',mesh:'网格',note:'便签'})[n.type] || n.type; g.appendChild(s);
      if (n.type === 'asset' && metaById[n.asset_id]?.version) {
        const v = el('text', { x: tx, y: 46, fill: '#34d399', 'font-size': 9.5 });
        v.textContent = metaById[n.asset_id].version; g.appendChild(v);
      }
      if (hasChildren(n) && n.type !== 'note' && n.type !== 'mesh') {
        const b = el('text', { x: w - 18, y: h - 8, fill: stroke, 'font-size': 13, 'font-weight': 700,
          style: 'cursor:pointer' });
        b.textContent = n.collapsed ? '＋' : '－';
        b.addEventListener('mousedown', ev => ev.stopPropagation());
        b.addEventListener('click', ev => {
          ev.stopPropagation();
          toggle(n);
        });
        g.appendChild(b);
      }
      g.addEventListener('mousedown', ev => {
        ev.stopPropagation();
        const pt = toWorld(ev.clientX, ev.clientY);
        drag = { n, dx: pt.x - n.x, dy: pt.y - n.y, moved: false };
      });
      g.addEventListener('click', ev => { ev.stopPropagation(); if (!drag?.moved) select(n); });
      g.addEventListener('dblclick', ev => { ev.stopPropagation(); toggle(n); });
      gNode.appendChild(g);
    });
  }
  function toWorld(cx, cy) {
    const r = svg.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  }

  // ---------- 交互 ----------
  svg.addEventListener('mousedown', ev => {
    if (drag) return;
    panning = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
    svg.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', ev => {
    if (panning) {
      view.x = panning.vx + (ev.clientX - panning.x);
      view.y = panning.vy + (ev.clientY - panning.y);
      render();
    } else if (drag) {
      const pt = toWorld(ev.clientX, ev.clientY);
      drag.n.x = pt.x - drag.dx; drag.n.y = pt.y - drag.dy; drag.moved = true;
      render();
    }
  });
  window.addEventListener('mouseup', () => {
    if (drag && !drag.moved) select(drag.n);
    drag = null; panning = null; svg.style.cursor = 'grab';
  });
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.15 : 0.87);
  }, { passive: false });
  function zoomAt(cx, cy, f) {
    const r = svg.getBoundingClientRect();
    const mx = cx - r.left, my = cy - r.top;
    const k2 = Math.min(3, Math.max(Number.EPSILON, view.k * f));
    view.x = mx - (mx - view.x) * (k2 / view.k);
    view.y = my - (my - view.y) * (k2 / view.k);
    view.k = k2; render();
  }

  // ---------- 侧栏 ----------
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  let preview = null;
  function select(n) {
    selected = n.id; render();
    const p = document.getElementById('cv-panel');
    let thumb = '';
    if (n.type === 'asset' && metaById[n.asset_id]?.preview) {
      thumb = `<img src="/api/assets/${n.dir}/${n.asset_id}/file/${metaById[n.asset_id].preview}"
        style="width:100%; border-radius:10px; margin-bottom:10px; background:#0b1120">`;
    }
    if (n.type === 'cat' || n.type === 'sub') {
      const items = (itemsByDir[n.dir] || []).filter(it =>
        n.type === 'cat' || (it.subcategory || '其他') === n.sub);
      const subs = {};
      items.forEach(it => (subs[it.subcategory || '其他'] = subs[it.subcategory || '其他'] || []).push(it));
      const chips = Object.entries(subs).sort((a, b) => b[1].length - a[1].length)
        .map(([k, v]) => `<span class="chip">${escapeHTML(k)} ${v.length}</span>`).join('');
      const wall = (n.type === 'sub' ? items : items.slice(0, 12)).map(it => {
        const m = metaById[it.asset_id];
        const img = m?.preview
          ? `<img src="/api/assets/${encodeURIComponent(n.dir)}/${encodeURIComponent(it.asset_id)}/file/${escapeHTML(m.preview)}"
             style="width:100%; aspect-ratio:1; object-fit:contain; border-radius:8px; background:#0b1120">`
          : `<div style="width:100%; aspect-ratio:1; border-radius:8px; background:#0b1120"></div>`;
        return `<div data-jump="${escapeHTML(it.asset_id)}" style="cursor:pointer">
          ${img}<div class="muted" style="font-size:10px; margin-top:2px;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${escapeHTML((it.name || it.asset_id).slice(0, 12))}</div></div>`;
      }).join('');
      p.innerHTML = `<h2>NODE · ${n.type === 'sub' ? '细分类目 ' + escapeHTML(n.sub) : '大类 ' + escapeHTML(n.dir)}</h2>
        <div class="muted" style="margin-bottom:8px">${items.length} 个资产</div>
        <div class="chips" style="margin-bottom:10px">${chips}</div>
        <div class="muted" style="margin-bottom:6px">点击缩略图进入该资产 ↓</div>
        <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:6px">${wall}</div>
        <div class="ops"><button class="sm ghost" id="cv-rename">重命名</button>
        <button class="sm ghost" id="cv-del">删除节点</button></div>`;
      p.querySelectorAll('[data-jump]').forEach(d => d.onclick = () => jumpToAsset(n.dir, d.dataset.jump));
      document.getElementById('cv-rename').onclick = () => { const v2 = prompt('新名称', n.label); if (v2) { n.label = v2; render(); } };
      document.getElementById('cv-del').onclick = () => { nodes = nodes.filter(x => x !== n && x.parent !== n.id); selected = null; render(); };
      return;
    }
    p.innerHTML = `<h2>NODE · ${n.type}</h2>
      ${thumb}
      <div style="font-size:14px; margin-bottom:6px">${n.label ?? ''}</div>
      <div class="stat" style="margin-bottom:8px">${n.id}</div>
      <div id="cv-meta" class="muted"></div>
      <div id="cv-glbox" style="width:100%; height:220px; margin-top:10px; border:1px solid var(--line); border-radius:10px"></div>
      <div class="ops">
        ${n.type === 'asset' || n.type === 'version'
          ? `<a class="dl" href="#${n.dir}/${n.asset_id}">打开资产详情</a>` : ''}
        <button class="sm ghost" id="cv-rename">重命名</button>
        <button class="sm ghost" id="cv-del">删除节点</button>
      </div>`;
    document.getElementById('cv-rename').onclick = () => { const v2 = prompt('新名称', n.label ?? ''); if (v2) { n.label = v2; render(); select(n); } };
    document.getElementById('cv-del').onclick = () => { nodes = nodes.filter(x => x !== n && x.parent !== n.id); selected = null; render(); };
    const dir = n.dir, aid = n.asset_id, ver = n.ver || n.version;
    if (n.type === 'asset') {
      const metaBox = document.getElementById('cv-meta');
      versionsOf(n.dir, n.asset_id).then(v => {
        if (selected === n.id && metaBox?.isConnected) metaBox.textContent = `状态 ${n.status ?? '?'} · 版本 ${v.length} 个`;
      });
    } else if (n.type === 'version' && n.meta) {
      const vv = n.meta.validation ?? {};
      document.getElementById('cv-meta').innerHTML =
        `${n.meta.provider} · ${vv.triangles ?? '?'} tri / ${vv.vertices ?? '?'} vert · ${vv.height_m ? vv.height_m.toFixed(2) + 'm' : '—'}`;
    } else if (n.type === 'mesh' && n.mesh) {
      document.getElementById('cv-meta').textContent = `${n.mesh.triangles} tri / ${n.mesh.vertices} vert`;
    } else if (n.type === 'sub') {
      document.getElementById('cv-meta').textContent = `细分类目 · ${childrenOf(n.id).length} 个资产（双击展开）`;
    }
    if (dir && aid && ver && THREE) {
      const box = document.getElementById('cv-glbox');
      try {
        const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0f1d);
        const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 2000);
        const rend = new THREE.WebGLRenderer({ antialias: true });
        rend.setSize(box.clientWidth, 220); box.innerHTML = ''; box.appendChild(rend.domElement);
        const pm = new THREE.PMREMGenerator(rend);
        scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
        scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.5));
        const dl = new THREE.DirectionalLight(0x88ccff, 0.6); dl.position.set(3, 6, 4); scene.add(dl);
        const ctl = new OrbitControls(cam, rend.domElement);
        new GLTFLoader().load(`/api/assets/${dir}/${aid}/file/versions/${ver}/model.glb`, g => {
          const o = g.scene; scene.add(o);
          o.traverse(m => { if (m.isMesh) [].concat(m.material).forEach(mt => { if (mt) mt.side = THREE.DoubleSide; }); });
          if (!box.isConnected) { ctl.dispose(); pm.dispose(); rend.dispose(); return; }
          const bb = modelBounds(o);
          cam.aspect = Math.max(box.clientWidth, 1) / 220;
          fitCamera(cam, bb, new THREE.Vector3(0, 0, 1), ctl);
          preview = rend;
          (function loop() { if (preview !== rend || !box.isConnected) { ctl.dispose(); pm.dispose(); rend.dispose(); return; } requestAnimationFrame(loop); ctl.update(); rend.render(scene, cam); })();
        }, undefined, () => { box.innerHTML = '<div class="muted" style="padding:10px">GLB 加载失败</div>'; });
      } catch { box.innerHTML = '<div class="muted" style="padding:10px">预览失败</div>'; }
    }
  }

  // ---------- 工具栏 ----------
  function fit() {
    const vis = visibleNodes();
    if (!vis.length) return;
    const bounds = vis.reduce((b, n) => {
      const [w, h] = nodeSize(n);
      return [Math.min(b[0], n.x), Math.min(b[1], n.y),
        Math.max(b[2], n.x + w), Math.max(b[3], n.y + h)];
    }, [Infinity, Infinity, -Infinity, -Infinity]);
    const minX = bounds[0] - 24, minY = bounds[1] - 24;
    const maxX = bounds[2] + 24, maxY = bounds[3] + 24;
    const r = svg.getBoundingClientRect();
    const k = Math.min(r.width / (maxX - minX), r.height / (maxY - minY), 1.6);
    if (!(k > 0)) return;
    view.k = k;
    view.x = (r.width - (maxX - minX) * view.k) / 2 - minX * view.k;
    view.y = (r.height - (maxY - minY) * view.k) / 2 - minY * view.k;
    render();
  }
  document.getElementById('cv-fit').onclick = fit;
  document.getElementById('cv-zin').onclick = () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25); };
  document.getElementById('cv-zout').onclick = () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8); };

  function applyLayout(branch = null) {
    const roots = branch ? [branch] : nodes.filter(n => !n.parent);
    const kidsOf = n => n.collapsed ? [] : childrenOf(n.id);
    for (const root of roots) {
      const origin = { x: root.x, y: root.y };
      if (layout === 'tree') {
        let leafY = 0;
        const place = (n, depth) => {
          const kids = kidsOf(n);
          kids.forEach(c => place(c, depth + 1));
          n.x = depth * 280;
          n.y = kids.length ? (kids[0].y + kids[kids.length - 1].y) / 2 : leafY;
          if (!kids.length) leafY += 80;
        };
        place(root, 0);
        const dx = (branch ? origin.x : 0) - root.x;
        const dy = (branch ? origin.y : 0) - root.y;
        const shift = n => { n.x += dx; n.y += dy; kidsOf(n).forEach(shift); };
        shift(root);
      } else {
        if (!branch) { root.x = 0; root.y = 0; }
        const place = (n, angle, depth) => {
          const kids = kidsOf(n);
          const cols = Math.ceil(Math.sqrt(kids.length || 1));
          kids.forEach((c, i) => {
            let a = angle + (i - (kids.length - 1) / 2) * Math.min(0.35, Math.PI / Math.max(1, kids.length));
            if (n.type === 'root') a = i * Math.PI * 2 / Math.max(1, kids.length);
            if (layout === 'grid') {
              c.x = n.x + 280 + (i % cols) * 280;
              c.y = n.y + 80 + Math.floor(i / cols) * 160;
            } else {
              let radius = n.type === 'root' ? 620 : 340;
              if (layout === 'scatter') {
                const seed = [...c.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0);
                a = (seed % 6283) / 1000;
                radius = 300 + seed % 600;
              }
              c.x = n.x + Math.cos(a) * radius;
              c.y = n.y + Math.sin(a) * radius * 0.8;
            }
            place(c, a, depth + 1);
          });
        };
        place(root, Math.atan2(root.y, root.x), 0);
      }
    }
    render();
  }
  for (const mode of layouts) {
    document.getElementById('cv-' + mode).onclick = () => { layout = mode; applyLayout(); };
  }
  document.getElementById('cv-note').onclick = () => {
    const label = prompt('便签内容', '新想法');
    if (!label) return;
    const p = selected ? byId.get(selected) : byId.get('root');
    const n = add({ id: 'note:' + Date.now(), parent: p?.id ?? 'root', type: 'note', label,
      x: (p?.x ?? 0) + 140, y: (p?.y ?? 0) + 70, collapsed: true, loaded: true });
    render(); select(n);
  };
  document.getElementById('cv-expand').onclick = async () => {
    const root = byId.get('root');
    if (root) root.collapsed = false;
    for (const c of nodes.filter(n => n.type === 'cat')) await expand(c);
    // 不改 sub 及更深层的已有状态，支持与单枝展开组合。
    applyLayout();
  };
  document.getElementById('cv-collapse').onclick = () => {
    nodes.forEach(n => { n.collapsed = n.type !== 'root'; });
    applyLayout();
  };
  document.getElementById('cv-save').onclick = async () => {
    const payload = snapshot();
    persist();
    try { await api('/api/canvas', { method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload) });
      document.getElementById('cv-info').textContent = '布局已保存 ' + new Date().toLocaleTimeString();
    } catch (e) { alert('保存失败: ' + e.message); }
  };
  document.getElementById('cv-go').onclick = async () => {
    const q = document.getElementById('cv-search').value.trim().toLowerCase();
    if (!q) return;
    const hit = nodes.find(n => (n.type === 'asset' || n.type === 'version')
      && ((n.label || '').toLowerCase().includes(q) || n.id.toLowerCase().includes(q)));
    if (hit) {
      await jumpToAsset(hit.dir, hit.asset_id);
      if (hit.type === 'version') {
        const asset = byId.get(hit.parent);
        if (asset) { await expand(asset); applyLayout(asset); }
        centerOn(hit); select(hit);
      }
      return;
    }
    for (const [dir, items] of Object.entries(itemsByDir)) {
      const item = items.find(it => `${it.name || ''} ${it.asset_id}`.toLowerCase().includes(q));
      if (item) { await jumpToAsset(dir, item.asset_id); return; }
    }
    document.getElementById('cv-info').textContent = '未找到：' + q;
  };
  async function jumpToAsset(dir, assetId) {
    const root = byId.get('root'), cat = byId.get('cat:' + dir);
    if (!root || !cat) return;
    await expand(root);
    await expand(cat);
    const it = (itemsByDir[dir] || []).find(x => x.asset_id === assetId);
    const sub = byId.get(`sub:${dir}/${it?.subcategory || '其他'}`);
    if (!sub) return;
    await expand(sub);
    const hit = byId.get(`asset:${dir}/${assetId}`);
    if (!hit) return;
    applyLayout(cat);
    centerOn(hit); select(hit);
  }
  function centerOn(n) {
    const r = svg.getBoundingClientRect();
    view.k = Math.max(view.k, 0.8);
    view.x = r.width / 2 - (n.x + 100) * view.k;
    view.y = r.height / 2 - (n.y + 25) * view.k;
    render();
  }

  build();
}
