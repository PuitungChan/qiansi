/**
 * 《牵丝》确定性物理内核 —— 输入帧。
 *
 * 输入被归一成**每 tick 一个不可变帧**，这是确定性的前提（FR-PHY-008 / AC-05）：
 * 只要输入帧序列相同，任何设备、任何帧率下的模拟结果都必须逐位一致。
 * 因此内核**不直接读键盘/鼠标/触摸**，那些都在渲染层的适配器里（见 assets/scripts/cocos/）。
 *
 * ## 牵丝的操作语义（第 13 轮实机反馈后改写）
 *
 * 创始人原话：「是否可以做成玩家长按屏幕瞄准，松手后发射丝线，
 * 松手的位置即是丝线附着的位置（如果松手的地方是空白那么不附着）」。
 *
 * 所以一帧输入里，"瞄准"与"发射"是两个字段：
 *   · `aimPoint !== null` **且** `firePressed === false` ⇒ 玩家正按着、在瞄准；
 *   · `aimPoint !== null` **且** `firePressed === true`  ⇒ **这一帧松手了**，
 *     `aimPoint` 就是**附着点**（内核把它吸附到该处物体的表面）。
 *
 * 移动也不再是模拟摇杆：`moveX` 现在是两个按钮/按键的 **−1 / 0 / +1**。
 * 类型保留成数字，是为了让"以后可能出现的加速踏板/手柄"不用改内核接口。
 *
 * 对应需求：FR-ACT-002（牵）/ FR-ACT-003（收·放）/ FR-ACT-004（断）/ FR-ACT-005（键鼠）。
 * 本文件不得引入任何引擎依赖。
 */

import type { Vec2 } from './vec2'

/** 收放丝指令。 */
export type ReelCommand =
  /** 收丝：目标丝长以 8 m/s 减小。 */
  | 'in'
  /** 放丝：目标丝长以 8 m/s 增大（张力下降，物体脱离约束但丝仍在）。 */
  | 'out'
  /** 不动。 */
  | 'hold'

/** 一帧输入。所有字段必填，缺省值由 `input()` 提供。 */
export interface InputFrame {
  /** 水平移动意图，−1 / 0 / +1（屏幕上的左右按钮 / A·D / ←·→）。 */
  readonly moveX: number
  /**
   * 当前**瞄准点**（世界坐标，米）；`null` = 本帧没在瞄准。
   * 松手那一帧它同时就是**附着点**（见 `firePressed`）。
   */
  readonly aimPoint: Vec2 | null
  /** 本帧**松手发射**的瞬间为 true（边沿触发一次）。 */
  readonly firePressed: boolean
  /** 收放丝。 */
  readonly reel: ReelCommand
  /** 要切断的丝索引；`-1` = 不切（屏幕「断」按钮 / `Q` / 右键 / 点丝线）。 */
  readonly cutRope: number
  /** 凝神（子弹时间）是否按住。R3 才实现效果，R1 仅透传。 */
  readonly focus: boolean
}

export const EMPTY_INPUT: InputFrame = {
  moveX: 0,
  aimPoint: null,
  firePressed: false,
  reel: 'hold',
  cutRope: -1,
  focus: false,
}

/** 从部分字段构造完整输入帧（测试与回放用）。 */
export function input(partial: Partial<InputFrame> = {}): InputFrame {
  return {
    moveX: partial.moveX ?? 0,
    aimPoint: partial.aimPoint ?? null,
    firePressed: partial.firePressed ?? false,
    reel: partial.reel ?? 'hold',
    cutRope: partial.cutRope ?? -1,
    focus: partial.focus ?? false,
  }
}

/** 把 moveX 夹到 [−1, 1]。非法输入（NaN / 非有限）归零，避免污染确定性。 */
export function sanitizeMoveX(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < -1) return -1
  if (v > 1) return 1
  return v
}

/** 序列化一帧输入，用于回放导出（FR-SOC-002 的 R1 子集 / NFR-MNT-003）。 */
export function encodeInput(f: InputFrame): string {
  const ax = f.aimPoint === null ? '' : `${round(f.aimPoint.x)},${round(f.aimPoint.y)}`
  return [
    round(f.moveX),
    ax,
    f.firePressed ? 1 : 0,
    f.reel === 'in' ? 1 : f.reel === 'out' ? -1 : 0,
    f.cutRope,
    f.focus ? 1 : 0,
  ].join('|')
}

function round(v: number): number {
  // 量化到 1e-6，避免回放文件因浮点打印差异而体积膨胀或不可比。
  return Math.round(v * 1e6) / 1e6
}
