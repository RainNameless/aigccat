//! MinIO（S3）存取层：资产的唯一事实来源，全部 JSON/文件落 bucket。
//! 目录约定见 KICKOFF 第 6 节：<category_plural>/<asset_id>/...

use crate::config::AppConfig;
use s3::creds::Credentials;
use s3::{Bucket, Region};
use serde_json::Value;

#[derive(Clone)]
pub struct Store {
    bucket: Box<Bucket>,
    bucket_name: String,
    region: Region,
    creds: Credentials,
}

impl Store {
    pub fn new(cfg: &AppConfig) -> Result<Self, String> {
        let endpoint = if cfg.minio_endpoint.starts_with("http") {
            cfg.minio_endpoint.clone()
        } else {
            format!("http://{}", cfg.minio_endpoint)
        };
        let region = Region::Custom { region: "us-east-1".into(), endpoint };
        let creds = Credentials::new(
            Some(&cfg.minio_access_key),
            Some(&cfg.minio_secret_key),
            None,
            None,
            None,
        )
        .map_err(|e| format!("minio creds: {e}"))?;
        let bucket = Bucket::new(&cfg.minio_bucket, region.clone(), creds.clone())
            .map_err(|e| format!("minio bucket: {e}"))?
            .with_path_style();
        Ok(Self { bucket, bucket_name: cfg.minio_bucket.clone(), region, creds })
    }

    /// 启动时确保 bucket 存在（已存在则忽略）
    pub async fn ensure_bucket(&self) {
        match self.bucket.list("".to_string(), Some("/".to_string())).await {
            Ok(_) => tracing::info!("minio bucket ready"),
            Err(e) => {
                match Bucket::create_with_path_style(
                    &self.bucket_name,
                    self.region.clone(),
                    self.creds.clone(),
                    s3::BucketConfiguration::default(),
                )
                .await
                {
                    Ok(_) => tracing::info!("minio bucket created"),
                    Err(ce) => tracing::warn!("ensure_bucket: list err={e}; create err={ce}"),
                }
            }
        }
    }

    pub async fn put_json(&self, key: &str, v: &Value) -> Result<(), String> {
        let data = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
        let resp = self
            .bucket
            .put_object(key, &data)
            .await
            .map_err(|e| format!("put {key}: {e}"))?;
        let code = resp.status_code();
        if (200..300).contains(&code) {
            Ok(())
        } else {
            Err(format!("put {key}: http {code}"))
        }
    }

    pub async fn get_json(&self, key: &str) -> Result<Value, String> {
        let bytes = self.get_bytes(key).await?;
        serde_json::from_slice(&bytes).map_err(|e| format!("parse {key}: {e}"))
    }

    pub async fn put_bytes(&self, key: &str, data: &[u8]) -> Result<(), String> {
        let resp = self
            .bucket
            .put_object(key, data)
            .await
            .map_err(|e| format!("put {key}: {e}"))?;
        let code = resp.status_code();
        if (200..300).contains(&code) {
            Ok(())
        } else {
            Err(format!("put {key}: http {code}"))
        }
    }

    /// S3 HEAD only: no model bytes are read when validating a browser cache entry.
    pub async fn object_identity(&self, key: &str) -> Result<(String,u64),String> {
        let (head,code)=self.bucket.head_object(key).await.map_err(|e|e.to_string())?;
        if code!=200 { return Err(format!("head: http {code}")); }
        let etag=head.e_tag.filter(|s|!s.is_empty()).ok_or("Missing ETag")?;
        let size=head.content_length.filter(|n|*n>=0).ok_or("Missing model length")? as u64;
        Ok((etag,size))
    }

    pub async fn get_bytes(&self, key: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .bucket
            .get_object(key)
            .await
            .map_err(|e| format!("get {key}: {e}"))?;
        // rust-s3 对 S3 错误（404 NoSuchKey 等）也返回 Ok，必须自查状态码
        let code = resp.status_code();
        if !(200..300).contains(&code) {
            return Err(format!("get {key}: http {code}"));
        }
        Ok(resp.bytes().to_vec())
    }

    /// 列出前缀下全部对象 key（递归，重分类迁移用）
    pub async fn list_keys(&self, prefix: &str) -> Result<Vec<String>, String> {
        let results = self
            .bucket
            .list(prefix.to_string(), None)
            .await
            .map_err(|e| format!("list {prefix}: {e}"))?;
        let mut out = Vec::new();
        for r in results {
            for o in r.contents {
                out.push(o.key);
            }
        }
        Ok(out)
    }

    pub async fn delete_prefix(&self, prefix: &str) -> Result<(), String> {
        for k in self.list_keys(prefix).await? {
            self.bucket
                .delete_object(&k)
                .await
                .map_err(|e| format!("delete {k}: {e}"))?;
        }
        Ok(())
    }

    /// 列出某前缀下的"子目录"（common prefixes），用于枚举资产
    pub async fn list_dirs(&self, prefix: &str) -> Result<Vec<String>, String> {
        let results = self
            .bucket
            .list(prefix.to_string(), Some("/".to_string()))
            .await
            .map_err(|e| format!("list {prefix}: {e}"))?;
        let mut out = Vec::new();
        for r in results {
            if let Some(cps) = r.common_prefixes {
                for cp in cps {
                    let name = cp.prefix.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
                    if !name.is_empty() {
                        out.push(name);
                    }
                }
            }
        }
        Ok(out)
    }

    pub async fn image_keys(&self) -> Result<Vec<String>, String> {
        let results = self.bucket.list(String::new(), None).await.map_err(|e| e.to_string())?;
        Ok(results.into_iter().flat_map(|r| r.contents).map(|o| o.key)
            .filter(|key| key.contains("/source/") && [".png", ".jpg", ".jpeg", ".webp"].iter().any(|ext| key.to_lowercase().ends_with(ext))).collect())
    }

    /// 列出某前缀下的文件名（不含子目录），如 jobs/ 下的 job_001.json
    pub async fn list_files(&self, prefix: &str) -> Result<Vec<String>, String> {
        let results = self
            .bucket
            .list(prefix.to_string(), Some("/".to_string()))
            .await
            .map_err(|e| format!("list {prefix}: {e}"))?;
        let mut out = Vec::new();
        for r in results {
            for o in r.contents {
                let name = o.key.rsplit('/').next().unwrap_or("").to_string();
                if !name.is_empty() {
                    out.push(name);
                }
            }
        }
        out.sort();
        Ok(out)
    }
}
