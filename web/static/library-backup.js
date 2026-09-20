import { loadPresets, savePresets } from './creative-presets.js?v=1';

const BASE = '/api/library-backup';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes = n => {
  const value = Number(n) || 0;
  const unit = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${(value / 1024 ** unit).toLocaleString('zh-CN', {maximumFractionDigits:1})} ${['B','KiB','MiB','GiB'][unit]}`;
};
let opened;

export async function openLibraryBackup({api, onRestored}) {
  if (opened?.open) { opened.focus(); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'library-backup';
  dialog.setAttribute('aria-labelledby', 'backup-title');
  dialog.innerHTML = `<div class="backup-heading"><h2 id="backup-title">资产库打包与恢复</h2><button type="button" data-close aria-label="关闭打包与恢复">×</button></div>
    <p class="backup-intro">保存全部资产、图片、模型版本与历史，也包含回收站。当前搜索和筛选不会缩小导出范围。本部署的账号目前共享同一资产库。</p>
    <div class="backup-start">
      <section><h3>导出全量备份</h3><p>包含项目归属、收藏、图谱布局、创作设置与消耗记录。</p>
        <label class="backup-check"><input type="checkbox" data-export-presets checked>同时保存此浏览器的创作预设</label>
        <button type="button" class="primary" data-export>打包全部资产</button></section>
      <section><h3>从备份恢复</h3><p>选择 aigccat 导出的 ZIP，先校验并查看内容，再决定如何导入。</p>
        <label for="backup-file">资产库备份文件</label><input id="backup-file" type="file" accept=".zip,application/zip">
        <button type="button" data-upload disabled>上传并检查备份</button></section>
    </div>
    <section class="backup-task" hidden><p data-status role="status" aria-live="polite"></p><progress aria-label="打包或恢复进度" hidden></progress><div data-content></div></section>
    <p class="backup-error" role="alert" hidden></p>
    <p class="backup-note">打包和恢复期间请等待后台任务完成。关闭此窗口后，已开始的后台任务会继续，重新打开即可查看。新环境的服务密钥与 Studio 登录会话需要单独配置。</p>`;
  document.body.append(dialog);
  opened = dialog;
  const $ = selector => dialog.querySelector(selector);
  let timer, transfer, rendered = '', busy = false;
  const error = message => { $('.backup-error').textContent = message; $('.backup-error').hidden = !message; };
  const send = (url, body) => api(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  function controls(disabled) {
    busy = disabled;
    $('[data-export]').disabled = disabled;
    $('#backup-file').disabled = disabled;
    $('[data-upload]').disabled = disabled || !$('#backup-file').files.length;
  }
  function progress(done, total) {
    const bar = $('progress'); bar.hidden = false;
    if (total) { bar.max = total; bar.value = done; }
    else bar.removeAttribute('value');
  }
  function summary(info) {
    return `<dl class="backup-summary"><div><dt>资产</dt><dd>${esc(info.asset_count)}</dd></div><div><dt>模型版本</dt><dd>${esc(info.versions)}</dd></div><div><dt>源图片</dt><dd>${esc(info.images)}</dd></div><div><dt>文件总量</dt><dd>${esc(info.files)} 个 · ${esc(bytes(info.bytes))}</dd></div></dl>
      <p>备份时间：${esc(new Date(info.created_at * 1000).toLocaleString())} · 本机创作预设 ${esc(info.preset_count)} 条</p>`;
  }
  function schedule() {
    clearTimeout(timer);
    if (dialog.open && transfer && ['building','validating','uploading','restoring'].includes(transfer.status)) {
      timer = setTimeout(async () => {
        try { render(await api(`${BASE}/${transfer.id}`)); }
        catch (e) { error(`暂时无法读取进度：${e.message}。后台任务可能仍在继续。`); schedule(); }
      }, 2000);
    }
  }
  async function reset() {
    try {
      if (transfer) await api(`${BASE}/${transfer.id}`, {method:'DELETE'});
      transfer = null; rendered = ''; controls(false); error(''); $('.backup-task').hidden = true;
    } catch (e) { error(e.message); }
  }
  function render(state) {
    transfer = state;
    const pending = ['building','validating','uploading','restoring'].includes(state.status);
    controls(pending || state.status === 'preview');
    $('.backup-task').hidden = false;
    $('[data-status]').textContent = state.message || '正在处理';
    if (pending) progress(state.completed, state.total); else $('progress').hidden = true;
    const signature = state.id + ':' + state.status;
    if (signature !== rendered) {
      rendered = signature;
      const content = $('[data-content]');
      content.replaceChildren();
      if (state.status === 'ready') {
        content.innerHTML = summary(state.summary) + `<div class="backup-actions"><a class="dl" href="${BASE}/${encodeURIComponent(state.id)}/download" download>下载完整备份 ZIP</a><button type="button" data-reset>完成并清理临时文件</button></div><p class="backup-note">请在下载完成后再清理临时文件。</p>`;
      } else if (state.status === 'preview') {
        const info = state.summary, conflicts = info.conflicts || [];
        content.innerHTML = summary(info) + `<p>当前库有 ${esc(info.current_assets)} 个资产；其中 ${esc(conflicts.length)} 个编号与备份重复。</p>
          ${conflicts.length ? `<details><summary>查看重复编号</summary><ul class="backup-conflicts">${conflicts.map(ref=>`<li>${esc(ref)}</li>`).join('')}</ul></details>` : ''}
          <label for="backup-conflict-mode">重复编号的处理方式</label><select id="backup-conflict-mode"><option value="skip">保留当前资产，跳过重复编号</option><option value="replace">用备份完整替换重复编号的资产</option></select>
          <p class="backup-note">替换包含该资产的全部版本和历史。未出现在备份中的资产会保留。</p>
          <label class="backup-check"><input type="checkbox" data-restore-settings ${info.current_assets === 0 ? 'checked' : ''}>恢复备份中的库设置</label>
          <p class="backup-note">勾选会替换项目归属、收藏、回收站状态、图谱布局、全局风格、创作设置和消耗记录。完整迁移到空库时建议勾选。</p>
          <label class="backup-check"><input type="checkbox" data-restore-presets ${info.has_presets ? 'checked' : 'disabled'}>恢复并替换此浏览器的创作预设</label>
          <label class="backup-check" data-confirm-label hidden><input type="checkbox" data-confirm>我已核对重复资产，同意用备份替换</label>
          <div class="backup-actions"><button type="button" class="primary" data-restore>开始恢复</button><button type="button" data-reset>放弃此次导入</button></div>`;
        const update = () => {
          const replacing = conflicts.length > 0 && $('#backup-conflict-mode').value === 'replace';
          $('[data-confirm-label]').hidden = !replacing;
          $('[data-restore]').disabled = replacing && !$('[data-confirm]').checked;
        };
        $('#backup-conflict-mode').onchange = update;
        $('[data-confirm]').onchange = update;
        $('[data-restore]').onclick = async () => {
          const request = {conflicts:$('#backup-conflict-mode').value, restore_settings:$('[data-restore-settings]').checked, restore_presets:$('[data-restore-presets]').checked};
          content.querySelectorAll('button,input,select').forEach(el=>el.disabled = true);
          error('');
          try { render(await send(`${BASE}/${state.id}/restore`, request)); }
          catch (e) { rendered = ''; render(state); error(e.message); }
        };
      } else if (state.status === 'done') {
        const result = state.result;
        content.innerHTML = `<p>已恢复 ${esc(result.imported)} 个资产，跳过 ${esc(result.skipped)} 个重复资产。${result.settings_restored ? '库设置已恢复。' : ''}</p>
          <div class="backup-actions"><button type="button" class="primary" data-refresh>刷新资产库</button><button type="button" data-reset>完成并清理临时文件</button></div>`;
        if (Array.isArray(result.browser_presets)) {
          try {
            if (localStorage.getItem('aigccat.backup-presets-applied') !== state.id) {
              savePresets(result.browser_presets);
              localStorage.setItem('aigccat.backup-presets-applied', state.id);
            }
          } catch { error('服务器资产已恢复，但此浏览器无法保存创作预设。请允许本地存储后重新打开本窗口。'); }
        }
        $('[data-refresh]').onclick = () => { dialog.close(); onRestored?.(); };
      } else if (state.status === 'failed') {
        content.innerHTML = '<p>可以清理此次临时文件后重新操作。</p><button type="button" data-reset>清理此次任务</button>';
      }
      $('[data-reset]')?.addEventListener('click', reset);
    }
    schedule();
  }
  $('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { clearTimeout(timer); dialog.remove(); opened = null; });
  $('#backup-file').onchange = () => { if (!busy) $('[data-upload]').disabled = !$('#backup-file').files.length; };
  $('[data-export]').onclick = async () => {
    error(''); controls(true);
    try { render(await send(`${BASE}/export`, {browser_presets:$('[data-export-presets]').checked ? loadPresets() : null})); }
    catch (e) { controls(false); error(e.message); }
  };
  $('[data-upload]').onclick = async () => {
    const file = $('#backup-file').files[0]; if (!file) return;
    controls(true); error(''); $('.backup-task').hidden = false;
    $('[data-status]').textContent = '正在上传备份…'; $('[data-content]').replaceChildren(); progress(0, file.size);
    const form = new FormData(); form.append('file', file);
    // XHR exposes upload progress without buffering a whole archive in browser memory.
    const xhr = new XMLHttpRequest(); xhr.open('POST', `${BASE}/import`);
    xhr.upload.onprogress = event => { if (dialog.open) progress(event.loaded, event.lengthComputable ? event.total : 0); };
    xhr.onload = () => {
      if (xhr.status === 401) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname); return; }
      if (!dialog.open) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try { rendered = ''; render(JSON.parse(xhr.responseText)); }
        catch { controls(false); error('上传响应无效，请重新打开窗口查看任务状态'); }
      } else { controls(false); $('progress').hidden = true; error(xhr.responseText || '上传失败'); }
    };
    xhr.onerror = () => { if (dialog.open) { controls(false); $('progress').hidden = true; error('上传连接中断，请重新打开窗口查看任务状态'); } };
    xhr.send(form);
  };
  controls(true);
  dialog.showModal();
  try {
    const current = await api(BASE);
    if (!dialog.open) return;
    if (current.recovery_pending) {
      controls(true); $('.backup-task').hidden = false;
      $('[data-status]').textContent = '上次恢复中断，需要先还原原资产库。';
      $('[data-content]').innerHTML = '<button type="button" data-recover>重试恢复原资产库</button>';
      $('[data-recover]').onclick = async () => {
        $('[data-recover]').disabled = true;
        try { await send(`${BASE}/recover`, {}); dialog.close(); onRestored?.(); }
        catch (e) { error(e.message); $('[data-recover]').disabled = false; }
      };
    } else if (current.transfer) render(current.transfer);
    else controls(false);
  } catch (e) { error(`无法读取资产库任务状态：${e.message}。请关闭后重试。`); }
}
