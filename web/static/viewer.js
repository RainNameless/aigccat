import { modelBytes } from './model-download.js?v=2';
import * as THREE from 'three';
import { MeshoptDecoder } from './vendor/meshoptimizer/meshopt_decoder.mjs';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// 每个查看器独立拥有场景资源；过期加载结果也必须释放。
export function viewerTools(modelBounds, fitCamera) {
  const viewers = [];
  const directions = { front:[0,0,1], back:[0,0,-1], left:[-1,0,0], right:[1,0,0], side:[1,0,0], top:[0,1,0.0001], '34':[0.7,0.5,0.7] };
  function release(roots, originals = new Map(), replacements = new Set()) {
    const geometries = new Set(), materials = new Set(replacements), textures = new Set(), skeletons = new Set();
    roots.forEach(root => root?.traverse(o => {
      if (o.geometry) geometries.add(o.geometry);
      if (o.skeleton) skeletons.add(o.skeleton);
      [o.material, originals.get(o)].flat().filter(Boolean).forEach(m => materials.add(m));
    }));
    materials.forEach(m => Object.values(m).forEach(t => { if (t?.isTexture) textures.add(t); }));
    const images = new Set();
    textures.forEach(t => { if (t.source?.data) images.add(t.source.data); t.dispose(); });
    images.forEach(i => i.close?.());
    materials.forEach(m => m.dispose()); geometries.forEach(g => g.dispose()); skeletons.forEach(s => s.dispose());
  }
  function clearModel(v) {
    v.loadAbort?.abort();
    v.loadAbort = null;
    delete v.container.dataset.loading;
    v.overlays?.forEach(({overlay}) => { overlay.removeFromParent(); overlay.material.dispose(); });
    v.overlays = [];
    if(v.skeletonHelper) { v.skeletonHelper.removeFromParent(); v.skeletonHelper.geometry.dispose(); v.skeletonHelper.material.dispose(); v.skeletonHelper=null; }
    v.modelURL = null;
    if (v.mixer) { v.mixer.stopAllAction(); if(v.obj) v.mixer.uncacheRoot(v.obj); }
    release(v.roots || [], v.originals, v.replacements);
    v.playing = false;
    v.obj?.removeFromParent(); v.obj = null; v.bounds = null; v.mixer = null; v.action = null; v.clips = [];
    v.roots = []; v.originals.clear(); v.replacements.clear(); v.alternatives.clear();
    v.animationUI.hidden = true;
    syncToolbar(v);
  }
  function resetControls(v) {
    const c = v.controls, target = c.target.clone();
    c.dispose();
    const next = new OrbitControls(v.camera, v.renderer.domElement);
    next.target.copy(target); next.enableDamping = true; next.dampingFactor = 0.08;
    next.mouseButtons = { LEFT:THREE.MOUSE.ROTATE, MIDDLE:THREE.MOUSE.DOLLY, RIGHT:THREE.MOUSE.PAN };
    next.touches = { ONE:THREE.TOUCH.ROTATE, TWO:THREE.TOUCH.DOLLY_PAN };
    next.screenSpacePanning = true; next.rotateSpeed = 0.7; next.zoomSpeed = 0.8;
    next.autoRotate = v.container.querySelector('[data-rotate]').checked; next.autoRotateSpeed = 0.6; v.controls = next;
  }
  function camFor(v, preset) {
    if (!v.obj) return;
    const direction = preset ? new THREE.Vector3(...directions[preset]) : v.camera.position.clone().sub(v.controls.target);
    // Only tagged plans use -Z as front; do not flip unrelated legacy assets.
    if (preset && v.planFrontNegativeZ) direction.applyAxisAngle(new THREE.Vector3(0,1,0), Math.PI);
    const autoRotate = v.controls.autoRotate;
    resetControls(v);
    v.controls.autoRotate = autoRotate;
    v.container.querySelector('[data-rotate]').checked = autoRotate;
    frameModel(v,direction);
  }
  function frameModel(v,direction) {
    const stage=v.container.querySelector('.viewer-stage'), width=stage.clientWidth, height=stage.clientHeight;
    v.camera.clearViewOffset();
    fitCamera(v.camera,v.bounds,direction,v.controls);
    // Reserve screen space below the model for the floating controls.
    if(width && height) {
      v.camera.position.sub(v.controls.target).multiplyScalar(height/Math.max(height-80,height*.5)).add(v.controls.target);
      v.camera.setViewOffset(width,height,0,24,width,height);
    }
  }
  function setMode(v, mode) {
    if (!['original','solid','wire','albedo','normal'].includes(mode)) return;
    v.mode = mode;
    v.originals.forEach((original, mesh) => {
      if (mode === 'original') { mesh.material = original; return; }
      if (!v.alternatives.has(mesh)) v.alternatives.set(mesh, {});
      const cache = v.alternatives.get(mesh);
      if (!cache[mode]) {
        const make = m => {
          const options = { side:m.side, flatShading:m.flatShading };
          const replacement = mode === 'normal' ? new THREE.MeshNormalMaterial(options) : mode === 'albedo' ? new THREE.MeshBasicMaterial({...options,map:m.map, color:m.color || 0xffffff, alphaMap:m.alphaMap,alphaTest:m.alphaTest,transparent:m.transparent,opacity:m.opacity}) : new THREE.MeshStandardMaterial({ ...options, color:0xe5e7e9, roughness:0.8, metalness:0, polygonOffset:mode==='wire',polygonOffsetFactor:1,polygonOffsetUnits:1 });
          v.replacements.add(replacement); return replacement;
        };
        cache[mode] = Array.isArray(original) ? original.map(make) : make(original);
      }
      mesh.material = cache[mode];
    });
    if(mode === 'wire' && !v.overlays.length) {
      v.originals.forEach((original,mesh) => {
        // Overlay geometry stays outside the model tree so exports and picking keep the source model.
        const overlay = mesh.clone(false);
        overlay.material = new THREE.MeshBasicMaterial({color:0x252a31,wireframe:true,transparent:true,opacity:0.55,depthWrite:false});
        overlay.matrixAutoUpdate=false; overlay.renderOrder=1; overlay.frustumCulled=false;
        if(mesh.morphTargetInfluences) overlay.morphTargetInfluences=mesh.morphTargetInfluences;
        v.scene.add(overlay); v.overlays.push({mesh,overlay});
      });
    }
    v.overlays.forEach(({overlay}) => { overlay.visible=mode==='wire'; });
    syncToolbar(v);
  }
  function syncToolbar(v) {
    const q=s=>v.container.querySelector(s);
    q('[data-mode]').value=v.mode;
    v.container.querySelectorAll('[data-view-mode]').forEach(b=>{ b.disabled=!v.obj; b.setAttribute('aria-pressed',String(b.dataset.viewMode===v.mode)); });
    q('[data-bones]').disabled=!v.skeletonHelper;
    q('[data-bones]').setAttribute('aria-pressed',String(!!v.skeletonHelper?.visible));
    q('[data-download]').disabled=!v.modelURL;
    ['data-fit','data-view','data-shot','data-rotate'].forEach(attr => { q(`[${attr}]`).disabled=!v.obj; });
    v.container.dataset.displayMode=v.mode;
    v.grid.visible=!!v.obj && q('[data-grid]').checked;
    const hasModel=String(!!v.obj);
    if(v.container.dataset.hasModel!==hasModel) {
      v.container.dataset.hasModel=hasModel;
      v.container.dispatchEvent(new CustomEvent('viewer-model-state',{detail:{hasModel:!!v.obj}}));
    }
  }
  function updateTimelineUI(v) {
    const tl = v.animationUI.querySelector('[data-timeline]'); if (!tl || !tl.isConnected) return;
    tl.hidden = !v.clips.length;
    if (!v.clips.length) return;
    const clip = v.clips[Number(v.animationUI.querySelector('[data-clip]').value)];
    v.animationUI.querySelector('[data-play]').textContent = v.playing ? '暂停动画' : '播放动画';
    const total = Math.round(clip.duration * 24);
    const scrub = tl.querySelector('[data-timeline-scrub]');
    const label = tl.querySelector('[data-timeline-label]');
    if (scrub.max !== String(total)) { scrub.max = String(total); }
    const current = v.mixer && v.action ? Math.round(v.action.time * 24) : 0;
    if (document.activeElement !== scrub) scrub.value = String(current);
    label.textContent = `${current}/${total}`;
    const btn = tl.querySelector('[data-timeline-toggle]');
    if (btn.dataset.playing !== String(v.playing)) {
    btn.dataset.playing = String(v.playing);
    btn.innerHTML = v.playing
      ? '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    btn.title = v.playing ? '暂停' : '播放';
    btn.setAttribute('aria-label',btn.title);
    }
  }
  function bindTimeline(v) {
    const tl = v.animationUI.querySelector('[data-timeline]'); if (!tl || tl._bound) return;
    tl._bound = true;
    // loadInto 在 createViewer 之外，拿不到内部的 on()；用 v.events.signal 管理生命周期
    const sig = v.events?.signal;
    const on = (el, type, fn) => el && el.addEventListener(type, fn, sig ? { signal: sig } : {});
    on(tl.querySelector('[data-timeline-prev]'), 'click', () => {
      if (!v.action && v.clips.length) v.animationUI.querySelector('[data-clip]').dispatchEvent(new Event('change'));
      if (!v.action) return;
      v.action.paused = true; v.playing = false;
      v.action.time = Math.max(0, v.action.time - 1/24);
      v.mixer?.update(0);
      updateTimelineUI(v);
    });
    on(tl.querySelector('[data-timeline-next]'), 'click', () => {
      if (!v.action && v.clips.length) v.animationUI.querySelector('[data-clip]').dispatchEvent(new Event('change'));
      if (!v.action) return;
      v.action.paused = true; v.playing = false;
      const total = v.clips[Number(v.animationUI.querySelector('[data-clip]').value)].duration;
      v.action.time = Math.min(total, v.action.time + 1/24);
      v.mixer?.update(0);
      updateTimelineUI(v);
    });
    on(tl.querySelector('[data-timeline-toggle]'), 'click', () => {
      if (!v.action && v.clips.length) v.animationUI.querySelector('[data-clip]').dispatchEvent(new Event('change'));
      if (!v.action) return;
      v.playing = !v.playing;
      v.action.paused = !v.playing;
      if (v.playing && v.action.time >= v.clips[Number(v.animationUI.querySelector('[data-clip]').value)].duration) v.action.time = 0;
      v.mixer?.update(0);
      updateTimelineUI(v);
    });
    on(tl.querySelector('[data-timeline-scrub]'), 'input', (e) => {
      if (!v.action && v.clips.length) v.animationUI.querySelector('[data-clip]').dispatchEvent(new Event('change'));
      if (!v.action) return;
      v.action.paused = true; v.playing = false;
      v.action.time = Number(e.target.value) / 24;
      v.mixer?.update(0);
      updateTimelineUI(v);
    });
  }
  function createViewer(container, heightPx = 480) {
    container.classList.add('model-viewer');
    container.innerHTML = `<div class="viewer-tools">
      <select data-mode aria-label="显示材质" hidden><option value="original">纹理</option><option value="solid">白模</option><option value="normal">法线</option><option value="wire">线框＋白模</option><option value="albedo">反照率</option></select>
      <select data-view aria-label="视角"><option value="">选择视角</option><option value="front">正面</option><option value="back">背面</option><option value="left">左侧</option><option value="right">右侧</option><option value="top">俯视</option></select>
      <button data-fit title="居中取景（保留当前方向）" aria-label="居中取景"><i data-lucide="crosshair"></i></button><button data-full title="全屏" aria-label="全屏"><i data-lucide="maximize"></i></button><button data-shot title="截图" aria-label="截图"><i data-lucide="camera"></i></button>
      <label><input type="checkbox" data-grid checked>网格</label><label><input type="checkbox" data-rotate checked>自动转</label>
      <div class="viewer-display-settings" role="group" aria-label="显示设置"><label>背景<input data-bg type="color" value="#0a0f1d"></label><label>曝光<input data-exposure type="range" min="0.1" max="3" step="0.05" value="1" aria-label="曝光"></label></div>
      <span data-animation hidden><select data-clip aria-label="动画片段"></select><button data-play>播放动画</button><div class="anim-timeline" data-timeline hidden><button data-timeline-prev title="上一帧" aria-label="上一帧"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" fill="currentColor"/></svg></button><button data-timeline-toggle title="播放/暂停" aria-label="播放或暂停"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></button><button data-timeline-next title="下一帧" aria-label="下一帧"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M16 6h2v12h-2zM6 6v12l8.5-6z" fill="currentColor"/></svg></button><input data-timeline-scrub type="range" min="0" max="0" step="1" value="0" aria-label="动画时间轴"><span data-timeline-label>0/0</span></div></span>
    </div><div class="viewer-stage" tabindex="0" aria-label="模型视图"><div class="viewport-dock" role="toolbar" aria-label="模型显示工具">${[['solid','circle','白模'],['wire','boxes','线框＋白模'],['original','paint-bucket','纹理'],['albedo','sun','反照率'],['normal','scan-face','法线']].map(([mode,icon,label])=>`<button data-view-mode="${mode}" title="${label}" aria-label="${label}" aria-pressed="false"><i data-lucide="${icon}"></i><span class="dock-tooltip">${label}</span></button>`).join('')}<span class="dock-divider"></span><button data-rot="-90" title="逆时针旋转 90°" aria-label="逆时针旋转"><i data-lucide="rotate-ccw"></i><span class="dock-tooltip">逆时针</span></button><button data-rot="0" title="朝向重置（正面）" aria-label="朝向重置"><i data-lucide="compass"></i><span class="dock-tooltip">重置朝向</span></button><button data-rot="90" title="顺时针旋转 90°" aria-label="顺时针旋转"><i data-lucide="rotate-cw"></i><span class="dock-tooltip">顺时针</span></button><span class="dock-divider"></span><button data-bones title="骨骼显示（需要带骨骼模型）" aria-label="骨骼显示" aria-pressed="false"><i data-lucide="bone"></i><span class="dock-tooltip">骨骼</span></button><button data-download title="下载模型" aria-label="下载模型"><i data-lucide="download"></i><span class="dock-tooltip">下载</span></button></div><div class="axis-gizmo" aria-label="模型方向指示"><svg viewBox="-50 -50 100 100" role="img" aria-label="前后左右方向"><circle class="compass-face" r="47"/><circle class="compass-ticks" r="39"/><text x="0" y="-29" text-anchor="middle">前</text><text x="0" y="38" text-anchor="middle">后</text><text x="-33" y="4" text-anchor="middle">左</text><text x="33" y="4" text-anchor="middle">右</text><g class="axis-ring"><path class="compass-needle" d="M0 -23 8 5 0 1 -8 5Z"/><path class="compass-tail" d="M0 23 8 5 0 1 -8 5Z"/></g><circle r="3" fill="currentColor"/></svg></div></div><div class="viewer-stats" role="status">等待模型</div>`;
    const animationUI = container.querySelector('[data-animation]');
    const q = s => container.querySelector(s) || animationUI.querySelector(s), stage = q('.viewer-stage');
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0f1d);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.toneMapping = THREE.ACESFilmicToneMapping;
    stage.append(renderer.domElement);
    const pm = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
    const environment = pm.fromScene(room, 0.04); room.dispose(); pm.dispose(); scene.environment = environment.texture;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.5));
    const light = new THREE.DirectionalLight(0xffffff, 1); light.position.set(2,4,3); scene.add(light);
    const grid = new THREE.GridHelper(4, 20, 0x365165, 0x243445); scene.add(grid);
    const v = {container, animationUI, scene,camera,renderer,grid,environment,running:true,serial:0,originals:new Map(),alternatives:new Map(),replacements:new Set(),overlays:[],clips:[],mode:'original',controls:new OrbitControls(camera, renderer.domElement)};
    resetControls(v); viewers.push(v);
    const events = new AbortController(); v.events = events;
    const on = (el, type, fn) => el.addEventListener(type, fn, {signal:events.signal});
    const syncTheme = () => {
      const style = getComputedStyle(document.documentElement);
      const background = style.getPropertyValue('--stage').trim() || '#191b1d';
      scene.background.set(background);
      q('[data-bg]').value = background;
      [grid.material].flat().forEach(m => m.color.set(style.getPropertyValue('--grid').trim() || '#414448'));
    };
    on(window, 'aigccat-theme', syncTheme);
    syncTheme();
    on(renderer.domElement,'contextmenu',e => e.preventDefault());
    on(renderer.domElement,'pointerdown',() => stage.focus({preventScroll:true}));
    on(q('[data-mode]'),'change',e => setMode(v,e.target.value));
    container.querySelectorAll('[data-view-mode]').forEach(b=>on(b,'click',()=>setMode(v,b.dataset.viewMode)));
    on(q('[data-bones]'),'click',()=>{ if(v.skeletonHelper) {v.skeletonHelper.visible=!v.skeletonHelper.visible;syncToolbar(v);} });
    // 朝向旋转：绕 Y 轴 90° 步进 / 重置回正面
    container.querySelectorAll('[data-rot]').forEach(b=>on(b,'click',()=>{
      if(!v.obj) return;
      const step=Number(b.dataset.rot);
      if(step===0){ v.obj.rotation.set(0,0,0); }
      else { v.obj.rotation.y += step*Math.PI/180; }
      v.obj.updateMatrixWorld(true);
      v.bounds = modelBounds(v.obj);
      camFor(v);
    }));
    on(q('[data-download]'),'click',()=>{
      if(!v.modelURL) return;
      const event=new CustomEvent('viewer-download',{cancelable:true});
      if(container.dispatchEvent(event)) { const a=document.createElement('a');a.href=v.modelURL;a.download='model.glb';a.click(); }
    });
    syncToolbar(v); window.lucide?.createIcons();
    on(q('[data-view]'),'change',e => { if(e.target.value) camFor(v,e.target.value); e.target.value=''; });
    on(q('[data-fit]'),'click',() => camFor(v));
    on(q('[data-grid]'),'change',e => { grid.visible=e.target.checked; });
    on(q('[data-rotate]'),'change',e => { v.controls.autoRotate=e.target.checked; });
    on(q('[data-bg]'),'input',e => scene.background.set(e.target.value));
    on(q('[data-exposure]'),'input',e => { renderer.toneMappingExposure=Number(e.target.value); });
    const syncFullscreen = () => {
      const active = document.fullscreenElement === container || container.classList.contains('viewer-expanded'), button = q('[data-full]');
      button.title = active ? '退出全屏' : '全屏';
      button.setAttribute('aria-label', button.title);
      button.innerHTML = `<i data-lucide="${active ? 'minimize' : 'maximize'}"></i>`;
      window.lucide?.createIcons();
    };
    on(q('[data-full]'),'click',async () => {
      if (container.classList.contains('viewer-expanded')) container.classList.remove('viewer-expanded');
      else {
        try { if(document.fullscreenElement === container) await document.exitFullscreen(); else await container.requestFullscreen(); }
        catch { container.classList.add('viewer-expanded'); }
      }
      syncFullscreen();
    });
    on(document,'fullscreenchange',syncFullscreen);
    on(document,'keydown',e => {
      if(e.key === 'Escape' && container.classList.contains('viewer-expanded')) {
        container.classList.remove('viewer-expanded'); syncFullscreen();
      }
    });
    on(q('[data-shot]'),'click',() => {
      if (!v.obj) return;
      renderer.render(scene,camera);
      renderer.domElement.toBlob(blob => {
        if(!blob || !v.running) return;
        const url=URL.createObjectURL(blob), a=document.createElement('a'); a.href=url; a.download='模型视角.png'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
      },'image/png');
    });
    on(container,'keydown',e => {
      if(e.target.closest('input,textarea,select,[contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if(e.key.toLowerCase()==='f') { e.preventDefault(); camFor(v); }
      if(e.key==='Escape' && document.fullscreenElement===container) document.exitFullscreen().catch(()=>{});
    });
    function animation() {
      v.mixer.stopAllAction(); v.action=v.mixer.clipAction(v.clips[Number(q('[data-clip]').value)]); v.action.play(); v.action.paused=!v.playing;
    }
    on(q('[data-clip]'),'change',animation);
    on(q('[data-play]'),'click',() => { v.playing=!v.playing; if(!v.action) animation(); else v.action.paused=!v.playing; q('[data-play]').textContent=v.playing?'暂停动画':'播放动画'; });
    v.resizeObserver=new ResizeObserver(() => {
      const w=stage.clientWidth,h=stage.clientHeight;
      if(!w || !h || !v.running) return;
      renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix();
      if (v.obj) frameModel(v,camera.position.clone().sub(v.controls.target));
    }); v.resizeObserver.observe(stage);
    renderer.setSize(Math.max(1,stage.clientWidth),Math.max(1,stage.clientHeight || heightPx),false);
    camera.aspect=Math.max(1,stage.clientWidth)/Math.max(1,stage.clientHeight || heightPx); camera.updateProjectionMatrix();
    let previous=performance.now();
    function loop(now) {
      if(!v.running) return;
      const dt=Math.min((now-previous)/1000,0.1); previous=now;
      v.mixer?.update(dt); v.controls.update();
      if(v.mode==='wire' && v.obj) { v.obj.updateMatrixWorld(true); v.overlays.forEach(({mesh,overlay})=>{overlay.matrix.copy(mesh.matrixWorld);overlay.visible=mesh.visible;}); }
      if(v.bounds) { const radius=Math.max(v.bounds.getSize(new THREE.Vector3()).length()/2,1e-6), distance=camera.position.distanceTo(v.bounds.getCenter(new THREE.Vector3())); camera.near=radius*0.001; camera.far=Math.max(radius*100,distance+radius*4); camera.updateProjectionMatrix(); }
      // 方位轴：随相机水平方位角旋转（前= -Z）
      const gizmo = stage.querySelector('.axis-gizmo .axis-ring');
      if (gizmo && (v.gizmoAt === undefined || now - v.gizmoAt > 60)) {
        v.gizmoAt = now;
        const dir = camera.position.clone().sub(v.controls.target);
        gizmo.setAttribute('transform', `rotate(${((Math.atan2(dir.x, dir.z) - (v.planFrontNegativeZ ? Math.PI : 0)) * 180 / Math.PI).toFixed(1)})`);
      }
      updateTimelineUI(v);
      renderer.render(scene,camera);
      if (new URLSearchParams(location.search).has('qa') && now - (v.qaAt || 0) > 500) {
        v.qaAt = now;
        const gl = renderer.getContext(), pixel = new Uint8Array(4), samples = [];
        for (let y=1; y<8; y++) for (let x=1; x<8; x++) {
          gl.readPixels(Math.floor(renderer.domElement.width*x/8), Math.floor(renderer.domElement.height*y/8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          samples.push(Array.from(pixel).join(','));
        }
        renderer.domElement.dataset.qaPixels = JSON.stringify({colors:new Set(samples).size,samples:samples.join(';')});
        renderer.domElement.dataset.qaViewer = JSON.stringify({mode:v.mode,meshes:v.originals.size,overlays:v.overlays.filter(x=>x.overlay.visible).length,bones:!!v.skeletonHelper?.visible,originalRestored:[...v.originals].every(([mesh,material])=>mesh.material===material)});
      }
      v.frame=requestAnimationFrame(loop);
    }
    v.frame=requestAnimationFrame(loop); return v;
  }
  async function prepareSwitch(v,url,signal,onProgress) {
    let g=null;
    try {
      if(signal.aborted)throw new DOMException('Cancelled','AbortError');
      if(!g){const bytes=await modelBytes(url,signal,onProgress);if(signal.aborted)throw new DOMException('Cancelled','AbortError');g=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes,new URL('.',new URL(url,location.href)).href);}
      if(signal.aborted)throw new DOMException('Cancelled','AbortError');
      const box=modelBounds(g.scene), textures=new Set();
      g.scene.traverse(o=>[o.material].flat().filter(Boolean).forEach(m=>Object.values(m).forEach(t=>{if(t?.isTexture)textures.add(t);})));for(const t of textures)v.renderer.initTexture(t);
      const target=new THREE.WebGLRenderTarget(1,1),oldTarget=v.renderer.getRenderTarget(),culled=[];
      g.scene.traverse(o=>{if(o.isMesh){culled.push([o,o.frustumCulled]);o.frustumCulled=false;}});
      try{v.scene.add(g.scene);v.renderer.setRenderTarget(target);v.renderer.render(v.scene,v.camera);}
      finally{g.scene.removeFromParent();for(const [mesh,value] of culled)mesh.frustumCulled=value;v.renderer.setRenderTarget(oldTarget);target.dispose();}
      return {g,bounds:box};
    } catch(error){if(g)release(g.scenes||[g.scene]);throw error;}
  }
  function releasePrepared(staged){if(staged?.g)release(staged.g.scenes||[staged.g.scene]);}
  async function loadInto(v,url,staged=null) {
    const serial=++v.serial; clearModel(v); v.alternatives.clear();
    const info=v.container.querySelector('.viewer-stats'); info.textContent='模型加载中…';
    v.loadAbort = new AbortController();
    v.requestURL = url;
    v.container.dataset.loading = 'true';
    try {
      let g=staged?.g;
      performance.mark("aigccat-model-load",{detail:{url,staged:!!g}});
      if(!g){
        const bytes = await modelBytes(url,v.loadAbort.signal,progress=>{
          if(serial===v.serial)v.container.dispatchEvent(new CustomEvent('viewer-load-progress',{detail:{stage:'download',...progress}}));
        });
        v.container.dispatchEvent(new CustomEvent('viewer-load-progress',{detail:{stage:'prepare'}}));
        if (!v.running || serial !== v.serial) return null;
        g=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes,new URL('.',new URL(url,location.href)).href);
      }
      if(!v.running || serial!==v.serial) { release(g.scenes || [g.scene]); return null; }
      v.roots=g.scenes || [g.scene]; v.obj=g.scene; v.scene.add(v.obj);
      v.planFrontNegativeZ = staged?.negativeZ || false;
      v.obj.traverse(o => { if(o.userData?.aigccat_coordinate_system === 'right_handed_y_up_neg_z') v.planFrontNegativeZ = true; });
      // Untagged direct-script outputs carry their explicit axis contract in version metadata.
      if (!staged && !v.planFrontNegativeZ && /\/model\.glb(?:\?|$)/.test(url)) {
        try {
          const response = await fetch(url.replace(/\/model\.glb(?:\?.*)?$/, '/meta.json'));
          if (response.ok) {
            const meta = await response.json();
            v.planFrontNegativeZ = meta.coordinate_system === 'right_handed_y_up_neg_z';
          }
        } catch (_) { /* Legacy untagged models preserve their original view. */ }
        if (!v.running || serial !== v.serial) return null;
      }
      let meshes=0,triangles=0,vertices=0;
      v.obj.traverse(o => { if(o.isMesh) { v.originals.set(o,o.material); const instances=o.isInstancedMesh?o.count:1; meshes+=instances; vertices+=(o.geometry.attributes.position?.count || 0)*instances; triangles+=Math.floor((o.geometry.index?.count ?? o.geometry.attributes.position?.count ?? 0)/3)*instances; } });
      let hasBones=false; v.obj.traverse(o=>{if(o.isBone)hasBones=true;});
      if(hasBones) { v.skeletonHelper=new THREE.SkeletonHelper(v.obj);v.skeletonHelper.material.depthTest=false;v.skeletonHelper.renderOrder=2;v.skeletonHelper.visible=false;v.scene.add(v.skeletonHelper); }
      v.modelURL=url;
      v.bounds=staged?.bounds || modelBounds(v.obj); const size=v.bounds.getSize(new THREE.Vector3()), center=v.bounds.getCenter(new THREE.Vector3()), span=Math.max(size.x,size.y,size.z,1e-6);
      v.grid.scale.setScalar(span/2); v.grid.position.set(center.x,v.bounds.min.y,center.z);
      setMode(v,v.mode); camFor(v,'front');
      v.clips=g.animations || []; v.playing=false;
      const animation=v.animationUI; animation.hidden=!v.clips.length;
      if(v.clips.length) {
        v.mixer=new THREE.AnimationMixer(v.obj);
        v.mixer.addEventListener('finished', () => { v.playing=false; updateTimelineUI(v); });
        v.animationUI.querySelector('[data-clip]').replaceChildren(...v.clips.map((c,i)=>new Option(`动画 ${i+1}（${c.duration.toFixed(1)} 秒）`,String(i))));
        v.animationUI.querySelector('[data-play]').textContent='播放动画';
        bindTimeline(v);
        updateTimelineUI(v);
      }
      info.textContent=`${meshes.toLocaleString()} 个网格 · ${triangles.toLocaleString()} 三角面 · ${vertices.toLocaleString()} 顶点 · 尺寸 ${size.toArray().map(n=>n.toPrecision(4)).join(' × ')}（模型单位）`;
      return {size,center,span,meshes,triangles,vertices};
    } catch(e) {
      if(!v.running || serial!==v.serial) return null;
      clearModel(v); info.textContent='模型加载失败：'+e.message; throw e;
    } finally {
      if (serial === v.serial) { delete v.container.dataset.loading; v.loadAbort = null; }
    }
  }
  function disposeViewer(v) {
    if(!v.running) return;
    v.running=false; ++v.serial; cancelAnimationFrame(v.frame); v.resizeObserver.disconnect(); v.events.abort(); v.controls.dispose(); clearModel(v);
    release([v.grid]); v.environment.dispose(); v.renderer.dispose(); v.renderer.forceContextLoss(); v.renderer.domElement.remove();
  }
  function disposeViewers() { viewers.forEach(disposeViewer); viewers.length=0; }
  function clearViewer(v) { ++v.serial; clearModel(v); }
  return {viewers,createViewer,loadInto,prepareSwitch,releasePrepared,camFor,disposeViewer,disposeViewers,clearViewer};
}
