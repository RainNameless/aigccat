//! OpenCode adapter. Supplier secrets remain in Rust; agent only sees task-scoped files.
use std::{sync::Arc,time::Duration};
use axum::{body::{Body,Bytes},extract::{State,Path,Query},http::{HeaderMap,Method,StatusCode},response::{Response,IntoResponse},Json};
use serde_json::{Value,json};
use crate::assets::AppState;
type Error=(StatusCode,String);
fn token()->String {std::env::var("RIG_AGENT_TOKEN").unwrap_or_default()}
fn client(seconds:u64)->Result<reqwest::Client,Error>{reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(seconds)).build().map_err(|_|(StatusCode::INTERNAL_SERVER_ERROR,"客户端初始化失败".into()))}
fn same_origin(h:&HeaderMap)->bool{
 let Some(origin)=h.get("origin").and_then(|h|h.to_str().ok()) else{return false};
 let Some(host)=h.get("host").and_then(|h|h.to_str().ok()) else{return false};
 origin==std::env::var("SERVICES_PUBLIC_ORIGIN").ok().filter(|s|!s.is_empty()).unwrap_or_else(||format!("http://{host}"))
}
fn allowed(path:&str,method:&Method)->bool{
 if path=="health" {return method==Method::GET}
 if path=="tasks" {return method==Method::GET||method==Method::POST}
 let p:Vec<_>=path.split('/').collect();
 if p.len()<2||p[0]!="tasks"||!p[1].starts_with("rig_")||p[1].len()!=28||!p[1][4..].bytes().all(|b|b.is_ascii_hexdigit()){return false}
 (p.len()==2&&method==Method::GET)||(p.len()==3&&((p[2]=="cancel"&&method==Method::POST)||(p[2]=="image"&&method==Method::GET)))
}
pub async fn proxy(State(st):State<Arc<AppState>>,Path(path):Path<String>,Query(query):Query<std::collections::HashMap<String,String>>,method:Method,headers:HeaderMap,body:Bytes)->Result<Response,Error>{
 if !allowed(&path,&method){return Err((StatusCode::NOT_FOUND,"接口不存在".into()))}
 if method!=Method::GET&&!same_origin(&headers){return Err((StatusCode::FORBIDDEN,"操作要求同源 Origin".into()))}
 let secret=token();if secret.is_empty(){return Err((StatusCode::SERVICE_UNAVAILABLE,"OpenCode 尚未配置".into()))}
 let mut payload=body.to_vec();
 if path=="tasks"&&method==Method::POST{
  let mut value:Value=serde_json::from_slice(&body).map_err(|_|(StatusCode::BAD_REQUEST,"任务格式无效".into()))?;
  let id=value["model_id"].as_str().ok_or((StatusCode::BAD_REQUEST,"请选择文字模型".into()))?;
  let service=crate::services::rig_text_model(&st.cfg,id).map_err(|s|(StatusCode::BAD_REQUEST,s))?;
  value["model_name"]=json!(service.model);payload=serde_json::to_vec(&value).unwrap();
 }
 let url=format!("{}/{}",std::env::var("RIG_AGENT_URL").unwrap_or_else(|_|"http://opencode:4097".into()).trim_end_matches('/'),path);
 let upstream=client(35)?.request(method.clone(),url).bearer_auth(secret).query(&query).header("Content-Type","application/json").body(payload).send().await.map_err(|_|(StatusCode::BAD_GATEWAY,"OpenCode 执行器不可达，任务不会自动重新提交".into()))?;
 let status=upstream.status();let kind=upstream.headers().get("content-type").and_then(|h|h.to_str().ok()).unwrap_or("application/json").to_string();
 let bytes=crate::services::bounded_body(upstream,8*1024*1024).await.map_err(|e|(StatusCode::BAD_GATEWAY,e))?;
 Ok((status,[("content-type",kind),("cache-control","no-store".into())],Body::from(bytes)).into_response())
}
pub async fn provider(State(st):State<Arc<AppState>>,headers:HeaderMap,Json(mut input):Json<Value>)->Result<Json<Value>,Error>{
 let secret=token();if secret.is_empty()||headers.get("authorization").and_then(|s|s.to_str().ok())!=Some(format!("Bearer {secret}").as_str()){return Err((StatusCode::FORBIDDEN,"内部接口".into()))}
 let id=input["model_id"].as_str().ok_or((StatusCode::BAD_REQUEST,"缺少模型".into()))?;
 let service=crate::services::rig_text_model(&st.cfg,id).map_err(|e|(StatusCode::BAD_REQUEST,e))?;
 let req=&mut input["request"];if !req.is_object()||!req["messages"].is_array(){return Err((StatusCode::BAD_REQUEST,"模型请求无效".into()))}
 req["model"]=json!(service.model);req["stream"]=json!(false);
 if let Some(obj)=req.as_object_mut(){obj.remove("stream_options");obj.remove("user");}
 let r=client(180)?.post(format!("{}/chat/completions",service.base_url.trim_end_matches('/'))).bearer_auth(service.api_key).json(req).send().await.map_err(|e|(StatusCode::BAD_GATEWAY,crate::services::network_error(e)))?;
 let r=crate::services::check_response(r).await.map_err(|e|(StatusCode::BAD_GATEWAY,e))?;
 let bytes=crate::services::bounded_body(r,4*1024*1024).await.map_err(|e|(StatusCode::BAD_GATEWAY,e))?;
 Ok(Json(serde_json::from_slice(&bytes).map_err(|_|(StatusCode::BAD_GATEWAY,"模型响应不是JSON".into()))?))
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn endpoints_are_scoped(){assert!(allowed("health",&Method::GET));assert!(allowed("tasks/rig_0123456789abcdef01234567/cancel",&Method::POST));for p in ["config","session","tasks/../config","tasks/rig_0123456789abcdef01234567/unknown"]{assert!(!allowed(p,&Method::GET));}assert!(!allowed("tasks/rig_0123456789abcdef01234567",&Method::DELETE));}
 #[test]fn mutations_need_same_origin(){let mut h=HeaderMap::new();h.insert("host","localhost:8080".parse().unwrap());assert!(!same_origin(&h));h.insert("origin","http://evil.example".parse().unwrap());assert!(!same_origin(&h));h.insert("origin","http://localhost:8080".parse().unwrap());assert!(same_origin(&h));}
}
