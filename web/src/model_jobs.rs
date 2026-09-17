//! Durable Tripo orchestration: input snapshot -> one submission -> poll -> local version.
use crate::{assets::{AppState,CATEGORIES},ops,services,tripo::{Client,Generate},validator};
use axum::{extract::{Path,State},http::StatusCode,response::Json};
use serde_json::{json,Value};
use std::{sync::Arc,time::Duration};
type Shared=Arc<AppState>;
type ResultApi=Result<(StatusCode,Json<Value>),(StatusCode,String)>;
fn bad(e: impl Into<String>)->(StatusCode,String){(StatusCode::BAD_REQUEST,e.into())}
fn storage(e: impl Into<String>)->(StatusCode,String){(StatusCode::INTERNAL_SERVER_ERROR,e.into())}
fn valid_asset(dir:&str,id:&str)->Result<(),(StatusCode,String)>{
    if !CATEGORIES.contains(&dir) {return Err(bad("资产类型无效"));} crate::tripo::valid_id(id).map_err(bad)
}
pub(crate) async fn patch(st:&Shared,base:&str,job:&str,value:Value)->Result<(),String>{
    ops::patch_job(st,base,job,value).await?;
    let record=st.store.get_json(&format!("{base}/jobs/{job}.json")).await?;
    st.store.put_json(&format!("{base}/model_activity.json"),&record).await
}

pub async fn generate(State(st):State<Shared>,Path((dir,id)):Path<(String,String)>,body:axum::body::Bytes)->ResultApi{
    valid_asset(&dir,&id)?;
    let req:Generate=if body.is_empty(){Generate::default()}else{serde_json::from_slice(&body).map_err(|_|bad("建模请求无效；请刷新页面，使用文字或图片建模"))?};
    if req.source=="studio"{return crate::studio_jobs::generate(st,dir,id,req).await;}
    if req.source!="api"{return Err(bad("生成来源无效"));}
    // 按供应商路由：模型配置里选了谁，就走谁的传输层。
    let settings=services::snapshot(&st.cfg).map_err(storage)?;
    let (provider,service)=settings.model3d_route(req.model_id.as_deref()).map_err(bad)?;
    match provider.as_str() {
        "tripo" => generate_tripo(st,dir,id,req,service).await,
        "meshy" => generate_meshy(st,dir,id,req,service).await,
        other => {
            // 未接入的供应商：把「为什么不能跑、去哪看文档」一次说清，别让人猜
            let b=crate::providers::builtin(other);
            let auth_hint=if b.is_some_and(|b|b.auth==crate::providers::Auth::TencentCloudSignature){"（注意：它用腾讯云 TC3 签名，不是 Bearer Key）"}else{""};
            let name=b.map(|b|b.name).unwrap_or(other);
            let docs=b.map(|b|b.docs).unwrap_or("docs/PROVIDERS.md");
            Err(bad(format!("「{name}」的生成传输层尚未接入本分支{auth_hint}；官方端点已核对（{docs}），可先用 Tripo / Meshy")))
        }
    }
}

async fn generate_tripo(st:Shared,dir:String,id:String,req:Generate,service:crate::services::Service)->ResultApi{
    req.validate(&service.model).map_err(bad)?;
    let base_url=service.base_url.clone();
    let client=Client::new(service).map_err(bad)?;
    let (base,asset,_,_)=ops::load(&st,&dir,&id).await?;
    if let Some(expected)=req.expected_history_node_id.as_deref(){
        if let Some(result)=crate::history::check_stale_head(&st.store,&base,expected).await{return Ok(result);}
    }
    // Lock before checking persisted jobs: no double charge on simultaneous clicks.
    let permit=ops::MODEL_GATE.try_acquire().map_err(|_|(StatusCode::CONFLICT,"已有模型任务在运行，请等任务完成".into()))?;
    if ops::has_active_model_job(&st,&base).await{return Err((StatusCode::CONFLICT,"该资产仍有未确认的模型任务，请先查看任务记录并查询原任务".into()));}
    let mut images=Vec::new();
    if req.mode!="text" {
        for view in ["front","side","back","right"] {
            if req.mode=="single" && view!="front" {continue;}
            match st.store.get_bytes(&format!("{base}/source/reference_{view}.png")).await{
                Ok(bytes)=>{
                    let bytes=crate::tripo::reference_png(&bytes).map_err(|e|bad(format!("{view}参考图：{e}")))?;
                    images.push((view.to_string(),bytes));
                },
                Err(_) if view=="front"=>return Err(bad("请先上传正面参考图")),
                Err(_)=>{},
            }
        }
        if req.mode=="multi" && images.len()<2 {return Err(bad("多视图需要正面及至少一个其他视角"));}
    }
    let job=ops::next_job(&st,&base,"model_build",json!({"provider":"tripo","status":"running","started_at":ops::now_epoch(),
        "model":client.model(),"model_id":req.model_id,"service_base_url":base_url,"request":req,
        "stage":"prepared","progress":{"phase":"准备参考图","percent":0}})).await?;
    // Snapshot everything before any supplier request. A failed snapshot cannot charge.
    for (view,bytes) in &images {
        if let Err(e)=st.store.put_bytes(&format!("{base}/jobs/{job}/reference_{view}.png"),bytes).await {
            let _=patch(&st,&base,&job,json!({"status":"failed","error":"保存输入失败，未提交 Tripo","finished_at":ops::now_epoch()})).await;
            return Err(storage(e));
        }
    }
    patch(&st,&base,&job,json!({})).await.map_err(storage)?;
    let accepted=json!({"job_id":job,"asset_id":id,"status":"running","provider":"tripo","accepted":true});
    tokio::spawn(async move{
        let _permit=permit;
        let submission:Result<String,String>=async{
            let balance=client.balance().await?;
            if balance["balance"].as_f64().is_some_and(|n| n<=0.0) {
                return Err("Tripo API 可用额度为 0，请在 Tripo 开发者平台补充额度后重新生成；本次未提交生成请求".into());
            }
            let mut files=Vec::new();
            for (view,bytes) in images {
                patch(&st,&base,&job,json!({"stage":"uploading","progress":{"phase":"上传参考图到 Tripo","percent":3}})).await?;
                let token=client.upload(bytes,&format!("{view}.png")).await?;
                files.push((view,token));
            }
            let (route,payload)=req.payload(client.model(),&files)?;
            patch(&st,&base,&job,json!({"stage":"submitting","progress":{"phase":"提交 Tripo 生成任务","percent":5}})).await?;
            // Exactly one paid POST; an ambiguous response must never trigger a second POST.
            let task_id=client.create(&route,&payload).await?;
            patch(&st,&base,&job,json!({"provider_task_id":task_id,"stage":"polling"})).await?;
            Ok(task_id)
        }.await;
        match submission {
            Ok(task_id)=>finish_poll(st,base,job,asset,client,task_id).await,
            Err(error)=>{
                let record=st.store.get_json(&format!("{base}/jobs/{job}.json")).await.unwrap_or(json!({}));
                let uncertain=record["stage"]=="submitting" && !error.starts_with("Tripo HTTP 4") && !error.starts_with("Tripo HTTP 200 / code");
                let _=patch(&st,&base,&job,json!({"status":if uncertain{"unknown"}else{"failed"},"error":format!("{error}；未自动重试"),"finished_at":ops::now_epoch()})).await;
            }
        }
    });
    Ok((StatusCode::ACCEPTED,Json(accepted)))
}

/// Meshy 生成：任务语义与 Tripo 相同（一次提交 → 轮询 → 落盘），
/// 但提交体与状态机按 Meshy 官方 API 来（docs/PROVIDERS.md）。
/// Meshy 目前只做 文字 / 单图 两种模式；多视图与其多图能力对不上，明确拒绝而不是静默降级。
async fn generate_meshy(st:Shared,dir:String,id:String,req:Generate,service:crate::services::Service)->ResultApi{
    if !matches!(req.mode.as_str(),"text"|"single") {
        return Err(bad("Meshy 通道目前支持文字与单图建模；多视图请在模型配置中选择 Tripo"));
    }
    if req.mode=="text" && (req.prompt.trim().is_empty() || req.prompt.chars().count()>1024) {
        return Err(bad("文字建模描述需为 1–1024 字"));
    }
    let base_url=service.base_url.clone();
    let image_mode=req.mode!="text";
    let client=crate::meshy::Client::new(service,image_mode).map_err(bad)?;
    let (base,asset,_,_)=ops::load(&st,&dir,&id).await?;
    if let Some(expected)=req.expected_history_node_id.as_deref(){
        if let Some(result)=crate::history::check_stale_head(&st.store,&base,expected).await{return Ok(result);}
    }
    let permit=ops::MODEL_GATE.try_acquire().map_err(|_|(StatusCode::CONFLICT,"已有模型任务在运行，请等任务完成".into()))?;
    if ops::has_active_model_job(&st,&base).await{return Err((StatusCode::CONFLICT,"该资产仍有未确认的模型任务，请先查看任务记录并查询原任务".into()));}
    let mut images=Vec::new();
    if image_mode {
        match st.store.get_bytes(&format!("{base}/source/reference_front.png")).await{
            Ok(bytes)=>{
                let bytes=crate::tripo::reference_png(&bytes).map_err(|e|bad(format!("front参考图：{e}")))?;
                images.push(bytes);
            },
            Err(_)=>return Err(bad("请先上传正面参考图")),
        }
    }
    let job=ops::next_job(&st,&base,"model_build",json!({"provider":"meshy","status":"running","started_at":ops::now_epoch(),
        "model":client.model(),"model_id":req.model_id,"service_base_url":base_url,"request":req,
        "stage":"prepared","progress":{"phase":"准备参考图","percent":0}})).await?;
    for (i,bytes) in images.iter().enumerate(){
        if let Err(e)=st.store.put_bytes(&format!("{base}/jobs/{job}/reference_front_{i}.png"),bytes).await {
            let _=patch(&st,&base,&job,json!({"status":"failed","error":"保存输入失败，未提交 Meshy","finished_at":ops::now_epoch()})).await;
            return Err(storage(e));
        }
    }
    patch(&st,&base,&job,json!({})).await.map_err(storage)?;
    let accepted=json!({"job_id":job,"asset_id":id,"status":"running","provider":"meshy","accepted":true});
    tokio::spawn(async move{
        let _permit=permit;
        let submission:Result<String,String>=async{
            patch(&st,&base,&job,json!({"stage":"submitting","progress":{"phase":"提交 Meshy 生成任务","percent":5}})).await?;
            // 唯一一次付费 POST；语义不明的响应绝不触发第二次提交
            let task_id=if image_mode{
                use base64::Engine as _;
                let b64=base64::engine::general_purpose::STANDARD.encode(&images.remove(0));
                client.create_image(&b64,&req.prompt).await?
            }else{
                client.create_text(req.prompt.trim(),req.pbr).await?
            };
            patch(&st,&base,&job,json!({"provider_task_id":task_id,"stage":"polling"})).await?;
            Ok(task_id)
        }.await;
        match submission{
            Ok(task_id)=>finish_poll_meshy(st,base,job,asset,client,task_id).await,
            Err(error)=>{
                let record=st.store.get_json(&format!("{base}/jobs/{job}.json")).await.unwrap_or(json!({}));
                let uncertain=record["stage"]=="submitting" && !error.starts_with("Meshy HTTP 4");
                let _=patch(&st,&base,&job,json!({"status":if uncertain{"unknown"}else{"failed"},"error":format!("{error}；未自动重试"),"finished_at":ops::now_epoch()})).await;
            }
        }
    });
    Ok((StatusCode::ACCEPTED,Json(accepted)))
}

async fn finish_poll_meshy(st:Shared,base:String,job:String,asset:Value,client:crate::meshy::Client,task_id:String){
    let result=tokio::time::timeout(crate::meshy::TASK_TIMEOUT,async{
        if let Ok(glb)=st.store.get_bytes(&format!("{base}/jobs/{job}/result.glb")).await {
            commit_result(&st,&base,&job,&asset,&task_id,&glb,None,Some("已恢复本地模型；可在工作台保存当前视角".into())).await?;
            return Ok::<(),String>(());
        }
        loop{
            let data=client.task(&task_id).await?;
            let remote=data["status"].as_str().unwrap_or("");
            let state=crate::meshy::normalize_status(remote);
            if state=="failed"{
                let error=client_clean(&client,&data);
                patch(&st,&base,&job,json!({"status":"failed","provider_status":remote,"error":error,
                    "credits_consumed":data["consumed_credits"],"finished_at":ops::now_epoch()})).await?;
                return Ok(());
            }
            if state=="success"{
                patch(&st,&base,&job,json!({"stage":"downloading","provider_status":remote,"credits_consumed":data["consumed_credits"],
                    "progress":{"phase":"保存模型与预览","percent":95}})).await?;
                let url=data["model_urls"]["glb"].as_str().or(data["model_url"].as_str()).ok_or("Meshy 成功响应没有 GLB 链接")?;
                let glb=client.download(url,150*1024*1024).await?;
                st.store.put_bytes(&format!("{base}/jobs/{job}/result.glb"),&glb).await?;
                let mut preview=None;
                let mut warning=None;
                if let Some(url)=data["thumbnail_url"].as_str(){
                    match client.download(url,20*1024*1024).await{
                        Ok(bytes)=>match image::load_from_memory(&bytes){
                            Ok(img)=>{
                                let mut output=std::io::Cursor::new(Vec::new());
                                if img.thumbnail(640,640).write_to(&mut output,image::ImageFormat::Png).is_ok(){preview=Some(output.into_inner());}
                            },
                            Err(_)=>warning=Some("供应商预览图片无效，可在工作台保存当前模型视角".to_string()),
                        },
                        Err(_)=>warning=Some("预览下载失败；模型已保存，可在工作台保存当前视角".to_string()),
                    }
                }
                commit_result(&st,&base,&job,&asset,&task_id,&glb,preview,warning).await?;
                return Ok(());
            }
            let percent=5+data["progress"].as_u64().unwrap_or(0).min(100)*89/100;
            patch(&st,&base,&job,json!({"status":"running","stage":"polling","provider_status":remote,"last_checked_at":ops::now_epoch(),
                "progress":{"phase":"Meshy 生成中","percent":percent}})).await?;
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }).await.unwrap_or_else(|_|Err("等待 Meshy 超过 30 分钟，请查询原任务结果".into()));
    if let Err(error)=result{
        let _=patch(&st,&base,&job,json!({"status":"waiting","error":error,"resumable":true,
            "progress":{"phase":"连接或保存中断，可查询原任务","percent":0}})).await;
    }
}

/// Meshy 失败详情：task_error.message 优先，且绝不带出 Key。
fn client_clean(_client:&crate::meshy::Client,data:&Value)->String{
    data["task_error"]["message"].as_str().unwrap_or("Meshy 生成失败或取消").chars().filter(|c| !c.is_control()).take(400).collect()
}

async fn finish_poll(st:Shared,base:String,job:String,asset:Value,client:Client,task_id:String){
    let result=tokio::time::timeout(Duration::from_secs(1800),async{
        if let Ok(glb)=st.store.get_bytes(&format!("{base}/jobs/{job}/result.glb")).await {
            commit_result(&st,&base,&job,&asset,&task_id,&glb,None,Some("已恢复本地模型；可在工作台保存当前视角".into())).await?;
            return Ok::<(),String>(());
        }
        loop{
            let data=client.task(&task_id).await?;
            let remote=data["status"].as_str().ok_or("Tripo 未返回任务状态")?;
            if matches!(remote,"failed"|"cancelled"){
                let error=client.clean(data["error_message"].as_str().unwrap_or("Tripo 生成失败或取消"));
                patch(&st,&base,&job,json!({"status":"failed","provider_status":remote,"error":error,"error_code":data["error_code"],
                    "credits_consumed":data["credits_consumed"],"finished_at":ops::now_epoch()})).await?;
                return Ok::<(),String>(());
            }
            if remote=="success"{
                patch(&st,&base,&job,json!({"stage":"downloading","provider_status":remote,"credits_consumed":data["credits_consumed"],
                    "progress":{"phase":"保存模型与预览","percent":95}})).await?;
                let glb=client.download(data["output"]["model_url"].as_str().ok_or("Tripo 成功响应没有 model_url")?,150*1024*1024).await?;
                // Persist downloaded bytes immediately; links expire after five minutes.
                st.store.put_bytes(&format!("{base}/jobs/{job}/result.glb"),&glb).await?;
                let mut preview=None;
                let mut warning=None;
                if let Some(url)=data["output"]["rendered_image_url"].as_str(){
                    match client.download(url,20*1024*1024).await {
                        Ok(bytes)=>{
                            match image::load_from_memory(&bytes){
                                Ok(img)=>{
                                    let mut output=std::io::Cursor::new(Vec::new());
                                    if img.thumbnail(640,640).write_to(&mut output,image::ImageFormat::Png).is_ok(){preview=Some(output.into_inner());}
                                },Err(_)=>warning=Some("供应商预览图片无效，可在工作台保存当前模型视角".to_string())
                            }
                        },Err(_)=>warning=Some("预览下载失败；模型已保存，可在工作台保存当前视角".to_string())
                    }
                }
                commit_result(&st,&base,&job,&asset,&task_id,&glb,preview,warning).await?;
                return Ok(());
            }
            if !["queued","running"].contains(&remote){return Err("Tripo 返回未识别状态，请查询原任务".into());}
            let percent=5+data["progress"].as_u64().unwrap_or(0).min(100)*89/100;
            patch(&st,&base,&job,json!({"status":"running","stage":"polling","provider_status":remote,"last_checked_at":ops::now_epoch(),
                "progress":{"phase":if remote=="queued"{"Tripo 排队中"}else{"Tripo 生成中"},"percent":percent}})).await?;
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }).await.unwrap_or_else(|_|Err("等待 Tripo 超过 30 分钟，请查询原任务结果".into()));
    if let Err(error)=result{
        let _=patch(&st,&base,&job,json!({"status":"waiting","error":error,"resumable":true,
            "progress":{"phase":"连接或保存中断，可查询原任务","percent":0}})).await;
    }
}

pub(crate) async fn commit_result(st:&Shared,base:&str,job:&str,asset:&Value,task_id:&str,glb:&[u8],preview:Option<Vec<u8>>,warning:Option<String>)->Result<(),String>{
    let check=validator::validate_glb(glb,None);
    if !check.ok{return Err(format!("Tripo 模型校验失败：{}",check.errors.join("; ")));}
    let record=st.store.get_json(&format!("{base}/jobs/{job}.json")).await?;
    let ver=ops::store_version(&st.store,base,asset,glb,json!({"provider":record["provider"],"operation":"generate",
        "method":record["provider"],"source_job_id":job,"provider_task_id":task_id,"model":record["model"],
        "request":record["request"],"credits_consumed":record["credits_consumed"],"preview_warning":warning}),&check).await?;
    if let Some(png)=preview{
        st.store.put_bytes(&format!("{base}/versions/{ver}/preview.png"),&png).await?;
        let mut a=st.store.get_json(&format!("{base}/asset.json")).await?;
        a["preview"]=json!({"image":"preview.png","path":format!("versions/{ver}/preview.png")});
        st.store.put_json(&format!("{base}/asset.json"),&a).await?;
    }
    patch(st,base,job,json!({"status":"done","stage":"done","version":ver,"resumable":false,"error":null,
        "finished_at":ops::now_epoch(),"bytes":glb.len(),"validation":{"ok":check.ok,"triangles":check.triangles,"vertices":check.vertices},
        "progress":{"phase":"模型已保存","percent":100}})).await
}

pub async fn resume(State(st):State<Shared>,Path((dir,id,job)):Path<(String,String,String)>)->ResultApi{
    valid_asset(&dir,&id)?;crate::tripo::valid_id(&job).map_err(bad)?;
    let (base,asset,_,_)=ops::load(&st,&dir,&id).await?;
    let record=st.store.get_json(&format!("{base}/jobs/{job}.json")).await.map_err(|_|bad("任务不存在"))?;
    if record["provider"]=="tripo_studio"{return crate::studio_jobs::resume(State(st),Path((dir,id,job))).await;}
    if record["provider"]=="meshy"{
        if record["status"]=="done"{return Ok((StatusCode::OK,Json(record)));}
        if record["status"]=="failed" {return Err(bad("供应商已确认失败，不能恢复该任务"));}
        let task_id=record["provider_task_id"].as_str().ok_or_else(||bad("未取得 Meshy 任务编号；请先到 Meshy 控制台核对是否已创建，避免重复计费"))?.to_string();
        let permit=ops::MODEL_GATE.try_acquire().map_err(|_|(StatusCode::CONFLICT,"已有模型任务在查询，请稍后查看".into()))?;
        let settings=services::snapshot(&st.cfg).map_err(storage)?;
        let (_,service)=settings.model3d_route(record["model_id"].as_str()).map_err(bad)?;
        if service.base_url!=record["service_base_url"].as_str().unwrap_or(""){return Err(bad("该任务的 Meshy 接入地址已改变，请恢复原接入后查询"));}
        let image_mode=record["request"]["mode"].as_str().is_some_and(|m|m!="text");
        let client=crate::meshy::Client::new(service,image_mode).map_err(bad)?;
        patch(&st,&base,&job,json!({"status":"running","error":null,"progress":{"phase":"查询原 Meshy 任务","percent":5}})).await.map_err(storage)?;
        let response=json!({"status":"running","job_id":job,"provider_task_id":task_id});
        tokio::spawn(async move{let _permit=permit;finish_poll_meshy(st,base,job,asset,client,task_id).await;});
        return Ok((StatusCode::ACCEPTED,Json(response)));
    }
    if record["provider"]!="tripo"{return Err(bad("不是 Tripo 任务"));}
    if record["status"]=="done"{return Ok((StatusCode::OK,Json(record)));}
    if record["status"]=="failed" {return Err(bad("供应商已确认失败，不能恢复该任务"));}
    let task_id=record["provider_task_id"].as_str().ok_or_else(||bad("未取得 Tripo 任务编号；请先到 Tripo 控制台核对是否已创建，避免重复计费"))?.to_string();
    let permit=ops::MODEL_GATE.try_acquire().map_err(|_|(StatusCode::CONFLICT,"已有模型任务正在查询，请稍后查看".into()))?;
    let settings=services::snapshot(&st.cfg).map_err(storage)?;
    let service=settings.tripo_service(record["model_id"].as_str()).map_err(bad)?;
    if service.base_url!=record["service_base_url"].as_str().unwrap_or(""){return Err(bad("该任务的 Tripo 接入地址已改变，请恢复原接入后查询"));}
    let client=Client::new(service).map_err(bad)?;
    patch(&st,&base,&job,json!({"status":"running","error":null,"progress":{"phase":"查询原 Tripo 任务","percent":5}})).await.map_err(storage)?;
    let response=json!({"status":"running","job_id":job,"provider_task_id":task_id});
    tokio::spawn(async move{let _permit=permit;finish_poll(st,base,job,asset,client,task_id).await;});
    Ok((StatusCode::ACCEPTED,Json(response)))
}

/// Restart recovery marks interrupted jobs; manual resume performs GET only.
pub async fn recover(st:Shared){
    let cutoff=ops::now_epoch();
    for dir in CATEGORIES{
        for id in st.store.list_dirs(&format!("{dir}/")).await.unwrap_or_default(){
            let base=format!("{dir}/{id}");
            for file in st.store.list_files(&format!("{base}/jobs/")).await.unwrap_or_default(){
                let Ok(r)=st.store.get_json(&format!("{base}/jobs/{file}")).await else{continue};
                if !["tripo","tripo_studio","meshy"].contains(&r["provider"].as_str().unwrap_or("")) || r["status"]!="running" || r["started_at"].as_u64().unwrap_or(u64::MAX)>=cutoff {continue;}
                let job=file.trim_end_matches(".json").to_string();
                // User can resume waiting jobs explicitly; startup just makes interrupted work visible.
                let has_task=r["provider_task_id"].is_string() || r["runner_id"].is_string();
                let _=patch(&st,&base,&job,json!({"status":if has_task{"waiting"}else{"unknown"},"resumable":has_task,
                    "error":if has_task{"服务已重启，请查询原 Tripo 任务；不会重新生成"}else{"服务重启前提交结果未确认，请在 Tripo 控制台核对"}})).await;
            }
        }
    }
}
