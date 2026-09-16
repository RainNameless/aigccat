// aigccat Unity Adapter（阶段 8）
// 放到 Unity 项目的 Assets/Editor/ 下，菜单：aigccat → Import Published Assets
// 协议：只消费 Asset Contract(asset.json) + model.glb，绝不直连 OpenAI/Tripo（KICKOFF 5.6）
// 依赖：Unity 2021.3+，GLB 导入需 com.unity.cloud.gltfast（Package Manager 安装）
using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

public static class AigccatImporter
{
    // ---- 配置（按环境改）----
    const string WebBase = "http://localhost:8080";   // aigccat web 服务
    const string ImportRoot = "Assets/aigccat";        // GLB 落地目录
    const string PreviewScene = "Assets/aigccat/Preview.unity";

    static readonly HttpClient http = new HttpClient();

    [MenuItem("aigccat/Import Published Assets")]
    public static async void ImportAll()
    {
        try
        {
            Directory.CreateDirectory(ImportRoot);
            var assets = await GetJson($"{WebBase}/api/assets");
            int imported = 0;
            foreach (var a in assets["assets"].EnumerateArray())
            {
                string id = a.GetProperty("asset_id").GetString();
                string type = a.GetProperty("asset_type").GetString();
                string dir = PluralDir(type);
                // 只导 published 资产
                var detail = await GetJson($"{WebBase}/api/assets/{dir}/{id}");
                string published = detail["latest"].GetProperty("published").GetString();
                if (string.IsNullOrEmpty(published)) continue;

                string glbUrl = $"{WebBase}/api/assets/{dir}/{id}/file/versions/{published}/model.glb";
                string dst = $"{ImportRoot}/{id}_{published}.glb";
                var bytes = await http.GetByteArrayAsync(glbUrl);
                await File.WriteAllBytesAsync(dst, bytes);
                AssetDatabase.ImportAsset(dst);
                imported++;
                Debug.Log($"[aigccat] imported {id}@{published} -> {dst}");
            }
            AssetDatabase.Refresh();
            EditorUtility.DisplayDialog("aigccat", $"导入完成：{imported} 个 published 资产", "OK");
        }
        catch (Exception e)
        {
            Debug.LogError($"[aigccat] import failed: {e}");
            EditorUtility.DisplayDialog("aigccat", $"导入失败：{e.Message}", "OK");
        }
    }

    [MenuItem("aigccat/Spawn Into Preview Scene")]
    public static void SpawnAll()
    {
        // 把 ImportRoot 下所有 GLB 实例化排进当前场景（一行排开，方便目检）
        var guids = AssetDatabase.FindAssets("t:GameObject", new[] { ImportRoot });
        int i = 0;
        foreach (var g in guids)
        {
            var path = AssetDatabase.GUIDToAssetPath(g);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null) continue;
            var inst = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            inst.transform.position = new Vector3(i * 2.0f, 0, 0);
            i++;
        }
        Debug.Log($"[aigccat] spawned {i} assets into active scene");
    }

    static string PluralDir(string t) => t switch
    {
        "character" => "characters", "animal" => "animals", "prop" => "props",
        "building" => "buildings", "environment" => "environments", "vegetation" => "vegetation",
        "ground" => "grounds", "sky" => "skies", "vehicle" => "vehicles",
        "material" => "materials", "effect" => "effects", "apparel" => "apparel",
        _ => "props",
    };

    static async Task<System.Text.Json.JsonElement> GetJson(string url)
    {
        var s = await http.GetStringAsync(url);
        using var doc = System.Text.Json.JsonDocument.Parse(s);
        return doc.RootElement.Clone();
    }
}
