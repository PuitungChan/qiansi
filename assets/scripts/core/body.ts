/**
 * 《牵丝》确定性物理内核 —— 刚体与形状。
 *
 * M0 范围内刚体**没有自转**（无角速度、无转动惯量），形状只有圆与轴对齐矩形。
 * 理由见 DECISIONS D-025：核心机制（角动量守恒）发生在"物体绕主角旋转"的轨道层面，
 * 不是刚体自转；去掉自转后确定性更容易证明，也能在本机做完整回归。
 *
 * FR-PHY-014 要求系统记录每个刚体的质量/速度/动能/动量，供伤害计算与 UI 读取——
 * 这些量在每个 tick 末尾由 `refreshDerived()` 统一刷新，绝不允许各调用点自己算。
 *
 * 本文件不得引入任何引擎依赖。
 */

import type { Vec2 } from './vec2'
import {
  DEFAULT_FRICTION,
  DEFAULT_RESTITUTION,
  PLAYER_MASS_AIRBORNE,
} from './constants'

// ── 形状 ──────────────────────────────────────────────

export type ShapeKind = 'circle' | 'aabb'

export interface CircleShape {
  readonly kind: 'circle'
  readonly radius: number
}

export interface AabbShape {
  readonly kind: 'aabb'
  /** 半宽 */
  readonly hw: number
  /** 半高 */
  readonly hh: number
}

export type Shape = CircleShape | AabbShape

export function circle(radius: number): CircleShape {
  return { kind: 'circle', radius }
}

export function aabb(hw: number, hh: number): AabbShape {
  return { kind: 'aabb', hw, hh }
}

// ── 标签 ──────────────────────────────────────────────

/** 刚体的语义分类。内核用它做规则判定，渲染层用它选颜色。 */
export type BodyTag = 'player' | 'static' | 'prop' | 'enemy' | 'hazard'

/** 动/静。静态刚体 invMass = 0，永不移动。 */
export type BodyKind = 'static' | 'dynamic'

/** 敌人弱点 = 物理量分类。设计 §4.1 / FR-CBT-001。 */
export type Weakness =
  /** 任意物理量都吃（墨卒）。 */
  | 'any'
  /** 只吃动量 mv 即冲击伤害（墨甲）。 */
  | 'impact'
  /** 只吃动能 v² 即切割伤害（墨刃）。 */
  | 'cut'
  /** 只吃反向张力差（墨缚，R3）。 */
  | 'tear'
  /** 只吃承重点（墨巢）。 */
  | 'structure'

// ── 刚体 ──────────────────────────────────────────────

export interface Body {
  /** 稳定索引。在 world 的 bodies 数组里 = 下标，且**永不重排**——求解器据此保证确定性。 */
  readonly id: number
  readonly name: string
  readonly kind: BodyKind
  readonly tag: BodyTag
  readonly shape: Shape

  pos: Vec2
  vel: Vec2

  /** 当前质量。主角会随着地/离地在 0.5 与 1e6 之间切换（D-019）。 */
  mass: number
  /** 当前质量倒数。静态刚体为 0。 */
  invMass: number

  /**
   * **设计口径的固有质量**，永不随"着地/离地"变化（主角恒为 0.5）。
   *
   * 为什么必须有这个字段：主角着地时 `mass` 是 1e6（为了实现"等效质量 ∞"），
   * 但伤害公式里的 `m_eff = min(m_att, m_tgt)` 用的必须是**设计质量**。
   * 若拿 1e6 去算，主角走路撞一下墨甲就是 `min(1e6, 20) × v / 4 = 5v ≈ 30`，
   * 直接一次击杀——与设计「主角质量 0.5，玩家不产生力量」正面冲突。
   */
  readonly damageMass: number

  restitution: number
  friction: number

  /** 上一 tick 末尾判定出的着地状态。质量切换依据它，避免同一 tick 内质量跳变。 */
  grounded: boolean

  /** 是否可被丝线附着（FR-PHY-013）。无相本体需"墨丝"心法，R1 不涉及。 */
  anchorable: boolean

  /**
   * **脱离豁免**：暂时不与主角发生碰撞，直到两者彻底分开为止。
   *
   * 为什么需要：丝线被收短时，被牵物体会**进到主角身体内部**——实测摆动中石块到主角
   * 中心最近只有 `0.129 m`，而主角半宽 0.4 / 半高 0.8。断丝的瞬间如果立刻恢复碰撞，
   * 求解器会把这个"嵌在身体里"的物体猛地推出去，**主角被一起撞飞**（第 3 轮实机反馈 #4）。
   *
   * 规则很简单也很物理：**已经在你身体里的东西，不该再"撞"你一次。**
   * 每 tick 检查，一旦两者分开就自动撤销豁免，恢复正常碰撞。
   */
  ignorePlayer: boolean

  /**
   * 死亡时**碎裂消失**（陶罐、木栅这类易碎场景物），而不是像敌人那样留在场上。
   * 为 true 时，血量归零会把 `removed` 置为 true —— 从碰撞与渲染中一起移除。
   */
  shattersOnDeath: boolean

  /**
   * 已被移出世界（碎裂、消散）。`detectContacts` 与渲染层都会跳过它。
   * 用布尔标记而不是从 `bodies` 数组里删元素 —— **数组下标就是刚体 id**，
   * 一删就会让 id 错位，确定性直接崩掉。
   */
  removed: boolean

  /** ── 以下为每 tick 由 refreshDerived() 刷新的派生量（FR-PHY-014）── */
  /** 动量 p = m·v */
  momentum: Vec2
  /** 动能 KE = ½·m·|v|² */
  kineticEnergy: number

  /** ── 战斗属性（M0 只有墨甲用得上）── */
  hp: number
  maxHp: number
  weakness: Weakness
  alive: boolean
}

export interface BodyInit {
  id: number
  name: string
  kind: BodyKind
  tag: BodyTag
  shape: Shape
  pos: Vec2
  vel?: Vec2
  mass?: number
  restitution?: number
  friction?: number
  anchorable?: boolean
  hp?: number
  weakness?: Weakness
  /** 死亡时碎裂消失（陶罐等易碎场景物）。见 `shattersOnDeath`。 */
  shattersOnDeath?: boolean
}

export function createBody(init: BodyInit): Body {
  const isStatic = init.kind === 'static'
  const mass = isStatic ? 0 : (init.mass ?? 1)
  const hp = init.hp ?? 0
  return {
    id: init.id,
    name: init.name,
    kind: init.kind,
    tag: init.tag,
    shape: init.shape,
    pos: init.pos,
    vel: init.vel ?? { x: 0, y: 0 },
    mass,
    invMass: isStatic || mass === 0 ? 0 : 1 / mass,
    damageMass: mass,
    restitution: init.restitution ?? DEFAULT_RESTITUTION,
    friction: init.friction ?? DEFAULT_FRICTION,
    grounded: false,
    anchorable: init.anchorable ?? false,
    ignorePlayer: false,
    shattersOnDeath: init.shattersOnDeath ?? false,
    removed: false,
    momentum: { x: 0, y: 0 },
    kineticEnergy: 0,
    hp,
    maxHp: hp,
    weakness: init.weakness ?? 'any',
    alive: true,
  }
}

/**
 * 刷新派生量。每个 tick 末尾对每具刚体调用一次，顺序 = 数组顺序。
 * FR-PHY-014：质量 / 速度 / 动能 / 动量。
 */
export function refreshDerived(b: Body): void {
  if (b.kind === 'static') {
    b.momentum = { x: 0, y: 0 }
    b.kineticEnergy = 0
    return
  }
  b.momentum = { x: b.mass * b.vel.x, y: b.mass * b.vel.y }
  b.kineticEnergy = 0.5 * b.mass * (b.vel.x * b.vel.x + b.vel.y * b.vel.y)
}

/** 动能（J）。供伤害预读与调试面板读取。 */
export function speed(b: Body): number {
  return Math.sqrt(b.vel.x * b.vel.x + b.vel.y * b.vel.y)
}

/** 改变质量并同步 invMass。主角着地/离地切换用。 */
export function setMass(b: Body, mass: number): void {
  if (b.kind === 'static') return
  if (mass === b.mass) return
  b.mass = mass
  b.invMass = mass === 0 ? 0 : 1 / mass
}

/** 主角离地质量（FR-PHY-003）。 */
export function restoreAirborneMass(b: Body): void {
  setMass(b, PLAYER_MASS_AIRBORNE)
}

// ── 形状查询 ──────────────────────────────────────────

export interface Bounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/** 轴对齐包围盒。用于宽相位与渲染。 */
export function boundsOf(b: Body): Bounds {
  const s = b.shape
  if (s.kind === 'circle') {
    return {
      minX: b.pos.x - s.radius,
      minY: b.pos.y - s.radius,
      maxX: b.pos.x + s.radius,
      maxY: b.pos.y + s.radius,
    }
  }
  return {
    minX: b.pos.x - s.hw,
    minY: b.pos.y - s.hh,
    maxX: b.pos.x + s.hw,
    maxY: b.pos.y + s.hh,
  }
}

/** 形状在给定方向上的支撑半径投影（用于圆-盒的最近点计算）。 */
export function halfExtents(s: Shape): { hw: number; hh: number } {
  if (s.kind === 'circle') return { hw: s.radius, hh: s.radius }
  return { hw: s.hw, hh: s.hh }
}
