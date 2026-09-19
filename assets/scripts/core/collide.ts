/**
 * 《牵丝》确定性物理内核 —— 碰撞检测（窄相位）。
 *
 * 只有三种组合：圆-圆、圆-盒、盒-盒。全部输出**轴对齐**接触。
 * 法线方向约定：`normal` 始终由 `a` **指向** `b`。
 *
 * 确定性要点：接触对的枚举顺序由 `world.ts` 用固定双重循环保证（i < j），
 * 本文件不产生任何依赖哈希/迭代顺序的行为，也不使用随机数（FR-PHY-008）。
 *
 * 本文件不得引入任何引擎依赖。
 */

import type { Body } from './body'
import { type Vec2, dot, len, norm, sub } from './vec2'

export interface Contact {
  /** 接触对中的第一具刚体。 */
  readonly a: Body
  /** 接触对中的第二具刚体。 */
  readonly b: Body
  /** 由 a 指向 b 的单位法线。 */
  readonly normal: Vec2
  /** 穿透深度（> 0）。 */
  readonly penetration: number
  /**
   * 求解**前**的相对法向速度 `dot(vb − va, n)`。
   * 负值 = 正在接近。伤害判定用的 `v_rel` 就取自这里（见 damage.ts）。
   */
  readonly preSolveNormalVelocity: number
  /** 接近速度（m/s，取正值）。供伤害判定、撞击反馈与音效使用。 */
  readonly approachSpeed: number
}

interface RawManifold {
  /** 由 a 指向 b 的单位法线。 */
  normal: Vec2
  penetration: number
}

function manifoldCircleCircle(a: Body, b: Body): RawManifold | null {
  const ra = a.shape.kind === 'circle' ? a.shape.radius : 0
  const rb = b.shape.kind === 'circle' ? b.shape.radius : 0
  const d = sub(b.pos, a.pos)
  const r = ra + rb
  const l = len(d)
  if (l >= r) return null
  // 完全重合时给一个固定法线，避免 0/0 产生 NaN 污染确定性哈希。
  const n = l === 0 ? { x: 0, y: 1 } : { x: d.x / l, y: d.y / l }
  return { normal: n, penetration: r - l }
}

function manifoldCircleAabb(circleBody: Body, boxBody: Body): RawManifold {
  const r = circleBody.shape.kind === 'circle' ? circleBody.shape.radius : 0
  const hw = boxBody.shape.kind === 'aabb' ? boxBody.shape.hw : 0
  const hh = boxBody.shape.kind === 'aabb' ? boxBody.shape.hh : 0
  const c = circleBody.pos
  const bx = boxBody.pos.x
  const by = boxBody.pos.y

  const closestX = Math.min(Math.max(c.x, bx - hw), bx + hw)
  const closestY = Math.min(Math.max(c.y, by - hh), by + hh)
  const dx = closestX - c.x
  const dy = closestY - c.y
  const l = Math.sqrt(dx * dx + dy * dy)

  if (l > r) return { normal: { x: 0, y: 0 }, penetration: -1 }

  if (l > 1e-9) {
    // 圆心在盒外：法线由圆心指向最近点，即"由圆指向盒"。
    return {
      normal: { x: dx / l, y: dy / l },
      penetration: r - l,
    }
  }

  // 圆心落在盒内部：沿最小穿透轴推出。
  const overlapX = hw - Math.abs(c.x - bx)
  const overlapY = hh - Math.abs(c.y - by)
  if (overlapX < overlapY) {
    const s = c.x < bx ? -1 : 1
    return { normal: { x: s, y: 0 }, penetration: r + overlapX }
  }
  const s = c.y < by ? -1 : 1
  return { normal: { x: 0, y: s }, penetration: r + overlapY }
}

function manifoldAabbAabb(a: Body, b: Body): RawManifold | null {
  const ahw = a.shape.kind === 'aabb' ? a.shape.hw : 0
  const ahh = a.shape.kind === 'aabb' ? a.shape.hh : 0
  const bhw = b.shape.kind === 'aabb' ? b.shape.hw : 0
  const bhh = b.shape.kind === 'aabb' ? b.shape.hh : 0

  const dx = b.pos.x - a.pos.x
  const dy = b.pos.y - a.pos.y
  const overlapX = ahw + bhw - Math.abs(dx)
  const overlapY = ahh + bhh - Math.abs(dy)
  if (overlapX <= 0 || overlapY <= 0) return null

  if (overlapX < overlapY) {
    return { normal: { x: dx < 0 ? -1 : 1, y: 0 }, penetration: overlapX }
  }
  return { normal: { x: 0, y: dy < 0 ? -1 : 1 }, penetration: overlapY }
}

/**
 * 检测一对待测刚体。返回的 `normal` 一律由 `a` 指向 `b`。
 * 两个静态刚体直接跳过（它们永远不会互相作用）。
 */
export function collide(a: Body, b: Body): Contact | null {
  if (a.kind === 'static' && b.kind === 'static') return null

  const sa = a.shape.kind
  const sb = b.shape.kind

  let m: RawManifold | null = null
  let swap = false

  if (sa === 'circle' && sb === 'circle') {
    m = manifoldCircleCircle(a, b)
  } else if (sa === 'circle' && sb === 'aabb') {
    m = manifoldCircleAabb(a, b)
  } else if (sa === 'aabb' && sb === 'circle') {
    m = manifoldCircleAabb(b, a)
    swap = true
  } else {
    m = manifoldAabbAabb(a, b)
  }

  if (m === null || m.penetration <= 0) return null

  // 若上面是以 (b, a) 的顺序算的，法线需要取反才能恢复 "a → b" 的约定。
  const normal = swap ? { x: -m.normal.x, y: -m.normal.y } : m.normal
  const rel = sub(b.vel, a.vel)
  const vn = dot(rel, normal)

  return {
    a,
    b,
    normal,
    penetration: m.penetration,
    preSolveNormalVelocity: vn,
    approachSpeed: vn < 0 ? -vn : 0,
  }
}

/** 便捷：判断两个包围盒是否可能相交（宽相位）。 */
export function boundsOverlap(a: Body, b: Body): boolean {
  const sa = a.shape
  const sb = b.shape
  const ahw = sa.kind === 'circle' ? sa.radius : sa.hw
  const ahh = sa.kind === 'circle' ? sa.radius : sa.hh
  const bhw = sb.kind === 'circle' ? sb.radius : sb.hw
  const bhh = sb.kind === 'circle' ? sb.radius : sb.hh
  return (
    Math.abs(b.pos.x - a.pos.x) < ahw + bhw &&
    Math.abs(b.pos.y - a.pos.y) < ahh + bhh
  )
}

/**
 * 刚体表面上离 `p` 最近的点（`p` 在形状内部时返回 `p` 本身）。
 *
 * 第 13 轮起，这个函数同时承担**丝线附着点**的计算，语义正好就是创始人要的那句话：
 * 「**松手的位置即是丝线附着的位置**」——
 *   · 松手点在物体上（轮廓内或轮廓上）⇒ 锚点就是你松手的那一点，不做任何吸附；
 *   · 松手点在轮廓外一点点（`ROPE_AIM_TOLERANCE` 之内）⇒ 吸附到最近的表面点，容错用。
 *
 * ⚠️ 这里曾经考虑过"内部也推到边界"，实测**否决**：石块的锚点从中心挪到表面差 0.5m，
 * 有效绳长变短，甩速从 ≥15 掉到 **14.98 m/s**，正好跌破设计附录 A 的投石量级。
 * 而"瞄石块边缘就挂在边缘"这个诉求，本函数**已经满足**（边缘在轮廓上 ⇒ 原样使用）。
 * 见 D-048 的修订与 D-052。
 *
 * 历史理由（D-048）保留：大物体上按中心取锚点是致命的——16 米宽的横梁若锚点取中心，
 * 玩家站在梁左端下方连上去时绳长会瞬间变成 16.8m（上限 12m），一连接就被猛拽。
 */
export function closestPointOnShape(p: Vec2, b: Body): Vec2 {
  const s = b.shape
  if (s.kind === 'circle') {
    const dx = p.x - b.pos.x
    const dy = p.y - b.pos.y
    const l = Math.sqrt(dx * dx + dy * dy)
    if (l <= s.radius || l < 1e-9) return { x: p.x, y: p.y }
    const k = s.radius / l
    return { x: b.pos.x + dx * k, y: b.pos.y + dy * k }
  }
  return {
    x: Math.min(Math.max(p.x, b.pos.x - s.hw), b.pos.x + s.hw),
    y: Math.min(Math.max(p.y, b.pos.y - s.hh), b.pos.y + s.hh),
  }
}

/** `p` 到刚体表面的距离（在内部时为 0）。 */
export function distanceToShape(p: Vec2, b: Body): number {
  const c = closestPointOnShape(p, b)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** 调试用：把法线格式化。 */
export function formatNormal(n: Vec2): string {
  const u = norm(n)
  return `(${u.x.toFixed(3)}, ${u.y.toFixed(3)})`
}
