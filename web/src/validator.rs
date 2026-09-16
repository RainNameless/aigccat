//! GLB V1 校验器（纯 Rust，零依赖解析 glTF 头 + JSON chunk）
//! 完整校验链（trimesh/pygltflib/骨骼命名）在 worker/validators/validate_glb.py，阶段 6 接入 Windmill。
//!
//! 检查项：
//! 1. magic/version/length 头合法
//! 2. JSON chunk 可解析，且 meshes 非空
//! 3. POSITION accessor 的 min/max 存在 → 世界坐标包围盒（沿 scene graph 累乘 TRS）
//! 4. 量化身高检查：spec.attributes.height_m 存在时，模型高度容差 ±20%

use serde_json::Value;

/// 行主序仿射矩阵（4x4，最后一行固定 [0,0,0,1]）
type Mat = [[f64; 4]; 4];

fn identity() -> Mat {
    [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]
}

fn mul(a: &Mat, b: &Mat) -> Mat {
    let mut out = [[0.0f64; 4]; 4];
    for r in 0..4 {
        for c in 0..4 {
            out[r][c] = (0..4).map(|k| a[r][k] * b[k][c]).sum();
        }
    }
    out
}

fn vec3(v: Option<&Value>, default: [f64; 3]) -> [f64; 3] {
    let Some(arr) = v.and_then(|x| x.as_array()) else { return default };
    let mut out = default;
    for (i, item) in arr.iter().take(3).enumerate() {
        if let Some(n) = item.as_f64() { out[i] = n; }
    }
    out
}

/// 节点局部矩阵：优先 matrix（glTF 为列主序），否则由 T·R·S 组成。
fn node_matrix(node: &Value) -> Mat {
    if let Some(arr) = node.get("matrix").and_then(|m| m.as_array()).filter(|a| a.len() == 16) {
        let c: Vec<f64> = arr.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
        // 列主序 → 行主序
        let mut m = [[0.0f64; 4]; 4];
        for r in 0..4 { for c2 in 0..4 { m[r][c2] = c[c2 * 4 + r]; } }
        return m;
    }
    let t = vec3(node.get("translation"), [0.0, 0.0, 0.0]);
    let s = vec3(node.get("scale"), [1.0, 1.0, 1.0]);
    let q = vec3(node.get("rotation"), [0.0, 0.0, 0.0]);
    let w = node.get("rotation").and_then(|r| r.get(3)).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let (x, y, z) = (q[0], q[1], q[2]);
    let rot = [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w), 0.0],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w), 0.0],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y), 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let mut local = mul(&rot, &[[s[0], 0.0, 0.0, 0.0], [0.0, s[1], 0.0, 0.0], [0.0, 0.0, s[2], 0.0], [0.0, 0.0, 0.0, 1.0]]);
    for r in 0..3 { local[r][3] = t[r]; }
    local
}

fn triplet(arr: &[Value]) -> Option<[f64; 3]> {
    if arr.len() != 3 { return None; }
    Some([arr[0].as_f64()?, arr[1].as_f64()?, arr[2].as_f64()?])
}

fn apply(m: &Mat, p: [f64; 3]) -> [f64; 3] {
    (0..3)
        .map(|r| m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3])
        .collect::<Vec<f64>>()
        .try_into()
        .unwrap_or([0.0, 0.0, 0.0])
}

/// 世界坐标包围盒：从场景根沿 TRS 累乘，把每个网格顶点的局部 8 角点变换后取并集。
/// 直接用 accessor 的 min/max 只能得到"物体自身"尺寸——多部件模型（Blender 依计划生成）
/// 会因此把身高算成一个部件的大小。
fn world_bbox(json: &Value) -> Option<([f64; 3], [f64; 3])> {
    let nodes = json.get("nodes").and_then(|n| n.as_array())?;
    let meshes = json.get("meshes").and_then(|m| m.as_array());
    let accessors = json.get("accessors").and_then(|a| a.as_array());
    let roots: Vec<usize> = json
        .get("scenes")
        .and_then(|s| s.as_array())
        .and_then(|ss| ss.first())
        .and_then(|s| s.get("nodes"))
        .and_then(|n| n.as_array())
        .map(|ns| ns.iter().filter_map(|n| n.as_u64()).map(|i| i as usize).collect())
        .filter(|v: &Vec<usize>| !v.is_empty())
        .unwrap_or_else(|| vec![0]);
    let mut mn = [f64::INFINITY; 3];
    let mut mx = [f64::NEG_INFINITY; 3];
    let mut found = false;
    fn walk(
        nodes: &[Value], meshes: Option<&Vec<Value>>, accessors: Option<&Vec<Value>>,
        idx: usize, parent: &Mat, mn: &mut [f64; 3], mx: &mut [f64; 3], found: &mut bool,
        seen: &mut Vec<usize>,
    ) {
        if seen.contains(&idx) { return; }
        seen.push(idx);
        let Some(node) = nodes.get(idx) else { return; };
        let world = mul(parent, &node_matrix(node));
        if let (Some(mi), Some(meshes), Some(accessors)) = (node.get("mesh").and_then(|m| m.as_u64()), meshes, accessors) {
            if let Some(mesh) = meshes.get(mi as usize) {
                for prim in mesh.get("primitives").and_then(|p| p.as_array()).unwrap_or(&vec![]) {
                    let ai = prim.get("attributes").and_then(|a| a.get("POSITION")).and_then(|x| x.as_u64());
                    let Some(ai) = ai else { continue };
                    let Some(acc) = accessors.get(ai as usize) else { continue };
                    let (Some(lo), Some(hi)) = (acc.get("min").and_then(|v| v.as_array()), acc.get("max").and_then(|v| v.as_array())) else { continue };
                    if lo.len() != 3 || hi.len() != 3 { continue; }
                    let (Some(lo), Some(hi)) = (triplet(lo), triplet(hi)) else { continue };
                    for cx in [lo[0], hi[0]] { for cy in [lo[1], hi[1]] { for cz in [lo[2], hi[2]] {
                        let p = apply(&world, [cx, cy, cz]);
                        for i in 0..3 { mn[i] = mn[i].min(p[i]); mx[i] = mx[i].max(p[i]); }
                        *found = true;
                    }}}
                }
            }
        }
        for child in node.get("children").and_then(|c| c.as_array()).unwrap_or(&vec![]) {
            if let Some(ci) = child.as_u64() {
                walk(nodes, meshes, accessors, ci as usize, &world, mn, mx, found, seen);
            }
        }
    }
    for root in roots {
        walk(nodes, meshes, accessors, root, &identity(), &mut mn, &mut mx, &mut found, &mut vec![]);
    }
    if found { Some((mn, mx)) } else { None }
}

pub struct Validation {
    pub ok: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub mesh_count: usize,
    pub height_m: Option<f64>,
    pub bbox: Option<[f64; 3]>,
    pub triangles: Option<u64>,
    pub vertices: Option<u64>,
}

pub fn validate_glb(bytes: &[u8], expected_height_m: Option<f64>) -> Validation {
    let mut v = Validation {
        ok: false,
        errors: vec![],
        warnings: vec![],
        mesh_count: 0,
        height_m: None,
        bbox: None,
        triangles: None,
        vertices: None,
    };
    if bytes.len() < 20 {
        v.errors.push("file too small for GLB header".into());
        return v;
    }
    if &bytes[0..4] != b"glTF" {
        v.errors.push("bad magic: not a GLB".into());
        return v;
    }
    let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    if version != 2 {
        v.errors.push(format!("unsupported glTF version {version}"));
        return v;
    }
    let declared = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if declared != bytes.len() {
        v.errors
            .push(format!("length mismatch: header {declared} vs actual {}", bytes.len()));
    }
    let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if &bytes[16..20] != b"JSON" || bytes.len() < 20 + json_len {
        v.errors.push("missing JSON chunk".into());
        return v;
    }
    let json: Value = match serde_json::from_slice(&bytes[20..20 + json_len]) {
        Ok(j) => j,
        Err(e) => {
            v.errors.push(format!("JSON chunk parse failed: {e}"));
            return v;
        }
    };
    let meshes = json["meshes"].as_array();
    v.mesh_count = meshes.map(|m| m.len()).unwrap_or(0);
    if v.mesh_count == 0 {
        v.errors.push("no meshes".into());
    }
    // 拓扑信息：三角面与顶点数
    if let (Some(meshes), Some(accs)) = (meshes, json["accessors"].as_array()) {
        let mut tris = 0u64;
        let mut verts = 0u64;
        for m in meshes {
            if let Some(prims) = m["primitives"].as_array() {
                for p in prims {
                    if let Some(ai) = p["indices"].as_u64() {
                        if let Some(acc)=accs.get(ai as usize) { tris += acc["count"].as_u64().unwrap_or(0)/3; }
                        else { v.errors.push("invalid indices accessor".into()); }
                    }
                    if let Some(pi) = p["attributes"]["POSITION"].as_u64() {
                        if let Some(acc)=accs.get(pi as usize) { verts += acc["count"].as_u64().unwrap_or(0); }
                        else { v.errors.push("invalid POSITION accessor".into()); }
                    }
                }
            }
        }
        v.triangles = Some(tris);
        v.vertices = Some(verts);
    }
    // 包围盒：沿场景图变换到世界坐标（Blender 导出为 Z-up→Y-up 转换，高度可能落在 Z）
    if let Some((mn, mx)) = world_bbox(&json) {
        {
            let size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
            v.bbox = Some(size);
            // glTF uses Y-up. Depth must not become height when rotating around the vertical axis.
            let h = size[1];
            v.height_m = Some(h);
            if let Some(exp) = expected_height_m {
                let dev = (h - exp).abs() / exp;
                if dev > 0.20 {
                    v.errors
                        .push(format!("height {h:.2}m deviates {:.0}% from expected {exp}m (>20%)", dev * 100.0));
                }
            } else if h < 0.01 || h > 500.0 {
                v.warnings.push(format!("suspicious height {h:.2}m (unit mismatch?)"));
            }
        }
    } else {
        v.warnings.push("no POSITION min/max, bbox unknown".into());
    }
    v.ok = v.errors.is_empty();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两个部件：一个位于世界原点，一个被父节点平移到 y=1.5 且缩放 2 倍。
    fn scene_json() -> Value {
        serde_json::json!({
            "scenes": [{ "nodes": [0, 1] }],
            "nodes": [
                { "mesh": 0 },
                { "mesh": 1, "translation": [0.0, 1.5, 0.0], "scale": [2.0, 2.0, 2.0] }
            ],
            "meshes": [
                { "primitives": [{ "attributes": { "POSITION": 0 } }] },
                { "primitives": [{ "attributes": { "POSITION": 1 } }] }
            ],
            "accessors": [
                { "type": "VEC3", "min": [-0.1, -0.1, -0.1], "max": [0.1, 0.1, 0.1], "count": 8 },
                { "type": "VEC3", "min": [0.0, 0.0, 0.0], "max": [0.1, 0.25, 0.1], "count": 8 }
            ]
        })
    }

    #[test]
    fn world_bbox_applies_translation_and_scale() {
        let (mn, mx) = world_bbox(&scene_json()).unwrap();
        // 部件1：原点 ±0.1；部件2：y 1.5..2.0（0.25*2），x/z 0..0.2
        assert!((mn[1] + 0.1).abs() < 1e-9, "min y = {}", mn[1]);
        assert!((mx[1] - 2.0).abs() < 1e-9, "max y = {}", mx[1]);
        assert!((mx[0] - 0.2).abs() < 1e-9, "max x = {}", mx[0]);
    }

    #[test]
    fn matrix_nodes_are_supported() {
        // 列主序平移矩阵（沿 x 平移 5）
        let j = serde_json::json!({
            "scenes": [{ "nodes": [0] }],
            "nodes": [{ "mesh": 0, "matrix": [1,0,0,0, 0,1,0,0, 0,0,1,0, 5,0,0,1] }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 } }] }],
            "accessors": [{ "type": "VEC3", "min": [0.0,0.0,0.0], "max": [1.0,1.0,1.0], "count": 8 }]
        });
        let (mn, mx) = world_bbox(&j).unwrap();
        assert!((mn[0] - 5.0).abs() < 1e-9 && (mx[0] - 6.0).abs() < 1e-9, "{mn:?} {mx:?}");
    }

    #[test]
    fn cycles_and_missing_data_do_not_hang() {
        let j = serde_json::json!({
            "scenes": [{ "nodes": [0] }],
            "nodes": [{ "mesh": 0, "children": [0] }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 } }] }],
            "accessors": [{ "type": "VEC3", "min": [0.0,0.0,0.0], "max": [1.0,1.0,1.0], "count": 8 }]
        });
        let (mn, mx) = world_bbox(&j).unwrap();
        assert!((mx[0] - 1.0).abs() < 1e-9);
        // 没有 min/max → 无法判定包围盒，只返回 None（不报错、不伪造）
        let j2 = serde_json::json!({
            "scenes": [{ "nodes": [0] }],
            "nodes": [{ "mesh": 0 }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 } }] }],
            "accessors": [{ "type": "VEC3", "count": 8 }]
        });
        assert!(world_bbox(&j2).is_none());
        assert!(world_bbox(&serde_json::json!({})).is_none());
    }
}
