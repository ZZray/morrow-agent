// Copyright (c) Ray Zhang. 主题与强调色：预设 + 自定义，记在本机；全站颜色都从 --accent 用 color-mix 派生。
export type ThemeChoice = 'system' | 'light' | 'dark';
export const accentPresets = [
  { value: '#f6d454', label: '柠檬黄' },
  { value: '#a6ef9e', label: '薄荷绿' },
  { value: '#b49cf7', label: '薰衣草' },
  { value: '#f7b37c', label: '蜜桃橙' },
  { value: '#8ec5f5', label: '晴空蓝' },
  { value: '#f39ab8', label: '樱花粉' },
] as const;
export const defaultAccent = accentPresets[0].value;
const ACCENT_KEY = 'reach.accent', THEME_KEY = 'reach.theme';
const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeAccent(value: string | null | undefined): string | null {
  return value && HEX.test(value) ? value.toLowerCase() : null;
}
export function normalizeTheme(value: string | null | undefined): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}
function readKey(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function writeKey(key: string, value: string | null) {
  try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* 隐私模式等场景只在本次会话生效 */ }
}

export function currentAccent() { return normalizeAccent(readKey(ACCENT_KEY)) ?? defaultAccent; }
export function currentTheme() { return normalizeTheme(readKey(THEME_KEY)); }

// CSSOM 设置属性不受 style-src 'self' 限制。
// 强调色上的文字：浅色强调配深字，深色强调配白字（WCAG 相对亮度）。
export function onAccent(color: string): '#1f1f22' | '#ffffff' {
  const [r, g, b] = [1, 3, 5].map(i => { const c = parseInt(color.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? '#1f1f22' : '#ffffff';
}
export function applyAccent(color: string | null) {
  const next = normalizeAccent(color);
  const style = document.documentElement.style;
  if (next && next !== defaultAccent) { style.setProperty('--accent-user', next); style.setProperty('--on-accent', onAccent(next)); }
  else { style.removeProperty('--accent-user'); style.removeProperty('--on-accent'); }
}
export function setAccent(color: string | null) {
  const next = normalizeAccent(color);
  writeKey(ACCENT_KEY, next && next !== defaultAccent ? next : null);
  applyAccent(next);
}
export function applyTheme(choice: ThemeChoice) {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
}
export function setTheme(choice: ThemeChoice) { writeKey(THEME_KEY, choice === 'system' ? null : choice); applyTheme(choice); }
export function restoreAppearance() { applyTheme(currentTheme()); applyAccent(currentAccent()); }
