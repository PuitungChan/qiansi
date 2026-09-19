/**
 * 《牵丝》确定性物理内核 —— 丝线（张力模型 + Verlet 绳索）。
 *
 * ## 力的传递：轴向弹簧-阻尼（这是"张力"的定义）
 *
 * 设计文档给的是**张力值** `T ∈ [0, 400]`，但没有给"伸长量 → 张力"的换算。
 * 本文件采用最直接、可标定的模型（DECISIONS D-021）：
 *
 * ```
 *   ΔL = 当前长度 − 目标丝长
 *   ΔL ≤ 0  ⇒  T = 0                      （松弛不传力，铁律 1 / FR-PHY-001）
 *   ΔL > 0  ⇒  T = k·ΔL + c·v_axial        （c = 2ζ√(k·m_reduced)）
 * ```
 *
 * 张力单位是**牛顿**。`T_max = 400 N` 恰好等于墨甲（质量 20）的重力 `20 × 20 = 400 N`——
 * 即素丝吊不起墨甲、韧丝（700 N）可以。这个自洽是选牛顿制的直接证据，见 D-021。
 *
 * ## 绳索本体：Verlet 积分（FR-PHY-010）
 *
 * 渲染用的绳索是一条 10 段的 Verlet 链（端点硬约束在两具刚体的锚点上），
 * 负责松弛下垂、绷紧拉直、以及后续"缠绕"需求的空间形态。
 *
 * ⚠️ M0 的**力**由上面那条轴向弹簧-阻尼承担，Verlet 链是**纯表现**、不反作用于刚体。
 * 这么做是刻意的工程取舍：串联弹簧链的等效刚度是 `k/N`，在 PBD 下会引入
 * "力沿绳传播有延迟"的软绵绵手感，而 M0 要验证的恰恰是"甩出去那一下爽不爽"。
 * 等到需要"丝绕过柱子"（R2+）时再把链提升为受力路径——接口已经预留。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { ROPE_SEGMENTS, ROPE_LEN_MIN, ROPE_LEN_MAX } from './constants'
import { type Vec2, dist, sub } from './vec2'

// ── 丝位状态 ──────────────────────────────────────────

export type RopeState =
  /** 空闲：可以附着。 */
  | 'idle'
  /**
   * 飞行中：丝已经从主角射出去，**还没到位**（第 13 轮反馈新增）。
   * 这一段时间里它**不传递任何力**，只是视觉上从主角射向目标。
   */
  | 'flying'
  /** 已附着：正在传递张力。 */
  | 'attached'
  /** 重凝中：断开后的 1.5s 冷却，不可附着（FR-PHY-007）。 */
  | 'recovering'

export interface Rope {
  /** 稳定索引（0..MAX_ROPE-1），同时充当 HUD 上的丝线圆点顺序（FR-UI-001）。 */
  readonly index: number
  state: RopeState
  /** 被附着（或正飞向）的刚体 id；`-1` = 无目标。 */
  targetId: number
  /**
   * **附着点在目标上的局部偏移**（米，相对目标中心）。
   *
   * 第 13 轮反馈：「现在丝线无论发射到物体的哪个位置，最终呈现出来都是附着在了物体的中间，
   * 我觉得这个不太好，有时候我可能想把丝线射到横梁的边上。」
   *
   * 所以锚点不再是"离主角最近的表面点"（那正是 D-048 的做法，它会随主角移动而**滑动**），
   * 而是**发射那一刻锁定的那一点**，之后跟着目标刚体一起走。
   * 副作用是好的：横梁不再是一根"可以吊着人横向滑动的轨道"（见 D-049 的漏洞）。
   */
  anchorOffset: Vec2
  /** 飞行中的**丝头**世界坐标（表现层画这条线用）。 */
  flyTip: Vec2
  /** 飞行起点（主角出丝点），表现层用。 */
  flyFrom: Vec2
  /** 玩家控制的目标丝长（米）。收/放丝改的就是它。 */
  targetLength: number
  /** 当前实际长度（诊断 + 表现用）。 */
  length: number
  /** 当前张力（牛顿）。 */
  tension: number
  /** 重凝剩余时间（秒）。 */
  recongealRemaining: number
  /** 本丝位本次附着以来出现过的最大张力，供埋点与"濒断"体验复盘。 */
  peakTension: number
  /** 导致上一次断开的原因，调试面板用。 */
  lastBreakReason: 'none' | 'cut' | 'over-tension'
}

export function createRope(index: number): Rope {
  return {
    index,
    state: 'idle',
    targetId: -1,
    anchorOffset: { x: 0, y: 0 },
    flyTip: { x: 0, y: 0 },
    flyFrom: { x: 0, y: 0 },
    targetLength: 0,
    length: 0,
    tension: 0,
    recongealRemaining: 0,
    peakTension: 0,
    lastBreakReason: 'none',
  }
}

// ── 张力 ──────────────────────────────────────────────

export interface TensionInput {
  /** 当前两端实际距离（米）。 */
  readonly length: number
  /** 玩家控制的目标丝长（米）。 */
  readonly targetLength: number
  /**
   * 轴向相对速度（m/s）：`dot(v_target − v_player, n)`。
   * 正值 = 两端正在互相远离，阻尼项因此**增加**张力（抑制进一步拉伸）。
   */
  readonly axialVelocity: number
  /** 等效质量 `1 / (invMassA + invMassB)`。分母为 0（双方都是静态）时传 Infinity。 */
  readonly reducedMass: number
  readonly stiffness: number
  readonly dampingRatio: number
}

/**
 * 计算张力（牛顿）。松弛时恒为 0 —— 这是 FR-PHY-001「丝只能拉不能推」的实现点。
 */
export function ropeTension(input: TensionInput): number {
  const extension = input.length - input.targetLength
  if (!(extension > 0)) return 0

  const k = input.stiffness
  let c = 0
  if (Number.isFinite(input.reducedMass) && input.reducedMass > 0) {
    c = 2 * input.dampingRatio * Math.sqrt(k * input.reducedMass)
  }

  let t = k * extension + c * input.axialVelocity
  if (!(t > 0)) t = 0
  return t
}

/** 等效质量。两端都可动时用标准公式；有静态端时退化为可动端的质量。 */
export function reducedMass(invMassA: number, invMassB: number): number {
  const s = invMassA + invMassB
  if (s <= 0) return Number.POSITIVE_INFINITY
  return 1 / s
}

/** 收放丝：把目标丝长夹到 [ROPE_LEN_MIN, ROPE_LEN_MAX]。 */
export function clampRopeLength(v: number): number {
  if (!Number.isFinite(v)) return ROPE_LEN_MIN
  if (v < ROPE_LEN_MIN) return ROPE_LEN_MIN
  if (v > ROPE_LEN_MAX) return ROPE_LEN_MAX
  return v
}

// ── Verlet 绳索（表现层用，8–12 段）────────────────────

export interface VerletChain {
  /** 粒子数 = 段数 + 1。 */
  readonly count: number
  readonly segments: number
  readonly px: Float64Array
  readonly py: Float64Array
  readonly ox: Float64Array
  readonly oy: Float64Array
}

/** 创建一条从 a 到 b 均匀铺开的链。 */
export function createVerletChain(a: Vec2, b: Vec2, segments = ROPE_SEGMENTS): VerletChain {
  const count = segments + 1
  const px = new Float64Array(count)
  const py = new Float64Array(count)
  const ox = new Float64Array(count)
  const oy = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const t = i / segments
    const x = a.x + (b.x - a.x) * t
    const y = a.y + (b.y - a.y) * t
    px[i] = x
    py[i] = y
    ox[i] = x
    oy[i] = y
  }
  return { count, segments, px, py, ox, oy }
}

export interface VerletStepOptions {
  /** 两端锚点（世界坐标，通常是主角与被附着物）。 */
  readonly a: Vec2
  readonly b: Vec2
  /** 目标丝长（米）；链的静止总长就是它。 */
  readonly restLength: number
  /** 重力（m/s²）。 */
  readonly gravityY: number
  readonly dt: number
  /** 速度阻尼（每步乘数），< 1 才有衰减。 */
  readonly damping?: number
  /** 距离约束迭代次数。 */
  readonly iterations?: number
}

/**
 * 推进一步 Verlet 链。**不反作用于刚体**（见文件头说明）。
 * 端点被硬约束到 a / b，中间粒子按 `restLength / segments` 均分。
 * 确定性：固定迭代次数、固定遍历顺序、无随机。
 */
export function stepVerletChain(chain: VerletChain, o: VerletStepOptions): void {
  const { px, py, ox, oy, count, segments } = chain
  const damping = o.damping ?? 0.98
  const iterations = o.iterations ?? 6
  const g = o.gravityY * o.dt * o.dt

  // 1) Verlet 位置积分
  for (let i = 0; i < count; i++) {
    const vx = (px[i] - ox[i]) * damping
    const vy = (py[i] - oy[i]) * damping
    ox[i] = px[i]
    oy[i] = py[i]
    px[i] += vx
    py[i] += vy + g
  }

  const rest = o.restLength / segments

  // 2) 约束求解：端点钉死 + 每段等长
  for (let iter = 0; iter < iterations; iter++) {
    px[0] = o.a.x
    py[0] = o.a.y
    px[count - 1] = o.b.x
    py[count - 1] = o.b.y

    for (let i = 0; i < segments; i++) {
      const dx = px[i + 1] - px[i]
      const dy = py[i + 1] - py[i]
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < 1e-9) continue
      const diff = (d - rest) / d
      const cx = dx * diff * 0.5
      const cy = dy * diff * 0.5
      // 端点不参与移动（由硬约束固定）
      if (i !== 0) {
        px[i] += cx
        py[i] += cy
      }
      if (i + 1 !== count - 1) {
        px[i + 1] -= cx
        py[i + 1] -= cy
      }
    }

    px[0] = o.a.x
    py[0] = o.a.y
    px[count - 1] = o.b.x
    py[count - 1] = o.b.y
  }
}

/** 采样链条为点列，供渲染层绘制。 */
export function chainPoints(chain: VerletChain): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < chain.count; i++) out.push({ x: chain.px[i], y: chain.py[i] })
  return out
}

/** 重新铺链（换目标或重新附着时调用）。 */
export function resetChain(chain: VerletChain, a: Vec2, b: Vec2): void {
  const segments = chain.segments
  for (let i = 0; i < chain.count; i++) {
    const t = i / segments
    const x = a.x + (b.x - a.x) * t
    const y = a.y + (b.y - a.y) * t
    chain.px[i] = x
    chain.py[i] = y
    chain.ox[i] = x
    chain.oy[i] = y
  }
}

/**
 * 点到线段的距离 —— 断丝命中判定用（FR-ACT-009：半径 ≥ 22 逻辑像素）。
 * 纯函数，可单测。
 */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = p.x - a.x
  const apy = p.y - a.y
  const denom = abx * abx + aby * aby
  if (denom < 1e-12) return dist(p, a)
  let t = (apx * abx + apy * aby) / denom
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const cx = a.x + abx * t
  const cy = a.y + aby * t
  const dx = p.x - cx
  const dy = p.y - cy
  return Math.sqrt(dx * dx + dy * dy)
}

/** 两根丝之间的张力差（撕裂判定，FR-CBT-004 / R3 预留）。 */
export function tensionDifference(r1: Rope, r2: Rope): number {
  return Math.abs(r1.tension - r2.tension)
}

/** 轴向方向：由 A 指向 B 的单位向量。 */
export function ropeAxis(a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a)
  const l = Math.sqrt(d.x * d.x + d.y * d.y)
  if (l < 1e-9) return { x: 0, y: 1 }
  return { x: d.x / l, y: d.y / l }
}
