## aigccat Godot Adapter（阶段 8）
## 用法：作为 EditorScript 在 Godot 编辑器 Script Editor 里打开并 Run（Cmd+Shift+X）
## 协议：只消费 Asset Contract + model.glb，绝不直连 OpenAI/Tripo（KICKOFF 5.6）
@tool
extends EditorScript

const WEB_BASE := "http://localhost:8080"
const IMPORT_ROOT := "res://aigccat/"
const PREVIEW_SCENE := "res://aigccat/preview.tscn"

const DIR_OF := {
	"character": "characters", "animal": "animals", "prop": "props",
	"building": "buildings", "environment": "environments", "vegetation": "vegetation",
	"ground": "grounds", "sky": "skies", "vehicle": "vehicles",
	"material": "materials", "effect": "effects", "apparel": "apparel",
}

func _run() -> void:
	DirAccess.make_dir_recursive_absolute(IMPORT_ROOT)
	var assets: Array = _http_get_json(WEB_BASE + "/api/assets").get("assets", [])
	var imported := 0
	for a in assets:
		var id: String = a["asset_id"]
		var dir: String = DIR_OF.get(a["asset_type"], "props")
		var detail := _http_get_json("%s/api/assets/%s/%s" % [WEB_BASE, dir, id])
		var published = detail.get("latest", {}).get("published")
		if published == null:
			continue
		var url := "%s/api/assets/%s/%s/file/versions/%s/model.glb" % [WEB_BASE, dir, id, published]
		var bytes := _http_get_bytes(url)
		if bytes.is_empty():
			push_warning("[aigccat] empty glb: " + id)
			continue
		var path := "%s%s_%s.glb" % [IMPORT_ROOT, id, published]
		var f := FileAccess.open(path, FileAccess.WRITE)
		f.store_buffer(bytes)
		f.close()
		imported += 1
		print("[aigccat] imported %s@%s -> %s" % [id, published, path])
	EditorInterface.get_resource_filesystem().scan()
	print("[aigccat] done, %d published assets imported" % imported)
	_spawn_preview()

## 把导入的 GLB 实例化到 preview.tscn 一行排开
func _spawn_preview() -> void:
	var root := Node3D.new()
	root.name = "AigccatPreview"
	var i := 0
	var da := DirAccess.open(IMPORT_ROOT)
	if da == null:
		return
	for fname in da.get_files():
		if not fname.ends_with(".glb"):
			continue
		var packed: PackedScene = load(IMPORT_ROOT + fname)
		if packed == null:
			continue
		var inst := packed.instantiate()
		inst.position = Vector3(i * 2.0, 0, 0)
		root.add_child(inst)
		inst.owner = root
		i += 1
	var scene := PackedScene.new()
	scene.pack(root)
	ResourceSaver.save(scene, PREVIEW_SCENE)
	print("[aigccat] preview scene saved: %s (%d nodes)" % [PREVIEW_SCENE, i])

func _http_get_json(url: String) -> Dictionary:
	var bytes := _http_get_bytes(url)
	var parsed = JSON.parse_string(bytes.get_string_from_utf8())
	return parsed if parsed is Dictionary else {}

func _http_get_bytes(url: String) -> PackedByteArray:
	var req := HTTPRequest.new()
	EditorInterface.get_base_control().add_child(req)
	var err := req.request(url)
	if err != OK:
		req.queue_free()
		return PackedByteArray()
	var res = await req.request_completed
	req.queue_free()
	# res = [result, response_code, headers, body]
	return res[3] if res[1] == 200 else PackedByteArray()
