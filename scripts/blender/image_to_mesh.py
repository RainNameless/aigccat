"""把正面参考图转成可挤出的剪影 SVG（不依赖 cv2/skimage）。

思路：白/纯色背景参考图 → 灰度 → 大津阈值 → 取最大连通区域的行列范围 →
按行求左右边界 → 生成闭合多边形 → 写 SVG。Blender 再导入 SVG 曲线并挤出成 3D。

局限（不要夸大）：这是「正面剪影挤出」，侧面/背面靠对称假设，属于图片驱动的
建模辅助，不是多视角三维重建。
"""
import sys

import numpy as np
from PIL import Image


def load_gray(path, size=512):
    image = Image.open(path).convert("L").resize((size, size))
    return np.asarray(image, dtype=np.float32) / 255.0


def otsu(gray):
    hist, _ = np.histogram(gray, bins=256, range=(0, 1))
    total = hist.sum()
    sum_all = np.dot(np.arange(256), hist)
    sum_b = w_b = 0.0
    best, threshold = -1.0, 0
    for i in range(256):
        w_b += hist[i]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += i * hist[i]
        m_b = sum_b / w_b
        m_f = (sum_all - sum_b) / w_f
        between = w_b * w_f * (m_b - m_f) ** 2
        if between > best:
            best, threshold = between, i
    return threshold / 255.0


def silhouette_polygon(gray):
    # 以四角估计背景色，用与背景的灰度差分割；比单一全局阈值稳健。
    h, w = gray.shape
    k = max(2, h // 20)
    corners = np.concatenate([
        gray[:k, :k].ravel(), gray[:k, -k:].ravel(),
        gray[-k:, :k].ravel(), gray[-k:, -k:].ravel(),
    ])
    background = float(np.median(corners))
    diff = np.abs(gray - background)
    level = max(0.12, float(np.percentile(diff, 70)) * 0.6)
    mask = diff > level
    if mask.mean() > 0.6:  # 背景占比异常时退回大津法
        level = otsu(gray)
        mask = gray < level
        if mask.mean() > 0.6:
            mask = gray > level
    rows = np.where(mask.any(axis=1))[0]
    if rows.size < 8:
        return None
    top, bottom = rows[0], rows[-1]
    points = []
    for y in range(top, bottom + 1, 2):
        cols = np.where(mask[y])[0]
        if cols.size == 0:
            continue
        points.append((int(cols[0]), int(y)))
    for y in range(bottom, top - 1, -2):
        cols = np.where(mask[y])[0]
        if cols.size == 0:
            continue
        points.append((int(cols[-1]), int(y)))
    return points, mask.mean()


def write_svg(points, width, height, out_path):
    if not points:
        return False
    # SVG 的 Y 轴向下，Blender 导入后需翻转；这里直接输出并保持单位一致。
    path = "M " + " L ".join(f"{x},{y}" for x, y in points) + " Z"
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}"><path d="{path}" fill="#000000"/></svg>'
    )
    with open(out_path, "w") as handle:
        handle.write(svg)
    return True


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    gray = load_gray(src)
    result = silhouette_polygon(gray)
    if not result:
        print("NO_SILHOUETTE")
        sys.exit(1)
    points, coverage = result
    ok = write_svg(points, gray.shape[1], gray.shape[0], dst)
    print(f"SVG_OK points={len(points)} coverage={coverage:.3f} -> {dst}" if ok else "SVG_FAIL")
