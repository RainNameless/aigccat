//! Meshy 传输层。提交一次、只轮询不重发；下载链接同样“先落盘再展示”。
//!
//! 官方任务模型（docs.meshy.ai）：
//!   POST /text-to-3d  {prompt, mode:"preview", ...}        → {"result":"<task_id>"}
//!   POST /image-to-3d {image_url:"data:image/png;base64,…"} → {"result":"<task_id>"}
//!   GET  /text-to-3d/{task_id} / /image-to-3d/{task_id}     → {status,progress,model_urls{glb,…},thumbnail_url}
//! 鉴权：Authorization: Bearer msy_…。状态机 PENDING→IN_PROGRESS→SUCCEEDED/FAILED/CANCELED。
//! 参考图无法公开托管（本服务 MinIO 只在内网），Meshy 接受 base64 data URI，直接内联提交。
use crate::services::{bounded_body, Service};
use serde_json::{json, Value};
use std::time::Duration;

pub const TASK_TIMEOUT: Duration = Duration::from_secs(1800);

pub struct Client {
    http: reqwest::Client,
    service: Service,
    /// 提交用的路由（text-to-3d / image-to-3d），轮询走同一路由 + /{task_id}
    route: &'static str,
}

fn valid_task_id(s: &str) -> Result<(), String> {
    // 官方示例是 UUID，但长度上限按通用任务号放宽；不允许路径穿越字符
    if s.is_empty() || s.len() > 200 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Meshy 任务标识无效".into());
    }
    Ok(())
}

impl Client {
    pub fn new(service: Service, image_mode: bool) -> Result<Self, String> {
        if service.api_key.trim().is_empty() {
            return Err("请先在模型配置管理中填写 Meshy API Key（msy_ 开头）".into());
        }
        Ok(Self {
            http: reqwest::Client::builder().timeout(Duration::from_secs(120)).build().map_err(|_| "Meshy 客户端初始化失败".to_string())?,
            service,
            route: if image_mode { "image-to-3d" } else { "text-to-3d" },
        })
    }
    pub fn model(&self) -> &str { &self.service.model }
    fn url(&self, suffix: &str) -> String {
        // 注意两段斜杠：base 与 route 之间、route 与 suffix 之间
        format!("{}/{}/{suffix}", self.service.base_url.trim_end_matches('/'), self.route)
    }
    fn clean(&self, s: &str) -> String {
        s.replace(&self.service.api_key, "[已隐藏]").chars().filter(|c| !c.is_control()).take(400).collect()
    }
    async fn parse(&self, response: reqwest::Response) -> Result<Value, String> {
        let status = response.status().as_u16();
        let bytes = bounded_body(response, 2 * 1024 * 1024).await?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| format!("Meshy 响应无效（HTTP {status}）"))?;
        if !(200..300).contains(&status) {
            let reason = match status {
                401 | 403 => "Key 无效或无权限",
                402 => "账户积分不足",
                429 => "请求过于频繁",
                _ => "请求被拒绝",
            };
            let detail = v["message"].as_str().or(v["error"]["message"].as_str()).unwrap_or(reason);
            return Err(format!("Meshy HTTP {status}：{}", self.clean(detail)));
        }
        Ok(v)
    }
    /// 唯一一次付费 POST。语义不明的响应绝不能触发第二次提交。
    pub async fn create_text(&self, prompt: &str, pbr: bool) -> Result<String, String> {
        let payload = json!({"prompt": prompt, "mode": "preview", "enable_pbr": pbr, "topology": "quad"});
        self.create(&payload).await
    }
    pub async fn create_image(&self, png_b64: &str, prompt: &str) -> Result<String, String> {
        let mut payload = json!({"image_url": format!("data:image/png;base64,{png_b64}")});
        // 文字引导贴图是可选增强；空串不发送，保持请求干净
        if !prompt.trim().is_empty() { payload["texture_prompt"] = json!(prompt.trim()); }
        self.create(&payload).await
    }
    async fn create(&self, payload: &Value) -> Result<String, String> {
        let response = self.http.post(self.url("")).bearer_auth(&self.service.api_key).json(payload)
            .send().await.map_err(crate::services::network_error)?;
        let data = self.parse(response).await?;
        let task_id = data["result"].as_str().ok_or("Meshy 响应缺少任务编号（result）")?;
        valid_task_id(task_id)?;
        Ok(task_id.to_string())
    }
    pub async fn task(&self, task_id: &str) -> Result<Value, String> {
        valid_task_id(task_id)?;
        let response = self.http.get(self.url(task_id)).bearer_auth(&self.service.api_key)
            .send().await.map_err(crate::services::network_error)?;
        self.parse(response).await
    }
    /// 下载客户端不携带鉴权头；签名链接永不入库。
    pub async fn download(&self, raw: &str, limit: usize) -> Result<Vec<u8>, String> {
        let url = reqwest::Url::parse(raw).map_err(|_| "Meshy 下载链接无效".to_string())?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err("Meshy 下载链接格式不安全".into());
        }
        let host = url.host_str().ok_or("Meshy 下载链接缺少主机")?;
        let test_local = cfg!(test) && host == "127.0.0.1";
        if !test_local && (url.scheme() != "https" || host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() || host.ends_with(".local")) {
            return Err("Meshy 下载链接必须使用公开 HTTPS 域名".into());
        }
        let response = self.http.get(url).send().await.map_err(crate::services::network_error)?;
        if !response.status().is_success() {
            return Err(format!("Meshy 下载失败（HTTP {}）；资产链接仅保留有限时间，可重新查询原任务", response.status().as_u16()));
        }
        bounded_body(response, limit).await
    }
}

/// 把 Meshy 的任务状态归一成本链路通用的三态：running / failed / success。
pub fn normalize_status(status: &str) -> &'static str {
    match status {
        "SUCCEEDED" => "success",
        "FAILED" | "CANCELED" => "failed",
        // PENDING / IN_PROGRESS 及一切未知状态都继续轮询；未知状态不会误判成失败
        _ => "running",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn service() -> Service { Service { base_url: "https://api.meshy.ai/openapi/v2".into(), model: "latest".into(), api_key: "msy_test".into() } }
    #[test]
    fn task_ids_follow_shape() {
        assert!(valid_task_id("018a210d-8ba4-705c-b111-1f1776f7f578").is_ok());
        assert!(valid_task_id("").is_err());
        assert!(valid_task_id("../etc").is_err());
        assert!(valid_task_id("id with space").is_err());
        assert!(valid_task_id(&"x".repeat(201)).is_err());
    }
    #[test]
    fn statuses_normalize_without_false_failures() {
        assert_eq!(normalize_status("PENDING"), "running");
        assert_eq!(normalize_status("IN_PROGRESS"), "running");
        assert_eq!(normalize_status("WHATEVER"), "running");
        assert_eq!(normalize_status("SUCCEEDED"), "success");
        assert_eq!(normalize_status("FAILED"), "failed");
        assert_eq!(normalize_status("CANCELED"), "failed");
    }
    #[test]
    fn empty_key_is_rejected_upfront() {
        let s = Service { base_url: "https://api.meshy.ai/openapi/v2".into(), model: "latest".into(), api_key: String::new() };
        match Client::new(s, false) {
            Err(e) => assert!(e.contains("Meshy API Key"), "错误信息应指向 Key 配置：{e}"),
            Ok(_) => panic!("空 Key 不应构造出客户端"),
        }
    }
    #[test]
    fn route_depends_on_mode() {
        let text = Client::new(service(), false).unwrap();
        let image = Client::new(service(), true).unwrap();
        assert!(text.url("").ends_with("/text-to-3d/"));
        assert!(image.url("").ends_with("/image-to-3d/"));
    }
    #[test]
    fn credentials_never_leak_in_errors() {
        let c = Client::new(service(), false).unwrap();
        assert_eq!(c.clean("boom msy_test boom"), "boom [已隐藏] boom");
    }
}
