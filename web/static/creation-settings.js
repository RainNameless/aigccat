export const creationDefaults = {allowMultiple:false,count:1,ratio:'16:9'};
export function creationConfig(state={}) {
  const c=state.creation||{};
  return {allowMultiple:c.allowMultiple===true,count:[1,2,3,4].includes(c.count)?c.count:1,ratio:['1:1','16:9','9:16','4:3','3:4'].includes(c.ratio)?c.ratio:'16:9'};
}
export async function readCreationConfig(){const r=await fetch('/api/workbench/state');if(!r.ok)throw Error('创作设置读取失败');return creationConfig(await r.json());}
const button=document.getElementById('creation-settings');
if(button){
 const dialog=document.createElement('dialog');dialog.className='creation-settings-dialog';document.body.append(dialog);
 button.onclick=async()=>{try{
 const c=await readCreationConfig();
 dialog.innerHTML=`<h2>首页创作设置</h2><p>默认生成一组四张独立参考图，首页只保留常用选项。</p><form><label><input id="allow-multiple" type="checkbox" ${c.allowMultiple?'checked':''}> 开启多方案生成</label><label>每次方案组数<select id="creation-count">${[1,2,3,4].map(n=>`<option ${n===c.count?'selected':''}>${n}</option>`).join('')}</select></label><label>参考图画幅<select id="creation-ratio">${['16:9','1:1','9:16','4:3','3:4'].map(r=>`<option ${r===c.ratio?'selected':''}>${r}</option>`).join('')}</select></label><p>每组生成正面、背面、左侧、右侧四张独立图片；两组为八张。多方案会增加生成次数与费用。</p><p id="creation-feedback" role="status"></p><div><button type="button" id="close-creation">取消</button><button type="submit">保存创作设置</button></div></form>`;
 const toggle=dialog.querySelector('#allow-multiple'),count=dialog.querySelector('#creation-count');const sync=()=>count.disabled=!toggle.checked;toggle.onchange=sync;sync();
 dialog.querySelector('#close-creation').onclick=()=>dialog.close();
 dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const submit=e.submitter;submit.disabled=true;try{
 const r=await fetch('/api/workbench/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({creation:{allowMultiple:toggle.checked,count:Number(count.value),ratio:dialog.querySelector('#creation-ratio').value}})});if(!r.ok)throw Error(await r.text());dialog.querySelector('#creation-feedback').textContent='已保存，首页下次生成使用新设置。';
 }catch(e){dialog.querySelector('#creation-feedback').textContent=e.message;}finally{submit.disabled=false;}};dialog.showModal();
 }catch(e){document.getElementById('chat-notice').textContent=e.message;}};
}
