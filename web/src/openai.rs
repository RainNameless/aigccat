//! OpenAI 兼容端点调用：自然语言描述 → Character/Asset Spec（含自动分类）
//!
//! 成本红线：默认 gpt-5.4-mini，单次 spec 生成预算 ~1200 tokens。
//! 返回 (spec_json, usage) —— usage 写入 job 成本账本。

use crate::config::AppConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 11 类受控枚举（KICKOFF 5.2），prompt 与校验共用
pub const ASSET_TYPES: [&str; 12] = [
    "character", "animal", "prop", "building", "environment", "vegetation",
    "ground", "sky", "vehicle", "material", "effect", "apparel",
];

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    response_format: ResponseFormat,
    max_completion_tokens: u32,
}

#[derive(Serialize)]
struct ResponseFormat {
    r#type: &'static str,
}

#[derive(Serialize)]
struct Message<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Choice {
    message: RespMessage,
}

#[derive(Deserialize)]
struct RespMessage {
    content: String,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug)]
pub struct SpecOutput {
    pub spec: Value,
    pub usage: Option<Usage>,
    pub model: String,
}

/// 分类目录（中英双语 + 关键词），编译进二进制
pub static CATALOG_JSON: &str = include_str!("../assets/taxonomy_catalog.json");

fn system_prompt() -> String {
    format!(
        "You are a game-asset spec generator. Output ONLY a JSON object.\n\
         LANGUAGE RULE: Chinese is the primary display language. Fields 'name', 'description',\
         'style', 'subcategory' MUST be Chinese; keep *_en fields as English copies.\n\
         Required fields:\n\
         - \"asset_type\": exactly one of [{}]\n\
         - \"type_confidence\": float 0..1\n\
         - \"name\": short Chinese name\n\
         - \"name_en\": english slug (lowercase, space separated)\n\
         - \"style\": Chinese style (e.g. 写实卡通 / 低多边形 / 像素风 / 赛博朋克 / 中国风)\n\
         - \"style_en\": english style keyword\n\
         - \"subcategory\": Chinese fine-grained category, e.g. 花瓶/碗盘/路灯/花坛/乔木/住宅/商人/儿童; use 其他 if unsure\n\
         - \"subcategory_en\": english subcategory\n\
         - \"description\": detailed Chinese description\n\
         - \"description_en\": detailed English description for image generation\n\
         - \"taxonomy\": {{\"gender\": \"男性\"|\"女性\"|\"中性\"|\"n/a\", \"age_group\": \"婴儿\"|\"儿童\"|\"少年\"|\"青年\"|\"中年\"|\"老年\"|\"n/a\", \"apparel_type\": \"上衣\"|\"下装\"|\"连衣裙\"|\"鞋靴\"|\"帽饰\"|\"配饰\"|\"n/a\"}}\n\
         - \"attributes\": type-specific fields (character: gender/age/height_m/body_type/clothing/accessories/hair; \
           building: floors/footprint_m/materials; ground/sky: tiling/season/time_of_day)\n\
         - \"model_requirements\": {{\"rig\": \"humanoid\"|\"none\", \"game_ready\": true, \"unit\": \"meter\", \"up_axis\": \"Y\"}}\n\
         If user explicitly gives an asset type, use it (confidence 1.0).",
        ASSET_TYPES.join(", ")
    )
}

/// 从模型输出中稳健提取 JSON（容忍 ```json 围栏与首尾杂讯）
pub(crate) fn extract_json(text: &str) -> Result<Value, String> {
    let t = text.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t).trim();
    match serde_json::from_str(t) {
        Ok(v) => Ok(v),
        Err(e) => {
            // 退化：截取第一个 { 到最后一个 }
            if let (Some(a), Some(b)) = (t.find('{'), t.rfind('}')) {
                serde_json::from_str(&t[a..=b]).map_err(|_| format!("spec JSON parse failed: {e}"))
            } else {
                Err(format!("spec JSON parse failed: {e}"))
            }
        }
    }
}

pub async fn generate_spec(
    cfg: &AppConfig,
    description: &str,
    hints: &str,
) -> Result<SpecOutput, String> {
    let service = cfg.text_service()?;
    if service.api_key.trim().is_empty() {
        return Err("文本服务未配置密钥，请前往 /settings.html 配置".into());
    }
    crate::services::validate_url(&service.base_url)?;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(120)).build().map_err(|_| "文本客户端初始化失败")?;
    let user_content = if hints.is_empty() {
        description.to_string()
    } else {
        format!("{description}\nAdditional constraints: {hints}")
    };
    let sys = system_prompt();
    let req = ChatRequest {
        model: &service.model,
        messages: vec![
            Message { role: "system", content: &sys },
            Message { role: "user", content: &user_content },
        ],
        response_format: ResponseFormat { r#type: "json_object" },
        max_completion_tokens: 1200,
    };
    let url = format!("{}/chat/completions", service.base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .bearer_auth(&service.api_key)
        .json(&req)
        .send()
        .await
        .map_err(|_| "文本服务请求失败".to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("文本服务 HTTP {status}"));
    }
    let parsed: ChatResponse = resp.json().await.map_err(|_| "文本服务响应格式无效".to_string())?;
    let content = parsed
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .ok_or_else(|| "openai returned no choices".to_string())?;
    let spec = extract_json(&content).map_err(|_| "文本服务返回无效 Spec JSON".to_string())?;
    // 校验 asset_type 在受控枚举内
    let t = spec.get("asset_type").and_then(Value::as_str).unwrap_or("");
    if !ASSET_TYPES.contains(&t) {
        return Err("文本服务返回无效 asset_type".into());
    }
    Ok(SpecOutput { spec, usage: parsed.usage, model: service.model })
}
