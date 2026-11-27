// Copyright (c) Ray Zhang. Reach 对话侧栏浮动菜单定位（视口坐标系边界翻转与键盘回退锚点）。

/** 计算侧栏更多按钮与右键触发的菜单视口坐标，兼容键盘 0,0 触发事件。 */
export function contextMenuPoint(
  coords: { clientX: number; clientY: number },
  anchor: { left: number; top: number; bottom: number },
): { x: number; y: number; flipUpFrom?: number } {
  if (coords.clientX > 0 || coords.clientY > 0) return { x: coords.clientX, y: coords.clientY };
  return { x: Math.max(8, anchor.left + 24), y: anchor.bottom + 4, flipUpFrom: anchor.top - 4 };
}

/** 在视口安全区域内定位浮动菜单，贴近下/右边沿时反向翻转并保持齐边。 */
export function placeFloatingMenu(opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  pad?: number;
  flipUpFrom?: number;
  flipLeftFrom?: number;
}): { left: number; top: number; flipX: boolean; flipY: boolean } {
  const pad = opts.pad ?? 8;
  const maxLeft = Math.max(pad, opts.viewportWidth - opts.width - pad);
  const leftAnchor = opts.flipLeftFrom ?? opts.x;
  const flipX = opts.x + opts.width > opts.viewportWidth - pad && leftAnchor - opts.width >= pad;
  const left = Math.min(maxLeft, Math.max(pad, flipX ? leftAnchor - opts.width : opts.x));
  const maxTop = Math.max(pad, opts.viewportHeight - opts.height - pad);
  const topAnchor = opts.flipUpFrom ?? opts.y;
  const flipY = opts.y + opts.height > opts.viewportHeight - pad && topAnchor - opts.height >= pad;
  const top = Math.min(maxTop, Math.max(pad, flipY ? topAnchor - opts.height : opts.y));
  return { left, top, flipX, flipY };
}
