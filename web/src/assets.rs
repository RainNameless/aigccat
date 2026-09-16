//! 资产 API：创建（AI 自动分类 + spec 落 MinIO + 成本账本）、列表、详情
//!
//! asset_id 规则：<类型前缀>_<英文slug>_<三位序号>，如 chr_girl_001
//! job 规则：每资产顺序编号 job_001/job_002/...，成本写入 job json（KICKOFF 阶段 2 验收项）

use crate::openai::{self, Usage};
use crate::store::Store;
use axum::{extract::{Path, State}, http::StatusCode, response::Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// asset_type → (id 前缀, MinIO 复数目录)
pub fn category_info(t: &str) -> Option<(&'static str, &'static str)> {
    Some(match t {
        "character" => ("chr", "characters"),
        "animal" => ("anm", "animals"),
        "prop" => ("prp", "props"),
        "building" => ("bld", "buildings"),
        "environment" => ("env", "environments"),
        "vegetation" => ("veg", "vegetation"),
        "ground" => ("grd", "grounds"),
        "sky" => ("sky", "skies"),
        "vehicle" => ("veh", "vehicles"),
        "apparel" => ("app", "apparel"),
        "material" => ("mat", "materials"),
        "effect" => ("efx", "effects"),
        _ => return None,
    })
}

pub const CATEGORIES: [&str; 12] = [
    "characters", "animals", "props", "buildings", "environments", "vegetation",
    "grounds", "skies", "vehicles", "materials", "effects", "apparel",
];

fn now_epoch() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn slug(s: &str, fallback: &str) -> String {
    let mut out = String::new();
    for w in s.split(|c: char| !c.is_ascii_alphanumeric()) {
        if w.is_empty() {
            continue;
        }
        let candidate = if out.is_empty() { w.to_string() } else { format!("{out}_{w}") };
        if candidate.len() > 16 {
            break; // 词边界截断，不切半个词
        }
        out = candidate.to_ascii_lowercase();
    }
    let out = out.trim_matches('_').to_string();
    if out.is_empty() { fallback.to_string() } else { out }
}

pub struct AppState {
    pub cfg: crate::config::AppConfig,
    pub store: Store,
}

type Shared = Arc<AppState>;
type ApiResult<T> = Result<T, (StatusCode, String)>;

fn err500(msg: impl Into<String>) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, msg.into())
}

#[derive(Deserialize)]
pub struct CreateAssetReq {
    description: String,
    name: Option<String>,
    asset_type: Option<String>,
    style: Option<String>,
    height_m: Option<f64>,
    extra: Option<String>,
    /// Tripo creation needs only a saved input, not a paid LLM description pass.
    #[serde(default)]
    draft: bool,
}

pub async fn create_asset(
    State(st): State<Shared>,
    Json(req): Json<CreateAssetReq>,
) -> ApiResult<Json<Value>> {
    if req.description.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "description 不能为空".into()));
    }
    // 组装提示约束（用户显式指定的类型优先 → 自动分类 confidence=1.0）
    let mut hints = Vec::new();
    if let Some(t) = &req.asset_type {
        if category_info(t).is_none() {
            return Err((StatusCode::BAD_REQUEST, format!("非法 asset_type: {t}")));
        }
        hints.push(format!("asset_type must be {t}"));
    }
    if let Some(s) = &req.style { hints.push(format!("style: {s}")); }
    if let Some(h) = req.height_m { hints.push(format!("height_m: {h}")); }
    if let Some(n) = &req.name { hints.push(format!("preferred name: {n}")); }
    if let Some(e) = &req.extra { hints.push(e.clone()); }

    // 预算熔断：超过 COST_BUDGET_TOKENS 直接拒绝（KICKOFF 9：成本账本 + 熔断）
    let out = if req.draft {
        openai::SpecOutput {
            spec: json!({"asset_type":req.asset_type.as_deref().unwrap_or("prop"),
                "name":req.name.clone().unwrap_or_else(||req.description.chars().take(40).collect()),
                "description":req.description,"style":req.style,"attributes":{},
                "model_requirements":{},"classification_source":"user"}),
            usage:None, model:"none".into(),
        }
    } else {
        crate::ops::budget_check(&st).await?;
        openai::generate_spec(&st.cfg, &req.description, &hints.join("; ")).await.map_err(err500)?
    };
    if let Some(u) = out.usage {
        crate::ops::ledger_add(&st, u.total_tokens).await;
    }

    let asset_type = out.spec["asset_type"].as_str().unwrap_or("").to_string();
    let (prefix, dir) = category_info(&asset_type).ok_or_else(|| err500("bad asset_type"))?;

    // 序号 = 当前类目下资产数 + 1（并发=1，无竞争）
    static CREATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = CREATE_LOCK.lock().await;
    let existing = st.store.list_dirs(&format!("{dir}/")).await.map_err(err500)?;
    let seq = existing.len() + 1;
    // 命名 slug：优先英文名（中文名会退化成占位词，仅在英文名也缺失时用）
    let from_name = req.name.as_deref().map(|n| slug(n, "asset"));
    let from_en = out.spec["name_en"].as_str().map(|n| slug(n, "asset"));
    let name_slug = match (from_name, from_en) {
        (Some(a), Some(b)) if a == "asset" => b,
        (Some(a), _) => a,
        (None, Some(b)) => b,
        (None, None) => "asset".into(),
    };
    let mut seq = seq;
    let mut asset_id = format!("{prefix}_{name_slug}_{seq:03}");
    while existing.contains(&asset_id) { seq+=1; asset_id=format!("{prefix}_{name_slug}_{seq:03}"); }
    let base = format!("{dir}/{asset_id}");
    let now = now_epoch();

    // 1) spec（含 asset_id 回填）
    let mut spec = out.spec.clone();
    spec["asset_id"] = json!(asset_id);
    spec["name"] = json!(req.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&asset_id));
    st.store.put_json(&format!("{base}/source/spec.json"), &spec).await.map_err(err500)?;

    // 2) Asset Contract（骨架，模型版本待阶段 4 填充）
    let contract = json!({
        "schema": "game.asset", "schema_version": "1.0",
        "asset_id": asset_id, "asset_type": asset_type, "version": null,
        "status": "spec_ready",
        "name": spec["name"], "created_at": now,
        "model": null, "rig": spec["model_requirements"]["rig"],
        "preview": null, "anchor_of": null, "variant_distance": null
    });
    st.store.put_json(&format!("{base}/asset.json"), &contract).await.map_err(err500)?;

    // 3) 版本三态指针
    let latest = json!({ "latest": null, "approved": null, "published": null });
    st.store.put_json(&format!("{base}/latest.json"), &latest).await.map_err(err500)?;

    // 图片由用户手动生成，创建 Spec 不调用收费图像服务。

    // 5) job + 成本账本
    let usage: Option<Usage> = out.usage;
    let job = json!({
        "job_id": "job_001", "asset_id": asset_id, "kind": if req.draft {"asset_create"} else {"spec_generate"},
        "status": "done", "created_at": now,
        "steps": [{ "name": "spec_generating", "status": "done", "at": now }],
        "cost": {
            "api": if req.draft {"none"} else {"openai-chat"}, "model": out.model,
            "prompt_tokens": usage.map(|u| u.prompt_tokens),
            "completion_tokens": usage.map(|u| u.completion_tokens),
            "total_tokens": usage.map(|u| u.total_tokens)
        }
    });
    st.store.put_json(&format!("{base}/jobs/job_001.json"), &job).await.map_err(err500)?;
    tracing::info!(%asset_id, %asset_type, "asset spec created");
    Ok(Json(json!({
        "asset_id": asset_id, "asset_type": asset_type,
        "type_confidence": spec["type_confidence"], "name": spec["name"],
        "status": "spec_ready", "job_id": "job_001",
        "cost": job["cost"]
    })))
}

pub async fn list_assets(State(st): State<Shared>) -> ApiResult<Json<Value>> {
    let mut items = Vec::new();
    for dir in CATEGORIES {
        let ids = st.store.list_dirs(&format!("{dir}/")).await.map_err(err500)?;
        for id in ids {
            if let Ok(a) = st.store.get_json(&format!("{dir}/{id}/asset.json")).await {
                let image_activity = st.store.get_json(&format!("{dir}/{id}/image_activity.json")).await.unwrap_or(Value::Null);
                let model_activity = st.store.get_json(&format!("{dir}/{id}/model_activity.json")).await.unwrap_or(Value::Null);
                let flow_activity = st.store.get_json(&format!("{dir}/{id}/source/studio_flow_activity.json")).await.unwrap_or(Value::Null);
                let activity = if model_activity["created_at"].as_u64().unwrap_or(0)>=image_activity["created_at"].as_u64().unwrap_or(0) { model_activity } else { image_activity };
                let activity = if flow_activity["created_at"].as_u64().unwrap_or(0) > activity["created_at"].as_u64().unwrap_or(0) { flow_activity } else { activity };
                let labels = st.store.get_json(&format!("{dir}/{id}/source/tags.json")).await.unwrap_or(json!({"tags":[]}));
                let preview = a["preview"]["path"].as_str().map(str::to_owned)
                    .or_else(|| activity["images"].as_array().and_then(|images| images.last()).and_then(Value::as_str).map(str::to_owned));
                items.push(json!({
                    "asset_id": id,
                    "asset_type": a["asset_type"],
                    "name": a["name"],
                    "tags": labels["tags"],
                    "status": a["status"],
                    "version": a["version"],
                    "preview": preview,
                    "generation": activity,
                    "created_at": a["created_at"],
                }));
            }
        }
    }
    items.sort_by_key(|i| i["created_at"].as_u64().unwrap_or(0));
    items.reverse();
    Ok(Json(json!({ "assets": items, "count": items.len() })))
}

pub async fn get_asset(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    if !CATEGORIES.contains(&dir.as_str()) {
        return Err((StatusCode::BAD_REQUEST, format!("非法类目: {dir}")));
    }
    let base = format!("{dir}/{id}");
    // 读取前统一判定：超过 15 分钟无结果的 running 任务标记 failed，避免前端永远看到处理中
    crate::ops::sweep_stale_jobs(&st, &base).await;
    let asset = st.store.get_json(&format!("{base}/asset.json")).await.map_err(err500)?;
    let spec = st.store.get_json(&format!("{base}/source/spec.json")).await.unwrap_or(Value::Null);
    let latest = st.store.get_json(&format!("{base}/latest.json")).await.unwrap_or(Value::Null);
    let jobs = st.store.list_files(&format!("{base}/jobs/")).await.unwrap_or_default();
    let flow_activity = st.store.get_json(&format!("{base}/source/studio_flow_activity.json")).await.unwrap_or(Value::Null);
    Ok(Json(json!({ "asset": asset, "spec": spec, "latest": latest, "jobs": jobs, "flow_activity": flow_activity })))
}
