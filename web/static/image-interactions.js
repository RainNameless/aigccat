// Shared image drag/drop and preview for workbench, library and dialogs.
const IMAGE_URL = 'application/x-aigccat-image-url';
let ghost;
const imageAt = target => target.closest?.('img') || target.closest?.('[draggable="true"]')?.querySelector('img');
function usable(img) {
  return img && !img.closest('.app-header, .app-brand, [data-motion], .motion-card') && img.getAttribute('src');
}
function clearGhost() { ghost?.remove(); ghost=null; }
export async function imageDropFiles(transfer) {
  if (transfer.files?.length) return [...transfer.files];
  let src=transfer.getData(IMAGE_URL) || transfer.getData('text/uri-list').split('\n').find(s=>s&&!s.startsWith('#'));
  if(!src) {
    const raw=transfer.getData('application/x-aigccat-image');
    if(raw) {
      const {asset,path}=JSON.parse(raw);
      src='/api/assets/'+asset+'/file/'+path.split('/').map(encodeURIComponent).join('/');
    }
  }
  if(!src) throw Error('请拖入图片文件或站内图片');
  const url=new URL(src,location.href);
  if(!['http:','https:','blob:','data:'].includes(url.protocol) ||
    (['http:','https:'].includes(url.protocol)&&url.origin!==location.origin)) throw Error('请先下载外部图片，再上传');
  const response=await fetch(url);
  if(!response.ok) throw Error('图片读取失败，请重试');
  const blob=await response.blob();
  if(blob.size>20*1024*1024)throw Error('图片不能超过20 MB');
  const bytes=new Uint8Array(await blob.slice(0,12).arrayBuffer());
  const type=bytes[0]===137&&bytes[1]===80?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':
    String.fromCharCode(...bytes.slice(8,12))==='WEBP'?'image/webp':blob.type;
  return [new File([blob],decodeURIComponent(url.pathname.split('/').pop()||'image'),{type})];
}
function destination(target) {
  const upload=target.closest?.('[data-upload]');
  if(upload)return {element:upload,upload:upload.dataset.upload};
  const input=target.matches?.('input[type=file][accept*="image"]')?target:
    target.closest?.('label')?.querySelector('input[type=file][accept*="image"]');
  return input?{element:input.closest('label')||input,input}:null;
}
function notify(error) {
  let box=document.getElementById('image-interaction-error');
  if(!box){box=document.createElement('div');box.id='image-interaction-error';box.setAttribute('role','alert');document.body.append(box);}
  box.textContent=error.message;box.hidden=false;setTimeout(()=>box.hidden=true,6000);
}
document.addEventListener('dragstart',event=>{
  const img=imageAt(event.target);
  if(!usable(img))return;
  const src=img.currentSrc||img.src;
  event.dataTransfer.setData(IMAGE_URL,src);
  event.dataTransfer.setData('text/uri-list',src);
  event.dataTransfer.effectAllowed='copy';
  clearGhost();
  // A canvas drag image uses its displayed dimensions, never the source's 4K/8K size.
  const rect=img.getBoundingClientRect();
  ghost=document.createElement('canvas');
  ghost.width=Math.max(1,Math.round(rect.width));ghost.height=Math.max(1,Math.round(rect.height));
  Object.assign(ghost.style,{position:'fixed',left:'0',top:'0',pointerEvents:'none',width:ghost.width+'px',height:ghost.height+'px',zIndex:'-1'});
  const scale=Math.min(ghost.width/img.naturalWidth,ghost.height/img.naturalHeight);
  ghost.getContext('2d').drawImage(img,(ghost.width-img.naturalWidth*scale)/2,(ghost.height-img.naturalHeight*scale)/2,img.naturalWidth*scale,img.naturalHeight*scale);
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost,Math.max(0,Math.min(ghost.width,event.clientX-rect.left)),Math.max(0,Math.min(ghost.height,event.clientY-rect.top)));
},true);
document.addEventListener('dragend',()=>{clearGhost();document.querySelectorAll('.image-drop-active').forEach(el=>el.classList.remove('image-drop-active'));});
document.addEventListener('dragover',event=>{
  const dest=destination(event.target);if(!dest)return;
  event.preventDefault();event.stopImmediatePropagation();
  event.dataTransfer.dropEffect='copy';dest.element.classList.add('image-drop-active');
},true);
document.addEventListener('dragleave',event=>{
  const dest=destination(event.target);
  if(dest&&!dest.element.contains(event.relatedTarget))dest.element.classList.remove('image-drop-active');
},true);
document.addEventListener('drop',async event=>{
  const dest=destination(event.target);if(!dest)return;
  event.preventDefault();event.stopImmediatePropagation();clearGhost();dest.element.classList.remove('image-drop-active');
  const serial=location.hash;
  try{
    const files=await imageDropFiles(event.dataTransfer);
    if(!dest.element.isConnected||serial!==location.hash)throw Error('输入区域已切换，请重新拖入');
    if(dest.input){
      const transfer=new DataTransfer();files.forEach(f=>transfer.items.add(f));dest.input.files=transfer.files;
      dest.input.dispatchEvent(new Event('change',{bubbles:true}));
    } else dest.element.dispatchEvent(new CustomEvent('aigccat-image-drop',{bubbles:true,detail:{files,target:dest.upload}}));
  }catch(error){notify(error);}
},true);
document.addEventListener('click',event=>{
  const img=event.target.closest?.('img');
  if(!usable(img)||img.closest('#image-lightbox, .open-asset, .asset-card, .model-history-grid, .style-card')||event.ctrlKey||event.metaKey)return;
  // Only image content opens preview; card labels and upload buttons retain their actions.
  event.preventDefault();event.stopImmediatePropagation();
  let dialog=document.getElementById('image-lightbox');
  if(!dialog){
    dialog=document.createElement('dialog');dialog.id='image-lightbox';
    dialog.innerHTML='<header><strong>图片预览</strong><span></span><button type="button" aria-label="关闭图片预览">关闭</button></header><div><img alt="图片预览"></div><footer><button type="button">适应窗口 / 原始大小</button></footer>';
    document.body.append(dialog);dialog.querySelector('header button').onclick=()=>dialog.close();
    dialog.querySelector('footer button').onclick=()=>dialog.classList.toggle('original-size');
    dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  }
  dialog.classList.remove('original-size');
  /* ★ 点开就是要看细节，必须拿原图：加 full=1 让 nginx 跳过按需缩略。
     列表里的 <img> 会被缩到 192，若这里沿用同一个 URL 就还是缩略图，
     而且下面那行尺寸标签会显示成 192 × 288 这种错值。 */
  const lbPreview=dialog.querySelector('img');
  const lbLabel=dialog.querySelector('header span');
  const lbBase=(img.currentSrc||img.src).replace(/([?&])full=1\b&?/,'$1').replace(/[?&]$/,'');
  lbLabel.textContent='加载中…';
  lbPreview.onload=()=>{lbLabel.textContent=lbPreview.naturalWidth+' × '+lbPreview.naturalHeight;};
  lbPreview.onerror=()=>{lbLabel.textContent='加载失败';};
  lbPreview.src=lbBase+(lbBase.includes('?')?'&':'?')+'full=1';
  dialog.showModal();
},true);
const style=document.createElement('style');
style.textContent=`
.image-drop-active{outline:2px solid var(--accent,#b9d4eb)!important;outline-offset:3px;background:#839eb322!important}
#image-lightbox{width:min(1100px,94vw);max-width:94vw;padding:16px;border:1px solid #777;border-radius:14px;background:var(--panel,#25282c);color:var(--text,#eee)}
#image-lightbox::backdrop{background:#000b}
#image-lightbox header{display:flex;align-items:center;gap:16px;margin-bottom:12px}
#image-lightbox header button{margin-left:auto}
#image-lightbox>div{height:70vh;overflow:auto;display:flex;align-items:center;justify-content:center}
#image-lightbox img{max-width:100%;max-height:100%;object-fit:contain;cursor:grab}
#image-lightbox.original-size>div{display:block}
#image-lightbox.original-size img{max-width:none;max-height:none}
#image-lightbox footer{margin-top:12px;text-align:center}
#image-interaction-error{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:#292c30;color:white;padding:14px 22px;border:1px solid #aaa;border-radius:10px}
`;
document.head.append(style);
