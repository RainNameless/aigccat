//! 手动调用 OpenAI 兼容图像服务生成真实三视图，不提供占位回退。
use crate::{config::AppConfig, services::{Service, validate_url}};
use serde::Deserialize;

#[derive(Deserialize)]
struct ImagesResponse { data: Vec<ImageDatum> }
#[derive(Deserialize)]
struct ImageDatum { b64_json: Option<String>, url: Option<String> }

/// 图像尺寸上限（单边像素）；超过即视为配置非法，避免供应商生成超大图拖垮网关。
const MAX_IMAGE_DIM: u32 = 2048;
/// 默认 512x512：中转网关硬超时 60s，1024x1024 的 gpt-image-2 单次生成必超时。
const DEFAULT_IMAGE_SIZE: &str = "512x512";

/// 解析 IMAGE_SIZE：形如 `WxH`（默认 512x512，单边 1..=2048）；`none` 表示不强设尺寸。
fn parse_image_size(raw: Option<&str>) -> Result<Option<String>, String> {
    let raw = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_IMAGE_SIZE);
    if raw.eq_ignore_ascii_case("none") { return Ok(None); }
    let (w, h) = raw.split_once(['x', 'X', '*'])
        .ok_or_else(|| format!("config: IMAGE_SIZE 格式非法（{raw}），应形如 1024x1024 或 none"))?;
    let side = |v: &str| -> Result<u32, String> {
        v.trim().parse::<u32>().map_err(|_| format!("config: IMAGE_SIZE 格式非法（{raw}），应形如 1024x1024 或 none"))
    };
    let (w, h) = (side(w)?, side(h)?);
    if w == 0 || h == 0 || w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM {
        return Err(format!("config: IMAGE_SIZE 超出范围（{w}x{h}），单边需在 1..={MAX_IMAGE_DIM}"));
    }
    Ok(Some(format!("{w}x{h}")))
}

fn image_size() -> Result<Option<String>, String> {
    parse_image_size(std::env::var("IMAGE_SIZE").ok().as_deref())
}

/// 描述文本截断上限（字符数）：长 prompt 显著拉高 gpt-image-2 单次耗时，会被 60s 网关掐断。
const DESCRIPTION_MAX_CHARS: usize = 240;

/// 截断到 DESCRIPTION_MAX_CHARS 个字符，尽量落在单词边界。
/// 不加省略号——省略号会让模型误判描述不完整，反而引入歧义。
fn truncate_description(s: &str) -> &str {
    let s = s.trim();
    if s.chars().count() <= DESCRIPTION_MAX_CHARS {
        return s;
    }
    let end = s.char_indices().nth(DESCRIPTION_MAX_CHARS).map_or(s.len(), |(i, _)| i);
    let head = &s[..end];
    match head.rfind(char::is_whitespace) {
        // 只在能保留大部分内容时回退到单词边界，避免个别超长词把描述砍空
        Some(ws) if ws * 2 >= end => head[..ws].trim_end(),
        _ => head.trim_end(),
    }
}

/// 构造单视图 prompt：只保留必要约束（视图 / 全身 / 正交 / 纯色白底 / 风格），
/// 去掉与这些约束重复或冗余的修饰，压缩单次生成耗时。
fn build_view_prompt(view: &str, description_en: &str, style: &str) -> String {
    let desc = truncate_description(description_en);
    let style = style.trim();
    if style.is_empty() {
        format!("{view} view, full body, orthographic, plain solid white background. {desc}")
    } else {
        format!("{view} view, full body, orthographic, plain solid white background, {style}. {desc}")
    }
}

pub(crate) async fn gen_openai_image(service: &Service, prompt: &str) -> Result<Vec<u8>, String> {
    gen_image_options(service, prompt, image_size()?, None).await
}

pub(crate) async fn gen_image_options(service: &Service, prompt: &str, size: Option<String>, reference: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    validate_url(&service.base_url)?;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(180)).build().map_err(|_| "图像客户端初始化失败")?;
    let mut payload = serde_json::json!({"model": service.model, "prompt": prompt, "n": 1});
    if let Some(size) = &size { payload["size"] = serde_json::json!(size); }
    let started = std::time::Instant::now();
    let request = if let Some(bytes) = reference {
        let mut form = reqwest::multipart::Form::new().text("model", service.model.clone()).text("prompt", prompt.to_string()).text("n", "1")
            .part("image", reqwest::multipart::Part::bytes(bytes).file_name("reference.png").mime_str("image/png").map_err(|_| "图像格式无效")?);
        if let Some(s) = &size { form = form.text("size", s.clone()); }
        client.post(format!("{}/images/edits", service.base_url.trim_end_matches('/'))).bearer_auth(&service.api_key).multipart(form)
    } else {
        client.post(format!("{}/images/generations", service.base_url.trim_end_matches('/'))).bearer_auth(&service.api_key).json(&payload)
    };
    let resp = request.send().await.map_err(crate::services::network_error)?;
    let status = resp.status().as_u16();
    // 状态码与耗时必须可定位：错误串里也带 status，warn 日志两者都记。
    let resp = crate::services::check_response(resp).await.map_err(|e| {
        tracing::warn!(status = status, elapsed_ms = started.elapsed().as_millis() as u64,
            image_size = size.as_deref().unwrap_or("none"), error = %e, "image generation request failed");
        e
    })?;
    let body = crate::services::bounded_body(resp, 24 * 1024 * 1024).await?;
    let parsed: ImagesResponse = serde_json::from_slice(&body).map_err(|_| "invalid_response: 图像服务响应格式无效")?;
    let datum = parsed.data.into_iter().next().ok_or("图像服务未返回图片")?;
    let bytes = if let Some(b64) = datum.b64_json {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "图像编码无效")?
    } else if let Some(url) = datum.url {
        // 下载链接可能包含签名 query；绝不附带服务 API key。
        let u = reqwest::Url::parse(&url).map_err(|_| "图片下载地址无效")?;
        if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some() { return Err("图片下载地址无效".into()); }
        let resp = client.get(u).send().await.map_err(crate::services::network_error)?;
        if !resp.status().is_success() { return Err("image_download: 图片下载服务返回错误".into()); }
        crate::services::bounded_body(resp, 16 * 1024 * 1024).await?
    } else { return Err("图像服务未返回 b64_json 或 url".into()); };
    // 统一验证并转为 PNG，避免错误响应被保存成图片。
    let mut reader = image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format().map_err(|_| "unsupported_image: 无法识别图像格式")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096); limits.max_image_height = Some(4096); limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| "unsupported_image: 图像无效、不支持或超过解码限制")?;
    let mut png = std::io::Cursor::new(Vec::new());
    decoded.write_to(&mut png, image::ImageFormat::Png).map_err(|_| "PNG 编码失败")?;
    Ok(png.into_inner())
}

/// 生成单个视图（front/side/back）的 PNG；失败即返回已分类错误，无占位回退。
pub async fn generate_view(
    cfg: &AppConfig,
    view: &str,
    description_en: &str,
    style: &str,
) -> Result<Vec<u8>, String> {
    let service = cfg.image_service()?;
    if service.api_key.trim().is_empty() { return Err("图像服务未配置密钥，请前往 /settings.html 配置".into()); }
    validate_url(&service.base_url)?;
    let prompt = build_view_prompt(view, description_en, style);
    // 记录最终 prompt 便于定位生成耗时/失败原因；不记任何密钥与 base_url 凭据。
    tracing::info!(view = %view, prompt_chars = prompt.chars().count(),
        image_model = %service.model, prompt = %prompt, "image view prompt");
    gen_openai_image(&service, &prompt).await
}

/// 一次生成三视图（保留给批量/外部调用路径；逐视图进度由 generate_view 驱动）
#[allow(dead_code)]
pub async fn generate_three_views(cfg: &AppConfig, _asset_type: &str, description_en: &str, style: &str) -> Result<[(String, Vec<u8>); 3], String> {
    let mut out: [(String, Vec<u8>); 3] = Default::default();
    for (i, view) in ["front", "side", "back"].iter().enumerate() {
        let bytes = generate_view(cfg, view, description_en, style).await?;
        out[i] = (format!("reference_{view}.png"), bytes);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{build_view_prompt, parse_image_size, truncate_description, DESCRIPTION_MAX_CHARS};
    #[tokio::test]
    async fn image_transport_uses_real_json_and_multipart_contracts() {
        use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};
        use base64::Engine;
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2,2).write_to(&mut cursor,image::ImageFormat::Png).unwrap();
        let png = cursor.into_inner();
        for edit in [false,true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let response = serde_json::json!({"data":[{"b64_json":base64::engine::general_purpose::STANDARD.encode(&png)}]}).to_string();
            let server = tokio::spawn(async move {
                let (mut stream,_) = listener.accept().await.unwrap();
                let mut request=Vec::new();
                let mut buffer=[0u8;4096];
                loop {
                    let n=stream.read(&mut buffer).await.unwrap();
                    if n==0 { break; }
                    request.extend_from_slice(&buffer[..n]);
                    if let Some(end)=request.windows(4).position(|w|w==b"\r\n\r\n") {
                        let headers=String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                        let len=headers.lines().find_map(|s|s.strip_prefix("content-length: ")).unwrap().parse::<usize>().unwrap();
                        if request.len()>=end+4+len { break; }
                    }
                }
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).as_bytes()).await.unwrap();
                String::from_utf8_lossy(&request).into_owned()
            });
            let service=crate::services::Service{base_url:format!("http://{addr}/v1"),model:"test-image".into(),api_key:"test-key".into()};
            let generated=super::gen_image_options(&service,"test prompt",Some("1024x768".into()),edit.then(||png.clone())).await.unwrap();
            assert!(image::load_from_memory(&generated).is_ok());
            let request=server.await.unwrap();
            assert!(request.contains(if edit {"POST /v1/images/edits"} else {"POST /v1/images/generations"}));
            assert!(request.contains("test-image") && request.contains("1024x768"));
            if edit { assert!(request.contains("multipart/form-data") && request.contains("filename=\"reference.png\"")); }
        }
    }
    #[test]
    fn image_size_defaults_and_bounds() {
        // 未设置 / 空值 → 默认 512x512
        assert_eq!(parse_image_size(None).unwrap().as_deref(), Some("512x512"));
        assert_eq!(parse_image_size(Some("")).unwrap().as_deref(), Some("512x512"));
        assert_eq!(parse_image_size(Some("  ")).unwrap().as_deref(), Some("512x512"));
        // 合法尺寸归一化
        assert_eq!(parse_image_size(Some("512x768")).unwrap().as_deref(), Some("512x768"));
        assert_eq!(parse_image_size(Some(" 1024x1024 ")).unwrap().as_deref(), Some("1024x1024"));
        assert_eq!(parse_image_size(Some("2048x2048")).unwrap().as_deref(), Some("2048x2048"));
        // none 表示不强设尺寸
        assert_eq!(parse_image_size(Some("none")), Ok(None));
        assert_eq!(parse_image_size(Some("NONE")), Ok(None));
        // 越界与非法格式一律拒绝
        for bad in ["2049x1024", "1024x2049", "0x1024", "1024x0", "1024", "abc", "1024x", "x1024", "-1x100", "1024x1024x1024"] {
            let err = parse_image_size(Some(bad)).unwrap_err();
            assert!(err.starts_with("config: IMAGE_SIZE"), "{bad} => {err}");
        }
    }

    #[test]
    fn description_truncation_respects_limit_and_word_boundary() {
        // 短描述原样保留（含首尾空白裁剪）
        assert_eq!(truncate_description("  a slim student  "), "a slim student");
        assert_eq!(truncate_description(""), "");
        // 长描述截断后不超过上限，且不加省略号
        let long: String = std::iter::repeat("word ").take(200).collect();
        let out = truncate_description(&long);
        assert!(out.chars().count() <= DESCRIPTION_MAX_CHARS, "{} > {}", out.chars().count(), DESCRIPTION_MAX_CHARS);
        assert!(!out.ends_with("...") && !out.ends_with('…'), "截断不得追加省略号: {out}");
        // 单词边界：结果以完整单词结尾（无半截单词）
        assert!(!out.ends_with(char::is_whitespace), "尾部不应残留空白: {out}");
        assert!(out.starts_with("word "), "{out}");
        // 超长单词（无空白可切）时按字符硬截，不返回空串
        let no_space: String = std::iter::repeat('x').take(500).collect();
        let out = truncate_description(&no_space);
        assert_eq!(out.chars().count(), DESCRIPTION_MAX_CHARS);
    }

    #[test]
    fn view_prompt_keeps_required_constraints() {
        let long: String = std::iter::repeat("word ").take(200).collect();
        for view in ["front", "side", "back"] {
            let p = build_view_prompt(view, &long, "stylized");
            // 必要约束：视图 / 全身 / 正交 / 纯色白底 / 风格
            assert!(p.contains(view), "{p}");
            assert!(p.contains("full body"), "{p}");
            assert!(p.contains("orthographic"), "{p}");
            assert!(p.contains("white background"), "{p}");
            assert!(p.contains("stylized"), "{p}");
            // 描述已截断：总长受控
            assert!(p.chars().count() <= DESCRIPTION_MAX_CHARS + 80, "prompt 过长: {}", p.chars().count());
        }
        // 空 style 时不留下 "background, ." 之类坏结构
        let p = build_view_prompt("front", "a cat", "");
        assert!(p.contains("white background."), "{p}");
        assert!(!p.contains(", ."), "{p}");
    }
}
