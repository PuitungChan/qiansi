/**
 * 性能预算的**静态检查**（NFR-PERF-002 / 003 / 004）。
 *
 * SRS §7.1 给这三条写的验证方法就是"静态检查"——不是真机 Profiler。所以这一组测试
 * 断言的是**预算不会被实现的演进悄悄花掉**：场景里能堆多少刚体、一根丝几段、
 * 墨体粒子记账在哪。
 *
 * NFR-PERF-001 / 005 / 006 / 007 需要真机或引擎运行时数据。本文件**不写假断言**，
 * 它们的验证状态记在 `docs/需求追踪矩阵.md`。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import * as C from '../assets/scripts/core/constants'
import { PrologueScene } from '../assets/scripts/core/scene_prologue'
import { M0Scenario } from '../assets/scripts/core/scene_m0'
import { EnemyTrainingScenario } from '../assets/scripts/core/scene_enemies'
import { NO_INPUT } from './helpers'

const SCENES = [
  ['序章', () => new PrologueScene()],
  ['M0', () => new M0Scenario()],
  ['敌人训练场', () => new EnemyTrainingScenario()],
] as const

/** 跑 sec 秒空输入，返回刚体数的峰值。 */
function peakBodies(
  scene: { step(i: typeof NO_INPUT): void; world: { bodies: unknown[] } },
  sec: number,
) {
  const initial = scene.world.bodies.length
  let peak = initial
  for (let i = 0; i < 60 * sec; i++) {
    scene.step(NO_INPUT)
    const n = scene.world.bodies.length
    if (n > peak) peak = n
  }
  return { initial, peak }
}

test('NFR-PERF-002：单屏刚体数 ≤ 40 —— 三个场景逐个过一遍', () => {
  // 第 20 轮加了"敌人训练场"（三类敌人 + 6 枚墨点池），它也必须进预算表 ——
  // 新场景最容易悄悄花掉预算（墨点池一个人就占 6 个名额）。
  const peaks: Record<string, number> = {}
  for (const [name, make] of SCENES) {
    const { peak } = peakBodies(make(), 90)
    peaks[name] = peak
    assert.ok(
      peak <= 40,
      `${name}刚体峰值 ${peak} 超过预算 40。若这是新增内容导致的，先改 SRS 的预算，` +
        `或证明这些刚体不会同时出现在单屏内 —— 而不是直接把阈值改成实测值。`,
    )
  }
  // 把实测值写进断言消息，调参时看得见
  assert.ok(Object.keys(peaks).length === 3, `场景数应为 3，实测 ${JSON.stringify(peaks)}`)
})

test('刚体数组长度全程恒定（帧率不会随游玩时长下滑）', () => {
  // 比"峰值 ≤ 40"更强的一条：数组长度恒定 ⇒ 宽相位规模恒定。
  // 新增/移除一律走 `removed` 标记，绝不删数组元素 —— 数组下标就是刚体 id。
  //
  // 训练场这一条尤其关键：墨巢会**反复激活与回收墨点**，那是本项目里
  // 唯一一处"看起来像在动态生成物体"的地方（D-065 ② 用预生成池实现）。
  for (const [name, make] of SCENES) {
    const { initial, peak } = peakBodies(make(), 90)
    assert.equal(peak, initial, `${name}：刚体数组长度在运行中变了（数组下标即 id，一动确定性就崩）`)
  }
})

test('NFR-PERF-003：Verlet 绳索 ≤ 4 根 × 12 段', () => {
  assert.ok(C.MAX_ROPES <= 4, `丝位上限 ${C.MAX_ROPES} > 4`)
  assert.ok(C.ROPE_SEGMENTS <= 12, `单根丝的段数 ${C.ROPE_SEGMENTS} > 12`)
  // 最坏情况的总粒子数（每根丝的粒子数 = 段数 + 1，见 rope.ts 的 VerletChain）
  const worst = C.MAX_ROPES * (C.ROPE_SEGMENTS + 1)
  assert.ok(worst <= 4 * 13, `绳索粒子总数 ${worst} 超过 4 × 12 段对应的上限`)
})

test('NFR-PERF-002：丝线不占刚体名额（绳索走 Verlet，不是刚体链）', () => {
  // 这条是给未来的自己看的：如果哪天有人把丝改成"刚体链"来省事，
  // 4 根 × 10 段 = 40 具刚体就会一个人把整个 40 的预算吃光。必须是 Verlet。
  const scene = new PrologueScene()
  scene.world.unlockedRopes = scene.world.ropes.length
  const before = scene.world.bodies.length
  for (let i = 0; i < 60; i++) scene.step(NO_INPUT)
  assert.equal(
    scene.world.bodies.length,
    before,
    '刚体数在丝线存在期间增加了 —— 丝必须是 Verlet 粒子链，不是刚体',
  )
})
