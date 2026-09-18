//! 文本、图像与独立视觉服务配置；密钥仅写入私有配置文件，不进入响应或错误。
use crate::assets::AppState;
use crate::config::AppConfig;
use axum::{extract::State, http::{HeaderMap, StatusCode}, response::Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs::{self, OpenOptions}, io::Write, os::unix::fs::{OpenOptionsExt, PermissionsExt}, path::Path, sync::{Arc, Mutex}};

/// 建模引擎未接入时的说明（model.ready=false 时展示）；不把未接入能力描述为可用。
pub const MODEL_MESSAGE: &str = concat!(
    "请在模型配置管理中为 Tripo / Meshy / Rodin / Hunyuan3D / Hi3D 任一家填写 API Key。",
    "五家均已接入生成链路（各家参数与密钥格式见 docs/PROVIDERS.md；混元填 SecretId:SecretKey）。",
);
static FILE_LOCK: Mutex<()> = Mutex::new(());
const FILE: &str = "/srv/config/services.json";
/// 识图模型缺省值。实测：gpt-6-astra 必超时、gpt-5.4-mini 不支持图片输入、gpt-5.6-terra 可用。
const DEFAULT_VISION_MODEL: &str = "gpt-5.6-terra";
type ApiResult = Result<Json<Value>, (StatusCode, String)>;

#[derive(Clone, Serialize, Deserialize)]
pub struct Service {
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Services {
    pub text: Service,
    pub image: Service,
    #[serde(default)]
    pub vision: Option<Service>,
    #[serde(default)]
    pub catalog: Option<Catalog>,
}
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Catalog {
    providers: Vec<Provider>,
    models: Vec<ModelEntry>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Provider { id: String, name: String, base_url: String, #[serde(default)] api_key: String }
#[derive(Clone, Serialize, Deserialize)]
struct ModelEntry { id: String, provider: String, model: String, service: String, enabled: bool, #[serde(default)] default: bool }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    text: Option<Patch>,
    image: Option<Patch>,
    vision: Option<Patch>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Patch {
    base_url: String,
    model: String,
    api_key: Option<String>,
    #[serde(default)]
    clear_key: bool,
}

pub fn validate_url(value: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(value).map_err(|_| "服务地址必须是有效的 HTTP(S) URL".to_string())?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none()
        || !u.username().is_empty() || u.password().is_some()
        || u.query().is_some() || u.fragment().is_some()
        || value.split("://").nth(1).unwrap_or("").split('/').next().unwrap_or("").contains('@') {
        return Err("服务地址不允许 userinfo、query 或 fragment，且必须使用 HTTP(S)".into());
    }
    Ok(u)
}
fn defaults(cfg: &AppConfig) -> Services {
    Services {
        text: Service { base_url: cfg.openai_base_url.clone(), model: cfg.openai_model.clone(), api_key: cfg.openai_api_key.clone() },
        image: Service {
            base_url: std::env::var("IMAGE_BASE_URL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| cfg.openai_base_url.clone()),
            model: std::env::var("IMAGE_MODEL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "gpt-image-1".into()),
            api_key: std::env::var("IMAGE_API_KEY").unwrap_or_default(),
        },
        vision: None,
        catalog: None,
    }
}
fn load(path: &Path, cfg: &AppConfig) -> Result<Services, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "服务配置文件格式错误".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(defaults(cfg)),
        Err(_) => Err("无法读取服务配置文件".into()),
    }
}
pub fn snapshot(cfg: &AppConfig) -> Result<Services, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "服务配置锁不可用".to_string())?;
    load(Path::new(FILE), cfg)
}
impl Services {
    pub fn effective_image(&self) -> Service {
        let mut image = self.image.clone();
        if image.api_key.is_empty() {
            image.api_key = self.text.api_key.clone();
            image.base_url = self.text.base_url.clone();
        }
        image
    }
    /// 对外视图：blender 段只反映工作器可达性；model.ready 以真实引擎为准。
    fn public(&self, blender: &crate::blender::Status) -> Value {
        let view = |s: &Service| json!({"base_url": s.base_url, "model": s.model, "key_configured": !s.api_key.is_empty()});
        let tripo = self.tripo_service(None).ok();
        let ready = tripo.as_ref().is_some_and(|s| !s.api_key.trim().is_empty());
        let message = if ready { "Tripo 已配置；配置状态不代表真实生成已验证" } else { MODEL_MESSAGE };
        json!({
            "text": view(&self.text),
            "image": view(&self.image),
            "vision": self.vision.as_ref().map(view),
            "blender": blender.json(),
            "model": { "ready": ready, "configured":ready, "verified":false, "provider":"tripo", "message": message },
            "tripo": tripo.as_ref().map(view)
        })
    }
}
fn apply(s: &mut Service, patch: Patch) -> Result<(), String> {
    validate_url(&patch.base_url)?;
    if patch.model.trim().is_empty() { return Err("model 不能为空".into()); }
    s.base_url = patch.base_url.trim_end_matches('/').into();
    s.model = patch.model;
    if patch.clear_key { s.api_key.clear(); }
    else if let Some(key) = patch.api_key.filter(|k| !k.trim().is_empty()) { s.api_key = key; }
    Ok(())
}
fn apply_vision(vision: &mut Option<Service>, patch: Patch) -> Result<(), String> {
    let mut service = vision.clone().unwrap_or_else(|| Service {
        base_url: String::new(), model: String::new(), api_key: String::new(),
    });
    // 更换源时不得把已有视觉密钥自动发送给另一供应商。
    let changed_origin = !service.base_url.is_empty()
        && validate_url(&service.base_url)?.origin() != validate_url(&patch.base_url)?.origin();
    if changed_origin && !patch.clear_key
        && patch.api_key.as_ref().map_or(true, |key| key.trim().is_empty()) {
        service.api_key.clear();
    }
    apply(&mut service, patch)?;
    *vision = Some(service);
    Ok(())
}
fn save(path: &Path, settings: &Services) -> Result<(), String> {
    let parent = path.parent().ok_or("配置目录无效")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建配置目录")?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "系统时钟无效")?.as_nanos();
    let temp = parent.join(format!(".services-{}-{nonce}.tmp", std::process::id()));
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(&serde_json::to_vec(settings)?)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result.map_err(|_| "无法原子保存服务配置".into())
}
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else { return false; };
    let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else { return false; };
    let Ok(origin_url) = validate_url(origin) else { return false; };
    // 服务自身为 HTTP；HTTPS 反代部署须显式配置公开 Origin，不信任客户端转发头。
    let expected = std::env::var("SERVICES_PUBLIC_ORIGIN").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("http://{host}"));
    let Ok(expected_url) = validate_url(&expected) else { return false; };
    origin_url.path() == "/" && expected_url.path() == "/"
        && origin_url.origin() == expected_url.origin()
}
pub async fn get_services(State(st): State<Arc<AppState>>) -> ApiResult {
    let settings = snapshot(&st.cfg).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    // 真实 ping 一次工作器：reachable 不是配置推断出来的
    let blender = crate::blender::status().await;
    Ok(Json(settings.public(&blender)))
}
pub async fn put_services(State(st): State<Arc<AppState>>, headers: HeaderMap, payload: Result<Json<Update>, axum::extract::rejection::JsonRejection>) -> ApiResult {
    if !same_origin(&headers) { return Err((StatusCode::FORBIDDEN, "配置变更要求同源 Origin".into())); }
    let Json(update) = payload.map_err(|_| (StatusCode::BAD_REQUEST, "配置请求 JSON 无效".into()))?;
    // 先做工作器探测：文件锁的 guard 不能跨 await 持有（否则 handler 不再是 Send）
    let blender = crate::blender::status().await;
    let _guard = FILE_LOCK.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "服务配置锁不可用".into()))?;
    let mut settings = load(Path::new(FILE), &st.cfg).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if let Some(p) = update.text { apply(&mut settings.text, p).map_err(|e| (StatusCode::BAD_REQUEST, e))?; }
    if let Some(p) = update.image { apply(&mut settings.image, p).map_err(|e| (StatusCode::BAD_REQUEST, e))?; }
    if let Some(p) = update.vision {
        apply_vision(&mut settings.vision, p).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    }
    save(Path::new(FILE), &settings).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(settings.public(&blender)))
}

// 测试只允许一个进行中请求；try_acquire 不排队，避免重复收费。
static TEST_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
impl Services {
    pub fn image_model(&self, id: Option<&str>) -> Result<Service,String> {
        let c=self.catalog();
        let m=c.models.iter().find(|m| m.service=="image" && m.enabled && id.map_or(m.default, |id| m.id==id))
            .ok_or("图片模型未启用，请检查模型配置")?;
        c.resolve(&m.id).map(|(_,s)|s)
    }
    pub fn tripo_service(&self, id: Option<&str>) -> Result<Service,String> {
        let c=self.catalog();
        let m=match id {
            Some(id) => c.models.iter().find(|m|m.id==id && m.service=="model3d" && m.enabled),
            None => c.models.iter().find(|m|m.service=="model3d" && m.default && m.enabled),
        }.ok_or("Tripo 模型未启用，请检查模型配置")?;
        c.resolve(&m.id).map(|(_,s)|s)
    }
    /// 解析 model3d 模型并带上供应商 id：生成入口按它路由到对应传输层（tripo/meshy/…）。
    pub fn model3d_route(&self, id: Option<&str>) -> Result<(String,Service),String> {
        let c=self.catalog();
        let m=match id {
            Some(id) => c.models.iter().find(|m|m.id==id && m.service=="model3d" && m.enabled),
            None => c.models.iter().find(|m|m.service=="model3d" && m.default && m.enabled),
        }.ok_or("3D 生成模型未启用，请检查模型配置")?;
        let provider=m.provider.clone();
        c.resolve(&m.id).map(|(_,s)|(provider,s))
    }
    pub(crate) fn plan_service(&self) -> Option<Service> {
        let c=self.catalog.as_ref()?;
        let m=c.models.iter().find(|m|m.service=="vision" && m.default && m.enabled)?;
        c.resolve(&m.id).ok().map(|(_,s)|s)
    }
    fn catalog(&self) -> Catalog {
        if let Some(c) = &self.catalog { let mut c=c.clone(); c.ensure_builtin(); return c; }
        let mut c = Catalog::default();
        let mut services = vec![("text", self.text.clone()), ("image", self.effective_image())];
        if let Some(v) = &self.vision { services.push(("vision", v.clone())); }
        for (kind, service) in services {
            let provider = if let Some(p) = c.providers.iter().find(|p| p.base_url == service.base_url && p.api_key == service.api_key) { p.id.clone() } else {
                let id = format!("provider-{}", c.providers.len()+1);
                c.providers.push(Provider { id:id.clone(), name:format!("接入 {}", c.providers.len()+1), base_url:service.base_url, api_key:service.api_key }); id
            };
            c.models.push(ModelEntry { id:kind.into(), provider, model:service.model, service:kind.into(), enabled:true, default:true });
        }
        for m in &mut c.models { if m.service=="vision" { m.default=false; } }
        let provider=c.models.iter().find(|m|m.service=="text").unwrap().provider.clone();
        // 视觉/识图模型配置槽（plan 路线已移除，仅保留配置位以兼容历史 catalog 与设置页）
        let vision_model = std::env::var("VISION_MODEL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_VISION_MODEL.to_string());
        c.models.push(ModelEntry { id:"plan-default".into(),provider,model:vision_model,service:"vision".into(),enabled:true,default:true });
        c.ensure_builtin();
        c
    }
}
impl Catalog {
    /// 内置供应商全部登记进目录：后台「模型配置管理」里直接填 Key、启停模型即可。
    /// 已存在同 id 的接入（典型：后台保存过目录）就跳过——绝不能因为每次 catalog()
    /// 都调用这里而追加重复条目。Key 初值取环境变量（如 MESHY_API_KEY），后台保存后以目录为准。
    /// Tripo 保持默认；其余四家登记为「已启用、非默认」，等传输层接入后再切换默认也不迟。
    fn ensure_builtin(&mut self) {
        for builtin in crate::providers::BUILTIN {
            if self.providers.iter().any(|p| p.id == builtin.id) { continue; }
            // 环境变量只作首次登记的初值；混元是两段式密钥（SecretId:SecretKey），两段都在才拼
            let api_key = match builtin.key_env2 {
                Some(second) => {
                    let id = std::env::var(builtin.key_env).unwrap_or_default();
                    let key = std::env::var(second).unwrap_or_default();
                    if !id.is_empty() && !key.is_empty() { format!("{id}:{key}") } else { String::new() }
                }
                None => std::env::var(builtin.key_env).unwrap_or_default(),
            };
            self.providers.push(Provider { id: builtin.id.into(), name: builtin.name.into(), base_url: builtin.base_url.into(), api_key });
            for (i, model) in builtin.models.iter().enumerate() {
                let mut model_id = format!("{}-model-{i}", builtin.id);
                while self.models.iter().any(|m| m.id == model_id) { model_id.push('-'); }
                self.models.push(ModelEntry {
                    id: model_id, provider: builtin.id.into(), model: (*model).into(),
                    service: "model3d".into(), enabled: true,
                    default: builtin.id == "tripo" && i == 0,
                });
            }
        }
    }
    fn public(&self) -> Value {
        json!({"providers":self.providers.iter().map(|p| json!({"id":p.id,"name":p.name,"base_url":p.base_url,"key_configured":!p.api_key.is_empty()})).collect::<Vec<_>>(),"models":self.models})
    }
    fn resolve(&self, id: &str) -> Result<(String, Service), String> {
        let m = self.models.iter().find(|m| m.id==id && m.enabled).ok_or("模型已停用或不存在")?;
        let p = self.providers.iter().find(|p| p.id==m.provider).ok_or("模型未绑定接入配置")?;
        Ok((m.service.clone(),Service { base_url:p.base_url.clone(), api_key:p.api_key.clone(), model:m.model.clone() }))
    }
}
pub async fn get_catalog(State(st): State<Arc<AppState>>) -> ApiResult {
    Ok(Json(snapshot(&st.cfg).map_err(|e|(StatusCode::INTERNAL_SERVER_ERROR,e))?.catalog().public()))
}
pub async fn put_catalog(State(st): State<Arc<AppState>>, headers: HeaderMap, payload: Result<Json<Catalog>, axum::extract::rejection::JsonRejection>) -> ApiResult {
    if !same_origin(&headers) { return Err((StatusCode::FORBIDDEN,"配置变更要求同源 Origin".into())); }
    let Json(mut c) = payload.map_err(|_|(StatusCode::BAD_REQUEST,"模型配置格式无效".into()))?;
    let _guard = FILE_LOCK.lock().map_err(|_|(StatusCode::INTERNAL_SERVER_ERROR,"配置锁不可用".into()))?;
    let mut settings = load(Path::new(FILE),&st.cfg).map_err(|e|(StatusCode::INTERNAL_SERVER_ERROR,e))?;
    let old = settings.catalog();
    let bad = |s:&str| (StatusCode::BAD_REQUEST,s.to_string());
    if c.providers.len()>100 || c.models.len()>1000 { return Err(bad("配置数量超过上限")); }
    let mut ids = std::collections::HashSet::new();
    for p in &mut c.providers {
        if p.id.is_empty() || p.id.len()>120 || !ids.insert(p.id.clone()) || p.name.trim().is_empty() || p.name.len()>120 { return Err(bad("接入名称或标识无效 / 重复")); }
        let url = validate_url(&p.base_url).map_err(|e|bad(&e))?;
        p.base_url = p.base_url.trim_end_matches('/').into();
        if p.api_key.trim().is_empty() {
            if let Some(before) = old.providers.iter().find(|o|o.id==p.id) {
                if validate_url(&before.base_url).map_err(|e|bad(&e))?.origin()!=url.origin() { return Err(bad("更换服务器地址时请填写新 Key")); }
                p.api_key = before.api_key.clone();
            }
        }
    }
    ids.clear();
    for m in &c.models {
        if m.id.is_empty() || m.id.len()>120 || !ids.insert(m.id.clone()) || m.model.trim().is_empty() || m.model.len()>120 || m.model.chars().any(char::is_control) || !matches!(m.service.as_str(),"text"|"image"|"vision"|"model3d") || !c.providers.iter().any(|p|p.id==m.provider) { return Err(bad("模型名称、类型或接入绑定无效")); }
        // 模型清单按供应商校验：内置供应商（tripo/meshy/rodin/hunyuan3d/hi3d）只认各自注册表里的名字；
        // 自定义接入仍按 Tripo 系（现有传输层只认识这些）
        if m.service=="model3d" {
            let allowed = crate::providers::models_of(&m.provider);
            match allowed {
                Some(list) => if !list.contains(&m.model.as_str()) { return Err(bad("该模型不在所选供应商的官方模型清单里")); },
                None => if !crate::tripo::MODELS.contains(&m.model.as_str()) { return Err(bad("自定义接入暂仅支持 Tripo P1 / H 系列模型")); },
            }
        }
        if m.default && !m.enabled { return Err(bad("请先更换默认模型，再停用该模型")); }
    }
    for kind in ["text","image","vision","model3d"] {
        let defaults:Vec<_> = c.models.iter().filter(|m|m.service==kind && m.default).collect();
        if kind=="vision" && defaults.len()<=1 { continue; }
        if defaults.len()!=1 { return Err(bad("文字、图片、3D 生成各需一个启用的默认模型")); }
        if let Some(m) = defaults.first() {
            let (_,s) = c.resolve(&m.id).map_err(|e|bad(&e))?;
            match kind { "text"=>settings.text=s,"image"=>settings.image=s,_=>{} }
        }
    }
    let public=c.public(); settings.catalog=Some(c);
    save(Path::new(FILE),&settings).map_err(|e|(StatusCode::INTERNAL_SERVER_ERROR,e))?;
    Ok(Json(public))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestRequest {
    service: String, confirm_cost: bool,
    #[serde(default)] prompt: Option<String>,
    #[serde(default)] model: Option<String>,
    #[serde(default)] model_id: Option<String>,
}

pub async fn service_models(State(st): State<Arc<AppState>>, axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String,String>>) -> ApiResult {
    let settings = snapshot(&st.cfg).map_err(|e| (StatusCode::BAD_REQUEST,e))?;
    let service = if let Some(id) = query.get("provider") {
        let c=settings.catalog();
        let p=c.providers.iter().find(|p|&p.id==id).ok_or((StatusCode::BAD_REQUEST,"接入不存在".into()))?;
        if let Some(allowed) = c.models.iter().find(|m|m.provider==p.id && m.service=="model3d").and_then(|m| crate::providers::models_of(&m.provider)) {
            let default_model = c.models.iter().find(|m|m.provider==p.id && m.service=="model3d" && m.default).map(|m|m.model.clone()).or_else(|| allowed.first().map(|s|s.to_string()));
            return Ok(Json(json!({"models":allowed,"default_model":default_model})));
        }
        Service { base_url:p.base_url.clone(),api_key:p.api_key.clone(),model:String::new() }
    } else { match query.get("service").map(String::as_str) {
        Some("image") => settings.effective_image(),
        Some("text") => settings.text,
        _ => return Err((StatusCode::BAD_REQUEST,"请选择文本或图片服务".into())),
    }};
    validate_url(&service.base_url).map_err(|e| (StatusCode::BAD_REQUEST,e))?;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(15)).build().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR,"客户端初始化失败".into()))?;
    let response = client.get(format!("{}/models",service.base_url.trim_end_matches('/'))).bearer_auth(&service.api_key).send().await.map_err(|e| (StatusCode::BAD_GATEWAY,network_error(e)))?;
    let response = check_response(response).await.map_err(|e| (StatusCode::BAD_GATEWAY,e))?;
    let body = bounded_body(response,1024*1024).await.map_err(|e| (StatusCode::BAD_GATEWAY,e))?;
    let value: Value = serde_json::from_slice(&body).map_err(|_| (StatusCode::BAD_GATEWAY,"模型列表格式无效".into()))?;
    let models: Vec<&str> = value["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).filter(|s| s.len() <= 120 && !s.chars().any(char::is_control)).collect();
    Ok(Json(json!({"models":models,"default_model":service.model})))
}

pub(crate) fn network_error(e: reqwest::Error) -> String {
    if e.is_timeout() { "timeout: 服务请求超时；可能已计费，请勿自动重试".into() }
    else { "network: 无法连接服务或读取响应".into() }
}
pub(crate) async fn bounded_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len().saturating_add(chunk.len()) > limit { return Err("response_too_large: 服务响应超过安全大小限制".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub(crate) async fn check_response(response: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = response.status();
    if status.is_success() { return Ok(response); }
    let code = status.as_u16();
    // 只读取有限错误数据进行分类，绝不返回供应商原文、URL 或密钥。
    let body = bounded_body(response, 65536).await.unwrap_or_default();
    let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let upstream_code = value["error"]["code"].as_str().unwrap_or("");
    let kind = value["error"]["type"].as_str().unwrap_or("");
    let no_accounts = value["error"]["message"].as_str().unwrap_or("").to_ascii_lowercase().contains("no available compatible accounts");
    let quota = [upstream_code, kind].iter().any(|s| matches!(*s, "insufficient_quota" | "insufficient_balance" | "billing_hard_limit_reached" | "credit_balance_exhausted"));
    // 5xx 中网关类单独标注，便于区分"供应商慢/网关超时"与"参数/鉴权"问题。
    let gateway = match code { 502 => "/网关错误", 503 => "/服务不可用", 504 => "/网关超时", _ => "" };
    let error = match code {
        500..=599 if no_accounts => format!("provider_capacity: 供应商没有可用的兼容账号，当前图片服务不可用；请联系供应商或在服务设置更换可用服务（HTTP {code}）"),
        401 | 403 => format!("authentication: 认证失败或无权限，请检查已保存密钥及模型权限（HTTP {code}）"),
        402 => format!("balance: 供应商要求充值或开通计费（HTTP {code}）"),
        429 if quota => format!("balance: 供应商明确报告额度或余额不足（HTTP {code}）"),
        429 => format!("rate_limit: 请求被限流，不能据此认定余额不足；稍后手动重试（HTTP {code}）"),
        404 => format!("model_not_found: 模型或接口不存在，请核对地址与模型（HTTP {code}）"),
        400 | 405 | 415 | 422 | 501 => format!("unsupported: 模型、接口或请求参数不受支持，请核对服务能力（HTTP {code}）"),
        500 | 502..=599 => format!("upstream_5xx: 供应商服务错误（HTTP {code}{gateway}）；可能已计费，请勿自动重试"),
        _ => format!("upstream: 供应商返回错误，请检查服务状态（HTTP {code}）"),
    };
    tracing::warn!(status = code, category = error.split(": ").next().unwrap_or(""), "upstream returned error status");
    Err(error)
}

/// 从已分类错误串里取出 HTTP 状态码（形如 "（HTTP 504）"），供日志结构化输出；无则 0。
pub(crate) fn error_status(error: &str) -> u16 {
    let Some(rest) = error.split("（HTTP ").nth(1) else { return 0; };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(0)
}

pub async fn test_services(State(st): State<Arc<AppState>>, headers: HeaderMap, payload: Result<Json<TestRequest>, axum::extract::rejection::JsonRejection>) -> (StatusCode, Json<Value>) {
    let start = std::time::Instant::now();
    let reply = |status, result: Result<Value, String>| {
        let mut value = match result {
            Ok(mut value) => { value["success"] = json!(true); value["error"] = Value::Null; value },
            Err(e) => { let (code, message) = e.split_once(": ").unwrap_or(("test_failed", &e)); json!({"success":false,"error":code,"message":message}) }
        };
        value["duration"] = json!(start.elapsed().as_millis() as u64);
        value["duration_unit"] = json!("ms");
        (status, Json(value))
    };
    if !same_origin(&headers) { return reply(StatusCode::FORBIDDEN, Err("origin: 服务测试要求同源 Origin".into())); }
    let Ok(Json(req)) = payload else { return reply(StatusCode::BAD_REQUEST, Err("invalid_request: 测试请求 JSON 无效".into())); };
    if !req.confirm_cost || !matches!(req.service.as_str(), "text" | "image") {
        return reply(StatusCode::BAD_REQUEST, Err("confirmation_required: 必须选择文本或图片服务并明确确认费用".into()));
    }
    if req.prompt.as_ref().is_some_and(|s| s.trim().is_empty() || s.chars().count()>10000)
        || req.model.as_ref().is_some_and(|s| s.trim().is_empty() || s.len()>120 || s.chars().any(char::is_control)) {
        return reply(StatusCode::BAD_REQUEST,Err("invalid_request: 描述或模型名称无效".into()));
    }
    let Ok(_permit) = TEST_GATE.try_acquire() else { return reply(StatusCode::CONFLICT, Err("busy: 已有测试进行中，本次未调用供应商，请等待后手动操作".into())); };
    let result = tokio::time::timeout(std::time::Duration::from_secs(180), async {
        let settings = snapshot(&st.cfg)?;
        let mut service = if let Some(id)=&req.model_id {
            let (kind,s)=settings.catalog().resolve(id)?;
            if kind=="model3d" { return Err("3D 模型请在首页建模工作台测试".into()); }
            if (kind=="image") != (req.service=="image") { return Err("模型类型不匹配".into()); } s
        } else { if req.service == "text" { settings.text.clone() } else { settings.effective_image() } };
        if req.model_id.is_none() { if let Some(model) = &req.model { service.model = model.trim().to_owned(); } }
        if service.api_key.trim().is_empty() { return Err("missing_key: 未配置有效密钥，请先保存配置".into()); }
        validate_url(&service.base_url)?;
        if req.service == "image" {
            let png = crate::imagegen::gen_openai_image(&service, req.prompt.as_deref().unwrap_or("Generate an image of a single blue circle on a plain white background.")).await?;
            use base64::Engine;
            Ok(json!({"message":"图片已生成","model":service.model,"png_base64":base64::engine::general_purpose::STANDARD.encode(png)}))
        } else {
            let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(30)).build().map_err(|_| "network: 客户端初始化失败")?;
            let response = client.post(format!("{}/chat/completions", service.base_url.trim_end_matches('/')))
                .bearer_auth(&service.api_key).json(&json!({"model":service.model,"messages":[{"role":"user","content":req.prompt.as_deref().unwrap_or("Reply OK.")}],"max_completion_tokens":2048,"stream":false}))
                .send().await.map_err(network_error)?;
            let response = check_response(response).await?;
            let bytes = bounded_body(response, 65536).await?;
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_response: 文本响应不是有效 JSON")?;
            if value["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().is_empty() { return Err("invalid_response: 未返回可验证的文本内容".into()); }
            Ok(json!({"message":value["choices"][0]["message"]["content"],"model":service.model}))
        }
    }).await.unwrap_or_else(|_| Err("timeout: 测试超时；可能已计费，请勿自动重试".into()));
    reply(StatusCode::OK, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_migrates_shared_credentials_and_enforces_switches() {
        let s=Service { base_url:"https://example.com/v1".into(),model:"text-model".into(),api_key:"private-test-key".into() };
        let settings=Services { text:s.clone(),image:Service { model:"image-model".into(),..s },vision:None,catalog:None };
        let mut c=settings.catalog();
        // 五家内置供应商（tripo/meshy/rodin/hunyuan3d/hi3d）+ 文本/图片共用的一条自建接入
        assert_eq!(c.providers.len(),6);
        // 文本 1 + 图片 1 + 视觉 1 + 内置五家的模型（4+3+6+2+4=19）
        assert_eq!(c.models.len(),22);
        assert!(c.providers.iter().filter(|p| crate::providers::BUILTIN.iter().any(|b| b.id==p.id)).count()==5);
        assert!(!c.public().to_string().contains("private-test-key"));
        assert_eq!(c.resolve("image").unwrap().1.model,"image-model");
        c.models[1].enabled=false;
        assert!(c.resolve("image").is_err());
        assert!(c.resolve("missing").is_err());
        let mut configured=settings;
        let expected=c.resolve("plan-default").unwrap().1;
        configured.catalog=Some(c);
        let resolved=configured.plan_service().unwrap();
        assert_eq!(resolved.model,expected.model);
        assert_eq!(resolved.api_key,"private-test-key");
    }
    #[tokio::test]
    async fn upstream_classification_is_safe() {
        for (status, body, expected) in [
            (401, r#"{"error":{"message":"secret-key"}}"#, "authentication"),
            (403, "secret-key", "authentication"),
            (429, r#"{"error":{"code":"rate_limit_exceeded"}}"#, "rate_limit"),
            (429, r#"{"error":{"code":"insufficient_quota"}}"#, "balance"),
            (404, "secret-key", "model_not_found"),
            (400, "secret-key", "unsupported"),
            (501, "secret-key", "unsupported"),
            (500, "secret-key", "upstream_5xx"),
            (502, "secret-key", "upstream_5xx"),
            (503, "secret-key", "upstream_5xx"),
            (503, r#"{"error":{"message":"No available compatible accounts secret-key"}}"#, "provider_capacity"),
            (504, "secret-key", "upstream_5xx"),
        ] {
            let raw = axum::http::Response::builder().status(status).body(body.to_string()).unwrap();
            let error = check_response(reqwest::Response::from(raw)).await.unwrap_err();
            assert!(error.starts_with(expected), "{status} => {error}");
            assert!(!error.contains("secret-key"));
            // 状态码必须体现在错误分类里，便于定位
            assert!(error.contains(&format!("HTTP {status}")), "{status} => {error}");
            assert_eq!(error_status(&error), status);
        }
        assert_eq!(error_status("timeout: 无状态码错误"), 0);
        let g = check_response(reqwest::Response::from(
            axum::http::Response::builder().status(504).body(String::new()).unwrap())).await.unwrap_err();
        assert_eq!(g, "upstream_5xx: 供应商服务错误（HTTP 504/网关超时）；可能已计费，请勿自动重试");
        assert!(serde_json::from_value::<TestRequest>(json!({"service":"image","confirm_cost":true,"api_key":"injected"})).is_err());
        let gate = tokio::sync::Semaphore::new(1);
        let permit = gate.try_acquire().unwrap(); assert!(gate.try_acquire().is_err());
        drop(permit); assert!(gate.try_acquire().is_ok());
    }
    #[test]
    fn optional_vision_is_private_and_does_not_reuse_cross_origin_keys() {
        let legacy = json!({"text":{"base_url":"https://text.example/v1","model":"text","api_key":"dummy-text"},
            "image":{"base_url":"https://image.example/v1","model":"image","api_key":""}});
        let mut settings: Services = serde_json::from_value(legacy).unwrap();
        assert!(settings.vision.is_none());
        let status = crate::blender::Status { configured: false, reachable: false, version: None };
        assert!(settings.public(&status)["vision"].is_null());
        let update: Update = serde_json::from_value(json!({"vision":{"base_url":"https://vision.example/v1","model":"hy4","api_key":"dummy-vision"}})).unwrap();
        apply_vision(&mut settings.vision, update.vision.unwrap()).unwrap();
        let view = settings.public(&status);
        assert_eq!(view["vision"]["key_configured"], true);
        assert!(!view.to_string().contains("dummy-"));
        assert!(!view.to_string().contains("api_key"));
        let patch = |url: &str, key| Patch { base_url: url.into(), model: "hy4".into(), api_key: key, clear_key: false };
        apply_vision(&mut settings.vision, patch("https://vision.example/v2", None)).unwrap();
        assert_eq!(settings.vision.as_ref().unwrap().api_key, "dummy-vision");
        apply_vision(&mut settings.vision, patch("https://other.example/v1", None)).unwrap();
        assert!(settings.vision.as_ref().unwrap().api_key.is_empty());
        apply_vision(&mut settings.vision, patch("https://new.example/v1", Some("dummy-new".into()))).unwrap();
        assert_eq!(settings.vision.as_ref().unwrap().api_key, "dummy-new");
        let restored: Services = serde_json::from_slice(&serde_json::to_vec(&settings).unwrap()).unwrap();
        assert_eq!(restored.vision.unwrap().model, "hy4");
    }

    #[test]
    fn urls_and_origin() {
        for u in ["ftp://example.com", "https://u:p@example.com", "https://@example.com", "https://example.com?q=x", "https://example.com#x"] { assert!(validate_url(u).is_err()); }
        assert!(validate_url("https://example.com/v1").is_ok());
        let mut h = HeaderMap::new(); h.insert("host", "localhost:8080".parse().unwrap());
        assert!(!same_origin(&h));
        h.insert("origin", "http://evil.example".parse().unwrap()); assert!(!same_origin(&h));
        h.insert("origin", "http://localhost:8080".parse().unwrap()); assert!(same_origin(&h));
        h.insert("origin", "https://localhost:8080".parse().unwrap()); assert!(!same_origin(&h));
    }
    /// blender 段只反映工作器可达性；model.ready 不得在不可达时被写成 true
    #[test]
    fn blender_section_reflects_reachability_only() {
        let service = Service { base_url: "https://example.com/v1".into(), model: "m".into(), api_key: "k".into() };
let settings = Services { text: service.clone(), image: service, vision: None, catalog: None };
        let offline = crate::blender::Status { configured: false, reachable: false, version: None };
        let view = settings.public(&offline);
        assert_eq!(view["blender"], json!({"configured": false, "reachable": false, "version": null}));
        assert_eq!(view["model"]["ready"], false);
        assert!(view["model"]["message"].as_str().unwrap().contains("Tripo"));

        let down = crate::blender::Status { configured: true, reachable: false, version: None };
        let view = settings.public(&down);
        assert_eq!(view["blender"]["configured"], true);
        assert_eq!(view["blender"]["reachable"], false);
        assert_eq!(view["model"]["ready"], false, "不可达不得报告建模已接入");

        let up = crate::blender::Status { configured: true, reachable: true, version: Some("Blender 5.2.1 LTS".into()) };
        let view = settings.public(&up);
        assert_eq!(view["blender"]["version"], "Blender 5.2.1 LTS");
        assert_eq!(view["model"]["ready"], false);
        assert!(view["model"]["message"].as_str().unwrap().contains("Tripo"));
        // 视图里不得出现任何密钥
        assert!(!view.to_string().contains("\"api_key\""));
    }

    #[test]
    fn key_semantics_and_private_atomic_file() {
        let mut s = Service { base_url: "https://example.com/v1".into(), model: "test".into(), api_key: "test-secret".into() };
        let patch = |key, clear| Patch { base_url: "https://example.com/v1".into(), model: "test".into(), api_key: key, clear_key: clear };
        apply(&mut s, patch(Some("".into()), false)).unwrap(); assert_eq!(s.api_key, "test-secret");
        let settings = Services { text: s.clone(), image: Service { api_key: String::new(), ..s.clone() }, vision: None, catalog: None };
        let unreachable = crate::blender::Status { configured: false, reachable: false, version: None };
        assert!(!settings.public(&unreachable).to_string().contains("test-secret"));
        assert_eq!(settings.effective_image().api_key, "test-secret");
        let dir = std::env::temp_dir().join(format!("aigccat-services-test-{}", std::process::id()));
        let path = dir.join("services.json");
        save(&path, &settings).unwrap(); save(&path, &settings).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let stored: Services = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap(); assert_eq!(stored.text.api_key, "test-secret");
        fs::remove_dir_all(dir).unwrap();
        apply(&mut s, patch(Some("replacement".into()), false)).unwrap(); assert_eq!(s.api_key, "replacement");
        apply(&mut s, patch(Some("ignored".into()), true)).unwrap(); assert!(s.api_key.is_empty());
        let cleared = Services { text: s.clone(), image: s, vision: None, catalog: None };
        assert!(cleared.effective_image().api_key.is_empty());
    }
}

/// Only enabled text catalog entries can drive the local OpenCode agent.
pub fn rig_text_model(cfg: &AppConfig, id: &str) -> Result<Service,String> {
    let (kind, service)=snapshot(cfg)?.catalog().resolve(id)?;
    if kind!="text" { return Err("AI 绑骨需要已启用的文字模型".into()); }
    if service.api_key.trim().is_empty() { return Err("所选文字模型尚未配置 Key".into()); }
    validate_url(&service.base_url)?;
    Ok(service)
}
