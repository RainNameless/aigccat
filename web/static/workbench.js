import { openRigAgent } from './rig-agent.js?v=2';
import { assetImages } from './asset-images.js?v=1';
import { createAssetTransition } from './asset-transition.js?v=2';
import { mountAssetProgress } from './asset-progress.js?v=1';
import { examples } from './creative-examples.js?v=1';
import { creationConfig, readCreationConfig } from './creation-settings.js?v=1';
import { mountProjects } from './project-folders.js?v=2';
import { createGenerationIndicator } from './generation-indicator.js?v=1';
import { studioMotions, motionCategories } from './studio-motions.js?v=1';
import { moveToTrash, trashResult } from './asset-trash.js?v=2';
import { mountModelActions } from './model-actions.js?v=5';
import * as THREE from "three";
import { viewerTools } from "./viewer.js?v=opened-cache-19";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { starterPresets, loadPresets, savePresets } from './creative-presets.js?v=1';

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name) => `<i data-lucide="${name}"></i>`;
const icons = () => window.lucide?.createIcons();
const TOOLS = [
  ["image", "图片创作", "创作图片", "panels-top-left"],
  ["model", "模型构建", "构建模型", "cuboid"],
  ["split", "部件管理", "分离模型部件", "component"],
  ["remesh", "网格整理", "优化网格结构", "triangle"],
  ["uv", "UV 展开", "展开 UV 坐标", "grid-2x2"],
  ["texture", "贴图处理", "贴图处理", "swatch-book"],
  ["paint", "贴图绘制", "绘制表面颜色", "brush", "texture"],
  ["upscale", "贴图尺寸", "调整贴图尺寸", "scaling", "texture"],
  ["pbr", "材质参数", "调整材质参数", "sliders-horizontal", "texture"],
  ["rig", "绑骨蒙皮", "自动绑定骨骼", "bone"],
  ["animation", "动作制作", "动作预设与播放", "clapperboard"],
];
const TYPES = {
  character: ["角色", "characters"],
  animal: ["动物", "animals"],
  prop: ["道具", "props"],
  building: ["建筑", "buildings"],
  environment: ["环境", "environments"],
  vegetation: ["植被", "vegetation"],
  ground: ["地面", "grounds"],
  sky: ["天空", "skies"],
  vehicle: ["载具", "vehicles"],
  apparel: ["服装", "apparel"],
  material: ["材质", "materials"],
  effect: ["特效", "effects"],
};
const STATUS = {
  published: "已发布",
  approved: "模型已生成",
  model_review: "模型已生成",
  imported: "已导入",
  spec_ready: "描述就绪",
  reference_review: "参考图已生成",
  reference_approved: "参考图已就绪",
  running: "运行中",
  done: "完成",
  failed: "失败",
  waiting: "待查询",
  unknown: "提交待确认",
};
const defaults = {
  prompt: "",
  imageModel: "",
  imageRatio: "1:1",
  imageCount: "1",
  imageResolution: "1080",
  imageModelId: "",
  imageInput: "text",
  mode: "text",
  modelSource: "studio",
  tripoModel: "",
  studioModel: "v3.0-20250812",
  tripoFaces: "",
  geometryQuality: "",
  textureQuality: "standard",
  textureSize: "2048",
  modelQuad: false,
  tripoTexture: true,
  tripoPbr: false,
  assetName: "",
  assetType: "prop",
  faces: 5000,
  topology: "voxel",
  voxel: 0.035,
  ratio: 0.5,
  faceCap: "none",
  textureMode: "studio",
  texturePrompt: "",
  textureInput: "reference",
  style: "圆润卡通",
  pose: false,
  height: 1.25,
  splitMethod: "loose",
  mesh: "",
  color: "#c7c9cb",
  roughness: 0.5,
  metalness: 0,
  resolution: 2048,
  animation: "turntable",
  animationPanel: "clips",
  studioMotion: "hug",
  motionCategory: "all",
  duration: 4,
  paintSize: 18,
  scale: 1,
  rotation: 0,
};
let prefs = { favorites: [], archived: [], settings: {} },
  form = { ...defaults },
  tool = "model",
  allAssets = [],
  current = null,
  version = "",
  detail = null,
  historyTree = null;
let collection = "all",
  managing = false,
  checked = new Set(),
  uploads = {},
  imageTarget = "front",
  busy = false,
  selectionSerial = 0,
  saveTimer,
  toastTimer,
  currentTab = "assets",
  meshes = [],
  selectedMesh = null,
  pickStart,
  painting = false;
let creationOptions=creationConfig();
let studioHealth=null;
function renderServiceStatus(){
  const studio=form.modelSource==='studio';const ready=studioHealth?.ready;
  $('service-status').textContent=studio?(ready?'网页订阅 · 已连接':studioHealth?'网页订阅 · 未连接':'网页订阅 · 检查连接…'):'Tripo API';
  $('service-status').title=studio?(ready?'后台执行器可用；历史失败请在任务记录查看':studioHealth?.error||'正在检查当前连接'):'';
}
async function refreshStudioHealth(){try{studioHealth=await api('/api/studio/status');}catch{studioHealth={ready:false,error:'本站服务暂不可达'};}renderServiceStatus();}
setInterval(refreshStudioHealth,30000);
let versionLabels = {};
let creationState = null,
  assetMedia = [],
  imageInventory = [],
  selectedImage = null,
  imageResults = [],
  currentJobs = [],
  activePolls = new Map(),
  serviceInfo = {},
  modelCatalog = {models:[],providers:[]};
const objectURLs = new Set(),
  undoCheckout = [];

async function api(path, options = {}) {
  const headers =
    options.body && !(options.body instanceof FormData)
      ? { "Content-Type": "application/json" }
      : {};
  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!response.ok) {
    const message = await response.text();
    if (response.status === 413) throw new Error('上传内容超过大小限制，请缩小图片或模型文件后重试');
    throw new Error(
      `${response.status} · ${message.slice(0, 800) || response.statusText}`,
    );
  }
  return response.json();
}
const post = (path, body = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
const put = (path, body) =>
  api(path, { method: "PUT", body: JSON.stringify(body) });
const dirOf = (a) => TYPES[a.asset_type]?.[1] || "props";
const keyOf = (a) => `${dirOf(a)}/${a.asset_id}`;
const baseOf = (a) => `/api/assets/${keyOf(a)}`;
const fileURL = (a, key) =>
  `${baseOf(a)}/file/${key.split("/").map(encodeURIComponent).join("/")}`;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 7000);
}
function safe(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      toast(error.message);
      console.error(error);
    }
  };
}
let pendingPrefs = {};
function persist(patch) {
  prefs = { ...prefs, ...patch };
  pendingPrefs = { ...pendingPrefs, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(
    () => {
      const changed = pendingPrefs; pendingPrefs = {};
      put("/api/workbench/state", changed).catch((e) =>
        toast("设置保存失败：" + e.message),
      );
    },
    350,
  );
}
function updateForm(name, value) {
  form[name] = value;
  persist({ settings: form });
}
function modal(title, html) {
  $("dialog-title").textContent = title;
  $("dialog-body").innerHTML = html;
  if (!$("dialog").open) $("dialog").showModal();
  icons();
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function base64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
async function png(file, maxEdge = 1024) {
  if (file.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20 MB");
  const bitmap = await createImageBitmap(file);
  if (bitmap.width > 8192 || bitmap.height > 8192) {
    bitmap.close();
    throw new Error("图片尺寸不能超过 8192 像素");
  }
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function bounds(obj) {
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.skeleton?.update();
      o.computeBoundingBox();
      // Derive the culling sphere from the already evaluated skinned bounds.
      o.boundingSphere ||= new THREE.Sphere();
      o.boundingBox.getBoundingSphere(o.boundingSphere);
    }
  });
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) throw new Error("模型没有几何体");
  return box;
}
function fit(camera, box, direction, controls) {
  const center = box.getCenter(new THREE.Vector3()),
    size = box.getSize(new THREE.Vector3()),
    span = Math.max(size.length(), 0.0001),
    back = direction.clone().normalize(),
    right = new THREE.Vector3().crossVectors(camera.up, back).normalize(),
    up = new THREE.Vector3().crossVectors(back, right).normalize();
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  let distance = 0;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const p = new THREE.Vector3(x, y, z).sub(center);
        distance = Math.max(
          distance,
          p.dot(back) + (1.15 * Math.abs(p.dot(right))) / (tan * camera.aspect),
          p.dot(back) + (1.15 * Math.abs(p.dot(up))) / tan,
        );
      }
  camera.position.copy(center).addScaledVector(back, distance);
  camera.near = span * 0.001;
  camera.far = span * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  if (!controls) return;
  controls.target.copy(center);
  controls.minDistance = span * 0.03;
  controls.maxDistance = span * 20;
  controls.update();
}
const viewers = viewerTools(bounds, fit),
  viewer = viewers.createViewer($("model-stage"));
// Keep one playback toolbar; mount it only inside the model-actions panel.
viewer.animationUI.remove();
const assetTransition=createAssetTransition(document.querySelector('.studio-layout'),document.querySelector('.viewport'));
viewer.container.addEventListener('viewer-load-progress',event=>{
  const p=event.detail;
  if(p.stage==='download')assetTransition.update(selectionSerial,p.total?`2 / 3 · 模型下载 ${Math.min(100,Math.round(p.loaded/p.total*100))}%`:`2 / 3 · 已接收 ${(p.loaded/1048576).toFixed(1)} MiB`,p.total?p.loaded/p.total*100:undefined);
  else assetTransition.update(selectionSerial,'2 / 3 · 准备模型与贴图');
});
const generationIndicator = createGenerationIndicator(document.querySelector('.viewport'));
function syncGeneration() {
  const job = currentJobs.filter(j=>['model_build','model_process'].includes(j.kind)).sort((a,b)=>Number(a.job_id?.split('_').pop())-Number(b.job_id?.split('_').pop())).at(-1);
  generationIndicator.update(tool === 'model' && current ? job : null, current ? keyOf(current) : '');
}
$('model-stage').addEventListener('viewer-model-state',()=>{
  document.querySelector('.viewport').dataset.hasModel=String(!!viewer.obj);
  renderRail();
});
document.querySelector('.viewport').dataset.hasModel='false';
$("model-stage").addEventListener('viewer-download',event=>{event.preventDefault();exportDialog();});

// 顶部流程步骤：图片 → 模型 → 整理 → 表面 → 动作，明确"一个资产是怎么做出来的"
const FLOW_STEPS = [
  ["image", "1 参考", "文字和图片生成四视图，确认后建模"],
  ["model", "2 建模", "已确认的多视图 → Tripo → 模型"],
  ["remesh", "3 整理", "减面 / 重拓扑 / UV 展开"],
  ["texture", "4 贴图", "纹理、材质、贴图绘制"],
  ["rig", "5 绑骨", "AI 操作本地 Blender 绑定骨骼并生成动作"],
  ["animation", "6 动作", "播放已有动作，或让 AI 操作 Blender 制作动作"],
];
// 用资产的真实产物判断每一步是否已完成（不再依赖工具切换顺序，跨工具乱序也不会失真）
function flowDone() {
  const jobs = currentJobs;
  const hasKind = (...kinds) => jobs.some(j => kinds.includes(j.kind) && j.status === "done");
  const hasOp = (...ops) => jobs.some(j => j.kind === "model_process" && j.status === "done"
    && ops.includes(j.operation || j.options?.operation));
  return {
    image: !!current && (assetMedia.some(i => i.kind === "reference" || i.kind === "generated")
      || hasKind("image_generate", "reference_generate", "reference_approve")),
    model: !!version || hasKind("model_build"),
    remesh: hasOp("decimate", "remesh", "quad") || hasKind("model_process")
      && currentJobs.some(j => j.kind === "model_process" && ["decimate", "remesh", "quad", "uv"].includes(j.operation || j.options?.operation)),
    texture: meshes.some(m=>[m.material].flat().some(mat=>mat?.map)) || hasOp("texture", "material", "upscale"),
    rig: meshes.some(m=>m.isSkinnedMesh),
    animation: viewer.clips.length>0 || hasOp("animation"),
  };
}
function renderFlowSteps() {
  const host = $("flow-steps");
  if (!host) return;
  const done = flowDone();
  if (tool === 'model' || !viewer.obj) {
    host.innerHTML = [['image','1 准备参考'],['model','2 生成模型'],['texture','3 完善模型']].map(([t,label])=>`<button data-flow-tool="${t}" ${t==='texture'&&!viewer.obj?'disabled':''} class="${t===tool?'active ':''}${done[t]?'done':''}" aria-current="${t===tool}">${label}</button>`).join('');
    host.querySelectorAll('[data-flow-tool]').forEach(b=>b.onclick=()=>selectTool(b.dataset.flowTool));
    return;
  }
  host.innerHTML = FLOW_STEPS.map(([t, label, hint]) =>
    `<button data-flow-tool="${t}" class="${t === tool ? "active " : ""}${done[t] ? "done" : ""}" title="${esc(hint)}" aria-current="${t === tool}">${esc(label)}</button>`
  ).join("");
  host.querySelectorAll("[data-flow-tool]").forEach(b => (b.onclick = () => selectTool(b.dataset.flowTool)));
}
function renderRail() {
  $("tool-rail").innerHTML = TOOLS.filter(t=>viewer.obj || ["image","model"].includes(t[0])).filter(
    (t) =>
      !t[4] || tool === t[4] || TOOLS.find((t) => t[0] === tool)?.[4] === t[4],
  )
    .map(
      (t) =>
        `<button data-tool="${t[0]}" class="${tool === t[0] ? "active " : ""}${t[4] ? "subtool" : ""}" title="${t[1]}" aria-label="${t[1]}" aria-pressed="${tool === t[0]}">${icon(t[3])}<span>${t[1]}</span></button>`,
    )
    .join("");
  $("tool-rail")
    .querySelectorAll("[data-tool]")
    .forEach((b) => (b.onclick = () => selectTool(b.dataset.tool)));
  icons();
}
function choices(name, items) {
  return `<div class="segmented" role="group" aria-label="${esc(name)}">${items.map(([value, label]) => `<button title="${esc(({single:'单图',multi:'多视图',batch:'批量',text:'文本'})[value] || String(label).replace(/<[^>]*>/g, ''))}" data-choice="${name}" data-value="${value}" class="${String(form[name]) === String(value) ? "active" : ""}" aria-pressed="${String(form[name]) === String(value)}">${label}</button>`).join("")}</div>`;
}
function field(label, html) {
  return `<label class="field">${label}</label>${html}`;
}
function select(name, items) {
  return `<select class="full" data-field="${name}" aria-label="${name}">${items.map(([v, label]) => `<option value="${v}" ${String(form[name]) === String(v) ? "selected" : ""}>${label}</option>`).join("")}</select>`;
}
function numeric(name, min, max, step = 1) {
  return `<div class="numeric"><input data-field="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${form[name]}" aria-label="${name}滑块"><input data-field="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${form[name]}" aria-label="${name}"></div>`;
}
function toggle(name, label) {
  return `<label class="toggle">${label}<input type="checkbox" data-field="${name}" ${form[name] ? "checked" : ""}></label>`;
}
function uploadBox(view, label, small = false) {
  return `<button class="drop-zone ${small ? "small" : ""}" data-upload="${view}" title="${label}" aria-label="${label}">${uploads[view]?.url ? `<img src="${uploads[view].url}" alt="${label}">` : `${icon(view === 'batch' ? 'gallery-horizontal-end' : 'file-image')}<span>${uploads[view]?.files ? uploads[view].files.length + ' 张参考图' : label}</span>`}</button>`;
}
// 造型风格：缩略图网格（每个风格用内联 SVG 表达形体语言，不依赖外部图片资源）
const STYLE_THUMBS = [
  ["圆润卡通", "大眼圆脸、粗轮廓、夸张比例", `<circle cx="16" cy="11" r="7"/><path d="M9 20h14l-2 14H11z"/><circle cx="13" cy="11" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="11" r="1.6" fill="currentColor" stroke="none"/>`],
  ["写实", "真实人体比例与细节", `<circle cx="16" cy="9" r="5"/><path d="M11 15h10v12h-3v7h-2v-7h-1v7h-2v-7h-2z"/>`],
  ["低多边形", "块面切割、硬朗切角", `<path d="M16 4l7 5-2 8-5 3-5-3-2-8z"/><path d="M11 17l5 12 5-12"/><path d="M16 4v13"/>`],
  ["黏土", "柔和塑形、手工质感", `<ellipse cx="16" cy="10" rx="6" ry="6.5"/><path d="M10 17c0 5 3 6 6 6s6-1 6-6"/><path d="M13 9.5h1.6M17.4 9.5H19"/>`],
  ["机械科幻", "硬边装甲、关节圆轴承", `<rect x="13" y="4" width="6" height="6" rx="1"/><rect x="8" y="12" width="16" height="9" rx="2"/><circle cx="12" cy="17" r="2.2"/><circle cx="20" cy="17" r="2.2"/><path d="M12 21v6M20 21v6"/>`],
];
function styleGrid() {
  return `<label class="field">造型风格</label><div class="style-grid">${STYLE_THUMBS.map(([value, hint, svg]) =>
    `<button class="style-card ${form.style === value ? "active" : ""}" data-style="${esc(value)}" title="${esc(hint)}" aria-pressed="${form.style === value}"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">${svg}</svg><strong>${esc(value)}</strong></button>`
  ).join("")}</div>`;
}
function uploadHint(kind = "reference") {
  const rules = kind === "batch"
    ? "支持 PNG / JPEG / WebP · 单张 ≤ 20 MB · 最多 10 张"
    : kind === "texture"
      ? "支持 PNG / JPEG / WebP · 单张 ≤ 20 MB · 建议正方形无缝纹理"
      : kind === "multi"
        ? "四视图更稳：正 / 左 / 右 / 背各一张 · 建议同光照同比例 · 像素 512–4096"
        : "支持 PNG / JPEG / WebP · 单张 ≤ 20 MB · 建议短边 ≥ 512 像素";
  return `<p class="upload-hint">${icon("info")} ${rules} · 拖拽或粘贴图片也可上传</p>`;
}
function source() {
  const preview = ['texture','paint','upscale','pbr'].includes(tool)?null:current && version ? `versions/${version}/preview.png` : current?.preview;
  return `${preview ? `<img class="operation-thumb" src="${fileURL(current, preview)}" alt="当前版本" onerror="this.hidden=true">` : ""}<div class="source-name">${current ? esc(current.name) + " · " + esc(version || "无模型") : "未选择模型"}</div>`;
}
function meshSelect() {
  return field(
    "目标部件",
    select("mesh", [
      ["", "全部部件"],
      ...meshes.map((m) => [esc(m.name), esc(m.name)]),
    ]),
  );
}
function materialFields() {
  return `<label class="toggle">基础颜色<input data-field="color" type="color" value="${form.color}" aria-label="基础颜色"></label>${field("粗糙度", numeric("roughness", 0, 1, 0.05))}${field("金属度", numeric("metalness", 0, 1, 0.05))}`;
}
function promptBox() {
  return `<div class="prompt-box"><textarea data-field="prompt" aria-label="创作提示词" placeholder="描述你想制作的人物或物件，也可以加入图片作为参考…" maxlength="10000">${esc(form.prompt)}</textarea><button class="prompt-upload" data-upload="input" title="上传参考图片">${uploads.input ? `<img src="${uploads.input.url}" alt="当前参考图片"><span>点击更换图片</span>` : `${icon('image-plus')}<strong>拖入图片</strong><span>或点击上传 · 可选</span>`}</button><div class="prompt-bottom">${uploads.input ? `<button id="remove-reference" title="移除参考图">${icon('x')}移除图片</button>` : '<small>PNG / JPEG / WebP</small>'}<span>${form.prompt.length}/10000</span></div></div>`;
}
function exampleCards(kind='purpose') {
  return `<div class="example-grid">${examples.map(e=>`<button class="example-card" data-example="${e.id}" title="${esc(e.hint)}"><img src="${e.image}" alt="${esc(e.name+' · '+e.style)}"><strong>${esc(kind==='style'?e.style:e.name)}</strong><small>${esc(e.hint)}</small></button>`).join('')}</div>`;
}
function promptActions() {
  return `<div class="creative-actions"><button id="open-presets" title="查看图文案例">${icon('book-open')}案例</button><button id="enrich-prompt" title="AI 扩写描述 · 调用付费文本服务">${icon('wand-sparkles')}扩写</button><button id="global-style" title="查看风格图片并选择">${icon('palette')}风格</button></div>`;
}
async function styleDialog() {
  const style = await api('/api/styleprofile');
  modal('选择整体风格', `<p>点击图片选择风格；用途案例不会限制你创作的主体。</p>${exampleCards('style')}<details><summary>微调风格与配色</summary><label class="field">画面风格<input id="style-keywords" value="${esc(style.style_keywords)}"></label><label class="field">主要颜色<input id="style-palette" value="${esc(style.color_palette)}"></label><label class="field">人物比例（非人物可忽略）<input id="style-ratio" value="${esc(style.head_body_ratio)}"></label></details><p id="style-selection" role="status">选择后点击保存，应用于后续图片创作。</p><button id="save-style-profile" class="primary">保存风格</button>`);
  $('dialog-body').querySelectorAll('[data-example]').forEach(b=>b.onclick=()=>{
    const e=examples.find(e=>e.id===b.dataset.example);
    $('style-keywords').value=e.style;$('style-palette').value=e.palette;$('style-ratio').value=e.ratio;
    $('style-selection').textContent='已选择：'+e.style;
    $('dialog-body').querySelectorAll('[data-example]').forEach(x=>x.classList.toggle('active',x===b));
  });
  $('save-style-profile').onclick = safe(async()=>{
    await put('/api/styleprofile',{style_keywords:$('style-keywords').value,color_palette:$('style-palette').value,head_body_ratio:$('style-ratio').value});
    $('dialog').close(); toast('风格已保存');
  });
}
let motionImageObserver;
function bindStudioMotionLibrary() {
  const grid = $('studio-motion-grid');
  function render() {
    motionImageObserver?.disconnect();
    const query = $('motion-search').value.trim().toLowerCase();
    const items = studioMotions.filter(m => (form.motionCategory === 'all' || m.category === form.motionCategory) && (m.name + ' ' + m.id).toLowerCase().includes(query));
    grid.innerHTML = items.map(m => `<button class="anim-card studio-motion-card ${form.studioMotion===m.id?'active':''}" data-studio-motion="${m.id}" aria-pressed="${form.studioMotion===m.id}" title="${esc(m.name)}"><span class="motion-image"><img data-preview-src="${m.path}" alt="${esc(m.name)}白模动画" decoding="async"></span><strong>${esc(m.name)}</strong><span class="motion-selected" aria-hidden="true">✓</span></button>`).join('') || '<p class="help-line">没有匹配的动作</p>';
    motionImageObserver = new IntersectionObserver(entries => entries.forEach(({target,isIntersecting})=>{
      if(isIntersecting && !target.src) target.src=target.dataset.previewSrc;
    }), {root:$('parameters'),rootMargin:'150px'});
    grid.querySelectorAll('img').forEach(img=>{
      motionImageObserver.observe(img);
      img.onerror=()=>{img.alt='预览加载失败';img.closest('button').title='预览加载失败，请刷新重试';};
    });
    grid.querySelectorAll('[data-studio-motion]').forEach(button=>button.onclick=()=>{
      updateForm('studioMotion',button.dataset.studioMotion);
      grid.querySelectorAll('[data-studio-motion]').forEach(b=>{
        const selected=b===button;b.classList.toggle('active',selected);b.setAttribute('aria-pressed',String(selected));
      });
      $('operation-context').textContent='已选择：'+studioMotions.find(m=>m.id===form.studioMotion).name+' · 预览';
    });
  }
  $('motion-search').oninput=render;
  $('parameters').querySelectorAll('[data-motion-category]').forEach(button=>button.onclick=()=>{
    updateForm('motionCategory',button.dataset.motionCategory);
    $('parameters').querySelectorAll('[data-motion-category]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
    render();
  });
  render();
}
let disposeMotionPreviews = () => {};
function renderParameters() {
  motionImageObserver?.disconnect();
  disposeMotionPreviews();
  disposeMotionPreviews = () => {};
  const entry = TOOLS.find((t) => t[0] === tool);
  $("tool-title").innerHTML = icon(entry[3]) + entry[2];
  let html = "",
    action = "",
    context = "本地 Blender · 保存为新版本";
  // 需要已选资产 + 模型版本的工具：未满足时给出明确引导并禁用运行按钮
  const needsModel = ["split", "remesh", "uv", "texture", "paint", "upscale", "pbr", "rig", "animation"];
  let missingRequirement = "";
  if (needsModel.includes(tool) && !current)
    missingRequirement = "此工具需要一个已有模型版本的资产。先在右侧资产栏选择，或到「模型构建」生成。";
  else if (needsModel.includes(tool) && current && !version)
    missingRequirement = `资产「${current.name}」还没有模型版本。先在「模型构建」生成，或从版本下拉选择已有版本。`;

  if (missingRequirement)
    html += `<div class="tool-requirement" role="note">${icon("triangle-alert")}<span>${esc(missingRequirement)}</span><button class="req-link" data-goto-tool="model">去生成模型</button></div>`;
  if (tool === "image") {
    const imageModels=modelCatalog.models.filter(m=>m.enabled && m.service==='image');
    if(!imageModels.some(m=>m.id===form.imageModelId)) form.imageModelId=(imageModels.find(m=>m.default)||imageModels[0])?.id||'';
    html = promptBox() + promptActions() +
      field('图像模型',select('imageModelId',imageModels.length?imageModels.map(m=>[m.id,esc(m.model)]):[['','暂无可用模型']])) +
      field('目标分辨率',choices('imageResolution',[['1080','1080p'],['2048','2K'],['3840','4K']])) +
      '<p class="help-line">四张独立图片 · 正面 / 背面 / 左侧 / 右侧</p>';
    action = '生成四视图';
    context = `${creationOptions.allowMultiple?creationOptions.count:1} 组 × 4 张参考图 · ${form.imageResolution==='1080'?'1080p':form.imageResolution==='2048'?'2K':'4K'}`;
  } else if (tool === "model") {
    const studio=form.modelSource==='studio';
    const models = studio ? ['v3.0-20250812','v3.1-20260211','v2.5-20250123'].map(model=>({id:model,model})) : modelCatalog.models.filter(m=>m.enabled && m.service==='model3d');
    if (!studio && !models.some(m=>m.id===form.tripoModel)) form.tripoModel=(models.find(m=>m.default)||models[0])?.id||'';
    form.mode='multi';
    const selectedModel=studio?form.studioModel:models.find(m=>m.id===form.tripoModel)?.model;
    const maxFaces=selectedModel?.startsWith('P1')?20000:selectedModel?.startsWith('v2.5')?500000:selectedModel?.startsWith('v3.0')?1000000:studio?2000000:1500000;
    if(Number(form.tripoFaces)>maxFaces)form.tripoFaces=String(maxFaces);
    if(form.studioModel!=='v3.1-20260211')form.geometryQuality='';
    html = choices('modelSource', [['studio','网页订阅'],['api','API']]) +
      '<p class="help-line">先确认多视图，再生成模型。只有一张图？先补齐其他视角。</p>' +
      uploadBox('front','正面参考 · 点击上传') + `<div class="upload-grid">${uploadBox('side','左侧',true)}${uploadBox('back','背面',true)}${uploadBox('right','右侧',true)}</div>` +
      '<button id="prepare-multiview" class="full">从文字或图片生成四视图</button><button id="load-multiview" class="full">从已创建好的四视图加载</button>' +
      field('资产名称（可选）', `<input class="full" data-field="assetName" aria-label="资产名称" placeholder="留空使用资源 ID" value="${esc(form.assetName)}">${current?'<button id="save-asset-name" class="full">保存名称</button>':''}`) +
      (!current ? field('资产分类',select('assetType',Object.entries(TYPES).map(([k,v])=>[k,v[0]]))) : '') +
      field('3D 模型',select(studio?'studioModel':'tripoModel',models.map(m=>[m.id,esc(m.model.startsWith('P1')?'P1 · 低多边形':m.model)]))) +
      field('目标面数',select('tripoFaces',[['','自动（由模型决定）'],...[500,2000,5000,10000,20000,50000,100000,500000,1000000,1500000,2000000].filter(n=>n<=maxFaces).map(n=>[String(n),n.toLocaleString()])])) +
      (studio ? (form.studioModel==='v3.1-20260211'?field('几何精度',select('geometryQuality',[['','标准'],['detailed','高精度 · 更多细节']])):'') + toggle('modelQuad','四边面拓扑') : '') +
      toggle('tripoTexture','生成纹理') + (form.tripoTexture ? toggle('tripoPbr','PBR 材质') + (studio ? field('贴图质量',select('textureQuality',[['standard','标准'],['extreme','极高 · 细节优先']])) + field('导出贴图尺寸',choices('textureSize',[['2048','2K'],['4096','4K'],['8192','8K']])) + '<p class="help-line">尺寸为导出目标；实际细节取决于生成结果。高精度与高质量贴图会增加积分和等待时间。</p>' : '') : '') +
      `<a class="help-line" href="/settings.html">${studio?"模型设置":"模型配置 · 地址与 Key"}</a><p class="help-line">${form.mode==='batch'?'每张图片生成一个独立资产，依次执行，失败后停止。':(studio?'使用网页订阅积分，后台自动生成、下载并保存到当前资产。':'直接调用 Tripo，完成后保存模型和新版本。')}${version?'重新生成会保留现有版本。':''}</p>` +
      (version ? '<button id="review-model">查看模型四视图</button>' : '');
    action = version ? '重新生成模型' : '生成模型';
    context = 'Tripo API · 生成完成后可预览与下载';
    context = studio ? `Studio 后台生成 · ${form.geometryQuality==='detailed'?'高精度':'标准几何'} · ${form.tripoTexture?(form.textureQuality==='extreme'?'极高贴图':'标准贴图')+' · '+(Number(form.textureSize)/1024)+'K 导出':'白模'}` : context;
    renderServiceStatus();


  } else if (tool === "split") {
    html =
      source() +
      field(
        "拆分依据",
        choices("splitMethod", [
          ["loose", "连通部件"],
          ["material", "材质"],
          ["presplit", "预分割"],
        ]),
      ) +
      `<p class="help-line">${
        form.splitMethod === "presplit"
          ? "按大于 35° 的锐边拆分几何部件；不识别头、躯干等语义，平滑表面可能不分开。"
          : "连通部件 = 按几何连通性拆分；材质 = 按材质分组拆分。"
      }</p>` +
      meshSelect();
    action = form.splitMethod === "presplit" ? "执行预分割" : "开始拆分";
  } else if (tool === "remesh") {
    html =
      source() +
      field(
        "处理方式",
        choices("topology", [
          ["voxel", "体素"],
          ["quad", "四边面"],
          ["decimate", "减面"],
        ]),
      ) +
      meshSelect();
    html +=
      form.topology === "voxel"
        ? field("体素尺寸 / 米", numeric("voxel", 0.005, 0.2, 0.005))
        : form.topology === "quad"
          ? field("目标面数", numeric("faces", 500, 100000, 500)) +
            field(
              "档位",
              choices("faceTier", [
                ["", "自定义"],
                ["2000", "低 · 2k"],
                ["8000", "中 · 8k"],
                ["30000", "高 · 30k"],
              ]),
            ) +
            `<small>GLB 交付时自动三角化。</small>`
          : field("保留比例", numeric("ratio", 0.01, 1, 0.01));
    html += `<button id="unwrap" class="full" style="border:1px solid #45474a;margin-top:18px">${icon("unfold-horizontal")}UV 展开</button>`;
    action = "应用重拓扑";
  } else if (tool === "uv") {
    html =
      source() +
      `<p class="help-line">为模型生成 UV 坐标（智能展开）。展开后可到「贴图处理」做文生/图生纹理，或用「贴图绘制」手绘。</p>` +
      meshSelect() +
      field(
        "展开方式",
        choices("uvMode", [
          ["smart", "智能展开"],
          ["angle", "角度展开"],
        ]),
      );
    action = "展开 UV";
    context = "生成 UV 坐标 → 可做纹理";
  } else if (tool === "rig") {
    html = source() + '<p class="help-line">让 AI 检查当前模型，操作本地 Blender 绑定骨骼并制作动作。窗口里可查看执行记录和检查图，结果保存为新版本。</p>' +
      (current?.asset_type==='character' ? '<details><summary>其他绑定方式</summary><p class="help-line">Studio 人物绑定适合 T / A 姿势的类人模型，使用网页订阅积分。</p><button id="studio-human-rig" class="full">使用 Studio 人物绑定</button></details>' : '');
    action = "打开 AI 绑骨助手";
    context = "OpenCode · 本地 Blender";
  } else if (tool === "texture") {
    html =
      source() +
      field(
        "纹理方式",
        choices("textureMode", [
          ["studio", "AI 贴图"],
          ["generate", "平铺纹理"],
          ["upload", "已有贴图"],
          ["brush", "手动绘制"],
        ]),
      ) +
      (form.textureMode === "brush"
        ? `<p class="help-line">直接在模型上绘制颜色，保存为新版本。模型需要已有 UV。</p><button class="full" data-goto-tool="paint">打开贴图绘制</button>`
        : "") +
      (form.textureMode === "studio" ? choices('textureInput',[['text','文字描述'],['reference','四视图参考']]) + (form.textureInput==='text' ? field('贴图描述',`<textarea data-field="texturePrompt" aria-label="贴图描述" placeholder="例如：黑色战术服、棕色皮革腰带、银色金属扣，保留原有造型">${esc(form.texturePrompt)}</textarea>`) : '<p class="help-line">使用当前资产已保存的前后左右参考图，为模型生成一致贴图。</p>') + '<p class="help-line">Studio 网页订阅 · 建议先贴图，再绑骨和添加动作。保存为新版本。</p>' : '') +
      (form.textureMode === "generate"
        ? '<p class="help-line">生成一张平铺材质图片并应用到 UV，适合木纹、布料等重复纹理。人物服装请用 AI 贴图。</p>' + field(
            "纹理描述",
            `<textarea data-field="prompt" aria-label="纹理描述" placeholder="例如：金色长发、红色蝴蝶结发饰，黑色与金色相间的连衣裙，肩部有银色护甲片，腰间粉色缎带，白色长袜与棕色圆头皮靴的动漫女性角色，整体手办质感，各区域色彩边界清晰">${esc(form.prompt)}</textarea>`,
          )
        : "") +
      (form.textureMode === "studio" ? '' : meshSelect()) +
      (form.textureMode === "upload"
        ? field("贴图图片", uploadBox("texture", "拖入右侧图片或点击上传") + uploadHint("texture")) + '<p class="help-line">直接按模型现有 UV 应用图片。请使用与此模型匹配的贴图，不是角色参考照片。</p>'
        : "") +
      (["generate","upload"].includes(form.textureMode) ? `<details><summary>材质参数</summary>${materialFields()}</details>` : "");
    action = form.textureMode === "brush"
      ? "打开贴图绘制"
      : form.textureMode === "studio" ? "生成模型贴图" : form.textureMode === "upload"
        ? "应用上传纹理"
        : "生成并应用纹理";
    context = form.textureMode === "brush"
      ? "在模型上绘制颜色"
      : form.textureMode === "studio" ? "Studio AI 贴图 · 使用订阅积分" : form.textureMode === "upload"
        ? "已有纹理 · 本地应用"
        : "AI 生成色彩纹理 → UV 材质";
  } else if (tool === "paint") {
    html =
      source() +
      meshSelect() +
      `<label class="toggle">画笔颜色<input data-field="color" type="color" value="${form.color}" aria-label="画笔颜色"></label>` +
      field("画笔大小", numeric("paintSize", 2, 80)) +
      `<button id="paint-toggle" class="full ${painting ? "active" : ""}" style="border:1px solid #555;margin-top:15px">${icon("paintbrush")}${painting ? "结束绘制" : "开始绘制"}</button><button id="paint-reset" class="full">撤销未保存绘制</button>`;
    action = "保存绘制版本";
    context = "UV 画笔 · 当前部件";
  } else if (tool === "upscale") {
    html =
      source() +
      meshSelect() +
      field(
        "纹理最大边长",
        select("resolution", [
          [1024, "1K"],
          [2048, "2K"],
          [4096, "4K"],
          [8192, "8K"],
        ]),
      ) +
      `<p class="help-line">本地纹理重采样；AI 超分辨率尚未接入。</p>`;
    action = "调整纹理分辨率";
  } else if (tool === "pbr") {
    html = source() + meshSelect() + '<p class="help-line">调整当前材质，保留已有贴图和法线。被贴图控制的通道保持贴图效果。</p>' + materialFields();
    action = "应用 PBR 材质";
  }
  // 前置条件引导横幅必须放在所有工具块之后（因为部分工具用 html = ... 覆盖前面的赋值）
  if(tool==='texture'&&form.textureMode==='studio')missingRequirement='AI 贴图接入验证中：当前上游任务失败，暂不可提交。已有贴图、手动绘制和材质调整可使用。';
  if(tool==='texture'&&form.textureMode==='studio'&&meshes.some(m=>m.isSkinnedMesh))missingRequirement='当前版本已有骨骼。请在上方版本菜单选择白模或绑骨前的贴图版本，再生成贴图。';
  if (missingRequirement) html = `<div class="tool-requirement" role="note">${icon("triangle-alert")}<span>${esc(missingRequirement)}</span>${!version?'<button class="req-link" data-goto-tool="model">去生成模型</button>':''}</div>` + html;
  if (tool === 'animation') {
    if (!['studio','clips'].includes(form.animationPanel)) form.animationPanel='clips';
    const panels = choices('animationPanel', [['clips','模型动作'],['studio','动作模板']]);
    if (form.animationPanel === 'studio') {
      html = panels + `<div class="motion-library"><label class="field" for="motion-search">人物动作 · ${studioMotions.length} 个</label><input id="motion-search" class="full" type="search" placeholder="搜索动作，如拥抱、行走、拳击" aria-label="搜索动作"><div class="motion-categories">${Object.entries(motionCategories).map(([id,name])=>`<button data-motion-category="${id}" class="${form.motionCategory===id?'active':''}" aria-pressed="${form.motionCategory===id}">${name}</button>`).join('')}</div><div id="studio-motion-grid" class="anim-grid studio-motion-grid"></div><p class="help-line">点击白模查看动作，应用后通过 Studio 导出带动作的新模型版本。</p><a class="motion-studio-link" href="https://studio.tripo3d.ai/zh/workspace/rigging" target="_blank" rel="noopener">在 Tripo Studio 使用动作 ↗</a></div>`;
      action = '应用到模型'; context = 'Studio 动作 · 保存为新版本';
    } else if (form.animationPanel === 'clips') {
      html = panels + '<button id="open-rig-agent" class="full">AI 生成或调整动作</button><section id="model-actions"></section>';
      action = ''; context = '播放与管理当前模型的动作';
    }
  }
  $("parameters").innerHTML = html;
  if(tool === 'animation' && form.animationPanel === 'studio') bindStudioMotionLibrary();
  if(tool === 'animation' && form.animationPanel === 'clips') {
    disposeMotionPreviews = mountModelActions($('model-actions'), {
      viewer, asset:current, version, fileURL, put, base64, esc, toast, modal, fit, bounds,
      openAgent:showRigAgent,
      openTemplates:()=>{form.animationPanel="studio";renderParameters();},
    });
  }
  $('parameters').inert = busy;
  $("run-tool").hidden = tool === "animation" && form.animationPanel === "clips";
  $("run-tool").textContent = action;
  $("run-tool").disabled = (tool === "animation" && !meshes.some(m=>m.isSkinnedMesh)) || busy || !!missingRequirement || currentJobs.some(j=>j.kind==='image_generate' && ['running','queued'].includes(j.status));
  $("parameters")
    .querySelectorAll("[data-goto-tool]")
    .forEach((b) => (b.onclick = () => selectTool(b.dataset.gotoTool)));
  $("operation-context").textContent = context;
  $("parameters")
    .querySelectorAll("[data-field]")
    .forEach(
      (el) =>
        (el.oninput = () => {
          let value =
            el.type === "checkbox"
              ? el.checked
              : ["range", "number"].includes(el.type)
                ? Number(el.value)
                : el.value;
          updateForm(el.dataset.field, value);
          if (el.dataset.field === "mesh") {
            selectedMesh = meshes.find((m) => m.name === value) || null;
            $("selection-info").textContent = selectedMesh?.name || "全部部件";
            const mat=[(selectedMesh||meshes[0])?.material].flat()[0];
            if(mat){form.color='#'+mat.color.getHexString();form.roughness=mat.roughness??.5;form.metalness=mat.metalness??0;renderParameters();}
          }
          if (["range", "number"].includes(el.type))
            $("parameters")
              .querySelectorAll(`[data-field="${el.dataset.field}"]`)
              .forEach((other) => (other.value = value));
          if (el.dataset.field === "prompt") {
            const counter = $("parameters").querySelector('.prompt-bottom span');
            if (counter) counter.textContent = `${value.length}/10000`;
          }
          if (el.dataset.field === "tripoTexture" && !value) updateForm('tripoPbr',false);
          if (["useTexture","tripoModel","studioModel","tripoTexture","tripoPbr","geometryQuality","textureQuality"].includes(el.dataset.field)) renderParameters();
        }),
    );
  $("parameters")
    .querySelectorAll("[data-choice]")
    .forEach(
      (el) =>
        (el.onclick = () => {
          updateForm(el.dataset.choice, el.dataset.value);
          // 低模档位：选中档位后同步"目标面数"输入框与滑块
          if (el.dataset.choice === "faceTier" && el.dataset.value)
            updateForm("faces", Number(el.dataset.value));
          renderParameters();
        }),
    );
  $("parameters")
    .querySelectorAll("[data-upload]")
    .forEach((el) => {
      el.onclick = () => chooseImage(el.dataset.upload);
      el.ondragover = e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect='copy'; el.classList.add('drag-over'); };
      el.ondragleave = () => el.classList.remove('drag-over');
      el.ondrop = safe(async e => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drag-over'); const raw=e.dataTransfer.getData(IMAGE_DRAG_TYPE); if(raw) await loadImageResource(JSON.parse(raw),el.dataset.upload); else await receiveImages([...e.dataTransfer.files], el.dataset.upload); });
    });
  $("parameters")
    .querySelectorAll("[data-anim]")
    .forEach((el) => (el.onclick = () => { updateForm("animation", el.dataset.anim); renderParameters(); }));
  $("parameters")
    .querySelectorAll("[data-style]")
    .forEach((el) => (el.onclick = () => { updateForm("style", el.dataset.style); renderParameters(); }));
  $('save-asset-name')?.addEventListener('click',safe(async()=>{
    const asset=current;const name=form.assetName.trim()||asset.asset_id;
    await put(baseOf(asset)+'/spec',{spec:{...detail.spec,name},note:'修改资产名称'});
    asset.name=name;form.assetName=name;$('asset-title').textContent=name;await refreshAssets();toast('名称已保存');
  }));
  $('open-rig-agent')?.addEventListener('click',safe(showRigAgent));
  $('studio-human-rig')?.addEventListener('click',safe(()=>exclusive(()=>studioProcess('rig'))));
  $('prepare-multiview')?.addEventListener('click',()=>{if(!uploads.input&&uploads.front)uploads.input={...uploads.front};selectTool('image');});
  $('load-multiview')?.addEventListener('click',safe(()=>chooseReferenceGroup()));
  $('open-presets')?.addEventListener('click', presetDialog);
  $('global-style')?.addEventListener('click', safe(styleDialog));
  $('save-preset')?.addEventListener('click', safe(() => presetEditor()));
  $('enrich-prompt')?.addEventListener('click', safe(enrichPrompt));
  $("remove-reference")?.addEventListener("click", () => {
    if (uploads.input) URL.revokeObjectURL(uploads.input.url);
    delete uploads.input;
    renderParameters();
  });
  $("review-model")?.addEventListener("click", safe(() => captureAssetViews(true)));
  $("unwrap")?.addEventListener(
    "click",
    safe(() => exclusive(() => process("uv"))),
  );
  $("paint-toggle")?.addEventListener("click", () => {
    if (!viewer.obj) return toast("先选择模型");
    restoreMaterials();
    painting = !painting;
    viewer.controls.enabled = !painting;
    renderParameters();
  });
  $("paint-reset")?.addEventListener(
    "click",
    safe(async () => {
      painting = false;
      viewer.controls.enabled = true;
      await selectAsset(current, version);
      renderParameters();
    }),
  );
  icons();
}
function selectTool(value) {
  if (!TOOLS.some((t) => t[0] === value)) return;
  tool = !viewer.obj && !["image","model"].includes(value) ? "model" : value;
  painting = false;
  viewer.controls.enabled = true;
  renderRail();
  renderFlowSteps();
  renderParameters();
  $('parameters').scrollTop = 0;
  $('model-stage').hidden = tool === 'image';
  document.querySelector('.viewport').classList.toggle('image-workspace',tool === 'image');
  ['model-history','version-select','save-preview','export-model','undo','redo'].forEach(id=>$(id).hidden=tool==='image');
  $('selection-info').hidden = tool === 'image' || !viewer.obj;
  syncGeneration();
  if (tool === 'image') renderImages(current);
  $("image-stage").hidden = tool !== "image";
  $("empty-stage").hidden = !!viewer.obj || !$("image-stage").hidden;
  const hash = new URLSearchParams({
    tool,
    ...(current ? { asset: keyOf(current) } : {}),
  });
  history.replaceState(null, "", "#" + hash);
}
function presetDialog() {
  modal('用途案例', `<p>先看图，再选用途。悬停或键盘聚焦可放大查看，点击填入描述。</p>${exampleCards()}<details><summary>我的文字草稿</summary>${loadPresets().map(p=>`<article><p>${esc(p.name)}：${esc(p.prompt)}</p><button data-draft-use="${esc(p.id)}">采用</button><button data-draft-edit="${esc(p.id)}">编辑</button><button data-draft-delete="${esc(p.id)}">删除</button></article>`).join('') || '<p>暂无保存的草稿。</p>'}<button id="preset-new">保存当前描述</button></details>`);
  $('dialog-body').querySelectorAll('[data-example]').forEach(b=>b.onclick=()=>{updateForm('prompt',examples.find(e=>e.id===b.dataset.example).prompt);renderParameters();$('dialog').close();});
  $('dialog-body').querySelectorAll('[data-draft-use]').forEach(b=>b.onclick=()=>{updateForm('prompt',loadPresets().find(p=>p.id===b.dataset.draftUse).prompt);renderParameters();$('dialog').close();});
  $('dialog-body').querySelectorAll('[data-draft-edit]').forEach(b=>b.onclick=()=>presetEditor(loadPresets().find(p=>p.id===b.dataset.draftEdit)));
  $('dialog-body').querySelectorAll('[data-draft-delete]').forEach(b=>b.onclick=()=>{savePresets(loadPresets().filter(p=>p.id!==b.dataset.draftDelete));presetDialog();});
  $('preset-new').onclick=()=>presetEditor();
}
function presetEditor(existing) {
  modal(existing ? '编辑预设' : '保存创作预设', `<label class="field" for="preset-name">名称</label><input id="preset-name" class="full" maxlength="40" value="${esc(existing?.name || '')}"><label class="field" for="preset-prompt">描述</label><textarea id="preset-prompt" class="full" maxlength="10000">${esc(existing?.prompt || form.prompt)}</textarea><button id="preset-save" class="primary">保存预设</button>`);
  $('preset-save').onclick = safe(() => {
    const name = $('preset-name').value.trim(), prompt = $('preset-prompt').value.trim();
    if (!name || !prompt) throw new Error('名称与描述均不能为空');
    const entries = loadPresets();
    if (!existing && entries.length >= 40) throw new Error('最多保存 40 个预设');
    const item = { id: existing?.id || crypto.randomUUID(), name, prompt };
    savePresets(existing ? entries.map(p => p.id === existing.id ? item : p) : [...entries,item]);
    presetDialog(); toast('预设已保存到此浏览器');
  });
}
async function enrichPrompt() {
  const original = form.prompt.trim();
  if (!original) throw new Error('先填写主体描述');
  modal('描述扩写', `<label class="field">原始描述</label><p class="prompt-original">${esc(original)}</p><button id="request-enrichment" class="primary">生成扩写 · 付费文本服务</button><div id="enrichment-result" role="status"></div>`);
  $('request-enrichment').onclick = safe(async () => {
    const button = $('request-enrichment'), output = $('enrichment-result');
    button.disabled = true; output.textContent = '正在扩写…';
    try {
      const result = await post('/api/prompt/enrich', {description:original});
      if (typeof result.enriched !== 'string' || !result.enriched.trim()) throw new Error('服务未返回有效描述');
      if (!output.isConnected) return;
      output.innerHTML = `<label class="field" for="enriched-prompt">扩写结果</label><textarea id="enriched-prompt" class="full" maxlength="10000">${esc(result.enriched.slice(0,10000))}</textarea><button id="use-enrichment" class="primary">采用扩写</button>`;
      $('use-enrichment').onclick = safe(() => {
        if (form.prompt.trim() !== original) throw new Error('原始描述已经改变，请关闭后重新扩写');
        updateForm('prompt', $('enriched-prompt').value); renderParameters(); $('dialog').close();
      });
    } catch (error) { if (output.isConnected) output.textContent = error.message; }
    finally { button.disabled = false; }
  });
}

function chooseImage(target) {
  imageTarget = target;
  $("image-file").multiple = target === "batch";
  $("image-file").click();
}
$("image-file").onchange = safe(async (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  await receiveImages(files, imageTarget);
});
async function receiveImages(files, target) {
  if (busy) throw new Error('任务运行中，请完成后再更换参考图');
  if (files.some(f => !['image/png','image/jpeg','image/webp'].includes(f.type))) throw new Error('支持 PNG、JPEG 和 WebP 图片');
  if (files.length > 10) throw new Error("最多选择 10 张图片");
  if (target !== 'batch' && files.length > 1) throw new Error('当前输入只接受一张图片');
  if (target === "batch") {
    if (files.some((f) => f.size > 20 * 1024 * 1024))
      throw new Error("单张图片不得超过 20 MB");
    uploads.batch = { files };
  } else if (files[0]) {
    const blob = await png(files[0],target==='texture'?8192:1024);
    if(!blob||blob.size>20*1024*1024)throw Error('转换后的图片超过20 MB，请降低贴图分辨率');
    if (uploads[target]?.url)
      URL.revokeObjectURL(uploads[target].url);
    const url = URL.createObjectURL(blob);
    objectURLs.add(url);
    uploads[target] = { blob, url, name: files[0].name };
    if (tool === 'image') updateForm('imageInput','image');
  }
  renderParameters();
}
document.addEventListener('paste', safe(async event => {
  if ($('dialog').open || !['image','model','texture'].includes(tool)) return;
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  await receiveImages(files, tool === 'image' ? 'input' : tool === 'texture' ? 'texture' : form.mode === 'batch' && tool === 'model' ? 'batch' : 'front');
}));
async function saveUploads(asset, views = ["front", "side", "right", "back"]) {
  // Check actual content: historical Studio JPEG files may carry a .png filename/MIME.
  const converted=await Promise.all(views.map(async view=>{
    const item=uploads[view];if(!item)return null;
    const signature=new Uint8Array(await item.blob.slice(0,8).arrayBuffer());
    const isPng=[137,80,78,71,13,10,26,10].every((b,i)=>signature[i]===b);
    const blob=isPng?item.blob:await png(item.blob,8192);
    if(!blob||blob.size>20*1024*1024)throw Error(`${view}参考图转为PNG后超过20 MB，请换一张较小的图片`);
    return {view,item,blob};
  }));
  for(const entry of converted.filter(Boolean))entry.item.blob=entry.blob;
  for (const view of views)
    if (uploads[view]) {
      if (!uploads[view].savedFor || uploads[view].savedFor !== keyOf(asset)) {
        const path = `source/uploads/${Date.now()}_${view}.png`;
        await put(fileURL(asset, path), {bytes_b64: await base64(uploads[view].blob)});
        uploads[view].savedFor = keyOf(asset);
      }
      await put(fileURL(asset, `source/reference_${view}.png`), {
        bytes_b64: await base64(uploads[view].blob),
      });
    }
}
async function ensureAsset(force = false, prompt = form.prompt) {
  if (current && !force) return current;
  if (!prompt.trim()) throw new Error("填写资产描述后再创建");
  creationState = {status:'creating',name:prompt.slice(0,40)};
  renderAssets(); if(tool==='image') renderImages(current);
  showProgress('正在创建资产…',0);
  let result;
  try { result = await post("/api/assets", {
    description: prompt,
    draft: true,
    name: form.assetName || undefined,
    asset_type: form.assetType || 'prop',
    style: form.style,
    height_m: form.height,
    extra: form.pose ? "标准 T 姿势，双臂水平伸展" : undefined,
  }); } catch(error) {
    creationState = {status:'failed',name:prompt.slice(0,40),error:error.message};
    renderAssets(); if(tool==='image') renderImages(current); throw error;
  }
  creationState = null;
  $('asset-search').value=''; $('type-filter').value=''; $('status-filter').value=''; collection='all';
  document.querySelectorAll('[data-collection]').forEach(b=>b.classList.toggle('active',b.dataset.collection==='all'));
  await refreshAssets();
  const found = allAssets.find((a) => a.asset_id === result.asset_id);
  if (!found) throw new Error("资产已创建，但列表暂不可用，请刷新");
  const draftUploads = uploads;
  const draftForm = {...form};
  await selectAsset(found);
  uploads = draftUploads;
  form = draftForm;
  renderParameters();
  showProgress(`${found.name} · 资产已创建`,0);
  return found;
}
function showProgress(text, percent = 0) {
  syncGeneration();
  $("job-progress").hidden = false;
  $("job-text").textContent = text;
  $("job-progress").querySelector("progress").value = percent;
}
async function exclusive(fn) {
  if (busy) throw new Error("当前任务尚未结束");
  busy = true;
  $('parameters').inert = true;
  $("run-tool").disabled = true;
  try {
    return await fn();
  } catch (e) {
    generationIndicator.update(null, "");
    if (tool === 'image' && (current?.generation?.status === 'failed' || creationState)) $('job-progress').hidden = true;
    else showProgress("任务失败：" + e.message, 0);
    generationIndicator.update(null, "");
    throw e;
  } finally {
    busy = false;
    $('parameters').inert = false;
    renderParameters();
  }
}
async function waitJob(asset, jobId) {
  const key = keyOf(asset) + "/" + jobId;
  activePolls.set(key, true);
  const started = Date.now();
  try {
    while (Date.now() - started < 31 * 60 * 1000) {
      const job = await api(baseOf(asset) + "/jobs/" + jobId);
      if (current && keyOf(current) === keyOf(asset)) {
        const index = currentJobs.findIndex(j => j.job_id === jobId);
        if (index < 0) currentJobs.push(job); else currentJobs[index] = job;
      }
      if (job.images && current && keyOf(current) === keyOf(asset)) {
        imageResults = [...new Set([...imageResults, ...job.images])];
        const index = currentJobs.findIndex(j => j.job_id === jobId);
        if (index < 0) currentJobs.push(job); else currentJobs[index] = job;
        updateImageActivity(asset,job);
        if (tool === 'image') renderImages(asset);
      }
      if(['tripo','tripo_studio'].includes(job.provider)) updateImageActivity(asset,job);
      showProgress(
        `${asset.name} · ${STATUS[job.status] || job.status} · ${['tripo','tripo_studio'].includes(job.provider) ? (job.progress?.phase || 'Tripo 生成') : job.kind === 'image_generate' ? '图片生成' : job.kind || ""}`,
        job.progress?.percent || 0,
      );
      if (["failed","waiting","unknown"].includes(job.status)) throw new Error(job.error || "任务失败");
      if (job.status === "done") {
        showProgress(
          `${asset.name} · 已完成${job.version ? " · " + job.version : ""}`,
          100,
        );
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("等待超时，后台任务仍可在任务记录中查看");
  } finally {
    activePolls.delete(key);
  }
}
async function process(
  operation,
  options = {},
  asset = current,
  ver = version,
) {
  if (!asset || !ver) throw new Error("先选择具有模型版本的资产");
  const r = await post(`${baseOf(asset)}/versions/${ver}/process`, {
    operation,
    ratio: form.ratio,
    voxel_size: form.voxel,
    options: { mesh: form.mesh, ...options },
  });
  const job = await waitJob(asset, r.job_id);
  await refreshAssets();
  if (current?.asset_id === asset.asset_id)
    await selectAsset(
      allAssets.find((a) => a.asset_id === asset.asset_id) || asset,
      job.version,
    );
  return job;
}
async function studioProcess(operation) {
  if(!current||!version)throw Error('先选择模型');
  const asset=current,ver=version;
  const result=await post(`${baseOf(asset)}/versions/${ver}/studio-process`,{operation,prompt:operation==='texture'?form.texturePrompt:undefined,input:operation==='texture'?form.textureInput:undefined,animation:operation==='animation'?'preset:biped:'+form.studioMotion:undefined,expected_history_node_id:historyTree?.head});
  currentJobs.push({job_id:result.job_id,kind:'model_process',provider:'tripo_studio',status:'running',operation});
  const job=await waitJob(asset,result.job_id);
  await refreshAssets();
  if(current&&keyOf(current)===keyOf(asset)){await selectAsset(allAssets.find(a=>keyOf(a)===keyOf(asset))||asset,job.version);await savePreview(true);}
  toast(operation==='texture'?'贴图已保存为新版本，可继续绑骨':operation==='rig'?'绑定已保存，可选择动作模板':'动作版本已保存，进入模型动作播放');
  if(operation==='animation'){form.animationPanel='clips';selectTool('animation');}
}
function imageSize() {
  const [w,h]=creationOptions.ratio.split(':').map(Number);
  const edge={1080:1920,2048:2560,3840:3840}[form.imageResolution]||1920;
  return `${Math.round(edge*w/Math.max(w,h)/8)*8}x${Math.round(edge*h/Math.max(w,h)/8)*8}`;
}
async function fourViewPrompt(prompt) {
  const style=await api('/api/styleprofile');
  return `${prompt}\n风格：${style.style_keywords||''}；配色：${style.color_palette||''}；人物比例（只对人物适用）：${style.head_body_ratio||''}`;
}
async function generateImages(
  asset,
  prompt = form.prompt,
  count = creationOptions.allowMultiple ? creationOptions.count : 1,
  reference = !!uploads.input,
  fourViews = false,
) {
  const result = await post(baseOf(asset) + "/images", {
    prompt,
    count,
    size: imageSize(),
    reference,
    four_views: fourViews,
    model_id: form.imageModelId || undefined,
  });
  const queued={job_id:result.job_id,kind:'image_generate',status:'running',four_views:fourViews,count,images:[],view_images:[],progress:{percent:0},created_at:Date.now()/1000};
  currentJobs.push(queued); updateImageActivity(asset,queued);
  if(tool==='image') renderImages(asset);
  return waitJob(asset, result.job_id);
}
function showRigAgent(options={}) {
  if(!current||!version)throw Error('先选择已有模型');
  const asset=current;
  openRigAgent({asset:{...asset,dir:dirOf(asset)},version,api,initialPrompt:options.prompt,actionName:options.name,onResult:async task=>{
    await refreshAssets();
    const found=allAssets.find(a=>keyOf(a)===keyOf(asset));
    if(!found||prefs.archived.includes(keyOf(found)))throw Error('资产已移除，请到回收站查看');
    await selectAsset(found,task.result_version);form.animationPanel='clips';selectTool('animation');
  }});
}
async function runTool() {
  if(tool==='rig')return showRigAgent();
  if(tool==='texture'&&form.textureMode==='brush')return selectTool('paint');

  await exclusive(async () => {
    if (tool === "image") {
      if (!form.prompt.trim() && !uploads.input) throw new Error('填写描述或添加参考图片');
      const description=form.prompt.trim() || '根据参考图片还原同一个主体，补齐完整四视图';
      const asset = await ensureAsset(false,description);
      if (uploads.input) await put(fileURL(asset,"source/input_reference.png"),{bytes_b64:await base64(uploads.input.blob)});
      creationOptions=await readCreationConfig();
      const job = await generateImages(asset,await fourViewPrompt(description),creationOptions.allowMultiple?creationOptions.count:1,!!uploads.input,true);
      imageResults = [...new Set([...imageResults, ...(job.images || [])])];
      renderImages(asset);
      await loadJobs();
      return;
    }
    if (tool === "model") {
      const studio=form.modelSource==='studio';
      if(!studio) modelCatalog = await api('/api/settings/catalog');
      const model = studio ? {id:form.studioModel} : modelCatalog.models.find(m=>m.id===form.tripoModel && m.enabled && m.service==='model3d');
      if (!studio && (!model || !modelCatalog.providers.find(p=>p.id===model.provider)?.key_configured)) throw new Error('请先在模型设置中配置 Tripo Key');
      const promptLimit=studio?1000:1024;
      if (form.mode==='text' && (!form.prompt.trim() || [...form.prompt].length>promptLimit)) throw new Error(`填写 1–${promptLimit} 字的模型描述`);
      if (form.mode==='multi' && !['front','side','back','right'].every(v=>uploads[v])) throw new Error('请先补齐正面、背面、左侧和右侧四张参考图');
      if (form.mode==='single' && !uploads.front) throw new Error('请先上传参考图片');
      if (form.mode==='batch' && !uploads.batch?.files.length) throw new Error('请先选择批量图片');
      const request = {source:studio?'studio':'api',mode:form.mode==='batch'?'single':form.mode,prompt:form.prompt,
        model_id:model.id,texture:!!form.tripoTexture,pbr:!!form.tripoTexture && !!form.tripoPbr,
        face_limit:form.tripoFaces ? Number(form.tripoFaces) : undefined,
        ...(studio ? {geometry_quality:form.geometryQuality||undefined,quad:!!form.modelQuad,
          ...(form.tripoTexture ? {texture_quality:form.textureQuality,texture_size:Number(form.textureSize)} : {})} : {})};
      const batch = form.mode==='batch' ? [...uploads.batch.files] : [null];
      for (const [i,file] of batch.entries()) {
        if (file) { const blob=await png(file); uploads.front={blob,url:URL.createObjectURL(blob),name:file.name}; }
        const asset = await ensureAsset(!!file, form.prompt.trim() || form.assetName || file?.name || uploads.front?.name || '未命名模型');
        if(request.mode!=='text') await saveUploads(asset,request.mode==='single'?['front']:['front','side','back','right']);
        showProgress(`提交 Tripo${file?' · '+(i+1)+'/'+batch.length:''}`,0);
        const r = await post(baseOf(asset)+'/model',{...request,expected_history_node_id:historyTree?.head});
        currentJobs.push({job_id:r.job_id,kind:'model_build',provider:r.provider||'tripo',status:'running',created_at:Date.now()/1000});
        syncGeneration();
        await refreshAssets();
        const job=await waitJob(asset,r.job_id);
        await refreshAssets();
        if(current?.asset_id===asset.asset_id) {
          await selectAsset(allAssets.find(a=>a.asset_id===asset.asset_id)||asset,job.version);
          await savePreview().catch(e=>toast('模型已保存，缩略图保存失败：'+e.message));
        }
      }
      $('job-progress').hidden=true;
      toast('模型已保存，可切换视角检查或下载 GLB');
      return;
    }
    if (tool === "split") return process("split", { method: form.splitMethod });
      if (tool === "remesh")
      return process(
        form.topology === "voxel"
          ? "remesh"
          : form.topology === "quad"
            ? "quad"
            : "decimate",
        { faces: Number(form.faces) },
      );
    if (tool === "uv") return process("uv", { mode: form.uvMode });
    if (["rig","animation"].includes(tool)) return studioProcess(tool);
    if (tool === "pbr")
      return process("material", {
        color: form.color,
        roughness: form.roughness,
        metalness: form.metalness,
      });
    if (tool === "upscale")
      return process("upscale", { resolution: Number(form.resolution) });
    if (tool === "paint") return savePaint();
    if (tool === "texture") {
      if (!current || !version) throw new Error("先选择模型");
      const asset = current,
        ver = version;
      if(form.textureMode==='studio')return studioProcess('texture');
      if(!meshes.filter(m=>!form.mesh||m.name===form.mesh).every(m=>m.geometry.attributes.uv))throw Error('目标模型缺少 UV，请先完成 UV 展开');
      let textureKey;
      if (form.textureMode==='upload') {
        if (!uploads.texture) throw new Error("先上传纹理图片");
        textureKey = `source/texture_${Date.now()}.png`;
        await put(fileURL(asset, textureKey), {
          bytes_b64: await base64(uploads.texture.blob),
        });
      } else {
        if (!form.prompt.trim()) throw new Error("填写纹理描述");
        const job = await generateImages(
          asset,
          "Seamless flat albedo texture, even lighting, no perspective. " +
            form.prompt,
          1,
          false,
        );
        textureKey = job.images[0];
      }
      return process(
        "material",
        {
          texture_key: textureKey,
          color: "#ffffff",
          roughness: form.roughness,
          metalness: form.metalness,
        },
        asset,
        ver,
      );
    }
  });
}

function imageActivityLabel(job) {
  return ({running:'图片生成中',queued:'图片排队中',failed:'图片生成失败',done:'图片已生成'})[job?.status] || '';
}
function assetActivityLabel(asset) {
  if(asset.version && asset.generation?.status === 'done') return `${asset.version} · ${STATUS[asset.status] || asset.status}`;
  if(['tripo','tripo_studio'].includes(asset.generation?.provider)) return ({running:'模型生成中',waiting:'待查询原任务',unknown:'提交待确认',failed:'模型生成失败',done:'模型已生成'})[asset.generation.status]||'';
  return imageActivityLabel(asset.generation);
}
function updateImageActivity(asset,job) {
  if(!['image_generate','model_build','model_process'].includes(job.kind)) return;
  const entry=allAssets.find(a=>keyOf(a)===keyOf(asset));
  for(const a of [asset,entry].filter(Boolean)) {
    a.generation=job;
    if(!a.preview && job.images?.length) a.preview=job.images.at(-1);
  }
  if(current && keyOf(current)===keyOf(asset)) $('asset-status').textContent=assetActivityLabel(asset);
  renderAssets();
}
let disposeAssetProgress=()=>{}, assetRenderSignature="";
function renderAssets() {
  const q = $("asset-search").value.trim().toLowerCase(),
    type = $("type-filter").value,
    status = $("status-filter").value;
  const list = allAssets.filter((a) => {
    const key = keyOf(a),
      archived = prefs.archived?.includes(key);
    return (
      projects.matches(a) && (collection === "archived" ? archived : !archived) &&
      (collection !== "favorites" || prefs.favorites?.includes(key)) &&
      (!type || a.asset_type === type) &&
      (!status || a.status === status) &&
      (!q || `${a.name} ${a.asset_id}`.toLowerCase().includes(q))
    );
  });
  // Polling should not replace unchanged cards, focus, images or progress timers.
  const signature=JSON.stringify([list,current&&keyOf(current),prefs.favorites,managing,[...checked],creationState]);
  if(signature===assetRenderSignature) return;
  assetRenderSignature=signature;
  disposeAssetProgress();
  $("asset-count").textContent = list.length;
  $("asset-list").innerHTML = (creationState ? `<article class="asset-card creation-card" role="status"><span class="no-thumb">${icon('image')}</span><strong>${esc(creationState.name)}</strong><small>${creationState.status==='creating'?'正在创建资产…':'资产创建失败'}</small></article>` : '') +
    list
      .map((a) => {
        const key = keyOf(a);
        return `<article class="asset-card ${current && key === keyOf(current) ? "current" : ""}" data-key="${key}"><button class="open-asset" title="${esc(a.name)}" data-open="${key}">${a.preview ? `<img src="${fileURL(a, a.preview)}" alt="${esc(a.name)}" loading="lazy">` : `<span class="no-thumb">${icon("box")}</span>`}<strong>${esc(a.name)}</strong><small>${esc(assetActivityLabel(a) || (a.version || "无模型") + " · " + (STATUS[a.status] || a.status))}</small></button><button class="favorite ${prefs.favorites?.includes(key) ? "on" : ""}" data-favorite="${key}" title="收藏 ${esc(a.name)}" aria-pressed="${!!prefs.favorites?.includes(key)}">${icon("star")}</button>${managing ? `<input data-check="${key}" type="checkbox" ${checked.has(key) ? "checked" : ""} aria-label="选择 ${esc(a.name)}">` : ""}</article>`;
      })
      .join("") || '<p class="muted">没有匹配资产</p>';
  $("asset-list")
    .querySelectorAll("[data-open]")
    .forEach(
      (b) =>
        (b.onclick = safe(() =>
          // 允许任务运行中切换资产：后台任务按 asset key 索引，切换只改 UI 状态，不会串数据。
          // 任务完成后通过 current?.asset_id 判断，不会把用户强拉回旧资产。
          selectAsset(allAssets.find((a) => keyOf(a) === b.dataset.open)),
        )),
    );
  $("asset-list")
    .querySelectorAll("[data-favorite]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          const set = new Set(prefs.favorites || []);
          set.has(b.dataset.favorite)
            ? set.delete(b.dataset.favorite)
            : set.add(b.dataset.favorite);
          persist({ favorites: [...set] });
          renderAssets();
        }),
    );
  $("asset-list")
    .querySelectorAll("[data-check]")
    .forEach(
      (b) =>
        (b.onchange = () => {
          b.checked
            ? checked.add(b.dataset.check)
            : checked.delete(b.dataset.check);
          $("selected-count").textContent = checked.size;
        }),
    );
  disposeAssetProgress=mountAssetProgress($("asset-list"),list.map(a=>[keyOf(a),a.generation]));
  $("batch-actions").hidden = !managing;
  $("selected-count").textContent = checked.size;
  icons();
}
async function refreshAssets() {
  const [assets, state] = await Promise.all([api('/api/assets'),api('/api/workbench/state')]);
  allAssets = assets.assets || [];
  prefs.archived = state.archived || [];
  projects.update(state);
  if(current && collection!=='archived' && prefs.archived.includes(keyOf(current)) && !busy) {
    newDraft(); toast('当前资产已移入回收站');
  }
  renderAssets();
  await refreshImageInventory();
}
let assetSelectionAbort;
async function selectAsset(asset, requestedVersion) {
  if (!asset) return;
  const serial = ++selectionSerial;
  assetSelectionAbort?.abort();
  const controller=new AbortController();assetSelectionAbort=controller;
  let staged=null,committed=false;
  assetTransition.begin(serial,asset.name || asset.asset_id,keyOf(asset));
  try {
  await new Promise(resolve=>requestAnimationFrame(resolve));
  if(serial!==selectionSerial)return;
  // Prepare every dependency while the current model and panels remain live.
  const [response,head,inventory]=await Promise.all([api(baseOf(asset),{signal:controller.signal}),api(baseOf(asset)+'/history',{signal:controller.signal}).catch(()=>null),api('/api/media/images',{signal:controller.signal})]);
  if(serial!==selectionSerial)return;
  const targetVersion=requestedVersion||response.latest?.latest||asset.version||'';
  const treeNodes=head?.tree?.nodes||head?.nodes||[];
  const versionKeys=[...new Set([targetVersion,response.latest?.latest,response.latest?.approved,response.latest?.published,...(Array.isArray(treeNodes)?treeNodes:Object.values(treeNodes)).map(n=>n.revision_id)].filter(Boolean))];
  const stageRequest=targetVersion?viewers.prepareSwitch(viewer,fileURL(asset,`versions/${targetVersion}/model.glb`),controller.signal,p=>assetTransition.update(serial,p.cache?'读取本地缓存…':p.total?`模型加载 ${Math.round(p.loaded/p.total*100)}%`:'正在加载模型…',p.total?p.loaded/p.total*100:undefined)).then(result=>{staged=result;return null;},error=>error):Promise.resolve(null);
  const [stageError,metas,jobs]=await Promise.all([stageRequest,Promise.all(versionKeys.map(async v=>[v,await api(fileURL(asset,`versions/${v}/meta.json`),{signal:controller.signal}).catch(()=>({}))])),Promise.all((response.jobs||[]).map(name=>api(baseOf(asset)+'/jobs/'+name.replace(/\.json$/,''),{signal:controller.signal}).catch(()=>null)))]);
  if(serial!==selectionSerial){viewers.releasePrepared(staged);staged=null;return;}
  if(stageError)throw stageError;
  const metadata=Object.fromEntries(metas),readyUploads={};
  if(staged)staged.negativeZ=metadata[targetVersion]?.coordinate_system==='right_handed_y_up_neg_z';
  assetTransition.update(serial,'准备参考图与面板…');
  await Promise.all(['front','side','right','back'].map(async view=>{
    const path=`source/reference_${view}.png`;if(!inventory.images?.some(i=>i.asset===keyOf(asset)&&i.path===path))return;
    const r=await fetch(fileURL(asset,path),{signal:controller.signal});if(!r.ok)throw Error('参考图加载失败');const blob=await r.blob();
    const url=URL.createObjectURL(blob);objectURLs.add(url);const img=new Image();img.src=url;await img.decode();readyUploads[view]={blob,url,name:'已绑定参考图',savedFor:keyOf(asset)};
  }));
  if(staged && !inventory.images?.some(i=>i.asset===keyOf(asset))) {
    assetTransition.update(serial,'准备模型四视图…');
    const scene=new THREE.Scene();scene.background=viewer.scene.background?.clone();scene.environment=viewer.scene.environment;
    viewer.scene.children.filter(o=>o.isLight).forEach(light=>scene.add(light.clone()));scene.add(staged.g.scene);
    try {const records=await renderModelImageRecords(asset,targetVersion,{...viewer,scene,obj:staged.g.scene,bounds:staged.bounds,grid:{visible:false},planFrontNegativeZ:staged.negativeZ});inventory.images=[...(inventory.images||[]),...records];}
    finally{staged.g.scene.removeFromParent();}
  }
  if(serial!==selectionSerial){viewers.releasePrepared(staged);staged=null;return;}
  if (current && keyOf(current) !== keyOf(asset)) undoCheckout.length = 0;
  painted.clear();
  viewers.clearViewer(viewer);
  current = asset;
  form.assetName = asset.name || "";
  version = "";
  if (tool === "animation") renderParameters();
  creationState = null;
  imageResults = []; currentJobs = []; assetMedia = []; uploads = {}; selectedImage = null;
  renderMedia();
  syncGeneration();
  selectedMesh = null;
  meshes = [];
  form.mesh = "";
  painting = false;
  viewer.controls.enabled = true;
  $("asset-title").textContent = asset.name;
  $("asset-status").textContent = STATUS[asset.status] || asset.status;
  $("empty-stage").hidden = true;
  renderAssets();

  detail = response;
  form.prompt = response.spec?.description || '';
  form.height = Number(response.spec?.attributes?.height_m) || 1.65;
  form.style = response.spec?.style || form.style;
  $('empty-stage').querySelector('h2').textContent = '填写描述或上传参考图，然后点击生成模型';
  version = targetVersion;
  uploads=readyUploads;
  committed=true;
  // Start the large download before waiting for labels/history; always handle rejection.
  const modelRequest = version ? viewers.loadInto(viewer,fileURL(asset, `versions/${version}/model.glb`),staged).then(()=>null,error=>error) : null;
  if (serial !== selectionSerial) return;
  historyTree = head;
  const versions = new Set(
    [
      version,
      response.latest?.latest,
      response.latest?.approved,
      response.latest?.published,
      ...historyNodes().map((n) => n.revision_id),
    ].filter(Boolean),
  );
  const labels=Object.fromEntries(await Promise.all([...versions].map(async v=>{const meta=metadata[v]||{};return [v,meta.stage_name||({texture:'已贴图',rig:'已绑骨',animation:'含动作'})[meta.operation]||''];})));
  if(serial!==selectionSerial)return;
  versionLabels=labels;
  $("version-select").innerHTML =
    [...versions]
      .sort()
      .reverse()
      .map(
        (v) =>
          `<option value="${v}" ${v === version ? "selected" : ""}>${v}${labels[v]?" · "+esc(labels[v]):""}${v === response.latest?.published ? " · 发布" : ""}</option>`,
      )
      .join("") || '<option value="">无模型</option>';
  if (version) {
    const modelError = await modelRequest;
    if (serial !== selectionSerial) return;
    if (modelError) throw modelError;
    viewer.obj?.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });
    form.mesh='';
    const material=[meshes[0]?.material].flat()[0];
    if(material){form.color='#'+material.color.getHexString();form.roughness=material.roughness??.5;form.metalness=material.metalness??0;}
    $("empty-stage").hidden = !!viewer.obj;
  } else {
    viewers.clearViewer(viewer);
    $("empty-stage").hidden = false;
    $("model-stage").querySelector(".viewer-stats").textContent =
      "尚无模型版本";
  }
  persist({ last_asset: keyOf(asset) });
  renderProperties();
  renderHistory();
  if (tool !== "animation") renderParameters();
  // 切到已有模型的资产时，若还停在"图片创作"就自动切到模型视图：
  // 预览/展示的默认形态应当是已生成的模型，而不是"等待生成图片"。
  if (version && tool === "image" && !creationState) tool = "model";
  selectTool(tool);
  assetTransition.update(serial,'3 / 3 · 整理参考图与资源面板');
  await loadJobs(serial, response, {jobs,inventory});
  if (serial !== selectionSerial) return;
  await fillMissingModelImages(asset,serial);
  if(serial!==selectionSerial)return;
  await Promise.all([...document.querySelectorAll('.control-panel img')].map(img=>img.decode().catch(()=>{})));
  if(serial!==selectionSerial)return;
  await assetTransition.finish(serial);
  if (viewer.obj && version && !asset.preview) {
    await savePreview(true).catch(e => toast('模型已加载，缩略图保存失败：' + e.message));
  }
  } catch(error) {
    if(!committed)viewers.releasePrepared(staged);
    if(serial===selectionSerial){assetTransition.fail(serial,error);throw error;}
  }
}
function historyNodes() {
  const tree = historyTree?.tree || historyTree;
  return Array.isArray(tree?.nodes)
    ? tree.nodes
    : Object.values(tree?.nodes || {});
}
async function loadJobs(serial = selectionSerial, snapshot = null, ready = null) {
  if (!current || !detail) return;
  const asset = current;
  const fresh = snapshot || await api(baseOf(asset));
  if (serial !== selectionSerial) return;
  detail = fresh;
  const names = fresh.jobs || [];
  const jobs = ready?.jobs || await Promise.all(
    names.map((name) =>
      api(baseOf(asset) + "/jobs/" + name.replace(/\.json$/, "")).catch(
        () => null,
      ),
    ),
  );
  if (serial !== selectionSerial) return;
  const previouslyRunning=currentJobs.filter(j=>['tripo','tripo_studio'].includes(j.provider) && j.status==='running').map(j=>j.job_id);
  currentJobs = jobs.filter(Boolean);
  if(fresh.flow_activity?.job_id)currentJobs.push(fresh.flow_activity);
  syncGeneration();
  const lastImage=currentJobs.filter(j=>['image_generate','model_build','model_process'].includes(j.kind)).sort((a,b)=>Number(a.job_id?.split('_').pop())-Number(b.job_id?.split('_').pop())).at(-1);
  if(lastImage) updateImageActivity(asset,lastImage);
  const modelJob=currentJobs.filter(j=>['model_build','model_process'].includes(j.kind)).sort((a,b)=>Number(a.job_id?.split('_').pop())-Number(b.job_id?.split('_').pop())).at(-1);
  if(modelJob && ['running','waiting','unknown','failed'].includes(modelJob.status))
    showProgress((['failed','waiting','unknown'].includes(modelJob.status)?'上次任务：':'')+(modelJob.error || modelJob.progress?.phase || 'Tripo 生成中'),modelJob.progress?.percent||0);
  if(modelJob?.status==='done')$('job-progress').hidden=true;
  if(modelJob?.status==='done' && previouslyRunning.includes(modelJob.job_id) && modelJob.version && modelJob.version!==version && !busy) {
    await refreshAssets(); await selectAsset(allAssets.find(a=>keyOf(a)===keyOf(asset))||asset,modelJob.version); return;
  }
  const images = currentJobs
    .filter((j) => j.images?.length && typeof j.images[0] === "string")
    .flatMap((j) => j.images);
  const inventory = ready?.inventory || await api('/api/media/images');
  if (serial !== selectionSerial) return;
  imageInventory = inventory.images || [];
  assetMedia = imageInventory.filter(i => i.asset === keyOf(asset));
  await Promise.all(['front','side','right','back'].map(async view => {
    const path = `source/reference_${view}.png`;
    if (!uploads[view] && assetMedia.some(i=>i.path===path)) {
      const response = await fetch(fileURL(asset,path));
      if (serial !== selectionSerial) return;
      if (response.ok) {
        const blob = await response.blob();
        if (serial !== selectionSerial) return;
        const url = URL.createObjectURL(blob); objectURLs.add(url);
        uploads[view] = {blob,url,name:'已绑定参考图',savedFor:keyOf(asset)};
      }
    }
  }));
  if(serial!==selectionSerial)return;
  imageResults = [...new Set([...assetMedia.filter(i => i.kind === 'generated').map(i=>i.path), ...images])];
  renderMedia(); renderProperties(); renderFlowSteps();
  if (tool !== "animation") renderParameters();
  if (tool === "image") renderImages(asset);
}
const referenceViews=[['front','正面'],['back','背面'],['side','左侧'],['right','右侧']];
const IMAGE_DRAG_TYPE='application/x-aigccat-image';
function fourViewGroups(owner=null) {
  const grouped=new Map();
  for(const item of imageInventory) {
    if(prefs.archived.includes(item.asset)||!mediaAsset(item)||(owner&&item.asset!==keyOf(owner)))continue;
    const generated=item.path.match(/^(source\/images\/job_(\d+)_set(\d+))_(front|back|side|right)\.png$/);
    const reference=item.path.match(/^source\/reference_(front|back|side|right)\.png$/);
    if(!generated&&!reference)continue;
    const id=item.asset+'/'+(generated?generated[1]:'references');
    if(!grouped.has(id))grouped.set(id,{id,asset:mediaAsset(item),label:generated?`生成任务 ${Number(generated[2])} · 第 ${generated[3]} 组`:'已确认参考图',order:generated?Number(generated[2]):0,entries:[]});
    grouped.get(id).entries.push({view:generated?generated[4]:reference[1],path:item.path});
  }
  return [...grouped.values()].filter(g=>referenceViews.every(([v])=>g.entries.some(e=>e.view===v))).sort((a,b)=>b.order-a.order);
}
async function resourceBlob(item) {
  const known=imageInventory.find(i=>i.asset===item.asset&&i.path===item.path);
  if(!known||prefs.archived.includes(item.asset)||!mediaAsset(known))throw Error('图片已移除，请刷新图片资源');
  const r=await fetch(fileURL(mediaAsset(known),known.path));if(!r.ok)throw Error('图片读取失败，请重试');
  const blob=await r.blob();
  if(blob.size>20*1024*1024)throw Error('图片超过20 MB');
  return blob;
}
function bindImageDrag(element,item) {
  element.draggable=true;
  element.querySelectorAll('img').forEach(img=>{img.draggable=true;});
}
document.addEventListener('aigccat-image-drop',safe(event=>receiveImages(event.detail.files,event.detail.target)));
async function loadImageResource(item,target) {
  if(busy)throw Error('任务运行中，请稍后更换参考图');
  const serial=selectionSerial,blob=await resourceBlob(item);
  if(serial!==selectionSerial)throw Error('资产已切换，请重新拖入');
  await receiveImages([new File([blob],imageLabel(item),{type:blob.type})],target);
  toast('图片已载入上传框');
}
async function loadReferenceGroup(group) {
  if(busy)throw Error('任务运行中，请稍后加载');
  const serial=selectionSerial;
  const parts=await Promise.all(referenceViews.map(async([view,label])=>({view,blob:await resourceBlob({asset:keyOf(group.asset),path:group.entries.find(e=>e.view===view).path}),name:label})));
  if(serial!==selectionSerial)throw Error('资产已切换，请重新选择四视图');
  const next={};
  for(const p of parts){const url=URL.createObjectURL(p.blob);objectURLs.add(url);next[p.view]={blob:p.blob,url,name:p.name};}
  uploads={...uploads,...next};updateForm('mode','multi');
  $('dialog').close();selectTool('model');if(!viewer.obj)$('empty-stage').querySelector('h2').textContent='四视图已载入，点击左下方生成模型';toast('前后左右四张已载入，确认后点击生成模型');
}
async function chooseReferenceGroup(owner=null) {
  const serial=selectionSerial;
  await refreshImageInventory();if(serial!==selectionSerial)return;
  const groups=fourViewGroups(owner);
  modal('加载已创建的四视图',`<p>选择一组，前后左右自动对应到建模输入。加载不会发起生成。</p><div class="fourview-groups">${groups.map((g,i)=>`<article><strong>${esc(g.asset.name)} · ${esc(g.label)}</strong><div>${referenceViews.map(([v,label])=>`<figure><img loading="lazy" src="${fileURL(g.asset,g.entries.find(e=>e.view===v).path)}" alt="${label}"><figcaption>${label}</figcaption></figure>`).join('')}</div><button class="primary" data-load-group="${i}">加载这组四视图</button></article>`).join('')||'<p>暂无完整四视图。请先生成，或补齐前后左右四张图片。</p>'}</div>`);
  $('dialog-body').querySelectorAll('[data-load-group]').forEach(b=>b.onclick=safe(async()=>{b.disabled=true;try{await loadReferenceGroup(groups[Number(b.dataset.loadGroup)]);}finally{b.disabled=false;}}));
}
async function reviewReferenceSet(asset,entries) {
  const parts=await Promise.all(referenceViews.map(async([view,label])=>{
    const entry=entries.find(e=>e.view===view);if(!entry)throw Error('四张参考图尚未齐全');
    const r=await fetch(fileURL(asset,entry.path));if(!r.ok)throw Error(label+'图片读取失败');
    const blob=await r.blob(),url=URL.createObjectURL(blob);objectURLs.add(url);return {blob,url,name:label};
  }));
  modal('确认四张参考图',`<p>正面、背面、左侧、右侧分别是一张完整图片。检查造型和服装是否一致，可单独替换或调整视角归属。</p><div class="view-review">${parts.map((p,i)=>`<label><img src="${p.url}" alt="${p.name}参考图"><select data-view-slot="${i}">${referenceViews.map(([v,l],j)=>`<option value="${v}" ${i===j?'selected':''}>${l}</option>`).join('')}</select><span>替换这张图片<input type="file" data-replace-view="${i}" accept="image/png,image/jpeg,image/webp"></span></label>`).join('')}</div><button id="confirm-views" class="primary">确认四张参考图，下一步建模</button>`);
  let replacing=0;
  $('dialog-body').querySelectorAll('[data-replace-view]').forEach(input=>input.onchange=safe(async()=>{
    const f=input.files[0];if(!f)return;
    replacing++;$('confirm-views').disabled=true;
    try{const blob=await png(f),url=URL.createObjectURL(blob);objectURLs.add(url);const i=Number(input.dataset.replaceView);parts[i]={blob,url,name:f.name};input.closest('label').querySelector('img').src=url;}finally{replacing--;$('confirm-views').disabled=replacing>0;}
  }));
  $('confirm-views').onclick=safe(async()=>{
    if(replacing)return;
    const button=$('confirm-views');button.disabled=true;
    try{
      const slots=[...$('dialog-body').querySelectorAll('[data-view-slot]')].map(s=>s.value);
      if(new Set(slots).size!==4)throw Error('四个视角不能重复，请检查视角归属');
      if(keyOf(current||{})!==keyOf(asset))throw Error('当前资产已变化，请重新选择参考图');
      const next={};slots.forEach((v,i)=>next[v]=parts[i]);
      const previous=uploads;uploads={...uploads,...next};
      try{await saveUploads(asset,referenceViews.map(([v])=>v));}catch(e){uploads=previous;throw e;}
      updateForm('mode','multi');$('dialog').close();selectTool('model');toast('四张参考图已确认，点击生成模型开始建模');
    }finally{button.disabled=false;}
  });
}
function renderImages(asset) {
  const pending=currentJobs.filter(j=>j.kind==='image_generate'&&['running','queued'].includes(j.status));
  const failed=!pending.length?currentJobs.filter(j=>j.kind==='image_generate'&&j.status==='failed').at(-1):null;
  const groups=asset?fourViewGroups(asset):[];
  const complete=groups.length>0;
  const host=$('image-stage');
  host.innerHTML=`<div class="image-start-guide">${icon('images')}<h2>${complete?'四视图已就绪':'从一个想法开始'}</h2><p>${complete?'在下方查看参考图，确认后进入模型构建。':'在左侧描述想法，也可以上传图片作为参考。'}</p><div class="row">${complete?'<button class="primary" id="review-saved-views">一键载入四视图到建模</button>':'<button id="focus-image-prompt">填写描述</button><button id="start-image-upload">上传参考图</button>'}</div></div>`;
  host.innerHTML+=pending.map(j=>`<div class="image-pending" role="status">${esc(j.progress?.phase||'图片生成中')} · ${j.progress?.percent||0}%</div>`).join('');
  if(creationState)host.innerHTML+=`<section class="creation-feedback" role="status"><h2>${creationState.status==='creating'?'正在创建资产':'资产创建失败'}</h2><p>${esc(creationState.error||creationState.name)}</p></section>`;
  if(failed)host.innerHTML+=`<section class="creation-feedback failed" role="status"><h2>上次图片任务失败</h2><p>${esc(failed.error)}</p><a href="/settings.html">检查图片服务</a></section>`;
  renderImageHistory(asset);
  $('review-saved-views')?.addEventListener('click',safe(()=>groups.length===1?loadReferenceGroup(groups[0]):chooseReferenceGroup(asset)));
  $('focus-image-prompt')?.addEventListener('click',()=>document.querySelector('[data-field="prompt"]')?.focus());
  $('start-image-upload')?.addEventListener('click',()=>chooseImage('input'));
  host.hidden=tool!=='image';$('empty-stage').hidden=true;icons();
}
function imageOrder(a,b) {
  const rank=i=>{const n=referenceViews.findIndex(([v])=>i.path===`source/reference_${v}.png`||(i.path.startsWith('source/model_views/')&&i.path.endsWith('/'+v+'.png'))||new RegExp('_set\\d+_'+v+'\\.png$').test(i.path));return n<0?10:n;};
  return rank(a)-rank(b)||a.path.localeCompare(b.path);
}
function imageLabel(item) {
  const view=referenceViews.find(([v])=>item.path.includes('reference_'+v+'.')||new RegExp('_set\\d+_'+v+'\\.png$').test(item.path));
  if(item.path==='source/input_reference.png')return '创作原图';
  const modelView=referenceViews.find(([v])=>item.path.startsWith('source/model_views/')&&item.path.endsWith('/'+v+'.png'));
  if(modelView)return modelView[1];
  return view ? view[1] : item.kind==='generated'?'生成图片':item.path.split('/').pop();
}
function mediaAsset(item) { return allAssets.find(a=>keyOf(a)===item.asset); }
async function refreshImageInventory() {
  const result=await api('/api/media/images');
  const next=result.images||[],changed=JSON.stringify(next)!==JSON.stringify(imageInventory);
  imageInventory=next;
  assetMedia=current?next.filter(i=>i.asset===keyOf(current)):[];
  if(selectedImage && (prefs.archived.includes(selectedImage.asset)||!next.some(i=>i.asset===selectedImage.asset&&i.path===selectedImage.path)))selectedImage=null;
  renderMedia();
  if(changed && tool==='image')renderImages(current);
}
function selectImage(item) {
  selectedImage=item;
  tab('media'); renderMedia();
  document.querySelector('.studio-layout').classList.remove('assets-hidden');
  document.querySelectorAll('[data-image-path]').forEach(b=>b.classList.toggle('selected',b.dataset.imagePath===item.path));
}
function renderImageHistory(asset) {
  const rank=new Map(allAssets.map((a,i)=>[keyOf(a),i]));
  const visible=allAssets.filter(a=>!prefs.archived.includes(keyOf(a))&&(!asset||keyOf(a)===keyOf(asset))).flatMap(visibleAssetImages).sort((a,b)=>rank.get(a.asset)-rank.get(b.asset)||imageOrder(a,b));
  const host=$('image-stage');
  host.innerHTML+=`<section class="image-history"><header><strong>${asset?'当前资产图片':'历史图片'} · ${visible.length}</strong><span>左右浏览 · 图片可拖入上传框</span><div><button id="history-prev" aria-label="向左浏览图片">${icon('chevron-left')}</button><button id="history-next" aria-label="向右浏览图片">${icon('chevron-right')}</button></div></header><div class="history-filmstrip" tabindex="0" aria-label="图片缩略图，左右滑动">${visible.map((i,n)=>`<button class="history-image ${selectedImage?.asset===i.asset&&selectedImage?.path===i.path?'selected':''}" data-history-image="${n}" title="${esc(mediaAsset(i).name+' · '+imageLabel(i))}" aria-label="${esc(mediaAsset(i).name+' · '+imageLabel(i))}"><img loading="lazy" draggable="true" src="${fileURL(mediaAsset(i),i.path)}" alt="${esc(imageLabel(i))}"><span>${esc(imageLabel(i))}</span></button>`).join('')||'<p>生成或上传后的图片会保存在这里</p>'}</div></section>`;
  const strip=host.querySelector('.history-filmstrip');
  host.querySelectorAll('[data-history-image]').forEach(b=>{const item=visible[Number(b.dataset.historyImage)];bindImageDrag(b,item);});
  host.querySelectorAll('[data-history-image]').forEach(b=>b.onclick=()=>{if(strip.dataset.dragged==='true')return;selectImage(visible[Number(b.dataset.historyImage)]);host.querySelectorAll('[data-history-image]').forEach(el=>el.classList.toggle('selected',el===b));});
  const scroll=d=>strip.scrollBy({left:d*Math.max(160,strip.clientWidth*.7),behavior:'smooth'});
  $('history-prev').onclick=()=>scroll(-1);$('history-next').onclick=()=>scroll(1);
  const sync=()=>{$('history-prev').disabled=strip.scrollLeft<2;$('history-next').disabled=strip.scrollLeft+strip.clientWidth>=strip.scrollWidth-2;};
  strip.onscroll=sync;requestAnimationFrame(sync);
  strip.onkeydown=e=>{if(e.target===strip&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();scroll(e.key==='ArrowLeft'?-1:1);}};
  let drag=null;
  strip.onpointerdown=e=>{if(e.pointerType!=='mouse'||e.button!==0||e.target.closest('[draggable=true]'))return;drag={x:e.clientX,left:strip.scrollLeft};strip.dataset.dragged='false';};
  strip.onpointermove=e=>{if(!drag||!e.buttons)return;if(Math.abs(e.clientX-drag.x)>5){strip.dataset.dragged='true';strip.scrollLeft=drag.left-(e.clientX-drag.x);}};
  strip.onpointerup=()=>{drag=null;};strip.onpointerleave=()=>{drag=null;};
}
function visibleAssetImages(owner) {
  return assetImages(imageInventory.filter(i=>i.asset===keyOf(owner)));
}

async function renderModelImageRecords(asset,ver,context=viewer) {
  const camera=context.camera.clone(),grid=context.grid.visible,size=context.renderer.getSize(new THREE.Vector2()),ratio=context.renderer.getPixelRatio();
  const captures=[];camera.aspect=1;camera.clearViewOffset();camera.updateProjectionMatrix();
  try {
    context.grid.visible=false;context.renderer.setPixelRatio(1);context.renderer.setSize(512,512,false);
    for(const [view,xyz] of [['front',[0,0,1]],['back',[0,0,-1]],['side',[-1,0,0]],['right',[1,0,0]]]) {
      const direction=new THREE.Vector3(...xyz);if(context.planFrontNegativeZ)direction.applyAxisAngle(new THREE.Vector3(0,1,0),Math.PI);
      fit(camera,context.bounds,direction);context.renderer.render(context.scene,camera);
      captures.push({path:`source/model_views/${ver}/${view}.png`,data:context.renderer.domElement.toDataURL('image/png').split(',')[1]});
    }
  } finally {context.grid.visible=grid;context.renderer.setPixelRatio(ratio);context.renderer.setSize(size.x,size.y,false);context.renderer.render(viewer.scene,viewer.camera);}
  await Promise.all(captures.map(i=>put(fileURL(asset,i.path),{bytes_b64:i.data})));
  return captures.map(i=>({asset:keyOf(asset),path:i.path,kind:'uploaded'}));
}
async function fillMissingModelImages(asset,serial) {
  if(!viewer.obj || serial!==selectionSerial || imageInventory.some(i=>i.asset===keyOf(asset)))return;
  const records=await renderModelImageRecords(asset,version);
  if(serial!==selectionSerial)return;
  imageInventory.push(...records);assetMedia=records;renderMedia();
}

function renderMedia() {
  const selectedAsset=selectedImage&&mediaAsset(selectedImage);
  const owner=selectedAsset||current;
  const items=owner?visibleAssetImages(owner):[];
  const selected=selectedImage&&items.find(i=>i.path===selectedImage.path);
  $('media-tab').innerHTML='<a href="/library.html#images">全部图片资源</a>'+(!owner?'<p>选择资产或点击中间的历史图片，查看图片资源。</p>':`<h3>${esc(owner.name)}</h3>`)+
    (selected?`<section class="selected-image-detail"><strong>${esc(imageLabel(selected))}</strong><button id="selected-image-use" class="full">用作创作参考</button><a href="${fileURL(owner,selected.path)}" download>下载原图</a>${fourViewGroups(owner).length?'<button id="selected-image-model" class="full">加载此资产的四视图到建模</button>':''}</section>`:'')+
    (owner?`<h3>图片</h3><div class="reference-strip">${items.map(i=>`<button data-media-path="${esc(i.path)}" class="${selected?.path===i.path?'selected':''}" aria-pressed="${selected?.path===i.path}"><img loading="lazy" src="${fileURL(owner,i.path)}" alt="${esc(imageLabel(i))}"><span>${esc(imageLabel(i))}</span></button>`).join('')||'<small>暂无图片，导入模型后自动补齐四视图。</small>'}</div>`:'');
  const imageActions=$('media-tab').querySelector('.selected-image-detail');if(imageActions)$('media-tab').append(imageActions);
  $('media-tab').querySelectorAll('[data-media-path]').forEach(b=>b.onclick=()=>selectImage({asset:keyOf(owner),path:b.dataset.mediaPath}));
  $('selected-image-model')?.addEventListener('click',safe(()=>chooseReferenceGroup(owner)));
  $('media-tab').querySelectorAll('[data-media-path]').forEach(b=>{const item={asset:keyOf(owner),path:b.dataset.mediaPath};bindImageDrag(b,item);});

  $('selected-image-use')?.addEventListener('click',safe(async()=>{
    const serial=selectionSerial;
    const r=await fetch(fileURL(owner,selected.path));if(!r.ok)throw Error('图片读取失败');
    const blob=await r.blob();if(serial!==selectionSerial)throw Error('创作已切换，请重新选择图片');
    const url=URL.createObjectURL(blob);objectURLs.add(url);uploads.input={blob,url,name:imageLabel(selected)};
    selectTool('image');toast('已用作创作参考；原资产和四视图未改动');
  }));
}
function pipelineStage() {
  // 跨阶段"已运行节点"：按 6 个制作阶段命名，映射到后端 job kind
  if (!detail) return "";
  const jobs = currentJobs;
  const has = (kind, op) => jobs.some(j => j.status === 'done' && j.kind === kind && (!op || (j.operation || j.options?.operation) === op));
  const specDone = detail.spec?.description || has('spec_generate');
  const stages = [
    { key: 'reference', label: '概念设计', done: assetMedia.some(i => i.kind === 'reference') || !!detail.reference_images?.length || has('reference_generate') || has('image_generate'), tool: 'image' },
    { key: 'model', label: '几何生成', done: !!version || has('model_build') || (detail.versions?.length > 0), tool: 'model' },
    { key: 'process', label: '整理 / 纹理 / 动画', done: has('model_process'), tool: 'remesh' },
  ];
  const runningJob = jobs.find(j => ['running','queued'].includes(j.status));
  const active = runningJob ? (runningJob.kind === 'image_generate' ? null : stages.findIndex(s =>
    (runningJob.kind === 'reference_generate' && s.key === 'reference') ||
    (runningJob.kind === 'model_plan' && s.key === 'plan') ||
    (runningJob.kind === 'model_build' && s.key === 'model') ||
    (runningJob.kind === 'model_process' && s.key === 'process'))) : -1;
  return `<h3>流水线阶段</h3><ol class="pipeline-stages">${stages.map((s, i) => `<li class="${s.done ? 'done' : ''} ${i === active ? 'active' : ''}" title="${s.label}">${s.done ? icon('check') : (i === active ? icon('loader') : icon('circle'))}<button data-stage-tool="${s.tool}">${s.label}</button></li>`).join("")}</ol>${runningJob && runningJob.kind !== 'image_generate' ? `<p class="pipeline-note">${esc(runningJob.job_id)} · ${STATUS[runningJob.status] || esc(runningJob.status)}</p>` : ""}`;
}
function renderProperties() {
  if (!detail) return;
  $("properties-tab").innerHTML =
    pipelineStage() +
    `<h3>资产信息</h3><dl class="property-grid"><dt>名称</dt><dd>${esc(current.name)}</dd><dt>编号</dt><dd>${esc(current.asset_id)}</dd><dt>版本</dt><dd>${esc(version || "无")}</dd><dt>状态</dt><dd>${STATUS[current.status] || esc(current.status)}</dd><dt>网格</dt><dd>${meshes.length}</dd><dt>动画</dt><dd>${viewer.clips.length}</dd></dl><h3>参考图</h3><div class="reference-strip">${["front", "back", "side", "right"].filter(v=>assetMedia.some(i=>i.path===`source/reference_${v}.png`)).map((v, i) => `<button data-ref="${v}"><img src="${fileURL(current, `source/reference_${v}.png`)}" alt="${({front:"正面",back:"背面",side:"左侧",right:"右侧"})[v]}"><span>${({front:"正面",back:"背面",side:"左侧",right:"右侧"})[v]}</span></button>`).join("")}</div><h3>层级</h3><button class="hierarchy-row" data-mesh-index="-1">${icon("layers")}全部部件</button>${meshes.map((m, i) => `<button class="hierarchy-row" data-mesh-index="${i}" title="${esc(m.name)}">${icon("box")}<span>${esc(m.name || "Mesh " + i)}</span></button>`).join("")}<h3>模型变换</h3>${field("缩放", numeric("scale", 0.01, 10, 0.01))}${field("旋转 / 度", numeric("rotation", -180, 180, 1))}<button id="apply-transform" class="full">应用到新版本</button><h3>版本操作</h3><div class="row"><button id="compile-version">引擎包</button></div><h3>描述规格</h3><textarea id="spec-editor" aria-label="描述规格 JSON">${esc(JSON.stringify(detail.spec, null, 2))}</textarea><button id="save-spec" class="full">保存规格</button>`;
  $('properties-tab').insertAdjacentHTML('beforeend', '<details><summary>资产管理</summary><div class="asset-utilities"><button id="render-refs">从模型渲染三视图</button><button id="render-qa">生成质量检查图</button><button id="import-version">导入新版本</button><button id="compare-version">查看历史版本对照</button></div></details>');
  $('render-refs').onclick = safe(()=>exclusive(()=>captureAssetViews(false)));
  $('render-qa').onclick = safe(()=>exclusive(()=>captureAssetViews(true)));
  $('import-version').onclick = () => $('version-file').click();
  $('compare-version').onclick = compareVersion;
  $("properties-tab")
    .querySelectorAll("img")
    .forEach(
      (img) =>
        (img.onerror = () => {
          img.hidden = true;
        }),
    );
  $("properties-tab")
    .querySelectorAll("[data-ref]")
    .forEach((b) => (b.onclick = () => chooseImage(b.dataset.ref)));
  $("properties-tab")
    .querySelectorAll("[data-stage-tool]")
    .forEach((b) => (b.onclick = () => selectTool(b.dataset.stageTool)));
  $("properties-tab")
    .querySelectorAll("[data-mesh-index]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          selectedMesh = meshes[Number(b.dataset.meshIndex)] || null;
          form.mesh = selectedMesh?.name || "";
          $("selection-info").textContent = form.mesh || "全部部件";
          renderParameters();
        }),
    );
  $("properties-tab")
    .querySelectorAll("[data-field]")
    .forEach(
      (el) =>
        (el.oninput = () => {
          form[el.dataset.field] = Number(el.value);
          $("properties-tab")
            .querySelectorAll(`[data-field="${el.dataset.field}"]`)
            .forEach((other) => (other.value = el.value));
        }),
    );
  $("apply-transform").onclick = safe(() =>
    exclusive(() =>
      process("transform", { scale: form.scale, rotation: form.rotation }),
    ),
  );
  $("compile-version").onclick = safe(compileCurrent);
  $("save-spec").onclick = safe(async () => {
    await put(baseOf(current) + "/spec", {
      spec: JSON.parse($("spec-editor").value),
    });
    toast("规格已保存");
  });
  icons();
}
function renderHistory() {
  const nodes=historyNodes();
  const versions=[...$('version-select').options].map(o=>o.value).filter(Boolean).sort();
  $('history-tab').innerHTML=`<h3>模型版本历史</h3><p class="help-line">点击缩略图预览；旧版本始终保留。</p><div class="model-history-grid">${versions.map(v=>`<button data-preview-version="${esc(v)}" class="${v===version?'selected':''}" aria-pressed="${v===version}"><img loading="lazy" src="${fileURL(current,`versions/${v}/preview.png`)}" alt="${esc(v)}模型预览"><strong>${esc(v)} ${esc(versionLabels[v]||'模型')}</strong><small>${v===version?'正在查看':'点击预览'}</small></button>`).join('')||'<p>尚无模型版本</p>'}</div><details><summary>操作记录与恢复</summary>${nodes.map(n=>`<div class="history-item"><div>${esc(n.summary||n.revision_id||n.id)}<small>${esc(n.revision_id||'')}${n.id===historyTree?.head?' · 当前节点':''}</small></div><button data-checkout="${esc(n.id)}" title="恢复此版本">${icon('rotate-ccw')}</button></div>`).join('')}</details>`;
  $('history-tab').querySelectorAll('[data-preview-version]').forEach(b=>b.onclick=safe(async()=>{if(busy)throw Error('任务运行中，请稍后切换版本');await selectAsset(current,b.dataset.previewVersion);tab('history');}));
  $('history-tab').querySelectorAll('img').forEach(img=>img.onerror=()=>{img.hidden=true;const note=img.parentElement.querySelector('small');note.textContent='缩略图未保存 · 点击查看模型';});
  $('history-tab').querySelectorAll('[data-checkout]').forEach(b=>b.onclick=safe(()=>checkout(b.dataset.checkout)));
  icons();
}
// 构建流水线：把该资产经历过的 job 与版本画成节点图，并区分"生成"与"直接导入"
const BUILD_STEPS = {
  spec_generate: ["描述规格生成", "file-text"],
  image_generate: ["图片生成", "image"],
  reference_generate: ["参考图生成", "images"],
  reference_approve: ["参考图批准", "check-check"],
  spec_edit: ["规格编辑", "pencil"],
  model_plan: ["建模计划", "list-tree"],
  model_build: ["模型构建", "box"],
  model_process: ["后处理", "settings-2"],
  import_version: ["导入版本", "upload"],
};
async function renderBuild() {
  const host = $("build-tab");
  if (!current) { host.innerHTML = "<p class=\"muted\">先在资产栏选择一个资产。</p>"; return; }
  host.innerHTML = "<p class=\"muted\">正在读取构建记录…</p>";
  const jobs = currentJobs.slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  // 版本来源：version-select 里的选项就是该资产全部版本，读 meta 判断"生成"还是"导入"
  const versionKeys = [...($("version-select")?.options || [])]
    .map(o => o.value).filter(Boolean);
  const rows = [];
  for (const v of versionKeys) {
    const meta = await api(fileURL(current, `versions/${v}/meta.json`)).catch(() => ({}));
    rows.push({ version: v, meta });
  }
  const imported = rows.filter(r => String(r.meta.operation || "").startsWith("import") || r.meta.provider === "import");
  const generated = rows.filter(r => !imported.includes(r));
  const kindLabel = k => BUILD_STEPS[k]?.[0] || k;
  const kindIcon = k => BUILD_STEPS[k]?.[1] || "circle-dot";
  const stateOf = j => j.status === "done" ? "done" : j.status === "failed" ? "failed" : ["running", "queued"].includes(j.status) ? "running" : "pending";
  const node = (j) => {
    const st = stateOf(j);
    return `<div class="build-node ${st}" title="${esc(j.error || "")}">
      <span class="build-node-icon">${icon(st === "done" ? "check" : st === "failed" ? "x" : st === "running" ? "loader" : kindIcon(j.kind))}</span>
      <span class="build-node-body"><strong>${esc(kindLabel(j.kind))}</strong>
        <small>${esc(j.job_id)}${j.version ? " · " + esc(j.version) : ""}</small>
        ${j.error ? `<small class="build-error">${esc(j.error.slice(0, 120))}</small>` : ""}</span>
    </div>`;
  };
  host.innerHTML = `
    <h3>构建流水线</h3>
    <p class="build-summary">${esc(current.name)} · 共 ${jobs.length} 个任务${rows.length ? ` · ${rows.length} 个版本` : ""}
      ${imported.length ? ` · <strong>${imported.length} 个为直接导入</strong>` : ""}${generated.length ? ` · ${generated.length} 个为生成` : ""}</p>
    ${rows.length ? `<div class="build-versions">
      ${generated.length ? `<div class="build-vgroup"><span class="build-vtag generated">${icon("sparkles")}生成</span>${generated.map(r => `<span class="build-vchip" title="${esc(r.meta.provider || "")} · ${esc(r.meta.operation || "")}">${esc(r.version)}${r.meta.validation?.triangles ? ` <small>${r.meta.validation.triangles.toLocaleString()} 面</small>` : ""}</span>`).join("")}</div>` : ""}
      ${imported.length ? `<div class="build-vgroup"><span class="build-vtag imported">${icon("upload")}直接导入</span>${imported.map(r => `<span class="build-vchip">${esc(r.version)}</span>`).join("")}</div>` : ""}
    </div>` : '<p class="muted">还没有任何版本。到「模型构建」生成，或用「上传 3D 模型」导入。</p>'}
    ${jobs.length ? `<h3>任务顺序</h3><div class="build-flow">${jobs.map(node).join("")}</div>` : ""}
  `;
  icons();
}
async function checkout(node) {
  const result = await post(baseOf(current) + "/history/checkout", { node_id: node });
  await selectAsset(current, result.node.revision_id);
  toast("已切换历史节点");
}
function tab(value) {
  currentTab = value;
  for (const name of ["assets", "properties", "history", "media", "build"])
    $(name + "-tab").hidden = name !== value;
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === value));
  if (value === "build") renderBuild();
  if (value === "media") refreshImageInventory().catch(e=>toast("图片资源加载失败："+e.message));
}

async function importModel(file) {
  if (file.size > 150 * 1024 * 1024) throw new Error("模型不能超过 150 MB");
  let blob = file;
  const ext = file.name.split(".").pop().toLowerCase();
  showProgress("正在导入 " + file.name, 10);
  if (ext !== "glb") {
    let obj;
    const raw = await file.arrayBuffer();
    if (ext === "obj") {
      const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js");
      obj = new OBJLoader().parse(new TextDecoder().decode(raw));
    } else if (ext === "stl") {
      const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
      obj = new THREE.Mesh(
        new STLLoader().parse(raw),
        new THREE.MeshStandardMaterial({ color: 0xbfc4c9 }),
      );
    } else if (ext === "fbx") {
      const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
      obj = new FBXLoader().parse(raw, "");
    } else throw new Error("不支持的格式");
    const binary = await new GLTFExporter().parseAsync(obj, {
      binary: true,
      animations: obj.animations || [],
    });
    blob = new Blob([binary], { type: "model/gltf-binary" });
    disposeObject(obj);
  }
  const body = new FormData();
  body.set("file", blob, "model.glb");
  body.set("name", form.assetName.trim());
  body.set("asset_type", "prop");
  const r = await api("/api/assets/import", { method: "POST", body });
  await refreshAssets();
  await selectAsset(allAssets.find((a) => a.asset_id === r.asset_id));
  await savePreview();
  showProgress("已导入 " + file.name, 100);
}
function disposeObject(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    [o.material]
      .flat()
      .filter(Boolean)
      .forEach((m) => {
        Object.values(m).forEach((t) => t?.isTexture && t.dispose());
        m.dispose();
      });
  });
}
async function savePreview(quiet = false) {
  if (!current || !version || !viewer.obj) throw new Error("先选择模型");
  const asset = current, ver = version;
  const source = viewer.renderer.domElement;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 320;
  const camera = viewer.camera.clone(); camera.aspect = 1; camera.clearViewOffset();
  fit(camera, bounds(viewer.obj), viewer.camera.position.clone().sub(viewer.controls.target));
  const size = viewer.renderer.getSize(new THREE.Vector2());
  const gridVisible = viewer.grid.visible;
  try {
    viewer.grid.visible = false;
    viewer.renderer.setSize(320,320,false);
    viewer.renderer.render(viewer.scene,camera);
    canvas.getContext('2d').drawImage(source,0,0,320,320);
  } finally {
    viewer.grid.visible = gridVisible;
    viewer.renderer.setSize(size.x,size.y,false);
    viewer.renderer.render(viewer.scene,viewer.camera);
  }
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  await put(fileURL(asset, `versions/${ver}/preview.png`), {
    bytes_b64: await base64(blob),
  });
  await refreshAssets();
  asset.preview = `versions/${ver}/preview.png`;
  if (!quiet) toast("缩略图已保存");
}
async function exportCurrent(format = "glb") {
  if (!current || !version || !viewer.obj) throw new Error("先选择模型");
  if (format === "glb") {
    const r = await fetch(fileURL(current, `versions/${version}/model.glb`));
    if (!r.ok) throw new Error("下载失败");
    download(await r.blob(), `${current.asset_id}-${version}.glb`);
  } else if (format === "obj") {
    const { OBJExporter } = await import(
      "three/addons/exporters/OBJExporter.js"
    );
    download(
      new Blob([new OBJExporter().parse(viewer.obj)]),
      `${current.asset_id}.obj`,
    );
  } else if (format === "stl") {
    const { STLExporter } = await import(
      "three/addons/exporters/STLExporter.js"
    );
    download(
      new Blob([new STLExporter().parse(viewer.obj, { binary: true })]),
      `${current.asset_id}.stl`,
    );
  }
}
async function compileCurrent() {
  if (!version) throw new Error("先选择模型");
  const r = await post(`${baseOf(current)}/versions/${version}/compile`);
  const url =
    r.url ||
    r.download_url ||
    (r.key
      ? fileURL(current, r.key.replace(keyOf(current) + "/", ""))
      : fileURL(current, `versions/${version}/compiled.zip`));
  const res = await fetch(url);
  if (!res.ok) throw new Error("引擎包下载失败");
  download(await res.blob(), `${current.asset_id}-${version}.zip`);
}
function exportDialog() {
  modal(
    "下载模型",
    `<label class="field">格式</label><select id="export-format" class="full"><option value="glb">GLB · 材质与动画</option><option value="obj">OBJ · 几何</option><option value="stl">STL · 几何</option><option value="bundle">ZIP · 引擎交付包</option></select><button id="do-export" class="primary">导出当前版本</button><hr class="section-rule"><div class="row"><a href="/library.html">Unity / Godot 资产管理</a><a href="/settings.html">模型设置</a></div><p class="help-line">Blender、Unity、Godot 可使用 GLB。Maya、3ds Max 可使用 OBJ；Unreal 可通过 glTF 导入器读取 GLB。</p>`,
  );
  $("do-export").onclick = safe(async () => {
    if ($("export-format").value === "bundle") await compileCurrent();
    else await exportCurrent($("export-format").value);
  });
}
function tasksDialog() {
  modal(
    "任务记录",
    currentJobs
      .slice()
      .reverse()
      .map(
        (j) =>
          `<div class="history-item"><div>${j.kind==='image_generate'?'图片生成':j.kind==='model_build'?'模型生成':esc(j.kind)} · ${esc(j.job_id)}<small>${STATUS[j.status] || esc(j.status)}${j.version ? " · " + esc(j.version) : ""}</small>${j.error ? `<p>${esc(j.error)}</p>` : ""}</div>${j.status === "running" ? `<button data-watch="${j.job_id}">查看</button>` : ["tripo","tripo_studio"].includes(j.provider) && (j.provider_task_id || j.runner_id) && j.status==="waiting" ? `<button data-resume="${j.job_id}">查询原任务</button>` : ""}</div>`,
      )
      .join("") || "<p>暂无任务</p>",
  );
  $("dialog-body")
    .querySelectorAll("[data-watch]")
    .forEach(
      (b) =>
        (b.onclick = safe(async () => {
          $("dialog").close();
          await waitJob(current, b.dataset.watch);
          await selectAsset(current);
        })),
    );
  $('dialog-body').querySelectorAll('[data-resume]').forEach(b=>b.onclick=safe(async()=>{
    const asset=current;
    await post(baseOf(asset)+'/jobs/'+b.dataset.resume+'/resume');
    $('dialog').close();
    await exclusive(async()=>{const job=await waitJob(asset,b.dataset.resume);await refreshAssets();await selectAsset(asset,job.version);});
  }));

}

const painted = new Map(),
  raycaster = new THREE.Raycaster(),
  pointer = new THREE.Vector2();
function hit(event) {
  if (!viewer.obj) return null;
  const rect = viewer.renderer.domElement.getBoundingClientRect();
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    (-(event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, viewer.camera);
  return raycaster
    .intersectObject(viewer.obj, true)
    .find(
      (hit) =>
        hit.object.isMesh && (!form.mesh || hit.object.name === form.mesh),
    );
}
function paint(event) {
  const result = hit(event);
  if (!result?.uv) return;
  const mesh = result.object;
  let state = painted.get(mesh);
  if (!state) {
    if (Array.isArray(mesh.material)) return toast("多材质部件请先按材质拆分");
    const original = mesh.material;
    const canvas = document.createElement("canvas");
    const image = original.map?.image;
    canvas.width = image?.width || 1024; canvas.height = image?.height || 1024;
    const context = canvas.getContext("2d");
    context.fillStyle = "#" + original.color.getHexString();
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (image) context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const material = original.clone(),
      texture = new THREE.CanvasTexture(canvas);
    texture.flipY = original.map?.flipY ?? false;
    texture.colorSpace = THREE.SRGBColorSpace;
    material.map = texture;
    material.color.set("#ffffff");
    mesh.material = material;
    viewer.originals.set(mesh, material);
    viewer.alternatives.delete(mesh);
    viewer.replacements.add(original);
    state = { canvas, context, texture, original, material };
    painted.set(mesh, state);
  }
  const uv = result.uv;
  const x = uv.x * state.canvas.width,
    y = (state.texture.flipY ? 1 - uv.y : uv.y) * state.canvas.height;
  state.context.fillStyle = form.color;
  state.context.beginPath();
  state.context.arc(x, y, Number(form.paintSize), 0, Math.PI * 2);
  state.context.fill();
  state.texture.needsUpdate = true;
}
viewer.renderer.domElement.addEventListener("pointerdown", (e) => {
  pickStart = [e.clientX, e.clientY];
  if (painting) {
    viewer.renderer.domElement.setPointerCapture(e.pointerId);
    paint(e);
  }
});
viewer.renderer.domElement.addEventListener("pointermove", (e) => {
  if (painting && e.buttons === 1) paint(e);
});
viewer.renderer.domElement.addEventListener("pointerup", (e) => {
  if (
    painting ||
    !pickStart ||
    Math.hypot(e.clientX - pickStart[0], e.clientY - pickStart[1]) > 5
  )
    return;
  const result = hit(e);
  if (result) {
    selectedMesh = result.object;
    form.mesh = selectedMesh.name;
    $("selection-info").textContent = selectedMesh.name;
    renderParameters();
  }
});
async function savePaint() {
  if (!painted.size) throw new Error("尚无绘制修改");
  restoreMaterials();
  const asset = current;
  const binary = await new GLTFExporter().parseAsync(viewer.obj, {
    binary: true,
    animations: viewer.clips,
  });
  const r = await post(baseOf(asset) + "/versions/import", {
    glb_b64: await base64(new Blob([binary])),
    provider: "workbench_paint",
  });
  painted.clear();
  await refreshAssets();
  await selectAsset(
    allAssets.find((a) => a.asset_id === asset.asset_id) || asset,
    r.version,
  );
}

function restoreMaterials() {
  const mode = viewer.container.querySelector('[data-mode]');
  mode.value = 'original';
  mode.dispatchEvent(new Event('change'));
}

$('model-history').onclick=()=>{tab('history');document.querySelector('.studio-layout').classList.remove('assets-hidden');};
$("run-tool").onclick = safe(runTool);
$("close-dialog").onclick = () => $("dialog").close();
$("dialog").addEventListener("click", (e) => {
  if (e.target === $("dialog")) {
    const r = $("dialog").getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      $("dialog").close();
  }
});
const projectHost=document.createElement('div');
$('assets-tab').prepend(projectHost);
const projects=mountProjects(projectHost,{api,assets:()=>allAssets,ref:keyOf,selected:()=>checked.size?[...checked]:current?[keyOf(current)]:[],onChange:renderAssets});
let syncingAssets=false;
async function syncAssets(){if(document.hidden||syncingAssets)return;syncingAssets=true;try{await refreshAssets();}catch(e){console.warn('资产同步失败',e);}finally{syncingAssets=false;}}
window.addEventListener('focus',syncAssets);
window.addEventListener('storage',e=>{if(e.key==='aigccat-assets-changed')syncAssets();});
setInterval(syncAssets,10000);
$("asset-search").oninput = renderAssets;
$("type-filter").onchange = renderAssets;
$("status-filter").onchange = renderAssets;
$("type-filter").insertAdjacentHTML(
  "beforeend",
  Object.entries(TYPES)
    .map(([key, [name]]) => `<option value="${key}">${name}</option>`)
    .join(""),
);
document.querySelectorAll("[data-collection]").forEach(
  (b) =>
    (b.onclick = () => {
      collection = b.dataset.collection;
      document
        .querySelectorAll("[data-collection]")
        .forEach((x) => x.classList.toggle("active", x === b));
      renderAssets();
    }),
);
document
  .querySelectorAll("[data-tab]")
  .forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
$("refresh-assets").onclick = safe(refreshAssets);
$("manage-assets").onclick = () => {
  managing = !managing;
  checked.clear();
  renderAssets();
};
$("select-all").onclick = () => {
  $("asset-list")
    .querySelectorAll("[data-check]")
    .forEach((b) => checked.add(b.dataset.check));
  renderAssets();
};
$("batch-archive").onclick = safe(async () => {
  const button = $('batch-archive'), restore = collection === 'archived';
  if(button.disabled) return;
  button.disabled = true;
  try {
    const result = await moveToTrash(api, [...checked], restore);
    prefs.archived = result.archived;
    checked.clear(); await refreshAssets();
    modal('资产管理结果', `<p>${esc(trashResult(result,restore))}</p><a href="/library.html">打开资产库与回收站</a>`);
  } finally { button.disabled = false; }
});
$("batch-export").onclick = safe(async () => {
  if (!checked.size) throw new Error("先选择资产");
  for (const key of checked) {
    const a = allAssets.find((a) => keyOf(a) === key);
    if (!a?.version) continue;
    const r = await fetch(fileURL(a, `versions/${a.version}/model.glb`));
    if (!r.ok) throw new Error("导出失败：" + a.name);
    download(await r.blob(), a.asset_id + ".glb");
  }
});
$("toggle-assets").onclick = () =>
  document.querySelector(".studio-layout").classList.toggle("assets-hidden");
$("assets-header").onclick = $("toggle-assets").onclick;
const mobileLayout = matchMedia('(max-width:850px)');
mobileLayout.addEventListener('change', e => document.querySelector('.studio-layout').classList.toggle('assets-hidden',e.matches));
$("version-select").onchange = safe(() =>
  selectAsset(current, $("version-select").value),
);
$("save-preview").onclick = safe(() => savePreview());
$("export-model").onclick = exportDialog;
$("tasks-button").onclick = safe(async () => {
  await loadJobs();
  tasksDialog();
});
$("dismiss-job").onclick = () => ($("job-progress").hidden = true);
$("upload-model").onclick = () => $("model-file").click();
$("model-file").onchange = safe(async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) await exclusive(() => importModel(file));
});
async function captureAssetViews(qa) {
  if(!viewer.obj || !version) throw new Error('先选择模型');
  if(!qa && !confirm('用模型渲染结果替换当前正面、侧面、背面建模参考？')) return;
  const asset=current, ver=version, camera=viewer.camera.clone(), visible=viewer.grid.visible;
  camera.clearViewOffset();
  const captures=[];
  try {
    viewer.grid.visible=false;
    for(const [name,xyz] of Object.entries({front:[0,0,1],side:[1,0,0],back:[0,0,-1],...(qa?{'34':[.7,.5,.7]}:{})})) {
      const direction=new THREE.Vector3(...xyz);
      if(viewer.planFrontNegativeZ) direction.applyAxisAngle(new THREE.Vector3(0,1,0),Math.PI);
      fit(camera,bounds(viewer.obj),direction);
      viewer.renderer.render(viewer.scene,camera);
      captures.push({name:`qa_${name}.png`,view:name,data_b64:viewer.renderer.domElement.toDataURL('image/png').split(',')[1]});
    }
  } finally {viewer.grid.visible=visible; viewer.renderer.render(viewer.scene,viewer.camera);}
  if(qa) {
    await post(`${baseOf(asset)}/versions/${ver}/qa`,{images:captures.map(({name,data_b64})=>({name,data_b64}))});
    modal('质量检查图',`<div class="media-grid">${captures.map(i=>`<figure><img src="${fileURL(asset,`versions/${ver}/qa/${i.name}`)}" alt="${i.view}"></figure>`).join('')}</div>`);
  } else {
    for(const i of captures) await put(fileURL(asset,`source/reference_${i.view}.png`),{bytes_b64:i.data_b64});
    await selectAsset(asset,ver); tab('media');
  }
  toast('渲染结果已保存');
}
function compareVersion() {
  if(!current || !version) return toast('先选择模型');
  const asset=current, versions=[...$('version-select').options].filter(o=>o.value);
  modal('历史版本对照',`<select id="compare-choice" aria-label="对比版本">${versions.map(o=>`<option>${esc(o.value)}</option>`).join('')}</select><div id="compare-stage"></div>`);
  const other=viewers.createViewer($('compare-stage'),400);
  $('compare-choice').onchange=()=>viewers.loadInto(other,fileURL(asset,`versions/${$('compare-choice').value}/model.glb`));
  $('compare-choice').onchange();
  $('dialog').addEventListener('close',()=>viewers.disposeViewer(other),{once:true});
}
$('version-file').onchange = safe(async event=>{
  const file=event.target.files[0]; event.target.value=''; if(!file || !current) return;
  if(file.size>23*1024*1024) throw new Error('版本 GLB 不得超过 23 MB');
  const asset=current;
  await exclusive(async()=>{
    const r=await post(baseOf(asset)+'/versions/import',{glb_b64:await base64(file),provider:'external',expected_history_node_id:historyTree?.head});
    await refreshAssets(); await selectAsset(allAssets.find(a=>keyOf(a)===keyOf(asset))||asset,r.version);
  });
});
function newDraft(preservePrompt = false) {
  assetSelectionAbort?.abort();
  assetTransition.cancel();
  if (busy) return toast('等待当前任务结束后再新建');
  ++selectionSerial;
  current = null; version = ''; detail = null; historyTree = null;
  creationState = null;
  imageResults = []; assetMedia = []; currentJobs = []; uploads = {}; meshes = []; selectedImage = null;
  painted.clear(); undoCheckout.length = 0;
  viewers.clearViewer(viewer);
  if (!preservePrompt) updateForm('prompt','');
  updateForm('assetName','');
  updateForm('imageInput','text');
  $('empty-stage').querySelector('h2').textContent = '填写描述或上传参考图，开始生成模型';
  $('asset-title').textContent = '未命名创作';
  $('asset-status').textContent = '草稿';
  $('version-select').innerHTML = '<option value="">无模型</option>';
  $('properties-tab').innerHTML = ''; $('history-tab').innerHTML = '';
  $('job-progress').hidden = true;
  renderMedia(); renderAssets(); selectTool('image');
  refreshImageInventory().catch(e=>toast('图片资源加载失败：'+e.message));
}
$('new-asset').onclick = () => newDraft();
$("undo").onclick = safe(async () => {
  const tree = historyTree?.tree || historyTree,
    nodes = historyNodes(),
    head = nodes.find(
      (n) => (n.id || n.node_id) === (tree?.head || tree?.head_node_id),
    );
  const parent = head?.parent_id || head?.parent;
  if (!parent) throw new Error("已到最早历史节点");
  undoCheckout.push(head.id || head.node_id);
  await checkout(parent);
});
$("redo").onclick = safe(async () => {
  const next = undoCheckout.pop();
  if (!next) throw new Error("没有可恢复的历史节点");
  await checkout(next);
});
window.addEventListener("beforeunload", () => {
  disposeAssetProgress();
  generationIndicator.dispose();
  viewers.disposeViewers();
  objectURLs.forEach((url) => URL.revokeObjectURL(url));
});
async function boot() {
  const bootSelection = selectionSerial;
  if (innerWidth <= 850)
    document.querySelector(".studio-layout").classList.add("assets-hidden");
  try {
    prefs = { ...prefs, ...(await api("/api/workbench/state")) };
    creationOptions=creationConfig(prefs);
    form = { ...defaults, ...prefs.settings, imageResolution: ["1080","2048","3840"].includes(prefs.settings?.imageResolution)?prefs.settings.imageResolution:"1080", assetName: "", modelSource:"studio" };
    form.mode='multi';

  } catch (e) {
    toast("工作台设置暂不可用：" + e.message);
  }
  void refreshStudioHealth();
  serviceInfo = await api("/api/settings/services").catch(() => ({}));
  modelCatalog = await api('/api/settings/catalog').catch(()=>({models:[],providers:[]}));
  renderServiceStatus();
  await refreshAssets();
  if(selectionSerial !== bootSelection) return;
  const hash = new URLSearchParams(location.hash.slice(1));
  const legacyAsset = /^#(characters|props|scenes)\//.test(location.hash) ? decodeURIComponent(location.hash.slice(1)) : null;
  const initial =
    allAssets.find(
      (a) => keyOf(a) === (hash.get("asset") || legacyAsset || prefs.last_asset),
    ) || allAssets.find((a) => a.version && !prefs.archived.includes(keyOf(a)));
  // 默认工具取决于资产现状：已经有模型的资产直接进模型视图，否则进图片创作。
  // 否则打开一个有模型的资产却显示"等待生成图片"，用户以为模型丢了。
  tool = hash.get("tool") || "model";
  if (!TOOLS.some((t) => t[0] === tool)) tool = "model";
  selectTool(tool);
  if (hash.has('new') || !hash.has('asset') && !legacyAsset) newDraft(false);
  else if (initial) { await selectAsset(initial); if(hash.has("tool")) selectTool(hash.get("tool")); }
  icons();
}
safe(boot)();
window.addEventListener('hashchange', safe(async()=>{
  const route=new URLSearchParams(location.hash.slice(1));
  if(route.has('new') || !location.hash) return newDraft();
  const asset=allAssets.find(a=>keyOf(a)===route.get('asset'));
  if(asset && keyOf(asset)!==keyOf(current||{})) await selectAsset(asset);
  if(route.has('tool')) selectTool(route.get('tool'));
}));
setInterval(() => {
  if (!busy && currentJobs.some(j=>['running','queued'].includes(j.status))) loadJobs().catch(e=>{generationIndicator.update(null,'');toast(e.message);});
}, 4000);
