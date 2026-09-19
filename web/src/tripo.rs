//! Tripo v3 transport. Creation/upload are sent exactly once; polling never creates a task.
use crate::services::{bounded_body, Service};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const MODELS: [&str; 4] = ["P1-20260311", "v3.1-20260211", "v3.0-20250812", "v2.5-20250123"];
#[cfg_attr(not(test), allow(dead_code))] // 默认模型只被单测引用；清单本身在 providers.rs 也有登记
pub const DEFAULT_MODEL: &str = "P1-20260311";

fn api_source() -> String { "api".into() }
fn single() -> String { "single".into() }
fn yes() -> bool { true }
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Generate {
    #[serde(default = "api_source")] pub source: String,
    #[serde(default = "single")] pub mode: String,
    #[serde(default)] pub prompt: String,
    #[serde(default)] pub model_id: Option<String>,
    #[serde(default)] pub face_limit: Option<u32>,
    #[serde(default)] pub geometry_quality: Option<String>,
    #[serde(default)] pub texture_quality: Option<String>,
    #[serde(default)] pub texture_size: Option<u32>,
    #[serde(default)] pub quad: bool,
    #[serde(default = "yes")] pub texture: bool,
    #[serde(default)] pub pbr: bool,
    #[serde(default)] pub expected_history_node_id: Option<String>,
}
impl Default for Generate {
    fn default() -> Self { Self { source: api_source(), mode: single(), prompt: String::new(), model_id: None, face_limit: None, geometry_quality: None, texture_quality: None, texture_size: None, quad: false, texture: true, pbr: false, expected_history_node_id: None } }
}
impl Generate {
    pub fn validate(&self, model: &str) -> Result<(), String> {
        if !["text", "single", "multi"].contains(&self.mode.as_str()) { return Err("输入方式仅支持 text / single / multi".into()); }
        if !MODELS.contains(&model) { return Err("请选择已支持的 Tripo 模型版本".into()); }
        if self.mode == "text" && (self.prompt.trim().is_empty() || self.prompt.chars().count() > 1024) {
            return Err("文字建模描述需为 1–1024 字".into());
        }
        if self.source != "studio" && (self.geometry_quality.is_some() || self.texture_quality.is_some() || self.texture_size.is_some() || self.quad) { return Err("这些质量选项目前仅支持网页订阅模式".into()); }
        if let Some(q)=&self.geometry_quality { if q!="detailed" || model!="v3.1-20260211" { return Err("高精度几何请选择 Studio v3.1".into()); } }
        if self.texture_quality.as_deref().is_some_and(|q| !["standard","extreme"].contains(&q)) { return Err("贴图质量无效".into()); }
        if self.texture_size.is_some_and(|n| ![2048,4096,8192].contains(&n)) { return Err("贴图导出尺寸无效".into()); }
        if !self.texture && (self.texture_quality.is_some() || self.texture_size.is_some()) { return Err("贴图选项需要开启生成纹理".into()); }
        let (min,max) = match model { "P1-20260311" => (50,20_000), "v2.5-20250123" => (500,500_000), "v3.0-20250812" => (500,1_000_000), "v3.1-20260211" if self.source=="studio" => (500,2_000_000), _ => (500,1_500_000) };
        if self.face_limit.is_some_and(|n| n < min || n > max) { return Err(format!("该模型面数范围为 {min}–{max}；留空使用自适应面数")); }
        if self.pbr && !self.texture { return Err("PBR 需要开启贴图".into()); }
        Ok(())
    }
    pub fn payload(&self, model: &str, files: &[(String,String)]) -> Result<(String,Value),String> {
        self.validate(model)?;
        let mut v = json!({"model":model,"texture":self.texture,"pbr":self.pbr});
        if let Some(n) = self.face_limit { v["face_limit"] = json!(n); }
        let route = match self.mode.as_str() {
            "text" => { v["prompt"] = json!(self.prompt.trim()); "text-to-model" },
            "single" => {
                v["input"] = json!(files.iter().find(|(k,_)| k=="front").ok_or("缺少正面参考图片")?.1);
                "image-to-model"
            },
            _ => {
                if files.len()<2 || !files.iter().any(|(k,_)| k=="front") { return Err("多视图需要正面及至少一个其他视角".into()); }
                let mut inputs = Vec::new();
                for view in ["front","side","back","right"] {
                    if let Some((_,token)) = files.iter().find(|(k,_)| k==view) {
                        let mut item = json!({}); item[if view=="side" {"left"} else {view}] = json!(token); inputs.push(item);
                    }
                }
                v["inputs"] = json!(inputs); "multiview-to-model"
            }
        };
        Ok((format!("/generation/{route}"),v))
    }
}

/// Normalize historical JPEG bytes saved with .png names without resizing.
pub fn reference_png(bytes: &[u8]) -> Result<Vec<u8>,String> {
    const LIMIT:usize=20*1024*1024;
    if bytes.len()>LIMIT { return Err("参考图超过20 MB，请使用较小的图片".into()); }
    let format=image::guess_format(bytes).map_err(|_|"参考图无法识别，请重新上传PNG或JPEG图片")?;
    if ![image::ImageFormat::Png,image::ImageFormat::Jpeg].contains(&format) { return Err("参考图格式不支持，请在页面重新载入图片后提交".into()); }
    let mut reader=image::ImageReader::with_format(std::io::Cursor::new(bytes),format);
    let mut limits=image::Limits::default();limits.max_image_width=Some(8192);limits.max_image_height=Some(8192);reader.limits(limits);
    let decoded=reader.decode().map_err(|_|"参考图损坏或尺寸超过8192像素，请重新上传")?;
    if format==image::ImageFormat::Png { return Ok(bytes.to_vec()); }
    let mut output=std::io::Cursor::new(Vec::new());
    decoded.write_to(&mut output,image::ImageFormat::Png).map_err(|_|"参考图转换PNG失败")?;
    let png=output.into_inner();
    if png.len()>LIMIT { return Err("参考图转为PNG后超过20 MB，请使用较小的图片".into()); }
    Ok(png)
}

pub struct Client { http: reqwest::Client, service: Service }
impl Client {
    pub fn new(service: Service) -> Result<Self,String> {
        crate::services::validate_url(&service.base_url)?;
        if service.api_key.trim().is_empty() { return Err("请在设置 → 模型配置管理中填写 Tripo API Key".into()); }
        let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(120)).build().map_err(|_| "Tripo 客户端初始化失败")?;
        Ok(Self { http, service })
    }
    pub fn model(&self) -> &str { &self.service.model }
    fn url(&self, route: &str) -> String { format!("{}{route}",self.service.base_url.trim_end_matches('/')) }
    pub async fn post(&self, route: &str, payload: &Value) -> Result<Value,String> {
        let response = self.http.post(self.url(route)).bearer_auth(&self.service.api_key).json(payload)
            .send().await.map_err(crate::services::network_error)?;
        self.parse(response).await
    }
    pub async fn upload(&self, bytes: Vec<u8>, name: &str) -> Result<String,String> {
        let part = reqwest::multipart::Part::bytes(bytes).file_name(name.to_string()).mime_str("image/png").map_err(|_| "图片类型无效")?;
        let response = self.http.post(self.url("/files")).bearer_auth(&self.service.api_key)
            .multipart(reqwest::multipart::Form::new().part("file",part)).send().await.map_err(crate::services::network_error)?;
        let data = self.parse(response).await?;
        reference(&data,"file_token")
    }
    pub async fn create(&self, route: &str, payload: &Value) -> Result<String,String> {
        reference(&self.post(route,payload).await?,"task_id")
    }
    pub async fn balance(&self) -> Result<Value,String> {
        let response=self.http.get(self.url("/account/balance")).bearer_auth(&self.service.api_key)
            .send().await.map_err(crate::services::network_error)?;
        self.parse(response).await
    }
    pub async fn task(&self, id: &str) -> Result<Value,String> {
        valid_id(id)?;
        let response = self.http.get(self.url(&format!("/tasks/{id}"))).bearer_auth(&self.service.api_key)
            .send().await.map_err(crate::services::network_error)?;
        self.parse(response).await
    }
    async fn parse(&self, response: reqwest::Response) -> Result<Value,String> {
        let status = response.status().as_u16();
        let bytes = bounded_body(response,2*1024*1024).await?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| format!("Tripo 响应无效（HTTP {status}）"))?;
        if !(200..300).contains(&status) || v["code"].as_i64()!=Some(0) {
            let reason = match status { 401|403=>"Key 无效或无权限",402=>"账户额度不足",429=>"请求过于频繁或并发已满",_=>"请求被拒绝" };
            let raw = v["message"].as_str().or(v["error_message"].as_str()).unwrap_or(reason);
            return Err(format!("Tripo HTTP {status} / code {}：{}",v["code"],self.clean(raw)));
        }
        if !v["data"].is_object() { return Err("Tripo 响应缺少 data 对象".into()); }
        Ok(v["data"].clone())
    }
    pub fn clean(&self, s: &str) -> String {
        s.replace(&self.service.api_key,"[已隐藏]").chars().filter(|c| !c.is_control()).take(400).collect()
    }
    /// Download client has no Authorization header. Signed query strings are never persisted.
    pub async fn download(&self, raw: &str, limit: usize) -> Result<Vec<u8>,String> {
        let url = reqwest::Url::parse(raw).map_err(|_| "Tripo 下载链接无效")?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return Err("Tripo 下载链接格式不安全".into()); }
        let host = url.host_str().ok_or("Tripo 下载链接缺少主机")?;
        let test_local = cfg!(test) && host=="127.0.0.1";
        if !test_local && (url.scheme()!="https" || host=="localhost" || host.parse::<std::net::IpAddr>().is_ok() || host.ends_with(".local")) { return Err("Tripo 下载链接必须使用公开 HTTPS 域名".into()); }
        let response = self.http.get(url).send().await.map_err(crate::services::network_error)?;
        if !response.status().is_success() { return Err(format!("Tripo 下载失败（HTTP {}）；可重新查询原任务获取链接",response.status().as_u16())); }
        bounded_body(response,limit).await
    }
}
pub fn valid_id(s: &str) -> Result<(),String> {
    if s.is_empty() || s.len()>200 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c=='_' || c=='-') { return Err("Tripo 任务／文件标识无效".into()); } Ok(())
}
fn reference(v: &Value, field: &str) -> Result<String,String> {
    let s = v[field].as_str().ok_or_else(|| format!("Tripo 响应缺少 {field}"))?; valid_id(s)?; Ok(s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn jpeg_reference_is_converted_without_resizing_or_pixel_changes() {
        let original=image::RgbImage::from_pixel(31,17,image::Rgb([40,130,210]));
        let mut encoded=std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(original).write_to(&mut encoded,image::ImageFormat::Jpeg).unwrap();
        let jpeg=encoded.into_inner();let png=reference_png(&jpeg).unwrap();
        assert_eq!(image::guess_format(&png).unwrap(),image::ImageFormat::Png);
        assert_eq!(image::load_from_memory(&jpeg).unwrap().to_rgba8(),image::load_from_memory(&png).unwrap().to_rgba8());
        assert_eq!(reference_png(&png).unwrap(),png);
        assert!(reference_png(b"not an image").is_err());
        assert!(reference_png(&jpeg[..25]).is_err());
        assert!(reference_png(&vec![0;20*1024*1024+1]).unwrap_err().contains("超过20"));
    }
    #[test] fn text_and_multiview_contract() {
        let r=Generate{mode:"text".into(),prompt:"cat".into(),..Default::default()};
        let (path,p)=r.payload(DEFAULT_MODEL,&[]).unwrap(); assert_eq!(path,"/generation/text-to-model"); assert_eq!(p["prompt"],"cat"); assert!(p.get("input").is_none());
        let r=Generate{mode:"multi".into(),..Default::default()};
        let (_,p)=r.payload(DEFAULT_MODEL,&[("back".into(),"b".into()),("front".into(),"f".into()),("side".into(),"s".into())]).unwrap();
        assert_eq!(p["inputs"],json!([{"front":"f"},{"left":"s"},{"back":"b"}]));
        assert!(r.payload(DEFAULT_MODEL,&[("front".into(),"f".into())]).is_err());
    }
    #[test] fn incompatible_options_rejected_before_payment() {
        assert!(Generate{face_limit:Some(50000),..Default::default()}.validate(DEFAULT_MODEL).is_err());
        assert!(Generate{texture:false,pbr:true,..Default::default()}.validate(DEFAULT_MODEL).is_err());
        assert!(Generate{mode:"text".into(),..Default::default()}.validate(DEFAULT_MODEL).is_err());
        assert!(valid_id("../keys").is_err());
        assert!(serde_json::from_value::<Generate>(json!({"method":"pixel"})).is_err());
    }
    #[tokio::test] async fn v3_transport_preserves_task_and_never_retries_submission() {
        use axum::{routing::{get,post},Router,Json,http::HeaderMap};
        use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
        let calls=Arc::new(AtomicUsize::new(0)); let count=calls.clone();
        let app=Router::new().route("/v3/generation/text-to-model",post(move |headers:HeaderMap,Json(v):Json<Value>| {let count=count.clone();async move {
            assert_eq!(headers["authorization"],"Bearer test-secret"); assert_eq!(v["prompt"],"cat"); count.fetch_add(1,Ordering::SeqCst);
            Json(json!({"code":0,"data":{"task_id":"task_test"}}))
        }})).route("/v3/tasks/task_test",get(||async{Json(json!({"code":0,"data":{"task_id":"task_test","status":"success","progress":100,"output":{"model_url":"https://cdn.example/model.glb"}}}))}));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let addr=listener.local_addr().unwrap();
        let server=tokio::spawn(async move { axum::serve(listener,app).await.unwrap() });
        let client=Client::new(Service{base_url:format!("http://{addr}/v3"),api_key:"test-secret".into(),model:DEFAULT_MODEL.into()}).unwrap();
        let id=client.create("/generation/text-to-model",&json!({"prompt":"cat"})).await.unwrap();
        assert_eq!(client.task(&id).await.unwrap()["status"],"success");assert_eq!(client.task(&id).await.unwrap()["status"],"success");
        assert_eq!(calls.load(Ordering::SeqCst),1);assert!(!client.clean("test-secret failure").contains("test-secret"));server.abort();
    }
    #[tokio::test] async fn failures_and_downloads_preserve_security_contract() {
        use axum::{routing::get,Router,Json,http::{HeaderMap,StatusCode}};
        let app=Router::new()
            .route("/v3/account/balance",get(||async{Json(json!({"code":0,"data":{"balance":0,"frozen":0}}))}))
            .route("/v3/tasks/denied",get(||async{(StatusCode::UNAUTHORIZED,Json(json!({"code":401,"message":"test-secret denied"})))}))
            .route("/v3/tasks/error",get(||async{Json(json!({"code":1001,"message":"Rejected"}))}))
            .route("/model.glb",get(|h:HeaderMap|async move{assert!(h.get("authorization").is_none());"glTF-test"}))
            .route("/redirect",get(||async{(StatusCode::FOUND,[("location","/model.glb")])}));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr=listener.local_addr().unwrap();
        let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap()});
        let client=Client::new(Service{base_url:format!("http://{addr}/v3"),api_key:"test-secret".into(),model:DEFAULT_MODEL.into()}).unwrap();
        assert_eq!(client.balance().await.unwrap()["balance"],0);
        let error=client.task("denied").await.unwrap_err(); assert!(!error.contains("test-secret")); assert!(error.contains("401"));
        assert!(client.task("error").await.is_err());
        assert_eq!(client.download(&format!("http://{addr}/model.glb"),100).await.unwrap(),b"glTF-test");
        assert!(client.download(&format!("http://{addr}/model.glb"),2).await.is_err());
        assert!(client.download(&format!("http://{addr}/redirect"),100).await.is_err());
        assert!(client.download("http://localhost/model.glb",100).await.is_err());
        server.abort();
    }

}
