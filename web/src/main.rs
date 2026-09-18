//! aigccat web 后端
//!
//! 职责（严格限定）：
//! 1. 托管静态前端（web/static）
//! 2. 读写 MinIO 元数据（资产/spec/job/版本指针，见 assets.rs + store.rs）
//! 3. 调 OpenAI 生成 Spec 并自动分类（openai.rs）；长流程编排（阶段 3+）交 Windmill
//!
//! 不做：AI 多步编排逻辑（在 Windmill flow 内，Python 脚本执行）。

mod model_cache;
mod rig_agent;
mod assets;
mod blender;
mod config;
mod history;
mod imagegen;
mod model;
mod openai;
mod ops;
mod store;
mod services;
mod providers;
mod tripo;
mod meshy;
mod rodin;
mod hi3d;
mod hunyuan;
mod model_jobs;
mod studio_jobs;
mod validator;
mod workbench;

use assets::{create_asset, get_asset, list_assets, AppState};
use axum::{body::HttpBody, extract::Request, middleware::{self, Next}, response::{Json, Response}, routing::{get, post}, Router};
use config::AppConfig;
use ops::{
    ai_modify,
    approve_references,
    approve_version,
    backfill_posters,
    backfill_taxonomy,
    batch_run,
    compile_bundle,
    enrich_prompt,
    gen_model,
    gen_references,
    get_canvas,
    get_job,
    get_ledger,
    get_outline,
    get_style_profile,
    get_catalog,
    get_taxonomy,
    import_asset,
    import_version,
    proxy_file,
    publish_version,
    put_canvas,
    put_style_profile,
    process_version,
    push_file,
    reclassify,
    rollback,
    set_anchor,
    update_spec,
    upload_qa,
};
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::{services::ServeDir, compression::{CompressionLayer, CompressionLevel}};
use tracing_subscriber::EnvFilter;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

async fn healthz() -> Json<Health> {
    Json(Health {
        status: "ok",
        service: "aigccat-web",
        version: env!("CARGO_PKG_VERSION"),
    })
}

// Browsers report decoded stream bytes; retain that length across HTTP compression.
async fn resource_length(request: Request, next: Next) -> Response {
    let model = request.uri().path().ends_with(".glb");
    let mut response = next.run(request).await;
    if model {
        if let Some(length) = response.body().size_hint().exact() {
            if let Ok(value) = length.to_string().parse() {
                response.headers_mut().insert("x-resource-length", value);
            }
        }
    }
    response
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cfg = AppConfig::from_env();
    let store = store::Store::new(&cfg).expect("minio init failed");
    store.ensure_bucket().await;

    let state = Arc::new(AppState { cfg, store });
    let recovering = state.clone();
    tokio::spawn(async move { model_jobs::recover(recovering).await; });

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/assets/{dir}/{id}/versions/{ver}/model-cache", get(model_cache::validate))
        .route("/api/local-rig-agent/provider", post(rig_agent::provider).layer(axum::extract::DefaultBodyLimit::max(12 * 1024 * 1024)))
        .route("/api/local-rig-agent/{*path}", axum::routing::any(rig_agent::proxy))
        .route("/api/studio/status", get(studio_jobs::health))
        .route("/api/studio/session", get(studio_jobs::session_state).post(studio_jobs::session_action))
        .route("/api/assets/{dir}/{id}/versions/{ver}/studio-process", post(studio_jobs::process))
        .route("/api/assets", post(create_asset).get(list_assets))
        .route("/api/workbench/state", get(workbench::get_state).put(workbench::put_state))
        .route("/api/media/images", get(workbench::list_images))
        .route("/api/assets/{dir}/{id}/images", post(workbench::generate_images))
        .route("/api/assets/{dir}/{id}", get(get_asset))
        // 历史树（append-only、分支保留；checkout 只移动 HEAD）
        .route("/api/assets/{dir}/{id}/history", get(history::get_history))
        .route("/api/assets/{dir}/{id}/history/checkout", post(history::checkout))
        // 任务检查点（计划步骤 + append-only 事件流）
        .route("/api/assets/{dir}/{id}/tasks", post(history::create_task).get(history::list_tasks))
        .route("/api/assets/{dir}/{id}/tasks/{task_id}", get(history::get_task))
        .route("/api/assets/{dir}/{id}/tasks/{task_id}/events", post(history::append_task_event))
        .route("/api/assets/{dir}/{id}/jobs/{job}", get(get_job))
        .route("/api/assets/{dir}/{id}/references", post(gen_references))
        .route("/api/assets/{dir}/{id}/references/approve", post(approve_references))
        .route("/api/assets/{dir}/{id}/plan", post(|| async { (axum::http::StatusCode::GONE,"视觉建模计划已移除，请在首页直接调用 Tripo 生成模型") }))
        .route("/api/assets/{dir}/{id}/model", post(gen_model))
        .route("/api/assets/{dir}/{id}/jobs/{job}/resume", post(model_jobs::resume))
        .route("/api/assets/{dir}/{id}/versions/{ver}/process", post(process_version))
        .route("/api/assets/{dir}/{id}/versions/{ver}/approve", post(approve_version))
        .route("/api/assets/{dir}/{id}/versions/{ver}/publish", post(publish_version))
        .route("/api/assets/{dir}/{id}/rollback", post(rollback))
        .route("/api/assets/{dir}/{id}/reclassify", post(reclassify))
        .route(
            "/api/assets/{dir}/{id}/file/{*key}",
            get(proxy_file).put(push_file).layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        // High-detail GLB + 8K textures, including JSON base64 overhead.
        .route("/api/assets/{dir}/{id}/versions/import", post(import_version).layer(axum::extract::DefaultBodyLimit::max(768 * 1024 * 1024)))
        .route("/api/assets/{dir}/{id}/versions/{ver}/qa", post(upload_qa))
        .route("/api/assets/{dir}/{id}/versions/{ver}/anchor", post(set_anchor))
        .route("/api/assets/{dir}/{id}/versions/{ver}/outline", get(get_outline))
        .route("/api/assets/{dir}/{id}/versions/{ver}/compile", post(compile_bundle))
        .route("/api/prompt/enrich", post(enrich_prompt))
        .route("/api/assets/import", post(import_asset).layer(axum::extract::DefaultBodyLimit::max(160 * 1024 * 1024)))
        .route("/api/canvas", get(get_canvas).put(put_canvas))
        .route("/api/taxonomy", get(get_taxonomy))
        .route("/api/taxonomy/catalog", get(get_catalog))
        .route("/api/taxonomy/backfill", post(backfill_taxonomy))
        .route("/api/backfill/posters", post(backfill_posters))
        .route("/api/assets/{dir}/{id}/modify", post(ai_modify))
        .route("/api/assets/{dir}/{id}/spec", axum::routing::put(update_spec))
        .route("/api/styleprofile", get(get_style_profile).put(put_style_profile))
        .route("/api/ledger", get(get_ledger))
        .route("/api/batch", post(batch_run))
        // 静态前端：web/static
        .fallback_service(ServeDir::new("static"))
        .route("/api/settings/services", get(services::get_services).put(services::put_services))
        .route("/api/settings/services/test", post(services::test_services))
        .route("/api/settings/services/models", get(services::service_models))
        .route("/api/settings/catalog", get(services::get_catalog).put(services::put_catalog))
        .route("/api/settings/accounts", post(services::post_account))
        .route("/api/settings/accounts/{id}", axum::routing::patch(services::patch_account).delete(services::delete_account))
        .route("/api/settings/accounts/{id}/capture", post(services::capture_account))
        .route("/api/services/health", get(services::services_health))
        .layer(middleware::from_fn(resource_length))
        .layer(CompressionLayer::new().quality(CompressionLevel::Fastest))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("aigccat-web listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}
