// Durable native Studio image stages. Never repeat a POST with an unresolved marker.
const fs=require('node:fs/promises');
const path=require('node:path');
const {client,ROOT}=require('./client.cjs');
const DIR=path.join(ROOT,'outputs/highquality-10');
async function main(){
 const id=process.argv[2]||'case-01',stage=process.argv[3]||'original';
 if(!/^case-\d\d$/.test(id)||!['original','multiview'].includes(stage))throw Error('Invalid case/stage');
 const manifest=JSON.parse(await fs.readFile(path.join(DIR,'manifest.json'))),item=manifest.cases.find(x=>x.id===id);
 if(!item)throw Error('Unknown case');
 const dir=path.join(DIR,id);await fs.mkdir(dir,{recursive:true});
 const {execFileSync}=require('node:child_process');
 execFileSync('/usr/bin/python3',[path.join(__dirname,'fullflow-import.py'),id,'draft'],{stdio:'ignore'});
 const checkpoint=path.join(dir,stage+'.private.json');
 let state=await fs.readFile(checkpoint,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return {};throw e});
 const save=async()=>{await fs.writeFile(checkpoint+'.tmp',JSON.stringify(state,null,2),{mode:0o600});await fs.rename(checkpoint+'.tmp',checkpoint)};
 const c=await client();
 try{
  if(!state.submission){
   let body,route;
   if(stage==='original'){
    route='/v2/studio/image/gen_image_v2';body={if_upload:true,sketch_to_render:false,t_pose:false,amount:1,model_version:'gemini_2.5_flash_image_preview',prompt:item.prompt};
   }else{
    const original=JSON.parse(await fs.readFile(path.join(dir,'original.private.json')));
    const image=original.result?.output?.data?.[0];if(!image||original.result.status!=='success')throw Error('Original image not complete');
    route='/v2/studio/image/gen_multiview';body={if_upload:true,image:{bucket:image.bucket,key:image.key,image_audit_result:image.image_audit_result||'pass',image_source:'generate'}};
   }
   state={status:'submitting',submission:new Date().toISOString(),route,body};await save();
   const result=await c.call(route,body);state.asset_id=result.asset_id;state.status='submitted';await save();
   if(!state.asset_id)throw Error('Submission returned no asset_id; inspect original request, do not resubmit');
  }
  if(!state.asset_id)throw Error('Unresolved submission; POST must not be repeated');
  for(let i=0;i<240;i++){
   const result=await c.call('/v2/studio/image/get_image_asset',{asset_id:state.asset_id});
   state.result=result;state.status=result.status;await save();
   console.log(JSON.stringify({case:id,stage,asset_id:state.asset_id,status:state.status,images:result.output?.data?.length||0}));
   if(result.status==='success')return;
   if(['failed','expired'].includes(result.status))throw Error(stage+' '+result.status);
   await new Promise(r=>setTimeout(r,5000));
  }
  throw Error('Polling timed out; resume existing asset_id');
 }catch(e){state.error=e.message;await save();throw e}finally{await c.close()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
