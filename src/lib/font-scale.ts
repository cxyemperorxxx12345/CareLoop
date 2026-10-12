// 适老化字号档位：小（默认）/ 中 / 大
// 患者端核心用户为老年患者，全站统一小字号不友好；这里提供三档全局字号，
// 选择存 localStorage，刷新与跨页面均保持。

export type FontScale = 'sm' | 'md' | 'lg';

export const FONT_SCALE_KEY = 'careloop:font-scale';

export const FONT_SCALE_OPTIONS: Array<{ value: FontScale; label: string }> = [
  { value: 'sm', label: '小' },
  { value: 'md', label: '中' },
  { value: 'lg', label: '大' },
];

/** 读取本地记忆的档位；无记录 / 存储不可用时回退默认「小」 */
export function readFontScale(): FontScale {
  try {
    const v = localStorage.getItem(FONT_SCALE_KEY);
    if (v === 'sm' || v === 'md' || v === 'lg') return v;
  } catch {
    /* localStorage 被禁用时静默回退 */
  }
  return 'sm';
}

/** 把档位写到 <html> 的 class 上（fs-sm / fs-md / fs-lg，样式见 index.css） */
export function applyFontScale(scale: FontScale): void {
  const root = document.documentElement;
  root.classList.remove('fs-sm', 'fs-md', 'fs-lg');
  root.classList.add(`fs-${scale}`);
}

/** 持久化到 localStorage；存储不可用时仅本次会话生效 */
export function saveFontScale(scale: FontScale): void {
  try {
    localStorage.setItem(FONT_SCALE_KEY, scale);
  } catch {
    /* 忽略写入失败（隐私模式等） */
  }
}
