"""Local rig fitted to anm_asset_008 v001; not a universal animal auto-rigger.
Preserves mesh and textures. Generates a baked, in-place four-beat walk.
Run with Blender --background --python SCRIPT -- SOURCE OUTPUT_DIRECTORY.
"""
import bpy,numpy as np,math,sys,json
from pathlib import Path
from mathutils import Vector,Matrix
args=sys.argv[sys.argv.index('--')+1:];source=Path(args[0]);out=Path(args[1]);out.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.import_scene.gltf(filepath=str(source))
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
c=2**-.5;rotation=Matrix(((c,-c,0,0),(c,c,0,0),(0,0,1,0),(0,0,0,1)))
for o in meshes:
 o.matrix_world=rotation@o.matrix_world
 bpy.context.view_layer.objects.active=o;o.select_set(True);bpy.ops.object.transform_apply(location=True,rotation=True,scale=True);o.select_set(False)
arm=bpy.data.armatures.new('FoxSkeleton');rig=bpy.data.objects.new('Fox_Local_Rig',arm);bpy.context.collection.objects.link(rig);bpy.context.view_layer.objects.active=rig;rig.select_set(True);rig.show_in_front=True;bpy.ops.object.mode_set(mode='EDIT')
segments=[]
def bone(name,a,b,parent=None,deform=True):
 e=arm.edit_bones.new(name);e.head=a;e.tail=b;e.use_deform=deform
 if parent:e.parent=arm.edit_bones[parent]
 if deform:segments.append((name,np.array(a),np.array(b)))
 return e
bone('root',(-.105,0,0),(-.105,0,.12),deform=False)
bone('pelvis',(-.105,-.22,.47),(-.105,-.08,.51),'root')
bone('spine',(-.105,-.08,.51),(-.105,.12,.52),'pelvis')
bone('chest',(-.105,.12,.52),(-.09,.29,.55),'spine')
bone('neck',(-.09,.29,.55),(-.04,.39,.67),'chest')
bone('head',(-.04,.39,.67),(.02,.49,.7),'neck')
bone('tail.01',(-.105,-.24,.48),(-.11,-.39,.32),'pelvis')
bone('tail.02',(-.11,-.39,.32),(-.11,-.49,.16),'tail.01')
bone('tail.03',(-.11,-.49,.16),(-.08,-.60,.04),'tail.02')
legs={}
for side,fx,hx,hy in [('L',-.183,-.210,-.126),('R',-.012,-.010,-.165)]:
 for kind,x,y in [('front',fx,.30),('hind',hx,hy)]:
  prefix=kind+'.'+side
  if kind=='front':points=[(x,.25,.48),(x,.26,.27),(x,.29,.065),(x,.35,.025)];parent='chest'
  else:points=[(x,-.20,.46),(x,-.08,.29),(x,-.20,.14),(x,y,.045),(x,y+.065,.025)];parent='pelvis'
  names=[]
  for i in range(len(points)-1):
   n=prefix+'.'+str(i);bone(n,points[i],points[i+1],parent);parent=n;names.append(n)
  legs[prefix]=(names,points)
bpy.ops.object.mode_set(mode='OBJECT')
# Smooth nearest-segment skinning, capped at four influences. No mesh decimation.
for o in meshes:
 a=np.empty(len(o.data.vertices)*3,dtype=np.float32);o.data.vertices.foreach_get('co',a);a=a.reshape(-1,3)
 distances=[]
 for name,h,t in segments:
  direction=t-h;v=a-h;along=np.clip(v@direction/(direction@direction),0,1)
  d=((v-along[:,None]*direction)**2).sum(1)
  # Stop long tail surface borrowing rear leg weights.
  if name.startswith(('front.','hind.')):d+=np.maximum(0,-.29-a[:,1])**2*8
  if name.startswith('tail'):d+=np.maximum(0,a[:,1]+.28)**2*8
  distances.append(d)
 distances=np.stack(distances,axis=1);indices=np.argpartition(distances,4,axis=1)[:,:4]
 weights=1/(np.take_along_axis(distances,indices,axis=1)+.0003)**2.5;weights/=weights.sum(1,keepdims=True)
 groups=[o.vertex_groups.new(name=n) for n,_,_ in segments]
 # Quantize only skin weights to 1/1000 to batch assignments; geometry/texture unchanged.
 weights=np.round(weights*1000).astype(int)
 for j,g in enumerate(groups):
  rows,cols=np.where(indices==j);values=weights[rows,cols]
  for w in np.unique(values):
   if w:g.add(rows[values==w].tolist(),float(w)/1000,'REPLACE')
 mod=o.modifiers.new('Local four-legged skin','ARMATURE');mod.object=rig;o.parent=rig
 print('WEIGHTS',len(a),flush=True)
# Foot targets keep stance on ground; swing is a smooth forward arc.
for prefix,(names,points) in legs.items():
 foot=Vector(points[-2]);target=bpy.data.objects.new('IK_'+prefix,None);bpy.context.collection.objects.link(target);target.location=foot
 ik=rig.pose.bones[names[-2]].constraints.new('IK');ik.target=target;ik.chain_count=len(names)-1;ik.use_stretch=False
 for n in names:rig.pose.bones[n].ik_stretch=0
 legs[prefix]=(names,points,target)
fps=30;end=49;bpy.context.scene.render.fps=fps;bpy.context.scene.frame_start=1;bpy.context.scene.frame_end=end
phases={'hind.L':0,'front.L':.25,'hind.R':.5,'front.R':.75}
samples=[];feet=[]
for frame in range(1,end+1):
 u=(frame-1)/(end-1)
 for prefix,(names,points,target) in legs.items():
  phase=(u+phases[prefix])%1;base=Vector(points[-2]);stride=.085
  if phase<.65:offset=stride*(.5-phase/.65);lift=0
  else:
   t=(phase-.65)/.35;s=t*t*(3-2*t);offset=stride*(-.5+s);lift=.045*math.sin(math.pi*t)**2
  target.location=base+Vector((0,offset,lift))
 rig.pose.bones['root'].location.z=.003*(1-math.cos(4*math.pi*u))
 for n in ['tail.01','tail.02','tail.03']:
  pb=rig.pose.bones[n];pb.rotation_mode='XYZ';pb.rotation_euler.y=.045*math.sin(2*math.pi*u)
 bpy.context.view_layer.update();samples.append({pb.name:pb.matrix.copy() for pb in rig.pose.bones})
 feet.append({p:list(rig.pose.bones[n[-1]].head) for p,(n,_,_) in legs.items()})
for pb in rig.pose.bones:
 for con in list(pb.constraints):pb.constraints.remove(con)
 pb.rotation_mode='QUATERNION'
for frame,matrices in enumerate(samples,1):
 bpy.context.scene.frame_set(frame)
 for pb in rig.pose.bones:
  pb.matrix=matrices[pb.name];bpy.context.view_layer.update()
  pb.keyframe_insert('location',frame=frame);pb.keyframe_insert('rotation_quaternion',frame=frame);pb.keyframe_insert('scale',frame=frame)
rig.animation_data.action.name='Walk';rig['rig_type']='quadruped';rig['aigccat_rig_method']='local_fitted_fox_008'
bpy.context.scene.frame_set(1)
bpy.ops.object.select_all(action='DESELECT');rig.select_set(True)
for o in meshes:o.select_set(True)
bpy.context.view_layer.objects.active=rig
bpy.ops.wm.save_as_mainfile(filepath=str(out/'fox-walk.blend'))
bpy.ops.export_scene.gltf(filepath=str(out/'fox-walk.glb'),export_format='GLB',use_selection=True,export_animations=True,export_frame_range=True,export_force_sampling=True,export_skins=True,export_yup=True,export_extras=True)
report={'source':str(source),'bones':len(arm.bones),'vertices':sum(len(o.data.vertices) for o in meshes),'duration':(end-1)/fps,'frames':end,'loop_pose_error':max(max(abs(x) for row in (samples[0][n]-samples[-1][n]) for x in row) for n in samples[0]),'foot_samples':feet}
(out/'rig-report.json').write_text(json.dumps(report,indent=2));print('DONE',report['bones'],report['loop_pose_error'],flush=True)
