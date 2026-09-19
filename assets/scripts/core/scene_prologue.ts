/**
 * 《牵丝》—— 序章场景（R1 / M1 的实现对象）。
 *
 * 按 **D-043** 分批实现设计 §7 的序章前 12 分钟。当前进度：
 *
 * | 时间段 | 内容 | 状态 |
 * |---|---|---|
 * | 0:00–1:00 | 牵 | ✅ 批 1 |
 * | 1:00–2:00 | 收 | ✅ 批 1 |
 * | 2:00–3:00 | 断（砸碎陶罐） | ✅ 批 1 |
 * | 3:00–5:00 | **第一个墨卒 ★** | ✅ 批 2 |
 * | 5:00–8:00 | 质量差 | ⬜ 批 3 |
 * | 8:00–12:00 | 双丝 + 深沟 | ⬜ 批 4 |
 *
 * ## 两个阶段之间怎么切换（一条需要创始人确认的判断）
 *
 * 设计 §7 用**时间轴**写序章（0:00–1:00、3:00–5:00……）。但这个时间轴是**设计的节奏意图**，
 * 不是可执行的规则——而同一节又写着「**连上后**……提示消失」，说明它更在意"玩家做到了"。
 *
 * 所以本场景用**进度门控**：玩家把牵/收/断三件事都做过之后（`hintStep === 'done'`），
 * 再等 1 秒，墨卒入场。理由：手慢的玩家不该在还没学会"牵"的时候就面对敌人——
 * 那会让 AC-01 测出的不是"会不会自己想"，而是"看不看得懂"。
 *
 * ## 3:00–5:00 是**没有任何提示**的两分钟
 *
 * 设计 §7 原文：「这是整个游戏最重要的一分钟。玩家必须自己把前三个动作串起来。」
 * 唯一的保底是**石头微微发光**（60 秒没动作时触发，**不弹文字**）。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { type Body, aabb, circle } from './body'
import * as C from './constants'
import { advanceHints, createHintState, hintStep, hintText, type HintState } from './hints'
import type { InputFrame } from './input'
import type { PlayableScene } from './playable'
import { Telemetry } from './telemetry'
import { World, type WorldConfig } from './world'

/** 序章出场位置（米）。全部集中在这里，方便关卡调参。 */
export const PROLOGUE = {
  playerX: 4,
  stoneX: 8,
  /** 陶罐放在投掷方向上 ~5m 处：够远到必须"扔"，又远在射程内（D-039 的有效射程 ~15m）。 */
  jarX: 13,
} as const

/** 三件事都学会之后，墨卒入场前留的一拍（tick）。给玩家一秒钟意识到"我成了"。 */
const ENCOUNTER_DELAY_TICKS = 60

export type PrologueStage =
  /** 0:00–3:00：教牵/收/断，有提示 */
  | 'tutorial'
  /** 3:00–5:00：墨卒入场，**零提示** */
  | 'encounter'
  /** 5:00–8:00：质量差教学（重梁柱 vs 轻陶罐），**零提示** */
  | 'massdiff'

interface Spawn {
  readonly body: Body
  readonly x: number
  readonly y: number
  readonly removed: boolean
}

export class PrologueScene implements PlayableScene {
  readonly world: World
  readonly player: Body
  /** 唯一的弹丸。设计 §7 0:00「空场景。一块石头。」 */
  readonly stone: Body
  /** 可破坏场景物。设计 §7 2:00–3:00 的靶子。 */
  readonly jar: Body
  /** 第一个敌人。设计 §7 3:00–5:00，质量 1 / HP 5（附录 B「一下死，它是教学工具」）。 */
  readonly mote: Body
  /**
   * **梁柱**（设计 §2.6 / §7 5:00–8:00）：名义质量 60 的不可动结构。
   * 连上它收丝 → **你被拉过去**（"重的东西用来移动"）。
   */
  readonly beam: Body
  /**
   * **轻陶罐**（设计 §7 5:00–8:00）：质量 0.6，可附着。
   * 连上它收丝 → **它被拉过来**（"轻的东西用来打"）。
   * 与梁柱构成"质量差"的对照——这一幕**不需要任何文字**。
   */
  readonly pot: Body

  /** AC-01 埋点（D-042）。 */
  readonly telemetry = new Telemetry()

  private stage: PrologueStage = 'tutorial'
  private hints: HintState = createHintState()
  private encounterCountdown = -1
  private massDiffCountdown = -1
  private glowLatched = false
  private attachedSinceEncounter = false

  private readonly spawns: Spawn[] = []

  constructor(config: Partial<WorldConfig> = {}) {
    this.world = new World(config)
    const w = this.world

    // ── 地形：单屏房间制（FR-LVL-004），32m × 18m，与 M0 同一套尺寸 ──
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

    // ── 主角 ──
    const player = w.addBody({
      name: 'player',
      kind: 'dynamic',
      tag: 'player',
      shape: aabb(C.PLAYER_HALF_W, C.PLAYER_HALF_H),
      pos: { x: PROLOGUE.playerX, y: C.PLAYER_HALF_H + 0.01 },
      mass: C.PLAYER_MASS_AIRBORNE,
      friction: 0.5,
      restitution: 0,
    })
    w.setPlayer(player)

    // ── 石块：设计 §2.6 质量 4，万用弹丸 ──
    const stone = w.addBody({
      name: 'stone',
      kind: 'dynamic',
      tag: 'prop',
      shape: circle(0.5),
      pos: { x: PROLOGUE.stoneX, y: 0.51 },
      mass: 4,
      friction: C.PROP_FRICTION,
      restitution: 0.1,
      anchorable: true,
    })

    // ── 陶罐：设计 §2.6 质量 0.6「高速弹丸」；本段当作**可破坏靶子**使用 ──
    //
    // 为什么它一碰就碎、而敌人不是：陶罐 HP = 1 且弱点是 `any`，于是
    //   · 冲击公式要求 m_eff ≥ 3 ⇒ min(4, 0.6) = 0.6 被挡下
    //   · 切割公式 v²/60 ⇒ v ≈ 7.8 m/s 时达到 1 点伤害
    // 正好等价于"必须以投掷速度砸上去才会碎"，不需要为它单开一条规则（D-044）。
    const jar = w.addBody({
      name: 'jar',
      kind: 'dynamic',
      tag: 'prop',
      shape: circle(0.3),
      pos: { x: PROLOGUE.jarX, y: 0.31 },
      mass: 0.6,
      friction: C.PROP_FRICTION,
      restitution: 0.1,
      anchorable: false, // 陶罐是弹药，不是锚点
      hp: 1,
      weakness: 'any',
      shattersOnDeath: true,
    })

    // ── 墨卒：**构造时就建好，但先 `removed`** ────────────────
    //
    // 为什么不等到遭遇战再 addBody：**`bodies` 数组的下标就是刚体 id**，
    // 中途 push 一个进去会让求解器顺序改变、哈希漂移（AC-05 直接崩）。
    // 所以先占好 id，用 `removed` 控制它是否"存在于场上"。
    const mote = w.addBody({
      name: 'mote',
      kind: 'dynamic',
      tag: 'enemy',
      shape: circle(0.4),
      pos: { x: C.MOTE_SPAWN_X, y: 0.41 },
      mass: C.MOTE_MASS,
      friction: 0.4,
      restitution: 0.05,
      anchorable: false, // R1 阶段敌人不可被牵（D-038）
      hp: C.MOTE_HP,
      weakness: 'any', // 设计 §4.1：墨卒「弱点：任意」
    })
    mote.removed = true

    // ── 梁柱：**不可动的结构**（设计 §2.6 定性为"锚点与移动手段"）────
    //
    // 为什么 static：见 constants.ts 里 BEAM_* 的推导——设计 §2.2 与 §7
    // 在"谁被拉过去"上互相矛盾，取 §2.6 的定性（它是锚点）才能让 §7 成立。
    //
    // 为什么横在高处（y≈13）而不是竖在地上：
    // ① 竖在地上的柱子会挡住墨卒的行走路线与投掷弹道；
    // ② 从下方收丝时，拉力有明显向上分量 → 玩家**被拽离地面** →
    //    "离地"状态与后续的摆荡才有起点（设计 §4.2 摆荡要求"离地状态"）。
    const beam = w.addBody({
      name: 'beam',
      kind: 'static',
      tag: 'static',
      shape: aabb(C.BEAM_HALF_W, C.BEAM_HALF_H),
      pos: { x: C.BEAM_CENTER_X, y: C.BEAM_CENTER_Y },
      damageMass: C.BEAM_DAMAGE_MASS, // 名义质量 60（静态刚体的 mass 是 0）
      friction: 0.4,
      anchorable: true,
    })

    // ── 轻陶罐：质量差教学的"轻"那一端（5:00 才给出，先 removed）──
    const pot = w.addBody({
      name: 'pot',
      kind: 'dynamic',
      tag: 'prop',
      shape: circle(C.POT_RADIUS),
      pos: { x: C.POT_SPAWN_X, y: C.POT_RADIUS + 0.01 },
      mass: C.POT_MASS,
      friction: C.PROP_FRICTION,
      restitution: 0.1,
      anchorable: true,
    })
    pot.removed = true

    this.player = player
    this.stone = stone
    this.jar = jar
    this.mote = mote
    this.beam = beam
    this.pot = pot
    this.spawns.push(
      { body: ground, x: ground.pos.x, y: ground.pos.y, removed: false },
      { body: ceil, x: ceil.pos.x, y: ceil.pos.y, removed: false },
      { body: leftWall, x: leftWall.pos.x, y: leftWall.pos.y, removed: false },
      { body: rightWall, x: rightWall.pos.x, y: rightWall.pos.y, removed: false },
      { body: player, x: player.pos.x, y: player.pos.y, removed: false },
      { body: stone, x: stone.pos.x, y: stone.pos.y, removed: false },
      { body: jar, x: jar.pos.x, y: jar.pos.y, removed: false },
      { body: mote, x: mote.pos.x, y: mote.pos.y, removed: true },
      { body: beam, x: beam.pos.x, y: beam.pos.y, removed: false },
      { body: pot, x: pot.pos.x, y: pot.pos.y, removed: true },
    )

    w.settle(12)
  }

  // ── 主循环 ──────────────────────────────────────────

  step(input: InputFrame): void {
    this.advanceStage()
    this.scriptMote()

    this.world.step(input)

    advanceHints(this.hints, input, this.world.events)
    this.trackEncounter(input)
    this.updateGlow()

    this.telemetry.consume(this.world, input)
  }

  /** 教学阶段 → 遭遇战 → 质量差。见文件头"进度门控"的说明。 */
  private advanceStage(): void {
    if (this.stage === 'tutorial') {
      this.advanceFromTutorial()
      return
    }
    if (this.stage === 'encounter') {
      this.advanceFromEncounter()
    }
  }

  private advanceFromTutorial(): void {
    if (this.encounterCountdown < 0) {
      if (hintStep(this.hints) !== 'done') return
      this.encounterCountdown = ENCOUNTER_DELAY_TICKS
      return
    }

    this.encounterCountdown--
    if (this.encounterCountdown > 0) return

    // 墨卒入场
    this.stage = 'encounter'
    this.mote.removed = false
    this.mote.pos = { x: C.MOTE_SPAWN_X, y: 0.41 }
    this.mote.vel = { x: 0, y: 0 }
    this.telemetry.startEncounter(this.world.tick)
  }

  /**
   * 遭遇战结束 → 质量差。
   *
   * 结束条件是**墨卒被击杀**，或者**到了设计给的两分钟上限**（`ENCOUNTER_MAX_SEC`）。
   * 后者是为了**不卡死**：一个没打死墨卒的试玩者不该永远停在这一段、看不到后面的内容。
   * 它**不影响 AC-01 的判定**——`ac01Seconds()` 仍然只认"60 秒内、用石块"。
   */
  private advanceFromEncounter(): void {
    if (this.massDiffCountdown < 0) {
      const elapsedSec = (this.world.tick - this.encounterStartTick()) / C.TICK_HZ
      const done = !this.mote.alive || elapsedSec >= C.ENCOUNTER_MAX_SEC
      if (!done) return
      this.massDiffCountdown = ENCOUNTER_DELAY_TICKS
      return
    }

    this.massDiffCountdown--
    if (this.massDiffCountdown > 0) return

    // 质量差段：给出轻陶罐（梁柱一直在场上，它是结构）
    this.stage = 'massdiff'
    this.pot.removed = false
    this.pot.pos = { x: C.POT_SPAWN_X, y: C.POT_RADIUS + 0.01 }
    this.pot.vel = { x: 0, y: 0 }
    this.telemetry.markStage(this.world.tick, 'massdiff')
  }

  /**
   * 墨卒的行为：**朝主角缓慢爬来**（设计 §7「一个墨卒从右侧缓慢爬来」），
   * 到跟前就停下——它是教学工具，不该挤到玩家身上。
   * 全部由脚本驱动，无随机 ⇒ 确定性不受影响。
   */
  private scriptMote(): void {
    const m = this.mote
    if (m.removed || !m.alive) {
      m.vel = { x: 0, y: m.vel.y }
      return
    }
    const gap = m.pos.x - this.player.pos.x
    if (gap > C.MOTE_STOP_DISTANCE) m.vel = { x: -C.MOTE_SPEED, y: m.vel.y }
    else if (gap < -C.MOTE_STOP_DISTANCE) m.vel = { x: C.MOTE_SPEED, y: m.vel.y }
    else m.vel = { x: 0, y: m.vel.y }
  }

  private trackEncounter(input: InputFrame): void {
    void input
    if (this.stage !== 'encounter') return
    for (const e of this.world.events) {
      if (e.kind === 'rope-attached') this.attachedSinceEncounter = true
    }
  }

  /**
   * 克制提示（设计 §7）：60 秒没有动作 → 石头微微发光，**不弹文字**。
   * 一旦玩家牵上丝线（他开始动手了）就永久熄灭——发光是给**卡住的人**的。
   */
  private updateGlow(): void {
    if (this.stage !== 'encounter' || this.glowLatched) return
    if (!this.telemetry.encounterStarted) return
    const elapsedSec =
      (this.world.tick - this.encounterStartTick()) / C.TICK_HZ
    if (elapsedSec < C.HINT_GLOW_DELAY_SEC) return
    this.glowLatched = true
    this.telemetry.markGlow(this.world.tick)
  }

  private encounterStartTick(): number {
    // encounter_start 是遭遇战的第一条事件，直接取它的 tick
    for (const e of this.telemetry.snapshot()) {
      if (e.kind === 'encounter_start') return e.tick
    }
    return this.world.tick
  }

  // ── 表现层查询 ──────────────────────────────────────

  /** 3:00 之后**不再有任何文字提示**（设计 §7）。 */
  hint(): string | null {
    if (this.stage !== 'tutorial') return null
    return hintText(this.hints)
  }

  glowBodyId(): number {
    if (!this.glowLatched || this.attachedSinceEncounter) return -1
    if (!this.mote.alive || this.mote.removed) return -1
    return this.stone.id
  }

  // ── 状态查询 ────────────────────────────────────────

  get currentStage(): PrologueStage {
    return this.stage
  }

  get jarBroken(): boolean {
    return !this.jar.alive
  }

  get moteDead(): boolean {
    return !this.mote.alive
  }

  /** 教学进度（调试面板与埋点用）。 */
  hintProgress(): HintState {
    return { ...this.hints }
  }

  // ── 复位 ────────────────────────────────────────────

  reset(): void {
    for (const s of this.spawns) {
      s.body.pos = { x: s.x, y: s.y }
      s.body.vel = { x: 0, y: 0 }
      s.body.grounded = false
      s.body.hp = s.body.maxHp
      s.body.alive = true
      s.body.ignorePlayer = false
      s.body.removed = s.removed
    }
    this.world.tick = 0
    this.world.stunRemaining = 0
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
    this.hints = createHintState()
    this.stage = 'tutorial'
    this.encounterCountdown = -1
    this.massDiffCountdown = -1
    this.glowLatched = false
    this.attachedSinceEncounter = false
    this.telemetry.clear()
    this.world.settle(12)
  }

  summary(): Record<string, number | string> {
    const w = this.world
    const r0 = w.ropes[0]
    return {
      scene: `序章·批3（${this.stage}）`,
      tick: w.tick,
      playerX: this.player.pos.x,
      playerY: this.player.pos.y,
      playerGrounded: this.player.grounded ? 1 : 0,
      playerMass: this.player.mass,
      stoneX: this.stone.pos.x,
      jarBroken: this.jarBroken ? 1 : 0,
      moteX: this.mote.removed ? '(未入场)' : this.mote.pos.x,
      moteHp: this.mote.removed ? '-' : this.mote.hp,
      pot: this.pot.removed ? '(未给出)' : this.pot.pos.x,
      beam: `${C.BEAM_CENTER_X},${C.BEAM_CENTER_Y} m=${C.BEAM_DAMAGE_MASS}`,
      ropeState: r0?.state ?? 'none',
      ropeTension: r0?.tension ?? 0,
      hint: this.hint() ?? '(无)',
      glow: this.glowBodyId() >= 0 ? '石头' : '-',
      ac01: this.telemetry.ac01Seconds() === null ? '(未达成)' : this.telemetry.ac01Seconds()!,
      hash: w.stateHash(),
    }
  }
}
