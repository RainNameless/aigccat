export function createAssetTransition(layout,viewport){
  const host=layout.querySelector('#asset-list');let active=0,key='',label='',percent;
  function draw(){
    for(const card of host.querySelectorAll('.asset-card')){
      let badge=card.querySelector('.asset-load-overlay');
      if(!active||card.dataset.key!==key){badge?.remove();card.removeAttribute('aria-busy');continue;}
      if(!badge){badge=document.createElement('div');badge.className='asset-load-overlay';badge.innerHTML='<span class="asset-load-spinner"></span><span role="status"></span><progress aria-label="模型加载进度" max="100"></progress>';card.append(badge);}
      const thumbnail=card.querySelector('.open-asset>img,.open-asset>.no-thumb');badge.style.height=Math.max(96,thumbnail?.getBoundingClientRect().height||120)+'px';
      card.setAttribute('aria-busy','true');const text=badge.querySelector('[role=status]');if(text.textContent!==label)text.textContent=label;
      const bar=badge.querySelector('progress');if(Number.isFinite(percent))bar.value=percent;else bar.removeAttribute('value');
    }
  }
  new MutationObserver(draw).observe(host,{childList:true});
  function clear(id){if(id!==active)return;active=0;delete layout.dataset.pendingAsset;draw();}
  return {
    begin(id,name,assetKey){active=id;key=assetKey;label='读取资源…';percent=undefined;layout.dataset.pendingAsset=key;draw();},
    update(id,value,p){if(id!==active)return;label=value;percent=p;draw();},
    async finish(id){clear(id);},
    fail(id,error){clear(id);},
    cancel(){clear(active);}
  };
}
