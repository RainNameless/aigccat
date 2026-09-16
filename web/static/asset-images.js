// One coherent four-view set per asset. Preserve source files and historical groups.
export const imageViews=['front','back','side','right'];
export function imageView(item){return item.path.match(/(?:_|\/)(front|back|side|right)\.png$/)?.[1]||'';}
export function assetImages(items){
 const groups=new Map();
 for(const item of items){
  const m=item.path.match(/^(source\/images\/job_(\d+)_set(\d+))_(front|back|side|right)\.png$/);
  if(m){if(!groups.has(m[1]))groups.set(m[1],{job:Number(m[2]),set:Number(m[3]),views:{}});groups.get(m[1]).views[m[4]]=item;}
 }
 const generated=[...groups.values()].filter(g=>imageViews.every(v=>g.views[v])).sort((a,b)=>b.job-a.job||b.set-a.set)[0];
 if(generated)return imageViews.map(v=>generated.views[v]);
 const refs=imageViews.map(v=>items.find(i=>i.path===`source/reference_${v}.png`));
 if(refs.every(Boolean))return refs;
 // Only use actual model renders when no original/reference images are available.
 const originals=items.filter(i=>!i.path.startsWith('source/model_views/')&&!/(?:preview|thumbnail|poster)/i.test(i.path));
 if(originals.length){const partial=refs.filter(Boolean);return partial.length?partial:originals.filter(i=>i.path!=='source/input_reference.png').slice(0,4).concat(originals.length===1&&originals[0].path==='source/input_reference.png'?originals:[]);}
 const rendered=items.filter(i=>i.path.startsWith('source/model_views/')).sort((a,b)=>b.path.localeCompare(a.path));
 return imageViews.map(v=>rendered.find(i=>i.path.endsWith('/'+v+'.png'))).filter(Boolean);
}
