"""Trusted three-view voxel builder. Blender + NumPy only; no generated code execution.

CLI: blender -b --python pixel_builder.py -- plan.json out.glb
The plan contains base64 images and validated subject-relative region parameters.
"""
import base64
from collections import deque
import json
import math
import os
import sys
import tempfile

import bpy
import bmesh
import numpy as np
from mathutils import Vector

N = 128


def runs(row):
    ids = np.flatnonzero(row)
    return np.split(ids, np.flatnonzero(np.diff(ids) > 1) + 1) if len(ids) else []


def read_view(encoded, path):
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > 20 * 1024 * 1024:
        raise ValueError('reference exceeds 20 MB')
    with open(path, 'wb') as handle:
        handle.write(raw)
    im = bpy.data.images.load(path, check_existing=False)
    w, h = im.size
    if min(w, h) < 16 or max(w, h) > 4096:
        raise ValueError('reference dimensions must be 16..4096')
    a = np.asarray(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]
    # Byte PNG buffers expose encoded sRGB values (verified against Pillow).
    # Convert exactly once, when writing the linear vertex-color attribute.
    rgb = a[..., :3]
    border = np.concatenate((rgb[:2].reshape(-1, 3), rgb[-2:].reshape(-1, 3),
                             rgb[:, :2].reshape(-1, 3), rgb[:, -2:].reshape(-1, 3)))
    bg = np.median(border, axis=0)
    if np.mean(a[..., 3] < .5) > .01:
        mask = a[..., 3] > .5
    else:
        # Remove only background connected to the image border. White clothing
        # enclosed by a silhouette remains foreground even on white backgrounds.
        near = np.linalg.norm(rgb - bg, axis=2) < .06
        exterior = np.zeros((h, w), bool)
        queue = deque()
        for y, x in [(0, x) for x in range(w)] + [(h-1, x) for x in range(w)] + [(y, 0) for y in range(h)] + [(y, w-1) for y in range(h)]:
            if near[y, x] and not exterior[y, x]:
                exterior[y, x] = True
                queue.append((y, x))
        while queue:
            y, x = queue.popleft()
            for yy, xx in ((y-1, x), (y+1, x), (y, x-1), (y, x+1)):
                if 0 <= yy < h and 0 <= xx < w and near[yy, xx] and not exterior[yy, xx]:
                    exterior[yy, xx] = True
                    queue.append((yy, xx))
        mask = ~exterior
    ys, xs = np.where(mask)
    if len(xs) < 32 or len(xs) > .95 * w * h:
        raise ValueError('cannot isolate subject: use a plain background or transparent PNG')
    top, bottom = ys.min(), ys.max()
    left, right = xs.min(), xs.max()
    if top == 0 or bottom == h-1 or left == 0 or right == w-1:
        raise ValueError('subject touches image border; upload an uncropped view')
    scale = 120 / (bottom-top+1)
    if (right-left+1)*scale > 124:
        raise ValueError('subject too wide for character grid')
    yy = np.clip(np.rint((np.arange(N)-4)/scale+top).astype(int), 0, h-1)
    xx = np.clip(np.rint((np.arange(N)-64)/scale+(left+right)/2).astype(int), 0, w-1)
    out = rgb[yy[:, None], xx[None, :]]
    m = mask[yy[:, None], xx[None, :]]
    m[:4] = False
    m[124:] = False
    # Coarse stable palette, without dithering. Raw source is retained in job snapshots.
    out = np.round(np.clip(out, 0, 1)*31)/31
    # Nearest valid color on each row, avoiding background bleed into surface pixels.
    for y in range(N):
        valid = np.flatnonzero(m[y])
        if len(valid):
            nearest = valid[np.abs(np.arange(N)[:, None]-valid).argmin(axis=1)]
            out[y] = out[y, nearest]
    bpy.data.images.remove(im)
    return out, m


def main():
    plan_path, output = sys.argv[-2:]
    with open(plan_path) as handle:
        plan = json.load(handle)
    height = float(plan.get('height_m', 1.6))
    if not .1 <= height <= 20:
        raise ValueError('height_m out of bounds')
    regions = plan['regions']
    if not 1 <= len(regions) <= 12:
        raise ValueError('invalid region count')
    for r in regions:
        if not 0 <= r['top'] < r['bottom'] <= 1 or not .15 <= r['depth_ratio'] <= 2:
            raise ValueError('invalid region bounds')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with tempfile.TemporaryDirectory() as tmp:
        views = [read_view(plan['images'][name], os.path.join(tmp, name+'.png')) for name in ('front', 'side', 'back')]
    front, side, back = [i[0] for i in views]
    fm, sm, bm = [i[1] for i in views]
    vol = np.zeros((N, N, N), bool)
    info = {}
    depth_axis = np.arange(N)
    for row in range(4, 124):
        sr = np.flatnonzero(sm[row])
        if not len(sr):
            continue
        region = next((r for r in regions if r['top'] <= (row-4)/120 < r['bottom']), None)
        if region is None:
            raise ValueError('region bands must cover the entire subject')
        for run in runs(fm[row]):
            if len(run) < 2:
                continue
            cx = (run[0]+run[-1])/2
            rx = len(run)/2
            ry = min((sr[-1]-sr[0]+1)/2, rx*region['depth_ratio'])
            cy = (sr[0]+sr[-1])/2
            for x in run:
                extent = max(.65, ry*math.sqrt(max(.05, 1-((x-cx)/(rx+.4))**2)))
                vol[row, x] = abs(depth_axis-cy) <= extent
                info[row, int(x)] = (cx, rx, cy, region['face'])
    if vol.sum() < 100:
        raise ValueError('empty or unusable three-view volume')
    # Resolve edge-only diagonal contacts while preserving detached accessories.
    for _ in range(8):
        changes = 0
        for axis in range(3):
            a = np.moveaxis(vol, axis, 0)
            p, q, r, t = a[:, :-1, :-1], a[:, 1:, :-1], a[:, :-1, 1:], a[:, 1:, 1:]
            d1, d2 = p&t&~q&~r, q&r&~p&~t
            changes += int(d1.sum()+d2.sum())
            q[d1] = True
            p[d2] = True
        if not changes:
            break
    unit = height/(np.where(vol)[0].max()-np.where(vol)[0].min()+1)
    floor_row = np.where(vol)[0].max()
    directions = [(0,1,0,[(1,0,0),(1,1,0),(1,1,1),(1,0,1)]),
        (0,-1,0,[(0,1,0),(0,0,0),(0,0,1),(0,1,1)]),
        (0,0,1,[(1,1,0),(0,1,0),(0,1,1),(1,1,1)]),
        (0,0,-1,[(0,0,0),(1,0,0),(1,0,1),(0,0,1)]),
        (-1,0,0,[(0,0,1),(1,0,1),(1,1,1),(0,1,1)]),
        (1,0,0,[(0,1,0),(1,1,0),(1,0,0),(0,0,0)])]
    vertices, faces, colors = [], [], []
    for row, x, y in np.argwhere(vol):
        cx, rx, cy, face = info.get((row, int(x)), (64, 64, 64, False))
        rear_x = int(np.clip(127-x, 0, 127))
        rgb = front[row, x] if y <= cy else back[row, rear_x]
        if face and (y > cy or abs(x-cx)/max(rx,1) > .72):
            rgb = back[row, int(np.clip(64-(x-64)*.65, 0, 127))]
        elif not face and abs(x-cx)/max(rx,1) > .8:
            # Front/rear colors give one stable color per voxel, no side-eye mirroring.
            rgb = side[row, int(y)]
        linear = np.where(rgb <= .04045, rgb/12.92, ((rgb+.055)/1.055)**2.4)
        for dr, dx, dy, corners in directions:
            rr, xx, yy = row+dr, x+dx, y+dy
            if 0 <= rr < N and 0 <= xx < N and 0 <= yy < N and vol[rr, xx, yy]:
                continue
            start = len(vertices)
            vertices.extend([(-(x-64+a)*unit, -(y-64+b)*unit, (floor_row-row+c)*unit) for a,b,c in corners])
            faces.append(tuple(range(start, start+4)))
            colors.extend([tuple(linear)+(1,)]*4)
    mesh = bpy.data.meshes.new('Pixel surface')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new('Pixel character', mesh)
    bpy.context.collection.objects.link(obj)
    obj['aigccat_coordinate_system'] = 'right_handed_y_up_neg_z'
    obj['animation_ready'] = False
    color = mesh.color_attributes.new(name='PixelColor', type='BYTE_COLOR', domain='CORNER')
    color.data.foreach_set('color', np.asarray(colors, dtype=np.float32).ravel())
    mat = bpy.data.materials.new('Pixel colors')
    mat.use_nodes = True
    mat.node_tree.nodes.clear()
    output_node = mat.node_tree.nodes.new('ShaderNodeOutputMaterial')
    vc = mat.node_tree.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'PixelColor'
    # Color directly into Surface exports KHR_materials_unlit. Pixel art already
    # contains painted shading: preview and web viewer must preserve its palette.
    mat.node_tree.links.new(vc.outputs['Color'], output_node.inputs['Surface'])
    mesh.materials.append(mat)
    edit = bmesh.new()
    edit.from_mesh(mesh)
    bmesh.ops.remove_doubles(edit, verts=list(edit.verts), dist=unit*.001)
    bmesh.ops.recalc_face_normals(edit, faces=list(edit.faces))
    boundary = sum(e.is_boundary for e in edit.edges)
    nonmanifold = sum(not e.is_manifold for e in edit.edges)
    edit.to_mesh(mesh)
    edit.free()
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', use_selection=True,
                              export_all_vertex_colors=True, export_extras=True)
    # Every review image is made from a clean reimport of the actual deliverable.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=output)
    s = bpy.context.scene
    s.render.engine = 'BLENDER_EEVEE'
    s.render.resolution_x = s.render.resolution_y = 384
    s.render.resolution_percentage = 100
    s.render.film_transparent = True
    s.render.image_settings.file_format = 'PNG'
    s.view_settings.view_transform = 'Standard'
    s.world = bpy.data.worlds.new('Pixel studio')
    s.world.use_nodes = True
    s.world.node_tree.nodes['Background'].inputs[0].default_value = (.4,.4,.4,1)
    s.world.node_tree.nodes['Background'].inputs[1].default_value = .6
    for loc, power in [((-2,3,4),350), ((3,1,2),170), ((0,-3,3),220)]:
        ld = bpy.data.lights.new('Studio','AREA')
        ld.energy = power*(height/1.6)**2
        ld.size = height*2
        light = bpy.data.objects.new('Studio',ld)
        s.collection.objects.link(light)
        light.location = Vector(loc)*height/1.6
        light.rotation_euler = (Vector((0,0,height/2))-light.location).to_track_quat('-Z','Y').to_euler()
    cam = bpy.data.objects.new('Review camera',bpy.data.cameras.new('Review camera'))
    s.collection.objects.link(cam)
    s.camera = cam
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = height*1.15
    reviews = {}
    for angle, name in enumerate(('front','angle45','side','angle135','back','angle225','other_side','angle315')):
        theta = angle*math.pi/4
        cam.location = (math.sin(theta)*height*3, math.cos(theta)*height*3, height/2)
        cam.rotation_euler = (Vector((0,0,height/2))-cam.location).to_track_quat('-Z','Y').to_euler()
        path = os.path.splitext(output)[0]+'_'+name+'.png'
        s.render.filepath = path
        bpy.ops.render.render(write_still=True)
        with open(path,'rb') as handle:
            reviews[name] = base64.b64encode(handle.read()).decode()
    print('WORKER_STATS '+json.dumps({'method':'pixel','resolution':N,'occupied_voxels':int(vol.sum()),
        'boundary_edges':boundary,'non_manifold_edges':nonmanifold,'animation_ready':False,
        'review_images':reviews,'notes':plan.get('notes','')}))


if __name__ == '__main__':
    main()
