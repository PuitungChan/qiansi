/**
 * 测试脚手架：构造受控的极简世界，用于验证内核行为。
 * 本文件不叫 `*.test.ts`，因此不会被 `node --test "tests/*.test.ts"` 当作测试执行。
 */

import { type Body, aabb, circle } from '../assets/scripts/core/body'
import * as C from '../assets/scripts/core/constants'
import type { InputFrame } from '../assets/scripts/core/input'
import { World, type WorldConfig } from '../assets/scripts/core/world'

export const NO_INPUT: InputFrame = {
  moveX: 0,
  aimPoint: null,
  attachPressed: false,
  reel: 'hold',
  cutRope: -1,
  focus: false,
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
    friction: 0.4,
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
