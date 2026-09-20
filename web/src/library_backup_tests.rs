use super::*;
use base64::Engine;

fn triangle_glb(red: bool) -> Vec<u8> {
    let mut metadata=serde_json::to_vec(&json!({"asset":{"version":"2.0"},"scene":0,
        "scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]}],
        "materials":[{"doubleSided":true,"pbrMetallicRoughness":{"baseColorFactor":if red {[1.0,0.2,0.1,1.0]} else {[0.1,0.5,1.0,1.0]}}}],
        "buffers":[{"byteLength":36}],"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":36}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}]
    })).unwrap();
    while metadata.len()%4!=0 { metadata.push(b' '); }
    let mut bytes=b"glTF".to_vec(); bytes.extend(2u32.to_le_bytes());
    bytes.extend(((12+8+metadata.len()+8+36) as u32).to_le_bytes());
    bytes.extend((metadata.len() as u32).to_le_bytes()); bytes.extend(b"JSON"); bytes.extend(metadata);
    bytes.extend(36u32.to_le_bytes()); bytes.extend(b"BIN\0");
    for value in [0f32,0.,0.,1.,0.,0.,0.,1.,0.] { bytes.extend(value.to_le_bytes()); }
    bytes
}

fn transfer() -> Arc<Transfer> {
    let id = crate::history::new_id("backup_test_");
    let dir = std::env::temp_dir().join(&id);
    std::fs::create_dir(&dir).unwrap();
    Arc::new(Transfer { id, dir, state: Mutex::new(json!({})), manifest: Mutex::new(None), baseline: Mutex::new(vec![]) })
}

fn fixture() -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut add = |key: &str, v: Value| { files.insert(key.into(), serde_json::to_vec(&v).unwrap()); };
    add("props/rock/asset.json", json!({"asset_id":"rock","asset_type":"prop","name":"石头","version":"v002","status":"published","preview":{"path":"source/reference_front.png"}}));
    add("props/rock/source/spec.json", json!({"asset_id":"rock","name":"石头","description":"测试"}));
    add("props/rock/latest.json", json!({"latest":"v002","approved":"v001","published":"v001"}));
    add("props/rock/versions/v001/meta.json", json!({"version":"v001"}));
    add("props/rock/versions/v002/meta.json", json!({"version":"v002"}));
    add("props/rock/jobs/job_001.json", json!({"status":"done","cost":{"total_tokens":21}}));
    add("props/rock/tasks/t_1.json", json!({"events":[{"kind":"completed"}]}));
    add("props/rock/history/index.json", json!([
        {"id":"h1","parent_id":null,"revision_id":"v001","snapshot_hash":crate::history::sha256_hex(&triangle_glb(false)),"summary":"first","actor":"user","task_id":null,"created_at":1},
        {"id":"h2","parent_id":"h1","revision_id":"v002","snapshot_hash":crate::history::sha256_hex(&triangle_glb(true)),"summary":"second","actor":"user","task_id":null,"created_at":2}
    ]));
    add("props/rock/history/head.json", json!({"head":"h2"}));
    // Drafts have no model; a full backup must preserve them too.
    add("characters/draft/asset.json", json!({"asset_id":"draft","asset_type":"character","name":"草稿","version":null}));
    add("characters/draft/source/spec.json", json!({"description":"只生成过图片"}));
    add("characters/draft/latest.json", json!({"latest":null,"approved":null,"published":null}));
    add("_studio/workbench.json", json!({"favorites":["props/rock"],"archived":["characters/draft"],"project_folders":{"p1":"场景"},"asset_projects":{"props/rock":"p1"},"last_asset":"props/rock","settings":{"modelSource":"studio"}}));
    add("canvas/layout.json", json!({"props/rock":{"x":100,"y":200}}));
    add("style_profile.json", json!({"style_keywords":"卡通"}));
    add("ledger/totals.json", json!({"total_tokens":21,"calls":1}));
    files.insert("props/rock/versions/v001/model.glb".into(), triangle_glb(false));
    files.insert("props/rock/versions/v002/model.glb".into(), triangle_glb(true));
    let png=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGOsaJrIQApgIkk1w6gG4gATkergYFQDMYDkUAIA6s0Bq86NBj4AAAAASUVORK5CYII=").unwrap();
    files.insert("props/rock/source/reference_front.png".into(), png.clone());
    files.insert("props/rock/versions/v002/textures/color.png".into(), png);
    files
}

fn stage(s: &Transfer, files: &BTreeMap<String, Vec<u8>>) -> Manifest {
    let objects = files.iter().enumerate().map(|(i,(key, data))| {
        std::fs::write(s.object_path(i), data).unwrap();
        Entry { key:key.clone(), size:data.len() as u64, sha256:crate::history::sha256_hex(data) }
    }).collect();
    Manifest { format:FORMAT.into(), version:1, created_at:1, objects,
        browser_presets:Some(vec![Preset{id:"custom".into(),name:"角色".into(),prompt:"A姿势".into()}]) }
}

fn archive(s: &Transfer, manifest: &Manifest) {
    let mut zip = ZipWriter::new(File::create(s.dir.join("library.zip")).unwrap());
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file("manifest.json",options).unwrap();
    serde_json::to_writer(&mut zip,manifest).unwrap();
    for (i, e) in manifest.objects.iter().enumerate() {
        zip.start_file(format!("objects/{}",e.key),options).unwrap();
        zip.write_all(&std::fs::read(s.object_path(i)).unwrap()).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn archive_roundtrip_preserves_history_drafts_and_organization() {
    let s=transfer(); let files=fixture(); let manifest=stage(&s,&files); archive(&s,&manifest);
    let (_,summary)=unpack(&s).unwrap();
    assert_eq!(summary["asset_count"],2); assert_eq!(summary["versions"],2);
    for (i,e) in manifest.objects.iter().enumerate() { assert_eq!(std::fs::read(s.object_path(i)).unwrap(),files[&e.key]); }
}

#[test]
fn rejects_corruption_traversal_missing_history_and_running_jobs() {
    let s=transfer(); let files=fixture();
    let mut manifest=stage(&s,&files);
    manifest.objects[0].sha256="0".repeat(64); archive(&s,&manifest);
    assert!(unpack(&s).unwrap_err().contains("校验失败"));
    let mut manifest=stage(&s,&files); manifest.objects[0].key="props/../escape".into(); archive(&s,&manifest);
    assert!(unpack(&s).unwrap_err().contains("路径"));
    let mut missing=files.clone(); missing.remove("props/rock/versions/v001/model.glb");
    let manifest=stage(&s,&missing); assert!(validate_library(&s,&manifest).is_err());
    let mut running=files; running.insert("props/rock/jobs/job_001.json".into(),br#"{"status":"running"}"#.to_vec());
    let manifest=stage(&s,&running); assert!(validate_library(&s,&manifest).unwrap_err().contains("未完成"));
}

async fn test_store(bucket: &str) -> (Store, crate::config::AppConfig) {
    let endpoint=std::env::var("BACKUP_TEST_ENDPOINT").expect("Use an isolated disposable MinIO; never use a real library");
    let cfg=crate::config::AppConfig { minio_endpoint:endpoint,minio_access_key:"backup-test".into(),
        minio_secret_key:"backup-test-password".into(),minio_bucket:bucket.into(),
        openai_base_url:String::new(),openai_api_key:String::new(),openai_model:String::new() };
    let store=Store::new(&cfg).unwrap(); store.ensure_bucket().await; (store,cfg)
}

#[tokio::test]
#[ignore = "requires disposable MinIO; BACKUP_TEST_ENDPOINT, fixed test credentials"]
async fn isolated_store_restore_browse_conflicts_and_rollback() {
    let suffix=crate::history::new_id("t");
    let (source,_)=test_store(&format!("source-{suffix}")).await;
    let (target,cfg)=test_store(&format!("target-{suffix}")).await;
    let files=fixture();
    for (key,data) in &files { source.put_bytes(key,data).await.unwrap(); }
    // Deployment credentials and unrelated settings must never travel with asset archives.
    source.put_json("_private/credentials.json",&json!({"secret":"excluded"})).await.unwrap();
    let exported=transfer(); build_archive(&source,&exported,None).await.unwrap();
    if let Ok(dir)=std::env::var("BACKUP_TEST_ARTIFACT_DIR") {
        std::fs::copy(exported.dir.join("library.zip"),FsPath::new(&dir).join("fixture-library.zip")).unwrap();
    }
    let imported=transfer();
    std::fs::copy(exported.dir.join("library.zip"),imported.dir.join("library.zip")).unwrap();
    let (manifest,_)=unpack(&imported).unwrap();
    assert_eq!(manifest.objects.len(),files.len());
    *imported.manifest.lock().unwrap()=Some(manifest);
    *imported.baseline.lock().unwrap()=inventory(&target).await.unwrap();
    apply_restore(&target,&imported,RestoreRequest{conflicts:"replace".into(),restore_settings:true,restore_presets:false}).await.unwrap();
    for (key,data) in &files { assert_eq!(target.get_bytes(key).await.unwrap(),*data,"{key}"); }
    assert_eq!(inventory(&target).await.unwrap().len(),files.len());
    let state=Arc::new(AppState{store:target.clone(),cfg});
    let Json(list)=crate::assets::list_assets(State(state.clone())).await.unwrap();
    assert_eq!(list["assets"].as_array().unwrap().len(),2);
    let Json(detail)=crate::assets::get_asset(State(state.clone()),Path(("props".into(),"rock".into()))).await.unwrap();
    assert_eq!(detail["latest"]["published"],"v001");
    // An unrelated target asset survives either conflict policy.
    target.put_bytes("props/other/keep.bin",b"keep").await.unwrap();
    target.put_bytes("props/rock/target-only.bin",b"old").await.unwrap();
    *imported.baseline.lock().unwrap()=inventory(&target).await.unwrap();
    apply_restore(&target,&imported,RestoreRequest{conflicts:"skip".into(),restore_settings:false,restore_presets:false}).await.unwrap();
    assert_eq!(target.get_bytes("props/rock/target-only.bin").await.unwrap(),b"old");
    // A missing staged file forces an error after earlier writes: the journal restores original bytes.
    *imported.baseline.lock().unwrap()=inventory(&target).await.unwrap();
    let last=imported.manifest.lock().unwrap().as_ref().unwrap().objects.len()-1;
    std::fs::remove_file(imported.object_path(last)).unwrap();
    assert!(apply_restore(&target,&imported,RestoreRequest{conflicts:"replace".into(),restore_settings:true,restore_presets:false}).await.is_err());
    assert_eq!(target.get_bytes("props/rock/target-only.bin").await.unwrap(),b"old");
    for (key,data) in &files { assert_eq!(target.get_bytes(key).await.unwrap(),*data); }
    // A durable applying journal is also recoverable after process restart.
    target.copy_object("props/rock/target-only.bin","_backups/test/old-0").await.unwrap();
    target.put_json(JOURNAL,&json!({"id":"test","phase":"applying","entries":[{"key":"props/rock/target-only.bin","backup":"_backups/test/old-0"}]})).await.unwrap();
    target.put_bytes("props/rock/target-only.bin",b"interrupted").await.unwrap();
    recover(&target).await.unwrap();
    assert_eq!(target.get_bytes("props/rock/target-only.bin").await.unwrap(),b"old");
    assert_eq!(target.get_bytes("props/other/keep.bin").await.unwrap(),b"keep");
    // Restage and replace: obsolete files in selected assets must disappear.
    unpack(&imported).unwrap();
    *imported.baseline.lock().unwrap()=inventory(&target).await.unwrap();
    apply_restore(&target,&imported,RestoreRequest{conflicts:"replace".into(),restore_settings:true,restore_presets:false}).await.unwrap();
    assert!(!target.list_keys("props/rock/").await.unwrap().contains(&"props/rock/target-only.bin".into()));
    assert!(target.list_keys("_backups/").await.unwrap().is_empty());
    // Exercise the actual multipart extractor: retaining the first Field makes next_field fail.
    let app=axum::Router::new().route("/import",axum::routing::post(upload)
        .layer(axum::extract::DefaultBodyLimit::disable())).with_state(state);
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address=listener.local_addr().unwrap();
    let server=tokio::spawn(async move { axum::serve(listener,app).await.unwrap(); });
    let form=reqwest::multipart::Form::new().part("file",reqwest::multipart::Part::bytes(
        std::fs::read(exported.dir.join("library.zip")).unwrap()).file_name("library.zip"));
    let response=reqwest::Client::new().post(format!("http://{address}/import")).multipart(form).send().await.unwrap();
    assert!(response.status().is_success(),"{}",response.text().await.unwrap());
    let value:Value=response.json().await.unwrap();
    let task=session(value["id"].as_str().unwrap()).await.unwrap();
    for _ in 0..100 {
        if task.state.lock().unwrap()["status"] != "validating" { break; }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(task.state.lock().unwrap()["status"],"preview");
    let _ = discard(Path(task.id.clone())).await.unwrap();
    server.abort();
}
