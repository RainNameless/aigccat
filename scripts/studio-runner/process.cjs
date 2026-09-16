// Contracts observed in Studio workspace bundles: import_user_model, pre_rig_check,
// rigging_model, retarget_model, export, download_with_name. Never retry submissions.
const {StudioError}=require('./client.cjs');
const valid=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(s);
function validateProcess(input){
 const r=input.request;
 if(!['rig','animation','texture'].includes(r.operation))throw new StudioError('不支持的 Studio 后处理',true);
 if(['rig','texture'].includes(r.operation)&&(!input.glb||Buffer.from(input.glb,'base64').length>150*1024*1024))throw new StudioError('缺少模型或超过150MB',true);
 if(r.operation==='texture'){
  if(!r.prompt?.trim()&&!Object.keys(input.images||{}).length)throw new StudioError('填写贴图描述或准备四视图',true);
  const b=Buffer.from(input.glb,'base64');const g=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)));
  if(g.skins?.length||g.animations?.length)throw new StudioError('AI贴图请使用绑骨前的模型版本，避免丢失骨架和动作',true);
 }
 if(r.operation==='animation'&&(!valid(r.project_id)||!/^preset:biped:[a-z0-9_]+$/.test(r.animation||'')))throw new StudioError('先绑定模型，并选择人物动作',true);
}
async function processModel(c,id,input,read,save){
 let r=await read(id);const req=r.process_request||input.request;
 if(!r.process_request)await save(id,{process_request:req,credits_before:(await c.call('/v2/studio/user/profile/payment')).wallet?.total_credit});
 async function step(name,route,body){
  let state=await read(id);
  if(state.steps?.[name]?.done)return state.steps[name].result;
  let task=state.steps?.[name];
  if(!task){
   await save(id,{stage:'submitting',phase:name,steps:{...state.steps,[name]:{submitting:true}}});
   const result=await c.call(route,body);const entry=Array.isArray(result)?result[0]:result;
   if(route==='/v2/studio/operation/export'&&entry?.model_url){await save(id,{steps:{...(await read(id)).steps,[name]:{done:true,result:entry}}});return entry;}
   if(!valid(entry?.operator_id))throw Error('Studio未返回任务编号，请核对原任务');
   task={operator_id:entry.operator_id,result:entry};
   await save(id,{stage:'polling',operator_id:entry.operator_id,steps:{...(await read(id)).steps,[name]:task}});
  }
  if(!task.operator_id)throw new StudioError('上次提交未取得编号，停止以避免重复计费；请在Studio核对',true);
  const deadline=Date.now()+30*60*1000;
  while(Date.now()<deadline){
   const list=await c.call('/v2/studio/progress',{ids:[task.operator_id]}),p=list.find(x=>x.operator_id===task.operator_id);
   if(!p)throw Error('未查到原任务');
   if(['failed','cancelled','banned','expired'].includes(p.status))throw new StudioError(name+'失败：'+p.status,true);
   if(p.status==='success'){
    await save(id,{steps:{...(await read(id)).steps,[name]:{...task,done:true}}});return task.result;
   }
   await save(id,{phase:name,percent:Math.min(90,Number(p.progress)||5)});
   await new Promise(resolve=>setTimeout(resolve,3000));
  }
  throw Error(name+'等待超时，可查询原任务');
 }
 let project=r.project_id||req.project_id;
 if(['rig','texture'].includes(req.operation)){
  if(!project){
   let uploaded=r.uploaded;
   if(!uploaded){if(!input?.glb)throw new StudioError('上传中断，请重新发起绑骨',true);uploaded=await c.upload(Buffer.from(input.glb,'base64'),'glb');await save(id,{uploaded});}
   const result=await step('导入模型','/v2/studio/operation/import_user_model',{format:'glb',model:uploaded,name:'aigccat-'+id,transform_matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],use_original_uv:req.operation!=='texture'});
   project=result.project_id; if(!valid(project))throw Error('导入未返回项目编号');await save(id,{project_id:project});
  }
  if(req.operation==='rig'&&!(await read(id)).steps?.['人物骨骼绑定']?.done){
  const check=await c.call('/v2/studio/operation/pre_rig_check',{project_id:project,model_version:'v1.0-20240301'});
  if(!check.riggable||check.rig_type!=='biped')throw new StudioError('当前模型不适合人物绑定，请上传双臂展开、四肢分离的人物模型',true);
  await step('人物骨骼绑定','/v2/studio/operation/rigging_model',{project_id:project,model_version:'v1.0-20240301',rig_type:'biped'});
  }
 }
 if(req.operation==='texture'){
  let images=(await read(id)).texture_images;
  if(!images){images={};for(const [view,b64] of Object.entries(input?.images||{}))images[view]=await c.upload(Buffer.from(b64,'base64'));await save(id,{texture_images:images});}
  const body={project_id:project,delight:true,part_names:[],texture_alignment:Object.keys(images).length?'original_image':'geometry',texture_quality:'standard'};
  if(Object.keys(images).length)body.images=['front','side','back','right'].map(v=>images[v]||null);else body.prompt_text=req.prompt;
  await step('生成模型贴图','/v2/studio/operation/texture_model',body);
 }
 let detail=await c.call('/v2/studio/project/detail/v3/'+project);
 if(req.operation!=='texture'&&!detail.operator?.is_rigged)throw new StudioError('Studio模型尚未绑骨',true);
 let animationIds=[];
 if(req.operation==='animation'){
  const existing=detail.operator.retarget?.find(x=>x.name===req.animation&&x.status==='success');
  if(!existing){await step('生成模型动作','/v2/studio/operation/retarget_model',{project_id:project,model_version:'default',rig_type:'biped',animations:[req.animation]});detail=await c.call('/v2/studio/project/detail/v3/'+project);}
  const clip=detail.operator.retarget?.find(x=>x.name===req.animation&&x.status==='success');
  if(!clip)throw Error('未返回所选动作');animationIds=detail.operator.retarget.filter(x=>x.status==='success').map(x=>x.operator_id);
 }
 const result=await step('导出GLB','/v2/studio/operation/export',{project_id:project,model_version:'default',name:'aigccat-'+id,format:'gltf',with_animation:req.operation!=='texture',animations:animationIds,animate_in_place:true,enable_bake_animation:false,bake_animation_frame:0,texture_size:2048,texture_packaging:'zip',pack_uv:false,export_vertex_colors:false,fbx_preset:'blender'});
 const file=result.model_url?result:await c.call('/v2/studio/operation/download_with_name',{operator_id:result.operator_id,file_name:'aigccat-'+id});
 const raw=await c.model(file.model_url);
 const json=JSON.parse(raw.subarray(20,20+raw.readUInt32LE(12)).toString());
 if(req.operation==='texture'?!json.textures?.length:(!json.skins?.length||req.operation==='animation'&&!json.animations?.length))throw new StudioError('导出模型缺少要求的贴图、骨骼或动画，未作为成功入库',true);
 await save(id,{project_id:project,rig_type:req.operation==='texture'?null:'biped',operator_id:detail.operator.operator_id});
 return raw;
}
module.exports={processModel,validateProcess};
