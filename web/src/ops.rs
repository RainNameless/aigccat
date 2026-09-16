//! 资产操作端点：三视图 → 审核点1 → 3D 模型 → 版本三态（批准/发布/回滚）→ 重分类
//! 状态机遵循 KICKOFF 5.4；成本预算熔断：COST_BUDGET_TOKENS（默认 200000）

use crate::assets::{category_info, AppState, CATEGORIES};
use crate::config::AppConfig;
use crate::imagegen;
use crate::store::Store;
use crate::validator;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Json, Response},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type Shared = Arc<AppState>;
type ApiResult<T> = Result<T, (StatusCode, String)>;

pub fn now_epoch() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
fn e500(m: impl Into<String>) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, m.into())
}
fn e400(m: impl Into<String>) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, m.into())
}
fn e409(m: impl Into<String>) -> (StatusCode, String) {
    (StatusCode::CONFLICT, m.into())
}

pub fn reject_stub_meta(meta: &Value) -> ApiResult<()> {
    let provider = meta["provider"].as_str().unwrap_or("").trim().to_ascii_lowercase();
    if provider.contains("stub") || matches!(provider.as_str(), "batch" | "placeholder") {
        return Err(e409("历史占位版本不能批准、发布或编译，请导入真实模型或使用已接入的真实引擎"));
    }
    Ok(())
}

pub async fn ensure_real_version(st: &Shared, base: &str, ver: &str) -> ApiResult<()> {
    let meta = st.store.get_json(&format!("{base}/versions/{ver}/meta.json")).await
        .map_err(|_| e409("无法读取版本元数据，拒绝批准、发布或编译"))?;
    reject_stub_meta(&meta)
}

fn check_dir(dir: &str) -> ApiResult<()> {
    if CATEGORIES.contains(&dir) {
        Ok(())
    } else {
        Err(e400(format!("非法类目: {dir}")))
    }
}

pub(crate) async fn load(st: &Shared, dir: &str, id: &str) -> ApiResult<(String, Value, Value, Value)> {
    let base = format!("{dir}/{id}");
    let asset = st
        .store
        .get_json(&format!("{base}/asset.json"))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("资产不存在: {id}")))?;
    let spec = st.store.get_json(&format!("{base}/source/spec.json")).await.unwrap_or(Value::Null);
    let latest = st.store.get_json(&format!("{base}/latest.json")).await.unwrap_or(json!({}));
    Ok((base, asset, spec, latest))
}

async fn set_status(st: &Shared, base: &str, mut asset: Value, status: &str) -> ApiResult<()> {
    asset["status"] = json!(status);
    st.store.put_json(&format!("{base}/asset.json"), &asset).await.map_err(e500)
}

/// 后台任务版本：只用 Store，不依赖请求上下文（客户端断开后仍可写回）
async fn set_status_with(store: &Store, base: &str, mut asset: Value, status: &str) -> Result<(), String> {
    asset["status"] = json!(status);
    store.put_json(&format!("{base}/asset.json"), &asset).await.map_err(|e| e)
}

static JOB_IDS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) async fn next_job(st: &Shared, base: &str, kind: &str, extra: Value) -> ApiResult<String> {
    let _guard = JOB_IDS.lock().await;
    let files = st.store.list_files(&format!("{base}/jobs/")).await.unwrap_or_default();
    let job_id = format!("job_{:03}", files.len() + 1);
    let mut job = json!({
        "job_id": job_id, "kind": kind, "status": "done", "created_at": now_epoch()
    });
    job.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    st.store
        .put_json(&format!("{base}/jobs/{job_id}.json"), &job)
        .await
        .map_err(e500)?;
    crate::workbench::record_image_activity(&st.store, base, &job).await;
    Ok(job_id)
}

/// 把字段合并进已有 job（running → done/failed、写进度与错误），不覆盖未提及的字段。
pub async fn patch_job(st: &Shared, base: &str, job_id: &str, patch: Value) -> Result<(), String> {
    patch_job_with(&st.store, base, job_id, patch).await
}

async fn patch_job_with(
    store: &Store,
    base: &str,
    job_id: &str,
    patch: Value,
) -> Result<(), String> {
    let path = format!("{base}/jobs/{job_id}.json");
    let mut job = store
        .get_json(&path)
        .await
        .unwrap_or_else(|_| json!({ "job_id": job_id }));
    if let (Some(obj), Some(patch)) = (job.as_object_mut(), patch.as_object()) {
        obj.extend(patch.clone());
    }
    store.put_json(&path, &job).await?;
    crate::workbench::record_image_activity(store, base, &job).await;
    Ok(())
}

// ---------- 预算账本 ----------

pub async fn ledger_add(st: &Shared, tokens: u64) {
    let key = "ledger/totals.json";
    let mut t = st.store.get_json(key).await.unwrap_or(json!({"total_tokens":0,"calls":0}));
    t["total_tokens"] = json!(t["total_tokens"].as_u64().unwrap_or(0) + tokens);
    t["calls"] = json!(t["calls"].as_u64().unwrap_or(0) + 1);
    let _ = st.store.put_json(key, &t).await;
}

pub async fn budget_check(st: &Shared) -> ApiResult<()> {
    let budget: u64 = std::env::var("COST_BUDGET_TOKENS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000);
    let t = st.store.get_json("ledger/totals.json").await.unwrap_or(json!({}));
    let used = t["total_tokens"].as_u64().unwrap_or(0);
    if used >= budget {
        return Err((StatusCode::PAYMENT_REQUIRED, format!("预算熔断：已用 {used} tokens ≥ 预算 {budget}")));
    }
    Ok(())
}

pub async fn get_ledger(State(st): State<Shared>) -> ApiResult<Json<Value>> {
    let t = st.store.get_json("ledger/totals.json").await.unwrap_or(json!({"total_tokens":0,"calls":0}));
    let budget: u64 = std::env::var("COST_BUDGET_TOKENS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000);
    Ok(Json(json!({ "ledger": t, "budget_tokens": budget })))
}

// ---------- 阶段 3：三视图 + 审核点 1 ----------

/// 同一进程内同时只允许一个参考图生成（进程级并发门）。
/// 真正的"是否还能提交"判定以 job 状态为准（见 has_active_reference_job），
/// permit 只防止同一瞬间两个请求都通过检查，随后台任务结束释放。
static REFERENCE_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
/// 后台任务整体超时（与原先同步等待的 550 秒预算一致）
const REFERENCE_TIMEOUT_SECS: u64 = 550;
/// running 且无 finished_at 超过该秒数 → 视为陈旧（进程重启/连接断开造成的孤儿任务）
const STALE_AFTER_SECS: u64 = 900;
const STALE_ERROR: &str = "stale: 任务超过15分钟无结果，已标记失败；可能已计费，请勿自动重试";
const TIMEOUT_ERROR: &str = "timeout: 参考图生成超时，可能已计费，请勿自动重试";
const VIEWS: [&str; 3] = ["front", "side", "back"];

/// 任务的有效起始时间（优先 started_at，回退 created_at）
fn job_started_at(job: &Value) -> u64 {
    job["started_at"].as_u64().or_else(|| job["created_at"].as_u64()).unwrap_or(0)
}

/// 参与陈旧回收的 job 类型：参考图生成 + 建模计划 + Blender 建模 / 减面重拓扑。
/// 建模计划是同步接口，但客户端断开会丢弃 handler，job 可能停在 running，
/// 因此它也要能被回收（15 分钟无结果即标记失败）。
const TRACKED_JOB_KINDS: [&str; 5] = ["reference_generate", "model_plan", "model_build", "model_process", "image_generate"];

/// 统一陈旧判定：running + 无 finished_at + 已超过 STALE_AFTER_SECS。
/// 这是"是否仍在有效运行"的唯一判定口径，提交前与读取 job 时都走这里。
fn is_stale_job(job: &Value, now: u64) -> bool {
    !["tripo","tripo_studio"].contains(&job["provider"].as_str().unwrap_or("")) && TRACKED_JOB_KINDS.contains(&job["kind"].as_str().unwrap_or(""))
        && job["status"].as_str() == Some("running")
        && job["finished_at"].as_u64().is_none()
        && now.saturating_sub(job_started_at(job)) > STALE_AFTER_SECS
}

/// 把该资产下所有陈旧的后台任务标记为 failed（不重启、不重试、不退款判断），
/// 使其不再占用并发门；返回被标记的任务数。
pub async fn sweep_stale_jobs(st: &Shared, base: &str) -> usize {
    let files = st.store.list_files(&format!("{base}/jobs/")).await.unwrap_or_default();
    let now = now_epoch();
    let mut swept = 0usize;
    for f in files {
        if !f.ends_with(".json") {
            continue;
        }
        let path = format!("{base}/jobs/{f}");
        let Ok(mut job) = st.store.get_json(&path).await else { continue; };
        if !is_stale_job(&job, now) {
            continue;
        }
        let elapsed = now.saturating_sub(job_started_at(&job));
        job["status"] = json!("failed");
        job["error"] = json!(STALE_ERROR);
        job["finished_at"] = json!(now);
        job["stale"] = json!(true);
        if st.store.put_json(&path, &job).await.is_ok() {
            crate::workbench::record_image_activity(&st.store, base, &job).await;
            swept += 1;
            tracing::warn!(asset_id = %base, job_id = %job["job_id"].as_str().unwrap_or("?"),
                kind = %job["kind"].as_str().unwrap_or("?"), elapsed_secs = elapsed,
                "background job stale, marked failed");
        }
    }
    swept
}

/// 提交前与读取时共用的判定：该资产是否还有「有效运行中」的指定类型任务。
/// 内部先做陈旧清理，因此陈旧任务不会永久占用并发门。
pub(crate) async fn has_active_job(st: &Shared, base: &str, kind: &str) -> bool {
    sweep_stale_jobs(st, base).await;
    for f in st.store.list_files(&format!("{base}/jobs/")).await.unwrap_or_default() {
        if !f.ends_with(".json") {
            continue;
        }
        let Ok(job) = st.store.get_json(&format!("{base}/jobs/{f}")).await else { continue; };
        if job["kind"].as_str() == Some(kind) && matches!(job["status"].as_str(), Some("running" | "waiting" | "unknown")) {
            return true;
        }
    }
    false
}

pub async fn has_active_reference_job(st: &Shared, base: &str) -> bool {
    has_active_job(st, base, "reference_generate").await
}

/// Blender 建模 / 减面重拓扑共用一个并发门，任一在运行都拒绝新提交。
pub(crate) async fn has_active_model_job(st: &Shared, base: &str) -> bool {
    has_active_job(st, base, "model_build").await || has_active_job(st, base, "model_process").await
}

fn progress_json(completed: u64, current: Option<&str>) -> Value {
    json!({"completed_views": completed, "total_views": VIEWS.len(), "current_view": current})
}

/// 后台执行参考图生成：逐视图记录进度与日志，客户端断开也继续跑完并落盘。
async fn run_reference_job(
    store: Store,
    cfg: AppConfig,
    base: String,
    job_id: String,
    asset_id: String,
    asset: Value,
    spec: Value,
) {
    let job_path = format!("{base}/jobs/{job_id}.json");
    let mut job = store.get_json(&job_path).await.unwrap_or_else(|_| json!({
        "job_id": job_id, "kind": "reference_generate", "status": "running"
    }));
    let description = spec["description_en"].as_str().unwrap_or("game asset").to_string();
    let style = spec["style"].as_str().unwrap_or("stylized").to_string();

    let mut completed = 0u64;
    let started = Instant::now();
    let result: Result<(), String> = tokio::time::timeout(Duration::from_secs(REFERENCE_TIMEOUT_SECS), async {
        for view in VIEWS {
            job["progress"] = progress_json(completed, Some(view));
            let _ = store.put_json(&job_path, &job).await;
            let t0 = Instant::now();
            tracing::info!(asset_id = %asset_id, job_id = %job_id, view = %view, "reference view start");
            match imagegen::generate_view(&cfg, view, &description, &style).await {
                Ok(bytes) => {
                    let elapsed_ms = t0.elapsed().as_millis() as u64;
                    let size = bytes.len();
                    store
                        .put_bytes(&format!("{base}/source/reference_{view}.png"), &bytes)
                        .await
                        .map_err(|_| "storage: 参考图存储失败".to_string())?;
                    completed += 1;
                    job["progress"] = progress_json(completed, None);
                    let _ = store.put_json(&job_path, &job).await;
                    tracing::info!(asset_id = %asset_id, job_id = %job_id, view = %view,
                        elapsed_ms = elapsed_ms, bytes = size, "reference view ok");
                }
                Err(error) => {
                    let elapsed_ms = t0.elapsed().as_millis() as u64;
                    // status 取自已分类错误串（check_response 写入的 "（HTTP n）"）
                    tracing::warn!(asset_id = %asset_id, job_id = %job_id, view = %view,
                        status = crate::services::error_status(&error), elapsed_ms = elapsed_ms,
                        error = %error, "reference view failed");
                    return Err(error);
                }
            }
        }
        let mut updated = asset.clone();
        updated["reference_provider"] = json!("openai_images");
        updated["preview"] = json!({"image":"reference_front.png","path":"source/reference_front.png"});
        set_status_with(&store, &base, updated, "reference_review")
            .await
            .map_err(|_| "storage: 无法保存参考图待确认状态".to_string())
    })
    .await
    .unwrap_or_else(|_| {
        tracing::warn!(asset_id = %asset_id, job_id = %job_id, elapsed_ms = started.elapsed().as_millis() as u64,
            error = %TIMEOUT_ERROR, "reference job timeout");
        Err(TIMEOUT_ERROR.to_string())
    });

    let total_ms = started.elapsed().as_millis() as u64;
    job["progress"] = progress_json(completed, None);
    job["finished_at"] = json!(now_epoch());
    match result {
        Ok(()) => {
            job["status"] = json!("done");
            tracing::info!(asset_id = %asset_id, job_id = %job_id, elapsed_ms = total_ms,
                completed_views = completed, "reference job done");
        }
        Err(error) => {
            job["status"] = json!("failed");
            job["error"] = json!(error);
            tracing::warn!(asset_id = %asset_id, job_id = %job_id, elapsed_ms = total_ms,
                status = crate::services::error_status(&error), completed_views = completed,
                error = %error, "reference job failed");
        }
    }
    if let Err(e) = store.put_json(&job_path, &job).await {
        tracing::error!(asset_id = %asset_id, job_id = %job_id, error = %e, "reference job result save failed");
    }
}

/// 创建 running job 并把生成放进后台任务，立即返回（202），不阻塞请求连接。
async fn start_reference_job(st: &Shared, dir: &str, id: &str) -> ApiResult<Value> {
    check_dir(dir)?;
    let (base, asset, spec, _l) = load(st, dir, id).await?;
    // 提交前统一判定：陈旧 running 先落 failed，避免孤儿任务永久占用并发门
    if has_active_reference_job(st, &base).await {
        return Err(e409("参考图生成进行中（任务仍在有效期内），本次未调用供应商，请勿重复提交"));
    }
    let permit = REFERENCE_GATE
        .try_acquire()
        .map_err(|_| e409("参考图生成进行中，本次未调用供应商，请勿重复提交"))?;
    let now = now_epoch();
    let job_id = next_job(st, &base, "reference_generate", json!({
        "provider": "openai_images", "status": "running",
        "started_at": now, "progress": progress_json(0, Some("front"))
    }))
    .await?;
    // 与 AppState 同源的克隆，客户端断开不影響后台执行
    let store = st.store.clone();
    let cfg = st.cfg.clone();
    let base_owned = base.clone();
    let job_owned = job_id.clone();
    let id_owned = id.to_string();
    tokio::spawn(async move {
        let _permit = permit; // 任务结束（成功/失败/超时）才释放
        run_reference_job(store, cfg, base_owned, job_owned, id_owned, asset, spec).await;
    });
    tracing::info!(asset_id = %id, job_id = %job_id, "reference job accepted");
    Ok(json!({
        "asset_id": id, "status": "running", "job_id": job_id,
        "provider": "openai_images", "auto_approved": false, "accepted": true,
        "progress": progress_json(0, Some("front")),
        "message": "参考图生成已在后台开始；请按 job_id 读取任务状态，本接口不会等待生成结束，也不会自动重试"
    }))
}

pub async fn gen_references(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let body = start_reference_job(&st, &dir, &id).await?;
    Ok((StatusCode::ACCEPTED, Json(body)))
}

/// 读取单个 job（读取时也走统一陈旧判定，前端不会看到永久 running）
pub async fn get_job(
    State(st): State<Shared>,
    Path((dir, id, job)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let base = format!("{dir}/{id}");
    sweep_stale_jobs(&st, &base).await;
    let file = if job.ends_with(".json") { job.clone() } else { format!("{job}.json") };
    let record = st
        .store
        .get_json(&format!("{base}/jobs/{file}"))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("任务不存在: {job}")))?;
    Ok(Json(record))
}

pub async fn approve_references(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let (base, asset, _s, _l) = load(&st, &dir, &id).await?;
    let front = st.store.get_bytes(&format!("{base}/source/reference_front.png")).await
        .map_err(|_| e409("没有正面参考图，不能批准"))?;
    if image::load_from_memory(&front).is_err() { return Err(e400("正面参考图无效")); }
    let job_id = next_job(&st, &base, "reference_approve", json!({})).await?;
    set_status(&st, &base, asset, "reference_approved").await?;
    Ok(Json(json!({"asset_id": id, "status": "reference_approved", "job_id": job_id})))
}

// ---------- 建模计划（视觉模型看图）→ Blender 工作器建模 / 减面 / 重拓扑 ----------

/// 建模计划参考图的候选文件名（顺序即发给视觉模型的顺序）
/// Blender 单次作业后台超时（与工作器内部超时对齐）
const MODEL_TIMEOUT_SECS: u64 = 900;
const MODEL_TIMEOUT_ERROR: &str = "timeout: 建模任务超时未返回结果（Blender 可能仍在执行，请勿重复提交）";
/// 同一时刻只允许一个 Blender 作业（工作器为单实例，串行排队更安全）
pub(crate) static MODEL_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

fn model_progress(phase: &str, percent: u64) -> Value {
    json!({ "phase": phase, "percent": percent })
}

/// 建模引擎前置检查：未配置 → 501；不可达 → 503。绝不落到任何占位/伪造路径。
async fn require_worker() -> ApiResult<()> {
    let status = crate::blender::status().await;
    if !status.configured {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            crate::blender::require_url().unwrap_err(),
        ));
    }
    if !status.reachable {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "blender_unreachable: 建模工作器不可达。请确认宿主机 scripts/blender/worker_server.py 正在运行，"
                .to_string()
                + "且容器能访问 BLENDER_WORKER_URL（默认 http://host.docker.internal:8788，"
                + "compose 需 extra_hosts: host.docker.internal:host-gateway）",
        ));
    }
    Ok(())
}

/// 视觉/建模相关错误的 HTTP 映射：配置类 400，超时 504，其余上游/校验类 502。
fn upstream_status(error: &str) -> StatusCode {
    let kind = error.split(':').next().unwrap_or("");
    match kind {
        "missing_key" | "config" | "invalid_request" => StatusCode::BAD_REQUEST,
        "timeout" => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_GATEWAY,
    }
}

/// 后台建模任务：按计划构建 或 对已有版本做减面/重拓扑，成功后写入新版本。
enum ModelTask {
    Process { version: String, operation: String, ratio: f64, voxel_size: f64, options: Value },
}

/// 把成功产出的 GLB 写成新版本（provider=blender_worker）并推进审核状态。
pub(crate) async fn store_version(
    store: &Store,
    base: &str,
    asset: &Value,
    glb: &[u8],
    meta_extra: Value,
    validation: &validator::Validation,
) -> Result<String, String> {
    // 记录写入前的 latest：历史树尚不存在时用它初始化 root 节点
    let prev_latest = store
        .get_json(&format!("{base}/latest.json"))
        .await
        .ok()
        .and_then(|l| l["latest"].as_str().map(|s| s.to_string()));
    let existing = store.list_dirs(&format!("{base}/versions/")).await.unwrap_or_default();
    let reserved = meta_extra["source_job_id"].as_str();
    let mut reuse = None;
    if let Some(job) = reserved {
        for v in &existing {
            if store.get_json(&format!("{base}/versions/{v}/meta.json")).await.ok().is_some_and(|m|m["source_job_id"]==job) { reuse=Some(v.clone()); break; }
        }
    }
    let ver = reuse.unwrap_or_else(||format!("v{:03}",existing.iter().filter_map(|v|v.strip_prefix('v')?.parse::<u64>().ok()).max().unwrap_or(0)+1));
    store
        .put_bytes(&format!("{base}/versions/{ver}/model.glb"), glb)
        .await
        .map_err(|_| "storage: 模型存储失败".to_string())?;
    let mut meta = json!({
        "version": ver, "provider": "blender_worker", "created_at": now_epoch(), "anchor": false,
        "validation": {
            "ok": validation.ok, "warnings": validation.warnings, "mesh_count": validation.mesh_count,
            "height_m": validation.height_m, "bbox": validation.bbox,
            "triangles": validation.triangles, "vertices": validation.vertices
        }
    });
    if let (Some(obj), Some(extra)) = (meta.as_object_mut(), meta_extra.as_object()) {
        obj.extend(extra.clone());
    }
    store
        .put_json(&format!("{base}/versions/{ver}/meta.json"), &meta)
        .await
        .map_err(|_| "storage: 版本元数据写入失败".to_string())?;

    let mut latest = store.get_json(&format!("{base}/latest.json")).await.unwrap_or(json!({}));
    latest["latest"] = json!(ver);
    let auto = std::env::var("AUTO_APPROVE").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let auto_pub = std::env::var("AUTO_PUBLISH").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
    if auto {
        latest["approved"] = json!(ver);
    }
    if auto && auto_pub {
        latest["published"] = json!(ver);
    }
    store
        .put_json(&format!("{base}/latest.json"), &latest)
        .await
        .map_err(|_| "storage: 版本指针写入失败".to_string())?;

    let status = if auto && auto_pub { "published" } else if auto { "approved" } else { "model_review" };
    let mut a = store.get_json(&format!("{base}/asset.json")).await.unwrap_or_else(|_|asset.clone());
    a["version"] = json!(ver);
    a["model"] = json!({"file": "model.glb", "format": "glb", "unit": "meter", "up_axis": "Y", "forward_axis": if meta_extra["provider"]=="tripo" {"+X"} else {"-Z"}});
    set_status_with(store, base, a, status)
        .await
        .map_err(|_| "storage: 资产状态写入失败".to_string())?;
    // 版本已落盘，追加历史节点（append-only 历史树；失败只记日志不回滚版本）
    let summary = if meta_extra["provider"] == "tripo" { format!("Tripo 生成模型 → {ver}") } else { match meta_extra["operation"].as_str() {
        Some("decimate") => format!("Blender 减面 → {ver}"),
        Some("remesh") => format!("Blender 重拓扑 → {ver}"),
        _ => format!("Blender 生成模型 → {ver}"),
    }};
    if let Err(e) = crate::history::record_version(
        store, base, &ver, glb, prev_latest.as_deref(), &summary, "user", None,
    )
    .await
    {
        tracing::warn!(asset = %base, version = %ver, error = %e, "history append failed (version already saved)");
    }
    Ok(ver)
}

async fn run_model_job(
    store: Store,
    base: String,
    job_id: String,
    asset_id: String,
    asset: Value,
    spec: Value,
    kind: &'static str,
    task: ModelTask,
) {
    let started = Instant::now();
    let result: Result<Value, String> =
        tokio::time::timeout(Duration::from_secs(MODEL_TIMEOUT_SECS), async {
            let _ = patch_job_with(
                &store,
                &base,
                &job_id,
                json!({ "progress": model_progress("构建模型与渲染预览", 25) }),
            )
            .await;
            let (glb, mut stats, preview_png) = match &task {
                ModelTask::Process { version, operation, ratio, voxel_size, options } => {
                    let src = store
                        .get_bytes(&format!("{base}/versions/{version}/model.glb"))
                        .await
                        .map_err(|_| format!("missing_source: 版本 {version} 的 model.glb 不存在"))?;
                    let mut worker_options = if options.is_object() { options.clone() } else { json!({}) };
                    if let Some(key) = options["texture_key"].as_str() {
                        if !key.starts_with("source/") || key.contains("..") { return Err("纹理必须来自当前资产 source 目录".into()); }
                        use base64::Engine;
                        let bytes = store.get_bytes(&format!("{base}/{key}")).await?;
                        worker_options["texture_b64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
                    }
                    crate::blender::process(&src, operation, Some(*ratio), Some(*voxel_size), &worker_options).await
                }
            }?;
            let _ = patch_job_with(
                &store,
                &base,
                &job_id,
                json!({ "progress": model_progress("validate", 70) }),
            )
            .await;
            let mut expected_h = spec["attributes"]["height_m"].as_f64();
            if let ModelTask::Process { operation, options, .. } = &task {
                if let ModelTask::Process { version, .. } = &task {
                    expected_h = store.get_bytes(&format!("{base}/versions/{version}/model.glb")).await.ok()
                        .and_then(|src| validator::validate_glb(&src, None).height_m).or(expected_h);
                }
                if operation == "transform" { expected_h = expected_h.map(|h| h * options["scale"].as_f64().unwrap_or(1.0)); }
            }
            let check = validator::validate_glb(&glb, expected_h);
            if !check.ok {
                return Err(format!("model_invalid: 工作器产出的模型未通过校验：{}", check.errors.join("; ")));
            }
            let review_images = stats.as_object_mut().and_then(|s| s.remove("review_images"));
            let meta_extra = match &task {
                ModelTask::Process { version, operation, ratio, voxel_size, options } => json!({
                    "operation": operation, "source_version": version,
                    "ratio": ratio, "voxel_size": voxel_size, "options": options, "worker_stats": stats
                }),
            };
            let ver = store_version(&store, &base, &asset, &glb, meta_extra.clone(), &check).await?;
            if let Some(images) = review_images {
                use base64::Engine;
                for view in ["front", "side", "back", "angle45", "angle135", "angle225", "angle315", "other_side"] {
                    if let Some(encoded) = images[view].as_str() {
                        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "预览图片编码无效")?;
                        store.put_bytes(&format!("{base}/versions/{ver}/review_{view}.png"), &bytes).await?;
                    }
                }
            }
            // 工作器渲染的正视图缩略图直接落成资产预览：只要产出了模型，
            // 列表页/预览页就该显示模型本身，而不是参考图或"尚无预览"。
            if let Some(png) = preview_png {
                store
                    .put_bytes(&format!("{base}/versions/{ver}/preview.png"), &png)
                    .await?;
                if let Ok(mut a) = store.get_json(&format!("{base}/asset.json")).await {
                    a["preview"] = json!({
                        "image": "preview.png",
                        "path": format!("versions/{ver}/preview.png")
                    });
                    let _ = store.put_json(&format!("{base}/asset.json"), &a).await;
                }
            }
            Ok(json!({
                "version": ver, "bytes": glb.len(), "operation": meta_extra["operation"],
                "worker_stats": stats,
                "validation": {
                    "ok": check.ok, "warnings": check.warnings, "mesh_count": check.mesh_count,
                    "height_m": check.height_m, "triangles": check.triangles, "vertices": check.vertices
                }
            }))
        })
        .await
        .unwrap_or_else(|_| Err(MODEL_TIMEOUT_ERROR.to_string()));

    let elapsed = started.elapsed().as_millis() as u64;
    let patch = match &result {
        Ok(value) => {
            tracing::info!(asset_id = %asset_id, job_id = %job_id, kind = kind,
                elapsed_ms = elapsed, "model job done");
            let mut p = json!({"status": "done", "finished_at": now_epoch(),
                "progress": model_progress("done", 100)});
            if let (Some(obj), Some(v)) = (p.as_object_mut(), value.as_object()) {
                obj.extend(v.clone());
            }
            p
        }
        Err(error) => {
            tracing::warn!(asset_id = %asset_id, job_id = %job_id, kind = kind, elapsed_ms = elapsed,
                status = crate::services::error_status(error), error = %error, "model job failed");
            json!({"status": "failed", "finished_at": now_epoch(), "error": error})
        }
    };
    if let Err(e) = patch_job_with(&store, &base, &job_id, patch).await {
        tracing::error!(asset_id = %asset_id, job_id = %job_id, error = %e, "model job result save failed");
    }
}

/// Model generation is exclusively a direct Tripo API operation.
pub async fn gen_model(state: State<Shared>, path: Path<(String,String)>, body: axum::body::Bytes) -> ApiResult<(StatusCode,Json<Value>)> {
    crate::model_jobs::generate(state,path,body).await
}

#[derive(Deserialize)]
pub struct ProcessVersionReq {
    operation: String,
    ratio: Option<f64>,
    voxel_size: Option<f64>,
    #[serde(default)]
    options: Value,
    /// 可选乐观锁：与当前历史 HEAD 不一致 → 409 stale_head；不传则直接提交（兼容旧客户端）
    pub expected_history_node_id: Option<String>,
}

/// POST /api/assets/{dir}/{id}/versions/{ver}/process：对已有真实版本做减面 / 重拓扑，
/// 结果存为新版本（provider=blender_worker）并进入模型审核。
pub async fn process_version(
    State(st): State<Shared>,
    Path((dir, id, ver)): Path<(String, String, String)>,
    body: Result<Json<ProcessVersionReq>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    check_dir(&dir)?;
    let Json(req) = body.map_err(|_| e400("请求 JSON 无效：需要 {operation: \"decimate\"|\"remesh\"}"))?;
    let operation = req.operation.trim().to_ascii_lowercase();
    if !matches!(operation.as_str(), "decimate" | "remesh" | "quad" | "split" | "uv" | "material" | "upscale" | "rig" | "animation" | "transform") {
        return Err(e400(format!("不支持的处理操作: {operation}")));
    }
    let ratio = req.ratio.unwrap_or(0.5);
    let voxel_size = req.voxel_size.unwrap_or(0.05);
    if operation == "decimate" && !(0.01..=1.0).contains(&ratio) {
        return Err(e400(format!("ratio 需在 0.01..1.0 之间，收到 {ratio}")));
    }
    if operation == "remesh" && !(0.005..=1.0).contains(&voxel_size) {
        return Err(e400(format!("voxel_size 需在 0.005..1.0 之间，收到 {voxel_size}")));
    }
    if ![ratio, voxel_size].iter().all(|v| v.is_finite()) {
        return Err(e400("ratio / voxel_size 必须是有限数"));
    }
    require_worker().await?;
    let (base, asset, spec, _latest) = load(&st, &dir, &id).await?;
    ensure_real_version(&st, &base, &ver).await?;
    // 先确认源 GLB 存在，避免后台任务里才发现
    st.store
        .get_bytes(&format!("{base}/versions/{ver}/model.glb"))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("版本不存在或缺少 GLB: {ver}")))?;
    // 乐观锁前置校验：expected_history_node_id 与当前历史 HEAD 不一致 → 409（未提交工作器）
    if let Some(expected) = req.expected_history_node_id.as_deref() {
        if let Some((code, payload)) = crate::history::check_stale_head(&st.store, &base, expected).await {
            return Ok((code, payload));
        }
    }
    if has_active_model_job(&st, &base).await {
        return Err(e409("已有建模任务在运行（任务仍在有效期内），本次未提交工作器"));
    }
    let permit = MODEL_GATE
        .try_acquire()
        .map_err(|_| e409("已有建模任务在运行，本次未提交工作器"))?;
    let now = now_epoch();
    let job_id = next_job(
        &st,
        &base,
        "model_process",
        json!({
            "provider": "blender_worker", "status": "running", "started_at": now,
            "source_version": ver, "operation": operation,
            "ratio": ratio, "voxel_size": voxel_size,
            "progress": model_progress("queued", 0)
        }),
    )
    .await?;
    let store = st.store.clone();
    let base_owned = base.clone();
    let job_owned = job_id.clone();
    let id_owned = id.to_string();
    let version_owned = ver.clone();
    let op_owned = operation.clone();
    tokio::spawn(async move {
        let _permit = permit;
        run_model_job(
            store,
            base_owned,
            job_owned,
            id_owned,
            asset,
            spec,
            "model_process",
            ModelTask::Process { version: version_owned, operation: op_owned, ratio, voxel_size, options: req.options },
        )
        .await;
    });
    tracing::info!(asset_id = %id, job_id = %job_id, version = %ver, operation = %operation,
        "model process job accepted");
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "asset_id": id, "status": "running", "job_id": job_id,
            "provider": "blender_worker", "accepted": true,
            "source_version": ver, "operation": operation, "ratio": ratio, "voxel_size": voxel_size,
            "progress": model_progress("queued", 0),
            "message": format!("已提交 {operation} 任务；完成后生成新版本并进入模型审核")
        })),
    ))
}

/// 选锚点：latest 指针指向选中候选（KICKOFF：候选并排 → 选锚点 → 后续围绕锚点小幅偏移）
pub async fn set_anchor(
    State(st): State<Shared>,
    Path((dir, id, ver)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let (base, asset, _s, latest) = load(&st, &dir, &id).await?;
    st.store
        .get_json(&format!("{base}/versions/{ver}/meta.json"))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("版本不存在: {ver}")))?;
    // 清掉其他候选的 anchor 标记，打上当前
    let vers = st.store.list_dirs(&format!("{base}/versions/")).await.unwrap_or_default();
    for v in &vers {
        let mp = format!("{base}/versions/{v}/meta.json");
        if let Ok(mut m) = st.store.get_json(&mp).await {
            m["anchor"] = json!(v == &ver);
            let _ = st.store.put_json(&mp, &m).await;
        }
    }
    let mut l = latest.clone();
    l["latest"] = json!(ver);
    st.store.put_json(&format!("{base}/latest.json"), &l).await.map_err(e500)?;
    let mut a = asset.clone();
    a["version"] = json!(ver);
    a["anchor_of"] = json!(ver);
    set_status(&st, &base, a, asset["status"].as_str().unwrap_or("model_review")).await?;
    let job_id = next_job(&st, &base, "anchor_set", json!({"version": ver})).await?;
    Ok(Json(json!({"asset_id": id, "anchor": ver, "latest": ver, "job_id": job_id})))
}

// ---------- 阶段 7：版本三态操作（批准/发布/回滚） ----------

async fn move_pointer(
    st: &Shared,
    dir: &str,
    id: &str,
    pointer: &str,
    ver: &str,
    require_approved: bool,
) -> ApiResult<Json<Value>> {
    check_dir(dir)?;
    let (base, asset, _s, latest) = load(st, dir, id).await?;
    ensure_real_version(st, &base, ver).await?;
    // 版本必须存在
    st.store
        .get_json(&format!("{base}/versions/{ver}/meta.json"))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("版本不存在: {ver}")))?;
    if require_approved && latest["approved"].as_str() != Some(ver) {
        return Err(e409(format!("{ver} 未批准，不能发布")));
    }
    let mut l = latest.clone();
    l[pointer] = json!(ver);
    st.store.put_json(&format!("{base}/latest.json"), &l).await.map_err(e500)?;
    let status = if pointer == "published" { "published" } else { "approved" };
    let mut a = asset.clone();
    a["version"] = json!(ver);
    set_status(st, &base, a, status).await?;
    let job_id = next_job(st, &base, &format!("{pointer}_set"), json!({"version": ver})).await?;
    Ok(Json(json!({"asset_id": id, pointer: ver, "status": status, "job_id": job_id})))
}

pub async fn approve_version(
    State(st): State<Shared>,
    Path((dir, id, ver)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    move_pointer(&st, &dir, &id, "approved", &ver, false).await
}

pub async fn publish_version(
    State(st): State<Shared>,
    Path((dir, id, ver)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    move_pointer(&st, &dir, &id, "published", &ver, true).await
}

#[derive(Deserialize)]
pub struct RollbackReq {
    to_version: String,
}

/// 回滚 = published 指针写回历史版本（KICKOFF 5.8：不删文件，只动指针）
pub async fn rollback(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
    Json(req): Json<RollbackReq>,
) -> ApiResult<Json<Value>> {
    let r = move_pointer(&st, &dir, &id, "published", &req.to_version, false).await?;
    next_job(&st, &format!("{dir}/{id}"), "rollback", json!({"to": req.to_version})).await?;
    Ok(r)
}

// ---------- 分类纠正 + 目录迁移 ----------

#[derive(Deserialize)]
pub struct ReclassifyReq {
    asset_type: String,
}

pub async fn reclassify(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
    Json(req): Json<ReclassifyReq>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let (_pfx, new_dir) = category_info(&req.asset_type).ok_or_else(|| e400("非法 asset_type"))?;
    let (base, asset, spec, latest) = load(&st, &dir, &id).await?;
    if latest["published"].as_str().is_some() {
        return Err(e409("published 资产锁定，禁止迁移（先回滚/解锁）"));
    }
    if new_dir == dir {
        return Err(e400("目标分类与当前相同"));
    }
    let (new_prefix, _) = category_info(&req.asset_type).unwrap();
    let existing = st.store.list_dirs(&format!("{new_dir}/")).await.unwrap_or_default();
    let slug_part = id.split('_').nth(1).unwrap_or("asset");
    let new_id = format!("{new_prefix}_{}_{:03}", slug_part, existing.len() + 1);
    let new_base = format!("{new_dir}/{new_id}");

    // 全量 copy → delete
    let keys = st.store.list_keys(&format!("{base}/")).await.map_err(e500)?;
    for k in &keys {
        let bytes = st.store.get_bytes(k).await.map_err(e500)?;
        let nk = k.replacen(&base, &new_base, 1);
        st.store.put_bytes(&nk, &bytes).await.map_err(e500)?;
    }
    // 更新 json 内的 asset_id / asset_type
    let mut a = asset.clone();
    a["asset_id"] = json!(new_id);
    a["asset_type"] = json!(req.asset_type);
    st.store.put_json(&format!("{new_base}/asset.json"), &a).await.map_err(e500)?;
    if !spec.is_null() {
        let mut s = spec.clone();
        s["asset_id"] = json!(new_id);
        s["asset_type"] = json!(req.asset_type);
        s["type_confidence"] = json!(1.0);
        st.store.put_json(&format!("{new_base}/source/spec.json"), &s).await.map_err(e500)?;
    }
    st.store.delete_prefix(&format!("{base}/")).await.map_err(e500)?;
    Ok(Json(json!({
        "old_asset_id": id, "asset_id": new_id, "asset_type": req.asset_type,
        "migrated_files": keys.len()
    })))
}

// ---------- 外部 AI 产物推送（MCP：无 key 的 AI 也能把图片/模型推入资产库） ----------

#[derive(Deserialize)]
pub struct PushFileReq {
    bytes_b64: String,
}

/// PUT /api/assets/{dir}/{id}/file/{*key}：推送图片（三视图/预览/QA 渲染集）
pub async fn push_file(
    State(st): State<Shared>,
    Path((dir, id, key)): Path<(String, String, String)>,
    Json(req): Json<PushFileReq>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    use base64::Engine;
    // plan.json 是资产级建模计划（视觉模型产出、可手改），与 source/ 同级
    if key.contains("..")
        || !(key.starts_with("source/") || key.starts_with("versions/") || key == "plan.json")
    {
        return Err(e400("key 必须是 plan.json 或位于 source/ 或 versions/ 下"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.bytes_b64)
        .map_err(|e| e400(format!("base64: {e}")))?;
    let full = format!("{dir}/{id}/{key}");
    st.store.put_bytes(&full, &bytes).await.map_err(e500)?;

    // preview 自动写回 contract
    if key.contains("/preview.png") {
        let base = format!("{dir}/{id}");
        if let Ok(mut a) = st.store.get_json(&format!("{base}/asset.json")).await {
            a["preview"] = json!({ "image": key.split('/').last().unwrap_or("preview.png"),
                "path": key });
            let _ = st.store.put_json(&format!("{base}/asset.json"), &a).await;
        }
    }
    Ok(Json(json!({ "asset_id": id, "key": full, "bytes": bytes.len() })))
}

#[derive(Deserialize)]
pub struct ImportVersionReq {
    glb_b64: String,
    provider: Option<String>,
    /// 可选乐观锁：与当前历史 HEAD 不一致 → 409 stale_head；不传则直接提交（兼容旧客户端）
    pub expected_history_node_id: Option<String>,
}

/// POST /api/assets/{dir}/{id}/versions/import：外部生成的 GLB 推送成新版本（自动校验 + 版本号递增）
pub async fn import_version(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
    Json(req): Json<ImportVersionReq>,
) -> ApiResult<axum::response::Response> {
    check_dir(&dir)?;
    use base64::Engine;
    reject_stub_meta(&json!({"provider": req.provider}))?;
    let glb = base64::engine::general_purpose::STANDARD
        .decode(&req.glb_b64)
        .map_err(|e| e400(format!("base64: {e}")))?;
    let (base, asset, spec, latest) = load(&st, &dir, &id).await?;
    // 写入前的 latest：历史树尚不存在时用它初始化 root 节点
    let prev_latest = latest["latest"].as_str().map(|s| s.to_string());
    // 乐观锁前置校验：expected_history_node_id 与当前历史 HEAD 不一致 → 409（尚未写入任何数据）
    if let Some(expected) = req.expected_history_node_id.as_deref() {
        if let Some((code, payload)) = crate::history::check_stale_head(&st.store, &base, expected).await {
            return Ok((code, payload).into_response());
        }
    }
    let expected_h = spec["attributes"]["height_m"].as_f64();
    let check = validator::validate_glb(&glb, expected_h);
    if !check.ok {
        return Err(e400(format!("模型校验未通过: {}", check.errors.join("; "))));
    }
    let existing = st.store.list_dirs(&format!("{base}/versions/")).await.unwrap_or_default();
    let ver = format!("v{:03}", existing.len() + 1);
    st.store
        .put_bytes(&format!("{base}/versions/{ver}/model.glb"), &glb)
        .await
        .map_err(e500)?;
    let mut l = latest.clone();
    l["latest"] = json!(ver);
    let auto = std::env::var("AUTO_APPROVE").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let auto_pub = std::env::var("AUTO_PUBLISH").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
    if auto { l["approved"] = json!(ver); }
    if auto && auto_pub { l["published"] = json!(ver); }
    st.store.put_json(&format!("{base}/latest.json"), &l).await.map_err(e500)?;
    let meta = json!({
        "version": ver, "provider": req.provider.unwrap_or_else(|| "external_ai".into()),
        "created_at": now_epoch(), "anchor": false,
        "validation": {
            "ok": check.ok, "warnings": check.warnings, "mesh_count": check.mesh_count,
            "height_m": check.height_m, "bbox": check.bbox,
            "triangles": check.triangles, "vertices": check.vertices
        }
    });
    st.store
        .put_json(&format!("{base}/versions/{ver}/meta.json"), &meta)
        .await
        .map_err(e500)?;
    let mut a = asset.clone();
    a["version"] = json!(ver);
    a["model"] = json!({"file": "model.glb", "format": "glb", "unit": "meter", "up_axis": "Y", "forward_axis": "-Z"});
    let status = if auto && auto_pub { "published" } else if auto { "approved" } else { "model_review" };
    set_status(&st, &base, a, status).await?;
    let job_id = next_job(&st, &base, "import_version", json!({"version": ver, "provider": meta["provider"]})).await?;
    // 版本已落盘，追加历史节点（append-only 历史树；失败只记日志不回滚版本）
    let summary = format!("导入外部 GLB → {ver}");
    if let Err(e) = crate::history::record_version(
        &st.store, &base, &ver, &glb, prev_latest.as_deref(), &summary, "user", None,
    )
    .await
    {
        tracing::warn!(asset_id = %id, version = %ver, error = %e, "history append failed (version already saved)");
    }
    Ok(Json(json!({
        "asset_id": id, "version": ver, "status": status, "validation": meta["validation"], "job_id": job_id
    }))
    .into_response())
}

// ---------- 模型大纲 + 引擎包编译（画布/流水线可视化与交付） ----------

pub async fn get_outline(
    State(st): State<Shared>,
    Path((dir, id, ver)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let base = format!("{dir}/{id}");
    let glb = st
        .store
        .get_bytes(&format!("{base}/versions/{ver}/model.glb"))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("版本不存在: {ver}")))?;
    crate::model::outline(&glb).map_err(e500).map(Json)
}

pub async fn compile_bundle(
    State(st): State<Shared>,
    Path((dir, id, ver)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let base = format!("{dir}/{id}");
    let glb = st
        .store
        .get_bytes(&format!("{base}/versions/{ver}/model.glb"))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("版本不存在: {ver}")))?;
    let contract = st
        .store
        .get_json(&format!("{base}/asset.json"))
        .await
        .map_err(e500)?;
    let meta = st
        .store
        .get_json(&format!("{base}/versions/{ver}/meta.json"))
        .await
        .map_err(e500)?;
    reject_stub_meta(&meta)?;
    let outl = crate::model::outline(&glb).map_err(e500)?;

    let zip_bytes = crate::model::build_engine_bundle(&glb, &id, &ver, &contract, &meta, &outl)
        .map_err(e500)?;
    let key = format!("{base}/versions/{ver}/build/{id}_{ver}.zip");
    st.store.put_bytes(&key, &zip_bytes).await.map_err(e500)?;

    // meta 打上编译标记
    let mut m = meta.clone();
    m["compiled_at"] = json!(now_epoch());
    m["bundle"] = json!(format!("{id}_{ver}.zip"));
    st.store
        .put_json(&format!("{base}/versions/{ver}/meta.json"), &m)
        .await
        .map_err(e500)?;
    let job_id = next_job(&st, &base, "compile", json!({"version": ver, "bytes": zip_bytes.len()})).await?;
    Ok(Json(json!({
        "asset_id": id, "version": ver, "bundle": format!("{id}_{ver}.zip"),
        "bytes": zip_bytes.len(),
        "url": format!("/api/assets/{dir}/{id}/file/versions/{ver}/build/{id}_{ver}.zip"),
        "outline_stats": outl["stats"], "job_id": job_id
    })))
}

// ---------- 分类编排（层级 taxonomy：大类 → 性别/年龄/服装类型 → 资产） ----------

/// 返回层级结构：{ character: { _count: n, _gender: { 女: n, 男: n }, _age: { 儿童: n, ... } }, apparel: {...} }
/// 用分类目录（中英关键词）匹配细分小类：返回 {zh,en,group_zh,group_en}
fn infer_gender(name: &str) -> &'static str {
    let l = name.to_lowercase();
    if ["girl", "woman", "female", "女", "女孩", "女人"].iter().any(|k| l.contains(k)) { "女性" }
    else if ["boy", "man", "male", "男", "男孩", "男人"].iter().any(|k| l.contains(k)) { "男性" }
    else { "n/a" }
}

fn infer_age(name: &str) -> &'static str {
    let l = name.to_lowercase();
    if ["baby", "infant", "婴儿"].iter().any(|k| l.contains(k)) { "婴儿" }
    else if ["child", "kid", "儿童", "小孩"].iter().any(|k| l.contains(k)) { "儿童" }
    else if ["teen", "student", "少年", "学生"].iter().any(|k| l.contains(k)) { "少年" }
    else if ["elder", "old", "grand", "老人", "老年"].iter().any(|k| l.contains(k)) { "老年" }
    else if ["adult", "青年", "成人"].iter().any(|k| l.contains(k)) { "青年" }
    else { "n/a" }
}

fn classify_subtype(name: &str, dir: &str, extra: &str) -> Value {
    let cat: Value = serde_json::from_str(crate::openai::CATALOG_JSON).unwrap_or(Value::Null);
    let type_key = match dir {
        "characters" => "character", "animals" => "animal", "props" => "prop",
        "buildings" => "building", "environments" => "environment", "vegetation" => "vegetation",
        "grounds" => "ground", "skies" => "sky", "vehicles" => "vehicle",
        "materials" => "material", "effects" => "effect", "apparel" => "apparel",
        _ => "prop",
    };
    let hay = format!("{} {} {}", name, extra, dir).to_lowercase();
    let mut best: Option<(usize, Value)> = None; // (匹配关键词长度, 结果)
    if let Some(groups) = cat["tree"][type_key]["groups"].as_object() {
        for (gkey, g) in groups {
            if gkey == "age" || gkey == "gender" || gkey == "season" {
                continue; // 这些属于 taxonomy 维度，不作为小类
            }
            let gzh = g["zh"].as_str().unwrap_or(gkey);
            let gen = g["en"].as_str().unwrap_or(gkey);
            for it in g["items"].as_array().unwrap_or(&vec![]) {
                for kw in it["kw"].as_array().unwrap_or(&vec![]) {
                    let k = kw.as_str().unwrap_or("").to_lowercase();
                    if !k.is_empty() && hay.contains(&k) && k.len() > best.as_ref().map(|b| b.0).unwrap_or(0) {
                        best = Some((k.len(), json!({
                            "zh": it["zh"], "en": it["en"],
                            "group_zh": gzh, "group_en": gen
                        })));
                    }
                }
            }
        }
    }
    best.map(|b| b.1).unwrap_or_else(|| json!({
        "zh": "其他", "en": "Other", "group_zh": "未分类", "group_en": "Unclassified"
    }))
}

/// POST /api/taxonomy/catalog：返回完整细分类目体系（大类 → 中类 → 小类，中英双语）
pub async fn get_catalog() -> ApiResult<Json<Value>> {
    let cat: Value = serde_json::from_str(crate::openai::CATALOG_JSON)
        .map_err(|e| e500(format!("catalog parse: {e}")))?;
    Ok(Json(cat))
}

/// POST /api/taxonomy/backfill：给缺 taxonomy 的资产按名称启发式补齐（不调用 LLM）
pub async fn backfill_taxonomy(
    State(st): State<Shared>,
    body: Option<Json<Value>>,
) -> ApiResult<Json<Value>> {
    let force = body
        .as_ref()
        .and_then(|Json(b)| b.get("force"))
        .and_then(|f| f.as_bool())
        .unwrap_or(false);
    let mut filled = 0u64;
    let mut skipped = 0u64;
    for dir in CATEGORIES {
        let ids = st.store.list_dirs(&format!("{dir}/")).await.unwrap_or_default();
        for id in ids {
            let key = format!("{dir}/{id}/source/spec.json");
            let mut spec = match st.store.get_json(&key).await {
                Ok(s) => s,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            // 已有细分类目且有 taxonomy 才跳过（否则按最新目录重新归类）
            let has_sub = spec.get("subcategory").and_then(|x| x.as_str()).is_some();
            let has_tax = spec.get("taxonomy").map(|t| t.is_object()).unwrap_or(false);
            if !force && has_sub && has_tax {
                skipped += 1;
                continue;
            }
            let name = spec
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(&id)
                .to_string();
            let sub = classify_subtype(&name, dir, &spec.to_string());
            spec["subcategory"] = sub["zh"].clone();
            spec["subcategory_en"] = sub["en"].clone();
            spec["taxonomy"] = json!({
                "gender": infer_gender(&name),
                "age_group": infer_age(&name),
                "class": sub["zh"], "class_en": sub["en"],
                "group": sub["group_zh"], "group_en": sub["group_en"]
            });
            let _ = st.store.put_json(&key, &spec).await;
            filled += 1;
        }
    }
    Ok(Json(json!({ "filled": filled, "skipped": skipped })))
}

/// 不再制造占位海报，也不自动调用收费图像服务。
pub async fn backfill_posters() -> ApiResult<Json<Value>> {
    Err((StatusCode::NOT_IMPLEMENTED, "占位海报补齐已停用，请手动生成真实参考图或导入预览".into()))
}

fn bump(map: &mut serde_json::Map<String, Value>, key: &str) {
    let cur = map.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
    map.insert(key.to_string(), json!(cur + 1));
}

pub async fn get_taxonomy(State(st): State<Shared>) -> ApiResult<Json<Value>> {
    let mut tree = serde_json::Map::new();
    for dir in CATEGORIES {
        let ids = st.store.list_dirs(&format!("{dir}/")).await.unwrap_or_default();
        if ids.is_empty() {
            continue;
        }
        let atype = ids.first().map(|_| dir.trim_end_matches('s')).unwrap_or("prop");
        let mut node = json!({ "_count": ids.len(), "_type": atype, "_items": [] });
        let mut gender = serde_json::Map::new();
        let mut age = serde_json::Map::new();
        let mut apparel = serde_json::Map::new();
        let mut subs = serde_json::Map::new();
        for id in &ids {
            let spec = st
                .store
                .get_json(&format!("{dir}/{id}/source/spec.json"))
                .await
                .unwrap_or(Value::Null);
            let tax = spec.get("taxonomy").cloned().unwrap_or(json!({}));
            let g = tax.get("gender").and_then(|x| x.as_str()).unwrap_or("n/a").to_string();
            let a = tax.get("age_group").and_then(|x| x.as_str()).unwrap_or("n/a").to_string();
            let ap = tax.get("apparel_type").and_then(|x| x.as_str()).unwrap_or("n/a").to_string();
            let sub = spec.get("subcategory").and_then(|x| x.as_str()).unwrap_or("其他").to_string();
            bump(&mut gender, &g);
            bump(&mut age, &a);
            bump(&mut apparel, &ap);
            bump(&mut subs, &sub);
            node["_items"].as_array_mut().unwrap().push(json!({
                "asset_id": id, "name": spec.get("name"),
                "name_en": spec.get("name_en"), "gender": g, "age_group": a,
                "apparel_type": ap, "subcategory": sub,
                "subcategory_en": spec.get("subcategory_en")
            }));
        }
        node["_gender"] = Value::Object(gender);
        node["_age"] = Value::Object(age);
        node["_apparel"] = Value::Object(apparel);
        node["_subcategories"] = Value::Object(subs);
        tree.insert(dir.to_string(), node);
    }
    Ok(Json(Value::Object(tree)))
}

// ---------- AI 修改（用自然语言增量修改 spec，保留 diff 与成本） ----------

#[derive(Deserialize)]
pub struct ModifyReq {
    instruction: String,
    apply: Option<bool>, // true=写回 spec（默认），false=只预览
}

pub async fn ai_modify(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
    Json(req): Json<ModifyReq>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    if req.instruction.trim().is_empty() {
        return Err(e400("instruction 不能为空"));
    }
    budget_check(&st).await?;
    let (base, _a, spec, _l) = load(&st, &dir, &id).await?;

    let current = serde_json::to_string(&spec).unwrap_or_default();
    let out = crate::openai::generate_spec(
        &st.cfg,
        &format!("Modify the following asset spec per instruction.\nCURRENT SPEC: {current}\nINSTRUCTION: {}", req.instruction),
        "Return the FULL updated spec JSON with the same schema, changing only what the instruction asks. \
         Keep asset_id/asset_type unchanged unless the instruction explicitly changes the subject category.",
    )
    .await
    .map_err(e500)?;
    if let Some(u) = out.usage {
        ledger_add(&st, u.total_tokens).await;
    }

    let mut diff = Vec::new();
    if let (Some(old), Some(new)) = (spec.as_object(), out.spec.as_object()) {
        for (k, v) in new {
            match old.get(k) {
                Some(ov) if ov != v => diff.push(format!("~ {k}: {ov} -> {v}")),
                None => diff.push(format!("+ {k}: {v}")),
                _ => {}
            }
        }
        for k in old.keys() {
            if !new.contains_key(k) {
                diff.push(format!("- {k}"));
            }
        }
    }

    let apply = req.apply.unwrap_or(true);
    if apply {
        st.store
            .put_json(&format!("{base}/source/spec.json"), &out.spec)
            .await
            .map_err(e500)?;
    }
    let job_id = next_job(&st, &base, "ai_modify", json!({
        "instruction": req.instruction, "diff": diff, "applied": apply
    }))
    .await?;
    Ok(Json(json!({
        "asset_id": id, "applied": apply, "diff": diff, "spec": out.spec,
        "usage": out.usage.map(|u| u.total_tokens), "job_id": job_id
    })))
}

// ---------- 外部资产导入（合成体 Composition 功能已移除，不再提供）----------

pub async fn import_asset(
    State(st): State<Shared>,
    mut multipart: axum::extract::Multipart,
) -> ApiResult<Json<Value>> {
    let mut name: Option<String> = None;
    let mut asset_type: Option<String> = None;
    let mut description: Option<String> = None;
    let mut source_path: Option<String> = None;
    let mut glb: Option<Vec<u8>> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| e400(format!("multipart: {e}")))? {
        let fname = field.name().unwrap_or("").to_string();
        match fname.as_str() {
            "name" => name = Some(field.text().await.map_err(|e| e400(e.to_string()))?),
            "asset_type" => asset_type = Some(field.text().await.map_err(|e| e400(e.to_string()))?),
            "description" => description = Some(field.text().await.map_err(|e| e400(e.to_string()))?),
            "source_path" => source_path = Some(field.text().await.map_err(|e| e400(e.to_string()))?),
            "file" => glb = Some(field.bytes().await.map_err(|e| e400(e.to_string()))?.to_vec()),
            _ => {}
        }
    }
    let glb = glb.ok_or_else(|| e400("缺少 file 字段（GLB 二进制）"))?;
    let asset_type = asset_type.unwrap_or_else(|| "prop".into());
    let (_prefix, dir) = category_info(&asset_type).ok_or_else(|| e400(format!("非法 asset_type: {asset_type}")))?;
    let name = name.unwrap_or_else(|| format!("imported_{}", now_epoch()));

    let check = validator::validate_glb(&glb, None);
    if !check.ok {
        return Err(e400(format!("模型校验未通过: {}", check.errors.join("; "))));
    }

    let existing = st.store.list_dirs(&format!("{dir}/")).await.unwrap_or_default();
    let slug_name = crate::assets::slug(&name, "imported");
    let id = format!("{}_{}_{:03}", category_info(&asset_type).unwrap().0, slug_name, existing.len() + 1);
    let name = if name.trim().is_empty() { id.clone() } else { name.trim().to_string() };
    let base = format!("{dir}/{id}");
    let now = now_epoch();

    // spec（无 LLM 调用，走导入来源描述）
    let spec = json!({
        "asset_id": id, "asset_type": asset_type, "name": name,
        "name_en": slug_name, "style": "imported",
        "description_en": description.clone().unwrap_or_else(|| format!("imported from {dir}")),
        "source": "external_project_import",
        "source_path": source_path,
        "type_confidence": 1.0,
        "attributes": {}, "model_requirements": {"rig": "none", "game_ready": true, "unit": "meter", "up_axis": "Y"}
    });
    st.store.put_json(&format!("{base}/source/spec.json"), &spec).await.map_err(e500)?;
    let contract = json!({
        "schema": "game.asset", "schema_version": "1.0",
        "asset_id": id, "asset_type": asset_type, "version": "v001", "status": "imported",
        "name": name, "created_at": now,
        "model": {"file": "model.glb", "format": "glb", "unit": "meter", "up_axis": "Y", "forward_axis": "-Z"},
        "preview": null, "anchor_of": null, "variant_distance": null
    });
    st.store.put_json(&format!("{base}/asset.json"), &contract).await.map_err(e500)?;
    st.store
        .put_json(&format!("{base}/latest.json"), &json!({"latest": "v001", "approved": null, "published": null}))
        .await
        .map_err(e500)?;
    st.store
        .put_bytes(&format!("{base}/versions/v001/model.glb"), &glb)
        .await
        .map_err(e500)?;
    st.store
        .put_json(&format!("{base}/versions/v001/meta.json"), &json!({
            "version": "v001", "provider": "import", "created_at": now, "anchor": true,
            "validation": {
                "ok": check.ok, "warnings": check.warnings, "mesh_count": check.mesh_count,
                "height_m": check.height_m, "bbox": check.bbox,
                "triangles": check.triangles, "vertices": check.vertices
            }
        }))
        .await
        .map_err(e500)?;
    let job_id = next_job(&st, &base, "import", json!({"source_path": source_path})).await?;
    Ok(Json(json!({
        "asset_id": id, "asset_type": asset_type, "dir": dir, "status": "imported",
        "version": "v001", "triangles": check.triangles, "height_m": check.height_m, "job_id": job_id
    })))
}

// ---------- 画布布局持久化（思维导图式无限画布） ----------

pub async fn get_canvas(State(st): State<Shared>) -> ApiResult<Json<Value>> {
    let c = st
        .store
        .get_json("canvas/layout.json")
        .await
        .unwrap_or(json!({"nodes": [], "updated_at": null}));
    Ok(Json(c))
}

pub async fn put_canvas(
    State(st): State<Shared>,
    Json(req): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut c = req;
    c["updated_at"] = json!(now_epoch());
    st.store.put_json("canvas/layout.json", &c).await.map_err(e500)?;
    Ok(Json(c))
}

// ---------- AI 润色描述 ----------

#[derive(Deserialize)]
pub struct EnrichReq {
    description: String,
}

/// 把一句话描述润色为「单主体 + 特征」结构化生成 prompt（~250 tokens，计入账本）
pub async fn enrich_prompt(
    State(st): State<Shared>,
    Json(req): Json<EnrichReq>,
) -> ApiResult<Json<Value>> {
    if req.description.trim().is_empty() {
        return Err(e400("description 不能为空"));
    }
    budget_check(&st).await?;
    let out = crate::openai::generate_spec(&st.cfg, &req.description,
        "Task: rewrite the user description into a richer asset-creation prompt. \
         Keep JSON shape but focus description_en on: single subject + distinctive features + materials + color palette. \
         Do NOT change the subject.")
        .await
        .map_err(e500)?;
    if let Some(u) = out.usage {
        ledger_add(&st, u.total_tokens).await;
    }
    Ok(Json(json!({
        "enriched": out.spec["description_en"],
        "style": out.spec["style"],
        "usage": out.usage.map(|u| u.total_tokens)
    })))
}

// ---------- QA 渲染集（KICKOFF 审核铁律：多视角标准渲染集） ----------

#[derive(Deserialize)]
pub struct QaImage {
    name: String,      // qa_front.png / qa_side.png / qa_back.png / qa_34.png ...
    data_b64: String,
}

#[derive(Deserialize)]
pub struct QaUploadReq {
    images: Vec<QaImage>,
}

/// 前端 Three.js 渲染 4 视角后上传，存 versions/{v}/qa/
pub async fn upload_qa(
    State(st): State<Shared>,
    Path((dir, id, ver)): Path<(String, String, String)>,
    Json(req): Json<QaUploadReq>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    use base64::Engine;
    let mut saved = Vec::new();
    for img in &req.images {
        if !img.name.starts_with("qa_") || !img.name.ends_with(".png") || img.name.contains("..") {
            return Err(e400(format!("非法 QA 文件名: {}", img.name)));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&img.data_b64)
            .map_err(|e| e400(format!("base64 decode: {e}")))?;
        let key = format!("{dir}/{id}/versions/{ver}/qa/{}", img.name);
        st.store.put_bytes(&key, &bytes).await.map_err(e500)?;
        saved.push(img.name.clone());
    }
    Ok(Json(json!({"version": ver, "saved": saved})))
}

// ---------- Style Profile（KICKOFF 9：全局风格基准，注入 prompt） ----------

pub async fn get_style_profile(State(st): State<Shared>) -> ApiResult<Json<Value>> {
    let p = st.store.get_json("style_profile.json").await.unwrap_or(json!({
        "style_keywords": "stylized_realistic, clean topology, game-ready",
        "color_palette": "soft saturated, consistent with existing assets",
        "head_body_ratio": "1:7 (realistic) unless character spec says otherwise",
        "updated_at": null
    }));
    Ok(Json(p))
}

#[derive(Deserialize)]
pub struct StyleProfileReq {
    style_keywords: String,
    color_palette: Option<String>,
    head_body_ratio: Option<String>,
}

pub async fn put_style_profile(
    State(st): State<Shared>,
    Json(req): Json<StyleProfileReq>,
) -> ApiResult<Json<Value>> {
    let p = json!({
        "style_keywords": req.style_keywords,
        "color_palette": req.color_palette,
        "head_body_ratio": req.head_body_ratio,
        "updated_at": now_epoch()
    });
    st.store.put_json("style_profile.json", &p).await.map_err(e500)?;
    Ok(Json(p))
}

// ---------- 增量 Spec 编辑 + diff（KICKOFF 9 必须项） ----------

#[derive(Deserialize)]
pub struct SpecUpdateReq {
    spec: Value,
    note: Option<String>,
}

pub async fn update_spec(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
    Json(req): Json<SpecUpdateReq>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let (base, mut asset, old_spec, _l) = load(&st, &dir, &id).await?;
    if let Some(name) = req.spec["name"].as_str() {
        let name=name.trim();
        if name.chars().count()>120 || name.chars().any(char::is_control) { return Err(e400("资产名称最多120字，不能包含控制字符")); }
        asset["name"]=json!(if name.is_empty(){id.as_str()}else{name});
    }
    // diff：逐顶层键对比，记录 changed/added/removed
    let mut diff = Vec::new();
    if let (Some(old), Some(new)) = (old_spec.as_object(), req.spec.as_object()) {
        for (k, v) in new {
            match old.get(k) {
                Some(ov) if ov != v => diff.push(format!("~ {k}: {ov} -> {v}")),
                None => diff.push(format!("+ {k}: {v}")),
                _ => {}
            }
        }
        for k in old.keys() {
            if !new.contains_key(k) {
                diff.push(format!("- {k}"));
            }
        }
    }
    st.store
        .put_json(&format!("{base}/source/spec.json"), &req.spec)
        .await
        .map_err(e500)?;
    st.store.put_json(&format!("{base}/asset.json"), &asset).await.map_err(e500)?;
    let job_id = next_job(&st, &base, "spec_edit", json!({
        "note": req.note, "diff": diff
    }))
    .await?;
    Ok(Json(json!({"asset_id": id, "diff": diff, "job_id": job_id})))
}

// ---------- 批量操作（KICKOFF 5.7：多选 + Batch Job，顺序执行不破并发=1） ----------

#[derive(Deserialize)]
pub struct BatchReq {
    op: String,          // regenerate_references / regenerate_models / publish / rollback / global_style_apply
    assets: Vec<String>, // ["characters/chr_asset_001", ...]
    style: Option<String>, // global_style_apply 用：新风格关键词
}

pub async fn batch_run(
    State(st): State<Shared>,
    Json(req): Json<BatchReq>,
) -> ApiResult<Json<Value>> {
    if req.op == "regenerate_models" {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            "批量建模请使用首页的批量图片入口，"
                .to_string()
                + "每张图片独立提交 Tripo 并保存一个资产",
        ));
    }
    if req.assets.is_empty() {
        return Err(e400("assets 不能为空"));
    }
    if req.assets.len() > 20 {
        return Err(e400("单批最多 20 个资产"));
    }
    let batch_id = format!("batch_{}", now_epoch());
    let mut results = Vec::new();

    for aref in &req.assets {
        let (dir, id) = aref.split_once('/').ok_or_else(|| e400(format!("非法资产引用: {aref}")))?;
        check_dir(dir)?;
        let r: Result<Value, String> = async {
            let (base, asset, _s, latest) = load(&st, dir, id).await.map_err(|e| e.1)?;
            match req.op.as_str() {
                "regenerate_references" => {
                    // 后台任务：立即返回 accepted，实际结果以 job 状态为准
                    start_reference_job(&st, dir, id).await.map_err(|e| e.1)
                }
                "regenerate_models" => Err("请使用首页批量图片建模入口".into()),
                "compile" => {
                    let ver = latest["latest"].as_str().ok_or_else(|| format!("{id} 无 latest 版本"))?;
                    let Json(result) = compile_bundle(State(st.clone()), Path((dir.to_string(), id.to_string(), ver.to_string())))
                        .await.map_err(|e| e.1)?;
                    Ok(result)
                }
                "publish" => {
                    let approved = latest["approved"].as_str()
                        .ok_or_else(|| format!("{id} 无 approved 版本"))?;
                    ensure_real_version(&st, &base, approved).await.map_err(|e| e.1)?;
                    let mut l = latest.clone();
                    l["published"] = json!(approved);
                    st.store.put_json(&format!("{base}/latest.json"), &l).await?;
                    set_status(&st, &base, asset, "published").await.map_err(|e| e.1)?;
                    Ok(json!({"published": approved}))
                }
                "rollback" => {
                    // 回滚到 published 的前一个版本
                    let vers = st.store.list_dirs(&format!("{base}/versions/")).await.unwrap_or_default();
                    let cur = latest["published"].as_str()
                        .ok_or_else(|| format!("{id} 未发布，无需回滚"))?;
                    let mut sorted = vers.clone();
                    sorted.sort();
                    let idx = sorted.iter().position(|v| v == cur)
                        .ok_or_else(|| format!("{id} published 版本异常"))?;
                    if idx == 0 {
                        return Err(format!("{id} 已是最早版本 {cur}"));
                    }
                    let to = &sorted[idx - 1];
                    ensure_real_version(&st, &base, to).await.map_err(|e| e.1)?;
                    let mut l = latest.clone();
                    l["published"] = json!(to);
                    st.store.put_json(&format!("{base}/latest.json"), &l).await?;
                    set_status(&st, &base, asset, "published").await.map_err(|e| e.1)?;
                    Ok(json!({"rolled_back_to": to}))
                }
                "approve_references" => {
                    if asset["status"].as_str() != Some("reference_review") {
                        return Err(format!("{id} 状态 {} 不在参考图审核", asset["status"]));
                    }
                    set_status(&st, &base, asset, "reference_approved").await.map_err(|e| e.1)?;
                    Ok(json!({"status": "reference_approved"}))
                }
                "approve_models" => {
                    if asset["status"].as_str() != Some("model_review") {
                        return Err(format!("{id} 状态 {} 不在模型审核", asset["status"]));
                    }
                    let ver = latest["latest"].as_str()
                        .ok_or_else(|| format!("{id} 无 latest 版本"))?;
                    ensure_real_version(&st, &base, ver).await.map_err(|e| e.1)?;
                    let mut l = latest.clone();
                    l["approved"] = json!(ver);
                    st.store.put_json(&format!("{base}/latest.json"), &l).await?;
                    let mut a = asset.clone();
                    a["version"] = json!(ver);
                    set_status(&st, &base, a, "approved").await.map_err(|e| e.1)?;
                    Ok(json!({"approved": ver, "status": "approved"}))
                }
                "auto_publish" => {
                    // 快速通道：批准 latest + 直接发布（校验已过的前提下）
                    let ver = latest["latest"].as_str()
                        .ok_or_else(|| format!("{id} 无 latest 版本"))?;
                    ensure_real_version(&st, &base, ver).await.map_err(|e| e.1)?;
                    let mut l = latest.clone();
                    l["approved"] = json!(ver);
                    l["published"] = json!(ver);
                    st.store.put_json(&format!("{base}/latest.json"), &l).await?;
                    let mut a = asset.clone();
                    a["version"] = json!(ver);
                    set_status(&st, &base, a, "published").await.map_err(|e| e.1)?;
                    Ok(json!({"published": ver, "status": "published"}))
                }
                "global_style_apply" => {
                    // 全局改动：新风格写入 spec.style + 重生成参考图（KICKOFF 5.7）
                    let new_style = req.style.clone()
                        .ok_or_else(|| "global_style_apply 需要 style 参数".to_string())?;
                    let (_b, _a, mut spec, _l) = load(&st, dir, id).await.map_err(|e| e.1)?;
                    let old_style = spec["style"].as_str().unwrap_or("").to_string();
                    spec["style"] = json!(new_style);
                    st.store.put_json(&format!("{base}/source/spec.json"), &spec).await?;
                    // 参考图生成已进入后台：批量结果只记录已受理，实际结果以 job 为准
                    let submitted = start_reference_job(&st, dir, id).await.map_err(|e| e.1)?;
                    Ok(json!({"style": format!("{old_style} -> {new_style}"),
                        "job_id": submitted["job_id"], "status": submitted["status"], "accepted": true}))
                }
                other => Err(format!("未知批量操作: {other}")),
            }
        }
        .await;
        results.push(match r {
            Ok(v) => json!({"asset": aref, "ok": true, "result": v}),
            Err(m) => json!({"asset": aref, "ok": false, "error": m}),
        });
    }

    let ok_count = results.iter().filter(|r| r["ok"] == true).count();
    let record = json!({
        "batch_id": batch_id, "op": req.op, "created_at": now_epoch(),
        "total": results.len(), "ok": ok_count, "results": results
    });
    st.store
        .put_json(&format!("batches/{batch_id}.json"), &record)
        .await
        .map_err(e500)?;
    Ok(Json(record))
}

#[cfg(test)]
mod model_job_tests {
    use super::*;

    #[test]
    fn worker_errors_map_to_explicit_status() {
        assert_eq!(upstream_status("missing_key: 未配置密钥"), StatusCode::BAD_REQUEST);
        assert_eq!(upstream_status("invalid_request: 参考图为空"), StatusCode::BAD_REQUEST);
        assert_eq!(upstream_status("timeout: 超时"), StatusCode::GATEWAY_TIMEOUT);
        // 上游/校验类错误不能伪装成成功，也不能伪装成客户端参数错误
        assert_eq!(upstream_status("authentication: 认证失败（HTTP 401）"), StatusCode::BAD_GATEWAY);
        assert_eq!(upstream_status("invalid_plan: 部件越界"), StatusCode::BAD_GATEWAY);
        assert_eq!(upstream_status("blender_worker: 工作器返回 HTTP 500"), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn progress_records_phase_and_percent() {
        let p = model_progress("worker", 10);
        assert_eq!(p["phase"], "worker");
        assert_eq!(p["percent"], 10);
    }

    /// 工作器未配置/不可达时必须有明确错误，绝不能落到占位模型
    #[tokio::test]
    async fn missing_worker_is_reported_not_faked() {
        let previous = std::env::var("BLENDER_WORKER_URL").ok();
        std::env::remove_var("BLENDER_WORKER_URL");
        let err = require_worker().await.unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_IMPLEMENTED);
        assert!(err.1.contains("BLENDER_WORKER_URL"), "{}", err.1);
        // 配置了地址但端口无人监听 → 不可达
        std::env::set_var("BLENDER_WORKER_URL", "http://127.0.0.1:1");
        let err = require_worker().await.unwrap_err();
        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE);
        assert!(err.1.contains("不可达"), "{}", err.1);
        match previous {
            Some(v) => std::env::set_var("BLENDER_WORKER_URL", v),
            None => std::env::remove_var("BLENDER_WORKER_URL"),
        }
    }
}

#[cfg(test)]
mod provider_tests {
    use super::*;
    #[test]
    fn blocks_legacy_stubs_but_keeps_imports() {
        for provider in ["stub", "batch", "placeholder", "STUB", "stub_variant"] {
            assert!(reject_stub_meta(&json!({"provider": provider})).is_err());
        }
        for provider in ["import", "external_ai", "tripo", "blender"] {
            assert!(reject_stub_meta(&json!({"provider": provider})).is_ok());
        }
    }
}

#[cfg(test)]
mod reference_job_tests {
    use super::*;

    fn job(status: &str, started: u64, finished: Option<u64>) -> Value {
        json!({
            "job_id": "job_002", "kind": "reference_generate", "status": status,
            "created_at": started, "started_at": started, "finished_at": finished
        })
    }

    /// 统一陈旧判定的口径：只有 running + 无 finished_at + 超过 900 秒才算陈旧
    #[test]
    fn stale_only_when_running_without_result_past_deadline() {
        let now = 1_800_000_000u64;
        assert!(is_stale_job(&job("running", now - STALE_AFTER_SECS - 1, None), now));
        assert!(!is_stale_job(&job("running", now - STALE_AFTER_SECS, None), now));
        assert!(!is_stale_job(&job("running", now - 100, None), now));
        // 已有 finished_at（即便很旧）不再重复判定
        assert!(!is_stale_job(&job("running", now - 9_000, Some(now - 8_000)), now));
        assert!(!is_stale_job(&job("done", now - 9_000, None), now));
        assert!(!is_stale_job(&job("failed", now - 9_000, None), now));
        assert!(is_stale_job(&json!({"kind":"image_generate","status":"running","created_at":now-901}),now));
        assert!(!is_stale_job(&json!({"kind":"image_generate","status":"done","created_at":now-901}),now));
        // 非参考图任务不参与该判定
        assert!(!is_stale_job(&json!({"kind":"spec_generate","status":"running","created_at": now - 9_000}), now));
    }

    #[test]
    fn progress_records_completed_and_current_view() {
        let p = progress_json(1, Some("side"));
        assert_eq!(p["completed_views"], 1);
        assert_eq!(p["total_views"], 3);
        assert_eq!(p["current_view"], "side");
        assert_eq!(progress_json(3, None)["current_view"], Value::Null);
    }

    /// 建模/减面任务同样走后台任务，必须一起参与陈旧回收
    #[test]
    fn model_jobs_are_stale_tracked_too() {
        let now = 1_800_000_000u64;
        for kind in ["model_build", "model_process"] {
            assert!(is_stale_job(&json!({"kind": kind, "status": "running",
                "created_at": now - STALE_AFTER_SECS - 1}), now), "{kind}");
            assert!(!is_stale_job(&json!({"kind": kind, "status": "running",
                "created_at": now - 10}), now), "{kind}");
        }
        // 建模计划是同步接口，但客户端断开会丢下 running job，故同样参与回收
        assert!(is_stale_job(&json!({"kind": "model_plan", "status": "running",
            "created_at": now - STALE_AFTER_SECS - 1}), now));
        // 短任务（落盘即完成）不参与，避免把瞬时态误判为失败
        assert!(!is_stale_job(&json!({"kind": "import_version", "status": "running",
            "created_at": now - 9_000}), now));
    }

    #[test]
    fn stale_error_warns_about_possible_charge() {
        assert!(STALE_ERROR.contains("stale:"));
        assert!(STALE_ERROR.contains("可能已计费"));
        assert!(TIMEOUT_ERROR.contains("timeout:"));
    }
}

pub async fn proxy_file(
    State(st): State<Shared>,
    Path((dir, id, key)): Path<(String, String, String)>,
) -> ApiResult<Response> {
    check_dir(&dir)?;
    if key.contains("..") {
        return Err(e400("illegal key"));
    }
    let full = format!("{dir}/{id}/{key}");
    let bytes = st
        .store
        .get_bytes(&full)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("not found: {key}")))?;
    let ct = if key.ends_with(".png") {
        "image/png"
    } else if key.ends_with(".webp") {
        "image/webp"
    } else if key.ends_with(".glb") {
        "model/gltf-binary"
    } else if key.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    };
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, ct)
        .body(Body::from(bytes))
        .unwrap())
}
