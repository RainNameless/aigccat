//! GLB 模型大纲（scene graph / meshes / materials / textures / 拓扑统计）
//! 供前端「模型展示大纲」面板与引擎包编译使用。

use serde_json::{json, Value};

fn glb_json(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" {
        return Err("not a GLB".into());
    }
    let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if bytes.len() < 20 + json_len {
        return Err("truncated GLB".into());
    }
    serde_json::from_slice(&bytes[20..20 + json_len]).map_err(|e| format!("json chunk: {e}"))
}

fn arr(v: &Value, k: &str) -> Vec<Value> {
    match v.get(k).and_then(|x| x.as_array()) {
        Some(a) => a.clone(),
        None => vec![],
    }
}

/// 递归展开 node 树（name / mesh / scale / children）
fn node_tree(json: &Value, idx: usize, seen: &mut Vec<usize>) -> Value {
    if seen.contains(&idx) {
        return json!({ "name": "<cycle>", "index": idx });
    }
    seen.push(idx);
    let nodes = arr(json, "nodes");
    let n = match nodes.get(idx) {
        Some(n) => n,
        None => return json!({ "index": idx, "missing": true }),
    };
    let children: Vec<Value> = n
        .get("children")
        .and_then(|c| c.as_array())
        .map(|cs| cs.iter().filter_map(|c| c.as_u64()).map(|i| node_tree(json, i as usize, seen)).collect())
        .unwrap_or_default();
    json!({
        "index": idx,
        "name": n.get("name").and_then(|x| x.as_str()).unwrap_or("(unnamed)"),
        "mesh": n.get("mesh").and_then(|x| x.as_u64()),
        "scale": n.get("scale"),
        "has_rig": n.get("skin").is_some(),
        "children": children
    })
}

/// 生成完整模型大纲
pub fn outline(bytes: &[u8]) -> Result<Value, String> {
    let j = glb_json(bytes)?;
    let nodes = arr(&j, "nodes");
    let meshes = arr(&j, "meshes");
    let materials = arr(&j, "materials");
    let textures = arr(&j, "textures");
    let images = arr(&j, "images");
    let anims = arr(&j, "animations");
    let skins = arr(&j, "skins");
    let accessors = arr(&j, "accessors");

    // 拓扑统计
    let mut tris = 0u64;
    let mut verts = 0u64;
    let mut mesh_list = Vec::new();
    for (mi, m) in meshes.iter().enumerate() {
        let mut m_tris = 0u64;
        let mut m_verts = 0u64;
        let mut mat = None;
        for p in m.get("primitives").and_then(|x| x.as_array()).unwrap_or(&vec![]) {
            if let Some(ai) = p.get("indices").and_then(|x| x.as_u64()) {
                m_tris += accessors
                    .get(ai as usize)
                    .and_then(|a| a.get("count"))
                    .and_then(|c| c.as_u64())
                    .unwrap_or(0)
                    / 3;
            }
            if let Some(pi) = p.get("attributes").and_then(|a| a.get("POSITION")).and_then(|x| x.as_u64()) {
                m_verts += accessors
                    .get(pi as usize)
                    .and_then(|a| a.get("count"))
                    .and_then(|c| c.as_u64())
                    .unwrap_or(0);
            }
            mat = mat.or_else(|| p.get("material").and_then(|x| x.as_u64()));
        }
        tris += m_tris;
        verts += m_verts;
        mesh_list.push(json!({
            "index": mi,
            "name": m.get("name").and_then(|x| x.as_str()).unwrap_or("(unnamed)"),
            "triangles": m_tris, "vertices": m_verts, "material": mat
        }));
    }

    let mat_list: Vec<Value> = materials
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let pbr = m.get("pbrMetallicRoughness");
            json!({
                "index": i,
                "name": m.get("name").and_then(|x| x.as_str()).unwrap_or("(unnamed)"),
                "base_color": pbr.and_then(|p| p.get("baseColorFactor")),
                "metallic": pbr.and_then(|p| p.get("metallicFactor")).and_then(|x| x.as_f64()).unwrap_or(1.0),
                "roughness": pbr.and_then(|p| p.get("roughnessFactor")).and_then(|x| x.as_f64()).unwrap_or(1.0)
            })
        })
        .collect();

    let tex_list: Vec<Value> = textures
        .iter()
        .enumerate()
        .map(|(i, t)| json!({
            "index": i,
            "name": t.get("name").and_then(|x| x.as_str()).unwrap_or("(unnamed)"),
            "source": t.get("source")
        }))
        .collect();

    // scene 根节点
    let scene: Vec<Value> = j
        .get("scenes")
        .and_then(|s| s.as_array())
        .and_then(|ss| ss.first())
        .and_then(|s| s.get("nodes"))
        .and_then(|n| n.as_array())
        .map(|ns| ns.iter().filter_map(|n| n.as_u64()).map(|i| node_tree(&j, i as usize, &mut vec![])).collect())
        .unwrap_or_else(|| vec![node_tree(&j, 0, &mut vec![])]);

    Ok(json!({
        "stats": {
            "nodes": nodes.len(), "meshes": meshes.len(), "materials": materials.len(),
            "textures": textures.len(), "images": images.len(),
            "animations": anims.len(), "skins": skins.len(),
            "triangles": tris, "vertices": verts
        },
        "scene": scene,
        "meshes": mesh_list,
        "materials": mat_list,
        "textures": tex_list,
        "animations": anims.iter().map(|a| json!({"name": a.get("name")})).collect::<Vec<_>>(),
        "skins": skins.iter().map(|s| json!({
            "joints": s.get("joints").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0)
        })).collect::<Vec<_>>()
    }))
}

/// 引擎包编译：Asset Contract + GLB + 大纲 + manifest 打包成 zip
pub fn build_engine_bundle(
    glb: &[u8],
    asset_id: &str,
    version: &str,
    contract: &Value,
    meta: &Value,
    outl: &Value,
) -> Result<Vec<u8>, String> {
    use std::io::{Cursor, Write};
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts: zip::write::SimpleFileOptions = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(false);
        let mut add = |name: &str, data: &[u8]| -> Result<(), String> {
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            zip.write_all(data).map_err(|e| e.to_string())?;
            Ok(())
        };
        add("model.glb", glb)?;
        add("asset.json", &serde_json::to_vec_pretty(contract).map_err(|e| e.to_string())?)?;
        add("meta.json", &serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?)?;
        add("outline.json", &serde_json::to_vec_pretty(outl).map_err(|e| e.to_string())?)?;
        let manifest = json!({
            "schema": "aigccat.engine_bundle", "schema_version": "1.0",
            "asset_id": asset_id, "version": version,
            "compiled_at": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            "files": ["model.glb", "asset.json", "meta.json", "outline.json"],
            "engine_hint": {
                "unity": "import model.glb via glTFast; read asset.json for unit/up_axis",
                "godot": "import model.glb; read asset.json for unit/forward_axis"
            },
            "unit": "meter", "up_axis": "Y", "forward_axis": "-Z"
        });
        add("manifest.json", &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?)?;
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}
