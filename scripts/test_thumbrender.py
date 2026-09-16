"""运行合成回归；--live 只读测试057/099并保存PNG。"""
import io
import json
import hashlib
import struct
import sys
import unittest
import urllib.request
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
import thumbrender as renderer

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers


class ColorTests(unittest.TestCase):
    def mesh(self):
        return trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces=[[0, 1, 2]], process=False)

    def test_vertex_and_black(self):
        g = self.mesh()
        for color in ([255, 0, 0, 255], [0, 0, 0, 255]):
            g.visual = trimesh.visual.ColorVisuals(g, vertex_colors=[color] * 3)
            np.testing.assert_allclose(renderer._face_colors(g), [np.array(color[:3]) / 255])

    def test_face(self):
        g = self.mesh()
        g.visual = trimesh.visual.ColorVisuals(g, face_colors=[[0, 255, 0, 255]])
        np.testing.assert_allclose(renderer._face_colors(g), [[0, 1, 0]])

    def test_material_and_vertex(self):
        g = self.mesh()
        g.visual = trimesh.visual.texture.TextureVisuals(material=trimesh.visual.material.PBRMaterial())
        g.visual.vertex_attributes['color'] = np.array([[0.2, 0.4, 0.8, 1]] * 3)
        np.testing.assert_allclose(renderer._face_colors(g), [[0.2, 0.4, 0.8]])
        # trimesh 导出器对自定义颜色直接转 uint8，先显式量化合成测试数据。
        g.visual.vertex_attributes['color'] = np.round(g.visual.vertex_attributes['color'] * 255).astype('u1')
        blob = g.export(file_type='glb')
        loaded = next(iter(trimesh.load(io.BytesIO(blob), file_type='glb', force='scene').geometry.values()))
        np.testing.assert_allclose(renderer._face_colors(loaded), [[0.2, 0.4, 0.8]], atol=1/255)
        self.assertIsNotNone(renderer.render_png(blob, 100))

    def test_texture_and_vertex(self):
        g = self.mesh()
        image = Image.new('RGB', (2, 2), (200, 100, 50))
        g.visual = trimesh.visual.texture.TextureVisuals(uv=[[0, 0]] * 3, material=trimesh.visual.material.PBRMaterial(baseColorTexture=image, baseColorFactor=[0.5, 1., 1., 1.]))
        expected = np.array([[200, 100, 50]]) / 255 * [128/255, 1, 1]
        np.testing.assert_allclose(renderer._face_colors(g), expected)
        g.visual.vertex_attributes['color'] = np.array([[1., 0.5, 0.25, 1.]] * 3)
        np.testing.assert_allclose(renderer._face_colors(g), expected * [1, 0.5, 0.25])
        # trimesh 导出器对自定义颜色直接转 uint8，先显式量化合成测试数据。
        g.visual.vertex_attributes['color'] = np.round(g.visual.vertex_attributes['color'] * 255).astype('u1')
        blob = g.export(file_type='glb')
        loaded = next(iter(trimesh.load(io.BytesIO(blob), file_type='glb', force='scene').geometry.values()))
        self.assertIsNotNone(loaded.visual.material.baseColorTexture)
        np.testing.assert_allclose(renderer._face_colors(loaded), expected * [1, 128/255, 64/255])

    def test_material_only(self):
        g = self.mesh()
        g.visual = trimesh.visual.texture.TextureVisuals(material=trimesh.visual.material.PBRMaterial(baseColorFactor=[0.6, 0.6, 0.6, 1.]))
        np.testing.assert_allclose(renderer._face_colors(g), [[0.6, 0.6, 0.6]])


def live():
    out = Path(__file__).resolve().parents[1] / 'outputs'
    out.mkdir(exist_ok=True)
    report = {}
    for sid in ('057', '099'):
        url = f'http://localhost:8080/api/assets/characters/chr_npc_student_{sid}/file/'
        blob = _auth_urlopen(url + 'versions/v001/model.glb').read()
        n = struct.unpack_from('<I', blob, 12)[0]
        header = json.loads(blob[20:20+n])
        binary = blob[28+n:]
        scene = trimesh.load(io.BytesIO(blob), file_type='glb', force='scene', process=False)
        stats = []
        for p, g in zip([p for m in header['meshes'] for p in m['primitives']], scene.geometry.values()):
            a = header['accessors'][p['attributes']['COLOR_0']]
            view = header['bufferViews'][a['bufferView']]
            dtype = {5126: '<f4', 5121: 'u1', 5123: '<u2'}[a['componentType']]
            width = {'VEC3': 3, 'VEC4': 4}[a['type']]
            raw = np.ndarray((a['count'], width), dtype=dtype, buffer=binary, offset=view.get('byteOffset', 0)+a.get('byteOffset', 0), strides=(view.get('byteStride', width*np.dtype(dtype).itemsize), np.dtype(dtype).itemsize))
            loaded = g.visual.vertex_attributes['color']
            np.testing.assert_array_equal(raw, loaded)
            before = raw.copy()
            fc = renderer._face_colors(g)
            factor = g.visual.material.baseColorFactor
            expected = np.clip(raw[:, :3], 0, 1) * (1 if factor is None else np.asarray(factor)[:3]/255)
            np.testing.assert_allclose(fc, expected[g.faces].mean(axis=1), atol=1e-7)
            np.testing.assert_array_equal(before, raw)
            stats.append({'accessor': a, 'raw_unique': len(np.unique(raw, axis=0)), 'uint8_unique': len(np.unique(np.round(np.clip(raw, 0, 1)*255).astype('u1'), axis=0)), 'rgb_min': raw[:, :3].min(0).tolist(), 'rgb_max': raw[:, :3].max(0).tolist(), 'face_colors_match_source': True})
        png = renderer.render_png(blob, 720)
        assert png and Image.open(io.BytesIO(png)).size == (720, 720)
        (out / f'student_{sid}_color.png').write_bytes(png)
        asset = _auth_urlopen(url + 'asset.json').read()
        preview = _auth_urlopen(url + 'versions/v001/preview.png').read()
        report[sid] = {'model_sha256': hashlib.sha256(blob).hexdigest(), 'preview_sha256': hashlib.sha256(preview).hexdigest(), 'asset': json.loads(asset), 'colors': stats}
    (out / 'thumbrender_validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    if '--live' in sys.argv:
        live()
    else:
        unittest.main()
