// Logical folders: asset IDs and model file paths never change.
export function projectOf(asset,state,ref) {
  if(Object.hasOwn(state.asset_projects||{},ref)) return state.asset_projects[ref];
  const tags=Array.isArray(asset.tags)?asset.tags:[];
  if(tags.includes('demo') || /demo/i.test(asset.name||'')) return 'demo';
  if(tags.includes('test') || /(^|[_ -])test([_ -]|$)/i.test(`${asset.asset_id} ${asset.name||''}`)) return 'test';
  return '';
}
export function mountProjects(host,{api,assets,ref,selected,onChange}) {
  let state={},filter='*',folderSignature='';
  host.classList.add('project-panel');
  host.innerHTML='<label>项目文件夹</label><select aria-label="项目文件夹"></select><div class="project-actions"><button type="button" data-new>＋ 新建项目</button><button type="button" data-move>归档所选</button></div><span class="project-message" role="status"></span>';
  const select=host.querySelector('select'),message=host.querySelector('[role=status]');
  function render(){
    const folders={test:'test',demo:'Demo',...state.project_folders};
    const signature=JSON.stringify(folders);
    if(signature!==folderSignature) { select.replaceChildren(new Option('全部项目','*'),new Option('未归属项目',''),...Object.entries(folders).map(([id,name])=>new Option(name,id)));folderSignature=signature; }
    select.value=filter;
  }
  async function save(patch){
    state=await api('/api/workbench/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
    try{localStorage.setItem('aigccat-assets-changed',String(Date.now()));}catch{}
    render();onChange();
  }
  select.onchange=()=>{filter=select.value;onChange();};
  host.querySelector('[data-new]').onclick=async()=>{
    const name=prompt('项目名称');if(!name?.trim())return;
    try{const id='p_'+crypto.randomUUID();await save({project_folders:{[id]:name.trim().slice(0,50)}});filter=id;render();onChange();message.textContent='项目已创建，可选中资产后归档';}catch(e){message.textContent=e.message;}
  };
  host.querySelector('[data-move]').onclick=async()=>{
    const refs=selected();if(!refs.length){message.textContent='请先勾选资产；工作台也可直接归档当前模型';return;}
    const dialog=document.createElement('dialog');
    dialog.innerHTML='<h2>归档到项目</h2><select aria-label="目标项目"></select><div class="project-actions"><button data-confirm>确认归档</button><button data-cancel>取消</button></div><p role="status"></p>';
    const target=dialog.querySelector('select');
    target.replaceChildren(new Option('未归属项目',''),...Object.entries({test:'test',demo:'Demo',...state.project_folders}).map(([id,name])=>new Option(name,id)));
    target.value=filter==='*'?'test':filter;
    document.body.append(dialog);dialog.showModal();
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    dialog.querySelector('[data-confirm]').onclick=async()=>{
      const button=dialog.querySelector('[data-confirm]');button.disabled=true;
      try{await save({asset_projects:Object.fromEntries(refs.map(r=>[r,target.value]))});message.textContent=`已归档 ${refs.length} 个资产`;dialog.close();}catch(e){dialog.querySelector('[role=status]').textContent=e.message;button.disabled=false;}
    };
  };
  render();
  return {update(next){state=next;render();},matches(a){return filter==='*'||projectOf(a,state,ref(a))===filter;},reset(){filter='*';render();},state(){return state;}};
}
