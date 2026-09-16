"""可信参数化儿童角色引擎（Blender 5.2，单位米）。

blender -b --factory-startup --disable-autoexec --python character_engine.py -- \
    --input input.json --output character.glb
仅接受下列 DEFAULTS 字段；空对象使用默认值。生产调用使用 run_isolated_script.py。
height_m: 1.15–1.35；head_ratio: 4.8–5.8；age: 7/8。
hair: bob/short/pigtails；uniform: skirt/trousers；shoes: sneakers/mary_jane；
socks: ankle/knee；backpack: 布尔值。
materials: skin/hair/shirt/uniform/shoes/socks/backpack 各为 #RRGGBB。
本模块同时是可导入的部件生成函数库：CharacterBuilder 提供按部件的几何生成，
prepare_scene/evaluated_points/collect_object_stats/export_glb 为共享工具，
part_editor.py 复用这些定义完成部件级编辑；CLI 行为保持不变。
"""
import argparse
import json
import math
from pathlib import Path
import re
import sys

DEFAULTS = dict(age=8, height_m=1.25, head_ratio=5.2, hair='bob',
                uniform='skirt', shoes='sneakers', socks='knee', backpack=True,
                materials={})
COLORS = dict(skin='#E7B99C', hair='#30221E', shirt='#F2EFE5', uniform='#344D70',
              shoes='#394251', socks='#F7F6F0', backpack='#D57863')
COORDINATES = 'right_handed_y_up_neg_z'
PARTS = ('eyes', 'head', 'limbs', 'hair', 'clothes', 'backpack')


def validate(data):
    if not isinstance(data, dict) or set(data) - set(DEFAULTS):
        raise ValueError('输入必须为对象且字段必须在白名单内')
    p = {**DEFAULTS, **data}
    for key, lo, hi in [('height_m', 1.15, 1.35), ('head_ratio', 4.8, 5.8)]:
        if type(p[key]) not in (int, float) or not math.isfinite(p[key]) or not lo <= p[key] <= hi:
            raise ValueError(f'{key} 必须在 [{lo}, {hi}]')
    if type(p['age']) is not int or p['age'] not in (7, 8):
        raise ValueError('age 仅允许 7 或 8')
    for key, values in dict(hair=('bob', 'short', 'pigtails'), uniform=('skirt', 'trousers'),
                            shoes=('sneakers', 'mary_jane'), socks=('ankle', 'knee')).items():
        if not isinstance(p[key], str) or p[key] not in values:
            raise ValueError(f'{key} 不在白名单内')
    if type(p['backpack']) is not bool:
        raise ValueError('backpack 必须为布尔值')
    mats = p['materials']
    if not isinstance(mats, dict) or set(mats) - set(COLORS):
        raise ValueError('材质字段不在白名单内')
    if any(not isinstance(v, str) or not re.fullmatch(r'#[0-9A-Fa-f]{6}', v) for v in mats.values()):
        raise ValueError('材质仅允许 #RRGGBB，不允许文件、代码或纹理路径')
    p['materials'] = {**COLORS, **mats}
    return p


def no_duplicates(pairs):
    result = {}
    for k, v in pairs:
        if k in result:
            raise ValueError('JSON 重复字段：' + k)
        result[k] = v
    return result


def require_blender_host():
    import bpy
    if bpy.app.version[:2] != (5, 2):
        raise RuntimeError('需要 Blender 5.2 宿主')


def prepare_scene():
    """清空场景并设置公制单位，CLI 与部件编辑共用。"""
    import bpy
    require_blender_host()
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    return scene


def evaluated_points(objects):
    """对象（修改器求值后）的世界坐标顶点。
    曲线的 bound_box 可能包含远大于几何的范围，必须使用实际求值顶点。"""
    import bpy
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in objects:
        if obj.type not in ('MESH', 'CURVE'):
            continue
        evaluated = obj.evaluated_get(deps)
        mesh = evaluated.to_mesh()
        points.extend(evaluated.matrix_world @ v.co for v in mesh.vertices)
        evaluated.to_mesh_clear()
    return points


def collect_object_stats(objects):
    """逐对象统计部件、顶点数、三角形与实际包围盒。"""
    import bpy
    deps = bpy.context.evaluated_depsgraph_get()
    stats = {}
    for obj in objects:
        if obj.type not in ('MESH', 'CURVE'):
            continue
        evaluated = obj.evaluated_get(deps)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        world_vertices = [evaluated.matrix_world @ v.co for v in mesh.vertices]
        stats[obj.name] = dict(
            part=obj['aigccat_part'], vertices=len(mesh.vertices),
            triangles=len(mesh.loop_triangles),
            bounds_min=[min(v[i] for v in world_vertices) for i in range(3)],
            bounds_max=[max(v[i] for v in world_vertices) for i in range(3)])
        evaluated.to_mesh_clear()
    return stats


def part_vertex_counts(objects):
    """按 aigccat_part 汇总顶点数，供部件编辑校验。"""
    counts = {}
    for stat in collect_object_stats(objects).values():
        counts[stat['part']] = counts.get(stat['part'], 0) + stat['vertices']
    return counts


def export_glb(output):
    """保存 .blend 并导出带 extras 的 GLB，返回解析后的输出路径。"""
    import bpy
    output = Path(output).resolve()
    if output.suffix.lower() != '.glb' or not output.parent.is_dir():
        raise ValueError('输出必须为现有目录内的 .glb 文件')
    bpy.ops.wm.save_as_mainfile(filepath=str(output.with_suffix('.blend')))
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', export_yup=True,
                              export_extras=True, export_apply=True, export_animations=False,
                              export_cameras=False, export_lights=False)
    return output


class CharacterBuilder:
    """部件生成函数库：分组、材质与各部件几何，供 CLI 与部件级编辑复用。"""

    def __init__(self, p):
        import bpy
        self.p = p
        self.scene = bpy.context.scene
        self.scene['aigccat_coordinate_system'] = COORDINATES
        self.h = 1 / p['head_ratio']
        self.z = 1 - self.h / 2
        self.groups = {}
        self.materials = self._create_materials()

    def _create_materials(self):
        import bpy
        materials = {}
        for name, color in {**self.p['materials'], 'eyes': '#302E32', 'white': '#FFFFFF'}.items():
            mat = bpy.data.materials.new(name)
            srgb = [int(color[i:i+2], 16) / 255 for i in (1, 3, 5)]
            rgba = tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in srgb) + (1,)
            mat.diffuse_color = rgba
            mat.use_nodes = True
            shader = mat.node_tree.nodes.get('Principled BSDF')
            shader.inputs['Base Color'].default_value = rgba
            shader.inputs['Roughness'].default_value = .72
            materials[name] = mat
        return materials

    def create_groups(self):
        import bpy
        for part in PARTS:
            root = bpy.data.objects.new(part, None)
            self.scene.collection.objects.link(root)
            root['aigccat_part'] = part
            root['aigccat_coordinate_system'] = COORDINATES
            self.groups[part] = root
        return self.groups

    def _finish(self, obj, name, part, material):
        obj.name = name
        obj.parent = self.groups[part]
        obj['aigccat_part'] = part
        obj.data.materials.append(self.materials[material])
        if obj.type == 'MESH':
            for polygon in obj.data.polygons:
                polygon.use_smooth = True
        return obj

    def sphere(self, name, loc, scale, part, material):
        import bpy
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, location=loc)
        obj = bpy.context.object
        obj.scale = scale
        return self._finish(obj, name, part, material)

    def box(self, name, loc, size, radius, part, material):
        import bpy
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
        obj = bpy.context.object
        obj.scale = size
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bevel = obj.modifiers.new('圆角', 'BEVEL')
        bevel.width = radius
        bevel.segments = 4
        obj.modifiers.new('法线', 'WEIGHTED_NORMAL')
        return self._finish(obj, name, part, material)

    def curve(self, name, points, radius, part, material):
        import bpy
        data = bpy.data.curves.new(name, 'CURVE')
        data.dimensions = '3D'
        data.resolution_u = 10
        data.bevel_depth = radius
        data.bevel_resolution = 3
        data.use_fill_caps = True
        spline = data.splines.new('BEZIER')
        spline.bezier_points.add(len(points) - 1)
        for point, co in zip(spline.bezier_points, points):
            point.co = co
            point.handle_left_type = point.handle_right_type = 'AUTO'
        obj = bpy.data.objects.new(name, data)
        self.scene.collection.objects.link(obj)
        return self._finish(obj, name, part, material)

    def build_eyes(self):
        h, z = self.h, self.z
        for side in (-1, 1):
            x = side*h*.19
            self.sphere(f'eye_{side}', (x, h*.348, z+.012), (h*.052, h*.025, h*.067), 'eyes', 'eyes')
            self.sphere(f'eye_glint_{side}', (x-.002, h*.373, z+.017), (.0025, .0015, .003), 'eyes', 'white')

    def build_head(self):
        h, z = self.h, self.z
        self.sphere('head_round', (0, 0, z), (h*.43, h*.37, h*.49), 'head', 'skin')
        for side in (-1, 1):
            self.sphere(f'ear_{side}', (side*h*.43, 0, z-.012), (.014, .018, .022), 'head', 'skin')
        self.sphere('nose', (0, h*.368, z-.023), (.009, .01, .012), 'head', 'skin')
        self.curve('smile', [(-.015, h*.35, z-.045), (0, h*.365, z-.049), (.015, h*.35, z-.045)], .002, 'head', 'hair')

    def build_limbs(self):
        h = self.h
        self.sphere('neck', (0, 0, 1-h), (.035, .035, .06), 'limbs', 'skin')
        for side in (-1, 1):
            self.sphere(f'hand_{side}', (side*.156, .004, .504), (.032, .032, .043), 'limbs', 'skin')
            self.sphere(f'leg_{side}', (side*.064, 0, .27), (.04, .044, .235), 'limbs', 'skin')

    def build_clothes(self):
        import bpy
        p = self.p
        # 身体无成人胸腰造型，宽松长袖与及膝裙/长裤完整覆盖。
        self.box('shirt_loose', (0, 0, .655), (.225, .14, .28), .04, 'clothes', 'shirt')
        for side in (-1, 1):
            arm = self.box(f'sleeve_{side}', (side*.139, 0, .641), (.078, .11, .265), .032, 'clothes', 'shirt')
            arm.rotation_euler.y = side*-.12
            if p['uniform'] == 'trousers':
                self.box(f'trouser_{side}', (side*.065, 0, .31), (.103, .125, .47), .028, 'clothes', 'uniform')
            sock_top = .29 if p['socks'] == 'knee' else .115
            self.box(f'sock_{side}', (side*.064, 0, (.06+sock_top)/2), (.083, .093, sock_top-.06), .022, 'clothes', 'socks')
            self.box(f'shoe_{side}', (side*.064, .025, .035), (.105, .174, .07), .027, 'clothes', 'shoes')
            if p['shoes'] == 'sneakers':
                self.box(f'sole_{side}', (side*.064, .025, .012), (.107, .175, .024), .01, 'clothes', 'socks')
                for i in range(3):
                    self.box(f'lace_{side}_{i}', (side*.064, .04+i*.016, .071), (.051, .005, .005), .002, 'clothes', 'socks')
            else:
                self.box(f'strap_{side}', (side*.064, .016, .071), (.099, .024, .011), .004, 'clothes', 'shoes')
        if p['uniform'] == 'skirt':
            bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=.172, radius2=.112, depth=.265, location=(0, 0, .4525))
            skirt = bpy.context.object
            skirt.scale.y = .64
            bevel = skirt.modifiers.new('圆润裙边', 'BEVEL')
            bevel.width = .015
            bevel.segments = 4
            self._finish(skirt, 'knee_length_skirt', 'clothes', 'uniform')
        else:
            self.box('trouser_hips', (0, 0, .535), (.224, .14, .13), .028, 'clothes', 'uniform')
        for side in (-1, 1):
            collar = self.box(f'collar_{side}', (side*.039, .073, .766), (.072, .015, .045), .008, 'clothes', 'uniform')
            collar.rotation_euler.y = side*.25

    def build_hair(self):
        h, z, p = self.h, self.z, self.p
        # 曲线发束覆盖后脑与顶部，前额保留面部；没有球形头盔遮挡眼睛。
        rx, ry, rz = h*.445, h*.39, h*.505
        for i in range(25):
            phi = math.pi*.85 + math.pi*1.30*i/24
            points = []
            for j in range(7):
                theta = .05 + (1.95 if p['hair'] != 'short' else 1.65)*j/6
                points.append((rx*math.sin(theta)*math.cos(phi), ry*math.sin(theta)*math.sin(phi), z+rz*math.cos(theta)))
            self.curve(f'hair_back_{i:02}', points, h*.048, 'hair', 'hair')
        for i in range(11):
            x = (i-5)*h*.072
            self.curve(f'bangs_{i:02}', [(x*.45, .012, z+rz*.96), (x*.85, ry*.76, z+rz*.63),
                                   (x, ry*.94, z+rz*(.26+.08*math.cos(i)))], h*.049, 'hair', 'hair')
        if p['hair'] == 'pigtails':
            for side in (-1, 1):
                for i in range(5):
                    self.curve(f'pigtail_{side}_{i}', [(side*rx*.87, -.015, z), (side*(rx+.035), -.015+i*.005, z-.06),
                                                (side*(rx+.028), -.02, z-.135)], .012, 'hair', 'hair')

    def build_backpack(self):
        if not self.p['backpack']:
            return
        self.box('backpack_body', (0, -.118, .655), (.195, .095, .235), .035, 'backpack', 'backpack')
        self.box('backpack_pocket', (0, -.173, .619), (.145, .026, .105), .017, 'backpack', 'backpack')
        for side in (-1, 1):
            self.curve(f'backpack_strap_{side}', [(side*.082, -.117, .75), (side*.085, .011, .79),
                                           (side*.09, .085, .70), (side*.096, .065, .567),
                                           (side*.085, -.116, .565)], .011, 'backpack', 'backpack')

    def build_part(self, part):
        if part not in PARTS:
            raise ValueError(f'未知部件：{part}')
        getattr(self, f'build_{part}')()

    def build_all(self):
        for part in PARTS:
            self.build_part(part)

    def normalize_height(self, height_m, roots=None):
        """包含发束与鞋底的实际包围盒精确归一化到所需身高。"""
        import bpy
        roots = list(self.groups.values()) if roots is None else list(roots)
        points = evaluated_points([child for root in roots for child in root.children])
        if not points:
            raise RuntimeError('没有可归一化的几何体')
        low, high = min(v.z for v in points), max(v.z for v in points)
        scale = height_m / (high-low)
        for root in roots:
            root.scale = (scale,)*3
            root.location.z = -low*scale
        bpy.context.view_layer.update()


def build(p, output):
    import bpy
    prepare_scene()
    builder = CharacterBuilder(p)
    builder.create_groups()
    builder.build_all()
    builder.normalize_height(p['height_m'])
    output = export_glb(output)
    scene = bpy.context.scene
    object_stats = collect_object_stats(scene.objects)
    vertices = sum(s['vertices'] for s in object_stats.values())
    triangles = sum(s['triangles'] for s in object_stats.values())
    bounds_min = [min(s['bounds_min'][i] for s in object_stats.values()) for i in range(3)]
    bounds_max = [max(s['bounds_max'][i] for s in object_stats.values()) for i in range(3)]
    stats = dict(schema_version=1, parameters=p, blender_version=bpy.app.version_string,
                 aigccat_coordinate_system=COORDINATES, vertices=vertices, triangles=triangles,
                 objects=len(scene.objects), parts={k: len(v.children) for k, v in builder.groups.items()},
                 height_m=bounds_max[2]-bounds_min[2],
                 geometry_coordinate_system='blender_right_handed_z_up_pos_y',
                 bounds_min=bounds_min, bounds_max=bounds_max,
                 object_stats=object_stats,
                 glb_bytes=output.stat().st_size)
    output.with_suffix('.stats.json').write_text(json.dumps(stats, ensure_ascii=False, indent=2))
    print(json.dumps(stats, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:])
    if args.input.stat().st_size > 65536:
        raise ValueError('JSON 不得超过 64 KiB')
    params = validate(json.loads(args.input.read_text(), object_pairs_hook=no_duplicates))
    build(params, args.output)


if __name__ == '__main__':
    main()
