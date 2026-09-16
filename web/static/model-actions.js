import { mountMotionPreviews } from './motion-preview.js?v=4';

// Names and requests belong to this asset version, not global workbench preferences.
export function mountModelActions(host, ctx) {
  const {viewer, asset, version, fileURL, put, base64, esc, toast, modal, fit, bounds} = ctx;
  let visibleCount = 4;
  let disposed = false, cleanup = () => {}, writing = false;
  const clips = viewer.clips.slice();
  const url = asset && version ? fileURL(asset, `versions/${version}/actions.json`) : null;
  let metadata = {names:{}, requests:[]};
  const q = selector => host.querySelector(selector);
  async function read() {
    const response = await fetch(url, {cache:'no-store'});
    if (response.status === 404) return {names:{}, requests:[]};
    if (!response.ok) throw new Error(`动作设置读取失败（${response.status}）`);
    const value = await response.json();
    if (!value || typeof value.names !== 'object' || !Array.isArray(value.requests)) throw new Error('动作设置格式错误，请勿覆盖原文件');
    return value;
  }
  async function save(change) {
    if (writing) throw new Error('正在保存，请稍后');
    writing = true;
    try {
      const latest = await read();
      change(latest);
      await put(url, {bytes_b64:await base64(new Blob([JSON.stringify(latest)], {type:'application/json'}))});
      metadata = latest;
    } finally { writing = false; }
  }
  function editor(clipIndex = null, request = null) {
    if (writing) return toast("正在保存，请稍后打开编辑器");
    const id = request?.id || crypto.randomUUID();
    modal(clipIndex === null ? '添加动作' : '重新生成动作', `
      <div class="motion-editor">
        <label for="action-name">动作名称（可选）</label>
        <input id="action-name" maxlength="80" value="${esc(request?.name ?? metadata.names[clipIndex] ?? '')}" placeholder="">
        <label for="action-prompt">动作提示词</label>
        <textarea id="action-prompt" maxlength="2000" placeholder="例如：原地自然行走，双臂随步伐摆动，脚掌着地，首尾平滑衔接">${esc(request?.prompt || '')}</textarea>
        <div class="motion-suggestions">${['自然待机，轻微呼吸','原地行走，脚掌着地','挥手打招呼，缓慢放下手臂'].map(t=>`<button type="button" data-prompt-suggestion="${t}">${t}</button>`).join('')}</div>
        <label for="action-duration">时长（秒）</label><input id="action-duration" type="number" min="0.1" max="60" step="0.1" value="${request?.duration || clips[clipIndex]?.duration.toFixed(1) || 4}">
        <label class="toggle">循环<input id="action-loop" type="checkbox" ${request?.loop === false ? '' : 'checked'}></label>
        <p class="help-line">使用 OpenCode 操作本地 Blender 生成动作；下一步可选择执行模型并查看操作记录。也可以先保存为草稿。</p>
        <div class="row"><button id="save-action-request" class="primary">保存动作需求</button><button id="generate-action-agent">用 AI ${clipIndex === null ? '生成动作' : '重新生成'}</button></div>
        <p id="action-request-status" role="status"></p>
      </div>`);
    const body = document.getElementById('dialog-body');
    body.querySelectorAll('[data-prompt-suggestion]').forEach(b=>b.onclick=()=>{body.querySelector('#action-prompt').value=b.dataset.promptSuggestion;});
    body.querySelector('#generate-action-agent').onclick = () => {
      const status=body.querySelector('#action-request-status');
      if(viewer.modelURL!==fileURL(asset,`versions/${version}/model.glb`)){status.textContent='模型版本已切换，请重新打开';return;}
      const prompt=body.querySelector('#action-prompt').value.trim(),duration=Number(body.querySelector('#action-duration').value),name=body.querySelector('#action-name').value.trim();
      if(!prompt||!Number.isFinite(duration)||duration<.1||duration>60){status.textContent='请填写提示词及 0.1–60 秒的时长';return;}
      const loop=body.querySelector('#action-loop').checked;
      document.getElementById('dialog').close();
      ctx.openAgent?.({prompt:`${clipIndex===null?'添加新动作，保留已有动作。':'调整现有动作 '+clips[clipIndex].name+'，保留其他动作。'}\n${prompt}\n时长 ${duration} 秒；${loop?'循环，首尾姿态衔接':'单次播放'}。${name?'动作 clip 名称使用：'+name+'。':''}保留原模型和贴图，完成后输出可播放的骨骼动画 GLB。`,name});
    };
    body.querySelector('#save-action-request').onclick = async () => {
      const button=body.querySelector('#save-action-request'), status=body.querySelector('#action-request-status');
      if (viewer.modelURL !== fileURL(asset, `versions/${version}/model.glb`)) { status.textContent='模型版本已切换，请关闭后重新打开'; return; }
      const prompt=body.querySelector('#action-prompt').value.trim(), duration=Number(body.querySelector('#action-duration').value);
      if (!prompt || !Number.isFinite(duration) || duration < .1 || duration > 60) {status.textContent='请填写提示词及 0.1–60 秒的时长';return;}
      const item={id,name:body.querySelector('#action-name').value.trim(),prompt,duration,loop:body.querySelector('#action-loop').checked,source_clip:clipIndex,status:'awaiting_service'};
      button.disabled=true;
      try {
        await save(data=>{data.requests=data.requests.filter(r=>r.id!==id);data.requests.push(item);});
        status.textContent='需求已保存，尚未生成动画';
        document.dispatchEvent(new CustomEvent('model-actions-saved',{detail:{url}}));
        toast('动作需求已保存，尚未生成动画');
      } catch(e) {status.textContent=e.message;}
      finally {button.disabled=false;}
    };
  }
  function render() {
    if (disposed) return;
    cleanup(); viewer.animationUI.remove();
    host.innerHTML=`<div class="motion-heading"><span>已有动作 · ${clips.length}</span><button data-add-action ${!url?'disabled':''}>＋ 添加动作</button></div>
      <button data-open-templates class="full">选择动作模板</button><div class="model-playback"></div>
      ${clips.length ? `<div class="anim-grid">${clips.slice(0,visibleCount).map((clip,i)=>`<article class="model-action-card">
        <button class="anim-card" data-clip-preview="${i}" data-motion="clip:${i}" aria-label="播放动作 ${i+1}"><span class="motion-image"></span><small>${clip.duration.toFixed(1)} 秒 · 点击播放</small></button>
        <label>动作名称<input data-action-name="${i}" aria-label="动作 ${i+1} 名称" maxlength="80" value="${esc(metadata.names[i] || '')}"></label>
        <div class="motion-card-actions"><button data-save-name="${i}">保存名称</button><button data-regenerate="${i}">重新生成</button></div>
      </article>`).join('')}</div>${visibleCount<clips.length?`<button class="motion-expand" data-more-actions>向下展开更多动作 ↓（还有 ${clips.length-visibleCount} 个）</button>`:''}` : '<p class="help-line">当前模型没有动画。可以添加动作交给 AI 制作，或完成绑骨后使用人物动作模板。</p>'}
      <details class="action-requests"><summary>动作需求草稿 · ${metadata.requests.length}</summary>${metadata.requests.map(r=>`<article><strong>${esc(r.name)}</strong><p>${esc(r.prompt)}</p><small>${esc(r.duration)} 秒 · ${r.loop?'循环':'单次'} · 尚未生成</small><div><button data-edit-request="${esc(r.id)}">编辑需求</button><button data-delete-request="${esc(r.id)}">删除需求</button></div></article>`).join('')}</details>
      <p class="help-line">自定义名称保存在此资产版本中，不改写原始 GLB。</p>`;
    if (q('.anim-grid')) host.insertBefore(q('.action-requests'),q('.anim-grid'));
    q('.model-playback').append(viewer.animationUI);
    viewer.animationUI.hidden=!clips.length;
    const select=viewer.animationUI.querySelector('[data-clip]');
    [...select.options].forEach((o,i)=>{o.textContent=metadata.names[i] || `片段 ${i+1}`;});
    // Cards choose the clip; the toolbar provides a single pause/seek control.
    host.querySelectorAll('[data-clip-preview]').forEach(b=>b.onclick=()=>{
      select.value=b.dataset.clipPreview;select.dispatchEvent(new Event('change'));
      if(!viewer.playing) viewer.animationUI.querySelector('[data-play]').click();
      host.querySelectorAll('[data-clip-preview]').forEach(x=>x.classList.toggle('active',x===b));
    });
    if (clips.length && viewer.obj) cleanup=mountMotionPreviews(host,viewer,fit,bounds,()=>viewer.action?.getClip().duration || clips[0].duration);
    q('[data-more-actions]')?.addEventListener('click',()=>{
      host.querySelectorAll('[data-action-name]').forEach(input=>{metadata.names[input.dataset.actionName]=input.value;});
      visibleCount+=4;render();
    });
    q('[data-add-action]').onclick=()=>editor();
    q('[data-open-templates]').onclick=()=>ctx.openTemplates?.();
    host.querySelectorAll('[data-regenerate]').forEach(b=>b.onclick=()=>editor(Number(b.dataset.regenerate)));
    host.querySelectorAll('[data-save-name]').forEach(b=>b.onclick=async()=>{
      const index=b.dataset.saveName, value=q(`[data-action-name="${index}"]`).value.trim();b.disabled=true;
      try {await save(data=>{data.names[index]=value;});if(!disposed) select.options[Number(index)].textContent=value || `片段 ${Number(index)+1}`;toast('动作名称已保存');}
      catch(e){toast(e.message);}finally{b.disabled=false;}
    });
    host.querySelectorAll('[data-edit-request]').forEach(b=>b.onclick=()=>{const r=metadata.requests.find(r=>r.id===b.dataset.editRequest);editor(r.source_clip,r);});
    host.querySelectorAll('[data-delete-request]').forEach(b=>b.onclick=async()=>{
      b.disabled=true;try{await save(data=>{data.requests=data.requests.filter(r=>r.id!==b.dataset.deleteRequest);});render();}catch(e){toast(e.message);b.disabled=false;}
    });
  }
  const onSaved = event => {if(event.detail.url === url && !disposed) read().then(value=>{metadata=value;render();}).catch(e=>toast(e.message));};
  document.addEventListener('model-actions-saved',onSaved);
  host.innerHTML='<p role="status">正在读取模型动作…</p>';
  if(url) read().then(value=>{metadata=value;render();}).catch(e=>{
    if(disposed)return;
    host.innerHTML=`<p role="alert">${esc(e.message)}</p><button data-retry-actions>重新加载</button>`;
    q('[data-retry-actions]').onclick=()=>{read().then(value=>{metadata=value;render();}).catch(e=>toast(e.message));};
  }); else render();
  return ()=>{disposed=true;document.removeEventListener('model-actions-saved',onSaved);cleanup();viewer.animationUI.remove();};
}
