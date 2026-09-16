"""aigccat 部件级编辑器（Blender 5.2，单位米）。

blender -b --factory-startup --disable-autoexec --python part_editor.py -- \
    --input edit.json
输入 JSON（≤64 KiB，字段白名单）：
    source_glb:  aigccat 模板生成的 GLB 路径
    edit_params: 与 character_engine 相同的参数 schema（缺省字段用默认值）
    parts:       要重建的部件名数组，如 ["hair","backpack"]
    output:      输出 GLB 路径（现有目录内）
原理：导入 source GLB → 按 aigccat_part 属性精确匹配删除 parts 组的全部对象
（根空物体与子对象）→ 复用 character_engine 的相同生成函数按新参数重建，
以原身高为锚点归一化 → 导出同样带 extras 的 GLB → 重新导入输出校验：
未编辑部件顶点数误差 <1%、被编辑部件存在新几何、总身高误差 <0.5%。
source_glb 若不是模板生成（缺少 aigccat_part 属性）则明确报错退出，不做猜测。
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import character_engine as ce

EDIT_KEYS = ('source_glb', 'edit_params', 'parts', 'output')


def validate_edit(data):
    if not isinstance(data, dict) or set(data) - set(EDIT_KEYS):
        raise ValueError('输入必须为对象且仅包含 ' + '/'.join(EDIT_KEYS))
    for key in ('source_glb', 'output'):
        if not isinstance(data[key], str) or not data[key].strip():
            raise ValueError(f'{key} 必须为非空字符串')
    source = Path(data['source_glb'])
    if source.suffix.lower() != '.glb' or not source.is_file():
        raise ValueError('source_glb 必须为存在的 .glb 文件')
    output = Path(data['output'])
    if output.suffix.lower() != '.glb' or not output.parent.is_dir():
        raise ValueError('output 必须为现有目录内的 .glb 文件')
    parts = data['parts']
    if not isinstance(parts, list) or not parts or not all(isinstance(x, str) for x in parts):
        raise ValueError('parts 必须为非空字符串数组')
    if len(set(parts)) != len(parts):
        raise ValueError('parts 不得重复')
    unknown = set(parts) - set(ce.PARTS)
    if unknown:
        raise ValueError(f'parts 含未知部件：{sorted(unknown)}，仅允许 {list(ce.PARTS)}')
    params = ce.validate(data['edit_params'])
    return source, params, parts, output


def import_glb(filepath):
    import bpy
    try:
        bpy.ops.import_scene.gltf(filepath=str(filepath))
    except AttributeError:  # 兼容算子改名
        bpy.ops.wm.gltf_import(filepath=str(filepath))


def remove_objects(objects):
    import bpy
    for obj in objects:
        bpy.data.objects.remove(obj, do_unlink=True)


def purge_orphan_data():
    import bpy
    bpy.data.orphans_purge(do_recursive=True)


def scene_extent(objects):
    """所有几何对象的实际 z 向包围范围（最低点、身高）。"""
    stats = ce.collect_object_stats(objects)
    if not stats:
        raise ValueError('没有可测量的几何体')
    zs = [s['bounds_min'][2] for s in stats.values()] + [s['bounds_max'][2] for s in stats.values()]
    return min(zs), max(zs) - min(zs)


def run(source, params, parts, output):
    import bpy
    ce.prepare_scene()
    scene = bpy.context.scene
    import_glb(source)
    imported = list(scene.objects)
    tagged = [o for o in imported if 'aigccat_part' in o]
    if not tagged:
        raise ValueError('source_glb 不是 aigccat 模板生成：对象缺少 aigccat_part 自定义属性，拒绝编辑')
    if not any('aigccat_coordinate_system' in o for o in imported):
        raise ValueError('source_glb 不是 aigccat 模板生成：缺少 aigccat_coordinate_system 属性，拒绝编辑')
    untagged = [o.name for o in imported if 'aigccat_part' not in o]
    if untagged:
        raise ValueError(f'对象缺少 aigccat_part 属性：{untagged}，不是完整的 aigccat 模板 GLB')
    bad = {o['aigccat_part'] for o in tagged} - set(ce.PARTS)
    if bad:
        raise ValueError(f'aigccat_part 值非法：{sorted(bad)}')
    # 编辑前快照：逐部件顶点数与总身高，作为校验基准
    original_counts = ce.part_vertex_counts(imported)
    _, original_height = scene_extent(imported)
    # 按 aigccat_part 精确匹配删除指定部件（根空物体与子对象一并删除）
    edit_set = set(parts)
    doomed = [o for o in imported if o.get('aigccat_part') in edit_set]
    remove_objects(doomed)
    purge_orphan_data()
    # 用引擎相同生成函数按新参数重建全部部件，以原身高为锚点归一化，
    # 随后丢弃参考构建中未被编辑的部件（沿用 source 原对象）。
    builder = ce.CharacterBuilder(params)
    builder.create_groups()
    builder.build_all()
    builder.normalize_height(original_height)
    for part, root in list(builder.groups.items()):
        if part not in edit_set:
            remove_objects([root] + list(root.children))
    builder.groups = {p: r for p, r in builder.groups.items() if p in edit_set}
    purge_orphan_data()
    output = ce.export_glb(output)
    # 重新导入输出 GLB，校验部件顶点数与总身高
    ce.prepare_scene()
    import_glb(output)
    final_objects = list(bpy.context.scene.objects)
    final_counts = ce.part_vertex_counts(final_objects)
    _, final_height = scene_extent(final_objects)
    final_stats = ce.collect_object_stats(final_objects)
    errors = []
    report = dict(schema_version=1, source=str(source), parameters=params, parts=parts,
                  blender_version=bpy.app.version_string,
                  aigccat_coordinate_system=ce.COORDINATES,
                  original_height_m=original_height, final_height_m=final_height,
                  height_error=abs(final_height-original_height)/original_height,
                  vertices=sum(final_counts.values()),
                  triangles=sum(s['triangles'] for s in final_stats.values()),
                  objects=len(final_objects),
                  bounds_min=[min(s['bounds_min'][i] for s in final_stats.values()) for i in range(3)],
                  bounds_max=[max(s['bounds_max'][i] for s in final_stats.values()) for i in range(3)],
                  glb_bytes=output.stat().st_size,
                  part_vertices={})
    for part in ce.PARTS:
        old, new = original_counts.get(part, 0), final_counts.get(part, 0)
        entry = dict(edited=part in edit_set, original_vertices=old, final_vertices=new)
        if part in edit_set:
            if new == 0 and not (part == 'backpack' and not params['backpack']):
                errors.append(f'被编辑部件 {part} 没有生成任何几何体')
        elif old == 0 and new == 0:
            pass
        elif old == 0 or abs(new-old) > .01*old:
            errors.append(f'未编辑部件 {part} 顶点数变化超限：{old} → {new}')
        report['part_vertices'][part] = entry
    if abs(final_height-original_height) > .005*original_height:
        errors.append(f'总身高误差超限：{original_height} → {final_height}')
    report['validation_ok'] = not errors
    report['errors'] = errors
    output.with_suffix('.stats.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False))
    if errors:
        raise RuntimeError('部件编辑校验失败：' + '; '.join(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:])
    if args.input.stat().st_size > 65536:
        raise ValueError('JSON 不得超过 64 KiB')
    source, params, parts, output = validate_edit(
        json.loads(args.input.read_text(), object_pairs_hook=ce.no_duplicates))
    run(source, params, parts, output)


if __name__ == '__main__':
    main()
