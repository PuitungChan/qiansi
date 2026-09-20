/**
 * 《牵丝》—— **敌人训练场**（第 20 轮新增 / FR-CBT-001 / FR-CBT-011 / FR-CBT-012）。
 *
 * ## 为什么不把三类敌人塞进已有的场景
 *
 * · **序章**（12 分钟）的节奏已经排满，设计里这三类敌人出现在第 5 分钟**之后**的关卡；
 *   把它们塞进序章需要单独一轮讨论"放哪一段、教什么"（D-065 ④）。
 * · **M0 沙盒**是"手感"的基准：它有一条**演示脚本 + 锁定哈希**（`tests/demo.test.ts`）。
 *   往里加三具会互相碰撞的刚体，等于把那条基线搅浑 ——
 *   而"手感有没有变"这个问题的答案就变得不可读了。
 *
 * 所以新开一个房间：**同样的地形骨架、同样的主角与石块，加上三类敌人和一个墨巢**。
 * 它的用途是"验证这三类敌人的行为对不对"，不是"好玩"。
 *
 * ## 这个房间里的东西（一个都不多）
 *
 * | 刚体 | 作用 |
 * |---|---|
 * | 地形（地面/顶/两面墙） | 与 M0 同一套尺寸（32m × 18m） |
 * | 主角 | 站在左侧 |
 * | 石块 | 唯一的弹丸 —— 用来验证"墨刃必须用高速弹丸打" |
 * | **墨刃** | 右侧来回巡逻（9 m/s）。**只吃切割**：石块 15 m/s 打它 3.75 伤害 |
 * | **墨缚** | 会朝你走过来并**缠住你的丝**。唯一解法是**撕裂**（两根丝反向拉） |
 * | **墨巢** | 静止在右上角，朝你**射墨点**污染视野。打**承重点**才掉血（×3） |
 * | 墨点 ×6 | **预生成的池子**（平时休眠）—— 见 `enemies.ts` 里"为什么不新建刚体" |
 *
 * ## 怎么玩（给试玩的人）
 *
 * 1. 往右走，墨缚会迎上来，**连一根丝到它身上**，你会看到丝"不能收"了 —— 那是触须；
 * 2. 再连第二根丝（`N` 键把丝位调到 2），**朝反方向走**，两根丝的张力差拉开 ⇒ 撕裂；
 * 3. 靠近墨巢（14m 内）它开始射墨点，**被打中屏幕会变黑**，打掉巢就恢复；
 * 4. 墨刃只吃高速弹丸：连石块 → 甩起来 → 断，15 m/s 以上才有伤害。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { type Body, aabb, circle } from './body'
import * as C from './constants'
import { createBind, createBlade, createInkDot, createNest } from './enemies'
import type { InputFrame } from './input'
import type { Guidance, PlayableScene } from './playable'
import { World, type WorldConfig } from './world'

/** 墨刃的巡逻带（中心 ± 半宽）。放在右侧，与 M0 的墨甲区不重叠。 */
export const BLADE_CENTER_X = 24
export const BLADE_PATROL_HALF_WIDTH = 3
/** 墨缚的出生点（左侧一点，它会朝玩家走过来）。 */
export const BIND_SPAWN_X = 19
/** 墨巢的位置：右上角的"地形上的东西"。 */
export const NEST_X = 30

interface Spawn {
  readonly body: Body
  readonly x: number
  readonly y: number
  readonly removed: boolean
}

export class EnemyTrainingScenario implements PlayableScene {
  readonly world: World
  readonly player: Body
  readonly stone: Body
  readonly blade: Body
  readonly bind: Body
  readonly nest: Body

  private readonly spawns: Spawn[] = []
  private scripted = 0

  constructor(config: Partial<WorldConfig> = {}) {
    // **预建 2 个丝位**：这个房间的核心玩法（撕裂墨缚）需要两根丝，
    // 而 `WorldConfig.ropeCount` 同时是"丝位总槽数"与"开局解锁数"。
    // 预建而不是运行时 push —— 数组下标就是丝位编号（同 `scene_prologue.ts` 的做法）。
    const cfg: Partial<WorldConfig> = { ...config }
    if ((cfg.ropeCount ?? 0) < 2) cfg.ropeCount = 2
    this.world = new World(cfg)
    const w = this.world

    // ── 地形：与 M0 相同的 32m × 18m 房间 ──
    const ground = w.addBody({
      name: 'ground',
      kind: 'static',
      tag: 'static',
      shape: aabb(C.M0_ROOM_W / 2, 0.5),
      pos: { x: C.M0_ROOM_W / 2, y: -0.5 },
      friction: 0.8,
    })
    const ceil = w.addBody({
      name: 'ceiling',
      kind: 'static',
      tag: 'static',
      shape: aabb(C.M0_ROOM_W / 2, 0.5),
      pos: { x: C.M0_ROOM_W / 2, y: C.M0_ROOM_H + 0.5 },
      friction: 0.2,
    })
    const leftWall = w.addBody({
      name: 'wall-left',
      kind: 'static',
      tag: 'static',
      shape: aabb(0.5, C.M0_ROOM_H / 2),
      pos: { x: -0.5, y: C.M0_ROOM_H / 2 },
      friction: 0.2,
    })
    const rightWall = w.addBody({
      name: 'wall-right',
      kind: 'static',
      tag: 'static',
      shape: aabb(0.5, C.M0_ROOM_H / 2),
      pos: { x: C.M0_ROOM_W + 0.5, y: C.M0_ROOM_H / 2 },
      friction: 0.2,
    })

    // ── 主角与石块（与 M0 同参数，手感可比）──
    const player = w.addBody({
      name: 'player',
      kind: 'dynamic',
      tag: 'player',
      shape: aabb(C.PLAYER_HALF_W, C.PLAYER_HALF_H),
      pos: { x: 4, y: C.PLAYER_HALF_H + 0.01 },
      mass: C.PLAYER_MASS_AIRBORNE,
      friction: 0.5,
      restitution: 0,
    })
    w.setPlayer(player)

    const stone = w.addBody({
      name: 'stone',
      kind: 'dynamic',
      tag: 'prop',
      shape: circle(0.5),
      pos: { x: 8, y: 0.51 },
      mass: 4,
      friction: C.PROP_FRICTION,
      restitution: 0.1,
      anchorable: true,
    })

    // ── 三类敌人 ──
    //
    // 用 `enemies.ts` 的工厂 + `adoptBody()`，而**不是**在这里把参数再写一遍：
    // 敌人的质量/弱点/HP/巡逻带只允许有一个定义处（见 `World.adoptBody` 的注释）。
    const blade = w.adoptBody(createBlade(w.bodies.length, BLADE_CENTER_X, BLADE_PATROL_HALF_WIDTH))
    const bind = w.adoptBody(createBind(w.bodies.length, BIND_SPAWN_X))
    const nest = w.adoptBody(createNest(w.bodies.length, NEST_X))

    // ── 墨点池（**预生成**，平时休眠）──
    //
    // 这一段就是"D-065 ② 让不变量活下来"的实现：`INK_DOT_POOL` 枚墨点在这里
    // 一次性建好，之后**永远只在这 6 个槽位之间复用**，绝不在运行时 push。
    for (let i = 0; i < C.INK_DOT_POOL; i++) {
      w.adoptBody(createInkDot(w.bodies.length, i))
    }

    this.player = player
    this.stone = stone
    this.blade = blade
    this.bind = bind
    this.nest = nest

    for (const b of [ground, ceil, leftWall, rightWall, player, stone, blade, bind, nest]) {
      this.spawns.push({ body: b, x: b.pos.x, y: b.pos.y, removed: false })
    }
    // 墨点也要记进复位表（它们的"初态"就是休眠）
    for (const b of w.bodies) {
      if (b.name.startsWith('ink-dot')) {
        this.spawns.push({ body: b, x: b.pos.x, y: b.pos.y, removed: true })
      }
    }

    w.settle(12)
  }

  step(input: InputFrame): void {
    this.world.step(input)
    this.scripted++
  }

  reset(): void {
    for (const s of this.spawns) {
      s.body.pos = { x: s.x, y: s.y }
      s.body.vel = { x: 0, y: 0 }
      s.body.grounded = false
      s.body.hp = s.body.maxHp
      s.body.alive = true
      s.body.ignorePlayer = false
      s.body.removed = s.removed
      s.body.entangleRope = -1
      s.body.entangleRemaining = 0
      s.body.entangleCooldown = 0
      s.body.fireCooldown = 0
      s.body.dotLife = 0
    }
    this.world.tick = 0
    this.world.stunRemaining = 0
    this.world.inkPollution = 0
    for (const r of this.world.ropes) {
      r.state = 'idle'
      r.targetId = -1
      r.targetLength = 0
      r.length = 0
      r.tension = 0
      r.recongealRemaining = 0
      r.peakTension = 0
      r.lastBreakReason = 'none'
    }
    for (let i = 0; i < this.world.chains.length; i++) this.world.chains[i] = null
    this.scripted = 0
    this.world.settle(12)
  }

  /** 训练场是**调试用的房间**，不给教学提示（引导由渲染层的物体标签承担）。 */
  hint(): string | null {
    return null
  }

  /**
   * 这个房间**刻意不给引导文字**。
   *
   * 理由：它的用途是"验证敌人行为对不对"，任何文字都会让我在试玩时看到"我以为的样子"，
   * 而不是"敌人实际的样子"。想知道哪个是哪个，看小字标签（`L` 键）。
   */
  guidance(): Guidance {
    return { goal: '', step: '', notes: [] }
  }

  glowBodyId(): number {
    return -1
  }

  summary(): Record<string, number | string> {
    const w = this.world
    const live = w.bodies.filter((b) => b.name.startsWith('ink-dot') && !b.removed).length
    return {
      tick: w.tick,
      scripted: this.scripted,
      playerX: this.player.pos.x,
      playerY: this.player.pos.y,
      playerGrounded: this.player.grounded ? 1 : 0,
      stoneSpeed: Math.hypot(this.stone.vel.x, this.stone.vel.y),
      bladeX: this.blade.pos.x,
      bladeHp: this.blade.hp,
      bladeAlive: this.blade.alive ? 1 : 0,
      bindHp: this.bind.hp,
      bindAlive: this.bind.alive ? 1 : 0,
      // `-1` = 没缠任何丝；否则是被缠的丝位下标
      bindEntangleRope: this.bind.entangleRope,
      bindEntangleSec: this.bind.entangleRemaining,
      nestHp: this.nest.hp,
      nestAlive: this.nest.alive ? 1 : 0,
      inkDotsLive: live,
      // 视野污染：0 = 全屏可见，越大越黑（上限 0.65）
      pollution: w.inkPollution,
      visible: w.visibleRatio(),
      rope0: w.ropes[0]?.state ?? 'none',
      rope1: w.ropes[1]?.state ?? 'none',
      hash: w.stateHash(),
    }
  }
}
