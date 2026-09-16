"""CPU preview of the actual GLB when headless WebGL cannot render a dense rig."""
import bpy,sys,math,pathlib,numpy as np
from mathutils import Vector
p=pathlib.Path(sys.argv[sys.argv.index('--')+1]);bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(p))
scene=bpy.context.scene
# Thumbnail uses the actual rigged mesh in rest pose; original GLB is untouched.
for o in scene.objects:
 if o.type=='ARMATURE':o.animation_data_clear();o.data.pose_position='REST'
scene.frame_set(1);bpy.context.view_layer.update();deps=bpy.context.evaluated_depsgraph_get()
meshes=[o.evaluated_get(deps) for o in scene.objects if o.type=='MESH']
points=[]
for o in meshes:
 mesh=o.to_mesh();arr=np.empty(len(mesh.vertices)*3,dtype=np.float32);mesh.vertices.foreach_get('co',arr);arr=arr.reshape(-1,3);matrix=np.array(o.matrix_world);world=arr@matrix[:3,:3].T+matrix[:3,3];points.extend([Vector(world.min(axis=0)),Vector(world.max(axis=0))]);o.to_mesh_clear()
lo=Vector([min(v[i]for v in points)for i in range(3)]);hi=Vector([max(v[i]for v in points)for i in range(3)]);center=(hi+lo)/2;span=max(hi-lo)
bpy.ops.object.camera_add(location=center+Vector((1,-.18,.1)).normalized()*span*1.8);camera=bpy.context.object;camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.lens=48;scene.camera=camera
for delta,power,size in [((2,-3,4),500,3),((-2,1,2),250,3)]:
 bpy.ops.object.light_add(type='AREA',location=center+Vector(delta)*span);lamp=bpy.context.object;lamp.data.energy=power*span*span;lamp.data.shape='DISK';lamp.data.size=size*span;lamp.rotation_euler=(center-lamp.location).to_track_quat('-Z','Y').to_euler()
scene.world=bpy.data.worlds.new('PreviewWorld');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.12,.13,.15,1);scene.world.node_tree.nodes['Background'].inputs[1].default_value=.7
scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=12;scene.cycles.use_denoising=True
scene.render.resolution_x=512;scene.render.resolution_y=512;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.render.filepath=str(p.with_name(p.stem+'-preview.png'));bpy.ops.render.render(write_still=True)
