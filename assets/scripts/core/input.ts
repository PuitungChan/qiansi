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

/**
 * 量化到 1e-6（米 / 无量纲）。
 *
 * **输入帧在构造时就量化** —— 这是"回放导出的文本能逐位复现当时的模拟"的前提。
 * `encodeInput` 为了不让回放文件膨胀，本来就会把数值截到 1e-6；如果**实时那一遍**
 * 用的是没截过的原值（例如瞄准点 `0.5099999999`），那么"导出再导入"跑出来的世界
 * 与当时那一遍会在第 1 个 tick 就分叉（哈希建立在浮点原始位型上，差 1e-10 都算不同），
 * 于是回放**永远对不上**。所以在入口处就对齐，导出与实时才严格等价。
 */
function q(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

/** 从部分字段构造完整输入帧（测试与回放用）。 */
export function input(partial: Partial<InputFrame> = {}): InputFrame {
  const aim = partial.aimPoint
  return {
    moveX: q(sanitizeMoveX(partial.moveX ?? 0)),
    aimPoint: aim == null ? null : { x: q(aim.x), y: q(aim.y) },
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
  const ax = f.aimPoint === null ? '' : `${q(f.aimPoint.x)},${q(f.aimPoint.y)}`
  return [
    q(f.moveX),
    ax,
    f.firePressed ? 1 : 0,
    f.reel === 'in' ? 1 : f.reel === 'out' ? -1 : 0,
    f.cutRope,
    f.focus ? 1 : 0,
  ].join('|')
}

/**
 * `encodeInput()` 的逆运算（第 18 轮加：NFR-MNT-003 的"导入"那一半）。
 *
 * 为什么需要它：创始人试玩时按 `H` 会把输入序列打到控制台，但**只有导出、没有导入**时，
 * 那串文本只能靠人肉阅读。前三轮里为了定位"瞄准 UI 全没了""砸了却不掉血"，
 * 我只能靠推理和自写探针 —— **如果他当时能把那串序列贴给我，我可以在本机逐帧重放那一刻**。
 *
 * 格式就是 `encodeInput` 的输出：`moveX|aimX,aimY|fire|reel|cut|focus`。
 * 宽容解析：空行、`#` 注释、列数不足的行一律返回 `null`（调用方跳过）。
 */
export function decodeInput(line: string): InputFrame | null {
  const s = line.trim()
  if (s.length === 0 || s.startsWith('#')) return null
  const parts = s.split('|')
  if (parts.length < 6) return null

  const moveX = Number(parts[0])
  if (!Number.isFinite(moveX)) return null

  let aimPoint: Vec2 | null = null
  if (parts[1]!.length > 0) {
    const xy = parts[1]!.split(',')
    if (xy.length === 2) {
      const x = Number(xy[0])
      const y = Number(xy[1])
      if (Number.isFinite(x) && Number.isFinite(y)) aimPoint = { x, y }
    }
  }

  const reelN = Number(parts[3])
  const reel: ReelCommand = reelN > 0 ? 'in' : reelN < 0 ? 'out' : 'hold'
  const cutRope = Number(parts[4])

  return {
    moveX: sanitizeMoveX(moveX),
    aimPoint,
    firePressed: parts[2] === '1',
    reel,
    cutRope: Number.isFinite(cutRope) ? cutRope : -1,
    focus: parts[5] === '1',
  }
}
