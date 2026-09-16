//! 宿主机 Blender 工作器客户端（真实几何引擎：按建模计划构建 GLB / 减面 / 重拓扑）
//!
//! 容器内的 web 服务无法直接调用宿主机 Blender，只能通过 HTTP 访问宿主机工作器
//! （scripts/blender/worker_server.py）。工作器契约：
//!   GET  {BLENDER_WORKER_URL}/healthz -> {"ok":true,"blender":"Blender 5.2.1 LTS"}
//!   POST {BLENDER_WORKER_URL}/build   -> {"glb_b64":..,"bytes":..,"stats":..} 或 {"error":..}
//!     payload ① {"plan":{parts:[...]}}
//!     payload ② {"glb_b64":..,"operation":"decimate"|"remesh","ratio":0.5,"voxel_size":0.05}
//!
//! 红线：本模块只做真实调用，失败一律返回明确错误，绝不生成占位/伪几何。

use base64::Engine as _;
use serde_json::{json, Value};
use std::time::Duration;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(8);
/// 单次 Blender 作业上限（与工作器内部 600s 子进程超时对齐并留余量）
const BUILD_TIMEOUT: Duration = Duration::from_secs(900);
/// 响应体上限：GLB 经 base64 膨胀约 1.33 倍，64MB 足够工程用途
const MAX_BODY: usize = 64 * 1024 * 1024;
/// 工作器返回的错误文本截断长度（避免把宿主机路径等细节整段带回前端）
const MAX_ERROR_CHARS: usize = 300;

/// compose 里的默认值见 BLENDER_WORKER_URL（http://host.docker.internal:8788）
const UNCONFIGURED: &str = concat!(
    "blender_unconfigured: 未配置建模工作器（BLENDER_WORKER_URL，默认 http://host.docker.internal:8788）。",
    "请在 compose 中为 web 服务加 extra_hosts: host.docker.internal:host-gateway，并在宿主机启动 scripts/blender/worker_server.py",
);

/// 已配置的工作器地址；未配置（空值）返回 None。
pub fn worker_url() -> Option<String> {
    std::env::var("BLENDER_WORKER_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub configured: bool,
    pub reachable: bool,
    pub version: Option<String>,
}

impl Status {
    pub fn json(&self) -> Value {
        json!({ "configured": self.configured, "reachable": self.reachable, "version": self.version })
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| "network: 建模工作器客户端初始化失败".to_string())
}

/// 工作器错误文本清洗：只保留可打印字符并截断，避免路径/堆栈等内部细节外泄。
fn sanitize_error(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_ERROR_CHARS)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "工作器返回了空错误".to_string()
    } else {
        cleaned.to_string()
    }
}

fn network_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout: 建模工作器超时未返回结果（Blender 可能仍在执行，请勿重复提交）".into()
    } else if e.is_connect() {
        "unreachable: 无法连接建模工作器，请确认宿主机 scripts/blender/worker_server.py 已启动、"
            .to_string()
            + "且容器可通过 host.docker.internal 访问宿主机端口"
    } else {
        "network: 无法连接建模工作器或读取响应".into()
    }
}

async fn health(url: &str) -> Result<String, String> {
    let resp = client(HEALTH_TIMEOUT)?
        .get(format!("{}/healthz", url.trim_end_matches('/')))
        .send()
        .await
        .map_err(network_error)?;
    if !resp.status().is_success() {
        return Err(format!("blender_worker: 工作器健康检查返回 HTTP {}", resp.status().as_u16()));
    }
    let body = crate::services::bounded_body(resp, 65536).await?;
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| "blender_worker: 工作器健康检查响应不是有效 JSON".to_string())?;
    if value["ok"].as_bool() != Some(true) {
        return Err(format!("blender_worker: 工作器健康检查未确认可用（{}）", sanitize_error(value["error"].as_str().unwrap_or("无说明"))));
    }
    let version = value["blender"].as_str().unwrap_or("").trim();
    if version.is_empty() {
        return Err("blender_worker: 工作器未返回 Blender 版本".into());
    }
    Ok(version.to_string())
}

/// 工作器状态：configured 只看是否配置地址，reachable 必须真实 ping 通 healthz。
pub async fn status() -> Status {
    match worker_url() {
        None => Status { configured: false, reachable: false, version: None },
        Some(url) => match health(&url).await {
            Ok(version) => Status { configured: true, reachable: true, version: Some(version) },
            Err(e) => {
                tracing::warn!(error = %e, "blender worker health check failed");
                Status { configured: true, reachable: false, version: None }
            }
        },
    }
}

/// 取工作器地址，未配置直接报错（调用方据此返回"要求配置"的明确错误）。
pub fn require_url() -> Result<String, String> {
    worker_url().ok_or_else(|| UNCONFIGURED.to_string())
}

/// 提交一次 /build 请求，解析出 (GLB 字节, stats)。
async fn post_build(payload: &Value) -> Result<(Vec<u8>, Value, Option<Vec<u8>>), String> {
    let url = require_url()?;
    let resp = client(BUILD_TIMEOUT)?
        .post(format!("{}/build", url.trim_end_matches('/')))
        .json(payload)
        .send()
        .await
        .map_err(network_error)?;
    let status = resp.status();
    if !status.is_success() {
        let body = crate::services::bounded_body(resp, 65536).await?;
        let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        return Err(format!("blender_worker: HTTP {} · {}", status.as_u16(), sanitize_error(value["error"].as_str().unwrap_or("工作器未返回错误说明"))));
    }
    let body = crate::services::bounded_body(resp, MAX_BODY).await?;
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| "blender_worker: 工作器响应不是有效 JSON".to_string())?;
    if let Some(err) = value["error"].as_str() {
        return Err(format!("blender_worker: {}", sanitize_error(err)));
    }
    let b64 = value["glb_b64"]
        .as_str()
        .ok_or_else(|| "blender_worker: 工作器未返回 glb_b64".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "blender_worker: 工作器返回的 glb_b64 无法解码".to_string())?;
    // 不信任工作器自述：拿到的一定要是 GLB 才能进入版本库
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" {
        return Err("blender_worker: 工作器返回的内容不是合法 GLB".into());
    }
    // 工作器顺带渲染的正视图缩略图（可选）：有模型就该有预览，
    // 失败不影响模型交付，调用方按 None 处理。
    let preview = value["preview_b64"].as_str().and_then(|b64| {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .ok()
            .filter(|png| png.len() > 8 && &png[0..4] == b"\x89PNG")
    });
    Ok((bytes, value["stats"].clone(), preview))
}

/// 依据建模计划构建 GLB。返回 (glb, stats, 可选缩略图 PNG)。
pub async fn build(plan: &Value) -> Result<(Vec<u8>, Value, Option<Vec<u8>>), String> {
    post_build(&json!({ "plan": plan })).await
}

/// 对已有 GLB 做减面 / 重拓扑。返回 (glb, stats, 可选缩略图 PNG)。
pub async fn process(
    glb: &[u8],
    operation: &str,
    ratio: Option<f64>,
    voxel_size: Option<f64>,
    options: &Value,
) -> Result<(Vec<u8>, Value, Option<Vec<u8>>), String> {
    use base64::Engine;
    let mut payload = json!({
        "glb_b64": base64::engine::general_purpose::STANDARD.encode(glb),
        "operation": operation,
        "options": options,
    });
    if let Some(r) = ratio {
        payload["ratio"] = json!(r);
    }
    if let Some(v) = voxel_size {
        payload["voxel_size"] = json!(v);
    }
    post_build(&payload).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 环境变量是进程级全局状态，必须放在同一个用例里串行验证，避免并行用例互相干扰。
    #[test]
    fn url_resolution_and_unconfigured_message() {
        let previous = std::env::var("BLENDER_WORKER_URL").ok();
        std::env::set_var("BLENDER_WORKER_URL", "http://host.docker.internal:8788/");
        assert_eq!(worker_url().as_deref(), Some("http://host.docker.internal:8788"));
        std::env::set_var("BLENDER_WORKER_URL", "  ");
        assert_eq!(worker_url(), None);
        std::env::remove_var("BLENDER_WORKER_URL");
        let err = require_url().unwrap_err();
        assert!(err.starts_with("blender_unconfigured:"), "{err}");
        assert!(err.contains("host.docker.internal"), "{err}");
        match previous {
            Some(v) => std::env::set_var("BLENDER_WORKER_URL", v),
            None => std::env::remove_var("BLENDER_WORKER_URL"),
        }
    }

    #[test]
    fn status_shape_matches_contract() {
        let unreachable = Status { configured: true, reachable: false, version: None }.json();
        assert_eq!(unreachable["configured"], true);
        assert_eq!(unreachable["reachable"], false);
        assert_eq!(unreachable["version"], Value::Null);
        let ok = Status { configured: true, reachable: true, version: Some("Blender 5.2.1 LTS".into()) }.json();
        assert_eq!(ok["version"], "Blender 5.2.1 LTS");
    }

    #[test]
    fn worker_errors_are_truncated_and_printable() {
        let raw = format!("boom\n\u{7}{}", "x".repeat(1000));
        let out = sanitize_error(&raw);
        assert!(out.chars().count() <= MAX_ERROR_CHARS);
        assert!(!out.contains('\n') && !out.contains('\u{7}'));
        assert!(sanitize_error("").contains("空错误"));
        assert!(sanitize_error("   ").contains("空错误"));
    }
}
