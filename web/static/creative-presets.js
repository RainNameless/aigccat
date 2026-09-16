const KEY = 'aigccat.creative-presets.v1';
export const starterPresets = [
  { id:'product', name:'产品造型', icon:'package', prompt:'单件原创产品，主体完整居中，明确结构连接、材质分区与尺寸关系，中性背景，柔和均匀光线。' },
  { id:'character', name:'角色设定', icon:'contact-round', prompt:'原创角色全身设定，站姿自然，四肢与服装轮廓清楚，保持左右比例一致，无文字与配饰遮挡。' },
  { id:'architecture', name:'建筑体块', icon:'landmark', prompt:'单体原创建筑，清晰呈现入口、层级和屋顶结构，三分之四视角，材质简洁，背景留白。' },
  { id:'surface', name:'材质样本', icon:'swatch-book', prompt:'正视角材质样本，均匀照明，可平铺的表面细节，无透视变形、文字、阴影或高光遮挡。' },
];
export function loadPresets() {
  try {
    const entries = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(entries) ? entries.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.prompt === 'string').slice(0,40).map(p => ({id:p.id, name:p.name.slice(0,40), prompt:p.prompt.slice(0,10000)})) : [];
  } catch { return []; }
}
export function savePresets(entries) {
  localStorage.setItem(KEY, JSON.stringify(entries.slice(0,40)));
}
