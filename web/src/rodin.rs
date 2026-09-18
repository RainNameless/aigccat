//! Rodin (Hyper3D) 传输层。官方任务模型（docs.hyper3d.ai）：
//!   POST /rodin  multipart（prompt 文生 / images 图生，tier、mesh_mode、quality…）
//!                → {message, uuid, jobs:{uuids, subscription_key}, consumed}
//!   POST /status {"subscription_key"} → jobs 状态（全部 Done 才算完成，任一 Failed 立即失败）
//!   POST /download {"task_uuid"} → {list:[{url,name}]}
//! 鉴权：Authorization: Bearer。任务引用在本地存为 "uuid|subscription_key"。
use crate::providers::PollOutcome;
use crate::services::{bounded_body, Service};
use serde_json::{json, Value};
use std::time::Duration;

pub const TASK_TIMEOUT: Duration = Duration::from_secs(1800);

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    service: Service,
}

/// 提交后拿到的两个标识：uuid 用于下载，subscription_key 用于查状态。
/// 序列化成 "uuid|subscription_key" 存进任务记录，恢复时再拆开。
fn split_ref(task_ref: &str) -> Result<(String, String), String> {
    let (uuid, key) = task_ref.split_once('|').ok_or("Rodin 任务引用缺少 subscription_key")?;
    for part in [uuid, key] {
        if part.is_empty() || part.len() > 300 || !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("Rodin 任务标识无效".into());
        }
    }
    Ok((uuid.to_string(), key.to_string()))
}

fn valid_uuid(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 300 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Rodin 任务标识无效".into());
    }
    Ok(())
}

impl Client {
    pub fn new(service: Service) -> Result<Self, String> {
        if service.api_key.trim().is_empty() {
            return Err("请先在模型配置管理中填写 Rodin API Key（developer.hyper3d.ai 的 API Key 管理页生成）".into());
        }
        Ok(Self { http: reqwest::Client::builder().timeout(Duration::from_secs(120)).build().map_err(|_| "Rodin 客户端初始化失败".to_string())?, service })
    }
    fn url(&self, path: &str) -> String { format!("{}{path}", self.service.base_url.trim_end_matches('/')) }
    fn clean(&self, s: &str) -> String {
        s.replace(&self.service.api_key, "[已隐藏]").chars().filter(|c| !c.is_control()).take(400).collect()
    }
    async fn parse(&self, response: reqwest::Response) -> Result<Value, String> {
        let status = response.status().as_u16();
        let bytes = bounded_body(response, 2 * 1024 * 1024).await?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| format!("Rodin 响应无效（HTTP {status}）"))?;
        // HTTP 201 = 已受理；真正的失败以 error 字段为准
        if let Some(e) = v["error"].as_str() { if !e.is_empty() { return Err(format!("Rodin 拒绝请求：{}", self.clean(e))); } }
        if !(200..300).contains(&status) {
            let reason = match status { 401 | 403 => "Key 无效或无权限", 429 => "请求过于频繁", _ => "请求被拒绝" };
            let detail = v["message"].as_str().unwrap_or(reason);
            return Err(format!("Rodin HTTP {status}：{}", self.clean(detail)));
        }
        Ok(v)
    }
    /// 唯一一次付费提交。tier 必须显式给（官方说明：缺省会回落到 Gen-1/1.5 的 Regular）。
    pub async fn create_text(&self, prompt: &str) -> Result<String, String> {
        let form = reqwest::multipart::Form::new()
            .text("prompt", prompt.to_string())
            .text("tier", self.service.model.clone())
            .text("mesh_mode", "Raw")
            .text("geometry_file_format", "glb");
        self.create(form).await
    }
    pub async fn create_image(&self, png: Vec<u8>) -> Result<String, String> {
        let part = reqwest::multipart::Part::bytes(png).file_name("front.png").mime_str("image/png").map_err(|_| "图片类型无效")?;
        let form = reqwest::multipart::Form::new()
            .part("images", part)
            .text("tier", self.service.model.clone())
            .text("mesh_mode", "Raw")
            .text("geometry_file_format", "glb");
        self.create(form).await
    }
    async fn create(&self, form: reqwest::multipart::Form) -> Result<String, String> {
        let response = self.http.post(self.url("/rodin")).bearer_auth(&self.service.api_key)
            .multipart(form).send().await.map_err(crate::services::network_error)?;
        let v = self.parse(response).await?;
        let uuid = v["uuid"].as_str().ok_or("Rodin 响应缺少 uuid")?;
        let key = v["jobs"]["subscription_key"].as_str().ok_or("Rodin 响应缺少 subscription_key")?;
        valid_uuid(uuid)?; valid_uuid(key)?;
        Ok(format!("{uuid}|{key}"))
    }
    /// 轮询 + 完成后下载。全部 job Done 才取结果。
    pub async fn poll_once(&self, task_ref: &str) -> Result<PollOutcome, String> {
        let (_, key) = split_ref(task_ref)?;
        let response = self.http.post(self.url("/status")).bearer_auth(&self.service.api_key)
            .json(&json!({"subscription_key": key}))
            .send().await.map_err(crate::services::network_error)?;
        let v = self.parse(response).await?;
        let jobs = v["jobs"].as_array().cloned().unwrap_or_default();
        if jobs.is_empty() { return Err("Rodin 状态响应缺少 jobs 数组".into()); }
        let mut any_failed = None;
        let mut done = 0usize;
        for job in &jobs {
            let s = job["status"].as_str().unwrap_or_default().to_ascii_lowercase();
            if s.contains("fail") || s.contains("error") {
                any_failed = Some(job["message"].as_str().or(job["error"].as_str()).unwrap_or("Rodin 生成失败"));
            } else if s.contains("done") || s.contains("success") { done += 1; }
            // waiting/running 等一律继续轮询
        }
        if let Some(error) = any_failed { return Ok(PollOutcome::Failed { error: self.clean(error), credits: None }); }
        if done < jobs.len() {
            let percent = (done * 100 / jobs.len()) as u64;
            return Ok(PollOutcome::Running(percent));
        }
        // 全部完成 → 下载
        let (uuid, _) = split_ref(task_ref)?;
        let response = self.http.post(self.url("/download")).bearer_auth(&self.service.api_key)
            .json(&json!({"task_uuid": uuid}))
            .send().await.map_err(crate::services::network_error)?;
        let v = self.parse(response).await?;
        let list = v["list"].as_array().cloned().ok_or("Rodin 下载响应缺少 list 数组")?;
        let pick = list.iter().find(|f| f["name"].as_str().is_some_and(|n| n.to_ascii_lowercase().ends_with(".glb")))
            .or(list.first()).ok_or("Rodin 下载列表为空")?;
        let url = pick["url"].as_str().ok_or("Rodin 下载条目缺少 url")?;
        let glb = self.download(url, 150 * 1024 * 1024).await?;
        Ok(PollOutcome::Success { glb, preview: None, warning: None, credits: v["consumed"].as_f64().map(|c| json!(c)) })
    }
    /// 下载不带鉴权头；只允许公开 HTTPS。
    pub async fn download(&self, raw: &str, limit: usize) -> Result<Vec<u8>, String> {
        let url = reqwest::Url::parse(raw).map_err(|_| "Rodin 下载链接无效".to_string())?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err("Rodin 下载链接格式不安全".into());
        }
        let host = url.host_str().ok_or("Rodin 下载链接缺少主机")?;
        let test_local = cfg!(test) && host == "127.0.0.1";
        if !test_local && (url.scheme() != "https" || host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() || host.ends_with(".local")) {
            return Err("Rodin 下载链接必须使用公开 HTTPS 域名".into());
        }
        let response = self.http.get(url).send().await.map_err(crate::services::network_error)?;
        if !response.status().is_success() { return Err(format!("Rodin 下载失败（HTTP {}）", response.status().as_u16())); }
        bounded_body(response, limit).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn service() -> Service { Service { base_url: "https://api.hyper3d.com/api/v2".into(), model: "Gen-2.5-Medium".into(), api_key: "rodin-test".into() } }
    #[test]
    fn task_ref_roundtrip_and_validation() {
        let r = "d0b4c1e0-1111|sub-key_22";
        assert_eq!(split_ref(r).unwrap(), ("d0b4c1e0-1111".into(), "sub-key_22".into()));
        assert!(split_ref("no-separator").is_err());
        assert!(split_ref("|orphan").is_err());
        assert!(split_ref("has space|key").is_err());
    }
    #[test]
    fn empty_key_is_rejected_upfront() {
        let s = Service { base_url: "https://api.hyper3d.com/api/v2".into(), model: "Gen-2.5-Medium".into(), api_key: String::new() };
        match Client::new(s) { Err(e) => assert!(e.contains("Rodin API Key")), Ok(_) => panic!("空 Key 不应构造出客户端") }
    }
    #[test]
    fn credentials_never_leak() {
        let c = Client::new(service()).unwrap();
        assert_eq!(c.clean("boom rodin-test boom"), "boom [已隐藏] boom");
    }
}
