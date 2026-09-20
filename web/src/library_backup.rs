//! Portable library archives. Files are staged on disk; restores have a durable S3 undo journal.
//! The format preserves asset IDs and every object under each asset, including hidden/trash assets.
use crate::{assets::{AppState, CATEGORIES}, store::{ObjectIdentity, Store}};
use axum::{body::Body, extract::{Multipart, Path, Request, State}, http::StatusCode,
    middleware::Next, response::{IntoResponse, Response}, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::File, io::{Read, Write}, path::{Path as FsPath, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, LazyLock, Mutex}};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex as AsyncMutex, RwLock};
use tokio_util::io::ReaderStream;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

type Shared = Arc<AppState>;
type ApiError = (StatusCode, String);
const FORMAT: &str = "aigccat.library";
const GLOBALS: [&str; 4] = ["_studio/workbench.json", "canvas/layout.json", "style_profile.json", "ledger/totals.json"];
const JOURNAL: &str = "_backups/restore.json";
// Only JSON metadata is buffered. Binary objects and the ZIP are streamed through disk.
const JSON_LIMIT: u64 = 16 * 1024 * 1024;
pub static LIBRARY_GATE: LazyLock<Arc<RwLock<()>>> = LazyLock::new(|| Arc::new(RwLock::new(())));
static RECOVERY_PENDING: AtomicBool = AtomicBool::new(false);
static SESSION: AsyncMutex<Option<Arc<Transfer>>> = AsyncMutex::const_new(None);

fn bad(s: impl ToString) -> ApiError { (StatusCode::BAD_REQUEST, s.to_string()) }
fn internal(s: impl ToString) -> ApiError { (StatusCode::INTERNAL_SERVER_ERROR, s.to_string()) }
fn conflict(s: impl ToString) -> ApiError { (StatusCode::CONFLICT, s.to_string()) }

/// Hold a read lease across requests (including GET handlers that sweep stale jobs).
/// Long-running generation is checked separately before taking a library snapshot.
pub async fn guard(request: Request, next: Next) -> Response {
    if !request.uri().path().starts_with("/api/") || request.uri().path().starts_with("/api/library-backup") {
        return next.run(request).await;
    }
    if RECOVERY_PENDING.load(Ordering::Acquire) {
        return (StatusCode::SERVICE_UNAVAILABLE, "资产库恢复尚未完成，请在打包与恢复窗口重试恢复原库").into_response();
    }
    let Ok(_lease) = LIBRARY_GATE.try_read() else {
        return (StatusCode::LOCKED, "资产库正在打包或恢复，请稍后操作").into_response();
    };
    next.run(request).await
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preset { id: String, name: String, prompt: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry { key: String, size: u64, sha256: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    created_at: u64,
    objects: Vec<Entry>,
    #[serde(default)]
    browser_presets: Option<Vec<Preset>>,
}

struct Transfer {
    id: String,
    dir: PathBuf,
    state: Mutex<Value>,
    manifest: Mutex<Option<Manifest>>,
    baseline: Mutex<Vec<ObjectIdentity>>,
}
impl Drop for Transfer {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); }
}
impl Transfer {
    fn patch(&self, patch: Value) {
        let mut state = self.state.lock().unwrap();
        for (k, v) in patch.as_object().unwrap() { state[k] = v.clone(); }
    }
    fn fail(&self, error: impl ToString) { self.patch(json!({"status":"failed", "message":error.to_string()})); }
    fn progress(&self, message: &str, done: usize, total: usize) {
        self.patch(json!({"message":message,"completed":done,"total":total}));
    }
    fn object_path(&self, index: usize) -> PathBuf { self.dir.join(format!("object-{index}")) }
}

fn active(status: &str) -> bool { matches!(status, "uploading" | "validating" | "building" | "restoring") }
async fn begin(kind: &str, status: &str) -> Result<Arc<Transfer>, ApiError> {
    if RECOVERY_PENDING.load(Ordering::Acquire) { return Err(conflict("请先恢复上次中断的原资产库")); }
    let mut slot = SESSION.lock().await;
    if slot.as_ref().is_some_and(|s| {
        let v = s.state.lock().unwrap(); active(v["status"].as_str().unwrap_or("")) || v["status"] == "preview"
    }) { return Err(conflict("已有打包或导入任务，请先完成或放弃该任务")); }
    let id = crate::history::new_id("backup_");
    let dir = std::env::temp_dir().join(format!("aigccat-{id}"));
    std::fs::create_dir(&dir).map_err(internal)?;
    let transfer = Arc::new(Transfer { id: id.clone(), dir,
        state: Mutex::new(json!({"id":id,"kind":kind,"status":status,"message":"准备中","completed":0,"total":0})),
        manifest: Mutex::new(None), baseline: Mutex::new(Vec::new()) });
    *slot = Some(transfer.clone());
    Ok(transfer)
}
async fn session(id: &str) -> Result<Arc<Transfer>, ApiError> {
    SESSION.lock().await.as_ref().filter(|s| s.id == id).cloned()
        .ok_or((StatusCode::NOT_FOUND, "打包任务已过期，请重新导出或上传".into()))
}
pub async fn current() -> Json<Value> {
    let state = SESSION.lock().await.as_ref().map(|s| s.state.lock().unwrap().clone());
    Json(json!({"transfer":state,"recovery_pending":RECOVERY_PENDING.load(Ordering::Acquire)}))
}
pub async fn status(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let s = session(&id).await?;
    let value = s.state.lock().unwrap().clone();
    Ok(Json(value))
}
pub async fn discard(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let mut slot = SESSION.lock().await;
    let s = slot.as_ref().filter(|s| s.id == id).ok_or_else(|| bad("任务不存在"))?;
    if active(s.state.lock().unwrap()["status"].as_str().unwrap_or("")) { return Err(conflict("任务执行中，请等待完成")); }
    *slot = None;
    Ok(Json(json!({"ok":true})))
}

fn asset_of(key: &str) -> Option<&str> {
    let (dir, rest) = key.split_once('/')?;
    if !CATEGORIES.contains(&dir) { return None; }
    let (id, _) = rest.split_once('/')?;
    Some(&key[..dir.len() + id.len() + 1])
}
fn safe_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 1024 && !key.chars().any(|c| c.is_control() || "\\:%?#".contains(c))
        && key.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
        && (asset_of(key).is_some() || GLOBALS.contains(&key))
}
fn asset_refs(entries: &[Entry]) -> BTreeSet<String> {
    entries.iter().filter_map(|e| asset_of(&e.key).map(str::to_owned)).collect()
}
async fn inventory(store: &Store) -> Result<Vec<ObjectIdentity>, String> {
    let items = store.inventory("").await?;
    let items: Vec<_> = items.into_iter().filter(|o| {
        GLOBALS.contains(&o.key.as_str()) || CATEGORIES.iter().any(|d| o.key.starts_with(&format!("{d}/")))
    }).collect();
    if let Some(item) = items.iter().find(|o| !safe_key(&o.key)) { return Err(format!("资产路径无法打包：{}", item.key)); }
    Ok(items)
}
async fn ensure_idle(store: &Store, items: &[ObjectIdentity]) -> Result<(), String> {
    for item in items.iter().filter(|o| o.key.contains("/jobs/") && o.key.ends_with(".json") && o.key.split('/').count() == 4) {
        let job = store.get_json(&item.key).await?;
        if matches!(job["status"].as_str(), Some("running" | "queued" | "pending" | "processing")) {
            return Err("还有生成或处理任务运行中，请等待完成后再打包或恢复".into());
        }
    }
    Ok(())
}
fn validate_presets(presets: &Option<Vec<Preset>>) -> Result<(), String> {
    if let Some(p) = presets {
        if p.len() > 40 || p.iter().any(|p| p.id.len() > 160 || p.id.is_empty() || p.name.chars().count() > 40 || p.prompt.chars().count() > 10000) {
            return Err("浏览器创作预设格式无效".into());
        }
    }
    Ok(())
}
fn read_json(path: &FsPath) -> Result<Value, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > JSON_LIMIT { return Err("JSON 元数据过大".into()); }
    serde_json::from_reader(file).map_err(|e| format!("JSON 元数据损坏：{e}"))
}
fn digest_copy(mut input: impl Read, mut output: impl Write) -> Result<(u64, String), String> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        hash.update(&buffer[..n]); size += n as u64;
    }
    Ok((size, format!("{:x}", hash.finalize())))
}
fn file_digest(path: &FsPath) -> Result<(u64, String), String> {
    digest_copy(File::open(path).map_err(|e| e.to_string())?, std::io::sink())
}

/// Validate relationships needed by browsing, checkout, and continuing work before any library write.
fn validate_library(s: &Transfer, manifest: &Manifest) -> Result<Value, String> {
    let by_key: BTreeMap<_, _> = manifest.objects.iter().enumerate().map(|(i, e)| (e.key.as_str(), i)).collect();
    let get = |key: &str| -> Result<Value, String> {
        let i = by_key.get(key).ok_or_else(|| format!("备份缺少 {key}"))?;
        read_json(&s.object_path(*i))
    };
    let mut assets = Vec::new();
    for base in asset_refs(&manifest.objects) {
        let asset = get(&format!("{base}/asset.json"))?;
        let spec = get(&format!("{base}/source/spec.json"))?;
        let latest = get(&format!("{base}/latest.json"))?;
        let (dir, id) = base.split_once('/').unwrap();
        if asset["asset_id"].as_str() != Some(id) || crate::assets::category_info(asset["asset_type"].as_str().unwrap_or("")).map(|(_,d)|d) != Some(dir)
            || !spec.is_object() || !latest.is_object() { return Err(format!("资产标识或元数据不一致：{base}")); }
        let version_exists = |version: &str| -> bool {
            by_key.contains_key(format!("{base}/versions/{version}/model.glb").as_str())
                && by_key.contains_key(format!("{base}/versions/{version}/meta.json").as_str())
        };
        for field in ["latest", "approved", "published"] {
            if let Some(version) = latest[field].as_str() {
                if !version_exists(version) { return Err(format!("{base} 的 {field} 指向缺失版本 {version}")); }
            } else if !latest[field].is_null() { return Err(format!("{base} 的版本指针无效")); }
        }
        if let Some(version) = asset["version"].as_str() {
            if !version_exists(version) { return Err(format!("{base} 的资产版本缺失")); }
        }
        let index_key = format!("{base}/history/index.json");
        let head_key = format!("{base}/history/head.json");
        if by_key.contains_key(index_key.as_str()) || by_key.contains_key(head_key.as_str()) {
            let index = get(&index_key)?;
            let nodes = index.as_array().or_else(|| index["nodes"].as_array()).ok_or("历史索引无效")?;
            let mut known = BTreeSet::new();
            for value in nodes {
                let node: crate::history::HistoryNode = serde_json::from_value(value.clone()).map_err(|_| "历史节点无效")?;
                if node.parent_id.as_ref().is_some_and(|p| !known.contains(p)) || !known.insert(node.id.clone()) || !version_exists(&node.revision_id) {
                    return Err(format!("{base} 的历史关系或版本缺失"));
                }
                let file = &manifest.objects[by_key[format!("{base}/versions/{}/model.glb", node.revision_id).as_str()]];
                if node.snapshot_hash != file.sha256 { return Err(format!("{base} 的历史模型校验不一致")); }
            }
            let head = get(&head_key)?;
            if !head["head"].is_null() && !head["head"].as_str().is_some_and(|h| known.contains(h)) { return Err(format!("{base} 的历史 HEAD 缺失")); }
        }
        assets.push(json!({"ref":base,"name":asset["name"]}));
    }
    for key in GLOBALS { if by_key.contains_key(key) && !get(key)?.is_object() { return Err(format!("库设置无效：{key}")); } }
    // All JSON objects must parse, including jobs, metadata and task checkpoints.
    for (i, entry) in manifest.objects.iter().enumerate().filter(|(_, e)| e.key.ends_with(".json")) {
        let value = read_json(&s.object_path(i)).map_err(|e| format!("{}：{e}", entry.key))?;
        if entry.key.contains("/jobs/") && entry.key.split('/').count() == 4
            && matches!(value["status"].as_str(), Some("running" | "queued" | "pending" | "processing")) {
            return Err(format!("备份包含未完成的生成任务：{}；请在源部署完成任务后重新导出", entry.key));
        }
    }
    let bytes = manifest.objects.iter().try_fold(0u64, |n, e| n.checked_add(e.size)).ok_or("备份大小溢出")?;
    Ok(json!({"assets":assets,"asset_count":assets.len(),"files":manifest.objects.len(),"bytes":bytes,
        "versions":manifest.objects.iter().filter(|e|e.key.ends_with("/model.glb") && e.key.contains("/versions/")).count(),
        "images":manifest.objects.iter().filter(|e|e.key.contains("/source/") && [".png",".jpg",".jpeg",".webp"].iter().any(|ext|e.key.to_lowercase().ends_with(ext))).count(),
        "created_at":manifest.created_at,"preset_count":manifest.browser_presets.as_ref().map_or(0,Vec::len),
        "has_presets":manifest.browser_presets.is_some(),"settings":GLOBALS.iter().filter(|k|by_key.contains_key(**k)).collect::<Vec<_>>()}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportRequest { #[serde(default)] browser_presets: Option<Vec<Preset>> }
pub async fn export(State(st): State<Shared>, Json(req): Json<ExportRequest>) -> Result<Json<Value>, ApiError> {
    validate_presets(&req.browser_presets).map_err(bad)?;
    let s = begin("export", "building").await?;
    let response = s.state.lock().unwrap().clone();
    tokio::spawn(async move {
        let _lease = LIBRARY_GATE.write().await;
        if let Err(e) = build_archive(&st.store, &s, req.browser_presets).await { s.fail(e); }
    });
    Ok(Json(response))
}
async fn build_archive(store: &Store, s: &Arc<Transfer>, presets: Option<Vec<Preset>>) -> Result<(), String> {
    let before = inventory(store).await?;
    ensure_idle(store, &before).await?;
    let mut entries = Vec::new();
    for (i, item) in before.iter().enumerate() {
        s.progress("正在读取资产文件", i, before.len());
        let path = s.object_path(i);
        store.download_file(&item.key, &path).await?;
        let (size, sha256) = tokio::task::spawn_blocking(move || file_digest(&path)).await.map_err(|e| e.to_string())??;
        if size != item.size { return Err("文件在打包过程中发生变化，请重新导出".into()); }
        entries.push(Entry { key: item.key.clone(), size, sha256 });
    }
    if inventory(store).await? != before { return Err("资产库在打包过程中发生变化，请重新导出".into()); }
    let manifest = Manifest { format: FORMAT.into(), version: 1, created_at: crate::ops::now_epoch(), objects: entries, browser_presets: presets };
    s.progress("正在校验历史关系并写入 ZIP", before.len(), before.len());
    let clone = s.clone();
    let summary = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let summary = validate_library(&clone, &manifest)?;
        let manifest_bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
        if manifest_bytes.len() as u64 > JSON_LIMIT {
            return Err("文件清单超过当前格式的 16 MiB 上限，无法生成可恢复的备份".into());
        }
        let file = File::create(clone.dir.join("library.zip")).map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(file);
        // PNG/GLB are already large binaries. Stored ZIP avoids decompression bombs and uses ZIP64 as needed.
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (i, entry) in manifest.objects.iter().enumerate() {
            zip.start_file(format!("objects/{}", entry.key), options.large_file(entry.size >= u32::MAX as u64)).map_err(|e| e.to_string())?;
            let mut input = File::open(clone.object_path(i)).map_err(|e| e.to_string())?;
            std::io::copy(&mut input, &mut zip).map_err(|e| e.to_string())?;
        }
        zip.start_file("manifest.json", options).map_err(|e| e.to_string())?;
        zip.write_all(&manifest_bytes).map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?.sync_all().map_err(|e| e.to_string())?;
        Ok(summary)
    }).await.map_err(|e| e.to_string())??;
    // Only the ZIP is needed after export; release the staged object copies.
    for i in 0..before.len() { tokio::fs::remove_file(s.object_path(i)).await.map_err(|e|e.to_string())?; }
    s.patch(json!({"status":"ready","message":"打包完成，可以下载","summary":summary,
        "download_url":format!("/api/library-backup/{}/download",s.id)}));
    Ok(())
}
pub async fn download(Path(id): Path<String>) -> Result<Response, ApiError> {
    let s = session(&id).await?;
    if s.state.lock().unwrap()["status"] != "ready" { return Err(conflict("备份尚未准备完成")); }
    let file = tokio::fs::File::open(s.dir.join("library.zip")).await.map_err(internal)?;
    let size = file.metadata().await.map_err(internal)?.len();
    Ok(([("content-type", "application/zip".to_string()), ("content-length", size.to_string()),
        ("content-disposition", format!("attachment; filename=\"aigccat-library-{}.zip\"", crate::ops::now_epoch())),
        ("cache-control", "no-store".into())], Body::from_stream(ReaderStream::new(file))).into_response())
}

struct UploadGuard(Arc<Transfer>);
impl Drop for UploadGuard {
    fn drop(&mut self) {
        if self.0.state.lock().unwrap()["status"] == "uploading" { self.0.fail("上传中断，请重新选择备份文件"); }
    }
}
pub async fn upload(State(st): State<Shared>, mut multipart: Multipart) -> Result<Json<Value>, ApiError> {
    let s = begin("import", "uploading").await?;
    let _upload_guard = UploadGuard(s.clone());
    let result = async {
        let mut field = multipart.next_field().await.map_err(bad)?.ok_or_else(|| bad("请选择 ZIP 备份"))?;
        if field.name() != Some("file") { return Err(bad("需要 file 字段")); }
        let mut file = tokio::fs::File::create(s.dir.join("library.zip")).await.map_err(internal)?;
        while let Some(chunk) = field.chunk().await.map_err(bad)? { file.write_all(&chunk).await.map_err(internal)?; }
        file.sync_all().await.map_err(internal)?;
        // multer permits only one live field; release it before checking for extra fields.
        drop(field);
        if multipart.next_field().await.map_err(bad)?.is_some() { return Err(bad("一次只能上传一个备份")); }
        Ok::<(), ApiError>(())
    }.await;
    if let Err(e) = result { s.fail(&e.1); return Err(e); }
    s.patch(json!({"status":"validating","message":"正在校验备份内容"}));
    let response = s.state.lock().unwrap().clone();
    tokio::spawn(async move {
        let clone = s.clone();
        let result = async {
            let (manifest, mut summary) = tokio::task::spawn_blocking(move || unpack(&clone)).await.map_err(|e|e.to_string())??;
            let before = inventory(&st.store).await?;
            let existing: BTreeSet<_> = before.iter().filter_map(|e|asset_of(&e.key)).collect();
            summary["conflicts"] = json!(asset_refs(&manifest.objects).iter().filter(|a|existing.contains(a.as_str())).collect::<Vec<_>>());
            summary["current_assets"] = json!(existing.len());
            *s.baseline.lock().unwrap() = before;
            *s.manifest.lock().unwrap() = Some(manifest);
            s.patch(json!({"status":"preview","message":"完整性校验通过，请选择恢复方式","summary":summary}));
            Ok::<(), String>(())
        }.await;
        if let Err(e) = result { s.fail(e); }
    });
    Ok(Json(response))
}
fn unpack(s: &Transfer) -> Result<(Manifest, Value), String> {
    let mut zip = ZipArchive::new(File::open(s.dir.join("library.zip")).map_err(|e|e.to_string())?).map_err(|_| "无法读取 ZIP 备份")?;
    let manifest: Manifest = {
        let entry = zip.by_name("manifest.json").map_err(|_| "这是普通 ZIP，不是 aigccat 资产库备份")?;
        if entry.size() > JSON_LIMIT { return Err("备份清单过大".into()); }
        serde_json::from_reader(entry.take(JSON_LIMIT + 1)).map_err(|_| "备份清单损坏")?
    };
    if manifest.format != FORMAT || manifest.version != 1 { return Err("不支持此备份格式或版本".into()); }
    validate_presets(&manifest.browser_presets)?;
    if zip.len() != manifest.objects.len() + 1 { return Err("ZIP 文件数量与备份清单不一致".into()); }
    let mut names = BTreeSet::new();
    for i in 0..zip.len() {
        let file = zip.by_index(i).map_err(|_| "ZIP 条目无效")?;
        if !names.insert(file.name().to_string()) || file.is_dir() || file.encrypted()
            || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            || file.compression() != CompressionMethod::Stored || file.compressed_size() != file.size() {
            return Err("备份包含重复、压缩、加密或非普通文件条目".into());
        }
    }
    let mut keys = BTreeSet::new();
    for (i, entry) in manifest.objects.iter().enumerate() {
        if !safe_key(&entry.key) || !keys.insert(&entry.key) || entry.sha256.len() != 64 || !entry.sha256.bytes().all(|b|b.is_ascii_hexdigit()) {
            return Err(format!("备份文件路径或校验信息无效：{}",entry.key));
        }
        let name = format!("objects/{}",entry.key);
        let mut input = zip.by_name(&name).map_err(|_|format!("备份缺少 {}",entry.key))?;
        if input.size() != entry.size { return Err(format!("文件大小不一致：{}",entry.key)); }
        s.progress("正在验证文件校验和", i, manifest.objects.len());
        let output = File::create(s.object_path(i)).map_err(|e|e.to_string())?;
        let (size, hash) = digest_copy(&mut input, output)?;
        if size != entry.size || hash != entry.sha256 { return Err(format!("文件校验失败：{}",entry.key)); }
    }
    let summary = validate_library(s, &manifest)?;
    Ok((manifest, summary))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestoreRequest {
    conflicts: String,
    #[serde(default)] restore_settings: bool,
    #[serde(default)] restore_presets: bool,
}
#[derive(Serialize, Deserialize)]
struct Previous { key: String, backup: Option<String> }
#[derive(Serialize, Deserialize)]
struct Journal { id: String, phase: String, entries: Vec<Previous> }

pub async fn restore(State(st): State<Shared>, Path(id): Path<String>, Json(req): Json<RestoreRequest>) -> Result<Json<Value>, ApiError> {
    if !["skip", "replace"].contains(&req.conflicts.as_str()) { return Err(bad("请选择跳过或替换同编号资产")); }
    let s = session(&id).await?;
    {
        let mut state = s.state.lock().unwrap();
        if state["status"] != "preview" { return Err(conflict("请先上传并校验备份")); }
        state["status"] = json!("restoring"); state["message"] = json!("准备恢复");
    }
    let response = s.state.lock().unwrap().clone();
    tokio::spawn(async move {
        let _lease = LIBRARY_GATE.write().await;
        if let Err(e) = apply_restore(&st.store, &s, req).await { s.fail(e); }
    });
    Ok(Json(response))
}
async fn apply_restore(store: &Store, s: &Transfer, req: RestoreRequest) -> Result<(), String> {
    if RECOVERY_PENDING.load(Ordering::Acquire) { return Err("请先恢复原资产库".into()); }
    let before = inventory(store).await?;
    if before != *s.baseline.lock().unwrap() { return Err("当前资产库在预览后发生变化，请重新上传备份并核对冲突".into()); }
    ensure_idle(store, &before).await?;
    let manifest = s.manifest.lock().unwrap().clone().ok_or("备份清单不存在")?;
    let existing: BTreeSet<_> = before.iter().filter_map(|o|asset_of(&o.key).map(str::to_owned)).collect();
    let all = asset_refs(&manifest.objects);
    let selected: BTreeSet<_> = all.iter().filter(|a| req.conflicts == "replace" || !existing.contains(*a)).cloned().collect();
    let affected = |key: &str| asset_of(key).is_some_and(|a| selected.contains(a)) || req.restore_settings && GLOBALS.contains(&key);
    let incoming: Vec<_> = manifest.objects.iter().enumerate().filter(|(_,e)|affected(&e.key)).collect();
    let mut keys: BTreeSet<_> = before.iter().filter(|o|affected(&o.key)).map(|o|o.key.clone()).collect();
    keys.extend(incoming.iter().map(|(_,e)|e.key.clone()));
    let old: BTreeSet<_> = before.iter().map(|e|e.key.as_str()).collect();
    let mut journal = Journal { id: s.id.clone(), phase: "preparing".into(), entries: keys.into_iter().enumerate().map(|(i,key)| {
        let backup = old.contains(key.as_str()).then(||format!("_backups/{}/old-{i}",s.id));
        Previous { key, backup }
    }).collect() };
    if !journal.entries.is_empty() {
        store.put_json(JOURNAL,&serde_json::to_value(&journal).unwrap()).await?;
        let result = async {
            for (i, entry) in journal.entries.iter().enumerate() {
                s.progress("正在保存恢复前的数据",i,journal.entries.len());
                if let Some(backup) = &entry.backup { store.copy_object(&entry.key,backup).await?; }
            }
            if inventory(store).await? != before { return Err("准备期间资产库发生变化，未执行恢复".into()); }
            journal.phase = "applying".into();
            store.put_json(JOURNAL,&serde_json::to_value(&journal).unwrap()).await?;
            for (done,(i,entry)) in incoming.iter().enumerate() {
                s.progress("正在恢复资产文件",done,incoming.len());
                store.upload_file(&entry.key,&s.object_path(*i)).await?;
            }
            let incoming_keys: BTreeSet<_> = incoming.iter().map(|(_,e)|e.key.as_str()).collect();
            for entry in &journal.entries {
                if !incoming_keys.contains(entry.key.as_str()) { store.delete_object(&entry.key).await?; }
            }
            // Read back every restored byte before declaring success; etags alone are not checksums.
            for (done,(_,entry)) in incoming.iter().enumerate() {
                s.progress("正在校验已恢复的文件",done,incoming.len());
                let path = s.dir.join("verify");
                store.download_file(&entry.key,&path).await?;
                let hash = tokio::task::spawn_blocking(move || file_digest(&path)).await.map_err(|e|e.to_string())??;
                if hash != (entry.size,entry.sha256.clone()) { return Err(format!("恢复后的文件校验失败：{}",entry.key)); }
            }
            journal.phase = "committed".into();
            store.put_json(JOURNAL,&serde_json::to_value(&journal).unwrap()).await?;
            Ok::<(),String>(())
        }.await;
        if let Err(error) = result {
            s.progress("恢复未完成，正在还原原资产库",0,0);
            if let Err(undo_error) = recover(store).await {
                RECOVERY_PENDING.store(true,Ordering::Release);
                return Err(format!("{error}；原库还原暂未完成：{undo_error}。请重试恢复原库"));
            }
            return Err(format!("{error}；原资产库已保留"));
        }
        // Cleanup failures do not turn a committed restore into a failed one; startup retries cleanup.
        if let Err(e) = cleanup_journal(store,&journal).await { tracing::warn!(error=%e,"backup journal cleanup pending"); }
    }
    s.patch(json!({"status":"done","message":"资产恢复完成","completed":incoming.len(),"total":incoming.len(),
        "result":{"imported":selected.len(),"skipped":all.len()-selected.len(),"settings_restored":req.restore_settings,
        "browser_presets":if req.restore_presets {manifest.browser_presets} else {None}}}));
    Ok(())
}
async fn cleanup_journal(store: &Store, journal: &Journal) -> Result<(), String> {
    // Journal removed last: a restart can always distinguish rollback from cleanup.
    for entry in &journal.entries {
        if let Some(key) = &entry.backup { store.delete_object(key).await?; }
    }
    store.delete_object(JOURNAL).await
}
pub async fn recover(store: &Store) -> Result<(), String> {
    RECOVERY_PENDING.store(true,Ordering::Release);
    let result = async {
        if !store.list_keys("_backups/").await?.iter().any(|k|k == JOURNAL) { return Ok(()); }
        let mut journal: Journal = serde_json::from_value(store.get_json(JOURNAL).await?).map_err(|_|"恢复日志损坏")?;
        if journal.entries.iter().any(|e|!safe_key(&e.key) || e.backup.as_ref().is_some_and(|b|!b.starts_with(&format!("_backups/{}/old-",journal.id)))) {
            return Err("恢复日志路径无效".into());
        }
        if journal.phase == "applying" {
            for entry in &journal.entries {
                if let Some(backup) = &entry.backup { store.copy_object(backup,&entry.key).await?; }
                else { store.delete_object(&entry.key).await?; }
            }
            // Durable marker must precede deleting undo copies, including on rollback.
            journal.phase = "rolled_back".into();
            store.put_json(JOURNAL,&serde_json::to_value(&journal).unwrap()).await?;
        } else if !["preparing","committed","rolled_back"].contains(&journal.phase.as_str()) {
            return Err("恢复日志状态无效".into());
        }
        cleanup_journal(store,&journal).await
    }.await;
    if result.is_ok() { RECOVERY_PENDING.store(false,Ordering::Release); }
    result
}
pub async fn retry_recovery(State(st): State<Shared>) -> Result<Json<Value>, ApiError> {
    let _lease = LIBRARY_GATE.clone().try_write_owned().map_err(|_|conflict("正在执行资产库任务"))?;
    recover(&st.store).await.map_err(internal)?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
#[path = "library_backup_tests.rs"]
mod tests;
