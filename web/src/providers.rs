//! 内置 3D 生成供应商注册表：端点、鉴权、模型清单的唯一事实来源。
//!
//! 生成链路按 provider id 路由（model_jobs.rs 的 match）：`tripo` 走 tripo.rs、
//! `meshy` 走 meshy.rs；其余三家端点已核对、后台可直接配 Key，
//! 传输层按 meshy.rs 的模式逐家补齐（逐家字段说明见 docs/PROVIDERS.md）。

/// 鉴权方式。四家是 Bearer；混元走腾讯云 TC3 签名（SecretId + SecretKey）。
/// 生成入口的提示语会据此给出正确的配置指引。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    Bearer,
    TencentCloudSignature,
}

pub struct Builtin {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    /// 环境变量里的默认 Key（后台「模型配置管理」保存过的 Key 优先；两者都空 = 未配置）
    pub key_env: &'static str,
    pub docs: &'static str,
    pub models: &'static [&'static str],
    pub auth: Auth,
}

pub const BUILTIN: &[Builtin] = &[
    Builtin {
        id: "tripo",
        name: "Tripo 3D",
        base_url: "https://openapi.tripo3d.ai/v3",
        key_env: "TRIPO_API_KEY",
        docs: "https://platform.tripo3d.ai/docs",
        models: &["P1-20260311", "v3.1-20260211", "v3.0-20250812", "v2.5-20250123"],
        auth: Auth::Bearer,
    },
    Builtin {
        id: "meshy",
        name: "Meshy",
        base_url: "https://api.meshy.ai/openapi/v2",
        key_env: "MESHY_API_KEY",
        docs: "https://docs.meshy.ai",
        // "latest" 会解析到当前最新（现为 Meshy 6）；面向个人用户省去追版本
        models: &["latest", "meshy-6", "meshy-5"],
        auth: Auth::Bearer,
    },
    Builtin {
        id: "rodin",
        name: "Rodin (Hyper3D)",
        base_url: "https://api.hyper3d.com/api/v2",
        key_env: "RODIN_API_KEY",
        docs: "https://docs.hyper3d.ai",
        models: &["Gen-2.5-Medium", "Gen-2", "Regular", "Sketch", "Detail", "Smooth"],
        auth: Auth::Bearer,
    },
    Builtin {
        id: "hunyuan3d",
        name: "Hunyuan3D（腾讯混元生3D）",
        base_url: "https://ai3d.tencentcloudapi.com",
        key_env: "HUNYUAN_SECRET_ID",
        docs: "https://cloud.tencent.com/document/product/1804/123463",
        models: &["hunyuan-to3d-rapid", "hunyuan-to3d-pro"],
        auth: Auth::TencentCloudSignature,
    },
    Builtin {
        id: "hi3d",
        name: "Hi3D (Hitem3D)",
        base_url: "https://api.hitem3d.ai/open-api/v1",
        key_env: "HITEM3D_API_KEY",
        docs: "https://docs.hitem3d.ai",
        models: &["hi3dv3.0", "hitem3dv2.1", "hitem3dv2.0", "hitem3dv1.5"],
        auth: Auth::Bearer,
    },
];

pub fn builtin(id: &str) -> Option<&'static Builtin> {
    BUILTIN.iter().find(|b| b.id == id)
}

/// 模型配置校验：内置供应商只接受各自清单里的模型名。
pub fn models_of(provider_id: &str) -> Option<&'static [&'static str]> {
    builtin(provider_id).map(|b| b.models)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_is_consistent() {
        assert_eq!(BUILTIN.len(), 5);
        let ids: Vec<_> = BUILTIN.iter().map(|b| b.id).collect();
        // id 唯一，且不会与 catalog 自动生成的 "provider-N" 撞名
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "存在重复 id");
        assert!(ids.iter().all(|id| !id.starts_with("provider-")));
        for b in BUILTIN {
            assert!(!b.models.is_empty(), "{} 的模型清单为空", b.id);
            assert!(b.base_url.starts_with("https://"), "{} 的端点必须是 HTTPS", b.id);
            assert!(b.key_env.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'), "{} 的 key_env 不规范", b.id);
        }
        // 混元是唯一一家非 Bearer 鉴权：提示语与文档都依赖这一点
        assert_eq!(BUILTIN.iter().filter(|b| b.auth == Auth::TencentCloudSignature).count(), 1);
        assert!(builtin("hunyuan3d").unwrap().auth == Auth::TencentCloudSignature);
        // 五家都能被 models_of 找到；未知供应商返回 None（走自定义接入的旧校验）
        assert!(BUILTIN.iter().all(|b| models_of(b.id).is_some()));
        assert!(models_of("provider-1").is_none());
    }
}
