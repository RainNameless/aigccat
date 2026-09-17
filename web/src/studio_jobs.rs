//! Studio subscription session jobs; the local worker uses authenticated HTTP, no UI.
use crate::{assets::AppState,ops,tripo::Generate,model_jobs};
use axum::{extract::{State,Path},http::StatusCode,Json};
use serde_json::{Value,json};
use std::{sync::Arc,time::Duration};
use base64::{Engine as _,engine::general_purpose::STANDARD};
type Shared=Arc<AppState>;
type ResultApi=Result<(StatusCode,Json<Value>),(StatusCode,String)>;
fn error(e:impl Into<String>)->(StatusCode,String){(StatusCode::BAD_REQUEST,e.into())}
struct Worker{http:reqwest::Client,url:String,token:String}
impl Worker{
 fn new()->Result<Self,String>{Ok(Self{http:reqwest::Client::builder().timeout(Duration::from_secs(180)).build().map_err(|_|"执行器客户端初始化失败")?,url:std::env::var("STUDIO_WORKER_URL").unwrap_or("http://host.docker.internal:8790".into()),token:std::env::var("STUDIO_WORKER_TOKEN").map_err(|_|"Studio 执行器未配置")?})}
 async fn call(&self,path:&str,body:Option<Value>)->Result<Value,String>{
  let r=if let Some(v)=body{self.http.post(format!("{}{path}",self.url)).json(&v)}else{self.http.get(format!("{}{path}",self.url))}.bearer_auth(&self.token).send().await.map_err(|e| if e.is_connect(){"Studio 执行器未建立连接，未提交生成"}else{"Studio 后台连接中断；请查询原任务，不会自动重新生成"})?;
  let status=r.status();let v:Value=r.json().await.map_err(|_|"执行器响应格式无效")?;
  if !status.is_success(){return Err(v["error"].as_str().unwrap_or("Studio 执行器请求失败").to_string());}Ok(v)
 }
 async fn model(&self,id:&str)->Result<Vec<u8>,String>{
  let r=self.http.get(format!("{}/jobs/{id}/model",self.url)).bearer_auth(&self.token).send().await.map_err(|_|"模型传输中断，可查询原任务")?;
  if !r.status().is_success(){return Err("执行器模型尚不可用".into());}
  crate::services::bounded_body(r,150*1024*1024).await
 }
}
pub async fn health()->Json<Value>{
 let result=async{Worker::new()?.call("/health",None).await}.await;
 Json(match result{Ok(v)=>v,Err(e)=>json!({"ready":false,"error":e})})
}
// 会话接入的界面入口：转发给宿主执行器。执行器负责开浏览器、抓 cookie、落盘。
pub async fn session_state()->Json<Value>{
 let result=async{Worker::new()?.call("/session",None).await}.await;
 Json(match result{Ok(v)=>v,Err(e)=>json!({"state":"unavailable","error":e})})
}
pub async fn session_action(Json(body):Json<Value>)->ResultApi{
 let path=match body["action"].as_str().unwrap_or(""){
  "start"=>"/session/start","finish"=>"/session/finish","cancel"=>"/session/cancel",
  _=>return Err(error("未知操作")),
 };
 let worker=Worker::new().map_err(|e| error(e))?;
 match worker.call(path,Some(json!({}))).await{Ok(v)=>Ok((StatusCode::OK,Json(v))),Err(e)=>Err(error(e))}
}
pub fn validate(req:&Generate)->Result<(),String>{
 if req.source!="studio"{return Err("不是 Studio 任务".into());}
 let model=req.model_id.as_deref().unwrap_or("v3.0-20250812");
 if !["v3.0-20250812","v3.1-20260211","v2.5-20250123"].contains(&model){return Err("Studio 模型版本无效".into());}
 req.validate(model)?;
 if req.mode=="text"&&req.prompt.chars().count()>1000{return Err("Studio 文字描述最多1000字".into());}
 Ok(())
}
pub async fn generate(st:Shared,dir:String,id:String,mut req:Generate)->ResultApi{
 if req.model_id.is_none(){req.model_id=Some("v3.0-20250812".into());}validate(&req).map_err(error)?;
 let worker=Worker::new().map_err(error)?;
 let (base,asset,_,_)=ops::load(&st,&dir,&id).await?;
 if let Some(expected)=req.expected_history_node_id.as_deref(){if let Some(r)=crate::history::check_stale_head(&st.store,&base,expected).await{return Ok(r);}}
 let permit=ops::MODEL_GATE.try_acquire().map_err(|_|(StatusCode::CONFLICT,"已有模型任务运行中".into()))?;
 if ops::has_active_model_job(&st,&base).await{return Err((StatusCode::CONFLICT,"该资产有未确认任务，请查询原任务".into()));}
 let mut images=serde_json::Map::new();let mut snapshots=Vec::new();
 if req.mode!="text"{for view in ["front","side","back","right"]{
  if req.mode=="single"&&view!="front"{continue;}
  if let Ok(bytes)=st.store.get_bytes(&format!("{base}/source/reference_{view}.png")).await{
   let bytes=crate::tripo::reference_png(&bytes).map_err(|e|error(format!("{view}参考图：{e}")))?;
   images.insert(view.into(),json!(STANDARD.encode(&bytes)));snapshots.push((view,bytes));
  }
 }if !images.contains_key("front")||req.mode=="multi"&&images.len()<2{return Err(error("缺少所需参考图"));}}
 let job=ops::next_job(&st,&base,"model_build",json!({"provider":"tripo_studio","status":"running","stage":"prepared","started_at":ops::now_epoch(),"request":req,"model":req.model_id,"progress":{"phase":"准备 Studio 任务","percent":0}})).await?;
 let runner_id=format!("{dir}__{id}__{job}");
 for(view,bytes)in snapshots{if st.store.put_bytes(&format!("{base}/jobs/{job}/reference_{view}.png"),&bytes).await.is_err(){let _=model_jobs::patch(&st,&base,&job,json!({"status":"failed","error":"输入快照保存失败，未提交","finished_at":ops::now_epoch()})).await;return Err(error("输入快照保存失败"));}}
 model_jobs::patch(&st,&base,&job,json!({"runner_id":runner_id})).await.map_err(error)?;
 let response=json!({"job_id":job,"provider":"tripo_studio","status":"running","accepted":true});
 tokio::spawn(async move{let _permit=permit;
  let r=worker.call(&format!("/jobs/{runner_id}"),Some(json!({"request":req,"images":images}))).await;
  if let Err(e)=r{let not_sent=e.contains("未建立连接");let _=model_jobs::patch(&st,&base,&job,json!({"status":if not_sent{"failed"}else{"waiting"},"resumable":!not_sent,"error":e,"finished_at":ops::now_epoch()})).await;return;}
  poll(st,base,job,asset,worker,runner_id).await;
 });
 Ok((StatusCode::ACCEPTED,Json(response)))
}
async fn poll(st:Shared,base:String,job:String,asset:Value,worker:Worker,id:String){
 let result=tokio::time::timeout(Duration::from_secs(1900),async{
  loop{
   let r=worker.call(&format!("/jobs/{id}"),None).await?;
   model_jobs::patch(&st,&base,&job,json!({"provider_task_id":r["operator_id"],"studio_project_id":r["project_id"],"stage":r["stage"],"progress":{"phase":r["phase"],"percent":r["percent"]},"timings":{"started_at":r["started_at"],"submitted_at":r["submitted_at"],"generated_at":r["generated_at"],"finished_at":r["finished_at"]},"credits_before":r["credits_before"],"credits_after":r["credits_after"]})).await?;
   if r["status"]=="done"{
    let glb=match st.store.get_bytes(&format!("{base}/jobs/{job}/result.glb")).await{Ok(b)=>b,Err(_)=>{let b=worker.model(&id).await?;st.store.put_bytes(&format!("{base}/jobs/{job}/result.glb"),&b).await?;b}};
    let preview=async{let response=worker.http.get(format!("{}/jobs/{id}/preview",worker.url)).bearer_auth(&worker.token).send().await.ok()?;if !response.status().is_success(){return None;}crate::services::bounded_body(response,5*1024*1024).await.ok()}.await;
    let record=st.store.get_json(&format!("{base}/jobs/{job}.json")).await?;
    if record["kind"]=="model_process" {
     let check=crate::validator::validate_glb(&glb,None);if !check.ok{return Err("Studio处理模型校验失败".into());}
     let ver=ops::store_version(&st.store,&base,&asset,&glb,json!({"provider":"tripo_studio","operation":record["operation"],"source_version":record["source_version"],"source_job_id":job,"studio_project_id":r["project_id"],"request":record["request"]}),&check).await?;
     if let Some(bytes)=preview{st.store.put_bytes(&format!("{base}/versions/{ver}/preview.png"),&bytes).await?;}
     model_jobs::patch(&st,&base,&job,json!({"status":"done","version":ver,"error":null,"resumable":false,"finished_at":ops::now_epoch(),"progress":{"phase":"处理版本已保存","percent":100}})).await?;
    }else{model_jobs::commit_result(&st,&base,&job,&asset,r["operator_id"].as_str().unwrap_or(&id),&glb,preview,r["preview_warning"].as_str().map(String::from)).await?;}
    return Ok::<(),String>(());
   }
   if ["failed","waiting","unknown"].contains(&r["status"].as_str().unwrap_or("")){
    model_jobs::patch(&st,&base,&job,json!({"status":r["status"],"error":r["error"],"resumable":r["status"]=="waiting","finished_at":ops::now_epoch()})).await?;return Ok(());
   }
   tokio::time::sleep(Duration::from_secs(2)).await;
  }
 }).await.unwrap_or_else(|_|Err("等待超时，可查询原 Studio 任务".into()));
 if let Err(e)=result{let _=model_jobs::patch(&st,&base,&job,json!({"status":"waiting","error":e,"resumable":true})).await;}
}
pub async fn process(State(st):State<Shared>,Path((dir,id,ver)):Path<(String,String,String)>,Json(req):Json<Value>)->ResultApi{
 crate::tripo::valid_id(&ver).map_err(error)?;
 let op=req["operation"].as_str().unwrap_or("");
 if !["rig","animation","texture"].contains(&op){return Err(error("仅支持贴图、人物绑骨与动作"));}
 let worker=Worker::new().map_err(error)?;
 let(base,asset,_,_)=ops::load(&st,&dir,&id).await?;
 let permit=ops::MODEL_GATE.try_acquire().map_err(|_|(StatusCode::CONFLICT,"已有模型任务运行中".into()))?;
 if ops::has_active_model_job(&st,&base).await{return Err((StatusCode::CONFLICT,"请先查询未确认任务".into()));}
 if let Some(expected)=req["expected_history_node_id"].as_str(){if let Some(r)=crate::history::check_stale_head(&st.store,&base,expected).await{return Ok(r);}}
 let bytes=st.store.get_bytes(&format!("{base}/versions/{ver}/model.glb")).await.map_err(error)?;
 let mut request=json!({"operation":op,"source_version":ver});
 if op=="animation"{
  let meta=st.store.get_json(&format!("{base}/versions/{ver}/meta.json")).await.map_err(error)?;
  let project=meta["studio_project_id"].as_str().ok_or_else(||error("此版本尚未关联Studio骨架，请先在绑骨蒙皮完成绑定"))?;
  crate::tripo::valid_id(project).map_err(error)?;
  let motion=req["animation"].as_str().ok_or_else(||error("请选择动作"))?;
  if !motion.starts_with("preset:biped:")||motion.len()>100||!motion.chars().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c=='_'||c==':'){return Err(error("动作编号无效"));}
  request["project_id"]=json!(project);request["animation"]=json!(motion);
 }
 let mut images=serde_json::Map::new();
 if op=="texture" {
  let gltf:Value=bytes.get(12..16).and_then(|b|<[u8;4]>::try_from(b).ok()).and_then(|b|bytes.get(20..20+u32::from_le_bytes(b) as usize)).and_then(|b|serde_json::from_slice(b).ok()).ok_or_else(||error("模型格式无效"))?;
  if gltf["skins"].as_array().is_some_and(|a|!a.is_empty())||gltf["animations"].as_array().is_some_and(|a|!a.is_empty()){return Err(error("AI贴图请使用绑骨前的版本，避免丢失骨架和动作"));}
  if req["input"]=="reference" {
   for view in ["front","side","back","right"] {
    let b=st.store.get_bytes(&format!("{base}/source/reference_{view}.png")).await.map_err(|_|error("请先补齐前后左右四张参考图"))?;
    let b=crate::tripo::reference_png(&b).map_err(|e|error(format!("{view}参考图：{e}")))?;
    images.insert(view.into(),json!(STANDARD.encode(b)));
   }
  } else {
   let prompt=req["prompt"].as_str().unwrap_or("").trim();
   if prompt.is_empty()||prompt.chars().count()>1000{return Err(error("贴图描述需1–1000字"));}
   request["prompt"]=json!(prompt);
  }
 }
 let job=ops::next_job(&st,&base,"model_process",json!({"provider":"tripo_studio","status":"running","operation":op,"request":request,"source_version":ver,"started_at":ops::now_epoch()})).await?;
 let runner_id=format!("{dir}__{id}__{job}");
 model_jobs::patch(&st,&base,&job,json!({"runner_id":runner_id})).await.map_err(error)?;
 let input=json!({"request":request,"images":images,"glb":if op!="animation"{Some(STANDARD.encode(bytes))}else{None}});
 let response=json!({"job_id":job,"provider":"tripo_studio","status":"running"});
 tokio::spawn(async move{let _permit=permit;
  if let Err(e)=worker.call(&format!("/jobs/{runner_id}"),Some(input)).await{let _=model_jobs::patch(&st,&base,&job,json!({"status":"waiting","error":e,"resumable":true})).await;return;}
  poll(st,base,job,asset,worker,runner_id).await;
 });
 Ok((StatusCode::ACCEPTED,Json(response)))
}
pub async fn resume(State(st):State<Shared>,Path((dir,id,job)):Path<(String,String,String)>)->ResultApi{
 let(base,asset,_,_)=ops::load(&st,&dir,&id).await?;
 let r=st.store.get_json(&format!("{base}/jobs/{job}.json")).await.map_err(error)?;
 if r["status"]=="done"{return Ok((StatusCode::OK,Json(r)));}
 let runner=r["runner_id"].as_str().ok_or_else(||error("没有原 Studio 执行器任务"))?.to_string();
 crate::tripo::valid_id(&runner).map_err(error)?;
 let worker=Worker::new().map_err(error)?;
 let permit=ops::MODEL_GATE.try_acquire().map_err(|_|(StatusCode::CONFLICT,"已有模型任务运行中".into()))?;
 worker.call(&format!("/jobs/{runner}/resume"),Some(json!({}))).await.map_err(error)?;
 model_jobs::patch(&st,&base,&job,json!({"status":"running","error":null})).await.map_err(error)?;
 let response=json!({"job_id":job,"status":"running"});
 tokio::spawn(async move{let _permit=permit;poll(st,base,job,asset,worker,runner).await;});
 Ok((StatusCode::ACCEPTED,Json(response)))
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn studio_contract(){let r=Generate{source:"studio".into(),mode:"text".into(),prompt:"test".into(),model_id:Some("v3.0-20250812".into()),..Default::default()};assert!(validate(&r).is_ok());assert!(validate(&Generate{model_id:Some("fake".into()),..r.clone()}).is_err());assert!(validate(&Generate{prompt:"".into(),..r}).is_err());}
}
