"""Data-only GPT modeling recipes: lofts, tapered sweeps and small explicit meshes.

No generated Python is executed. Coordinates in the recipe are Y-up, front -Z.
The build preserves a master mesh, exports UV-backed fabric textures and produces
three review renders. Optimization is a separate operation on a saved version.
"""
import base64
import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector, Matrix, Euler

# glTF export converts Blender Z-up to Y-up: recipe (x,y,z) -> Blender (x,-z,y).
C = Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)))


def ring_mesh(spec):
    n = int(spec.get('segments', 20))
    if not 6 <= n <= 48:
        raise ValueError('segments out of bounds')
    rows = spec.get('profiles' if spec['shape'] == 'loft' else 'path', [])
    if not 2 <= len(rows) <= 32:
        raise ValueError('invalid profile count')
    verts, faces = [], []
    previous_side = None
    for i, row in enumerate(rows):
        if spec['shape'] == 'loft':
            y, x, z, rx, rz = row
            center, side, other = Vector((x,y,z)), Vector((1,0,0)), Vector((0,0,-1))
        else:
            x, y, z, radius = row
            center, rx, rz = Vector((x,y,z)), radius, radius
            prev = Vector(rows[max(0,i-1)][:3])
            after = Vector(rows[min(len(rows)-1,i+1)][:3])
            tangent = after-prev
            if tangent.length < 1e-6:
                raise ValueError('sweep has coincident path points')
            tangent.normalize()
            guide = previous_side or Vector((1,0,0))
            side = guide-tangent*guide.dot(tangent)
            if side.length < .01:
                guide = Vector((0,0,1))
                side = guide-tangent*guide.dot(tangent)
            side.normalize()
            other = tangent.cross(side).normalized()
            previous_side = side
        if rx <= 0 or rz <= 0:
            raise ValueError('profile radius must be positive')
        for j in range(n):
            a = 2*math.pi*j/n
            verts.append(tuple(center+side*(rx*math.cos(a))+other*(rz*math.sin(a))))
    for i in range(len(rows)-1):
        for j in range(n):
            faces.append((i*n+j, i*n+(j+1)%n, (i+1)*n+(j+1)%n, (i+1)*n+j))
    if spec.get('cap', True):
        faces.extend([tuple(reversed(range(n))), tuple((len(rows)-1)*n+j for j in range(n))])
    return verts, faces


def geometry(spec):
    kind = spec['shape']
    if kind in ('loft','sweep','mesh'):
        verts, faces = ring_mesh(spec) if kind != 'mesh' else (spec['vertices'],spec['faces'])
        mesh = bpy.data.meshes.new(spec['name'])
        mesh.from_pydata(verts, [], faces)
        mesh.update()
    else:
        bm = bmesh.new()
        if kind == 'sphere':
            bmesh.ops.create_uvsphere(bm,u_segments=24,v_segments=16,radius=.5)
        elif kind == 'cube':
            bmesh.ops.create_cube(bm,size=1)
        elif kind in ('cone','cylinder'):
            bmesh.ops.create_cone(bm,cap_ends=True,cap_tris=False,segments=24,radius1=.5,radius2=0 if kind=='cone' else .5,depth=1)
        elif kind == 'torus':
            rings=[]
            for i in range(24):
                a=2*math.pi*i/24;ring=[]
                for j in range(10):
                    b=2*math.pi*j/10;r=.5+.16*math.cos(b)
                    ring.append(bm.verts.new((r*math.cos(a),r*math.sin(a),.16*math.sin(b))))
                rings.append(ring)
            for i in range(24):
                for j in range(10):bm.faces.new((rings[i][j],rings[(i+1)%24][j],rings[(i+1)%24][(j+1)%10],rings[i][(j+1)%10]))
        else:
            raise ValueError('unsupported shape')
        if kind in ('cone','cylinder','torus'):
            for v in bm.verts:v.co=(v.co.x,v.co.z,-v.co.y)
        mesh=bpy.data.meshes.new(spec['name']);bm.to_mesh(mesh);bm.free()
    bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(mesh);bm.free()
    obj=bpy.data.objects.new(spec['name'],mesh);bpy.context.collection.objects.link(obj)
    scale=spec.get('scale',[1,1,1])
    for v in mesh.vertices:v.co=(v.co.x*scale[0],v.co.y*scale[1],v.co.z*scale[2])
    obj.matrix_world=C@Matrix.Translation(spec.get('position',[0,0,0]))@Euler(spec.get('rotation',[0,0,0]),'XYZ').to_matrix().to_4x4()
    obj['aigccat_coordinate_system']='right_handed_y_up_neg_z'
    obj['construction']=kind
    for polygon in mesh.polygons:polygon.use_smooth=spec.get('smooth',kind!='cube')
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
    bevel=spec.get('bevel',0)
    if bevel:
        mod=obj.modifiers.new('Edge finish','BEVEL');mod.width=bevel;mod.segments=2
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(island_margin=.025)
    bpy.ops.object.mode_set(mode='OBJECT')
    return obj


def linear(color):
    return [v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in color]


def material(spec, directory):
    color=spec.get('color',[.8,.8,.8]);m=spec.get('material',{})
    mat=bpy.data.materials.new(spec['name']);mat.use_nodes=True;mat.diffuse_color=(*color,1)
    bsdf=mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value=(*linear(color),1)
    bsdf.inputs['Roughness'].default_value=m.get('roughness',.65)
    bsdf.inputs['Metallic'].default_value=m.get('metallic',0)
    pattern=m.get('pattern','solid')
    if pattern!='solid':
        size=256;frequency=m.get('pattern_scale',12);contrast=m.get('pattern_color',[.7,.7,.7]);pixels=[]
        for y in range(size):
            for x in range(size):
                u,v=(x/size*frequency)%1,(y/size*frequency)%1
                if pattern=='plaid':mix=.65 if u<.12 or v<.12 else (.18 if u<.5 else 0)
                elif pattern=='stripes':mix=.65 if u<.18 else 0
                else:mix=.12*(.5+.5*math.sin((x+y)*1.8))
                rgb=[color[k]*(1-mix)+contrast[k]*mix for k in range(3)]
                pixels.extend((*rgb,1))
        img=bpy.data.images.new('Fabric_'+str(len(bpy.data.images)),width=size,height=size)
        img.pixels.foreach_set(pixels)
        img.filepath_raw=os.path.join(directory,img.name+'.png');img.file_format='PNG';img.save();img.pack()
        tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=img
        mat.node_tree.links.new(tex.outputs['Color'],bsdf.inputs['Base Color'])
    return mat


def review_renders(objects, directory):
    points=[o.matrix_world@Vector(c) for o in objects for c in o.bound_box]
    lower=Vector(tuple(min(p[i] for p in points) for i in range(3)))
    upper=Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center=(lower+upper)/2;span=max(upper-lower)
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=12
    scene.render.resolution_x=512;scene.render.resolution_y=512;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
    scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.65,.65,.65,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.65
    scene.view_settings.view_transform='Standard'
    for loc,power,size in [((2,-3,4),180,3),((-2,-1,2),100,3),((0,3,3),130,2)]:
        bpy.ops.object.light_add(type='AREA',location=center+Vector(loc)*span)
        light=bpy.context.object;light.data.energy=power*span*span;light.data.shape='DISK';light.data.size=size*span
        light.rotation_euler=(center-light.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.object.camera_add();camera=bpy.context.object;scene.camera=camera;camera.data.type='ORTHO';camera.data.ortho_scale=span*1.25
    images={}
    for name,direction in [('front',(0,-1,0)),('side',(1,0,0)),('back',(0,1,0))]:
        camera.location=center+Vector(direction)*span*3
        camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
        scene.render.filepath=os.path.join(directory,'review_'+name+'.png')
        bpy.ops.render.render(write_still=True)
        with open(scene.render.filepath,'rb') as handle:images[name]=base64.b64encode(handle.read()).decode()
    return images


def build(plan_path,out_path):
    with open(plan_path) as f:plan=json.load(f)
    if plan.get('coordinate_system')!='right_handed_y_up_neg_z':raise ValueError('invalid coordinate system')
    if not 1<=len(plan.get('parts',[]))<=96:raise ValueError('invalid part count')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.world=bpy.data.worlds.new('Studio')
    objects=[]
    for spec in plan['parts']:
        obj=geometry(spec);obj.data.materials.append(material(spec,os.path.dirname(out_path)));objects.append(obj)
    bpy.context.view_layer.update()
    for obj in objects:obj.data.calc_loop_triangles()
    triangles=sum(len(o.data.loop_triangles) for o in objects)
    boundaries=0
    for obj in objects:
        bm=bmesh.new();bm.from_mesh(obj.data);boundaries+=sum(e.is_boundary for e in bm.edges);bm.free()
    if not triangles:raise ValueError('empty model')
    bpy.ops.export_scene.gltf(filepath=out_path,export_format='GLB',export_apply=True,export_extras=True)
    stats={'engine':'gpt_blender','method':plan.get('method','surface'),'parts':len(objects),'triangles':triangles,
           'uv_meshes':sum(bool(o.data.uv_layers) for o in objects),'boundary_edges':boundaries,
           'textures':sum(any(n.type=='TEX_IMAGE' for n in m.node_tree.nodes) for m in bpy.data.materials if m.use_nodes),
           'quality_status':'needs_visual_review','notes':'形体草案；未验证贴近参考图的程度，角色动画拓扑仍需检查。'}
    stats['review_images']=review_renders(objects,os.path.dirname(out_path))
    print('WORKER_STATS '+json.dumps(stats))


if __name__=='__main__':build(*sys.argv[sys.argv.index('--')+1:])
