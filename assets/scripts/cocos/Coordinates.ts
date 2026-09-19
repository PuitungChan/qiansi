/**
 * 《牵丝》—— 世界坐标 ↔ 屏幕坐标。
 *
 * 约定（DECISIONS D-018）：
 *   - 房间左下角为世界原点 (0, 0)，Y 轴向上，1 单位 = 1 米
 *   - 渲染比例 60 px/m，房间 32m × 18m ⇒ 正好铺满 1920×1080 的逻辑分辨率
 *   - 因此 `屏幕像素 = 世界坐标 × 60`，且房间恰好铺满画布（单屏房间制 FR-LVL-004）
 *
 * 这个文件同时被渲染层和输入层使用，是全工程**唯一**允许把米换算成像素的地方。
 * 任何别处出现 `* 60` 都是缺陷。
 *
 * 本文件不导入 `cc`——它是纯数学，可以被本机测试覆盖。
 */

import { PPM, VIEW_H, VIEW_W } from '../core/constants'
import type { Vec2 } from '../core/vec2'

/** 世界坐标 → 屏幕像素（原点在房间左下角，Y 向上）。 */
export function worldToScreen(p: Vec2): { x: number; y: number } {
  return { x: p.x * PPM, y: p.y * PPM }
}

/** 屏幕像素 → 世界坐标（原点在房间左下角）。 */
export function screenToWorld(x: number, y: number): Vec2 {
  return { x: x / PPM, y: y / PPM }
}

/** 世界坐标 → 以画布中心为原点的节点局部坐标（Cocos Canvas 的坐标系）。 */
export function worldToLocal(p: Vec2): { x: number; y: number } {
  return { x: p.x * PPM - VIEW_W / 2, y: p.y * PPM - VIEW_H / 2 }
}

/** Cocos 的 UI 坐标（左下角为原点）→ 世界坐标。 */
export function uiToWorld(uiX: number, uiY: number): Vec2 {
  return screenToWorld(uiX, uiY)
}

/** 长度换算：米 → 像素。 */
export function metersToPx(m: number): number {
  return m * PPM
}

/** 长度换算：像素 → 米。 */
export function pxToMeters(px: number): number {
  return px / PPM
}
