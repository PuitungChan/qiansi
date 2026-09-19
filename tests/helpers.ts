/**
 * 测试脚手架：构造受控的极简世界，用于验证内核行为。
 * 本文件不叫 `*.test.ts`，因此不会被 `node --test "tests/*.test.ts"` 当作测试执行。
 */

import { type Body, aabb, circle } from '../assets/scripts/core/body'
import * as C from '../assets/scripts/core/constants'
import { type InputFrame, input } from '../assets/scripts/core/input'
import { World, type WorldConfig } from '../assets/scripts/core/world'

export const NO_INPUT: InputFrame = {
  moveX: 0,
  aimPoint: null,
  firePressed: false,
  reel: 'hold',
  cutRope: -1,
  focus: false,
}

/** 能"发射一根丝"的最小宿主：场景与世界都满足。 */
export interface FireHost {
  step(i: InputFrame): void
  readonly world: World
}

/**
 * **松手发射，并推进到丝线真的连上**。
 *
 * 第 13 轮起丝线不再瞬间成形：它要从主角**飞**到目标（`ROPE_LAUNCH_SPEED = 40 m/s`），
 * 到位那一刻才转 `attached`。所以"瞄准→发射"在测试里必须多推几帧，
 * 否则断言看到的是飞行中的 `flying` 状态。
 *
 * 最多等 `MAX_FLIGHT_TICKS`（12m 上限 / 40 m/s = 18 帧，留足余量）。
 * 返回是否连上了——不连上也可能是**预期**（松手在空白处 ⇒ 不附着）。
 */
export function fire(host: FireHost, point: { x: number; y: number }): boolean {
  const before = attachedCount(host.world)
  host.step(input({ aimPoint: point, firePressed: true }))
  for (let i = 0; i < MAX_FLIGHT_TICKS; i++) {
    if (attachedCount(host.world) > before) return true
    host.step(NO_INPUT)
  }
  return attachedCount(host.world) > before
}

const MAX_FLIGHT_TICKS = 40

/**
 * **只把丝射出去，不推进**。
 *
 * 用于断言"飞行中 / 冷却中"这类**中间状态**——`fire()` 会一路推到连上为止，
 * 那会把中间状态跳过去（用它检查"冷却期内不该连上"时，等到的是冷却结束）。
 */
export function fireNoWait(host: FireHost, point: { x: number; y: number }): void {
  host.step(input({ aimPoint: point, firePressed: true }))
}

/** 把一个裸 `World` 包成 `fire()` 能用的宿主（`World` 自己没有 `world` 字段）。 */
export function rawHost(world: World): FireHost {
  return { step: (i) => world.step(i), world }
}

function attachedCount(world: World): number {
  let n = 0
  for (const r of world.ropes) if (r.state === 'attached') n++
  return n
}

/** 无地面的纯空世界（只测绳索与物体动力学时用）。 */
export function emptyWorld(config: Partial<WorldConfig> = {}): { world: World; player: Body } {
  const world = new World(config)
  const player = world.addBody({
    name: 'player',
    kind: 'dynamic',
    tag: 'player',
    shape: aabb(C.PLAYER_HALF_W, C.PLAYER_HALF_H),
    pos: { x: 0, y: 0 },
    mass: C.PLAYER_MASS_AIRBORNE,
    friction: 0,
    restitution: 0,
  })
  world.setPlayer(player)
  return { world, player }
}

export interface FlatScene {
  world: World
  player: Body
  ground: Body
}

/** 一块无限长地面 + 一个站在地上的主角（静置后着地状态已确定）。 */
export function flatScene(
  config: Partial<WorldConfig> = {},
  opts: { playerX?: number } = {},
): FlatScene {
  const world = new World(config)
  const ground = world.addBody({
    name: 'ground',
    kind: 'static',
    tag: 'static',
    shape: aabb(200, 0.5),
    pos: { x: 0, y: -0.5 },
    friction: 0.8,
  })
  const player = world.addBody({
    name: 'player',
    kind: 'dynamic',
    tag: 'player',
    shape: aabb(C.PLAYER_HALF_W, C.PLAYER_HALF_H),
    pos: { x: opts.playerX ?? 0, y: C.PLAYER_HALF_H + 0.01 },
    mass: C.PLAYER_MASS_AIRBORNE,
    friction: 0.5,
    restitution: 0,
  })
  world.setPlayer(player)
  world.settle(10)
  return { world, player, ground }
}

/** 在地上放一个可附着物体。 */
export function addProp(
  world: World,
  opts: { x: number; mass: number; radius?: number; anchorable?: boolean; vx?: number; vy?: number },
): Body {
  const radius = opts.radius ?? 0.5
  const b = world.addBody({
    name: `prop${world.bodies.length}`,
    kind: 'dynamic',
    tag: 'prop',
    shape: circle(radius),
    pos: { x: opts.x, y: radius + 0.01 },
    vel: { x: opts.vx ?? 0, y: opts.vy ?? 0 },
    mass: opts.mass,
    friction: C.PROP_FRICTION,
    restitution: 0.1,
    anchorable: opts.anchorable ?? true,
  })
  return b
}

/** 放一只敌人。 */
export function addEnemy(
  world: World,
  opts: {
    x: number
    mass: number
    hp: number
    weakness: 'any' | 'impact' | 'cut' | 'tear' | 'structure'
    half?: number
    vx?: number
  },
): Body {
  const half = opts.half ?? 0.8
  return world.addBody({
    name: `enemy${world.bodies.length}`,
    kind: 'dynamic',
    tag: 'enemy',
    shape: aabb(half, half),
    pos: { x: opts.x, y: half + 0.01 },
    vel: { x: opts.vx ?? 0, y: 0 },
    mass: opts.mass,
    friction: 0.5,
    restitution: 0.05,
    anchorable: true,
    hp: opts.hp,
    weakness: opts.weakness,
  })
}

/** 跑 n 个 tick 的空输入，同时收集每 tick 的事件。 */
export function runIdle(world: World, n: number): void {
  for (let i = 0; i < n; i++) world.step(NO_INPUT)
}

export function speedOf(b: Body): number {
  return Math.hypot(b.vel.x, b.vel.y)
}
