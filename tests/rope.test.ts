/**
 * 丝线内核：张力模型、收放钳制、Verlet 绳索、断丝命中几何。
 *
 * 对应：FR-PHY-001 / FR-PHY-002 / FR-PHY-010 / FR-ACT-009 / AC-19
 * 口径依据：DECISIONS D-021（张力模型）、D-029（显示刻度 vs 物理断裂载荷）
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ROPE_LEN_MAX,
  ROPE_LEN_MIN,
  ROPE_SEGMENTS,
  ROPE_STIFFNESS,
  TENSION_BREAK_FORCE_BASE,
} from '../assets/scripts/core/constants'
import {
  chainPoints,
  clampRopeLength,
  createVerletChain,
  distanceToSegment,
  reducedMass,
  ropeTension,
  stepVerletChain,
  tensionDifference,
} from '../assets/scripts/core/rope'
import { createRope } from '../assets/scripts/core/rope'

const base = {
  stiffness: ROPE_STIFFNESS,
  dampingRatio: 0.2,
  axialVelocity: 0,
  reducedMass: 4,
}

test('松弛的丝不传递任何力（FR-PHY-001 铁律 1：丝只能拉不能推）', () => {
  // 实际长度 < 目标丝长 ⇒ 松弛
  assert.equal(ropeTension({ ...base, length: 3, targetLength: 6 }), 0)
  // 恰好相等 ⇒ 仍然松弛
  assert.equal(ropeTension({ ...base, length: 6, targetLength: 6 }), 0)
  // 哪怕正在高速相向运动，松弛状态下也不产生任何力（负的"推力"必须被吃掉）
  assert.equal(
    ropeTension({ ...base, length: 6, targetLength: 6, axialVelocity: -50 }),
    0,
  )
})

test('张力与伸长量成正比：T = k·ΔL', () => {
  const a = ropeTension({ ...base, length: 6.1, targetLength: 6 })
  const b = ropeTension({ ...base, length: 6.2, targetLength: 6 })
  assert.ok(Math.abs(a - ROPE_STIFFNESS * 0.1) < 1e-9)
  assert.ok(Math.abs(b - 2 * a) < 1e-9)
})

test('轴向相对速度通过阻尼项增加张力，反向则减小但不会变负', () => {
  const still = ropeTension({ ...base, length: 6.1, targetLength: 6 })
  const away = ropeTension({ ...base, length: 6.1, targetLength: 6, axialVelocity: 2 })
  const toward = ropeTension({ ...base, length: 6.1, targetLength: 6, axialVelocity: -2 })
  assert.ok(away > still)
  assert.ok(toward < still)
  // 向对方冲得足够猛时整体张力被夹到 0，绝不出现"推力"
  assert.equal(
    ropeTension({ ...base, length: 6.1, targetLength: 6, axialVelocity: -1000 }),
    0,
  )
})

test('物理断裂载荷与显示刻度的关系（D-029）', () => {
  // 显示刻度 400、物理载荷 1200 N；两者比例就是 HUD 上要显示的百分比余量
  assert.equal(TENSION_BREAK_FORCE_BASE, 1200)
  // 静吊石块(4)：80 N，占 7%
  const hang = ropeTension({ ...base, length: 6 + 0.08, targetLength: 6 })
  assert.ok(Math.abs(hang - 80) < 1e-9)
  assert.ok(hang / TENSION_BREAK_FORCE_BASE < 0.1)
})

test('等效质量：两端可动走标准公式；有静态端时退化为可动端质量', () => {
  assert.ok(Math.abs(reducedMass(0.25, 0.25) - 2) < 1e-12)
  assert.ok(Math.abs(reducedMass(0, 0.25) - 4) < 1e-12)
  // 双静态端：不会除零
  assert.equal(reducedMass(0, 0), Number.POSITIVE_INFINITY)
})

test('目标丝长被钳制在 [0.5, 12]（FR-PHY-002 / 设计 §2.4）', () => {
  assert.equal(clampRopeLength(-5), ROPE_LEN_MIN)
  assert.equal(clampRopeLength(100), ROPE_LEN_MAX)
  assert.equal(clampRopeLength(6), 6)
  assert.equal(clampRopeLength(Number.NaN), ROPE_LEN_MIN)
})

test('Verlet 绳索：端点被钉死、段数正确、总长收敛到目标丝长', () => {
  const chain = createVerletChain({ x: 0, y: 0 }, { x: 6, y: 0 }, ROPE_SEGMENTS)
  assert.equal(chain.count, ROPE_SEGMENTS + 1)
  assert.equal(chainPoints(chain).length, ROPE_SEGMENTS + 1)

  const a = { x: 0, y: 5 }
  const b = { x: 4, y: 1 }
  for (let i = 0; i < 240; i++) {
    stepVerletChain(chain, { a, b, restLength: 4, gravityY: -20, dt: 1 / 60 })
  }
  // 端点严格跟随锚点
  assert.equal(chain.px[0], a.x)
  assert.equal(chain.py[0], a.y)
  assert.equal(chain.px[chain.count - 1], b.x)
  assert.equal(chain.py[chain.count - 1], b.y)

  // 每段长度应接近 restLength / segments（端点被硬约束拉长的那一段除外）
  const rest = 4 / ROPE_SEGMENTS
  for (let i = 1; i < ROPE_SEGMENTS - 1; i++) {
    const dx = chain.px[i + 1] - chain.px[i]
    const dy = chain.py[i + 1] - chain.py[i]
    assert.ok(Math.abs(Math.hypot(dx, dy) - rest) < 0.25, `段 ${i} 长度偏差过大`)
  }
})

test('断丝命中判定几何：点到线段距离（FR-ACT-009 半径 ≥ 22 逻辑像素）', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 10, y: 0 }
  assert.equal(distanceToSegment({ x: 5, y: 3 }, a, b), 3)
  assert.equal(distanceToSegment({ x: 5, y: -2 }, a, b), 2)
  // 投影落在线段外时退化为到端点的距离
  assert.equal(distanceToSegment({ x: -3, y: 0 }, a, b), 3)
  assert.equal(distanceToSegment({ x: 14, y: 0 }, a, b), 4)
  // 退化线段（两端重合）不产生 NaN
  assert.equal(distanceToSegment({ x: 3, y: 4 }, a, a), 5)
})

test('撕裂判定用的张力差（FR-CBT-004，R3 预留）', () => {
  const r1 = createRope(0)
  const r2 = createRope(1)
  r1.tension = 500
  r2.tension = 150
  assert.equal(tensionDifference(r1, r2), 350)
  assert.equal(tensionDifference(r2, r1), 350)
})
