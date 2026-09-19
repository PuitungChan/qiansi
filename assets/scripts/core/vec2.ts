/**
 * 《牵丝》确定性物理内核 —— 二维向量。
 *
 * 全部为纯函数、不可变语义（返回新对象）。这是刻意的：
 * 内核要在 3 台设备 + 服务端产出**逐位一致**的结果（AC-05 / FR-PHY-008），
 * 因此不允许出现任何依赖调用顺序、对象身份或哈希遍历顺序的实现方式。
 * 数值一律使用 IEEE-754 double（JS number），其四则运算在任意合规实现上结果一致。
 *
 * 本文件**不得**引入任何引擎（Cocos / cc）依赖——见 DECISIONS D-017。
 */

export interface Vec2 {
  readonly x: number
  readonly y: number
}

export function v2(x: number, y: number): Vec2 {
  return { x, y }
}

export const ZERO: Vec2 = { x: 0, y: 0 }

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s }
}

export function neg(a: Vec2): Vec2 {
  return { x: -a.x, y: -a.y }
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
}

/** 二维叉积的标量结果 z 分量：`a × b = ax·by − ay·bx`。 */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x
}

export function lenSq(a: Vec2): number {
  return a.x * a.x + a.y * a.y
}

export function len(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y)
}

export function distSq(a: Vec2, b: Vec2): number {
  return lenSq(sub(a, b))
}

export function dist(a: Vec2, b: Vec2): number {
  return len(sub(a, b))
}

/** 归一化。零向量返回零向量（不产生 NaN——NaN 会污染整个确定性哈希）。 */
export function norm(a: Vec2): Vec2 {
  const l = len(a)
  if (l === 0) return ZERO
  return { x: a.x / l, y: a.y / l }
}

/** 逆时针旋转 90°：(x, y) → (−y, x)。 */
export function perp(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x }
}

export function rot(a: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** 限长（若长度超过 max，则按比例缩到 max）。 */
export function clampLen(a: Vec2, max: number): Vec2 {
  const l = len(a)
  if (l <= max || l === 0) return a
  const k = max / l
  return { x: a.x * k, y: a.y * k }
}

export function equals(a: Vec2, b: Vec2, eps = 0): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps
}

export function clone(a: Vec2): Vec2 {
  return { x: a.x, y: a.y }
}
