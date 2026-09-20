/**
 * 《牵丝》确定性物理内核 —— **三类敌人的行为**（FR-CBT-001 / FR-CBT-011 / FR-CBT-012）。
 *
 * 设计文档（§4.1）只给了敌人的**弱点与血量**，行为只写了定性一句话：
 * 「墨刃：高速游走」「墨缚：主动伸出触须缠绕丝线」「墨巢：持续生成墨卒」。
 * 这个文件把那三句话变成**可执行、可测试、确定性的规则**。
 *
 * | 敌人 | 弱点 | 行为（本文件实现） |
 * |---|---|---|
 * | 墨刃 | 切割 `v²` | 在两侧边界之间以 **9 m/s 巡逻**；到边界时**减速折返**（0.4s） |
 * | 墨缚 | **撕裂**（反向张力差 > 300） | 以 **2 m/s 逼近玩家**，进 6m 停下；每 2s 伸触须缠住最近一根已附着的丝 1.5s |
 * | 墨巢 | **承重点**（×3） | 静止；玩家进 14m 后每 1.6s 朝玩家**射一枚墨点** |
 *
 * ## 三条设计原则（这个文件里的每一行都服从它们）
 *
 * 1. **没有随机数、没有时钟。** 所有"什么时候开火 / 什么时候转向"都由 tick 倒计时决定
 *    ⇒ 同一段输入在任何设备上产生同一结果（AC-05）。
 * 2. **不新建刚体。** 墨点来自**预生成的固定池**（`INK_DOT_POOL` 枚，平时 `removed = true`）。
 *    `bodies` 数组下标就是刚体 id，长度必须全程不变 —— 这是状态哈希与性能预算的前提
 *    （`tests/perf.test.ts` 有断言守着它）。创始人第 20 轮的"墨巢改射墨点"方案
 *    正好也让这条不变量保住了（D-065）。
 * 3. **不替玩家做决定。** 墨刃/墨缚只会移动与缠丝，**不会造成任何伤害** ——
 *    R1 不实现主角承伤（FR-CBT-007 是 R2）。它们的威胁是**物理的**：
 *    撞你、挤你、把你顶下深沟（D-065 ③）。
 *
 * ## 与 world.ts 的关系
 *
 * 这里**不 import `World`**，只依赖一个结构化接口 `EnemyHost`。理由有两个：
 * ① 避免 `world ⇄ enemies` 的循环 import；
 * ② 让这一整层行为**可以在没有 World 的地方单测**（`tests/enemies.test.ts`）。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { type Body, aabb, circle, createBody, halfExtents } from './body'
import * as C from './constants'
import type { Rope } from './rope'
import { type Vec2, dist } from './vec2'

/** `world.ts` 需要向敌人层提供的全部能力（刻意做窄）。 */
export interface EnemyHost {
  readonly tick: number
  readonly player: Body
  readonly bodies: Body[]
  /** 全部丝位（含未解锁的）。敌人只关心 `attached` 的。 */
  readonly ropes: readonly Rope[]
  /**
   * 重力加速度（**带符号**，与 `WorldConfig.gravityY` 同口径：向下为负，如 −20）。
   * 墨巢解抛体角度要用它 —— 写死 20 的话，哪天有人调了重力，墨点就会全部打偏。
   */
  readonly gravityY: number
  /** 从池里取一枚休眠墨点并激活它（返回是否成功 —— 池子空了就失败）。 */
  spawnInkDot(from: Vec2, vel: Vec2): boolean
  /** 增加视野污染（0..1 会被钳制）。 */
  addPollution(amount: number): void
  /** 发出一个模拟事件（供埋点与回放定位）。 */
  pushEvent(kind: string, detail: Record<string, unknown>): void
}

/**
 * **运行期**的宿主自检（每个宿主只做一次）。
 *
 * 为什么需要它：本仓库的测试通道是 `node --experimental-strip-types`，
 * **不做类型检查** —— `World` 少实现一个方法，编译器不会说话，
 * 只会在跑到那一行时抛 `xxx is not a function`，而那通常离真正的原因很远。
 * 这里把"宿主接口不完整"变成一句能立刻读懂的报错。
 */
const VERIFIED_HOSTS = new WeakSet<object>()

function assertHost(w: EnemyHost): void {
  if (VERIFIED_HOSTS.has(w)) return
  const required = ['spawnInkDot', 'addPollution', 'pushEvent'] as const
  for (const k of required) {
    if (typeof (w as unknown as Record<string, unknown>)[k] !== 'function') {
      throw new Error(`EnemyHost 缺少方法 ${k}() —— 敌人层无法工作（见 core/enemies.ts 的接口定义）`)
    }
  }
  if (!Array.isArray(w.bodies) || !Array.isArray(w.ropes)) {
    throw new Error('EnemyHost 的 bodies / ropes 必须是数组')
  }
  if (!Number.isFinite(w.gravityY)) {
    throw new Error('EnemyHost 的 gravityY 必须是有限数（墨巢解抛体角度要用它）')
  }
  VERIFIED_HOSTS.add(w)
}

// ── 语义标签：用名字认敌人 ─────────────────────────────
//
// 为什么按 `name` 而不是新增一个 `enemyKind` 字段：刚体表是**场景数据**，
// 名字已经是它唯一的语义标识（`mote` / `armor` / …）。再加一个字段意味着
// 每个场景都要同步填两处，迟早会不一致。
// 代价是"名字拼错就静默失效"，所以下面把三个名字做成常量，并由测试锁住。

export const BLADE_NAME = 'blade'
export const BIND_NAME = 'bind'
export const NEST_NAME = 'nest'

export function isBlade(b: Body): boolean {
  return b.name === BLADE_NAME
}
export function isBind(b: Body): boolean {
  return b.name === BIND_NAME
}
export function isNest(b: Body): boolean {
  return b.name === NEST_NAME
}

/** 出丝点（与 `world.anchorOf` 同口径：主角从胸口出丝）。 */
function anchorOf(b: Body): Vec2 {
  if (b.tag === 'player') return { x: b.pos.x, y: b.pos.y + C.PLAYER_HAND_OFFSET_Y }
  return b.pos
}

// ── 主入口 ────────────────────────────────────────────

/**
 * 推进所有敌人的行为。**在 `world.step()` 的物理积分之前调用**。
 *
 * 顺序固定为 墨刃 → 墨缚 → 墨巢 → 墨点回收 ⇒ 确定性。
 */
export function stepEnemies(w: EnemyHost): void {
  assertHost(w)
  stepBlades(w)
  stepBinds(w)
  stepNests(w)
  stepInkDotHits(w)
  stepTear(w)
  recycleInkDots(w)
}

// ── 墨刃：高速巡逻 ────────────────────────────────────

/**
 * 墨刃的巡逻范围：以**入场位置**为中心、`patrolHalfWidth` 为半宽。
 *
 * 为什么用"入场位置"而不是绝对坐标：这样场景只要写一个 x，
 * 巡逻带跟着它走 —— 关卡重排时不会漏改一个藏在 constants 里的边界。
 */
export function bladePatrolCenter(b: Body): number {
  return b.patrolCenterX
}

function stepBlades(w: EnemyHost): void {
  for (const b of w.bodies) {
    if (b.removed || !b.alive || !isBlade(b)) continue

    const half = b.patrolHalfWidth
    const center = b.patrolCenterX
    const minX = center - half
    const maxX = center + half

    // 方向由 `vel.x` 的符号决定；为 0 时（刚生成）朝右。
    let dir = b.vel.x >= 0 ? 1 : -1

    // 距边界的距离。**先用它判折返，再拿它算减速** —— 顺序不能反：
    // 第一版是"等 `pos.x` 越过边界才折返"，而减速让速度在边界处趋近 0
    // ⇒ 位置**渐近逼近**边界、永远不越界 ⇒ 它就卡在边界前不动了（实测 vx 按 0.706 衰减到 0）。
    let distToEdge = dir > 0 ? maxX - b.pos.x : b.pos.x - minX
    if (distToEdge <= 0.02) {
      dir = -dir
      distToEdge = dir > 0 ? maxX - b.pos.x : b.pos.x - minX
    }

    // **直接写速度，不做加速度积分**。
    //
    // 第一版用的是"加速度逼近目标速度"，结果墨刃速度被地面的摩擦冲量吃掉一大截。
    // M0 的墨甲脚本早就是直接赋值的，这里沿用同一条做法：
    // **脚本化的敌人用速度级控制，不跟摩擦较劲**。
    //
    // 折返的"看得见"由**接近边界时减速**实现：距边界不足
    // `BLADE_PATROL_SPEED × BLADE_TURN_SECONDS / 2` 米时按比例降速，
    // 到边界那一刻速度正好最低，然后反向加速离开。
    const turnDist = (C.BLADE_PATROL_SPEED * C.BLADE_TURN_SECONDS) / 2
    const ramp = Math.min(1, Math.max(0, distToEdge / turnDist))
    b.vel.x = dir * C.BLADE_PATROL_SPEED * ramp
    // 墨刃没有竖直行为：它贴地滑行（半高 0.12，看起来就是"一片墨"）
    b.vel.y = 0
  }
}

// ── 墨缚：逼近 + 缠丝 ────────────────────────────────

function stepBinds(w: EnemyHost): void {
  const p = w.player
  for (const b of w.bodies) {
    if (b.removed || !b.alive || !isBind(b)) continue

    // ① 倒计时：先松开到期的缠绕，再考虑新的
    if (b.entangleRemaining > 0) {
      b.entangleRemaining -= C.DT
      if (b.entangleRemaining <= 0) {
        b.entangleRemaining = 0
        if (b.entangleRope >= 0) {
          w.pushEvent('bind-release', { body: b.id, rope: b.entangleRope })
          b.entangleRope = -1
        }
      }
    } else if (b.entangleCooldown > 0) {
      b.entangleCooldown -= C.DT
      if (b.entangleCooldown < 0) b.entangleCooldown = 0
    }

    // ② 移动：朝玩家逼近到 `BIND_RANGE` 就停
    //
    // 同样**直接写速度**（理由见 `stepBlades`：脚本化敌人不与地面摩擦较劲）。
    const dx = p.pos.x - b.pos.x
    const d = Math.abs(dx)
    if (d > C.BIND_RANGE) {
      b.vel.x = (dx >= 0 ? 1 : -1) * C.BIND_SPEED
    } else {
      b.vel.x = 0
    }
    b.vel.y = 0

    // ③ 缠绕：在射程内、有已附着的丝、且没在缠绕中 ⇒ 尝试缠最近的一根
    if (b.entangleRope >= 0 || b.entangleCooldown > 0) continue
    if (d > C.BIND_RANGE) continue
    const rope = nearestAttachedRope(w, b)
    if (rope === null) continue
    b.entangleRope = rope.index
    b.entangleRemaining = C.BIND_DURATION_SEC
    b.entangleCooldown = C.BIND_INTERVAL_SEC
    w.pushEvent('bind-grab', { body: b.id, rope: rope.index })
  }
}

/** 离这只墨缚**最近**的那根已附着丝（按丝位顺序取，保证确定性）。 */
function nearestAttachedRope(w: EnemyHost, b: Body): Rope | null {
  let best: Rope | null = null
  let bestD = Infinity
  for (const r of w.ropes) {
    if (r.state !== 'attached') continue
    const target = w.bodies[r.targetId]
    if (target === undefined) continue
    const d = dist(b.pos, anchorOf(target))
    if (d < bestD) {
      bestD = d
      best = r
    }
  }
  return best
}

/**
 * 某根丝是否**正被墨缚缠住**（`applyRopeCommands` 用它过滤玩家指令）。
 *
 * 规则（D-065 ③ 的推荐项，创始人未逐条回答，按推荐执行）：
 * **被缠期间那根丝不能收也不能放，但可以断。**
 * 惩罚是"这段时间你少一根丝"，解是"按断"，教的是资源管理。
 */
export function ropeIsEntangled(w: EnemyHost, ropeIndex: number): boolean {
  for (const b of w.bodies) {
    if (b.removed || !b.alive || !isBind(b)) continue
    if (b.entangleRemaining > 0 && b.entangleRope === ropeIndex) return true
  }
  return false
}

/** 松开所有指向某个丝位的缠绕（断丝 / 重凝时调用 —— 丝没了，触须就该松）。 */
export function releaseEntangle(w: EnemyHost, ropeIndex: number): void {
  for (const b of w.bodies) {
    if (!isBind(b)) continue
    if (b.entangleRope === ropeIndex) {
      b.entangleRope = -1
      b.entangleRemaining = 0
    }
  }
}

// ── 墨巢：静止 + 射墨点 ──────────────────────────────

function stepNests(w: EnemyHost): void {
  const p = w.player
  for (const b of w.bodies) {
    if (b.removed || !b.alive || !isNest(b)) continue

    if (b.fireCooldown > 0) {
      b.fireCooldown -= C.DT
      if (b.fireCooldown < 0) b.fireCooldown = 0
      continue
    }

    const from = coreWorldPos(b)
    const d = dist(from, p.pos)
    if (d > C.NEST_FIRE_RANGE) continue

    // **出膛点在巢的表面上，不在巢心里**。
    //
    // 第一版直接把墨点生成在承重点（巢的内部），结果墨点一出生就和自己的巢碰撞：
    // 实测它在 x≈29.5~30.4、y≈0.2~2.3 之间来回弹，**一步都飞不出去**。
    // 出膛点沿"朝向玩家"的方向挪出巢的半宽 + 墨点半径 + 一点余量。
    const he = halfExtents(b.shape)
    const dirX = p.pos.x >= b.pos.x ? 1 : -1
    const muzzle = {
      x: b.pos.x + dirX * (he.hw + C.INK_DOT_RADIUS + 0.05),
      y: from.y,
    }

    // 朝玩家射：**要解抛体角度**，不能直接朝玩家瞄。
    //
    // 第一版就是直接朝玩家瞄的（而且速度只有 11），结果**一发都打不中**：
    // 墨点受重力 g = 20 m/s²，从 y≈1.6 朝 8m 外的玩家平射，飞 0.4 秒就落地了。
    // 只有真的跑一遍才会发现 —— 单看代码完全合理。
    const v = ballisticVelocity(muzzle, p.pos, C.INK_DOT_SPEED, -w.gravityY)
    if (v === null) {
      // 无解（太远 / 太高）⇒ 这一拍不开火。正常情况下不会发生：
      // `NEST_FIRE_RANGE`(14) 比最大射程 `v²/g`(16.2) 小，射击距离内必有解。
      b.fireCooldown = C.DT * 6
      continue
    }
    const ok = w.spawnInkDot(muzzle, v)
    // 池子空了就等下一拍再试（不切换别的行为 —— 保持规则单一）
    if (ok) {
      b.fireCooldown = C.NEST_FIRE_INTERVAL_SEC
      w.pushEvent('nest-fire', { body: b.id, x: muzzle.x, y: muzzle.y })
    } else {
      b.fireCooldown = C.DT * 6
    }
  }
}

/**
 * 抛体解算：以速度大小 `speed` 从 `from` 打中 `to`，返回速度向量。
 *
 * 取**较平的那个解**（直接射，不吊高）—— 平射飞行时间短，玩家更难过早躲开，
 * 也更像"射"而不是"扔"。无解（超出最大射程 `speed²/g`）时返回 `null`。
 */
export function ballisticVelocity(from: Vec2, to: Vec2, speed: number, g: number): Vec2 | null {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const d = Math.abs(dx)
  if (d < 1e-9) return { x: 0, y: dy >= 0 ? speed : -speed }
  const s2 = speed * speed
  const disc = s2 * s2 - g * (g * d * d + 2 * dy * s2)
  if (!(disc >= 0)) return null
  // 平射解：tanθ = (s² − √disc) / (g·d)
  const tan = (s2 - Math.sqrt(disc)) / (g * d)
  const dir = dx >= 0 ? 1 : -1
  const cos = 1 / Math.sqrt(1 + tan * tan)
  return { x: dir * speed * cos, y: speed * tan * cos }
}

/** 承重点的世界坐标。没有承重点时就是物体中心。 */
export function coreWorldPos(b: Body): Vec2 {
  if (!(b.coreRadius > 0)) return b.pos
  return { x: b.pos.x + b.coreOffset.x, y: b.pos.y + b.coreOffset.y }
}

/** 某个世界坐标点是否落在承重点内（`resolveDamage` 靠它决定 ×3 还是 ×1）。 */
export function hitCore(b: Body, point: Vec2): boolean {
  if (!(b.coreRadius > 0)) return false
  return dist(point, coreWorldPos(b)) <= b.coreRadius
}

// ── 墨点命中主角 ⇒ 污染视野 ──────────────────────────

/**
 * 墨点是**穿过主角**的（`ignorePlayer: true`），所以命中判定要单独做。
 *
 * 为什么不让它真的"撞"主角：
 * ① 主角着地时质量是 `1e6`（D-019）。一枚 0.4kg 的墨点撞上去，求解器会把它弹飞 ——
 *    于是"被射中"变成"墨点被弹开"，玩家只会觉得这敌人打不准；
 * ② 墨点的作用是**污染视野**（FR-CBT-012），不是物理推挤。它是信息的攻击，不是力的攻击。
 *
 * 判定用**圆 vs AABB 的最近点**：主角是 AABB（`PLAYER_HALF_W` × `PLAYER_HALF_H`）。
 */
function stepInkDotHits(w: EnemyHost): void {
  const p = w.player
  const hw = C.PLAYER_HALF_W
  const hh = C.PLAYER_HALF_H
  for (const b of w.bodies) {
    if (b.removed || !isInkDot(b)) continue
    const cx = clamp(b.pos.x, p.pos.x - hw, p.pos.x + hw)
    const cy = clamp(b.pos.y, p.pos.y - hh, p.pos.y + hh)
    const dx = b.pos.x - cx
    const dy = b.pos.y - cy
    if (dx * dx + dy * dy > C.INK_DOT_RADIUS * C.INK_DOT_RADIUS) continue

    retireInkDot(b)
    // 污染量由调用方（World）钳制，这里只报"被打中了一发"。
    w.addPollution(C.INK_POLLUTION_PER_HIT)
    w.pushEvent('ink-hit', {
      dot: b.id,
      pollution: C.INK_POLLUTION_PER_HIT,
      visible: 1 - C.INK_POLLUTION_PER_HIT,
    })
  }
}

// ── 墨点回收 ──────────────────────────────────────────

/**
 * 落地的 / 超时的墨点回到池子里（`removed = true`，位置冻结在原地）。
 *
 * **为什么不让它一直飞**：池子只有 6 枚。飞出去的墨点不回收，
 * 巢打几发之后就再也射不出东西了 —— 而且这个 bug 在"打 10 秒"的短测试里看不出来。
 */
function recycleInkDots(w: EnemyHost): void {
  for (const b of w.bodies) {
    if (b.removed || !isInkDot(b)) continue
    b.dotLife -= C.DT
    const outOfWorld = b.pos.y < C.CHASM_FLOOR_Y || b.pos.x < -2 || b.pos.x > C.M0_ROOM_W + 2
    if (b.dotLife <= 0 || outOfWorld) retireInkDot(b)
  }
}

export const INK_DOT_NAME_PREFIX = 'ink-dot'

export function isInkDot(b: Body): boolean {
  return b.name.startsWith(INK_DOT_NAME_PREFIX)
}

/** 让一枚墨点退出模拟（位置冻结、标记 `removed`）。 */
export function retireInkDot(b: Body): void {
  b.removed = true
  b.vel.x = 0
  b.vel.y = 0
  b.dotLife = 0
}

/** 造一枚**休眠墨点**（池子里的一员）。场景构造时调用 `INK_DOT_POOL` 次。 */
export function createInkDot(id: number, index: number): Body {
  const b = createBody({
    id,
    name: `${INK_DOT_NAME_PREFIX}${index}`,
    kind: 'dynamic',
    tag: 'hazard',
    shape: circle(C.INK_DOT_RADIUS),
    // 休眠位置放在**世界之外**（比沟底还低）：即使哪天 `removed` 逻辑出问题，
    // 它也不会突然出现在关卡里挡住玩家。
    pos: { x: 0, y: C.CHASM_FLOOR_Y - 5 },
    mass: C.INK_DOT_MASS,
    restitution: 0,
    friction: 0.2,
    // 墨点**不能被丝线附着**：它是敌人打过来的东西，不是场景道具。
    // 想"接物回掷"（设计 §4.2 第 6 条）是 R2 的心法内容，届时按心法解锁。
    anchorable: false,
    hp: 1,
  })
  // 休眠 = 完全退出模拟（不碰撞、不积分、不参与宽相位），但仍然占着 `bodies` 的一个位置。
  b.removed = true
  b.ignorePlayer = true
  return b
}

// ── 撕裂（FR-CBT-004：第 20 轮由 R3 提前到 R1）────────

/**
 * 撕裂处决：**同一目标被两根丝拉着，且张力差 > 300 ⇒ 直接击杀**（设计 §2.5）。
 *
 * ## 为什么墨缚必须现在就能被打死
 *
 * 墨缚的**唯一**弱点就是撕裂（设计 §4.1「反向力差」）。而撕裂原本是 R3 的需求 ——
 * 两者一合，R1 里做出来的墨缚**没有任何手段能打死**。这不是"难度高"，是**无解**。
 * 所以创始人第 20 轮裁决把 FR-CBT-004 提前到 R1（D-065 ①）。
 *
 * ## 为什么判据里没有"反向"
 *
 * 设计原文是「两根丝**反向**拉且张力差 > 300」。但本作的丝线模型里，
 * 一根丝的两端**永远是「主角 ⇄ 目标」**（`launch()` 从主角出丝，另一端是松手点所在的物体），
 * 从来不是「物体 ⇄ 物体」。两根丝都连在同一只墨缚身上时，
 * 它们在墨缚那一侧的方向**都指向主角** ⇒ 夹角恒接近 0，"反向"永远判不成立。
 *
 * 所以取设计里**可执行的那一半**：**两根丝都附着在该目标上，且张力差 > 300 N**。
 * 玩家要做的动作仍然是设计想教的那件事 —— **连两根丝，把张力差拉开**。
 * 这条偏离记在 DECISIONS **D-066** 里等创始人复核。
 *
 * ## 为什么墨缚是唯一允许被丝线附着的敌人
 *
 * D-038 定的是「敌人不可附着，需墨丝心法（第四章）」。但墨缚的**唯一**弱点是撕裂，
 * 而撕裂的前提就是"能连上它" —— 不破这条，墨缚依然无解。
 * 破法是**只给墨缚开一个例外**：它的设计原型本来就是"藤蔓状、主动缠绕丝线"，
 * 你把丝连到它身上读起来完全顺（它抓你的丝，你也能抓它）。
 * 记在 D-066，等创始人复核。
 */
export function stepTear(w: EnemyHost): void {
  for (const b of w.bodies) {
    if (b.removed || !b.alive || b.weakness !== 'tear') continue

    // 收集所有附着在它身上的丝（按丝位顺序 ⇒ 确定性）
    let lo: Rope | null = null
    let hi: Rope | null = null
    for (const r of w.ropes) {
      if (r.state !== 'attached' || r.targetId !== b.id) continue
      if (lo === null) lo = r
      else if (r.tension < lo.tension) {
        hi = lo
        lo = r
      } else if (hi === null || r.tension > hi.tension) {
        hi = r
      }
    }
    if (lo === null || hi === null) continue
    if (hi.tension - lo.tension <= C.TEAR_TENSION_DIFF) continue

    b.hp = 0
    b.alive = false
    w.pushEvent('tear', {
      body: b.id,
      ropeA: lo.index,
      ropeB: hi.index,
      tensionA: lo.tension,
      tensionB: hi.tension,
    })
  }
}

// ── 小工具 ────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function clampAbs(v: number, max: number): number {
  return v > max ? max : v < -max ? -max : v
}

// ── 工厂：给场景用的三个构造器 ────────────────────────

/** 造一片墨刃（场景用）。`patrolHalfWidth` = 巡逻带半宽（米）。 */
export function createBlade(id: number, x: number, patrolHalfWidth: number): Body {
  return createBody({
    id,
    name: BLADE_NAME,
    kind: 'dynamic',
    tag: 'enemy',
    shape: aabb(C.BLADE_HALF_W, C.BLADE_HALF_H),
    pos: { x, y: C.BLADE_HALF_H + 0.01 },
    mass: C.BLADE_MASS,
    /**
     * 摩擦 **0**：它是"极薄的墨片，高速游走"（设计 §4.1），半高只有 0.12m。
     *
     * 实测教训：初版给 0.05，跑出来峰值速度只有 **6.28 m/s**（设定是 9）——
     * 碰撞求解器每 tick 用地面的摩擦冲量削掉一截。脚本化的敌人是"速度级控制"，
     * 想让它真的跑 9 m/s，就不能让摩擦跟它较劲。
     */
    friction: 0,
    restitution: 0.05,
    hp: C.BLADE_HP,
    // 设计 §4.1：弱点是速度 v² —— **只吃切割**，且 `m_eff = min(4, 0.5) = 0.5 < 3`
    // 让冲击公式永远打不动它。这是设计要求（"轻物高速撞击直接被弹开"），不是 bug。
    weakness: 'cut',
    patrolHalfWidth,
  })
}

/** 造一只墨缚（场景用）。 */
export function createBind(id: number, x: number): Body {
  return createBody({
    id,
    name: BIND_NAME,
    kind: 'dynamic',
    tag: 'enemy',
    shape: aabb(C.BIND_HALF_W, C.BIND_HALF_H),
    pos: { x, y: C.BIND_HALF_H + 0.01 },
    mass: C.BIND_MASS,
    friction: 0.4,
    restitution: 0.05,
    hp: C.BIND_HP,
    // 设计 §4.1：弱点是**反向力差** ⇒ 只吃撕裂（`stepTear`），普通撞击一律 0 伤害。
    weakness: 'tear',
    /**
     * **唯一可以被丝线附着的敌人**（D-066）。
     *
     * D-038 定的是"敌人不可附着，需墨丝心法（第四章）"。但墨缚的**唯一**弱点是撕裂，
     * 而撕裂的前提就是"能连上它" —— 不开这个例外，墨缚在 R1 依然无解，
     * 那创始人把撕裂提前到 R1 的裁决就落空了。
     *
     * 它在设定上也顺：设计 §4.1 写它"藤蔓状、**主动伸出触须缠绕丝线**"——
     * 它抓你的丝，你也能抓它。
     */
    anchorable: true,
  })
}

/**
 * 造一座墨巢（场景用）。
 *
 * 巢是**静态结构**（`mass: 0` ⇒ `kind: 'static'`，永不移动）：设计 §4.1 写它
 * "固定在地形上"。与 D-047 的梁柱是同一个手法。
 *
 * `damageMass` 仍然是设计附录 B 的"语义质量"口径 —— 静态刚体的 `mass` 是 0，
 * 但伤害公式读的是 `damageMass`（见 `Body.damageMass` 的注释）。
 */
export function createNest(id: number, x: number, y = C.NEST_HALF_H + 0.01): Body {
  const b = createBody({
    id,
    name: NEST_NAME,
    kind: 'static',
    tag: 'enemy',
    shape: aabb(C.NEST_HALF_W, C.NEST_HALF_H),
    pos: { x, y },
    friction: 0.8,
    hp: C.NEST_HP,
    // 设计 §4.1：弱点是**结构承重点** ⇒ 只有打中承重点才吃伤害（×3），
    // 打别处一律 0（`damage.ts` 的 `structure` 分支）。
    weakness: 'structure',
    // 语义质量：附录 B 把墨巢记为"静止"，伤害口径上给一个重物的数（60，同梁柱）
    damageMass: 60,
    // 承重点：巢身上的一个小圆（D-065 ④，半径 0.6m）
    coreRadius: C.NEST_CORE_RADIUS,
    coreOffset: { x: C.NEST_CORE_OFFSET_X, y: C.NEST_CORE_OFFSET_Y },
  })
  // 巢不能被丝线附着（它是地形上的东西，勾它没有意义）
  b.anchorable = false
  return b
}
