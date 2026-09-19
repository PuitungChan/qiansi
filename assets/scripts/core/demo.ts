/**
 * 《牵丝》—— M0 演示脚本（可回放）。
 *
 * 交接清单 §8 要求 M0 交付物包含"**一段可回放的演示**"。这里把它做成**内核的一部分**
 * 而不是编辑器里的动画，理由是：
 *
 * 1. 演示脚本是**纯输入帧序列**，回放 = 用同一份脚本喂同一个内核；
 * 2. 因此演示的最终状态哈希是**可断言**的——`tests/demo.test.ts` 把它锁死，
 *    任何一次调参如果改变了演示结果，测试会立刻红掉（这正是 AC-05 的日常收益）；
 * 3. Cocos 侧只是把这串输入帧逐 tick 喂给正在渲染的场景，不需要另写一套动画。
 *
 * 脚本内容：牵住石块 → 收丝拉起来 → **向右助跑接近墨甲** → 摆动加速 → 断丝投石。
 *
 * ## 为什么断丝时机是"搜索"出来的
 *
 * 投石能不能打中，取决于三个量：断丝瞬间的速度大小、**速度方向**、以及断丝位置。
 * 手填一个 tick 数字的话，任何一次数值调参都会让演示默默失效（甩不动 / 打不中），
 * 而这种失效极难被注意到。
 *
 * 所以这里先用**同一个内核**空跑一遍，对"助跑时长 × 断丝时机"做一遍网格搜索，
 * 用与主循环相同的积分器预测落点，挑"弹道离墨甲最近"的那一组。整个过程是确定性的，
 * 结果被缓存，代价约 2000 个 tick 的模拟（毫秒级）。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { predictTrajectory } from './aim'
import { GRAVITY_Y, ROPE_RECONGEAL_SEC } from './constants'
import { type InputFrame, input } from './input'
import { M0Scenario } from './scene_m0'
import type { Vec2 } from './vec2'

/** 演示脚本的固定长度（tick）。= 15 秒。 */
export const DEMO_TICKS = 900
/** 开局收丝的时长。 */
const REEL_TICKS = 40
/** 助跑候选值（tick）。0 = 原地摆。 */
const WALK_CANDIDATES = [0, 30, 60, 90, 120, 150, 180]
/** 摆动阶段的最长时长。 */
const SWING_LIMIT = 260
/** 断丝前要求的最低石块速度（m/s）。低于它说明这次甩动不成立。 */
const MIN_RELEASE_SPEED = 9
/** 预测弹道的时长（秒）。够覆盖一次投石的完整弧线。 */
const ARC_SECONDS = 1.6

export interface DemoPlan {
  /** 助跑 tick 数。 */
  walkTicks: number
  /** 断丝发生的绝对 tick。 */
  releaseTick: number
  /** 搜索到的弹道与墨甲的最近距离（米，越小越好）。 */
  missDistance: number
}

function attachFrame(sc: M0Scenario): InputFrame {
  return input({ attachPressed: true, aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y } })
}

/** 摆动阶段的输入：左右来回 + 持续收丝。 */
function swingFrame(i: number): InputFrame {
  return input({ moveX: Math.floor(i / 60) % 2 === 0 ? 1 : -1, reel: 'in' })
}

/**
 * 用与主循环相同的积分器预测自由弹道，返回它离目标（墨甲）最近的距离。
 * 弹道撞地（y < 石块半径）就截断——真实世界里石块不会穿过地面。
 */
function arcMissDistance(from: Vec2, vel: Vec2, target: Vec2, stoneRadius: number): number {
  const arc = predictTrajectory(from, vel, {
    gravityY: GRAVITY_Y,
    seconds: ARC_SECONDS,
    samples: 40,
  })
  let best = Number.POSITIVE_INFINITY
  for (const p of arc) {
    const d = Math.hypot(p.x - target.x, p.y - target.y)
    if (d < best) best = d
    // 贴地即止：地面在 y = 0，石心最低到 y = radius
    if (p.y <= stoneRadius) break
  }
  return best
}

/** 网格搜索：找到一组"能打到墨甲"的（助跑时长，断丝时机）。 */
function searchPlan(): DemoPlan {
  let best: DemoPlan = { walkTicks: 0, releaseTick: REEL_TICKS + 100, missDistance: Number.POSITIVE_INFINITY }

  for (const walkTicks of WALK_CANDIDATES) {
    const probe = new M0Scenario()
    probe.step(attachFrame(probe))
    for (let i = 1; i < REEL_TICKS; i++) probe.step(input({ reel: 'in' }))
    for (let i = 0; i < walkTicks; i++) probe.step(input({ moveX: 1 }))

    for (let i = 0; i < SWING_LIMIT; i++) {
      probe.step(swingFrame(i))
      const r = probe.world.ropes[0]!
      if (r.state !== 'attached') break

      const v = probe.stone.vel
      const speed = Math.hypot(v.x, v.y)
      if (speed < MIN_RELEASE_SPEED || v.x <= 0) continue

      const miss = arcMissDistance(probe.stone.pos, v, probe.armor.pos, 0.5)
      if (miss < best.missDistance) {
        best = {
          walkTicks,
          // +1 的原因：搜索时评估的是"跑完 swingFrame(i) 之后"的状态，
          // 而脚本里的断丝帧是"下一帧"。少这个 +1 就会差一 tick 断丝。
          releaseTick: REEL_TICKS + walkTicks + i + 1,
          missDistance: miss,
        }
      }
    }
  }

  return best
}

let cachedPlan: DemoPlan | null = null
/** 缓存的演示方案（只搜索一次；搜索本身是确定性的）。 */
export function demoPlan(): DemoPlan {
  if (cachedPlan === null) cachedPlan = searchPlan()
  return cachedPlan
}

/** 生成演示输入序列。 */
export function demoScript(): InputFrame[] {
  const plan = demoPlan()
  const probe = new M0Scenario()
  const attach = attachFrame(probe)

  const frames: InputFrame[] = []
  for (let i = 0; i < DEMO_TICKS; i++) {
    let frame: InputFrame

    if (i === 0) {
      frame = attach
    } else if (i < REEL_TICKS) {
      frame = input({ reel: 'in' })
    } else if (i < REEL_TICKS + plan.walkTicks) {
      // 助跑：把石块拖到墨甲的射程之内
      frame = input({ moveX: 1 })
    } else if (i < plan.releaseTick) {
      frame = swingFrame(i - REEL_TICKS - plan.walkTicks)
    } else if (i === plan.releaseTick) {
      frame = input({ cutRope: 0 })
    } else if (i < plan.releaseTick + 60) {
      // 释放后往左跑，画面能看清石块飞出去
      frame = input({ moveX: -1 })
    } else {
      frame = input({})
    }

    frames.push(frame)
  }
  return frames
}

export interface DemoResult {
  scenario: M0Scenario
  plan: DemoPlan
  hash: string
  /** 断丝瞬间石块的速度（m/s）。 */
  releaseSpeed: number
  /** 石块是否击中了墨甲。 */
  armorHit: boolean
  /** 墨甲剩余血量。 */
  armorHp: number
  /** 是否出现了超限断弦。 */
  ropeBroke: boolean
}

/** 空跑一遍演示脚本，返回可断言的摘要。 */
export function runDemo(): DemoResult {
  const plan = demoPlan()
  const sc = new M0Scenario()
  const frames = demoScript()
  let releaseSpeed = 0
  let armorHit = false
  let ropeBroke = false

  for (let i = 0; i < frames.length; i++) {
    sc.step(frames[i]!)
    if (i === plan.releaseTick - 1) {
      releaseSpeed = Math.hypot(sc.stone.vel.x, sc.stone.vel.y)
    }
    for (const e of sc.world.events) {
      if (e.kind === 'damage' && e.target === sc.armor.id) armorHit = true
      if (e.kind === 'rope-broken') ropeBroke = true
    }
  }

  return {
    scenario: sc,
    plan,
    hash: sc.world.stateHash(),
    releaseSpeed,
    armorHit,
    armorHp: sc.armor.hp,
    ropeBroke,
  }
}

/** 供调试面板显示。 */
export const DEMO_RECONGEAL_SEC = ROPE_RECONGEAL_SEC
