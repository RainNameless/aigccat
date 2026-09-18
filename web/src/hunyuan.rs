//! Hunyuan3D（腾讯混元生3D 极速版）传输层。官方任务模型（cloud.tencent.com/document/product/1804）：
//!   POST /  X-TC-Action: SubmitHunyuanTo3DRapidJob  {Prompt | ImageBase64, ResultFormat, EnablePBR}
//!           → {"Response":{"JobId"}}
//!   POST /  X-TC-Action: QueryHunyuanTo3DRapidJob  {"JobId"}
//!           → {"Response":{"Status":"WAIT|RUN|FAIL|DONE", "ErrorCode", "ErrorMessage", "ResultFile3Ds"}}
//! 鉴权：腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名 —— 密钥是 **SecretId:SecretKey**（英文冒号分隔，
//! 在后台模型配置的 Key 栏里这样填写；环境变量 HUNYUAN_SECRET_ID / HUNYUAN_SECRET_KEY 也可）。
//! 地域可用 HUNYUAN_REGION 覆盖（默认 ap-guangzhou）。
use crate::services::{bounded_body, Service};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

pub const TASK_TIMEOUT: Duration = Duration::from_secs(1800);
const VERSION: &str = "2025-05-13";

type HmacSha256 = Hmac<Sha256>;

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes { out.push_str(&format!("{b:02x}")); }
    out
}

/// unix 秒 → UTC 日期（Howard Hinnant 的 civil_from_days；不引 chrono，行为有单测钉死）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn utc_date_string(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    host: String,
    region: String,
    secret_id: String,
    secret_key: String,
    #[allow(dead_code)] // 供排障日志使用；错误信息里绝不输出
    service: Service,
}

fn split_credentials(api_key: &str) -> Result<(String, String), String> {
    let (id, key) = api_key.split_once(':')
        .ok_or("混元的密钥格式是 SecretId:SecretKey（英文冒号分隔）；请在后台模型配置里按这个格式填写")?;
    if id.trim().is_empty() || key.trim().is_empty() {
        return Err("混元的 SecretId / SecretKey 不能为空".into());
    }
    Ok((id.to_string(), key.to_string()))
}

fn hmac_sha256(key: &[u8], msg: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 可接受任意长度密钥");
    mac.update(msg.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

impl Client {
    pub fn new(service: Service) -> Result<Self, String> {
        let (secret_id, secret_key) = split_credentials(service.api_key.trim())?;
        let url = reqwest::Url::parse(service.base_url.trim_end_matches('/'))
            .map_err(|_| "混元接入地址无效".to_string())?;
        if url.scheme() != "https" { return Err("混元接入地址必须是 HTTPS".into()); }
        let host = url.host_str().ok_or("混元接入地址缺少主机")?.to_string();
        let region = std::env::var("HUNYUAN_REGION").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            .unwrap_or_else(|| "ap-guangzhou".into());
        Ok(Self { http: reqwest::Client::builder().timeout(Duration::from_secs(120)).build().map_err(|_| "混元客户端初始化失败".to_string())?, host, region, secret_id, secret_key, service })
    }

    /// TC3-HMAC-SHA256 签名请求。签名只覆盖 content-type 与 host（按官方规范），
    /// X-TC-* 公共参数不参与签名。
    async fn call(&self, action: &str, payload: &Value) -> Result<Value, String> {
        let body = serde_json::to_vec(payload).map_err(|_| "混元请求序列化失败".to_string())?;
        let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "系统时间异常")?.as_secs();
        let date = utc_date_string(timestamp);
        let hashed_payload = hex(&Sha256::digest(&body));
        let canonical_request = format!(
            "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{}\n\ncontent-type;host\n{hashed_payload}",
            self.host
        );
        let credential_scope = format!("{date}/tencentcloud/tc3_request");
        let string_to_sign = format!(
            "TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{}",
            hex(&Sha256::digest(canonical_request.as_bytes()))
        );
        // 派生密钥链：SecretDate → SecretService → SecretSigning → Signature
        let k_date = hmac_sha256(format!("TC3{}", self.secret_key).as_bytes(), &date);
        let k_service = hmac_sha256(&k_date, "tencentcloud");
        let k_signing = hmac_sha256(&k_service, "tc3_request");
        let signature = hex(&hmac_sha256(&k_signing, &string_to_sign));
        let authorization = format!(
            "TC3-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders=content-type;host, Signature={signature}",
            self.secret_id
        );
        let response = self.http.post(format!("https://{}/", self.host))
            .header("Authorization", authorization)
            .header("Content-Type", "application/json; charset=utf-8")
            .header("X-TC-Action", action)
            .header("X-TC-Timestamp", timestamp.to_string())
            .header("X-TC-Version", VERSION)
            .header("X-TC-Region", self.region.as_str())
            .body(body)
            .send().await.map_err(crate::services::network_error)?;
        let status = response.status().as_u16();
        let bytes = bounded_body(response, 2 * 1024 * 1024).await?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| format!("混元响应无效（HTTP {status}）"))?;
        if !(200..300).contains(&status) {
            let reason = match status { 401 | 403 => "签名或密钥无效", 429 => "请求过于频繁", _ => "请求被拒绝" };
            return Err(format!("混元 HTTP {status}：{reason}"));
        }
        if let Some(code) = v["Response"]["Error"]["Code"].as_str() {
            let message = v["Response"]["Error"]["Message"].as_str().unwrap_or("无详细信息");
            return Err(format!("混元 {}：{}", code, message));
        }
        Ok(v["Response"].clone())
    }

    /// 唯一一次付费提交。文生走 Prompt（≤200 字，入口已校验）；图生把参考图 base64 内联。
    pub async fn create(&self, prompt: Option<&str>, image_b64: Option<&str>, pbr: bool) -> Result<String, String> {
        let mut payload = json!({"ResultFormat": "GLB", "EnablePBR": pbr});
        if let Some(p) = prompt {
            if p.chars().count() > 200 { return Err("混元文生 3D 的描述上限是 200 字，请精简后重试".into()); }
            payload["Prompt"] = json!(p);
        } else if let Some(b64) = image_b64 {
            // 官方限制：编码后 ≤6MB（约 4.6MB 原图）
            if b64.len() > 6 * 1024 * 1024 { return Err("参考图过大（混元上限约 4.6MB 原始图片），请压缩后重试".into()); }
            payload["ImageBase64"] = json!(b64);
        } else {
            return Err("混元提交缺少 Prompt 或图片".into());
        }
        let response = self.call("SubmitHunyuanTo3DRapidJob", &payload).await?;
        let job_id = response["JobId"].as_str().ok_or("混元响应缺少 JobId")?;
        if job_id.is_empty() || job_id.len() > 200 || !job_id.chars().all(|c| c.is_ascii_digit()) {
            return Err("混元任务标识无效".into());
        }
        Ok(job_id.to_string())
    }

    /// 轮询 + 完成后下载。Status：WAIT/RUN 继续等；FAIL 取 ErrorCode/ErrorMessage；DONE 取 ResultFile3Ds。
    pub async fn poll_once(&self, job_id: &str) -> Result<crate::providers::PollOutcome, String> {
        let response = self.call("QueryHunyuanTo3DRapidJob", &json!({"JobId": job_id})).await?;
        match response["Status"].as_str().unwrap_or_default() {
            "FAIL" => Ok(crate::providers::PollOutcome::Failed {
                error: format!("{}：{}", response["ErrorCode"].as_str().unwrap_or("未知错误"), response["ErrorMessage"].as_str().unwrap_or("混元生成失败")),
                credits: None,
            }),
            "DONE" => {
                let files = response["ResultFile3Ds"].as_array().cloned().unwrap_or_default();
                if files.is_empty() { return Err("混元成功响应没有 ResultFile3Ds".into()); }
                // 优先 GLB；字段名按官方数据结构，做一层宽容解析
                let pick = files.iter().find(|f| f["Type"].as_str().is_some_and(|t| t.eq_ignore_ascii_case("GLB"))).or(files.first()).unwrap();
                let url = pick["Url"].as_str().or(pick["url"].as_str()).or(pick["FileUrl"].as_str()).ok_or("混元结果缺少下载链接")?;
                let glb = self.download(url, 150 * 1024 * 1024).await?;
                Ok(crate::providers::PollOutcome::Success { glb, preview: None, warning: None, credits: None })
            }
            // WAIT / RUN / 未知状态一律继续轮询
            _ => Ok(crate::providers::PollOutcome::Running(0)),
        }
    }

    /// 下载不带鉴权头；只允许公开 HTTPS。
    pub async fn download(&self, raw: &str, limit: usize) -> Result<Vec<u8>, String> {
        let url = reqwest::Url::parse(raw).map_err(|_| "混元下载链接无效".to_string())?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err("混元下载链接格式不安全".into());
        }
        let host = url.host_str().ok_or("混元下载链接缺少主机")?;
        let test_local = cfg!(test) && host == "127.0.0.1";
        if !test_local && (url.scheme() != "https" || host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() || host.ends_with(".local")) {
            return Err("混元下载链接必须使用公开 HTTPS 域名".into());
        }
        let response = self.http.get(url).send().await.map_err(crate::services::network_error)?;
        if !response.status().is_success() { return Err(format!("混元下载失败（HTTP {}）", response.status().as_u16())); }
        bounded_body(response, limit).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn service() -> Service { Service { base_url: "https://ai3d.tencentcloudapi.com".into(), model: "hunyuan-to3d-rapid".into(), api_key: "AKIDtest:test-secret".into() } }
    #[test]
    fn utc_dates_are_exact() {
        // 断言值全部用 date -u 实测核对，不手算
        assert_eq!(utc_date_string(0), "1970-01-01");
        assert_eq!(utc_date_string(86_399), "1970-01-01");
        assert_eq!(utc_date_string(86_400), "1970-01-02");
        assert_eq!(utc_date_string(951_782_400), "2000-02-29");
        assert_eq!(utc_date_string(1_709_164_800), "2024-02-29");
        assert_eq!(utc_date_string(1_693_526_400), "2023-09-01");
        assert_eq!(utc_date_string(1_789_603_200), "2026-09-17");
    }
    #[test]
    fn credentials_split_on_first_colon() {
        let (id, key) = split_credentials("AKIDabc:xyz-secret-with:colon").unwrap();
        assert_eq!(id, "AKIDabc");
        assert_eq!(key, "xyz-secret-with:colon");
        assert!(split_credentials("no-colon").unwrap_err().contains("SecretId:SecretKey"));
        assert!(split_credentials(":orphan").is_err());
    }
    #[test]
    fn empty_key_is_rejected_upfront() {
        let s = Service { base_url: "https://ai3d.tencentcloudapi.com".into(), model: "hunyuan-to3d-rapid".into(), api_key: String::new() };
        match Client::new(s) {
            Err(e) => assert!(e.contains("SecretId:SecretKey"), "错误信息应指向密钥格式：{e}"),
            Ok(_) => panic!("空 Key 不应构造出客户端"),
        }
    }
    #[test]
    fn hmac_chain_is_deterministic() {
        let a = hmac_sha256(b"key", "msg");
        let b = hmac_sha256(b"key", "msg");
        assert_eq!(a, b);
        assert_ne!(a, hmac_sha256(b"key2", "msg"));
        assert_eq!(hex(&a), hex(&b));
        assert_eq!(hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
