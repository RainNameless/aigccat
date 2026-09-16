// Cache only models explicitly opened by the user. No prefetch queue or GPU scene cache.
const MiB=1024*1024;
export function createModelCache({fetcher=(...args)=>fetch(...args),idb=globalThis.indexedDB,baseURL=globalThis.location?.href||'http://localhost/',memoryLimit=384*MiB,diskLimit=2*1024*MiB,dbName='aigccat-opened-models-v1'}={}) {
  const memory=new Map();let memorySize=0,dbPromise,writes=Promise.resolve();
  const check=signal=>{if(signal?.aborted)throw new DOMException('Cancelled','AbortError');};
  function remember(key,entry){const old=memory.get(key);if(old)memorySize-=old.blob.size;memory.delete(key);if(entry.blob.size>memoryLimit)return;memory.set(key,entry);memorySize+=entry.blob.size;while(memorySize>memoryLimit){const key=memory.keys().next().value;memorySize-=memory.get(key).blob.size;memory.delete(key);}}
  function database(){if(!idb)return Promise.resolve(null);return dbPromise??=new Promise(resolve=>{const r=idb.open(dbName,1);r.onupgradeneeded=()=>{r.result.createObjectStore('files');r.result.createObjectStore('metadata',{keyPath:'key'});};r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};r.onerror=()=>resolve(null);r.onblocked=()=>resolve(null);});}
  async function readDisk(key){try{await writes;const db=await database();if(!db)return null;return await new Promise(resolve=>{const tx=db.transaction(['files','metadata']);let blob,meta;tx.objectStore('files').get(key).onsuccess=e=>blob=e.target.result;tx.objectStore('metadata').get(key).onsuccess=e=>meta=e.target.result;tx.oncomplete=()=>resolve(blob&&meta?{blob,etag:meta.etag}:null);tx.onerror=tx.onabort=()=>resolve(null);});}catch{return null;}}
  function persist(key,entry){writes=writes.catch(()=>{}).then(async()=>{const db=await database();if(!db||entry.blob.size>diskLimit)return;await new Promise((resolve,reject)=>{const tx=db.transaction(['files','metadata'],'readwrite'),files=tx.objectStore('files'),meta=tx.objectStore('metadata');meta.getAll().onsuccess=e=>{const records=e.target.result.filter(r=>r.key!==key).sort((a,b)=>a.used-b.used);let total=entry.blob.size+records.reduce((n,r)=>n+r.size,0);for(const r of records){if(total<=diskLimit)break;files.delete(r.key);meta.delete(r.key);total-=r.size;}files.put(entry.blob,key);meta.put({key,etag:entry.etag,size:entry.blob.size,used:Math.max(Date.now(),...e.target.result.map(r=>r.used+1))});};tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);});}).catch(()=>{});}
  function touch(key){writes=writes.catch(()=>{}).then(async()=>{const db=await database();if(!db)return;await new Promise(resolve=>{const tx=db.transaction('metadata','readwrite'),store=tx.objectStore('metadata');store.getAll().onsuccess=e=>{const item=e.target.result.find(r=>r.key===key);if(item)store.put({...item,used:Math.max(Date.now(),...e.target.result.map(r=>r.used+1))});};tx.oncomplete=tx.onerror=tx.onabort=resolve;});}).catch(()=>{});}
  async function forget(url){const key=new URL(url,baseURL).href,old=memory.get(key);if(old){memorySize-=old.blob.size;memory.delete(key);}writes=writes.catch(()=>{}).then(async()=>{const db=await database();if(!db)return;await new Promise(resolve=>{const tx=db.transaction(['files','metadata'],'readwrite');tx.objectStore('files').delete(key);tx.objectStore('metadata').delete(key);tx.oncomplete=tx.onerror=tx.onabort=resolve;});});await writes;}
  async function bytes(url,signal,onProgress){
    check(signal);const address=new URL(url,baseURL),key=address.href;
    const match=address.origin===new URL(baseURL).origin&&address.pathname.match(/^\/api\/assets\/([\w-]+)\/([\w-]+)\/file\/versions\/(v\d+)\/model\.glb$/);
    let identity=null;
    if(match){
      const validation=await fetcher(`${address.origin}/api/assets/${match[1]}/${match[2]}/versions/${match[3]}/model-cache`,{signal,cache:'no-store'});
      if(!validation.ok){await forget(key);throw Error(`模型版本校验失败（${validation.status}）`);}
      identity=await validation.json();check(signal);
      if(!identity.etag||!Number.isSafeInteger(identity.size)||identity.size<=0)throw Error('模型版本校验响应无效');
      let entry=memory.get(key),source='memory';if(!entry){entry=await readDisk(key);source='disk';}check(signal);
      if(entry&&entry.etag===identity.etag&&entry.blob.size===identity.size){remember(key,entry);touch(key);const buffer=await entry.blob.arrayBuffer();check(signal);onProgress?.({loaded:buffer.byteLength,total:buffer.byteLength,cache:source});return buffer;}
      if(entry)await forget(key);
    }
    const response=await fetcher(key,{signal});
    if(!response.ok)throw Error(`模型下载失败（${response.status}）`);
    const total=Number(response.headers.get('x-resource-length')||(!response.headers.get('content-encoding')&&response.headers.get('content-length')))||0;
    const reader=response.body.getReader(),chunks=[];let loaded=0,last=0;
    try{for(;;){check(signal);const {done,value}=await reader.read();if(done)break;chunks.push(value);loaded+=value.byteLength;if(performance.now()-last>100){last=performance.now();onProgress?.({loaded,total});}}}catch(error){await reader.cancel().catch(()=>{});throw error;}
    check(signal);const blob=new Blob(chunks),buffer=await blob.arrayBuffer();check(signal);
    const view=buffer.byteLength>=12?new DataView(buffer):null;
    if(!view||view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==buffer.byteLength)throw Error('模型文件不完整或不是有效 GLB');
    if(identity&&identity.size===blob.size){const entry={etag:identity.etag,blob};remember(key,entry);persist(key,entry);}
    onProgress?.({loaded,total:total||loaded,cache:null});return buffer;
  }
  return {bytes,forget,flush:()=>writes};
}
const cache=createModelCache();
export const modelBytes=(url,signal,onProgress)=>cache.bytes(url,signal,onProgress);
export const forgetModel=url=>cache.forget(url);
