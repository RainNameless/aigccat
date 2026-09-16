const fs=require('node:fs/promises'),path=require('node:path');
const {client,ROOT}=require('./client.cjs');
async function main(){
 const id=process.argv[2],task=process.argv[3],stage=task==='texture-parts'?'texture':task==='rig-v2'?'rig':task;
 if(!/^case-\d\d$/.test(id)||!['geometry','texture','rig','walk','run','export'].includes(stage))throw Error('Invalid stage');
 const dir=path.join(ROOT,'outputs/highquality-10',id),file=path.join(dir,task+'.private.json');
 const read=s=>fs.readFile(path.join(dir,s+'.private.json'),'utf8').then(JSON.parse);
 const item=JSON.parse(await fs.readFile(path.join(ROOT,'outputs/highquality-10/manifest.json'))).cases.find(x=>x.id===id);
 let state=await read(task).catch(e=>{if(e.code==='ENOENT')return {};throw e});
 const save=async()=>{await fs.writeFile(file+'.tmp',JSON.stringify(state,null,2),{mode:0o600});await fs.rename(file+'.tmp',file)};
 const c=await client();
 try{
  if(!state.submission){
   let body,route;
   const views=(await read('multiview')).result;if(views.status!=='success'||views.output.data.length!==4)throw Error('Require complete native multiview');
   const images=views.output.data.map(x=>({bucket:x.bucket,key:x.key,image_audit_result:x.image_audit_result,image_source:'generate'}));
   let project;if(stage!=='geometry'){const g=await read('geometry');if(g.status!=='success')throw Error('Geometry incomplete');project=g.result.project_id;}
   if(stage==='geometry'){
    route='/v2/studio/operation/multiview_to_model';body={face_limit:2000000,quad:false,visibility:'shareable',model_version:'v3.1-20260211',geometry_quality:'detailed',generate_parts:false,smart_poly:false,texture:false,image:images};
   }else if(stage==='texture'){
    route='/v2/studio/operation/texture_model';body={project_id:project,images,delight:true,part_names:JSON.parse(await fs.readFile(path.join(dir,'geometry-meshes.json'))),texture_alignment:'original_image',texture_quality:'extreme'};
   }else if(stage==='rig'){
    if(!item.rig_type)throw Error('Static case needs no rig');
    const check=await c.call('/v2/studio/operation/pre_rig_check',{project_id:project,model_version:'v2.5-20260210'});
    state.precheck=check;await save();
    if(!check.riggable||check.rig_type!==item.rig_type)throw Error('Rig precheck mismatch: '+check.rig_type);
    route='/v2/studio/operation/rigging_model';body={project_id:project,rig_type:check.rig_type,model_version:task==='rig-v2'?'v2.0-20250506':check.rig_type==='biped'?'v1.0-20240301':'v2.5-20260210'};
   }else if(['walk','run'].includes(stage)){
    const motion=process.argv[4];if(!motion||!motion.startsWith('preset:'+item.rig_type+':'))throw Error('Grounded matching motion identifier required');
    route='/v2/studio/operation/retarget_model';body={project_id:project,model_version:'default',rig_type:item.rig_type,animations:[motion]};
   }else{
    const d=await c.call('/v2/studio/project/detail/v3/'+project),clips=(d.operator.retarget||[]).filter(x=>x.status==='success');
    if(item.rig_type&&(!d.operator.is_rigged||clips.length<2))throw Error('Rig and two animations required before final export');
    route='/v2/studio/operation/export';body={project_id:project,model_version:'default',name:id,format:'gltf',with_animation:!!item.rig_type,animations:clips.map(x=>x.operator_id),animate_in_place:true,enable_bake_animation:false,bake_animation_frame:0,texture_size:8192,texture_packaging:'zip',pack_uv:false,export_vertex_colors:false,fbx_preset:'blender'};
   }
   state={...state,status:'submitting',submission:new Date().toISOString(),route,body};await save();
   const result=await c.call(route,body);state.result=Array.isArray(result)?result[0]:result;state.operator_id=state.result.operator_id;state.status='submitted';await save();
   if(stage==='export'&&state.result.model_url){state.status='success';await save();}
  }
  if(!state.operator_id&&state.status!=='success')throw Error('Submission unresolved; must not repeat POST');
  for(let i=0;state.status!=='success'&&i<600;i++){
   const p=(await c.call('/v2/studio/progress',{ids:[state.operator_id]})).find(x=>x.operator_id===state.operator_id);
   if(!p)throw Error('Original task missing');state.status=p.status;state.progress=p.progress;await save();
   console.log(JSON.stringify({case:id,stage,status:p.status,progress:p.progress,operator_id:state.operator_id}));
   if(['failed','expired','cancelled','banned'].includes(p.status))throw Error(stage+' '+p.status);
   if(p.status!=='success')await new Promise(r=>setTimeout(r,5000));
  }
  if(state.status!=='success')throw Error('Timeout; query original task');
  if(stage==='export'){
   const output=state.result.model_url?state.result:await c.call('/v2/studio/operation/download_with_name',{operator_id:state.operator_id,file_name:id});
   await fs.writeFile(path.join(dir,'final.glb'),await c.model(output.model_url));
  }else{state.detail=await c.call('/v2/studio/project/detail/v3/'+state.result.project_id+'?operator_id='+state.operator_id);await save();}
 }catch(e){state.error=e.message;await save();throw e}finally{await c.close()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
