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
import { type Contact, boundsOverlap, closestPointOnShape, collide, distanceToShape } from './collide'
import * as C from './constants'
import { type DamageResult, resolveImpactAgainst } from './damage'
import {
  type EnemyHost,
  hitCore,
  isInkDot,
  isNest,
  releaseEntangle,
  ropeIsEntangled,
  stepEnemies,
} from './enemies'
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
  /**
   * **已解锁的丝位数**（FR-PRG-006：随进度 1→2→3→4）。
   *
   * 序章从 1 根开始，8:00 解锁第 2 根。实现方式是**预建全部丝位、只放行前 N 个**——
   * 而不是运行时往 `ropes` 数组里 push（数组下标就是丝位编号，一 push 就会让
   * HUD 顺序与状态哈希漂移）。构造期的 `config.ropeCount` 是**总槽位数**。
   */
  unlockedRopes: number

  /**
   * **视野污染**（FR-CBT-012 / D-065）：0 = 全屏可见，1 = 污染到下限。
   *
   * 墨巢射出的墨点命中主角时上升，之后**缓慢自愈**（`INK_POLLUTION_DECAY_PER_SEC`）。
   * 渲染层用它算遮罩；`visibleRatio()` 把"污染量"翻译成"还能看见多少"。
   *
   * 为什么把这个状态放在**内核**而不是渲染层：
   * ① 它会随 tick 演化 ⇒ 必须确定性（AC-05）；
   * ② 它是**玩法状态**（决定玩家还能看见多少信息），不是画面效果 ——
   *    如果它在渲染层，回放就没法复现"当时屏幕上有多黑"。
   */
  inkPollution = 0

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
    this.unlockedRopes = this.config.ropeCount
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

  /**
   * 收编一个**已经造好的**刚体（第 20 轮）。
   *
   * 存在的理由：敌人的参数（质量/弱点/HP/巡逻带/承重点）应当只有**一个**定义处，
   * 那个定义处是 `core/enemies.ts` 的工厂（`createBlade` / `createBind` / `createNest` /
   * `createInkDot`）。如果场景改用 `addBody({...})` 一字排开，同一套参数就会有两份，
   * 迟早有一份忘了改 —— 而这类"两处定义、一处漏改"的 bug 我这个项目已经踩过两次
   * （第 18 轮的回放头部格式、第 19 轮的 RTM 与 SRS 计数）。
   *
   * 只允许在**构造期**使用（id 必须等于当前数组长度，与 `addBody` 同一条铁律）。
   */
  adoptBody(b: Body): Body {
    const id = this.bodies.length
    if (b.id !== id) {
      throw new Error(`收编的刚体 id 必须等于其数组下标：期望 ${id}，收到 ${b.id}`)
    }
    this.bodies.push(b)
    if (this.bodies.length > this.cap) {
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

  /**
   * 重力加速度（带符号，向下为负）。
   *
   * 为什么要有这个 getter：`EnemyHost` 接口需要它（墨巢要解抛体角度才能打中玩家），
   * 而 `gravityY` 藏在 `config` 里。少了它，`enemies.ts` 的运行期宿主自检会当场报错 ——
   * 事实上它就是这么被抓到的。
   */
  get gravityY(): number {
    return this.config.gravityY
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

  /** 本帧玩家是否**真的**把某根丝收短了（刚性约束用来区分"自己走远"与"收丝"，D-057）。 */
  private reeledInThisTick = false

  step(input: InputFrame): void {
    this.events.length = 0
    this.tick++

    this.tickTimers()
    // 敌人行为**在物理积分之前**：它们只改自己的速度与倒计时，
    // 让同一 tick 的积分把新速度算进去（否则墨刃会慢一帧）。
    stepEnemies(this)
    this.stepPollution()
    const p = this.player
    this.applyPlayerControl(input, p)
    this.applyRopeCommands(input, p)
    // 飞行中的丝先推进：到位的那一帧立刻转 attached，于是"飞过去 → 绷住"发生在同一 tick 内，
    // 飞行期间它不参与 applyForces / solveRopeConstraints（两处都只看 attached）。
    this.stepFlyingRopes(p)
    this.applyForces(p)
    this.integrateVelocities()
    this.integratePositions()
    // 位置层约束：**丝线刚性约束 ⇄ 碰撞分离交替迭代**。
    // 两条都是位置约束，只各解一次的话刚性那条每次都赢 —— 被顶到墙上的敌人与石块
    // 会稳定地互相嵌进去（实测穿透 0.236m）。见 D-036。
    for (let it = 0; it < C.POSITION_ITERATIONS; it++) {
      this.solveRopeConstraints()
      this.detectContacts()
      this.correctPositions()
    }
    // 用最终位置重新取一次接触集：速度求解、伤害判定、着地判定都以它为准
    this.detectContacts()
    this.emitContacts()
    this.solveVelocities()
    this.updateGrounded()
    this.updateIgnoreFlags()
    this.stepFades()
    this.clearPollutionWhenNestsCleared()
    for (const b of this.bodies) refreshDerived(b)
    this.stepChains(p)
  }

  // ── 敌人层需要的能力（`EnemyHost`）──────────────────
  //
  // `core/enemies.ts` 刻意**不 import World**（避免循环依赖，也让那层能独立单测）。
  // 它只依赖一个结构化接口，下面这几个方法就是那个接口的实现。

  /**
   * 从墨点池里取一枚休眠墨点，放到 `from` 并以 `vel` 飞出去。
   *
   * **池子空了就返回 false**（巢会等下一拍再试）—— 绝不新建刚体：
   * `bodies` 数组下标就是刚体 id，长度必须全程不变（`tests/perf.test.ts` 守着它）。
   */
  spawnInkDot(from: Vec2, vel: Vec2): boolean {
    for (const b of this.bodies) {
      if (!isInkDot(b) || !b.removed) continue
      b.removed = false
      b.alive = true
      b.pos = { x: from.x, y: from.y }
      b.vel = { x: vel.x, y: vel.y }
      b.grounded = false
      b.dotLife = C.INK_DOT_LIFE_SEC
      b.ignorePlayer = true
      return true
    }
    return false
  }

  /** 事件出口（敌人层发事件用）。 */
  pushEvent(kind: string, detail: Record<string, unknown>): void {
    this.events.push({ kind, ...detail } as SimEvent)
  }

  // ── 1. 计时器 ───────────────────────────────────────

  /**
   * 视野污染的自愈与钳制（FR-CBT-012）。
   *
   * 三条规则：
   * ① 每 tick 按 `INK_POLLUTION_DECAY_PER_SEC` 回落 —— 失误可恢复，
   *    不会因为开局被打中两发就永久残废；
   * ② 钳到 `[0, 1 - INK_MIN_VISIBLE]`：**污染到顶也只遮掉 65% 视野**，
   *    至少留 35% —— 否则是"没法玩"，而不是"难受"（D-065 ②）；
   * ③ 墨巢死光时由 `clearPollutionFromNests()` 直接清零（创始人明确要求的那条）。
   */
  private stepPollution(): void {
    if (this.inkPollution > 0) {
      this.inkPollution -= C.INK_POLLUTION_DECAY_PER_SEC * C.DT
      if (this.inkPollution < 0) this.inkPollution = 0
    }
    const max = 1 - C.INK_MIN_VISIBLE
    if (this.inkPollution > max) this.inkPollution = max
  }

  /** 还能看见多少（0.35..1）。渲染层直接用这个数当"清晰区域的半径比例"。 */
  visibleRatio(): number {
    return 1 - this.inkPollution
  }

  /** 加污染（墨点命中时调用）。 */
  addPollution(amount: number): void {
    if (!(amount > 0)) return
    this.inkPollution += amount
    const max = 1 - C.INK_MIN_VISIBLE
    if (this.inkPollution > max) this.inkPollution = max
  }

  /**
   * 全部墨巢都死了 ⇒ 污染清零（创始人原话：「直到击败墨巢恢复全屏可见」）。
   *
   * 每 tick 检查一次（代价是遍历一遍 bodies，几十个元素，可忽略）。
   * 用"还有活着的巢吗"而不是"某只巢刚死"来判定：这样即使将来一关有多个巢，
   * 规则也仍然是"清完才恢复"，不需要额外状态。
   */
  private clearPollutionWhenNestsCleared(): void {
    if (this.inkPollution <= 0) return
    for (const b of this.bodies) {
      if (isNest(b) && !b.removed && b.alive) return
    }
    this.inkPollution = 0
  }

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

    // 牵（**松手发射**）：松手点即附着点，丝先飞过去，到位才开始受力。
    if (input.firePressed && input.aimPoint !== null && this.stunRemaining <= 0) {
      const slot = this.firstIdleRope()
      if (slot !== null) this.launch(slot, input.aimPoint, p)
    }

    // 收 / 放（对所有已附着的丝生效，设计 §3.1「缩短所有丝线」）
    //
    // 注：v0.2.0 这里有个"收丝机堵转"保护（张力达 80% 就暂停收丝）。
    // 自 D-032 起丝线改为**到顶变刚性、永不断裂**，伸长量被位置约束直接夹住，
    // 失控的前提消失，因此堵转已删除——收丝现在是纯粹的直接控制。
    if (input.reel !== 'hold' && this.stunRemaining <= 0) {
      const step = this.config.reelSpeed * C.DT
      // 记下"这一帧真的把丝收短了"：刚性约束要靠它区分
      // "主角自己在往外走"（→ 只挡不拽）与"玩家在收丝"（→ 该把人拉过去）。见 D-057。
      this.reeledInThisTick = false
      for (const r of this.ropes) {
        if (r.state !== 'attached') continue
        // **被墨缚缠住的丝收不动也放不动**（但可以断 —— 断的路径在上面，不经过这里）。
        // D-065 ③ 的推荐项：惩罚是"这段时间少一根丝"，解是"按断"，教的是资源管理。
        if (ropeIsEntangled(this, r.index)) continue
        if (input.reel === 'in') {
          const next = clampRopeLength(r.targetLength - step)
          if (next < r.targetLength) this.reeledInThisTick = true
          r.targetLength = next
        } else {
          r.targetLength = clampRopeLength(r.targetLength + step)
        }
      }
    } else {
      this.reeledInThisTick = false
    }
  }

  private firstIdleRope(): Rope | null {
    for (let i = 0; i < this.unlockedRopes; i++) {
      const r = this.ropes[i]
      if (r !== undefined && r.state === 'idle') return r
    }
    return null
  }

  /**
   * 松手点在哪个可附着物上（按数组顺序取最近的，顺序固定 ⇒ 确定性）。
   *
   * 判据是"松手点到物体**表面**的距离 ≤ `ROPE_AIM_TOLERANCE`"：
   * 允许略微落在轮廓外面一点点（手指有宽度），但不能是明显的空白。
   * 另外还要求主角到它的距离不超过丝长上限——丝是有射程的。
   */
  private pickAnchorableAt(player: Body, aim: Vec2): Body | null {
    const from = this.anchorOf(player)
    let best: Body | null = null
    let bestD = Number.POSITIVE_INFINITY
    for (const b of this.bodies) {
      if (!b.anchorable || b.tag === 'player' || !b.alive || b.removed) continue
      const d = distanceToShape(aim, b)
      if (d > this.config.attachTolerance) continue
      if (dist(from, closestPointOnShape(aim, b)) > C.ROPE_LEN_MAX) continue
      if (d < bestD) {
        bestD = d
        best = b
      }
    }
    return best
  }

  /**
   * 瞄准点的**预览信息**：这个点能不能附着、会落在哪个物体的哪一点。
   *
   * 渲染层用它把"可附着的物体"高亮出来、并画一个附着点标记——
   * 这样"松手在空白处不附着"这条规则在按下去的时候就是**看得见**的，而不是松手才知道。
   */
  aimPreview(player: Body, aim: Vec2): { targetId: number; point: Vec2; valid: boolean } {
    const target = this.pickAnchorableAt(player, aim)
    if (target === null) return { targetId: -1, point: aim, valid: false }
    return { targetId: target.id, point: closestPointOnShape(aim, target), valid: true }
  }

  /**
   * **发射**：把丝从主角射向 `aim`。
   *
   * 松手点在空白处 ⇒ **什么也不做**（创始人明确的规则）。返回是否真的射出去了。
   * 命中 ⇒ 立刻锁定"哪具刚体 + 表面上的哪一点"（局部偏移），进入 `flying`；
   * 飞行期间不传力，到位那一帧才转 `attached` 并生成 Verlet 链。
   */
  launch(r: Rope, aim: Vec2, player: Body): boolean {
    if (r.state !== 'idle') return false
    const target = this.pickAnchorableAt(player, aim)
    if (target === null) {
      this.events.push({ kind: 'rope-missed', rope: r.index, at: aim })
      return false
    }

    // 附着点：松手点吸附到该物体的**表面**（点在内部 ⇒ 推到最近的那条边）
    const surface = closestPointOnShape(aim, target)
    const from = this.anchorOf(player)
    r.state = 'flying'
    r.targetId = target.id
    r.anchorOffset = { x: surface.x - target.pos.x, y: surface.y - target.pos.y }
    r.flyFrom = { x: from.x, y: from.y }
    r.flyTip = { x: from.x, y: from.y }
    r.length = dist(from, surface)
    r.tension = 0
    r.peakTension = 0
    r.lastBreakReason = 'none'
    this.chains[r.index] = null
    this.events.push({ kind: 'rope-launched', rope: r.index, target: target.id, at: surface })
    return true
  }

  /** 附着点在**当前**世界坐标（目标会动，锚点跟着它走）。 */
  private ropeAnchorOf(r: Rope, target: Body): Vec2 {
    return { x: target.pos.x + r.anchorOffset.x, y: target.pos.y + r.anchorOffset.y }
  }

  /**
   * 推进飞行中的丝线。到了就转 `attached`。
   *
   * 目标在飞行途中消失（陶罐被打碎等）⇒ 直接作废进重凝，不留下一条指向虚空的丝。
   */
  private stepFlyingRopes(p: Body): void {
    for (const r of this.ropes) {
      if (r.state !== 'flying') continue
      const target = this.bodyById(r.targetId)
      if (target === null || target.removed || !target.alive) {
        r.state = 'recovering'
        r.recongealRemaining = C.ROPE_RECONGEAL_SEC
        r.targetId = -1
        continue
      }

      const from = this.anchorOf(p)
      const to = this.ropeAnchorOf(r, target)
      r.flyFrom = { x: from.x, y: from.y }
      const d = sub(to, r.flyTip)
      const rest = len(d)
      const stepLen = C.ROPE_LAUNCH_SPEED * C.DT
      if (rest <= stepLen) {
        // 到位：转成真正的附着，丝长 = 当前实际距离（不产生瞬时拉力，D-020）
        r.flyTip = { x: to.x, y: to.y }
        r.state = 'attached'
        const a = this.anchorOf(p)
        const b = this.ropeAnchorOf(r, target)
        r.targetLength = clampRopeLength(dist(a, b))
        r.length = r.targetLength
        r.tension = 0
        this.chains[r.index] = createVerletChain(a, b, C.ROPE_SEGMENTS)
        this.events.push({ kind: 'rope-attached', rope: r.index, target: target.id })
        continue
      }
      r.flyTip = { x: r.flyTip.x + (d.x / rest) * stepLen, y: r.flyTip.y + (d.y / rest) * stepLen }
    }
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

    // 丝没了，缠在它上面的触须就该松 —— 否则墨缚会抱着一个不存在的丝位直到超时，
    // 表现为"它明明没缠着任何东西却不来缠你"。
    releaseEntangle(this, r.index)

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

      const anchorB = this.ropeAnchorOf(r, target)
      const d = sub(anchorB, playerAnchor)
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

      // 丝只能拉：目标被拉向主角（−n）。
      this.fx[target.id] -= nx * T
      this.fy[target.id] -= ny * T

      // ── 主角这一端：**只有收丝时才吃弹簧力**（D-057，第 14 轮实机反馈）──
      //
      // 创始人原话：「我连接到横梁之后移动到丝线张力范围外后会被**直接拉到天上**，
      // 这显然不是我想要的效果……我希望到达张力最大之后只是我的**人物无法继续移动**
      // （最多是由于弹性势能被回拉一点位置）而不是被拉走，**人物能被拉走的方式是收丝**。」
      //
      // 拆成两条规则，正好对应他这句话：
      //   · **在收丝** ⇒ 全额施力（那是玩家主动要的，"重的东西把你拉过去"就是这个）；
      //   · **没在收丝** ⇒ **一点力都不给主角**，只留刚性约束（见 solveRopeConstraints）。
      //     刚性约束只会**取消**"相互远离"的速度分量，**永远不会给主角加速度**。
      //
      // 为什么"没在收丝时也不能给一点点力"：丝一旦绷紧，`L > 目标丝长` 就一直成立，
      // 弹簧力会**持续**存在。哪怕只有 25 m/s²，一秒之后也是 25 m/s —— 人还是会被慢慢吊上去。
      // 所以这里必须是"零"，不能是"小"。
      //
      // 至于原来那个 240 g 的暴击：张力上限 1200 N 对 0.5 kg 是 240 g。主角着地时
      // 等效质量 1e6，这个力什么都做不了（所以走路时毫无感觉）；可一旦踏空、质量回到 0.5，
      // 同一根绷紧的丝在一帧内就把他推成 **vy = +29 m/s**。实测就是这么上天的。
      // 第 15 轮补：**收丝时的拉力也要有上限**（`PLAYER_ROPE_MAX_ACCEL`）。
      // 实测从沟左沿收丝到悬吊横梁那一路，主角最高速度是 **39.68 m/s**（收丝速度只有 8），
      // 创始人原话「速度太快来不及放第二根丝」。现在把加速度夹在 60 m/s² 以内，
      // 剩下的位移交给刚性约束（按收丝速度把人收进去）。
      // ⚠️ 只夹**主角**这一端；物体那一端（甩石头的手感）一个字没动。
      if (this.reeledInThisTick) {
        const f = Math.min(T, C.PLAYER_ROPE_MAX_ACCEL / p.invMass)
        this.fx[p.id] += nx * f
        this.fy[p.id] += ny * f
      }
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
   *
   * ## 第 14 轮补的一条：**着地的主角只被"挡住"，不被"拽起"**（D-057）
   *
   * 位置修正的方向是"沿丝线指向锚点"。锚点在头顶时（序章的横梁），这个方向的**竖直分量**
   * 会把一个**站在地上**的人往上推——推离地面之后他就不再着地，等效质量从 1e6 掉回 0.5，
   * 于是越推越高。实测：连着横梁一直往右走，人在 15.4 处被抬到 14.2 米。
   *
   * 创始人要的是「到达张力最大之后只是我的人物无法继续移动……而不是被拉走」，
   * 所以**着地且没有在收丝**时，把修正改成**只夹水平方向**：
   * 解出 `|锚点 − (x, 手部y)| = 最大丝长` 的那个 x，把主角**在地上**推回可达范围，
   * 竖直方向一点不动。要离地只能靠收丝（见 applyForces 的说明）。
   */
  private solveRopeConstraints(): void {
    const p = this.player
    const limit = this.config.tensionMax / this.config.stiffness // = ROPE_MAX_STRETCH

    for (const r of this.ropes) {
      if (r.state !== 'attached') continue
      const target = this.bodyById(r.targetId)
      if (target === null) continue

      const a = this.anchorOf(p)
      const anchorB = this.ropeAnchorOf(r, target)
      const d = sub(anchorB, a)
      const L = len(d)
      if (L < 1e-9) continue

      const maxLen = r.targetLength + limit
      if (L <= maxLen) continue

      // ── 着地 + 没在收丝 ⇒ 水平夹住（D-057）──
      // 收丝时不走这条路：收丝是**唯一**能把主角拉离地面的手段，必须保留径向修正。
      if (p.grounded && !this.reeledInThisTick) {
        const dy = anchorB.y - a.y
        const r2 = maxLen * maxLen - dy * dy
        if (r2 > 0 && target.invMass === 0) {
          const dxMax = Math.sqrt(r2)
          const away = Math.sign(a.x - anchorB.x) || 1
          const dist = Math.abs(a.x - anchorB.x)
          if (dist > dxMax) {
            p.pos = { x: anchorB.x + away * dxMax, y: p.pos.y }
            // 取消"继续往外走"的速度，否则下一帧又被弹簧推回来、来回蹭
            if (p.vel.x * away > 0) p.vel.x = 0
          }
          continue
        }
      }

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
      // **`removed` 的刚体完全退出模拟**（第 16 轮修）：它已经不参与碰撞了，
      // 但如果还继续积分，它就会**穿过地形永远下落**（y → −∞），
      // 最终把状态哈希推成 NaN —— AC-05 直接崩。实测：死掉的墨卒在 removed 之后
      // 一路掉到 y = −266 还在掉。
      if (b.kind === 'static' || b.invMass === 0 || b.removed) continue
      b.vel = {
        x: b.vel.x + this.fx[i] * b.invMass * C.DT,
        y: b.vel.y + this.fy[i] * b.invMass * C.DT,
      }
    }
  }

  private integratePositions(): void {
    for (const b of this.bodies) {
      if (b.kind === 'static' || b.removed) continue
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
      if (a.removed) continue
      for (let j = i + 1; j < n; j++) {
        const b = this.bodies[j]
        if (b.removed || b.fadeTicks > 0) continue

        if (a.tag === 'player' || b.tag === 'player') {
          const other = a.tag === 'player' ? b : a
          // ① 主角与 **prop 类物体一律不碰撞**（D-035，取代 D-027）。
          //    一是"小石块挡住去路"（实机反馈 #6），二是被牵物体常常在主角体内、
          //    断丝瞬间会被求解器猛推出去把主角撞飞（反馈 #4）。两者一次解决。
          //    prop 是可以随手摆弄的东西，不该成为地形。
          if (other.tag === 'prop') continue
          // ②③ 只对**可动物体**豁免：正被牵住（D-027 的残留）、刚脱离还在体内（D-033）。
          //
          //    **静态结构必须始终和主角碰撞**（D-050）。批 4 之前这里对"被牵住的"一律
          //    豁免，于是"连上主横梁、收丝"会把主角**拉进横梁内部**：横梁不动，
          //    主角穿过去了。更糟的是丝线锚点是"离主角最近的表面点"（D-048），
          //    手一旦进入横梁内部，锚点就变成手自己、绳长塌成 0，约束**瞬间消失** ——
          //    于是主角被"拉一下、穿过去、掉下来、再被拉一下"，在梁里
          //    以 ±25 m/s 的竖直速度**永久抖动**（实测）。
          //    静态目标本来就拉不动，豁免它没有任何收益，所以只豁免可动物体。
          if (other.kind !== 'static') {
            if (held.has(other.id)) continue
            if (other.ignorePlayer) continue
          }
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
    // 谁可以被伤害？——**任何 maxHp > 0 的活体**，不再限定 `tag === 'enemy'`。
    // 这样陶罐这类"可破坏场景物"（D-044）走的是与敌人完全相同的伤害管线，
    // 不需要为它单开一条规则。
    const aHurtable = a.maxHp > 0 && a.alive && !a.removed
    const bHurtable = b.maxHp > 0 && b.alive && !b.removed
    let target: Body | null = null
    let attacker: Body | null = null
    if (aHurtable && bHurtable) return // 两个都可受伤：不结算互相伤害（M1 不涉及）
    if (aHurtable) {
      target = a
      attacker = b
    } else if (bHurtable) {
      target = b
      attacker = a
    }
    if (target === null || attacker === null) return
    if (attacker.kind === 'static') return

    // ── 门槛 ⓪：**主角的身体不是武器**（第 16 轮实机反馈）──────────────
    //
    // 创始人报的 bug：「现在玩家**一定速度撞向敌人也会对敌人造成伤害**」。
    // 根因是 `vulnerable`（教学敌人不做门槛判定）把原来挡住主角的那道
    // `m_eff = min(0.5, 1) = 0.5 < 3` 也一起绕过去了 —— 而主角走速 6 m/s
    // 正好等于 `MIN_DAMAGE_SPEED`，于是一路走过去就把墨卒撞死了。
    //
    // 设计 §2.4 写得很清楚：「主角质量 0.5，**不产生力量**」——
    // 伤害必须来自**甩出去的东西**（石块）或环境（"无丝"）。
    // 所以在这里一刀切掉：攻击者是主角 ⇒ 不结算伤害（碰撞本身照旧，走路撞上去只是被挡）。
    if (attacker.tag === 'player') return

    // ── 门槛 ①：**还牵在手上的东西不造成伤害**（D-037）──────────────
    //
    // 设计 §2.3 原文：「**断丝 = 攻击。**」——攻击动作本身就是"松手"。
    // 不设这一条的话，玩家只要把石块收到敌人身上慢慢磨就能击杀，
    // 而"甩过去砸"就不再是唯一解法，整个投石的技巧空间被绕过去了。
    if (this.isHeld(attacker)) return

    // ── 门槛 ②：蹭到不算砸到（D-037）───────────────────────────
    //
    // `MIN_IMPACT_SPEED`（0.5）负责"有没有接触反馈"，这里负责"算不算伤害"。
    // 取 6 m/s —— 至少要比主角的走速（6 m/s）快，才配叫"砸过去"。
    if (speed < C.MIN_DAMAGE_SPEED) return

    // 注意：用 **damageMass**（设计口径的固有质量），而不是当前有效质量。
    // 主角着地时有效质量是 1e6，若拿它算伤害，走路撞一下就能秒掉墨甲——
    // 与设计「主角质量 0.5，不产生力量」直接冲突。
    //
    // **易碎场景物**（第 14 轮）：撞到就碎，不走两道门槛（见 `Body.fragile`）。
    // 陶罐只有 0.6 质量，`min(4, 0.6) = 0.6` 被冲击门槛挡下、切割又要求 v ≥ 15；
    // 而实测玩家朝目标方向的正常甩投是 15~16 m/s（且只有约 2/3 的手法能做到），
    // 于是"砸碎陶罐"这第一课时灵时不灵。它本来就是我定的"可破坏场景物"（D-044），
    // 耐久口径也由我定：**砸到就碎**。
    // **承重点**（第 20 轮 / FR-CBT-012）：撞击点是否落在目标身上的承重点小圆内。
    // 目前只有墨巢用它（`weakness: 'structure'`，打中承重点 ×3、打别处 0）。
    // 判定用**接触点**而不是"攻击物的位置"：接触点才是"砸在哪儿"的那个点。
    const coreHit = hitCore(target, at)

    const res: DamageResult = target.fragile
      ? { type: 'impact', amount: Math.max(target.hp, 1), effective: true }
      : target.vulnerable
        ? // 易伤目标：只保留"撞上了没有"（MIN_DAMAGE_SPEED）这一道，按切割公式结算。
          // 见 Body.vulnerable —— 教学敌人不该出现"看着打中了却不掉血"的死区。
          { type: 'cut', amount: (speed * speed) / C.CUT_DIVISOR, effective: true }
        : resolveImpactAgainst(
            attacker.damageMass,
            target.damageMass,
            target.weakness,
            speed,
            coreHit,
          )
    if (!res.effective || res.amount <= 0) return

    target.hp -= res.amount
    this.events.push({
      kind: 'damage',
      target: target.id,
      by: attacker.id,
      amount: res.amount,
      type: res.type,
      hpAfter: target.hp,
      at,
    })
    if (target.hp <= 0) {
      target.hp = 0
      target.alive = false
      // 易碎场景物（陶罐等）当场碎裂消失；
      // **敌人渐隐之后消失**（第 16 轮创始人要求：「敌人击败后加渐变消失的效果，
      // 不要尸体在原地挡路」）—— 渐隐期间它不参与任何碰撞（见 detectContacts），
      // 所以不会挡路，但玩家能看到"它死了"。
      if (target.shattersOnDeath) target.removed = true
      else if (!target.removed) target.fadeTicks = C.DEATH_FADE_TICKS
      this.events.push({ kind: 'killed', target: target.id, by: attacker.id, at })
    }
  }

  /** 推进"死亡渐隐"计时；隐完就置 `removed`（从碰撞与渲染里一起消失）。 */
  private stepFades(): void {
    for (const b of this.bodies) {
      if (b.fadeTicks <= 0) continue
      b.fadeTicks--
      if (b.fadeTicks <= 0) {
        b.fadeTicks = 0
        b.removed = true
      }
    }
  }

  /**
   * 该刚体当前是否被某根丝牵住。
   * 用于伤害门槛 ① ——「断丝 = 攻击」（设计 §2.3），牵在手上的东西不算武器。
   * 主动断丝后丝位立刻进入 `recovering` 且 `targetId` 清空，所以本函数随即返回 false。
   */
  private isHeld(b: Body): boolean {
    for (const r of this.ropes) {
      if (r.state === 'attached' && r.targetId === b.id) return true
    }
    return false
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
      // **深穿透不算"站得住"**。
      //
      // 正常接触经过位置修正之后穿透量在 0.01 以下；反过来，穿透到十几厘米说明
      // 求解器**没能把人推出来**——人被挤在两个结构之间（实测：悬吊横梁顶面到主横梁
      // 底面只有 1.05m，而主角高 1.6m，收丝贴上去就被永久卡住 0.548m）。
      // 那种状态下的接触法线是"从人指向脚下的结构"，会被当成着地，
      // 于是玩家**嵌在 12 米高的横梁里被判成"站在对岸"**、直接通关。
      // 卡住是几何问题（缝要比人高），但"嵌在里面算不算站住"是判定问题，在这里拦掉。
      if (c.penetration > C.GROUNDED_MAX_PENETRATION) continue
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
      const anchorA = this.anchorOf(p)
      stepVerletChain(chain, {
        a: anchorA,
        b: this.ropeAnchorOf(r, target),
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
      const d = distanceToSegment(point, a, this.ropeAnchorOf(r, t))
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
      const d = distanceToSegment(point, a, this.ropeAnchorOf(r, t))
      if (d < bestD) {
        bestD = d
        best = r.index
      }
    }
    return best
  }

  /** HUD 用：**已解锁**丝位的占用状态（FR-UI-001 的圆点）。 */
  ropeDisplay(): { index: number; state: 'idle' | 'attached' | 'recovering'; tension: number; ratio: number }[] {
    return this.ropes.slice(0, this.unlockedRopes).map((r) => ({
      index: r.index,
      state: r.state,
      tension: r.tension,
      ratio: this.config.tensionMax > 0 ? r.tension / this.config.tensionMax : 0,
    }))
  }

  // ── 确定性 ──────────────────────────────────────────

  /** 参与哈希的全部状态量，顺序固定。 */
  stateValues(): number[] {
    const out: number[] = [
      this.tick,
      this.stunRemaining,
      this.unlockedRopes,
      // 视野污染（FR-CBT-012）：它是**玩法状态**，必须进哈希 ——
      // 否则"回放到第 300 帧时屏幕上有多黑"无法复现（AC-05）。
      this.inkPollution,
    ]
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
        b.removed ? 1 : 0,
        // 敌人行为状态（第 20 轮）：被缠的丝位 / 缠绕剩余 / 缠绕冷却 / 开火冷却 / 墨点寿命。
        // 少一个都会让"回放的某一帧开始分叉"变得无法解释。
        b.entangleRope,
        b.entangleRemaining,
        b.entangleCooldown,
        b.fireCooldown,
        b.dotLife,
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
