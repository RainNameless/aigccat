import bpy,sys,pathlib,json,math,subprocess
args=sys.argv[sys.argv.index('--')+1:];root=pathlib.Path(args[0]);stage=args[1]
if (root/(stage+'.source')).read_bytes()[:4]==b'glTF':
 subprocess.run(['node',str(pathlib.Path(__file__).with_name('prepare-source.cjs')),str(root),stage],check=True)
 sys.exit(0)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=str(root/(stage+'.source')),use_anim=False)
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
(root/(stage+'-meshes.json')).write_text(json.dumps([o.name for o in meshes]))
for o in meshes:o.rotation_euler.z-=math.pi/2
bpy.ops.export_scene.gltf(filepath=str(root/(stage+'.glb')),export_format='GLB',export_animations=False)
