"""Trusted GLB reimport inspection and contact-sheet rendering, independent of agent output."""
import bpy, json, sys, math
from mathutils import Vector
from pathlib import Path
src,prefix=sys.argv[sys.argv.index('--')+1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
scene=bpy.context.scene
rigs=[o for o in scene.objects if o.type=='ARMATURE']
shapes={pb.custom_shape for rig in rigs for pb in rig.pose.bones if pb.custom_shape}
for shape in shapes: shape.hide_render=True
meshes=[o for o in scene.objects if o.type=='MESH' and o not in shapes]
if not meshes: raise RuntimeError('GLB contains no meshes')
triangles=0
for o in meshes:o.data.calc_loop_triangles(); triangles+=len(o.data.loop_triangles)
bones=sum(len(o.data.bones) for o in rigs)
# glTF importer may import an action as an NLA track rather than active action.
actions=list(bpy.data.actions)
frames=sorted(set([1]+[int(a.frame_range[1]) for a in actions]));end=max(frames)
report={'blender':bpy.app.version_string,'triangles':triangles,'vertices':sum(len(o.data.vertices) for o in meshes),'bones':bones,'animations':[{'name':a.name,'frames':list(a.frame_range)} for a in actions], 'images':[{'name':i.name,'size':list(i.size)} for i in bpy.data.images if i.size[0]>0]}
points=[o.matrix_world@Vector(p) for o in meshes for p in o.bound_box]
lo=Vector(tuple(min(p[i] for p in points) for i in range(3))); hi=Vector(tuple(max(p[i] for p in points) for i in range(3))); center=(lo+hi)/2;span=max(hi-lo)
if not math.isfinite(span) or span<=0: raise RuntimeError('Invalid bounds')
report['bounds']=[list(lo),list(hi)]
scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=12
scene.render.resolution_x=384;scene.render.resolution_y=384;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=True;scene.view_settings.view_transform='Standard'
camdata=bpy.data.cameras.new('InspectionCamera');camdata.type='ORTHO';camdata.ortho_scale=span*1.4
cam=bpy.data.objects.new('InspectionCamera',camdata);scene.collection.objects.link(cam);cam.location=center+Vector((span*1.8,span*2.6,span*.7));cam.rotation_euler=(center-cam.location).to_track_quat('-Z','Y').to_euler();scene.camera=cam
world=bpy.data.worlds.new('InspectionWorld');world.use_nodes=True;world.node_tree.nodes['Background'].inputs[0].default_value=(.4,.4,.4,1);world.node_tree.nodes['Background'].inputs[1].default_value=.5;scene.world=world
for n,offset,power in [('Key',(-1,-2,3),300),('Fill',(2,2,2),200)]:
 light=bpy.data.lights.new(n,'AREA');light.energy=power*span**2;light.size=span*2;o=bpy.data.objects.new(n,light);scene.collection.objects.link(o);o.location=center+Vector(offset)*span;o.rotation_euler=(center-o.location).to_track_quat('-Z','Y').to_euler()
report['renders']=[]
poses=[]
for i,frame in enumerate([1,max(1,int(end*.33)),max(1,int(end*.66))]):
 scene.frame_set(frame);bpy.context.view_layer.update()
 poses.append([v for rig in rigs for pb in rig.pose.bones for row in pb.matrix for v in row])
 scene.render.filepath=str(Path(f'{prefix}-{i}.png').resolve());bpy.ops.render.render(write_still=True);report['renders'].append(f'{prefix}-{i}.png')
report['sample_pose_delta']=max([abs(a-b) for pose in poses[1:] for a,b in zip(poses[0],pose)] or [0])
Path(prefix+'-inspection.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print('INSPECTION '+json.dumps(report,ensure_ascii=False))
