/**
 * 《牵丝》确定性物理内核 —— 世界与步进。
 *
 * ## 单个 tick 的固定顺序（这个顺序就是确定性契约的一部分）
 *
 * ```
 *  1. tick++，推进硬直/重凝计时器
 *  2. 主角移动控制（着地/离地两套；硬直期间不响应）
 *  3. 丝线指令：断 → 牵 → 收/放（先断后牵，保证同帧"断一根牵一根"的语义）
 *  4. 施力：重力 + 丝线弹簧-阻尼（张力在这里算出，并夹上限）
 *  5. 积分速度  v += (F/m)·dt
 *  6. 积分位置  x += v·dt
 *  7. 丝线刚性约束：张力到顶时把两端钉在"目标丝长 + 弹性余量"上（D-032）
 *  8. 碰撞检测（固定双重循环 i<j，接触对顺序恒定）
 *  9. 撞击事件 + 伤害结算（用求解前的接近速度）
 * 10. 顺序冲量求解（固定迭代次数）+ 位置修正
 * 11. 着地状态更新 → 决定下一 tick 的主角质量
 * 12. 脱离豁免更新（与主角分开后恢复碰撞，D-033）
 * 13. 刷新派生量（动量/动能，FR-PHY-014）
 * 14. 推进 Verlet 绳索（纯表现）
 * ```
 *
 * ⚠️ **超限断弦已取消**（D-032）：张力到顶不再断丝，而是变成刚性约束。
 * 详见 `solveRopeConstraints()` 与常量里的 ROPE_MAX_STRETCH。
 *
 * 没有随机数、没有哈希表遍历、没有依赖 wall-clock 的分支。
 * 同样的输入帧序列 ⇒ 同样的 `stateHash()`（FR-PHY-008 / AC-05）。
 *
 * 本文件不得引入任何引擎依赖。
 */

import {
  type Body,
  type BodyInit,
  type BodyTag,
  createBody,
  refreshDerived,
  setMass,
} from './body'
import { type Contact, boundsOverlap, collide } from './collide'
import * as C from './constants'
import { type DamageResult, resolveImpactAgainst } from './damage'
import type { SimEvent } from './events'
import { hashFloat64Wide } from './hash'
import { type InputFrame, sanitizeMoveX } from './input'
import {
  type Rope,
  type VerletChain,
  clampRopeLength,
  createRope,
  createVerletChain,
  distanceToSegment,
  reducedMass,
  resetChain,
  ropeTension,
  stepVerletChain,
} from './rope'
import { type Vec2, dist, len, sub } from './vec2'

// ── 配置 ──────────────────────────────────────────────

export interface WorldConfig {
  gravityY: number
  /**
   * 张力**上限**（牛顿）。素丝 1200 / 韧丝 2100。
   *
   * ⚠️ 这不是"断裂阈值"（D-032）：到达上限时丝线**不断裂**，而是变成刚性约束。
   * 显示刻度 0–400 与之无关，只用于 UI 百分比（见 `TENSION_DISPLAY_MAX_BASE`）。
   */
  tensionMax: number
  /** 收丝速度上限 8（素丝）/ 14（疾丝）（FR-PHY-002）。 */
  reelSpeed: number
  moveSpeed: number
  airControlSpeed: number
  groundAccel: number
  airAccel: number
  stiffness: number
  dampingRatio: number
  /** 丝位数量。序章 1 根，上限 4（FR-PHY-010）。 */
  ropeCount: number
  attachTolerance: number
  ropeHitRadius: number
  solverIterations: number
}

export const DEFAULT_CONFIG: WorldConfig = {
  gravityY: C.GRAVITY_Y,
  tensionMax: C.TENSION_LIMIT_BASE,
  reelSpeed: C.ROPE_REEL_SPEED_BASE,
  moveSpeed: C.PLAYER_MOVE_SPEED,
  airControlSpeed: C.PLAYER_AIR_CONTROL_SPEED,
  groundAccel: C.PLAYER_GROUND_ACCEL,
  airAccel: C.PLAYER_AIR_ACCEL,
  stiffness: C.ROPE_STIFFNESS,
  dampingRatio: C.ROPE_DAMPING_RATIO,
  ropeCount: 1,
  attachTolerance: C.ROPE_ATTACH_TOLERANCE,
  ropeHitRadius: C.ROPE_HIT_RADIUS_M,
  solverIterations: C.SOLVER_ITERATIONS,
}

function clampAbs(v: number, limit: number): number {
  if (v > limit) return limit
  if (v < -limit) return -limit
  return v
}

// ── 世界 ──────────────────────────────────────────────

export class World {
  readonly config: WorldConfig
  readonly bodies: Body[] = []
  readonly ropes: Rope[] = []
  /** 每根丝位对应一条 Verlet 链（纯表现）。未附着时为 null。 */
  readonly chains: (VerletChain | null)[] = []
  /** 本 tick 产生的事件。每 tick 开头清空。 */
  readonly events: SimEvent[] = []

  tick = 0
  /** 超限断弦后的硬直剩余时间（FR-PHY-006）。 */
  stunRemaining = 0

  private fx: Float64Array
  private fy: Float64Array
  private cap: number
  private contacts: Contact[] = []
  private touching = new Set<number>()

  /** 主角的刚体 id。构造后由 `setPlayer()` 指定。 */
  private playerId = -1

  constructor(config: Partial<WorldConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.cap = 16
    this.fx = new Float64Array(this.cap)
    this.fy = new Float64Array(this.cap)
    for (let i = 0; i < this.config.ropeCount; i++) {
      this.ropes.push(createRope(i))
      this.chains.push(null)
    }
  }

  // ── 装配 ────────────────────────────────────────────

  addBody(init: Omit<BodyInit, 'id'> & { id?: number }): Body {
    const id = this.bodies.length
    if (init.id !== undefined && init.id !== id) {
      throw new Error(`刚体 id 必须等于其数组下标：期望 ${id}，收到 ${init.id}`)
    }
    const b = createBody({ ...init, id } as BodyInit)
    this.bodies.push(b)
    if (this.bodies.length > this.cap) {
      // 扩容只改数组长度，不改顺序 ⇒ 不影响确定性。
      this.cap = Math.max(16, this.bodies.length * 2)
      this.fx = new Float64Array(this.cap)
      this.fy = new Float64Array(this.cap)
    }
    return b
  }

  setPlayer(b: Body): void {
    this.playerId = b.id
  }

  get player(): Body {
    const p = this.bodies[this.playerId]
    if (p === undefined) throw new Error('World.setPlayer() 尚未调用')
    return p
  }

  bodyById(id: number): Body | null {
    const b = this.bodies[id]
    return b === undefined ? null : b
  }

  /** 找到指定标签的第一个刚体，测试与场景装配用。 */
  findByTag(tag: BodyTag): Body[] {
    const out: Body[] = []
    for (const b of this.bodies) if (b.tag === tag) out.push(b)
    return out
  }

  /** 空跑 n 个 tick，让场景静置（例如让主角落稳再进入可玩状态）。 */
  settle(n: number): void {
    const idle: InputFrame = {
      moveX: 0,
      aimPoint: null,
      attachPressed: false,
      reel: 'hold',
      cutRope: -1,
      focus: false,
    }
    for (let i = 0; i < n; i++) this.step(idle)
  }

  // ── 主步进 ──────────────────────────────────────────

  step(input: InputFrame): void {
    this.events.length = 0
    this.tick++

    this.tickTimers()
    const p = this.player
    this.applyPlayerControl(input, p)
    this.applyRopeCommands(input, p)
    this.applyForces(p)
    this.integrateVelocities()
    this.integratePositions()
    // 丝线的刚性约束：张力到顶时把两端钉在"目标丝长 + 弹性余量"上（D-032）。
    // 放在位置积分之后、碰撞之前 —— 它和碰撞一样是**位置层**的约束。
    this.solveRopeConstraints()
    this.detectContacts()
    this.emitContacts()
    this.solveVelocities()
    this.correctPositions()
    this.updateGrounded()
    this.updateIgnoreFlags()
    for (const b of this.bodies) refreshDerived(b)
    this.stepChains(p)
  }

  // ── 1. 计时器 ───────────────────────────────────────

  private tickTimers(): void {
    if (this.stunRemaining > 0) {
      this.stunRemaining -= C.DT
      if (this.stunRemaining < 0) this.stunRemaining = 0
    }
    for (const r of this.ropes) {
      if (r.state !== 'recovering') continue
      r.recongealRemaining -= C.DT
      if (r.recongealRemaining <= 0) {
        r.recongealRemaining = 0
        r.state = 'idle'
        this.events.push({ kind: 'rope-recovered', rope: r.index })
      }
    }
  }

  // ── 2. 主角移动控制 ─────────────────────────────────

  private applyPlayerControl(input: InputFrame, p: Body): void {
    if (this.stunRemaining > 0) return

    const mx = sanitizeMoveX(input.moveX)

    if (p.grounded) {
      // 着地：目标速度控制。这是"着地是锚点"的实现点——丝线拉不动主角（D-019/D-020）。
      const target = mx * this.config.moveSpeed
      const dv = target - p.vel.x
      p.vel.x += clampAbs(dv, this.config.groundAccel * C.DT)
      return
    }

    // 离地：只加速、不刹车。否则空气控制会抵消丝线甩飞的速度（D-020）。
    if (mx !== 0) {
      const target = mx * this.config.airControlSpeed
      const dv = target - p.vel.x
      if (dv !== 0 && Math.sign(dv) === Math.sign(mx)) {
        p.vel.x += clampAbs(dv, this.config.airAccel * C.DT)
      }
    }
  }

  // ── 3. 丝线指令 ─────────────────────────────────────

  /** 丝线的出丝点。主角从胸口出丝，其余物体从中心出丝（见 PLAYER_HAND_OFFSET_Y）。 */
  private anchorOf(b: Body): Vec2 {
    if (b.tag === 'player') return { x: b.pos.x, y: b.pos.y + C.PLAYER_HAND_OFFSET_Y }
    return b.pos
  }

  private applyRopeCommands(input: InputFrame, p: Body): void {
    // 断（先断后牵：允许同帧"断一根、牵一根"）
    if (input.cutRope >= 0) {
      const r = this.ropes[input.cutRope]
      if (r !== undefined && r.state === 'attached') this.detach(r, 'cut')
    }

    // 牵
    if (input.attachPressed && input.aimPoint !== null && this.stunRemaining <= 0) {
      const slot = this.firstIdleRope()
      if (slot !== null) {
        const target = this.pickAnchorable(p, input.aimPoint)
        if (target !== null) this.attach(slot, target, p)
      }
    }

    // 收 / 放（对所有已附着的丝生效，设计 §3.1「缩短所有丝线」）
    //
    // 注：v0.2.0 这里有个"收丝机堵转"保护（张力达 80% 就暂停收丝）。
    // 自 D-032 起丝线改为**到顶变刚性、永不断裂**，伸长量被位置约束直接夹住，
    // 失控的前提消失，因此堵转已删除——收丝现在是纯粹的直接控制。
    if (input.reel !== 'hold' && this.stunRemaining <= 0) {
      const step = this.config.reelSpeed * C.DT
      for (const r of this.ropes) {
        if (r.state !== 'attached') continue
        r.targetLength =
          input.reel === 'in'
            ? clampRopeLength(r.targetLength - step)
            : clampRopeLength(r.targetLength + step)
      }
    }
  }

  private firstIdleRope(): Rope | null {
    for (const r of this.ropes) if (r.state === 'idle') return r
    return null
  }

  /** 按数组顺序取"离瞄准点最近且在容差内"的可附着物。顺序固定 ⇒ 确定性。 */
  private pickAnchorable(player: Body, aim: Vec2): Body | null {
    const from = this.anchorOf(player)
    let best: Body | null = null
    let bestD = Number.POSITIVE_INFINITY
    for (const b of this.bodies) {
      if (!b.anchorable || b.tag === 'player' || !b.alive) continue
      const d = dist(b.pos, aim)
      if (d > this.config.attachTolerance) continue
      if (dist(from, b.pos) > C.ROPE_LEN_MAX) continue
      if (d < bestD) {
        bestD = d
        best = b
      }
    }
    return best
  }

  private attach(r: Rope, target: Body, player: Body): void {
    r.state = 'attached'
    r.targetId = target.id
    // D-020：连接瞬间丝长 = 当前距离，不产生拉力；只有主动收丝才发力。
    const a = this.anchorOf(player)
    r.targetLength = clampRopeLength(dist(a, target.pos))
    r.length = r.targetLength
    r.tension = 0
    r.peakTension = 0
    r.lastBreakReason = 'none'
    const chain = createVerletChain(a, target.pos, C.ROPE_SEGMENTS)
    this.chains[r.index] = chain
    this.events.push({ kind: 'rope-attached', rope: r.index, target: target.id })
  }

  private detach(r: Rope, reason: 'cut' | 'over-tension'): void {
    const targetId = r.targetId
    r.state = 'recovering'
    r.recongealRemaining = C.ROPE_RECONGEAL_SEC
    r.targetId = -1
    r.tension = 0
    r.length = 0
    r.lastBreakReason = reason
    this.chains[r.index] = null

    // 脱离豁免：丝线被收短时物体常常**在主角身体内部**（实测最近 0.129m，
    // 而主角半宽 0.4 / 半高 0.8）。此刻若立刻恢复碰撞，求解器会把它猛推出去、
    // 主角被一起撞飞（第 3 轮实机反馈 #4）。改为"已经在你身体里的东西不再撞你"，
    // 等两者分开后自动恢复碰撞。见 Body.ignorePlayer。
    const target = this.bodyById(targetId)
    if (target !== null) target.ignorePlayer = true

    if (reason === 'cut') {
      this.events.push({ kind: 'rope-cut', rope: r.index, target: targetId })
    }
  }

  // ── 4. 施力 ─────────────────────────────────────────

  private applyForces(p: Body): void {
    const n = this.bodies.length
    this.fx.fill(0, 0, n)
    this.fy.fill(0, 0, n)

    // 重力
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i]
      if (b.kind === 'static') continue
      this.fy[i] += b.mass * this.config.gravityY
    }

    // 丝线弹簧-阻尼。松弛 ⇒ 张力 0 ⇒ 不施任何力（FR-PHY-001 铁律 1）。
    const playerAnchor = this.anchorOf(p)
    for (const r of this.ropes) {
      if (r.state !== 'attached') {
        r.tension = 0
        continue
      }
      const target = this.bodyById(r.targetId)
      if (target === null) {
        this.detach(r, 'cut')
        continue
      }

      const d = sub(target.pos, playerAnchor)
      const L = len(d)
      r.length = L
      const nx = L > 1e-9 ? d.x / L : 0
      const ny = L > 1e-9 ? d.y / L : 1

      const vAxial = (target.vel.x - p.vel.x) * nx + (target.vel.y - p.vel.y) * ny
      const mr = reducedMass(p.invMass, target.invMass)
      let T = ropeTension({
        length: L,
        targetLength: r.targetLength,
        axialVelocity: vAxial,
        reducedMass: mr,
        stiffness: this.config.stiffness,
        dampingRatio: this.config.dampingRatio,
      })
      // 张力上限是"拉力上限"，不是"断裂阈值"（D-032）。
      // 到顶之后超出的部分由 solveRopeConstraints() 用刚性约束接管，
      // 这里把力的部分夹住即可，避免它继续涨。
      if (T > this.config.tensionMax) T = this.config.tensionMax
      r.tension = T
      if (T > r.peakTension) r.peakTension = T
      if (T <= 0) continue

      // 丝只能拉：目标被拉向主角（−n），主角被拉向目标（+n）。
      this.fx[target.id] -= nx * T
      this.fy[target.id] -= ny * T
      this.fx[p.id] += nx * T
      this.fy[p.id] += ny * T
    }
  }

  /**
   * 丝线的**刚性约束**（D-032 的核心）。
   *
   * 张力到达上限后丝线不再伸长，而是把两端钉在 `目标丝长 + 弹性余量` 的距离上；
   * 修正量按**逆质量**分配，于是自然涌现出设计要的行为：
   *
   * - 主角着地（等效质量 ∞）⇒ 几乎全部修正给物体 ⇒ **物体被拉向主角**
   * - 主角离地（0.5）、物体更重 ⇒ 大部分修正给主角 ⇒ **主角被拉过去**
   * - 两端都动不了 ⇒ 谁也过不去，主角**无法继续往张力增大的方向移动**
   *
   * 同时取消沿丝线方向**相互远离**的速度分量，否则每帧都会被弹簧再拉开一次、来回抖。
   */
  private solveRopeConstraints(): void {
    const p = this.player
    const limit = this.config.tensionMax / this.config.stiffness // = ROPE_MAX_STRETCH

    for (const r of this.ropes) {
      if (r.state !== 'attached') continue
      const target = this.bodyById(r.targetId)
      if (target === null) continue

      const a = this.anchorOf(p)
      const d = sub(target.pos, a)
      const L = len(d)
      if (L < 1e-9) continue

      const maxLen = r.targetLength + limit
      if (L <= maxLen) continue

      const invSum = p.invMass + target.invMass
      if (invSum <= 0) continue
      const nx = d.x / L
      const ny = d.y / L
      const excess = L - maxLen

      // 位置修正（按逆质量分配）
      const ka = (excess * p.invMass) / invSum
      const kb = (excess * target.invMass) / invSum
      p.pos = { x: p.pos.x + nx * ka, y: p.pos.y + ny * ka }
      target.pos = { x: target.pos.x - nx * kb, y: target.pos.y - ny * kb }

      // 速度修正：只取消"相互远离"的轴向速度
      const vAxial = (target.vel.x - p.vel.x) * nx + (target.vel.y - p.vel.y) * ny
      if (vAxial > 0) {
        const j = vAxial / invSum
        p.vel = { x: p.vel.x + nx * j * p.invMass, y: p.vel.y + ny * j * p.invMass }
        target.vel = {
          x: target.vel.x - nx * j * target.invMass,
          y: target.vel.y - ny * j * target.invMass,
        }
      }
    }
  }

  private integrateVelocities(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]
      if (b.kind === 'static' || b.invMass === 0) continue
      b.vel = {
        x: b.vel.x + this.fx[i] * b.invMass * C.DT,
        y: b.vel.y + this.fy[i] * b.invMass * C.DT,
      }
    }
  }

  private integratePositions(): void {
    for (const b of this.bodies) {
      if (b.kind === 'static') continue
      b.pos = { x: b.pos.x + b.vel.x * C.DT, y: b.pos.y + b.vel.y * C.DT }
    }
  }

  // ── 7. 碰撞检测 ─────────────────────────────────────

  private detectContacts(): void {
    this.contacts.length = 0
    const n = this.bodies.length

    // 被牵住的物体 id：主角与它之间**不做碰撞**。
    // 原因见 D-027：不豁免的话，石块一被收近就顶在主角自己的盒体上抬不起来，
    // 甩动速度上限只有 5.8 m/s，而设计 §7 要求"石头被拉向主角……悬在半空，开始摆动"。
    const held = new Set<number>()
    for (const r of this.ropes) {
      if (r.state === 'attached' && r.targetId >= 0) held.add(r.targetId)
    }

    for (let i = 0; i < n; i++) {
      const a = this.bodies[i]
      for (let j = i + 1; j < n; j++) {
        const b = this.bodies[j]

        if (a.tag === 'player' || b.tag === 'player') {
          const other = a.tag === 'player' ? b : a
          // ① 主角与 **prop 类物体一律不碰撞**（D-035，取代 D-027）。
          //    一是"小石块挡住去路"（实机反馈 #6），二是被牵物体常常在主角体内、
          //    断丝瞬间会被求解器猛推出去把主角撞飞（反馈 #4）。两者一次解决。
          //    prop 是可以随手摆弄的东西，不该成为地形。
          if (other.tag === 'prop') continue
          // ② 正被牵住 ⇒ 豁免（D-027 的残留，对敌人等非 prop 仍然适用）
          if (held.has(other.id)) continue
          // ③ 刚脱离且仍在主角体内 ⇒ 豁免，直到分开（D-033）
          if (other.ignorePlayer) continue
        }

        if (!boundsOverlap(a, b)) continue
        const c = collide(a, b)
        if (c !== null) this.contacts.push(c)
      }
    }
  }

  /**
   * 每 tick 检查"脱离豁免"是否该撤销：一旦物体与主角的包围盒**不再重叠**，
   * 就恢复正常碰撞。用包围盒而不是精确形状，是为了让豁免撤销得**更保守**
   * （宁可多豁免一帧，也不要在还嵌着的时候突然恢复碰撞）。
   */
  private updateIgnoreFlags(): void {
    const p = this.player
    const phw = p.shape.kind === 'aabb' ? p.shape.hw : p.shape.radius
    const phh = p.shape.kind === 'aabb' ? p.shape.hh : p.shape.radius
    for (const b of this.bodies) {
      if (!b.ignorePlayer) continue
      const shw = b.shape.kind === 'aabb' ? b.shape.hw : b.shape.radius
      const shh = b.shape.kind === 'aabb' ? b.shape.hh : b.shape.radius
      const separated =
        Math.abs(b.pos.x - p.pos.x) > phw + shw || Math.abs(b.pos.y - p.pos.y) > phh + shh
      if (separated) b.ignorePlayer = false
    }
  }

  // ── 8. 撞击事件与伤害 ───────────────────────────────

  private emitContacts(): void {
    const next = new Set<number>()
    for (const c of this.contacts) {
      const a = c.a
      const b = c.b
      const key = a.id * 1024 + b.id
      next.add(key)
      const isNew = !this.touching.has(key)
      if (!isNew) continue
      if (c.approachSpeed < C.MIN_IMPACT_SPEED) continue
      const at: Vec2 = {
        x: (a.pos.x + b.pos.x) * 0.5,
        y: (a.pos.y + b.pos.y) * 0.5,
      }
      this.events.push({ kind: 'impact', a: a.id, b: b.id, speed: c.approachSpeed, at })
      this.resolveDamage(a, b, c.approachSpeed, at)
    }
    this.touching = next
  }

  private resolveDamage(a: Body, b: Body, speed: number, at: Vec2): void {
    let target: Body | null = null
    let attacker: Body | null = null
    if (a.tag === 'enemy' && b.tag !== 'enemy') {
      target = a
      attacker = b
    } else if (b.tag === 'enemy' && a.tag !== 'enemy') {
      target = b
      attacker = a
    }
    if (target === null || attacker === null) return
    if (!target.alive || target.maxHp <= 0) return

    // 注意：用 **damageMass**（设计口径的固有质量），而不是当前有效质量。
    // 主角着地时有效质量是 1e6，若拿它算伤害，走路撞一下就能秒掉墨甲——
    // 与设计「主角质量 0.5，不产生力量」直接冲突。
    const res: DamageResult = resolveImpactAgainst(
      attacker.damageMass,
      target.damageMass,
      target.weakness,
      speed,
    )
    if (!res.effective || res.amount <= 0) return

    target.hp -= res.amount
    this.events.push({
      kind: 'damage',
      target: target.id,
      amount: res.amount,
      type: res.type,
      hpAfter: target.hp,
      at,
    })
    if (target.hp <= 0) {
      target.hp = 0
      target.alive = false
      this.events.push({ kind: 'killed', target: target.id, at })
    }
  }

  // ── 9. 顺序冲量求解 ─────────────────────────────────

  private solveVelocities(): void {
    const iters = this.config.solverIterations
    for (let k = 0; k < iters; k++) {
      for (let ci = 0; ci < this.contacts.length; ci++) {
        const c = this.contacts[ci]
        const A = c.a
        const B = c.b
        const invSum = A.invMass + B.invMass
        if (invSum <= 0) continue

        const nx = c.normal.x
        const ny = c.normal.y
        const rvx = B.vel.x - A.vel.x
        const rvy = B.vel.y - A.vel.y
        const vn = rvx * nx + rvy * ny

        if (vn <= 0) {
          const e = Math.min(A.restitution, B.restitution)
          let jn = (-(1 + e) * vn) / invSum
          if (jn < 0) jn = 0

          A.vel = { x: A.vel.x - nx * jn * A.invMass, y: A.vel.y - ny * jn * A.invMass }
          B.vel = { x: B.vel.x + nx * jn * B.invMass, y: B.vel.y + ny * jn * B.invMass }

          // 库仑摩擦（切向）
          const tx = -ny
          const ty = nx
          const vt2 = (B.vel.x - A.vel.x) * tx + (B.vel.y - A.vel.y) * ty
          let jt = -vt2 / invSum
          const mu = Math.sqrt(A.friction * B.friction)
          const maxF = mu * jn
          if (jt > maxF) jt = maxF
          else if (jt < -maxF) jt = -maxF

          A.vel = { x: A.vel.x - tx * jt * A.invMass, y: A.vel.y - ty * jt * A.invMass }
          B.vel = { x: B.vel.x + tx * jt * B.invMass, y: B.vel.y + ty * jt * B.invMass }
        }
      }
    }
  }

  private correctPositions(): void {
    for (let ci = 0; ci < this.contacts.length; ci++) {
      const c = this.contacts[ci]
      const invSum = c.a.invMass + c.b.invMass
      if (invSum <= 0) continue
      const pen = c.penetration - C.SLOP
      if (pen <= 0) continue
      const k = (pen * C.BAUMGARTE) / invSum
      const nx = c.normal.x
      const ny = c.normal.y
      c.a.pos = {
        x: c.a.pos.x - nx * k * c.a.invMass,
        y: c.a.pos.y - ny * k * c.a.invMass,
      }
      c.b.pos = {
        x: c.b.pos.x + nx * k * c.b.invMass,
        y: c.b.pos.y + ny * k * c.b.invMass,
      }
    }
  }

  // ── 10. 着地 ────────────────────────────────────────

  private updateGrounded(): void {
    const p = this.player
    let grounded = false
    for (let ci = 0; ci < this.contacts.length; ci++) {
      const c = this.contacts[ci]
      if (c.a !== p && c.b !== p) continue
      const other = c.a === p ? c.b : c.a
      if (other.tag === 'hazard') continue
      // 站得住的"实体"：静态地形，或质量足够大的动态物体。
      if (other.kind !== 'static' && other.damageMass < 5) continue
      // 由主角指向对方的法线；脚踩实体 ⇒ 对方在下方 ⇒ ny < 0。
      const ny = c.a === p ? c.normal.y : -c.normal.y
      if (ny <= -C.GROUNDED_NORMAL_Y) {
        grounded = true
        break
      }
    }
    p.grounded = grounded
    setMass(p, grounded ? C.PLAYER_MASS_GROUNDED : C.PLAYER_MASS_AIRBORNE)
  }

  // ── 11. 断弦：**已取消**（D-032）─────────────────────
  //
  // v0.2.0 这里会做"张力超限 → 断丝 + 0.8s 硬直"。创始人在第 3 轮实机反馈中指出
  // 这个机制**无法掌握**："丝线什么时候会断太难掌握了"。
  //
  // 现在改为：张力到顶**不断裂**，而是由 solveRopeConstraints() 变成刚性约束
  // （轻的一端被拉过来、重的一端拉不动）。于是"张力"从一件**不可预测的危险**
  // 变成一条**可预测的能力边界**，玩家随时知道自己在什么状态。
  //
  // 需要变的还有 SRS 的 FR-PHY-006（超限断裂 + 硬直），见 D-032 的影响面。
  // `stunRemaining` 与"硬直期间不响应输入"的机制保留，留给以后的其他硬直来源。

  // ── 13. Verlet 链（表现）────────────────────────────

  private stepChains(p: Body): void {
    for (const r of this.ropes) {
      const chain = this.chains[r.index]
      if (chain === null) continue
      if (r.state !== 'attached') {
        this.chains[r.index] = null
        continue
      }
      const target = this.bodyById(r.targetId)
      if (target === null) {
        this.chains[r.index] = null
        continue
      }
      stepVerletChain(chain, {
        a: this.anchorOf(p),
        b: target.pos,
        restLength: Math.max(r.targetLength, 0.05),
        gravityY: this.config.gravityY,
        dt: C.DT,
      })
    }
  }

  // ── 查询 ────────────────────────────────────────────

  /** 断丝命中判定：返回距离点最近的**已附着**丝位索引；无命中返回 −1。 */
  pickRope(point: Vec2, radius = this.config.ropeHitRadius): number {
    const a = this.anchorOf(this.player)
    let best = -1
    let bestD = radius
    for (const r of this.ropes) {
      if (r.state !== 'attached') continue
      const t = this.bodyById(r.targetId)
      if (t === null) continue
      const d = distanceToSegment(point, a, t.pos)
      if (d <= bestD) {
        bestD = d
        best = r.index
      }
    }
    return best
  }

  /** `Q 断最近的一根`（FR-ACT-005）：取距给定点最近的已附着丝位。 */
  pickNearestRope(point: Vec2): number {
    const a = this.anchorOf(this.player)
    let best = -1
    let bestD = Number.POSITIVE_INFINITY
    for (const r of this.ropes) {
      if (r.state !== 'attached') continue
      const t = this.bodyById(r.targetId)
      if (t === null) continue
      const d = distanceToSegment(point, a, t.pos)
      if (d < bestD) {
        bestD = d
        best = r.index
      }
    }
    return best
  }

  /** HUD 用：每根丝位的占用状态（FR-UI-001 的 4 枚圆点）。 */
  ropeDisplay(): { index: number; state: 'idle' | 'attached' | 'recovering'; tension: number; ratio: number }[] {
    return this.ropes.map((r) => ({
      index: r.index,
      state: r.state,
      tension: r.tension,
      ratio: this.config.tensionMax > 0 ? r.tension / this.config.tensionMax : 0,
    }))
  }

  // ── 确定性 ──────────────────────────────────────────

  /** 参与哈希的全部状态量，顺序固定。 */
  stateValues(): number[] {
    const out: number[] = [this.tick, this.stunRemaining]
    for (const b of this.bodies) {
      out.push(
        b.pos.x,
        b.pos.y,
        b.vel.x,
        b.vel.y,
        b.mass,
        b.hp,
        b.alive ? 1 : 0,
        b.ignorePlayer ? 1 : 0,
      )
    }
    for (const r of this.ropes) {
      out.push(
        r.state === 'idle' ? 0 : r.state === 'attached' ? 1 : 2,
        r.targetId,
        r.targetLength,
        r.length,
        r.tension,
        r.recongealRemaining,
      )
    }
    return out
  }

  stateHash(): string {
    return hashFloat64Wide(this.stateValues())
  }
}
