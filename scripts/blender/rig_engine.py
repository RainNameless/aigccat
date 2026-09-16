"""aigccat 角色自动绑骨 + 待机动画引擎（Blender 5.2，单位米）。

blender -b --factory-startup --disable-autoexec --python rig_engine.py -- \
    --input rig.json
输入 JSON（≤64 KiB，字段白名单）：
    source_glb: aigccat 模板生成的 GLB 路径（对象必须带 aigccat_part 属性）
    output:     输出 GLB 路径（现有目录内）
流程：导入 GLB → 校验模板属性（非模板明确报错）→ 依据部件求值后实际包围盒
计算 15 骨骨骼位置（竖直链 roll 对齐，local X = 世界 +X，pose 通道可预期）→
创建 ARMATURE：hips/spine/chest/neck/head + shoulder.L/R/upper_arm.L/R/hand.L/R
+ upper_leg.L/R/foot.L/R → 按部件归属绑定（hair/backpack→head，躯干 clothes→
spine/chest/hips，limbs 腿/裤袜→腿骨，手臂 sleeve+hand 尝试 ARMATURE_AUTO
自动权重，失败回退按归属 bone parent）→ 待机动画 idle：6 秒无缝循环
（呼吸=chest 位移+微倾、头部左右缓摆+轻点头、身体 sway，正弦整数周期采样，
首尾帧严格一致，LINEAR 插值）→ 导出 GLB（export_animations=True、Y-up、
extras 保留）→ GLB JSON chunk 与 Blender 重新导入双重校验（ARMATURE、
动画 clip 时长、首尾帧姿态一致、静置绑定误差报告）。
本脚本仅在 Blender 宿主内执行可信几何操作：不读密钥、不调外部服务、不动其他文件。
"""
import argparse
import json
import math
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import character_engine as ce

RIG_KEYS = ('source_glb', 'output')
CHAIN = ('hips', 'spine', 'chest', 'neck', 'head')
FPS = 24
DURATION_S = 6.0
KEY_STEP = 6                      # 0.25 s 采样，25 关键帧/通道
ANIM_NAME = 'idle'
DEVIATION_LIMIT = 1e-3            # 绑定后静置最大允许顶点位移（米）


def validate_rig(data):
    if not isinstance(data, dict) or set(data) - set(RIG_KEYS):
        raise ValueError('输入必须为对象且仅包含 ' + '/'.join(RIG_KEYS))
    for key in RIG_KEYS:
        if not isinstance(data[key], str) or not data[key].strip():
            raise ValueError(f'{key} 必须为非空字符串')
    source = Path(data['source_glb'])
    if source.suffix.lower() != '.glb' or not source.is_file():
        raise ValueError('source_glb 必须为存在的 .glb 文件')
    output = Path(data['output'])
    if output.suffix.lower() != '.glb' or not output.parent.is_dir():
        raise ValueError('output 必须为现有目录内的 .glb 文件')
    return source, output


def import_glb(filepath):
    import bpy
    try:
        bpy.ops.import_scene.gltf(filepath=str(filepath))
    except AttributeError:  # 兼容算子改名
        bpy.ops.wm.gltf_import(filepath=str(filepath))


def evaluated_verts(objects):
    """逐对象（修改器求值后）的世界坐标顶点快照。"""
    import bpy
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    result = {}
    for obj in objects:
        if obj.type not in ('MESH', 'CURVE'):
            continue
        evaluated = obj.evaluated_get(deps)
        mesh = evaluated.to_mesh()
        result[obj] = [evaluated.matrix_world @ v.co for v in mesh.vertices]
        evaluated.to_mesh_clear()
    return result


def bounds_of(verts):
    """顶点集的逐轴 (min, max)。"""
    return tuple((min(v[i] for v in verts), max(v[i] for v in verts))
                 for i in range(3))


def side_suffix(x):
    """模板角色面向 +Y：-X 为角色左侧（.L），+X 为右侧（.R）。"""
    return '.L' if x < 0 else '.R'


def classify(objects, bounds):
    """按部件归属返回 {对象: 目标骨骼 或 'auto_arm'（手臂自动权重组）}。"""
    targets = {}
    for obj in objects:
        part, name = obj['aigccat_part'], obj.name.lower()
        x = sum(bounds[obj][0]) / 2
        if part in ('head', 'eyes', 'hair', 'backpack'):
            bone = 'head'
        elif part == 'limbs':
            if 'neck' in name:
                bone = 'neck'
            elif 'hand' in name:
                bone = 'auto_arm'
            elif 'leg' in name:
                bone = 'upper_leg' + side_suffix(x)
            else:
                bone = 'chest'
        else:  # clothes
            if 'sleeve' in name:
                bone = 'auto_arm'
            elif 'shirt' in name or 'collar' in name:
                bone = 'chest'
            elif 'skirt' in name or ('trouser' in name and 'hips' in name):
                bone = 'hips'
            elif 'trouser' in name or 'sock' in name:
                bone = 'upper_leg' + side_suffix(x)
            elif any(k in name for k in ('shoe', 'sole', 'lace', 'strap')):
                bone = 'foot' + side_suffix(x)
            else:
                bone = 'chest'
        targets[obj] = bone
    return targets


def compute_skeleton(objects, bounds):
    """依据部件实际包围盒推导 15 根骨骼的 head/tail（先精确适配站直模板）。"""
    def objs_of(part, keyword):
        found = [o for o in objects
                 if o['aigccat_part'] == part and keyword in o.name.lower()]
        if not found:
            raise ValueError(f'模板缺少测量锚点：{part}/{keyword or "*"}')
        return found

    def center_x(objs):
        return (min(bounds[o][0][0] for o in objs)
                + max(bounds[o][0][1] for o in objs)) / 2

    def zspan(objs):
        return (min(bounds[o][2][0] for o in objs),
                max(bounds[o][2][1] for o in objs))

    def side_pair(part, keyword):
        found = objs_of(part, keyword)
        left = [o for o in found if sum(bounds[o][0]) / 2 < 0]
        right = [o for o in found if sum(bounds[o][0]) / 2 >= 0]
        if not left or not right:
            raise ValueError(f'模板缺少左右侧锚点：{part}/{keyword}')
        return left, right

    head_lo, head_hi = zspan(objs_of('head', ''))
    shirt_lo, shirt_hi = zspan(objs_of('clothes', 'shirt'))
    leg_top = zspan(objs_of('limbs', 'leg'))[1]
    torso = shirt_hi - leg_top
    if torso <= 0:
        raise ValueError('躯干锚点异常：shirt 顶低于腿顶')
    z_spine = leg_top + .20 * torso
    z_chest = leg_top + .55 * torso
    z_neck_base = shirt_hi
    z_neck_top = max(head_lo, z_neck_base + .01)
    z_head_top = head_hi
    bones = [
        dict(name='hips', head=(0, 0, leg_top), tail=(0, 0, z_spine),
             parent=None, connect=False),
        # CHAIN 不用 use_connect：connected bone 锁定 location 通道，
        # 呼吸等位移动画将不参与 pose 求值（rest 位置不受影响）
        dict(name='spine', head=(0, 0, z_spine), tail=(0, 0, z_chest),
             parent='hips', connect=False),
        dict(name='chest', head=(0, 0, z_chest), tail=(0, 0, z_neck_base),
             parent='spine', connect=False),
        dict(name='neck', head=(0, 0, z_neck_base), tail=(0, 0, z_neck_top),
             parent='chest', connect=False),
        dict(name='head', head=(0, 0, z_neck_top), tail=(0, 0, z_head_top),
             parent='neck', connect=False),
    ]
    sleeve_l, sleeve_r = side_pair('clothes', 'sleeve')
    hand_l, hand_r = side_pair('limbs', 'hand')
    leg_l, leg_r = side_pair('limbs', 'leg')
    shoes = [o for o in objects if o['aigccat_part'] == 'clothes'
             and any(k in o.name.lower() for k in ('shoe', 'sole', 'lace', 'strap'))]
    if not shoes:
        raise ValueError('模板缺少测量锚点：clothes/shoe')
    shoes_l = [o for o in shoes if sum(bounds[o][0]) / 2 < 0]
    shoes_r = [o for o in shoes if sum(bounds[o][0]) / 2 >= 0]
    if not shoes_l or not shoes_r:
        raise ValueError('模板缺少左右侧锚点：clothes/shoe')
    for suffix, sign, sleeve_side, hand_side, leg_side, shoe_side in (
            ('L', -1, sleeve_l, hand_l, leg_l, shoes_l),
            ('R', 1, sleeve_r, hand_r, leg_r, shoes_r)):
        scx = abs(center_x(sleeve_side))
        z_sleeve_hi = zspan(sleeve_side)[1]
        hcx = abs(center_x(hand_side))
        z_hand_lo, z_hand_hi = zspan(hand_side)
        lcx = abs(center_x(leg_side))
        z_leg_hi = zspan(leg_side)[1]
        z_ankle = zspan(shoe_side)[1]
        z_shoe_mid = sum(zspan(shoe_side)) / 2
        y_toe = max(bounds[o][1][1] for o in shoe_side)
        bones += [
            dict(name=f'shoulder.{suffix}',
                 head=(sign * .45 * scx, 0, z_sleeve_hi),
                 tail=(sign * scx, 0, z_sleeve_hi),
                 parent='chest', connect=False),
            dict(name=f'upper_arm.{suffix}',
                 head=(sign * scx, 0, z_sleeve_hi),
                 tail=(sign * hcx, 0, z_hand_hi),
                 parent=f'shoulder.{suffix}', connect=True),
            dict(name=f'hand.{suffix}',
                 head=(sign * hcx, 0, z_hand_hi),
                 tail=(sign * hcx, 0, z_hand_lo),
                 parent=f'upper_arm.{suffix}', connect=True),
            dict(name=f'upper_leg.{suffix}',
                 head=(sign * lcx, 0, z_leg_hi),
                 tail=(sign * lcx, 0, z_ankle),
                 parent='hips', connect=False),
            dict(name=f'foot.{suffix}',
                 head=(sign * lcx, 0, z_ankle),
                 tail=(sign * lcx, y_toe, z_shoe_mid),
                 parent=f'upper_leg.{suffix}', connect=True),
        ]
    return bones


def align_x_axis(bone):
    """竖直链骨骼 roll 对齐：local X = 世界 +X（location.x=左右，location.y=上下）。"""
    from mathutils import Vector
    direction = (bone.tail - bone.head).normalized()
    if abs(direction.z) < .99:
        return
    target = Vector((1.0, 0.0, 0.0))
    current = bone.x_axis.copy()
    angle = math.atan2(current.cross(target).dot(direction), current.dot(target))
    for roll in (bone.roll + angle, bone.roll - angle):
        bone.roll = roll
        if (bone.x_axis - target).length < 1e-4:
            return
    raise RuntimeError(f'骨骼 {bone.name} X 轴 roll 对齐失败')


def create_armature(bones):
    import bpy
    arm_data = bpy.data.armatures.new('aigccat_rig')
    arm = bpy.data.objects.new('Armature', arm_data)
    bpy.context.scene.collection.objects.link(arm)
    arm['aigccat_part'] = 'rig'
    arm['aigccat_coordinate_system'] = ce.COORDINATES
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for spec in bones:
        bone = arm_data.edit_bones.new(spec['name'])
        bone.head, bone.tail = spec['head'], spec['tail']
    for spec in bones:
        bone = arm_data.edit_bones[spec['name']]
        if spec['parent']:
            bone.parent = arm_data.edit_bones[spec['parent']]
            bone.use_connect = spec['connect']
        if spec['name'] in CHAIN:
            align_x_axis(bone)
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm


def parent_to_bone(obj, arm, bone_name):
    """bone parent（parent_type='BONE'）。

    Blender 骨骼父矩阵原点在骨尾、轴向为骨骼轴向（臂架空间）：
    P = arm.matrix_world @ bone.matrix_local @ T(0, length, 0)（5.2.1 实测反推）。
    显式设置 matrix_parent_inverse 并重置 matrix_basis（旧父级下的局部变换不能
    保留），保持世界变换不变。
    """
    from mathutils import Matrix
    world = obj.matrix_world.copy()
    bone = arm.data.bones[bone_name]
    parent_matrix = (arm.matrix_world @ bone.matrix_local
                     @ Matrix.Translation((0, bone.length, 0)))
    obj.parent = arm
    obj.parent_type = 'BONE'
    obj.parent_bone = bone_name
    obj.matrix_parent_inverse = parent_matrix.inverted() @ world
    obj.matrix_basis.identity()


def auto_fallback_bone(obj):
    """自动权重失败时按部件归属回退：sleeve→upper_arm，hand→hand。"""
    suffix = side_suffix(obj.matrix_world.translation.x)
    return ('hand' if 'hand' in obj.name.lower() else 'upper_arm') + suffix


def try_auto_weights(objects, arm):
    """手臂网格组尝试 ARMATURE_AUTO（bone heat 自动权重），失败返回 False。"""
    import bpy
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    result, detail = None, ''
    try:
        result = bpy.ops.object.parent_set(type='ARMATURE_AUTO', keep_transform=True)
    except RuntimeError as exc:
        detail = str(exc)
    if 'FINISHED' not in (result or ()):
        print(f'AUTO_WEIGHTS_FAILED result={result} {detail}')
        return False
    for obj in objects:
        if obj.parent != arm:
            print(f'AUTO_WEIGHTS_INCOMPLETE object={obj.name} parent={obj.parent and obj.parent.name} '
                  f'type={obj.parent_type} groups={len(obj.vertex_groups)}')
            return False
        if obj.parent_type == 'OBJECT':
            # keep_transform 下算子使用 OBJECT 父级；两模式父矩阵相同，
            # 规范化为 ARMATURE 以构成标准蒙皮设置，世界变换不变。
            obj.parent_type = 'ARMATURE'
        if obj.parent_type != 'ARMATURE':
            print(f'AUTO_WEIGHTS_BAD_TYPE object={obj.name} type={obj.parent_type}')
            return False
        if not obj.vertex_groups:
            print(f'AUTO_WEIGHTS_NO_GROUPS object={obj.name}')
            return False
        if not any(m.type == 'ARMATURE' for m in obj.modifiers):
            print(f'AUTO_WEIGHTS_NO_MODIFIER object={obj.name}')
            return False
    return True


def cleanup_auto(objects):
    import bpy
    for obj in objects:
        for modifier in [m for m in obj.modifiers if m.type == 'ARMATURE']:
            obj.modifiers.remove(modifier)
        obj.vertex_groups.clear()


def channels_for(height):
    """待机动画通道：(骨骼, 通道, 索引, 振幅, 周期数, 相位)；周期数为整数保证无缝。"""
    return [
        ('chest', 'location', 1, .005 * height, 2, 0.0),          # 呼吸：胸腔抬升
        ('chest', 'rotation_euler', 0, .006, 2, .7),              # 呼吸：轻微起伏
        ('head', 'rotation_euler', 2, .035, 1, 0.0),              # 头部左右缓摆
        ('head', 'rotation_euler', 0, .015, 1, math.pi / 2),      # 轻微点头
        ('spine', 'rotation_euler', 2, .012, 1, 2 * math.pi / 3),  # 上身反向轻摆
        ('hips', 'location', 0, .003 * height, 1, math.pi),       # 身体整体 sway
    ]


def all_fcurves(action):
    """Blender 5.2 slotted actions：取全部 channelbag 的 fcurve（legacy fcurves 已移除）。"""
    fcurves = []
    for layer in getattr(action, 'layers', ()):
        for strip in layer.strips:
            for bag in strip.channelbags:
                fcurves.extend(bag.fcurves)
    return fcurves


def insert_idle_keyframes(arm, channels):
    # pose bone 默认 rotation_mode='QUATERNION'：rotation_euler 的 fcurve 只更新属性值，
    # 不驱动 pose matrix（导出采样恒定）。必须先切到欧拉模式。
    for bone_name, path, index, amp, cycles, phase in channels:
        if path == 'rotation_euler':
            arm.pose.bones[bone_name].rotation_mode = 'XYZ'
    # 关键帧 0..144：glTF 导出按 frame/fps 映射时间，得到精确 0..6.0 s
    frames = range(0, int(DURATION_S * FPS) + 1, KEY_STEP)
    for frame in frames:
        t = frame / FPS
        for bone_name, path, index, amp, cycles, phase in channels:
            pose_bone = arm.pose.bones[bone_name]
            value = amp * math.sin(2 * math.pi * cycles * t / DURATION_S + phase)
            getattr(pose_bone, path)[index] = value
            pose_bone.keyframe_insert(data_path=path, index=index, frame=frame)
    return len(frames)


def build_idle_action(arm, height):
    import bpy
    channels = channels_for(height)
    action = bpy.data.actions.new(ANIM_NAME)
    action.use_fake_user = True
    anim_data = arm.animation_data_create()
    anim_data.action = action
    keyframes = insert_idle_keyframes(arm, channels)
    if not all_fcurves(action):
        # 兼容 slotted actions：改为让 keyframe_insert 自动创建 action 再重命名
        anim_data.action = None
        bpy.data.actions.remove(action)
        insert_idle_keyframes(arm, channels)
        action = anim_data.action
        action.name = ANIM_NAME
        action.use_fake_user = True
    for fcurve in all_fcurves(action):
        for point in fcurve.keyframe_points:
            point.interpolation = 'LINEAR'
    return action, channels, keyframes


def export_rigged_glb(output):
    import bpy
    bpy.ops.wm.save_as_mainfile(filepath=str(output.with_suffix('.blend')))
    bpy.ops.export_scene.gltf(
        filepath=str(output), export_format='GLB', export_yup=True,
        export_extras=True, export_apply=True, export_animations=True,
        export_cameras=False, export_lights=False)
    return output.resolve()


def parse_glb_json(path):
    data = path.read_bytes()
    if len(data) < 20 or struct.unpack('<I', data[:4])[0] != 0x46546C67:
        raise ValueError('输出不是有效 GLB')
    chunk_len, chunk_type = struct.unpack('<II', data[12:20])
    if chunk_type != 0x4E4F534A:
        raise ValueError('GLB 首 chunk 不是 JSON')
    return json.loads(data[20:20 + chunk_len])


def validate_glb_json(output):
    gltf = parse_glb_json(output)
    animations = gltf.get('animations') or []
    accessors = gltf.get('accessors') or []
    duration = 0.0
    for anim in animations:
        for sampler in anim.get('samplers', []):
            maximum = accessors[sampler['input']].get('max')
            if maximum:
                duration = max(duration, float(maximum[0]))
    return dict(animation_count=len(animations),
                animation_names=[a.get('name') for a in animations],
                duration_s=round(duration, 4),
                skin_count=len(gltf.get('skins') or []),
                node_count=len(gltf.get('nodes') or []))


def pose_loop_ok(arm, action):
    """重新导入后实际求值：首尾帧姿态一致（循环无缝）且中帧姿态不同（存在实际运动）。
    返回 (loop_seamless, has_motion)；无法求值时返回 None。"""
    import bpy
    scene = bpy.context.scene
    try:
        anim_data = arm.animation_data_create()
        if anim_data.action is None:
            anim_data.action = action
            if getattr(anim_data, 'action_slot', None) is None \
                    and getattr(action, 'slots', None):
                anim_data.action_slot = action.slots[0]

        def snapshot(frame):
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            return {pb.name: (arm.matrix_world @ pb.matrix).copy()
                    for pb in arm.pose.bones}

        def matrix_delta(a, b):
            return max(abs(a[i][j] - b[i][j]) for i in range(4) for j in range(4))

        first, last = int(action.frame_range[0]), int(action.frame_range[1])
        mid = (first + last) // 2
        before, after, middle = snapshot(first), snapshot(last), snapshot(mid)
        loop = max(matrix_delta(before[k], after[k]) for k in before) < 1e-5
        motion = max(matrix_delta(before[k], middle[k]) for k in before) > 1e-5
        return loop, motion
    except Exception as exc:
        print(f'POSE_LOOP_CHECK_SKIPPED: {type(exc).__name__} {exc}')
        return None


def validate_roundtrip(output):
    """重新导入输出 GLB：校验 ARMATURE、动画 clip、时长与首尾帧一致性。"""
    import bpy
    ce.prepare_scene()
    scene = bpy.context.scene
    scene.render.fps = FPS
    for action in list(bpy.data.actions):  # 清场后残留的旧 action 会导致重名 idle.001
        bpy.data.actions.remove(action)
    import_glb(output)
    armatures = [o for o in scene.objects if o.type == 'ARMATURE']
    if not armatures:
        raise RuntimeError('输出 GLB 不含 ARMATURE')
    arm = armatures[0]
    actions = list(bpy.data.actions)
    if not actions:
        raise RuntimeError('输出 GLB 不含动画 clip')
    report = dict(bone_count=len(arm.data.bones),
                  bones=sorted(b.name for b in arm.data.bones),
                  action_names=[a.name for a in actions], durations_s=[])
    seamless = True
    for action in actions:
        duration = (action.frame_range[1] - action.frame_range[0]) / FPS
        report['durations_s'].append(round(duration, 4))
        if abs(duration - DURATION_S) > .15:
            seamless = False
        for fcurve in all_fcurves(action):
            points = fcurve.keyframe_points
            if abs(points[-1].co.y - points[0].co.y) > 1e-6:
                seamless = False
    report['loop_seamless_fcurve'] = seamless
    pose = pose_loop_ok(arm, actions[0])
    if pose is None:
        report['loop_seamless_pose'] = None
    else:
        report['loop_seamless_pose'] = pose[0]
        report['loop_has_motion'] = pose[1]
    return report


def run(source, output):
    import bpy
    ce.prepare_scene()
    scene = bpy.context.scene
    import_glb(source)
    imported = list(scene.objects)
    # 模板校验：与 part_editor 同标准，非模板明确报错
    tagged = [o for o in imported if 'aigccat_part' in o]
    if not tagged:
        raise ValueError('source_glb 不是 aigccat 模板生成：对象缺少 aigccat_part 属性')
    if not any('aigccat_coordinate_system' in o for o in imported):
        raise ValueError('source_glb 不是 aigccat 模板生成：缺少 aigccat_coordinate_system 属性')
    untagged = [o.name for o in imported if 'aigccat_part' not in o]
    if untagged:
        raise ValueError(f'对象缺少 aigccat_part 属性：{untagged}')
    bad = {o['aigccat_part'] for o in tagged} - set(ce.PARTS)
    if bad:
        raise ValueError(f'aigccat_part 值非法：{sorted(bad)}（已绑骨 GLB 不可重复绑骨）')
    geometry = [o for o in imported if o.type in ('MESH', 'CURVE')]
    if not geometry:
        raise ValueError('source_glb 不含可绑定的几何体')
    before_verts = evaluated_verts(geometry)
    bounds = {o: bounds_of(v) for o, v in before_verts.items()}
    # 骨骼与绑定
    targets = classify(geometry, bounds)
    skeleton = compute_skeleton(geometry, bounds)
    arm = create_armature(skeleton)
    auto_objects = [o for o, b in targets.items() if b == 'auto_arm']
    binding_map = {}
    for obj, bone in targets.items():
        if bone != 'auto_arm':
            parent_to_bone(obj, arm, bone)
            binding_map[obj.name] = 'bone:' + bone
    auto_weights_used = False
    if auto_objects:
        auto_weights_used = try_auto_weights(auto_objects, arm)
        if auto_weights_used:
            for obj in auto_objects:
                binding_map[obj.name] = 'auto_weights'
        else:
            cleanup_auto(auto_objects)
            for obj in auto_objects:
                bone = auto_fallback_bone(obj)
                parent_to_bone(obj, arm, bone)
                binding_map[obj.name] = 'bone:' + bone
    # 静置绑定误差（T-pose 偏差报告）
    after_verts = evaluated_verts(list(before_verts))
    deviations = {}
    for obj, verts in after_verts.items():
        old = before_verts[obj]
        deviations[obj.name] = (max((a - b).length for a, b in zip(verts, old))
                                if len(old) == len(verts) else None)
    max_deviation = max(d for d in deviations.values() if d is not None)
    if max_deviation > DEVIATION_LIMIT:
        worst = sorted((d, n) for n, d in deviations.items() if d is not None)[-5:]
        raise RuntimeError(f'绑定后静置偏差超限：{max_deviation:.6f} m；最差对象：'
                           + ', '.join(f'{n}={d:.6f}' for d, n in worst))
    # 待机动画
    height = max(b[2][1] for b in bounds.values()) - min(b[2][0] for b in bounds.values())
    auto_names = sorted(o.name for o in auto_objects)  # 清场校验前固化
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = 0, int(DURATION_S * FPS)
    action, channels, keyframes = build_idle_action(arm, height)
    # 导出 + 双重校验
    output = export_rigged_glb(output)
    glb_report = validate_glb_json(output)
    roundtrip = validate_roundtrip(output)
    validation_ok = (roundtrip['bone_count'] == len(skeleton)
                     and roundtrip['loop_seamless_fcurve']
                     and roundtrip['loop_seamless_pose'] is not False
                     and glb_report['animation_count'] >= 1
                     and ANIM_NAME in glb_report['animation_names']
                     and abs(glb_report['duration_s'] - DURATION_S) < .15)
    stats = dict(
        schema_version=1, source=str(source), output=str(output),
        blender_version=bpy.app.version_string,
        aigccat_coordinate_system=ce.COORDINATES, height_m=height,
        bone_count=len(skeleton),
        bones=[dict(name=b['name'], head=list(b['head']), tail=list(b['tail']),
                    parent=b['parent'], connected=b['connect']) for b in skeleton],
        binding=dict(
            auto_weights_objects=auto_names,
            auto_weights_used=auto_weights_used,
            methods=binding_map,
            max_rest_deviation_m=round(max_deviation, 8),
            per_object_rest_deviation_m={k: round(v, 8) if v is not None else None
                                         for k, v in deviations.items()}),
        animation=dict(
            name=ANIM_NAME, fps=FPS, duration_s=DURATION_S,
            interpolation='LINEAR', keyframes_per_channel=keyframes,
            channels=[f'{b}.{p}[{i}] amp={a:.5f} cycles={c} phase={ph:.2f}'
                      for b, p, i, a, c, ph in channels]),
        glb=dict(bytes=output.stat().st_size, **glb_report),
        validation=dict(**roundtrip, validation_ok=validation_ok))
    output.with_suffix('.stats.json').write_text(json.dumps(stats, ensure_ascii=False, indent=2))
    print(json.dumps(stats, ensure_ascii=False))
    if not validation_ok:
        raise RuntimeError('绑骨校验失败：' + json.dumps(
            dict(glb=glb_report, roundtrip=roundtrip), ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:])
    if args.input.stat().st_size > 65536:
        raise ValueError('JSON 不得超过 64 KiB')
    source, output = validate_rig(
        json.loads(args.input.read_text(), object_pairs_hook=ce.no_duplicates))
    run(source, output)


if __name__ == '__main__':
    main()
