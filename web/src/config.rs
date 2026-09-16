//! 基础环境配置；文本和图像请求通过 getter 读取文件覆盖后的快照。

#[derive(Clone)]
pub struct AppConfig {
    pub minio_endpoint: String,
    pub minio_access_key: String,
    pub minio_secret_key: String,
    pub minio_bucket: String,
    pub openai_base_url: String,
    pub openai_api_key: String,
    pub openai_model: String,
}

impl AppConfig {
    pub fn text_service(&self) -> Result<crate::services::Service, String> {
        Ok(crate::services::snapshot(self)?.text)
    }

    pub fn image_service(&self) -> Result<crate::services::Service, String> {
        Ok(crate::services::snapshot(self)?.effective_image())
    }

    pub fn from_env() -> Self {
        let get = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        Self {
            minio_endpoint: get("MINIO_ENDPOINT", "minio:9000"),
            minio_access_key: get("MINIO_ACCESS_KEY", "aigccat"),
            minio_secret_key: get("MINIO_SECRET_KEY", ""),
            minio_bucket: get("MINIO_BUCKET", "game-assets"),
            openai_base_url: get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            openai_api_key: get("OPENAI_API_KEY", ""),
            openai_model: get("OPENAI_MODEL", "gpt-5.4-mini"),
        }
    }
}
