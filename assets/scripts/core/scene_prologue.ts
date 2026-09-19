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
 * | 3:00–5:00 | **第一个墨卒 ★** | ⬜ 批 2 |
 * | 5:00–8:00 | 质量差 | ⬜ 批 3 |
 * | 8:00–12:00 | 双丝 + 深沟 | ⬜ 批 4 |
 *
 * ## 批 1 的设计要点（全部来自设计 §7 原文）
 *
 * - 0:00–1:00「空场景。一块石头。屏幕上只有一行提示：『按住，拖向石头』。」
 * - 1:00–2:00「提示：『按住不放』。石头被拉向主角……石头悬在半空，开始摆动。」
 * - 2:00–3:00「提示：『点一下丝线』。石头飞出，砸碎一个陶罐。
 *   **不教"这可以用来打架"，只教"这会让东西飞"。**」
 *
 * 所以批 1 **一个敌人都没有**，提示只教三个动作。3:00 之后进入没有提示的墨卒段落（批 2）。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { type Body, aabb, circle } from './body'
import * as C from './constants'
import { advanceHints, createHintState, hintText, type HintState } from './hints'
import type { InputFrame } from './input'
import type { PlayableScene } from './playable'
import { World, type WorldConfig } from './world'

/** 序章出场位置（米）。全部集中在这里，方便关卡调参。 */
export const PROLOGUE = {
  playerX: 4,
  stoneX: 8,
  /** 陶罐放在投掷方向上 ~5m 处：够远到必须"扔"，又远在射程内（D-039 的有效射程 ~15m）。 */
  jarX: 13,
} as const

interface Spawn {
  readonly body: Body
  readonly x: number
  readonly y: number
}

export class PrologueScene implements PlayableScene {
  readonly world: World
  readonly player: Body
  /** 唯一的弹丸。设计 §7 0:00「空场景。一块石头。」 */
  readonly stone: Body
  /** 可破坏场景物。设计 §7 2:00–3:00 的靶子。 */
  readonly jar: Body

  private hints: HintState = createHintState()
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
    // 正好等价于"必须以投掷速度砸上去才会碎"，不需要为它单开一条规则。
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

    this.player = player
    this.stone = stone
    this.jar = jar
    this.spawns.push(
      { body: ground, x: ground.pos.x, y: ground.pos.y },
      { body: ceil, x: ceil.pos.x, y: ceil.pos.y },
      { body: leftWall, x: leftWall.pos.x, y: leftWall.pos.y },
      { body: rightWall, x: rightWall.pos.x, y: rightWall.pos.y },
      { body: player, x: player.pos.x, y: player.pos.y },
      { body: stone, x: stone.pos.x, y: stone.pos.y },
      { body: jar, x: jar.pos.x, y: jar.pos.y },
    )

    w.settle(12)
  }

  step(input: InputFrame): void {
    this.world.step(input)
    advanceHints(this.hints, input, this.world.events)
  }

  /** 设计 §7 的三句提示。学完就**什么都不显示**（这是正常状态）。 */
  hint(): string | null {
    return hintText(this.hints)
  }

  /** 教学进度（调试面板与埋点用）。 */
  hintProgress(): HintState {
    return { ...this.hints }
  }

  /** 陶罐是否已被砸碎。 */
  get jarBroken(): boolean {
    return !this.jar.alive
  }

  reset(): void {
    for (const s of this.spawns) {
      s.body.pos = { x: s.x, y: s.y }
      s.body.vel = { x: 0, y: 0 }
      s.body.grounded = false
      s.body.hp = s.body.maxHp
      s.body.alive = true
      s.body.ignorePlayer = false
      s.body.removed = false
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
    this.world.settle(12)
  }

  summary(): Record<string, number | string> {
    const w = this.world
    const r0 = w.ropes[0]
    return {
      scene: '序章·批1（0:00–3:00）',
      tick: w.tick,
      stun: w.stunRemaining,
      playerX: this.player.pos.x,
      playerY: this.player.pos.y,
      playerGrounded: this.player.grounded ? 1 : 0,
      playerMass: this.player.mass,
      stoneX: this.stone.pos.x,
      stoneSpeed: Math.hypot(this.stone.vel.x, this.stone.vel.y),
      jarX: this.jar.pos.x,
      jarBroken: this.jarBroken ? 1 : 0,
      ropeState: r0?.state ?? 'none',
      ropeLength: r0?.length ?? 0,
      ropeTension: r0?.tension ?? 0,
      hint: this.hint() ?? '(无)',
      hash: w.stateHash(),
    }
  }
}
