"""Exercise Blender workbench operations on temporary fixtures, without AI calls."""
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BLENDER = os.environ.get('BLENDER_BIN', '/Applications/Blender.app/Contents/MacOS/Blender')
PROCESSOR = ROOT / 'scripts/blender/workbench_process.py'


def gltf(path):
    data = path.read_bytes()
    assert data[:4] == b'glTF'
    size = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20+size])


class WorkbenchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='aigccat-workbench-')
        cls.folder = Path(cls.temp.name)
        cls.source = cls.folder / 'fixture.glb'
        code = '''import bpy, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12)
obj=bpy.context.object
obj.name='TestMesh'
mat=bpy.data.materials.new('Test material')
mat.use_nodes=True
img=bpy.data.images.new('Test texture',16,16)
img.generated_color=(.8,.2,.3,1)
img.pack()
node=mat.node_tree.nodes.new('ShaderNodeTexImage')
node.image=img
mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
obj.data.materials.append(mat)
bpy.ops.export_scene.gltf(filepath=sys.argv[-1],export_format='GLB')
'''
        fixture = cls.folder / 'fixture.py'
        fixture.write_text(code)
        subprocess.run([BLENDER,'-b','--factory-startup','--python',str(fixture),'--',str(cls.source)],check=True,capture_output=True,timeout=90)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def execute(self,operation,options=None,source=None):
        output=self.folder/(operation+'.glb')
        params=self.folder/(operation+'.json')
        params.write_text(json.dumps({'src':str(source or self.source),'out':str(output),'operation':operation,'ratio':.5,'voxel_size':.15,'options':options or {}}))
        result=subprocess.run([BLENDER,'-b','--factory-startup','--disable-autoexec','--python',str(PROCESSOR),'--',str(params)],capture_output=True,text=True,timeout=180,env={**os.environ,'AIGCCAT_BLENDER_SCRIPTS':str(PROCESSOR.parent)})
        self.assertEqual(result.returncode,0,result.stdout[-1500:]+result.stderr[-1500:])
        self.assertTrue(output.exists(),result.stdout[-2000:])
        return gltf(output)

    def test_reduce_remesh_and_uv(self):
        original=gltf(self.source)
        old=original['accessors'][original['meshes'][0]['primitives'][0]['indices']]['count']
        reduced=self.execute('decimate')
        new=reduced['accessors'][reduced['meshes'][0]['primitives'][0]['indices']]['count']
        self.assertLess(new,old)
        self.assertTrue(self.execute('remesh')['meshes'])
        self.assertTrue(self.execute('quad',{'faces':500})['meshes'])
        self.assertIn('TEXCOORD_0',self.execute('uv')['meshes'][0]['primitives'][0]['attributes'])

    def test_split_material_and_upscale(self):
        self.assertTrue(self.execute('split')['meshes'])
        result=self.execute('material',{'color':'#ff0000','roughness':.2,'metalness':.8})
        pbr=result['materials'][0]['pbrMetallicRoughness']
        self.assertAlmostEqual(pbr['metallicFactor'],.8,places=5)
        self.assertEqual(pbr['baseColorFactor'][:3],[1,0,0])
        self.assertTrue(self.execute('upscale',{'resolution':1024})['images'])

    def test_animation_and_transform(self):
        self.assertTrue(self.execute('animation',{'preset':'turntable','duration':2})['animations'])
        result=self.execute('transform',{'scale':2,'rotation':90})
        self.assertTrue(any(n.get('scale')==[2,2,2] for n in result['nodes']))

    def test_template_rig(self):
        source=ROOT/'outputs/character-engine-smoke.glb'
        if not source.exists(): self.skipTest('Template fixture unavailable')
        result=self.execute('rig',source=source)
        self.assertTrue(result['skins'])
        self.assertTrue(result['animations'])


if __name__=='__main__':
    unittest.main(verbosity=2)
