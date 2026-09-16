use axum::{extract::{Path, State}, http::StatusCode, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use crate::{assets::{AppState, CATEGORIES}, ops};

type Shared = Arc<AppState>;
type ResultJson = Result<Json<Value>, (StatusCode, String)>;
static STATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static IMAGE_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
static IMAGE_ACTIVITY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) async fn record_image_activity(store: &crate::store::Store, base: &str, job: &Value) {
    if job["kind"] != "image_generate" { return; }
    let _guard = IMAGE_ACTIVITY_LOCK.lock().await;
    let path = format!("{base}/image_activity.json");
    let previous = store.get_json(&path).await.unwrap_or(Value::Null);
    let sequence = |v: &Value| v["job_id"].as_str().and_then(|s| s.strip_prefix("job_")).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    if sequence(&previous) > sequence(job) { return; }
    if let Err(error) = store.put_json(&path, job).await {
        tracing::warn!(%error, "image activity summary could not be saved");
    }
}

fn valid_image_size(size: &str) -> bool {
    size.split_once('x').and_then(|(w,h)|Some((w.parse::<u32>().ok()?,h.parse::<u32>().ok()?)))
        .is_some_and(|(w,h)| (256..=4096).contains(&w) && (256..=4096).contains(&h) && w%8==0 && h%8==0)
}

pub async fn list_images(State(st): State<Shared>) -> ResultJson {
    let keys = st.store.image_keys().await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR,e))?;
    let images: Vec<Value> = keys.iter().filter_map(|key| {
        let mut parts = key.splitn(3, '/');
        let dir = parts.next()?;
        let id = parts.next()?;
        let path = parts.next()?;
        if !CATEGORIES.contains(&dir) || path == "source/preview_poster.png" { return None; }
        let kind = if path.starts_with("source/images/") { "generated" } else if path.starts_with("source/reference_") { "reference" } else { "uploaded" };
        Some(json!({"asset":format!("{dir}/{id}"),"path":path,"kind":kind}))
    }).collect();
    Ok(Json(json!({"images":images})))
}

pub async fn get_state(State(st): State<Shared>) -> ResultJson {
    Ok(Json(st.store.get_json("_studio/workbench.json").await.unwrap_or(json!({}))))
}

pub async fn put_state(State(st): State<Shared>, Json(mut patch): Json<Value>) -> ResultJson {
    let _guard = STATE_LOCK.lock().await;
    let object = patch.as_object().ok_or((StatusCode::BAD_REQUEST, "需要 JSON 对象".into()))?;
    if object.keys().any(|k| !matches!(k.as_str(), "creation" | "favorites" | "archived" | "settings" | "last_asset" | "archive_add" | "archive_remove" | "project_folders" | "asset_projects")) || patch.to_string().len() > 100_000 {
        return Err((StatusCode::BAD_REQUEST, "工作台配置字段无效或过大".into()));
    }
    if let Some(c) = patch.get("creation") {
        if !c.is_object() || c["allowMultiple"].as_bool().is_none()
            || !c["count"].as_u64().is_some_and(|n| (1..=4).contains(&n))
            || !c["ratio"].as_str().is_some_and(|r| ["1:1","16:9","9:16","4:3","3:4"].contains(&r)) {
            return Err((StatusCode::BAD_REQUEST,"创作设置无效".into()));
        }
    }
    if patch.get("archived").is_some() { return Err((StatusCode::CONFLICT,"页面版本已更新，请刷新后再操作回收站".into())); }
    let mut state = st.store.get_json("_studio/workbench.json").await.unwrap_or(json!({}));
    // Apply trash deltas under the lock; concurrent tabs cannot resurrect stale entries.
    if patch.get("archive_add").is_some() || patch.get("archive_remove").is_some() {
        let mut refs = state["archived"].as_array().cloned().unwrap_or_default();
        for key in ["archive_add", "archive_remove"] {
            if let Some(value) = patch.get(key) {
                let list = value.as_array().ok_or((StatusCode::BAD_REQUEST,"回收站操作必须是数组".into()))?;
                for item in list {
                    if !item.is_string() { return Err((StatusCode::BAD_REQUEST,"资产引用无效".into())); }
                    if key == "archive_add" { if !refs.contains(item) { refs.push(item.clone()); } }
                    else { refs.retain(|r|r!=item); }
                }
            }
        }
        patch["archived"] = json!(refs);
        patch.as_object_mut().unwrap().remove("archive_add");
        patch.as_object_mut().unwrap().remove("archive_remove");
    }
    for key in ["project_folders", "asset_projects"] {
        if let Some(value) = patch.get(key) {
            let entries = value.as_object().ok_or((StatusCode::BAD_REQUEST,"项目配置必须是对象".into()))?;
            for (id, name) in entries {
                if id.len()>160 || name.as_str().is_none_or(|n|n.len()>160 || n.chars().any(char::is_control)) {
                    return Err((StatusCode::BAD_REQUEST,"项目名称或引用无效".into()));
                }
            }
        }
    }
    for key in ["favorites", "archived"] {
        if let Some(value) = patch.get(key) {
            let list = value.as_array().ok_or((StatusCode::BAD_REQUEST,"收藏和回收站必须是数组".into()))?;
            for item in list {
                let reference = item.as_str().ok_or((StatusCode::BAD_REQUEST,"资产引用必须是字符串".into()))?;
                let (dir,id) = reference.split_once('/').ok_or((StatusCode::BAD_REQUEST,"资产引用无效".into()))?;
                if !CATEGORIES.contains(&dir) || id.is_empty() || id.contains('/') || id.contains("..") { return Err((StatusCode::BAD_REQUEST,"资产引用无效".into())); }
                if key == "archived" && !state[key].as_array().is_some_and(|old| old.contains(item)) {
                    let _latest = st.store.get_json(&format!("{reference}/latest.json")).await.map_err(|_| (StatusCode::NOT_FOUND,"资产不存在".into()))?;
                    // Trash only hides the asset; published versions and files remain restorable.
                }
            }
        }
    }
    if patch.get("settings").is_some_and(|v| !v.is_object()) || patch.get("last_asset").is_some_and(|v| !v.is_string()) {
        return Err((StatusCode::BAD_REQUEST,"设置数据类型无效".into()));
    }
    for (key, value) in patch.as_object().unwrap() {
        if key == "project_folders" || key == "asset_projects" {
            if !state[key].is_object() { state[key]=json!({}); }
            for (id,name) in value.as_object().unwrap() { state[key][id]=name.clone(); }
        } else { state[key] = value.clone(); }
    }
    st.store.put_json("_studio/workbench.json", &state).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR,e))?;
    Ok(Json(state))
}

const VIEW_ORDER: [(&str,&str);4] = [("front","正面"),("back","背面"),("side","左侧"),("right","右侧")];
fn view_prompt(subject: &str, view: &str) -> String {
    let direction=match view {
        "front"=>"FRONT view, facing directly toward camera",
        "back"=>"BACK view, facing directly away from camera; show the back of head and clothing, no face visible",
        "side"=>"LEFT side profile, camera on subject's left; nose points toward image left",
        _=>"RIGHT side profile, camera on subject's right; nose points toward image right",
    };
    format!("{subject}\nRender exactly ONE full subject in {direction}. This is one independent image, not a contact sheet. No collage, grid, split screen, multiple poses, text, labels or borders. Orthographic view, plain light gray background, full subject inside frame with margins. Keep identical anatomy, clothing, colors, materials, proportions and neutral pose as the supplied reference. Change camera direction only; do not copy the reference viewpoint. If a reference contains multiple views, render only the requested single view.")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageRequest {
    prompt: String,
    count: u32,
    size: String,
    model: Option<String>,
    model_id: Option<String>,
    #[serde(default)]
    reference: bool,
    #[serde(default)]
    four_views: bool,
}

pub async fn generate_images(State(st): State<Shared>, Path((dir,id)): Path<(String,String)>, Json(req): Json<ImageRequest>) -> ResultJson {
    if !CATEGORIES.contains(&dir.as_str()) || id.contains('/') || id.contains("..") || req.prompt.trim().is_empty() || req.prompt.len() > 20000 || !(1..=4).contains(&req.count)
        || !valid_image_size(&req.size) {
        return Err((StatusCode::BAD_REQUEST, "图片参数无效".into()));
    }
    ops::budget_check(&st).await?;
    let (base,_,_,_) = ops::load(&st,&dir,&id).await?;
    if ops::has_active_job(&st, &base, "image_generate").await {
        return Err((StatusCode::CONFLICT,"该资产已有图片任务生成中，请等待结果".into()));
    }
    let mut service = crate::services::snapshot(&st.cfg).and_then(|s| s.image_model(req.model_id.as_deref())).map_err(|e| (StatusCode::BAD_REQUEST,e))?;
    if let Some(model) = req.model.as_ref().filter(|s| req.model_id.is_none() && !s.trim().is_empty()) {
        if model.len() > 120 || model.chars().any(char::is_control) { return Err((StatusCode::BAD_REQUEST,"模型名称无效".into())); }
        service.model = model.clone();
    }
    if service.api_key.is_empty() { return Err((StatusCode::BAD_REQUEST,"请配置图像服务".into())); }
    let reference_file=if req.four_views {"input_reference.png"} else {"reference_front.png"};
    let reference = if req.reference { Some(st.store.get_bytes(&format!("{base}/source/{reference_file}")).await.map_err(|_| (StatusCode::BAD_REQUEST,"请先上传参考图".into()))?) } else { None };
    let permit = IMAGE_GATE.try_acquire().map_err(|_| (StatusCode::CONFLICT,"已有图片任务运行中".into()))?;
    let job = ops::next_job(&st,&base,"image_generate",json!({"status":"running","started_at":ops::now_epoch(),"model":service.model,"count":req.count,"size":req.size,"images":[],"api_calls":0,"prompt":req.prompt,"reference":req.reference,"four_views":req.four_views,"view_images":[]})).await?;
    let job_id = job.clone();
    tokio::spawn(async move {
        let _permit=permit;
        let mut images=Vec::<String>::new();
        let mut view_images=Vec::<Value>::new();
        let total=req.count * if req.four_views {4} else {1};
        let mut anchor=reference.clone();
        for i in 0..total {
            let view_index=if req.four_views {i%4} else {0};
            if view_index==0 { anchor=reference.clone(); }
            let (view,label)=VIEW_ORDER[view_index as usize];
            let prompt=if req.four_views { view_prompt(&req.prompt,view) } else {req.prompt.clone()};
            // Persist the impending call. No paid request is retried, including on partial failure.
            if ops::patch_job(&st,&base,&job,json!({"api_calls":i+1,"progress":{"percent":i*100/total,"phase":format!("生成第 {} 组 · {}",i/4+1,label)}})).await.is_err() { return; }
            let result = crate::imagegen::gen_image_options(&service,&prompt,Some(req.size.clone()),anchor.clone()).await;
            let result = match result {
                Ok(bytes) => {
                    if req.four_views && view_index==0 {anchor=Some(bytes.clone());}
                    let key=if req.four_views {format!("source/images/{job}_set{}_{}.png",i/4+1,view)} else {format!("source/images/{job}_{i}.png")};
                    st.store.put_bytes(&format!("{base}/{key}"),&bytes).await.map(|_|key)
                },
                Err(e) => Err(e),
            };
            match result {
                Ok(key) => {
                    images.push(key.clone());
                    if req.four_views {view_images.push(json!({"set":i/4+1,"view":view,"path":key}));}
                    let _=ops::patch_job(&st,&base,&job,json!({"images":images,"view_images":view_images,"progress":{"percent":((i+1)*100/total),"phase":format!("已生成 {} / {} 张",i+1,total)}})).await;
                },
                Err(error) => { let _=ops::patch_job(&st,&base,&job,json!({"status":"failed","error":error,"images":images,"view_images":view_images,"finished_at":ops::now_epoch()})).await; return; }
            }
        }
        let _=ops::patch_job(&st,&base,&job,json!({"status":"done","images":images,"view_images":view_images,"finished_at":ops::now_epoch()})).await;
    });
    Ok(Json(json!({"job_id":job_id,"status":"running"})))
}

#[cfg(test)]
mod tests {
    #[test]
    fn four_views_are_distinct_single_images() {
        let prompts:std::collections::HashSet<_>=super::VIEW_ORDER.iter().map(|(v,_)|super::view_prompt("same character",v)).collect();
        assert_eq!(prompts.len(),4);
        assert!(prompts.iter().all(|p|p.contains("exactly ONE") && p.contains("No collage")));
        let legacy:super::ImageRequest=serde_json::from_value(serde_json::json!({"prompt":"x","count":1,"size":"1920x1080"})).unwrap();
        assert!(!legacy.four_views);
    }
    #[test]
    fn dimensions_are_bounded_before_spending() {
        for size in ["512x512","1024x576","4096x2304","4096x4096"] { assert!(super::valid_image_size(size)); }
        for size in ["0x0","8192x4096","4096x4097","512x512x512","-512x512","NaNx512"] { assert!(!super::valid_image_size(size)); }
    }
}
