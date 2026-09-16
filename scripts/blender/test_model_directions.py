"""Reproducible ten-direction character geometry experiments, ten candidates each.

Authored procedural experiments, NOT image-to-3D reconstruction or 100 API calls.
Every result has independent GLB, recipe, three renders and measured mesh stats.
Blender Z-up/front -Y is converted by the glTF exporter to Y-up/front +Z;
the collection is rotated 180 degrees before export to match app front -Z.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

DIRECTIONS = {
    1: ('截面放样', 'longitudinal_sections'),
    2: ('细分曲面', 'catmull_clark'),
    3: ('体素融合', 'voxel_union_skin'),
    4: ('轮廓拟合', 'landmark_proportions'),
    5: ('服装结构', 'open_cardigan_pleated_skirt'),
    6: ('发片结构', 'layered_hair_ribbons'),
    7: ('面部雕形', 'analytic_face_displacement'),
    8: ('参考投影', 'front_image_uv_projection'),
    9: ('低模保形', 'decimation_with_detail_preservation'),
    10: ('混合构建', 'subdivision_garment_hair_face'),
}


def material(name, rgb, rough=.65):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*rgb, 1)
    shader.inputs['Roughness'].default_value = rough
    return mat


def mesh(name, vertices, faces, mat, smooth=True):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    for p in data.polygons:
        p.use_smooth = smooth
    return obj


def loft(name, rows, mat, segments=32, pleat=0, opening=0, sculpt=0):
    # rows [z,x,y,rx,ry], front -Y; opening omits a wedge at the front.
    verts, faces = [], []
    start = -math.pi/2 + opening
    span = 2*math.pi - 2*opening
    width = segments+1 if opening else segments
    for z,x,y,rx,ry in rows:
        for j in range(width):
            a = start + span*j/segments
            r = 1 + pleat*math.cos(12*a)
            vx, vy = x + rx*math.cos(a)*r, y + ry*math.sin(a)*r
            if sculpt and math.sin(a)<0:
                # Nose bridge, cheek volumes and eye sockets on a continuous head.
                g=lambda xx,zz,sx,sz: math.exp(-((vx-xx)/sx)**2-((z-zz)/sz)**2)
                face = (.022*g(0,1.48,.018,.030) + .012*g(0,1.455,.014,.012)
                        + .009*(g(.038,1.468,.024,.022)+g(-.038,1.468,.024,.022))
                        - .008*(g(.032,1.505,.021,.016)+g(-.032,1.505,.021,.016)))
                vy -= face*sculpt*(-math.sin(a))**5
            verts.append((vx,vy,z))
    for i in range(len(rows)-1):
        for j in range(segments if not opening else width-1):
            k=(j+1)%width
            faces.append((i*width+j,i*width+k,(i+1)*width+k,(i+1)*width+j))
    if not opening:
        faces += [tuple(reversed(range(width))),tuple((len(rows)-1)*width+j for j in range(width))]
    obj=mesh(name,verts,faces,mat)
    return obj


def tube(name, points, radii, mat, segments=16):
    verts,faces=[],[]
    previous=Vector((1,0,0))
    for i,point in enumerate(points):
        center=Vector(point)
        tangent=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(i-1,0)])
        tangent.normalize()
        u=previous-tangent*previous.dot(tangent)
        if u.length<.01: u=tangent.cross(Vector((0,1,0)))
        u.normalize(); v=tangent.cross(u).normalized(); previous=u
        for j in range(segments):
            a=2*math.pi*j/segments
            verts.append(tuple(center+radii[i]*(u*math.cos(a)+v*math.sin(a))))
    for i in range(len(points)-1):
        for j in range(segments):
            k=(j+1)%segments
            faces.append((i*segments+j,i*segments+k,(i+1)*segments+k,(i+1)*segments+j))
    faces += [tuple(reversed(range(segments))),tuple((len(points)-1)*segments+j for j in range(segments))]
    return mesh(name,verts,faces,mat)


def ellipsoid(name, center, scale, mat, n=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=n,ring_count=16,location=center)
    obj=bpy.context.object; obj.name=name; obj.scale=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    obj.data.materials.append(mat)
    for p in obj.data.polygons:p.use_smooth=True
    return obj


def apply(obj, mod):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True); bpy.context.view_layer.objects.active=obj
    bpy.ops.object.modifier_apply(modifier=mod.name)


def subdivide(obj, level=1):
    mod=obj.modifiers.new('Surface continuity','SUBSURF');mod.levels=level
    apply(obj,mod)


def ribbon(name, points, widths, mat):
    verts,faces=[],[]
    for i,(p,w) in enumerate(zip(points,widths)):
        for j in range(5):
            offset=(j/4-.5)*w
            verts.append((p[0]+offset,p[1]-.006*math.cos(offset/w*math.pi*2),p[2]))
    for i in range(len(points)-1):
        for j in range(4):faces.append((i*5+j,i*5+j+1,(i+1)*5+j+1,(i+1)*5+j))
    obj=mesh(name,verts,faces,mat)
    mod=obj.modifiers.new('Hair thickness','SOLIDIFY');mod.thickness=.0025;apply(obj,mod)
    subdivide(obj,1)
    return obj


def build(direction, iteration, directory, reference):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    t=(iteration-1)/9
    advanced=direction==10
    skin=material('skin',(.58,.36,.26),.53)
    hair=material('hair',(.047,.029,.022),.42)
    hairlight=material('hair strands',(.080,.048,.032),.45)
    navy=material('cardigan',(.022,.032,.053),.9)
    white=material('blouse',(.82,.81,.77),.85)
    shoe=material('sneaker',(.73,.75,.75),.6)
    dark=material('pupil',(.010,.008,.007),.3)
    lips=material('lips',(.40,.15,.13),.57)
    plaid=material('skirt plaid',(.10,.105,.12),.9)
    gold=material('buttons',(.15,.115,.067),.45)
    segments=24+2*iteration if direction==1 else 32
    headscale=(.94+.12*t) if direction==4 else 1
    legspread=(.055+.06*t) if direction==4 else .09
    pleat=(.012+.075*t) if direction==5 or advanced else .025
    facepower=(.3+1.3*t) if direction==7 or advanced else .45
    recipe={'direction':direction,'label':DIRECTIONS[direction][0],'method':DIRECTIONS[direction][1],
            'iteration':iteration,'parameter':t,'reference':str(reference),'segments':segments,
            'head_scale':headscale,'leg_spread':legspread,'pleat_depth':pleat,'face_displacement':facepower,
            'source':'Codex-authored procedural geometry experiment; no supplier API',
            'limitations':['Single front reference; inferred rear geometry','Unrigged','Not a neural reconstruction']}
    directory.mkdir(parents=True,exist_ok=True)
    (directory/'recipe.json').write_text(json.dumps(recipe,ensure_ascii=False,indent=2))
    body=[]
    body.append(loft('neck',[(1.28,0,0,.035,.034),(1.34,0,0,.037,.036),(1.40,0,-.002,.035,.034)],skin))
    torso=[(.81,0,0,.105,.062),(.87,0,0,.115,.067),(.97,0,0,.091,.057),(1.08,0,0,.105,.066),
           (1.18,0,0,.132,.075),(1.25,0,0,.147,.070),(1.30,0,0,.10,.048),(1.32,0,0,.045,.035)]
    body.append(loft('blouse',torso,white,segments))
    # Head with jaw, chin, cheek, temples and cranium cross sections.
    headrows=[(1.37,0,-.004,.018,.025),(1.385,0,-.006,.033,.036),(1.405,0,-.004,.045,.044),
              (1.435,0,0,.056,.054),(1.465,0,.004,.065,.059),(1.49,0,.004,.068,.062),
              (1.52,0,.007,.067,.062),(1.55,0,.009,.064,.061),(1.58,0,.012,.052,.052),
              (1.60,0,.015,.030,.034),(1.61,0,.016,.006,.009)]
    headrows=[(1.49+(z-1.49)*headscale,x,y,rx*headscale,ry*headscale) for z,x,y,rx,ry in headrows]
    head=loft('face continuous',headrows,skin,48,sculpt=facepower); body.append(head)
    for side in [-1,1]:
        x=side*legspread
        # Bent legs with knee and calf landmarks, continuous surface.
        hip_factor = .85 if direction == 1 else .55
        points=[(x*hip_factor,0,.88),(x*.75,-.008,.77),(x*.88,-.005,.66),(x*.76,-.020,.53),
                (x*.84,-.015,.46),(x*1.08,.014,.36),(x*1.18,.012,.23),(x*1.18,0,.135)]
        body.append(tube('leg '+str(side),points,[.063,.064,.056,.038,.035,.046,.034,.023],skin,segments))
        loft('sock '+str(side),[(.085,x*1.18,0,.03,.036),(.13,x*1.18,0,.029,.028),(.21,x*1.16,.004,.032,.029)],white)
        ellipsoid('sole '+str(side),(x*1.18,-.029,.038),(.043,.081,.021),shoe)
        ellipsoid('shoe '+str(side),(x*1.18,-.02,.067),(.04,.073,.042),white)
        for k in range(4):
            tube('lace',[(x*1.18-.021,-.043+k*.012,.103),(x*1.18+.021,-.037+k*.012,.103)], [.002,.002],shoe,8)
        sleeve=[(side*.123,0,1.25),(side*.164,-.006,1.22),(side*.18,-.008,1.10),
                (side*.185,-.030,1.02),(side*.16,-.088,1.07),(side*.13,-.109,1.16)]
        tube('sleeve '+str(side),sleeve,[.052,.060,.057,.052,.045,.032],navy,segments)
        palm=ellipsoid('palm '+str(side),(side*.123,-.115,1.18),(.022,.018,.038),skin)
        body.append(palm)
        for k in range(4):
            xx=side*(.108+k*.009)
            tube('finger',[(xx,-.119,1.19),(xx,-.133,1.175),(xx,-.129,1.16)], [.005,.005,.004],skin,10)
        ellipsoid('ear',(side*.065,.002,1.46),(.012,.013,.023),skin)
        # restrained eyes and upper eyelids, face front -Y.
        ellipsoid('eye',(side*.029,-.058,1.498),(.017,.006,.008),white)
        ellipsoid('iris',(side*.029,-.064,1.498),(.0065,.0025,.0065),hair)
        ellipsoid('pupil',(side*.029,-.066,1.498),(.0035,.0015,.004),dark)
        tube('eyelid',[(side*.012,-.062,1.499),(side*.029,-.064,1.506),(side*.046,-.056,1.50)],[.0018]*3,hair,8)
        tube('brow',[(side*.014,-.055,1.52),(side*.032,-.057,1.522),(side*.048,-.047,1.519)],[.0025,.003,.0018],hair,8)
        # Backpack straps, positioned outside blouse.
        tube('strap',[(side*.102,.08,1.25),(side*.114,.018,1.30),(side*.106,-.072,1.26),(side*.107,-.093,1.16),(side*.11,-.08,1.03)], [.012]*5,dark,12)
    tube('mouth',[(-.021,-.054,1.435),(-.011,-.061,1.432),(0,-.063,1.431),(.011,-.061,1.432),(.021,-.054,1.435)],[.0015,.0025,.003,.0025,.0015],lips,10)
    # Open-front garment shell: front blouse remains visible.
    cardigan=loft('open cardigan',[(.79,0,.004,.136,.082),(.86,0,.006,.128,.08),(.99,0,.009,.114,.075),
                        (1.12,0,.01,.129,.09),(1.24,0,.01,.152,.086),(1.29,0,.008,.11,.055)],navy,segments,opening=.42)
    solid=cardigan.modifiers.new('Garment thickness','SOLIDIFY');solid.thickness=.007;apply(cardigan,solid)
    skirt=loft('pleated skirt',[(.67,0,.01,.181,.111),(.70,0,.01,.176,.107),(.77,0,.006,.154,.095),
                         (.86,0,.004,.128,.077),(.94,0,0,.105,.064)],plaid,48,pleat=pleat)
    # Actual UV grid textile generated locally, embedded in GLB.
    size=128;image=bpy.data.images.new('plaid raster',width=size,height=size)
    pixels=[]
    for y in range(size):
        for x in range(size):
            v=.38 if x%32<2 or y%32<2 else (.19 if x%16<2 or y%16<2 else .11)
            pixels.extend((v,v*.98,v*.94,1))
    image.pixels.foreach_set(pixels);image.filepath_raw=str(directory/'plaid.png');image.file_format='PNG';image.save();image.pack()
    uv=skirt.data.uv_layers.new(name='fabric')
    for p in skirt.data.polygons:
        for li in p.loop_indices:
            co=skirt.data.vertices[skirt.data.loops[li].vertex_index].co
            uv.data[li].uv=((math.atan2(co.y,co.x)+math.pi)/(2*math.pi)*3,co.z*4)
    tex=plaid.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image
    plaid.node_tree.links.new(tex.outputs['Color'],plaid.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
    for side in [-1,1]:
        collar=mesh('collar',[(side*.014,-.038,1.31),(side*.052,-.06,1.29),(side*.066,-.072,1.22),(side*.020,-.076,1.255)],[(0,1,2,3)],white)
        mod=collar.modifiers.new('Collar thickness','SOLIDIFY');mod.thickness=.004;apply(collar,mod)
        for z in [.87,.97,1.07,1.17]:ellipsoid('button',(side*.060,-.078,z),(.007,.004,.007),gold,16)
    ellipsoid('backpack',(0,.113,1.064),(.119,.062,.185),dark)
    ellipsoid('backpack pocket',(0,.164,1.01),(.093,.020,.09),navy)
    # Hair crown is cropped so no full ellipsoid covers the face.
    crown=loft('hair crown',[(1.52,0,.018,.070,.063),(1.56,0,.021,.071,.067),
                 (1.60,0,.024,.052,.052),(1.62,0,.025,.015,.021)],hair,48,opening=.78)
    locks=7+iteration if direction==6 else 10
    for side in [-1,1]:
        for k in range(locks):
            depth=k/max(1,locks-1)
            xx=side*(.057+.031*depth)
            yy=-.010+.09*depth
            points=[(side*.025,yy*.5,1.604),(side*.055,yy-.004,1.565),(xx,yy,1.50),
                    (xx+side*.005,yy-.006,1.41),(xx+side*.018,yy-.012,1.32),
                    (xx+side*.006,yy-.023,1.24),(xx+side*.018,yy-.02,1.16+.045*depth)]
            if direction==6 or advanced:
                ribbon('hair ribbon',points,[.028,.035,.03,.029,.026,.021,.003],hairlight if k%3==0 else hair)
            else: tube('hair lock',points,[.016,.02,.019,.017,.018,.012,.002],hair,12)
        # Parted fringe swept to the sides, never a curtain over eyes.
        ribbon('fringe',[(side*.006,-.011,1.612),(side*.035,-.045,1.59),(side*.059,-.057,1.55),(side*.069,-.047,1.51)], [.02,.027,.024,.002],hair)
    objects=[o for o in bpy.context.scene.objects if o.type=='MESH']
    if direction==2 or advanced:
        for o in objects:
            if any(n in o.name for n in ['face continuous','blouse','sleeve','leg','open cardigan','pleated skirt']):
                subdivide(o,1 if t<.7 else 2)
                if direction==2:
                    mod=o.modifiers.new('Continuity relaxation','SMOOTH');mod.factor=.1+.5*t;mod.iterations=iteration;apply(o,mod)
    if direction==3:
        # Only connected skin masses are merged. Clothing/materials remain separate.
        targets=[o for o in objects if o.name.startswith(('face continuous','neck','leg','palm','ear'))]
        bpy.ops.object.select_all(action='DESELECT')
        for o in targets:o.select_set(True)
        bpy.context.view_layer.objects.active=targets[0];bpy.ops.object.join();o=bpy.context.object
        mod=o.modifiers.new('Voxel fused skin','REMESH');mod.mode='VOXEL';mod.voxel_size=.006-.003*t;mod.use_smooth_shade=True;apply(o,mod)
        mod=o.modifiers.new('Laplacian surface','SMOOTH');mod.factor=.4;mod.iterations=2+iteration;apply(o,mod)
    if direction==8:
        # Planar projection genuinely embeds reference pixels, but unseen side/back
        # remain procedural materials; this is not recovered texture or geometry.
        ref=bpy.data.images.load(str(reference));ref.pack()
        for obj in objects:
            if obj.name.startswith(('face','blouse','open cardigan','pleated skirt','leg')):
                mat=material('reference projection '+obj.name,(.7,.7,.7))
                tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=ref
                mat.node_tree.links.new(tex.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
                obj.data.materials.append(mat)
                uv=obj.data.uv_layers.active or obj.data.uv_layers.new(name='reference')
                for p in obj.data.polygons:
                    if p.normal.y<-(.15+.5*t):
                        p.material_index=len(obj.data.materials)-1
                        for li in p.loop_indices:
                            co=obj.matrix_world@obj.data.vertices[obj.data.loops[li].vertex_index].co
                            uv.data[li].uv=(.51+co.x/1.03,.035+co.z/1.65*.945)
    objects=[o for o in bpy.context.scene.objects if o.type=='MESH']
    if direction==9:
        for o in objects:
            if len(o.data.polygons)>100:
                mod=o.modifiers.new('Preserve silhouette budget','DECIMATE');mod.ratio=.18+.075*iteration;apply(o,mod)
                for p in o.data.polygons:p.use_smooth=t>.4
    # Recalculate outward normals consistently.
    import bmesh
    for o in objects:
        bm=bmesh.new();bm.from_mesh(o.data);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(o.data);bm.free()
        o.rotation_euler.z=math.pi
        o.location.x=-o.location.x;o.location.y=-o.location.y
    bpy.context.view_layer.update()
    for o in objects:o.data.calc_loop_triangles()
    stats={'triangles':sum(len(o.data.loop_triangles) for o in objects),'meshes':len(objects),
           'visual_status':'awaiting_review','blender':bpy.app.version_string}
    bpy.ops.export_scene.gltf(filepath=str(directory/'model.glb'),export_format='GLB',export_apply=True,export_extras=True)
    # Standard lighting/camera for all candidates. No lighting changes per route.
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=8
    scene.render.resolution_x=384;scene.render.resolution_y=512;scene.render.resolution_percentage=100
    scene.world=bpy.data.worlds.new('review world');scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.32,.34,.37,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.7
    scene.view_settings.view_transform='AgX'
    center=Vector((0,0,.82))
    for loc,power in [((2,3,4),260),((-2,1,2),160),((0,-3,3),200)]:
        bpy.ops.object.light_add(type='AREA',location=loc);lamp=bpy.context.object;lamp.data.energy=power;lamp.data.shape='DISK';lamp.data.size=3
        lamp.rotation_euler=(center-lamp.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.object.camera_add();camera=bpy.context.object;scene.camera=camera;camera.data.type='ORTHO';camera.data.ortho_scale=1.86
    for view,loc in [('front',(0,4,.84)),('side',(4,0,.84)),('back',(0,-4,.84))]:
        camera.location=loc;camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
        scene.render.filepath=str(directory/(view+'.png'));bpy.ops.render.render(write_still=True)
    (directory/'stats.json').write_text(json.dumps(stats,indent=2))
    print('EXPERIMENT_DONE '+json.dumps(stats),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--direction',type=int,required=True,choices=range(1,11))
    parser.add_argument('--iteration',type=int,required=True,choices=range(1,11));parser.add_argument('--out',type=Path,required=True);parser.add_argument('--reference',type=Path,required=True)
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    build(args.direction,args.iteration,args.out,args.reference)
