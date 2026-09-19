/**
 * 《牵丝》确定性物理内核 —— 预判线（FR-UI-003 / AC-02）。
 *
 * ## 口径：预判的是"假设此刻断丝"的弹道（DECISIONS D-024）
 *
 * 玩家真正要预判的是**我断丝的瞬间它会飞向哪**，所以前向模拟必须按"丝已断开"来做：
 *
 * - ✅ 含重力
 * - ❌ 不含丝线约束（丝一断就不传递力了）
 * - ❌ 不含碰撞（FR-UI-003 明确写"不显示碰撞后反弹"）
 *
 * 用与主循环**完全相同**的固定步长积分，保证预判线与真实结果零漂移——
 * 如果这里用了不同的积分方式，"预判线说谎"就会变成一个没人能复现的手感 bug。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { AIM_PREDICT_SAMPLES, AIM_PREDICT_SEC, DT } from './constants'
import type { Vec2 } from './vec2'

export interface PredictOptions {
  /** 预测时长（秒）。默认 0.3s（FR-UI-003）。 */
  readonly seconds?: number
  /** 采样点个数。默认 12。 */
  readonly samples?: number
  /** 重力（m/s²）。默认取调用方传入的世界重力。 */
  readonly gravityY: number
}

/**
 * 从 `start` 以 `velocity` 出发做自由弹道前向积分，返回采样点（**不含起点**）。
 * 采样点均匀分布在整段时长的末尾。
 */
export function predictTrajectory(
  start: Vec2,
  velocity: Vec2,
  options: PredictOptions,
): Vec2[] {
  const seconds = options.seconds ?? AIM_PREDICT_SEC
  const samples = Math.max(1, Math.round(options.samples ?? AIM_PREDICT_SAMPLES))
  const steps = Math.max(1, Math.round(seconds / DT))

  // 等距采样：用固定 stride 取点，保证相邻采样点之间**步数相同**。
  // （若按 `round(k·steps/samples)` 取点，步距会变成 1,2,1,2… 点线画出来是抖的。）
  // 代价是当 `samples` 不整除 `steps` 时实际点数会略少于请求值——对画线无所谓，
  // 但绝不能牺牲等距性。
  const stride = Math.max(1, Math.round(steps / samples))
  const pickAt = new Set<number>()
  for (let i = stride; i <= steps; i += stride) pickAt.add(i)
  pickAt.add(steps)

  const out: Vec2[] = []
  let x = start.x
  let y = start.y
  let vy = velocity.y
  const vx = velocity.x

  for (let i = 1; i <= steps; i++) {
    vy += options.gravityY * DT
    x += vx * DT
    y += vy * DT
    if (pickAt.has(i)) out.push({ x, y })
  }
  return out
}

/** 预判线段列表（相邻采样点配对），供渲染层直接画点线。 */
export function predictSegments(start: Vec2, points: readonly Vec2[]): { from: Vec2; to: Vec2 }[] {
  const segs: { from: Vec2; to: Vec2 }[] = []
  let prev = start
  for (const p of points) {
    segs.push({ from: prev, to: p })
    prev = p
  }
  return segs
}
