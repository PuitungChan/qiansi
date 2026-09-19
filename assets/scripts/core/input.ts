/**
 * 《牵丝》确定性物理内核 —— 输入帧。
 *
 * 输入被归一成**每 tick 一个不可变帧**，这是确定性的前提（FR-PHY-008 / AC-05）：
 * 只要输入帧序列相同，任何设备、任何帧率下的模拟结果都必须逐位一致。
 * 因此内核**不直接读键盘/鼠标/触摸**，那些都在渲染层的适配器里（见 assets/scripts/cocos/）。
 *
 * 对应需求：FR-ACT-002（牵）/ FR-ACT-003（收·放）/ FR-ACT-004（断）。
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

/** 一帧输入。所有字段必填，缺省值由 `EMPTY_INPUT` 提供。 */
export interface InputFrame {
  /** 水平移动意图，−1..1（左半屏虚拟摇杆 / WASD）。 */
  readonly moveX: number
  /**
   * 牵丝瞄准点（世界坐标，米）。
   * `null` = 本帧没有牵丝意图（不产生新连接）。
   */
  readonly aimPoint: Vec2 | null
  /** 本帧**按下瞬间**为 true，只在边沿触发一次连接。 */
  readonly attachPressed: boolean
  /** 收放丝。 */
  readonly reel: ReelCommand
  /** 要切断的丝索引；`-1` = 不切。FR-ACT-004「点击丝线即断开」。 */
  readonly cutRope: number
  /** 凝神（子弹时间）是否按住。R3 才实现效果，R1 仅透传。 */
  readonly focus: boolean
}

export const EMPTY_INPUT: InputFrame = {
  moveX: 0,
  aimPoint: null,
  attachPressed: false,
  reel: 'hold',
  cutRope: -1,
  focus: false,
}

/** 从部分字段构造完整输入帧（测试与回放用）。 */
export function input(partial: Partial<InputFrame> = {}): InputFrame {
  return {
    moveX: partial.moveX ?? 0,
    aimPoint: partial.aimPoint ?? null,
    attachPressed: partial.attachPressed ?? false,
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
    f.attachPressed ? 1 : 0,
    f.reel === 'in' ? 1 : f.reel === 'out' ? -1 : 0,
    f.cutRope,
    f.focus ? 1 : 0,
  ].join('|')
}

function round(v: number): number {
  // 量化到 1e-6，避免回放文件因浮点打印差异而体积膨胀或不可比。
  return Math.round(v * 1e6) / 1e6
}
