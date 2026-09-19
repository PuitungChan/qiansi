/**
 * 《牵丝》M0 灰盒房间 —— 场景装配与脚本化行为。
 *
 * M0 的交付定义（交接清单 §8）：
 *   一个 1920×1080 的灰色房间，**一块石头**，**一只墨甲**，**一个玩家方块**。
 *   验证 ① 牵/收/断三键是否直觉 ② 甩动是否有爽感 ③ 预判线是否真的帮到玩家。
 *   不做美术、不做关卡、不做叙事、不做音效、不做存档。
 *
 * 场景里只有这些刚体，**一个都不多**：地面 / 三面墙 / 主角 / 石块 / 墨甲。
 * 想加物件请等到 M1——M0 的房间是用来回答"手感"的，不是用来好玩。
 *
 * 墨甲行为见 DECISIONS D-026：**纯靶子 + 缓慢游走**，不追击、不攻击。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { type Body, aabb, circle } from './body'
import * as C from './constants'
import type { InputFrame } from './input'
import { World, type WorldConfig } from './world'

/**
 * 墨甲的往返区间（米）。
 *
 * 为什么上限是 22 而不是房间右侧的 31：这不是随手填的。重力 g = 20 m/s² 下，
 * 一个抛体能飞的最大水平距离是 `v²/g`。M0 实测石块能甩出的速度约 20–23 m/s，
 * 对应最大射程 **20–26 m**；再算上"要打得中而不是刚好够到"，交战距离必须留在
 * 这个射程以内。若把墨甲放在 16m 之外，玩家会频繁遇到"甩死了也打不到"——
 * 那会被误读成"手感不对"，而其实是**关卡尺度错了**。
 * 详见 DECISIONS D-030。
 */
export const ARMOR_PATROL_MIN_X = 9
export const ARMOR_PATROL_MAX_X = 22
/** 墨甲出生位置：在投掷射程内，但需要玩家先甩动而不是站着平推。 */
export const ARMOR_SPAWN_X = 13
/** 游走速度（m/s）。D-026 起点值。 */
export const ARMOR_PATROL_SPEED = 0.8

/** 灰盒配色（渲染层用；内核不理解颜色，只提供语义标签）。 */
export const GRAYBOX = {
  player: '#d8d8d8',
  stone: '#a8a8a8',
  armor: '#8a8a8a',
  ground: '#3a3a3a',
  wall: '#2e2e2e',
  rope: '#e8c46a',
  aim: '#7a6a3a',
} as const

interface Spawn {
  readonly body: Body
  readonly x: number
  readonly y: number
}

export class M0Scenario {
  readonly world: World
  readonly player: Body
  readonly stone: Body
  readonly armor: Body

  /** 墨甲游走方向。 */
  private patrolDir = 1
  private readonly spawns: Spawn[] = []
  /** 累计 tick（含 reset 后重新计数），供埋点与调试面板。 */
  private scripted = 0

  constructor(config: Partial<WorldConfig> = {}) {
    this.world = new World(config)
    const w = this.world

    // ── 地形：单屏房间制（FR-LVL-004），32m × 18m ──
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

    // ── 主角：0.8m × 1.6m 方块，固有质量 0.5（FR-PHY-003）──
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

    // ── 石块：质量 4，万用弹丸（设计 §2.6），可附着 ──
    // friction 用 PROP_FRICTION 而不是默认值：见 constants.ts 里的实测表 ——
    // M0 没有自转，石块只能滑，默认摩擦会让它在 12m 处就损失 44% 的速度。
    const stone = w.addBody({
      name: 'stone',
      kind: 'dynamic',
      tag: 'prop',
      shape: circle(0.5),
      pos: { x: 8, y: 0.51 },
      mass: 4,
      friction: C.PROP_FRICTION,
      restitution: 0.1,
      anchorable: true, // FR-PHY-013
    })

    // ── 墨甲：质量 20，HP 30，弱点是动量 mv（设计 §4.1 / 附录 B）──
    //
    // ⚠️ `anchorable: false` —— **R1 阶段不能把丝牵到敌人身上**。
    // 依据设计 §5 心法表：「**墨丝**（第四章中）—— 可以附着于「无相」本体 →
    // 打开的技术空间：甩动敌人打敌人（双截棍）」。也就是说"牵敌人"是第四章才解锁的能力，
    // 在此之前敌人不是可附着目标。
    // （曾误设为 true，创始人在第 5 轮实机反馈中指出。见 DECISIONS D-038。）
    const armor = w.addBody({
      name: 'armor',
      kind: 'dynamic',
      tag: 'enemy',
      shape: aabb(0.8, 0.8),
      pos: { x: ARMOR_SPAWN_X, y: 0.81 },
      mass: 20,
      friction: 0.5,
      restitution: 0.05,
      anchorable: false,
      hp: 30,
      weakness: 'impact',
    })

    this.player = player
    this.stone = stone
    this.armor = armor
    this.spawns.push(
      { body: ground, x: ground.pos.x, y: ground.pos.y },
      { body: ceil, x: ceil.pos.x, y: ceil.pos.y },
      { body: leftWall, x: leftWall.pos.x, y: leftWall.pos.y },
      { body: rightWall, x: rightWall.pos.x, y: rightWall.pos.y },
      { body: player, x: player.pos.x, y: player.pos.y },
      { body: stone, x: stone.pos.x, y: stone.pos.y },
      { body: armor, x: armor.pos.x, y: armor.pos.y },
    )

    // 静置若干 tick 让主角与石块落稳，着地状态确定后再交给你玩。
    // 这一步是确定性的（空输入 + 固定 tick 数），因此可以被回放复现。
    w.settle(12)
  }

  /** 推进一个 tick。脚本化行为在物理之前写入速度（确定性：只依赖 tick 与位置）。 */
  step(input: InputFrame): void {
    this.scriptArmor()
    this.world.step(input)
    this.scripted++
  }

  private scriptArmor(): void {
    const a = this.armor
    if (!a.alive) {
      a.vel = { x: 0, y: a.vel.y }
      return
    }
    if (a.pos.x <= ARMOR_PATROL_MIN_X) this.patrolDir = 1
    else if (a.pos.x >= ARMOR_PATROL_MAX_X) this.patrolDir = -1
    a.vel = { x: this.patrolDir * ARMOR_PATROL_SPEED, y: a.vel.y }
  }

  /** 复位到初始状态（调试面板的 R 键）。确定性：复位后 tick 归零。 */
  reset(): void {
    for (const s of this.spawns) {
      s.body.pos = { x: s.x, y: s.y }
      s.body.vel = { x: 0, y: 0 }
      s.body.grounded = false
      s.body.hp = s.body.maxHp
      s.body.alive = true
      s.body.ignorePlayer = false
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
    this.patrolDir = 1
    this.scripted = 0
    this.world.settle(12)
  }

  /** 场景摘要，调试面板与埋点用。 */
  summary(): Record<string, number | string> {
    const w = this.world
    const stone = this.stone
    return {
      tick: w.tick,
      scripted: this.scripted,
      stun: w.stunRemaining,
      playerX: this.player.pos.x,
      playerY: this.player.pos.y,
      playerVX: this.player.vel.x,
      playerVY: this.player.vel.y,
      playerGrounded: this.player.grounded ? 1 : 0,
      playerMass: this.player.mass,
      stoneSpeed: Math.hypot(stone.vel.x, stone.vel.y),
      stoneMomentum: Math.hypot(stone.momentum.x, stone.momentum.y),
      stoneKE: stone.kineticEnergy,
      armorHp: this.armor.hp,
      armorAlive: this.armor.alive ? 1 : 0,
      ropeState: w.ropes[0]?.state ?? 'none',
      ropeLength: w.ropes[0]?.length ?? 0,
      ropeTarget: w.ropes[0]?.targetLength ?? 0,
      ropeTension: w.ropes[0]?.tension ?? 0,
      ropeRatio: w.ropes[0] ? w.ropes[0].tension / w.config.tensionMax : 0,
      hash: w.stateHash(),
    }
  }
}
