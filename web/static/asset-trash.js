// Both asset surfaces share the same soft-delete rules. Never retry a write.
export async function moveToTrash(api, refs, restore = false) {
  const unique = [...new Set(refs)];
  if (!unique.length) throw new Error('先选择资产');
  const skipped = [], allowed = [];
  for (let i = 0; i < unique.length; i += 6) {
    await Promise.all(unique.slice(i, i + 6).map(async ref => {
      if (restore) { allowed.push(ref); return; }
      try {
        await api('/api/assets/' + ref);
        allowed.push(ref);
      } catch { skipped.push({ref, reason:'读取失败，未删除'}); }
    }));
  }
  const state = await api('/api/workbench/state');
  const archived = new Set(state.archived || []);
  const moved = allowed.filter(ref => restore ? archived.has(ref) : !archived.has(ref));
  moved.forEach(ref => restore ? archived.delete(ref) : archived.add(ref));
  const saved = moved.length ? await api('/api/workbench/state', {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({[restore?"archive_remove":"archive_add"]:moved})
  }) : state;
  try { localStorage.setItem('aigccat-assets-changed',String(Date.now())); } catch {}
  window.dispatchEvent(new Event('aigccat-assets-changed'));
  return {archived:saved.archived || [], moved, skipped};
}

export function trashResult(result, restore = false) {
  return `已${restore?'恢复':'移入回收站'} ${result.moved.length} 个资产。` +
    (result.skipped.length ? `跳过 ${result.skipped.length} 个：` + result.skipped.map(x=>`${x.ref}（${x.reason}）`).join('；') : '');
}
