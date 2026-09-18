//! Hi3D (Hitem3D) 传输层。官方任务模型（docs.hitem3d.ai）：
//!   POST /submit-task  multipart（images / multi_images、request_type、model、resolution、face、pbr、format）
//!                      → {code:200, data:{task_id}, msg}
//!   GET  /query-task?task_id=… → {code, data:{state: created→queueing→processing→success/failed, url, cover_url}, msg}
//! 鉴权：Authorization: Bearer accessToken。注意：结果下载链接只有 1 小时有效期，完成后立即落盘。
use crate::services::{bounded_body, Service};
use serde_json::{json, Value};
use std::time::Duration;

pub const TASK_TIMEOUT: Duration = Duration::from_secs(1800);

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    service: Service,
}

fn valid_task_id(s: &str) -> Result<(), String> {
    // 官方示例含字母数字与 . _ -，长度放宽但拒绝路径穿越与空白
    if s.is_empty() || s.len() > 300 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("Hi3D 任务标识无效".into());
    }
    if s.contains("..") { return Err("Hi3D 任务标识无效".into()); }
    Ok(())
}

/// 各模型的默认分辨率：与官方文档的枚举对齐；不在清单里的模型不发送（用服务端默认 1024³）。
fn default_resolution(model: &str) -> Option<&'static str> {
    match model {
        "hi3dv3.0" => Some("2048quality"),
        "hitem3dv2.1" => Some("1536pro"),
        _ => None,
    }
}

impl Client {
    pub fn new(service: Service) -> Result<Self, String> {
        if service.api_key.trim().is_empty() {
            return Err("请先在模型配置管理中填写 Hi3D accessToken（Hitem3D 开放平台获取）".into());
        }
        Ok(Self { http: reqwest::Client::builder().timeout(Duration::from_secs(120)).build().map_err(|_| "Hi3D 客户端初始化失败".to_string())?, service })
    }
    fn url(&self, path: &str) -> String { format!("{}{path}", self.service.base_url.trim_end_matches('/')) }
    fn clean(&self, s: &str) -> String {
        s.replace(&self.service.api_key, "[已隐藏]").chars().filter(|c| !c.is_control()).take(400).collect()
    }
    async fn parse(&self, response: reqwest::Response) -> Result<Value, String> {
        let status = response.status().as_u16();
        let bytes = bounded_body(response, 2 * 1024 * 1024).await?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| format!("Hi3D 响应无效（HTTP {status}）"))?;
        if !(200..300).contains(&status) {
            let reason = match status { 401 | 403 => "accessToken 无效或过期", 429 => "请求过于频繁", _ => "请求被拒绝" };
            let detail = v["msg"].as_str().unwrap_or(reason);
            return Err(format!("Hi3D HTTP {status}：{}", self.clean(detail)));
        }
        // code 为字符串或数字都有出现，统一按非 200 视为失败
        let code_ok = v["code"].as_u64() == Some(200) || v["code"].as_str() == Some("200");
        if !code_ok { return Err(format!("Hi3D code {}：{}", v["code"], self.clean(v["msg"].as_str().unwrap_or("请求被拒绝")))); }
        Ok(v)
    }
    /// 唯一一次付费提交（request_type=3：几何+纹理一次出；format=2：GLB，本链路只消费 GLB）。
    pub async fn create_image(&self, png: Vec<u8>, pbr: bool) -> Result<String, String> {
        let part = reqwest::multipart::Part::bytes(png).file_name("front.png").mime_str("image/png").map_err(|_| "图片类型无效")?;
        let mut form = reqwest::multipart::Form::new()
            .part("images", part)
            .text("request_type", "3")
            .text("model", self.service.model.clone())
            .text("format", "2")
            .text("pbr", if pbr { "1" } else { "0" });
        if let Some(r) = default_resolution(&self.service.model) { form = form.text("resolution", r.to_string()); }
        let response = self.http.post(self.url("/submit-task")).bearer_auth(&self.service.api_key)
            .multipart(form).send().await.map_err(crate::services::network_error)?;
        let v = self.parse(response).await?;
        let task_id = v["data"]["task_id"].as_str().ok_or("Hi3D 响应缺少 task_id")?;
        valid_task_id(task_id)?;
        Ok(task_id.to_string())
    }
    /// 轮询 + 完成后下载（链接 1 小时有效，完成即取）。
    pub async fn poll_once(&self, task_id: &str) -> Result<crate::providers::PollOutcome, String> {
        valid_task_id(task_id)?;
        let response = self.http.get(self.url("/query-task")).bearer_auth(&self.service.api_key)
            .query(&[("task_id", task_id)])
            .send().await.map_err(crate::services::network_error)?;
        let v = self.parse(response).await?;
        let state = v["data"]["state"].as_str().unwrap_or_default();
        match state {
            "failed" => Ok(crate::providers::PollOutcome::Failed {
                error: self.clean(v["data"]["msg"].as_str().or(v["msg"].as_str()).unwrap_or("Hi3D 生成失败")),
                credits: None,
            }),
            "success" => {
                let url = v["data"]["url"].as_str().ok_or("Hi3D 成功响应没有模型链接")?;
                let glb = self.download(url, 150 * 1024 * 1024).await?;
                let mut preview = None;
                if let Some(cover) = v["data"]["cover_url"].as_str() {
                    if let Ok(bytes) = self.download(cover, 20 * 1024 * 1024).await {
                        if let Ok(img) = image::load_from_memory(&bytes) {
                            let mut output = std::io::Cursor::new(Vec::new());
                            if img.thumbnail(640, 640).write_to(&mut output, image::ImageFormat::Png).is_ok() {
                                preview = Some(output.into_inner());
                            }
                        }
                    }
                }
                Ok(crate::providers::PollOutcome::Success { glb, preview, warning: None, credits: None })
            }
            // created / queueing / processing 及一切未知状态继续轮询，不误判失败
            _ => Ok(crate::providers::PollOutcome::Running(0)),
        }
    }
    /// 下载不带鉴权头；只允许公开 HTTPS。
    pub async fn download(&self, raw: &str, limit: usize) -> Result<Vec<u8>, String> {
        let url = reqwest::Url::parse(raw).map_err(|_| "Hi3D 下载链接无效".to_string())?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err("Hi3D 下载链接格式不安全".into());
        }
        let host = url.host_str().ok_or("Hi3D 下载链接缺少主机")?;
        let test_local = cfg!(test) && host == "127.0.0.1";
        if !test_local && (url.scheme() != "https" || host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() || host.ends_with(".local")) {
            return Err("Hi3D 下载链接必须使用公开 HTTPS 域名".into());
        }
        let response = self.http.get(url).send().await.map_err(crate::services::network_error)?;
        if !response.status().is_success() {
            return Err(format!("Hi3D 下载失败（HTTP {}）；链接仅 1 小时有效，可重新查询原任务", response.status().as_u16()));
        }
        bounded_body(response, limit).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn service() -> Service { Service { base_url: "https://api.hitem3d.ai/open-api/v1".into(), model: "hi3dv3.0".into(), api_key: "hi3d-test".into() } }
    #[test]
    fn task_ids_follow_shape() {
        assert!(valid_task_id("2c2ad20cb3204697ba7f80351c3e8606.jjewelry-aigc-api.1NraEb5ohU").is_ok());
        assert!(valid_task_id("").is_err());
        assert!(valid_task_id("../etc/passwd").is_err());
        assert!(valid_task_id("has space").is_err());
    }
    #[test]
    fn resolution_follows_model() {
        assert_eq!(default_resolution("hi3dv3.0"), Some("2048quality"));
        assert_eq!(default_resolution("hitem3dv2.1"), Some("1536pro"));
        assert_eq!(default_resolution("hitem3dv2.0"), None);
    }
    #[test]
    fn empty_key_is_rejected_upfront() {
        let s = Service { base_url: "https://api.hitem3d.ai/open-api/v1".into(), model: "hi3dv3.0".into(), api_key: String::new() };
        match Client::new(s) { Err(e) => assert!(e.contains("accessToken")), Ok(_) => panic!("空 Key 不应构造出客户端") }
    }
}
