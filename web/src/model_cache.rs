//! Lightweight source validation for browser-owned model caches. Never downloads the GLB.
use axum::{extract::{Path, State}, http::StatusCode, Json};
use serde_json::{json, Value};
use std::sync::Arc;
use crate::assets::AppState;
fn valid(dir: &str, id: &str, ver: &str) -> bool {
    [dir,id].iter().all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'_' || b==b'-'))
        && ver.starts_with('v') && ver.len()>1 && ver[1..].bytes().all(|b| b.is_ascii_digit())
}
pub async fn validate(State(st): State<Arc<AppState>>, Path((dir,id,ver)): Path<(String,String,String)>) -> Result<([( &'static str, &'static str);1],Json<Value>),(StatusCode,String)> {
    if !valid(&dir,&id,&ver) { return Err((StatusCode::BAD_REQUEST,"模型路径无效".into())); }
    let value=st.store.object_identity(&format!("{dir}/{id}/versions/{ver}/model.glb")).await
        .map_err(|_| (StatusCode::NOT_FOUND,"无法校验模型文件，请刷新资产后重试".into()))?;
    Ok(([("cache-control","private, no-store")],Json(json!({"etag":value.0,"size":value.1}))))
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn only_model_version_paths() {
        assert!(valid("characters","chr_test_241","v002"));
        for (d,i,v) in [("..","id","v001"),("animals","../id","v001"),("animals","id","v"),("animals","id","v1/../key")] { assert!(!valid(d,i,v)); }
    }
}
