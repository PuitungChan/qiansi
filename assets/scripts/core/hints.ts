/**
 * 《牵丝》—— 极简提示系统（设计 §7 的教学手段）。
 *
 * ## 为什么是"条件驱动"而不是"计时驱动"
 *
 * 设计 §7 用时间轴描述序章（0:00–1:00 牵、1:00–2:00 收……），但同时写着
 * 「**连上后**丝线绷紧……**提示消失**」——也就是说提示的**结束条件是玩家做到了**，不是时间到了。
 *
 * 所以这里实现成**状态机**：提示跟着"玩家已经会了什么"推进，而不是跟着秒表。
 * 好处是玩家卡住时提示会一直留着（不会因为超时把教学吞掉），
 * 而且同一个流程在慢手速玩家身上仍然成立。
 *
 * ## 三句提示只教操作，不教用途
 *
 * 设计 §7 原文：「不教"这可以用来打架"，只教"这会让东西飞"。」
 * 到 3:00 之后**没有任何提示**——那一段是整个项目最重要的 2 分钟（AC-01 的判定点）。
 *
 * 本文件不得引入任何引擎依赖。
 */

import type { SimEvent } from './events'
import type { InputFrame } from './input'
import { type TextKey, t } from './texts'

/** 教学步骤。顺序即推进方向，不可回退。 */
export type HintStep =
  /** 还没连上过东西 → 教"牵" */
  | 'attach'
  /** 连过但没收过丝 → 教"收" */
  | 'reel'
  /** 收过但没断过 → 教"断" */
  | 'cut'
  /** 三件都学会了 → **不再显示任何提示** */
  | 'done'

export interface HintState {
  everAttached: boolean
  everReeled: boolean
  everCut: boolean
}

export function createHintState(): HintState {
  return { everAttached: false, everReeled: false, everCut: false }
}

/** 由已完成的事实推导当前步骤（纯函数，可单测）。 */
export function hintStep(s: HintState): HintStep {
  if (!s.everAttached) return 'attach'
  if (!s.everReeled) return 'reel'
  if (!s.everCut) return 'cut'
  return 'done'
}

const STEP_TEXT: Record<HintStep, TextKey | null> = {
  attach: 'hintAttach',
  reel: 'hintReel',
  cut: 'hintCut',
  done: null,
}

/**
 * 当前该显示的提示文字。`null` = 什么都不显示（这才是设计要的状态，不是"没实现"）。
 */
export function hintText(s: HintState): string | null {
  const key = STEP_TEXT[hintStep(s)]
  return key === null ? null : t(key)
}

/**
 * 根据本 tick 的输入与事件推进教学状态。
 *
 * 「收过丝」的判定用的是**输入意图**（按住收丝）而不是"丝真的变短了"——
 * 因为玩家按住不放却因为丝已经到最短而没收动时，他其实**已经学会了这个动作**。
 */
export function advanceHints(s: HintState, input: InputFrame, events: readonly SimEvent[]): void {
  for (const e of events) {
    if (e.kind === 'rope-attached') s.everAttached = true
    else if (e.kind === 'rope-cut' || e.kind === 'rope-broken') s.everCut = true
  }
  if (input.reel === 'in') s.everReeled = true
}
