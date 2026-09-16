//! 资产历史树 + 任务检查点
//!
//! 历史树为 append-only、分支保留（checkout 后再提交产生分支，旧子节点永不删除/改写），
//! 任务事件同样 append-only。设计参考 psd2live（GPL-3.0，
//! https://github.com/tsunehimatoi/psd2live）的 WorkspaceHistoryTree / AgentTaskManager，
//! 按本仓库 Rust/axum + MinIO 栈独立重写，见仓库根 THIRD_PARTY_NOTICES.md。
//!
//! MinIO 布局（每资产）：
//! - history/index.json  全部节点元数据（数组；追加时整体重写文件，但已有节点逐字节不变）
//! - history/head.json   HEAD 指针（{"head": "h_..."}，put 即原子替换）
//! - tasks/{task_id}.json 任务检查点（计划 + append-only 事件流）

use crate::assets::{AppState, CATEGORIES};
use crate::store::Store;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

type Shared = Arc<AppState>;
type ApiResult<T> = Result<T, (StatusCode, String)>;

fn e400(m: impl Into<String>) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, m.into())
}
fn e500(m: impl Into<String>) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, m.into())
}

/// 历史树 / 任务事件的进程级互斥：单实例部署下把并发写变成显式排队，
/// 避免 index.json / tasks/*.json 的读-改-写互相覆盖（参考 psd2live 的 @Synchronized）。
static HISTORY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 进程内单调计数 + 纳秒时钟 → 无外部 crate 的随机 ID（h_ 历史节点 / t_ 任务）
static ID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn new_id(prefix: &str) -> String {
    use std::sync::atomic::Ordering;
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let seq = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{:x}{:04x}", nanos, seq & 0xffff)
}

// ---------- SHA-256（内容寻址哈希，非安全敏感用途） ----------
// 离线测试镜像只挂载 src/，Cargo.toml 固化在镜像内无法新增依赖，
// 故按 FIPS 180-4 内置实现（测试用 NIST 标准向量验证）。

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    // 填充：0x80 + 0 直到 ≡ 56 (mod 64)，再接 8 字节大端位长
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

// ---------- 历史树（纯核心，便于离线单测） ----------

/// 一次已提交工作区状态的不可变元数据。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HistoryNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub revision_id: String,
    pub snapshot_hash: String,
    pub summary: String,
    /// "user" | "agent" | "system"
    pub actor: String,
    pub task_id: Option<String>,
    pub created_at: u64,
}

/// append-only 历史树：节点只增不改，HEAD 只是可移动指针。
/// MinIO 上的 index.json / head.json 由 [load_tree] / [persist_tree] 负责，
/// 这里只做内存结构与树不变量（单根、父节点存在、append 必须挂到 HEAD）。
#[derive(Default)]
pub struct HistoryTree {
    pub head: Option<String>,
    pub nodes: Vec<HistoryNode>,
}

impl HistoryTree {
    /// 从 index.json + head.json 内容恢复树（坏数据不致命：解析失败的节点忽略，
    /// head 必须指向存在的节点）。
    pub fn from_parts(index: &Value, head: Option<&str>) -> Self {
        let arr = index
            .as_array()
            .cloned()
            .or_else(|| index["nodes"].as_array().cloned())
            .unwrap_or_default();
        let nodes: Vec<HistoryNode> = arr
            .iter()
            .filter_map(|n| serde_json::from_value(n.clone()).ok())
            .collect();
        let head = head
            .filter(|h| nodes.iter().any(|n| n.id == *h))
            .map(String::from);
        HistoryTree { head, nodes }
    }

    pub fn node(&self, id: &str) -> Option<&HistoryNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    /// 校验并追加节点，随后 HEAD 前进到新节点；返回新节点 ID。
    /// 已有节点（包括 HEAD 旧值）不做任何修改 —— 分支由此自然产生。
    pub fn append(
        &mut self,
        parent_id: Option<&str>,
        revision_id: &str,
        snapshot_hash: &str,
        summary: &str,
        actor: &str,
        task_id: Option<&str>,
        created_at: u64,
    ) -> Result<String, String> {
        if revision_id.trim().is_empty() {
            return Err("revision_id 不能为空".into());
        }
        if snapshot_hash.trim().is_empty() {
            return Err("snapshot_hash 不能为空".into());
        }
        if summary.trim().is_empty() {
            return Err("summary 不能为空".into());
        }
        if !matches!(actor, "user" | "agent" | "system") {
            return Err(format!("非法 actor: {actor}"));
        }
        if !self.nodes.is_empty() && parent_id.is_none() {
            return Err("历史树已有根节点，不能再追加无父节点的节点".into());
        }
        if let Some(p) = parent_id {
            if self.node(p).is_none() {
                return Err(format!("父节点不存在: {p}"));
            }
        }
        let node = HistoryNode {
            id: new_id("h_"),
            parent_id: parent_id.map(String::from),
            revision_id: revision_id.to_string(),
            snapshot_hash: snapshot_hash.to_string(),
            summary: summary.to_string(),
            actor: actor.to_string(),
            task_id: task_id.map(String::from),
            created_at,
        };
        self.nodes.push(node.clone());
        self.head = Some(node.id.clone());
        Ok(node.id)
    }

    /// 把 HEAD 移到既有节点；不新增、不修改任何节点。
    pub fn checkout(&mut self, node_id: &str) -> Result<HistoryNode, String> {
        let node = self
            .node(node_id)
            .ok_or_else(|| format!("历史节点不存在: {node_id}"))?
            .clone();
        self.head = Some(node.id.clone());
        Ok(node)
    }
}

/// 版本写入的历史提交输入。
pub struct VersionCommit<'a> {
    /// 本次写入前的 latest 版本（无树时用它初始化 root）
    pub prev_latest: Option<&'a str>,
    /// prev_latest 对应 model.glb 的 sha256（调用方算好传入，便于纯函数测试）
    pub prev_snapshot_hash: Option<&'a str>,
    pub revision_id: &'a str,
    pub snapshot_hash: &'a str,
    pub summary: &'a str,
    pub actor: &'a str,
    pub task_id: Option<&'a str>,
}

/// 写路径核心：无树时先以 prev_latest 建 root（actor=system），再把新版本追加为当前 HEAD 的子节点。
/// prev_latest 缺失（资产从未有过版本）时，新版本自身成为 root。
pub fn commit_version(tree: &mut HistoryTree, c: &VersionCommit, now: u64) -> Result<String, String> {
    if tree.nodes.is_empty() {
        if let (Some(prev), Some(hash)) = (c.prev_latest, c.prev_snapshot_hash) {
            if !prev.is_empty() && prev != c.revision_id {
                tree.append(
                    None,
                    prev,
                    hash,
                    &format!("载入已有版本 → {prev}"),
                    "system",
                    None,
                    now,
                )?;
            }
        }
    }
    let parent = tree
        .head
        .clone()
        .or_else(|| tree.nodes.last().map(|n| n.id.clone()));
    tree.append(
        parent.as_deref(),
        c.revision_id,
        c.snapshot_hash,
        c.summary,
        c.actor,
        c.task_id,
        now,
    )
}

// ---------- MinIO 读写（沿用 store.rs 的 get_json/put_json 模式） ----------

fn index_key(base: &str) -> String {
    format!("{base}/history/index.json")
}
fn head_key(base: &str) -> String {
    format!("{base}/history/head.json")
}

/// 读取历史树；无历史（文件缺失）→ 空树，不报错。
pub async fn load_tree(store: &Store, base: &str) -> HistoryTree {
    let index = store.get_json(&index_key(base)).await.unwrap_or(Value::Null);
    let head = store
        .get_json(&head_key(base))
        .await
        .ok()
        .and_then(|h| h["head"].as_str().map(String::from));
    HistoryTree::from_parts(&index, head.as_deref())
}

/// index.json 整体重写（S3 无 append；已有节点逐字节不变，只新增尾部节点），
/// head.json 单独 put 即原子替换。
async fn persist_tree(store: &Store, base: &str, tree: &HistoryTree) -> Result<(), String> {
    let index = serde_json::to_value(&tree.nodes).map_err(|e| e.to_string())?;
    store.put_json(&index_key(base), &index).await?;
    store
        .put_json(&head_key(base), &json!({ "head": tree.head }))
        .await
}

/// 写路径统一入口（供 ops.rs 调用）：读树 → 无树先以 prev_latest 建 root → 追加新版本 → 落盘。
/// 失败不回滚已写入的版本，由调用方记录日志。
pub async fn record_version(
    store: &Store,
    base: &str,
    revision_id: &str,
    glb: &[u8],
    prev_latest: Option<&str>,
    summary: &str,
    actor: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let _guard = HISTORY_LOCK.lock().await;
    let mut tree = load_tree(store, base).await;
    // 只有树为空且存在更早版本时才需要取 prev 版本的哈希建 root
    let prev_snapshot_hash = match prev_latest {
        Some(p) if tree.nodes.is_empty() && !p.is_empty() && p != revision_id => {
            let bytes = store
                .get_bytes(&format!("{base}/versions/{p}/model.glb"))
                .await?;
            Some(sha256_hex(&bytes))
        }
        _ => None,
    };
    let commit = VersionCommit {
        prev_latest,
        prev_snapshot_hash: prev_snapshot_hash.as_deref(),
        revision_id,
        snapshot_hash: &sha256_hex(glb),
        summary,
        actor,
        task_id,
    };
    commit_version(&mut tree, &commit, crate::ops::now_epoch())?;
    persist_tree(store, base, &tree).await
}

/// 请求携带 expected_history_node_id 时的前置校验：与当前 HEAD 一致 → None；
/// 不一致 → 409 stale_head JSON 载荷（乐观锁，参考 psd2live StaleWorkspaceHeadException）。
pub async fn check_stale_head(
    store: &Store,
    base: &str,
    expected: &str,
) -> Option<(StatusCode, Json<Value>)> {
    let actual = load_tree(store, base).await.head;
    if actual.as_deref() == Some(expected) {
        return None;
    }
    Some((StatusCode::CONFLICT, Json(stale_head_payload(expected, actual.as_deref()))))
}

/// 409 载荷构造（纯函数，便于测试固定字段）
pub fn stale_head_payload(expected: &str, actual: Option<&str>) -> Value {
    json!({
        "error": "stale_head",
        "expected": expected,
        "actual": actual,
        "message": "工作区已被其他修改更新，请刷新后重试"
    })
}

// ---------- 任务检查点（纯函数） ----------

pub const TASK_STATUSES: [&str; 4] = ["running", "waiting_user", "done", "failed"];

/// 新建任务文档：status=running，含一条"任务创建"初始事件。
/// plan_steps 接受 String / &str 序列（handler 传 Vec<String>，测试传 vec![&str]）。
pub fn new_task_value<S: AsRef<str>>(
    task_id: &str,
    title: &str,
    plan_steps: impl IntoIterator<Item = S>,
    now: u64,
) -> Result<Value, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("title 不能为空".into());
    }
    let steps: Vec<String> = plan_steps
        .into_iter()
        .map(|s| s.as_ref().trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if steps.is_empty() {
        return Err("plan_steps 至少包含一个非空步骤".into());
    }
    Ok(json!({
        "task_id": task_id,
        "title": title,
        "plan_steps": steps,
        "events": [{ "message": "任务创建", "status": "running", "created_at": now }],
        "status": "running",
        "progress": 0,
        "created_at": now,
        "updated_at": now,
    }))
}

/// 追加任务事件：只允许 push 新事件与更新 status/progress/updated_at，
/// 旧事件（含其 message/status/created_at）逐字节保持不变（append-only）。
pub fn append_task_event_value(
    mut task: Value,
    message: &str,
    progress: Option<u64>,
    artifact: Option<&str>,
    status: Option<&str>,
    now: u64,
) -> Result<Value, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("message 不能为空".into());
    }
    if let Some(p) = progress {
        if p > 100 {
            return Err(format!("progress 需在 0..=100 之间，收到 {p}"));
        }
    }
    if let Some(s) = status {
        if !TASK_STATUSES.contains(&s) {
            return Err(format!("非法 status: {s}（允许 {}）", TASK_STATUSES.join("/")));
        }
    }
    let mut event = json!({ "message": message, "created_at": now });
    if let Some(p) = progress {
        event["progress"] = json!(p);
    }
    if let Some(a) = artifact.map(str::trim).filter(|a| !a.is_empty()) {
        event["artifact"] = json!(a);
    }
    if let Some(s) = status {
        event["status"] = json!(s);
    }
    if !task["events"].is_array() {
        task["events"] = json!([]);
    }
    task["events"]
        .as_array_mut()
        .expect("events 已确保为数组")
        .push(event);
    if let Some(s) = status {
        task["status"] = json!(s);
    }
    if let Some(p) = progress {
        task["progress"] = json!(p);
    }
    task["updated_at"] = json!(now);
    Ok(task)
}

// ---------- HTTP handlers ----------

fn check_dir(dir: &str) -> ApiResult<()> {
    if CATEGORIES.contains(&dir) {
        Ok(())
    } else {
        Err(e400(format!("非法类目: {dir}")))
    }
}

async fn ensure_asset(st: &Shared, base: &str) -> ApiResult<()> {
    st.store
        .get_json(&format!("{base}/asset.json"))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("资产不存在: {base}")))?;
    Ok(())
}

/// GET /api/assets/{dir}/{id}/history → {head, nodes}；无历史时 head=null、nodes=[]。
pub async fn get_history(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let base = format!("{dir}/{id}");
    ensure_asset(&st, &base).await?;
    let tree = load_tree(&st.store, &base).await;
    Ok(Json(json!({ "head": tree.head, "nodes": tree.nodes })))
}

#[derive(Deserialize)]
pub struct CheckoutReq {
    node_id: String,
}

/// POST /api/assets/{dir}/{id}/history/checkout {node_id}：
/// 只移动 HEAD（head.json 原子替换），不改任何节点；返回新 HEAD 节点。
pub async fn checkout(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
    Json(req): Json<CheckoutReq>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let base = format!("{dir}/{id}");
    ensure_asset(&st, &base).await?;
    let _guard = HISTORY_LOCK.lock().await;
    let mut tree = load_tree(&st.store, &base).await;
    let node = tree
        .checkout(&req.node_id)
        .map_err(|_| (StatusCode::NOT_FOUND, format!("历史节点不存在: {}", req.node_id)))?;
    persist_tree(&st.store, &base, &tree)
        .await
        .map_err(e500)?;
    Ok(Json(json!({ "head": node.id, "node": node })))
}

#[derive(Deserialize)]
pub struct CreateTaskReq {
    title: String,
    plan_steps: Vec<String>,
}

/// POST /api/assets/{dir}/{id}/tasks {title, plan_steps} → 创建 tasks/{task_id}.json
pub async fn create_task(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
    Json(req): Json<CreateTaskReq>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    check_dir(&dir)?;
    let base = format!("{dir}/{id}");
    ensure_asset(&st, &base).await?;
    let task_id = new_id("t_");
    let task = new_task_value(&task_id, &req.title, req.plan_steps, crate::ops::now_epoch())
        .map_err(e400)?;
    st.store
        .put_json(&format!("{base}/tasks/{task_id}.json"), &task)
        .await
        .map_err(e500)?;
    Ok((StatusCode::CREATED, Json(task)))
}

/// GET /api/assets/{dir}/{id}/tasks → {tasks: [...]}（按创建时间升序）
pub async fn list_tasks(
    State(st): State<Shared>,
    Path((dir, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let base = format!("{dir}/{id}");
    ensure_asset(&st, &base).await?;
    let files = st
        .store
        .list_files(&format!("{base}/tasks/"))
        .await
        .unwrap_or_default();
    let mut tasks = Vec::new();
    for f in files.iter().filter(|f| f.ends_with(".json")) {
        if let Ok(t) = st.store.get_json(&format!("{base}/tasks/{f}")).await {
            tasks.push(t);
        }
    }
    tasks.sort_by_key(|t| t["created_at"].as_u64().unwrap_or(0));
    Ok(Json(json!({ "tasks": tasks })))
}

/// GET /api/assets/{dir}/{id}/tasks/{task_id} → 任务文档
pub async fn get_task(
    State(st): State<Shared>,
    Path((dir, id, task_id)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let base = format!("{dir}/{id}");
    ensure_asset(&st, &base).await?;
    st.store
        .get_json(&format!("{base}/tasks/{task_id}.json"))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("任务不存在: {task_id}")))
        .map(Json)
}

#[derive(Deserialize)]
pub struct TaskEventReq {
    message: String,
    progress: Option<u64>,
    artifact: Option<String>,
    status: Option<String>,
}

/// POST /api/assets/{dir}/{id}/tasks/{task_id}/events：
/// 追加事件（append-only，不改旧事件），可同步更新 status/progress。
pub async fn append_task_event(
    State(st): State<Shared>,
    Path((dir, id, task_id)): Path<(String, String, String)>,
    Json(req): Json<TaskEventReq>,
) -> ApiResult<Json<Value>> {
    check_dir(&dir)?;
    let base = format!("{dir}/{id}");
    ensure_asset(&st, &base).await?;
    let _guard = HISTORY_LOCK.lock().await;
    let task = st
        .store
        .get_json(&format!("{base}/tasks/{task_id}.json"))
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, format!("任务不存在: {task_id}")))?;
    let updated = append_task_event_value(
        task,
        &req.message,
        req.progress,
        req.artifact.as_deref(),
        req.status.as_deref(),
        crate::ops::now_epoch(),
    )
    .map_err(e400)?;
    st.store
        .put_json(&format!("{base}/tasks/{task_id}.json"), &updated)
        .await
        .map_err(e500)?;
    Ok(Json(updated))
}

// ---------- 单元测试（MinIO 交互不可用，按现有测试风格测纯核心；见 ops::model_job_tests） ----------

#[cfg(test)]
mod history_tests {
    use super::*;

    fn commit<'a>(
        prev_latest: Option<&'a str>,
        prev_hash: Option<&'a str>,
        revision_id: &'a str,
        summary: &'a str,
    ) -> VersionCommit<'a> {
        VersionCommit {
            prev_latest,
            prev_snapshot_hash: prev_hash,
            revision_id,
            snapshot_hash: "deadbeef",
            summary,
            actor: "user",
            task_id: None,
        }
    }

    #[test]
    fn sha256_matches_nist_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // >64 字节跨块
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    /// 空树 + 资产此前无任何版本 → 新版本自身成为 root
    #[test]
    fn first_commit_without_prev_latest_becomes_root() {
        let mut tree = HistoryTree::default();
        let head = commit_version(
            &mut tree,
            &commit(None, None, "v001", "Blender 生成模型 → v001"),
            100,
        )
        .unwrap();
        assert_eq!(tree.nodes.len(), 1);
        let n = tree.node(&head).unwrap();
        assert!(n.parent_id.is_none());
        assert_eq!(n.revision_id, "v001");
        assert_eq!(n.actor, "user");
        assert_eq!(tree.head.as_deref(), Some(head.as_str()));
    }

    /// 空树 + 资产已有 latest（如 v003）→ 先以 v003 建 root（system），新版本 v004 追加为其子节点
    #[test]
    fn first_commit_with_prev_latest_initializes_root_then_appends() {
        let mut tree = HistoryTree::default();
        let head = commit_version(
            &mut tree,
            &commit(Some("v003"), Some("hash_v003"), "v004", "Blender 减面 → v004"),
            100,
        )
        .unwrap();
        assert_eq!(tree.nodes.len(), 2);
        let root = &tree.nodes[0];
        assert!(root.parent_id.is_none());
        assert_eq!(root.revision_id, "v003");
        assert_eq!(root.snapshot_hash, "hash_v003");
        assert_eq!(root.actor, "system");
        let n = tree.node(&head).unwrap();
        assert_eq!(n.parent_id.as_deref(), Some(root.id.as_str()));
        assert_eq!(n.revision_id, "v004");
        assert_eq!(n.summary, "Blender 减面 → v004");
        assert_eq!(n.actor, "user");
    }

    /// 已有树：追加默认挂到当前 HEAD 并推进 HEAD
    #[test]
    fn append_uses_head_as_parent_and_advances_head() {
        let mut tree = HistoryTree::default();
        let h1 = commit_version(&mut tree, &commit(None, None, "v001", "root 版本"), 100).unwrap();
        let h2 = commit_version(&mut tree, &commit(Some("v001"), None, "v002", "追加版本"), 200).unwrap();
        // 第二次提交时树已存在，prev_latest 不再建 root
        assert_eq!(tree.nodes.len(), 2);
        let n2 = tree.node(&h2).unwrap();
        assert_eq!(n2.parent_id.as_deref(), Some(h1.as_str()));
        assert_eq!(tree.head.as_deref(), Some(h2.as_str()));
        assert!(n2.created_at >= tree.node(&h1).unwrap().created_at);
    }

    /// checkout 后再追加 → 产生分支，兄弟节点全部保留
    #[test]
    fn checkout_then_append_creates_branch() {
        let mut tree = HistoryTree::default();
        let root = commit_version(&mut tree, &commit(None, None, "v001", "root 版本"), 100).unwrap();
        let n1 = commit_version(&mut tree, &commit(Some("v001"), None, "v002", "第一分支"), 200).unwrap();
        // 回到 root 再提交 → 分支
        let checked = tree.checkout(&root).unwrap();
        assert_eq!(checked.id, root);
        let n2 = commit_version(&mut tree, &commit(Some("v001"), None, "v003", "第二分支"), 300).unwrap();
        assert_eq!(tree.nodes.len(), 3);
        assert_eq!(tree.node(&n1).unwrap().parent_id.as_deref(), Some(root.as_str()));
        assert_eq!(tree.node(&n2).unwrap().parent_id.as_deref(), Some(root.as_str()));
        assert_eq!(tree.head.as_deref(), Some(n2.as_str()));
        // v002 节点原样保留（append-only）
        assert_eq!(tree.node(&n1).unwrap().revision_id, "v002");
    }

    /// checkout 只移动 HEAD：节点列表深比较完全不变
    #[test]
    fn checkout_only_moves_head() {
        let mut tree = HistoryTree::default();
        let root = commit_version(&mut tree, &commit(None, None, "v001", "root 版本"), 100).unwrap();
        let _n1 = commit_version(&mut tree, &commit(Some("v001"), None, "v002", "追加版本"), 200).unwrap();
        let before = tree.nodes.clone();
        tree.checkout(&root).unwrap();
        assert_eq!(tree.nodes, before);
        assert_eq!(tree.head.as_deref(), Some(root.as_str()));
        // 不存在的节点 → 报错
        assert!(tree.checkout("h_nope").is_err());
    }

    /// 树不变量：非空树禁止再追加 root；父节点必须存在；actor 白名单
    #[test]
    fn append_enforces_tree_invariants() {
        let mut tree = HistoryTree::default();
        commit_version(&mut tree, &commit(None, None, "v001", "root 版本"), 100).unwrap();
        assert!(tree.append(None, "v009", "h", "无父节点", "user", None, 1).is_err());
        assert!(tree.append(Some("h_missing"), "v009", "h", "孤儿节点", "user", None, 1).is_err());
        assert!(tree.append(None, "v009", "h", "root", "robot", None, 1).is_err());
        assert!(tree.append(None, "", "h", "空 revision", "user", None, 1).is_err());
        assert!(tree.append(None, "v009", "", "空 hash", "user", None, 1).is_err());
        assert!(tree.append(None, "v009", "h", "", "user", None, 1).is_err());
    }

    /// index/head 反序列化：snake_case 字段、坏 head 丢弃、空输入 → 空树
    #[test]
    fn from_parts_parses_index_and_head() {
        let index = json!([{
            "id": "h_1", "parent_id": null, "revision_id": "v001", "snapshot_hash": "aa",
            "summary": "初始", "actor": "system", "task_id": null, "created_at": 1
        }, {
            "id": "h_2", "parent_id": "h_1", "revision_id": "v002", "snapshot_hash": "bb",
            "summary": "追加", "actor": "user", "task_id": "t_1", "created_at": 2
        }]);
        let tree = HistoryTree::from_parts(&index, Some("h_2"));
        assert_eq!(tree.nodes.len(), 2);
        assert_eq!(tree.head.as_deref(), Some("h_2"));
        assert_eq!(tree.nodes[1].task_id.as_deref(), Some("t_1"));
        // head 指向不存在的节点 → 丢弃
        let bad = HistoryTree::from_parts(&index, Some("h_99"));
        assert!(bad.head.is_none());
        // 空输入 → 空树（GET /history 无历史不报错的根基）
        let empty = HistoryTree::from_parts(&Value::Null, None);
        assert!(empty.nodes.is_empty());
        assert!(empty.head.is_none());
    }

    /// stale head 409：载荷字段与文案固定；actual 为空（无历史树）同样判 stale
    #[test]
    fn stale_head_payload_has_fixed_shape() {
        let p = stale_head_payload("h_expected", Some("h_actual"));
        assert_eq!(p["error"], "stale_head");
        assert_eq!(p["expected"], "h_expected");
        assert_eq!(p["actual"], "h_actual");
        assert_eq!(p["message"], "工作区已被其他修改更新，请刷新后重试");
        let p2 = stale_head_payload("h_expected", None);
        assert_eq!(p2["actual"], Value::Null);
    }

    // ---------- 任务检查点 ----------

    fn sample_task() -> Value {
        new_task_value("t_1", "给角色加帽子", vec!["生成参考图", "建模", "审核"], 100).unwrap()
    }

    #[test]
    fn new_task_has_initial_event_and_running_status() {
        let t = sample_task();
        assert_eq!(t["task_id"], "t_1");
        assert_eq!(t["status"], "running");
        assert_eq!(t["progress"], 0);
        assert_eq!(
            t["plan_steps"],
            json!(["生成参考图", "建模", "审核"])
        );
        let events = t["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["message"], "任务创建");
        assert_eq!(t["created_at"], 100);
        assert_eq!(t["updated_at"], 100);
        // 空标题 / 空步骤 → 拒绝
        assert!(new_task_value("t_2", "  ", vec!["步骤"], 1).is_err());
        assert!(new_task_value::<&str>("t_2", "标题", Vec::new(), 1).is_err());
        assert!(new_task_value("t_2", "标题", vec!["  ", ""], 1).is_err());
    }

    /// 事件追加 append-only：旧事件逐字节不变，只允许新事件入列 + 状态字段更新
    #[test]
    fn task_event_append_never_touches_old_events() {
        let mut t = sample_task();
        let before: Vec<Value> = t["events"].as_array().unwrap().clone();

        t = append_task_event_value(t, "参考图已生成", Some(30), None, None, 200).unwrap();
        assert_eq!(t["events"].as_array().unwrap().len(), before.len() + 1);
        for (old, cur) in before.iter().zip(t["events"].as_array().unwrap()) {
            assert_eq!(old, cur);
        }
        assert_eq!(t["progress"], 30);
        assert_eq!(t["updated_at"], 200);
        assert_eq!(t["status"], "running"); // 未传 status 不变

        let first_snapshot = t["events"].as_array().unwrap().clone();
        t = append_task_event_value(t, "等待用户确认", Some(60), Some("versions/v004/model.glb"), Some("waiting_user"), 300)
            .unwrap();
        let events = t["events"].as_array().unwrap();
        assert_eq!(events.len(), 3);
        for (old, cur) in first_snapshot.iter().zip(events) {
            assert_eq!(old, cur); // 前两条事件原样
        }
        let last = events.last().unwrap();
        assert_eq!(last["message"], "等待用户确认");
        assert_eq!(last["status"], "waiting_user");
        assert_eq!(last["artifact"], "versions/v004/model.glb");
        assert_eq!(t["status"], "waiting_user");
        assert_eq!(t["progress"], 60);
    }

    /// 事件入参校验：空 message、progress 越界、非法 status → 拒绝且不产生半写状态
    #[test]
    fn task_event_validates_inputs() {
        let t = sample_task();
        assert!(append_task_event_value(t.clone(), "   ", None, None, None, 1).is_err());
        assert!(append_task_event_value(t.clone(), "msg", Some(101), None, None, 1).is_err());
        assert!(append_task_event_value(t.clone(), "msg", None, None, Some("paused"), 1).is_err());
        // 合法边界
        assert!(append_task_event_value(t, "msg", Some(0), None, Some("done"), 1).is_ok());
    }
}
