// Persist export submission before sending: an unknown submission is never repeated.
async function exportGenerated(c,id,record,save){
 const size=record.texture_size;
 if(!size)return null;
 let task=record.quality_export;
 if(!task){
  await save(id,{quality_export:{submitting:true},phase:'按所选尺寸导出贴图',stage:'exporting'});
  const result=await c.call('/v2/studio/operation/export',{project_id:record.project_id,model_version:'default',name:id,format:'gltf',with_animation:false,animations:[],animate_in_place:true,enable_bake_animation:false,bake_animation_frame:0,texture_size:size,texture_packaging:'zip',pack_uv:false,export_vertex_colors:false,fbx_preset:'blender'});
  task=Array.isArray(result)?result[0]:result;
  if(!task?.model_url&&!task?.operator_id)throw Error('导出未返回任务编号，请核对Studio，不能重复提交');
  await save(id,{quality_export:task});
 }
 if(task.model_url)return c.model(task.model_url);
 if(!task.operator_id)throw Error('导出提交结果未知，请核对Studio；不会重复提交');
 const deadline=Date.now()+30*60*1000;
 while(Date.now()<deadline){
  const list=await c.call('/v2/studio/progress',{ids:[task.operator_id]});const p=list.find(x=>x.operator_id===task.operator_id);
  if(!p)throw Error('未查询到导出任务');
  if(['failed','expired','cancelled','banned'].includes(p.status)){const e=Error('Studio导出失败：'+p.status);e.confirmed=true;throw e;}
  if(p.status==='success'){
   const file=await c.call('/v2/studio/operation/download_with_name',{operator_id:task.operator_id,file_name:id});
   return c.model(file.model_url);
  }
  await new Promise(resolve=>setTimeout(resolve,3000));
 }
 throw Error('导出等待超时，可查询原任务');
}
module.exports={exportGenerated};
