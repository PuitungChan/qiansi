/**
 * 《牵丝》—— 世界坐标 ↔ 屏幕坐标。
 *
 * 约定（DECISIONS D-018）：
 *   - 房间左下角为世界原点 (0, 0)，Y 轴向上，1 单位 = 1 米
 *   - 渲染比例 60 px/m，窗口 1920×1080 ⇒ 可见 32m × 18m（单屏房间制 FR-LVL-004）
 *   - 因此 `屏幕像素 = (世界坐标 − 取景原点) × 60`
 *
 * ⚠️ **取景原点是第 13 轮实机反馈修的一个真 bug**：原先窗口左下角钉在世界 (0,0)，
 * 而地面顶面就在 y = 0 —— 整个可玩带贴在屏幕最下沿，**深沟（y < 0）完全在屏幕外**。
 * 创始人反馈「我看不到沟在哪里」。现在窗口下移到 `VIEW_ORIGIN_Y = −4.4`。
 *
 * 这个文件同时被渲染层和输入层使用，是全工程**唯一**允许把米换算成像素的地方。
 * 任何别处出现 `* 60` 都是缺陷。
 *
 * 本文件不导入 `cc`——它是纯数学，可以被本机测试覆盖。
 */

import { PPM, VIEW_H, VIEW_ORIGIN_X, VIEW_ORIGIN_Y, VIEW_W } from '../core/constants'
import type { Vec2 } from '../core/vec2'

/** 世界坐标 → 屏幕像素（原点在**窗口**左下角，Y 向上）。 */
export function worldToScreen(p: Vec2): { x: number; y: number } {
  return { x: (p.x - VIEW_ORIGIN_X) * PPM, y: (p.y - VIEW_ORIGIN_Y) * PPM }
}

/** 屏幕像素 → 世界坐标。 */
export function screenToWorld(x: number, y: number): Vec2 {
  return { x: x / PPM + VIEW_ORIGIN_X, y: y / PPM + VIEW_ORIGIN_Y }
}

/** 世界坐标 → 以画布中心为原点的节点局部坐标（Cocos Canvas 的坐标系）。 */
export function worldToLocal(p: Vec2): { x: number; y: number } {
  const s = worldToScreen(p)
  return { x: s.x - VIEW_W / 2, y: s.y - VIEW_H / 2 }
}

/** Cocos 的 UI 坐标（左下角为原点）→ 世界坐标。 */
export function uiToWorld(uiX: number, uiY: number): Vec2 {
  return screenToWorld(uiX, uiY)
}

/**
 * Cocos 的 UI 坐标（左下角为原点，1920×1080）→ 节点局部坐标（画布中心为原点）。
 *
 * 存在的理由：`Graphics` 与 `Label` 都在**节点局部坐标**里画，而按钮/面板的布局
 * 用"左下角为原点"更直观（`core/hud.ts` 就是这么写的，`getUILocation()` 也是这个口径）。
 * 两套坐标直接混用会导致 HUD 画到屏幕外——**这个 bug 真的发生过**：
 * 丝位圆点与张力条一直用 UI 坐标当局部坐标用，于是被画到了 y=1035（屏幕外）上。
 */
export function uiToLocal(uiX: number, uiY: number): { x: number; y: number } {
  return { x: uiX - VIEW_W / 2, y: uiY - VIEW_H / 2 }
}

/** 长度换算：米 → 像素。 */
export function metersToPx(m: number): number {
  return m * PPM
}

/** 长度换算：像素 → 米。 */
export function pxToMeters(px: number): number {
  return px / PPM
}
