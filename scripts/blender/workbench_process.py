"""Deterministic workbench operations. Every successful operation exports a new GLB."""
import base64
import json
import math
import os
import sys


def number(options, key, default, low, high):
    value = float(options.get(key, default))
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{key} must be in {low}..{high}')
    return value


def run(data):
    import bpy
    import bmesh
    from mathutils import Vector
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=data['src'])
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        raise ValueError('No mesh found')
    options = data.get('options') or {}
    operation = data['operation']
    selected = options.get('mesh', '')
    targets = [o for o in meshes if not selected or o.name == selected]
    if not targets:
        raise ValueError('Selected mesh no longer exists')
    if operation in ('decimate', 'remesh', 'quad', 'split') and any(o.find_armature() for o in targets):
        raise ValueError('Topology operations require an unrigged source version')
    def active(obj):
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
    def bake_color(source, target):
        # Keep the original textured surface while rebuilding UVs/topology.
        # Baking transfers appearance onto the new UV layout instead of reusing invalid coordinates.
        active(target)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(island_margin=.025)
        bpy.ops.object.mode_set(mode='OBJECT')
        mat = bpy.data.materials.new('Reprojected surface')
        mat.use_nodes = True
        target.data.materials.clear()
        target.data.materials.append(mat)
        image = bpy.data.images.new('Reprojected color', width=1024, height=1024)
        node = mat.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = image
        mat.node_tree.nodes.active = node
        scene = bpy.context.scene
        scene.render.engine = 'CYCLES'
        scene.cycles.device = 'CPU'
        scene.cycles.samples = 1
        scene.render.bake.use_selected_to_active = operation != 'uv'
        scene.render.bake.use_pass_direct = False
        scene.render.bake.use_pass_indirect = False
        scene.render.bake.use_pass_color = True
        scene.render.bake.cage_extrusion = max(target.dimensions) * .04
        scene.render.bake.max_ray_distance = max(target.dimensions) * .15
        scene.render.bake.margin = 8
        if operation == 'uv':
            # Same geometry: evaluate the original UV shader on the target itself,
            # avoiding ray projection misses at thin parts and seams.
            old_uv = target.data.uv_layers.new(name='Original UV')
            for dst, src in zip(old_uv.data, source.data.uv_layers.active.data):
                dst.uv = src.uv
            target.data.uv_layers.active_index = 0
            target.data.uv_layers[0].active_render = True
            target.data.materials.clear()
            for original_mat in source.data.materials:
                temp = original_mat.copy()
                uvnode = temp.node_tree.nodes.new('ShaderNodeUVMap')
                uvnode.uv_map = old_uv.name
                for tex in list(temp.node_tree.nodes):
                    if tex.type == 'TEX_IMAGE':
                        temp.node_tree.links.new(uvnode.outputs['UV'], tex.inputs['Vector'])
                dest = temp.node_tree.nodes.new('ShaderNodeTexImage')
                dest.image = image
                temp.node_tree.nodes.active = dest
                target.data.materials.append(temp)
            source.hide_render = True
        else:
            source.select_set(True)
        bpy.ops.object.bake(type='DIFFUSE')
        target.data.materials.clear()
        target.data.materials.append(mat)
        mat.node_tree.links.new(node.outputs['Color'], mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
        image.pack()
        bpy.data.objects.remove(source, do_unlink=True)
        active(target)
    if operation in ('decimate', 'remesh', 'quad', 'split', 'uv'):
        for obj in targets:
            active(obj)
            original = None
            if operation in ('uv', 'remesh', 'quad') and any(m and m.use_nodes and any(n.type == 'TEX_IMAGE' for n in m.node_tree.nodes) for m in obj.data.materials):
                original = obj.copy()
                original.data = obj.data.copy()
                bpy.context.collection.objects.link(original)
                original.select_set(False)
            if operation in ('quad', 'split'):
                bm = bmesh.new()
                bm.from_mesh(obj.data)
                bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
                bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
                bm.to_mesh(obj.data)
                bm.free()
                obj.data.update()
            if operation == 'decimate':
                mod = obj.modifiers.new('Workbench reduction', 'DECIMATE')
                mod.ratio = number(data, 'ratio', .5, .01, 1)
                bpy.ops.object.modifier_apply(modifier=mod.name)
            elif operation == 'remesh':
                mod = obj.modifiers.new('Workbench voxel remesh', 'REMESH')
                mod.mode = 'VOXEL'
                mod.voxel_size = number(data, 'voxel_size', .05, .005, 1)
                bpy.ops.object.modifier_apply(modifier=mod.name)
            elif operation == 'quad':
                count = int(number(options, 'faces', 5000, 500, 100000))
                bpy.ops.object.quadriflow_remesh(target_faces=count, use_mesh_symmetry=False)
            elif operation == 'split':
                method = options.get('method')
                bpy.ops.object.mode_set(mode='EDIT')
                bpy.ops.mesh.select_all(action='SELECT')
                if method == 'presplit':
                    # Split only sharp manifold edges; selecting all edges would shatter every face.
                    bm = bmesh.from_edit_mesh(obj.data)
                    sharp = [e for e in bm.edges if e.is_manifold
                             and e.calc_face_angle() > math.radians(35)]
                    if sharp:
                        bmesh.ops.split_edges(bm, edges=sharp)
                    bmesh.update_edit_mesh(obj.data)
                    bpy.ops.mesh.select_all(action='SELECT')
                    bpy.ops.mesh.separate(type='LOOSE')
                else:
                    bpy.ops.mesh.separate(type='MATERIAL' if method == 'material' else 'LOOSE')
                bpy.ops.object.mode_set(mode='OBJECT')
            elif operation == 'uv':
                bpy.ops.object.mode_set(mode='EDIT')
                bpy.ops.mesh.select_all(action='SELECT')
                uv_mode = options.get('mode', 'smart')
                if uv_mode == 'angle':
                    # 角度展开：按面法线夹角合并成岛，适合机械/硬表面
                    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=.02)
                else:
                    bpy.ops.uv.smart_project(island_margin=.03)
                bpy.ops.object.mode_set(mode='OBJECT')
            if original is not None:
                bake_color(original, obj)
    elif operation == 'material':
        color = options.get('color', '#d1d1d1').lstrip('#')
        if len(color) != 6:
            raise ValueError('Invalid material color')
        rgb = [int(color[i:i+2], 16)/255 for i in (0,2,4)]
        linear = [v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4 for v in rgb]
        texture = None
        if options.get('texture_b64'):
            path = os.path.join(os.path.dirname(data['out']), 'texture.png')
            with open(path, 'wb') as handle:
                handle.write(base64.b64decode(options['texture_b64'], validate=True))
            texture = bpy.data.images.load(path)
            texture.pack()
        for obj in targets:
            if texture and not obj.data.uv_layers:
                raise ValueError('Model has no UV coordinates; unwrap before applying a texture')
            # Copy each material slot: edits must retain existing maps, normal channels,
            # face-to-material assignments and materials used by unselected meshes.
            if not obj.data.materials:
                obj.data.materials.append(bpy.data.materials.new('Workbench PBR'))
            for index, original in enumerate(list(obj.data.materials)):
                mat = original.copy() if original else bpy.data.materials.new('Workbench PBR')
                mat.use_nodes = True
                bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
                if bsdf is None:
                    raise ValueError('Material has no supported Principled shader')
                if not bsdf.inputs['Base Color'].is_linked:
                    bsdf.inputs['Base Color'].default_value = (*linear, 1)
                bsdf.inputs['Roughness'].default_value = number(options, 'roughness', .5, 0, 1)
                bsdf.inputs['Metallic'].default_value = number(options, 'metalness', 0, 0, 1)
                if texture:
                    for link in list(bsdf.inputs['Base Color'].links):
                        mat.node_tree.links.remove(link)
                    node = mat.node_tree.nodes.new('ShaderNodeTexImage')
                    node.image = texture
                    mat.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
                obj.data.materials[index] = mat
    elif operation == 'upscale':
        size = int(number(options, 'resolution', 2048, 256, 8192))
        images = set()
        for obj in targets:
            for mat in obj.data.materials:
                if mat and mat.use_nodes:
                    for node in mat.node_tree.nodes:
                        if node.type == 'TEX_IMAGE' and node.image:
                            images.add(node.image)
        if not images:
            raise ValueError('Source model has no texture images')
        for image in images:
            w,h = image.size
            ratio = size/max(w,h)
            image.scale(max(1,round(w*ratio)),max(1,round(h*ratio)))
            image.pack()
    elif operation == 'transform':
        scale = number(options,'scale',1,.01,100)
        angle = math.radians(number(options,'rotation',0,-360,360))
        root = bpy.data.objects.new('Workbench transform', None)
        bpy.context.collection.objects.link(root)
        for obj in list(bpy.context.scene.objects):
            if obj != root and obj.parent is None:
                obj.parent = root
        root.scale = (scale,)*3
        root.rotation_euler.z = angle
    elif operation == 'rig':
        # The existing rig engine validates template anchors and skin deformation.
        import importlib.util
        directory = os.environ['AIGCCAT_BLENDER_SCRIPTS']
        sys.path.insert(0, directory)
        path = os.path.join(directory, 'rig_engine.py')
        spec = importlib.util.spec_from_file_location('rig_engine', path)
        rig = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rig)
        from pathlib import Path
        rig.run(Path(data['src']), Path(data['out']))
        with open(os.path.splitext(data['out'])[0]+'.stats.json') as handle:
            print('WORKER_STATS '+handle.read().replace('\n',''))
        return
    elif operation == 'animation':
        preset = options.get('preset','turntable')
        if preset not in ('turntable','bounce','land','retreat','hook','combo','kick','dance'):
            raise ValueError(f'Unsupported animation preset: {preset}')
        root = bpy.data.objects.new('Workbench animation', None)
        bpy.context.collection.objects.link(root)
        for obj in list(bpy.context.scene.objects):
            if obj != root and obj.parent is None:
                obj.parent = root
        duration = number(options,'duration',4,1,30)
        scene = bpy.context.scene
        scene.render.fps = 24
        scene.frame_end = round(duration*24)+1
        def insert(frame, rot_z=0, loc_z=0, loc_x=0, loc_y=0):
            root.rotation_euler.z = rot_z
            root.location.z = loc_z
            root.location.x = loc_x
            root.location.y = loc_y
            root.keyframe_insert('rotation_euler', frame=frame)
            root.keyframe_insert('location', frame=frame)
        if preset == 'turntable':
            for frame in range(1, scene.frame_end+1, 4):
                phase = (frame-1)/(scene.frame_end-1)
                insert(frame, rot_z=phase*math.tau)
            insert(scene.frame_end, rot_z=math.tau)
        elif preset == 'bounce':
            for frame in range(1, scene.frame_end+1, 4):
                phase = (frame-1)/(scene.frame_end-1)
                insert(frame, loc_z=abs(math.sin(phase*math.tau))*0.08)
            insert(scene.frame_end, loc_z=0)
        elif preset == 'land':
            n = scene.frame_end
            for frame in range(1, n+1, 4):
                t = (frame-1)/(n-1)
                if t < 0.3: z = 0.6 * (t/0.3)
                elif t < 0.8: z = 0.6 * (1 - (t-0.3)/0.5)
                else: z = max(0, 0.6 * (1 - (t-0.3)/0.5) * (1 - (t-0.8)/0.2)*4)
                insert(frame, loc_z=z)
            insert(n, loc_z=0)
        elif preset == 'retreat':
            for frame in range(1, scene.frame_end+1, 4):
                phase = (frame-1)/(scene.frame_end-1)
                insert(frame, loc_y=phase*0.5, loc_z=abs(math.sin(phase*math.pi))*0.05)
            insert(scene.frame_end, loc_y=0.5)
        elif preset == 'hook':
            for frame in range(1, scene.frame_end+1, 4):
                phase = (frame-1)/(scene.frame_end-1)
                swing = math.sin(phase*math.tau)
                insert(frame, rot_z=swing*0.4, loc_z=max(0, swing)*0.04)
            insert(scene.frame_end, rot_z=0)
        elif preset == 'combo':
            n = scene.frame_end
            for frame in range(1, n+1, 4):
                t = (frame-1)/(n-1)
                if t < 0.5:
                    swing = math.sin(t*math.pi*2)
                    insert(frame, rot_z=swing*0.4)
                else:
                    tt = (t-0.5)*2
                    z = 0.4 * max(0, 1 - abs(tt-0.5)*4)
                    insert(frame, loc_z=z)
            insert(n)
        elif preset == 'kick':
            for frame in range(1, scene.frame_end+1, 4):
                phase = (frame-1)/(scene.frame_end-1)
                kick = max(0, math.sin(phase*math.pi))
                insert(frame, loc_y=-kick*0.4, loc_z=kick*0.06)
            insert(scene.frame_end, loc_y=0)
        elif preset == 'dance':
            for frame in range(1, scene.frame_end+1, 4):
                phase = (frame-1)/(scene.frame_end-1)
                insert(frame,
                    rot_z=math.sin(phase*math.tau)*0.3,
                    loc_z=abs(math.sin(phase*math.tau*2))*0.05,
                    loc_x=math.sin(phase*math.tau*3)*0.05)
            insert(scene.frame_end, rot_z=0)
        root.animation_data.action.name = preset
        scene.frame_set(1)
    else:
        raise ValueError('Unsupported operation: '+operation)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes or not sum(len(o.data.polygons) for o in meshes):
        raise ValueError('Operation produced empty geometry')
    for obj in meshes:
        obj.data.calc_loop_triangles()
    stats = {'operation':operation, 'mesh_count':len(meshes), 'triangles':sum(len(o.data.loop_triangles) for o in meshes), 'vertices':sum(len(o.data.vertices) for o in meshes), 'animations':len(bpy.data.actions)}
    bpy.ops.export_scene.gltf(filepath=data['out'], export_format='GLB', export_extras=True, export_animations=True)
    print('WORKER_STATS '+json.dumps(stats))


if __name__ == '__main__':
    try:
        with open(sys.argv[sys.argv.index('--')+1]) as handle:
            run(json.load(handle))
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
