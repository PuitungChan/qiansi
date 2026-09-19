/**
 * 预判线（FR-UI-003 / AC-02）。
 *
 * 口径依据 D-024：预判的是"假设此刻断丝"的自由弹道——含重力、不含丝线约束、不含碰撞。
 * 用与主循环相同的固定步长积分，保证预判线与真实结果零漂移。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { predictSegments, predictTrajectory } from '../assets/scripts/core/aim'
import { AIM_PREDICT_SAMPLES, AIM_PREDICT_SEC, DT, GRAVITY_Y } from '../assets/scripts/core/constants'

test('预判线按 0.3s / 18 步积分，并给出指定数量的采样点', () => {
  const pts = predictTrajectory({ x: 0, y: 0 }, { x: 10, y: 0 }, { gravityY: GRAVITY_Y })
  assert.equal(pts.length, AIM_PREDICT_SAMPLES)
  // 18 步 = 0.3s
  assert.ok(Math.abs(AIM_PREDICT_SEC / DT - 18) < 1e-9)
})

test('预判线含重力：水平抛出时轨迹逐点下坠，且与解析解一致', () => {
  const v0 = 12
  const pts = predictTrajectory({ x: 0, y: 0 }, { x: v0, y: 0 }, { gravityY: GRAVITY_Y })
  const last = pts[pts.length - 1]
  const t = AIM_PREDICT_SEC
  // 用与主循环相同的半隐式欧拉：x = v·t，y = ½g t² + ½ g dt t（离散修正项）
  assert.ok(Math.abs(last.x - v0 * t) < 1e-9)
  assert.ok(last.y < 0, '必须下坠——不含重力的直线是错的')
  const analytic = 0.5 * GRAVITY_Y * t * t
  assert.ok(Math.abs(last.y - analytic) < 0.15, '应与解析解接近')

  // 严格单调下坠
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i]!.y < pts[i - 1]!.y)
  }
})

test('预判线不含丝线约束：横向速度保持恒定（这正是"断丝后飞向哪"）', () => {
  const pts = predictTrajectory({ x: 0, y: 0 }, { x: 20, y: 5 }, { gravityY: GRAVITY_Y })
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]!.x - pts[i - 1]!.x
    const dxPrev = i === 1 ? pts[0]!.x - 0 : pts[i - 1]!.x - pts[i - 2]!.x
    assert.ok(Math.abs(dx - dxPrev) < 1e-9, '水平步长必须恒定')
  }
})

test('预判线与真实自由飞行完全一致（用同一个积分器，零漂移）', () => {
  const start = { x: 3, y: 4 }
  const vel = { x: 7, y: 9 }
  const pts = predictTrajectory(start, vel, { gravityY: GRAVITY_Y })
  const predicted = pts[pts.length - 1]!

  // 手动用相同规则积分 18 步
  let x = start.x
  let y = start.y
  let vy = vel.y
  for (let i = 0; i < 18; i++) {
    vy += GRAVITY_Y * DT
    x += vel.x * DT
    y += vy * DT
  }
  assert.ok(Math.abs(x - predicted.x) < 1e-12)
  assert.ok(Math.abs(y - predicted.y) < 1e-12)
})

test('退化输入不产生 NaN', () => {
  const pts = predictTrajectory({ x: 0, y: 0 }, { x: 0, y: 0 }, { gravityY: 0 })
  for (const p of pts) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
  }
})

test('predictSegments 生成首尾相接的折线（渲染层直接画）', () => {
  const start = { x: 0, y: 0 }
  const pts = predictTrajectory(start, { x: 10, y: 0 }, { gravityY: GRAVITY_Y })
  const segs = predictSegments(start, pts)
  assert.equal(segs.length, pts.length)
  assert.deepEqual(segs[0]!.from, start)
  for (let i = 1; i < segs.length; i++) {
    assert.deepEqual(segs[i]!.from, segs[i - 1]!.to)
  }
})
