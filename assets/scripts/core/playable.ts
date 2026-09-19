/**
 * 《牵丝》—— 可播放场景的统一接口。
 *
 * 存在的理由：`cocos/Bootstrap.ts` 要能承载**不同的场景**（M0 沙盒 / 序章）。
 * 没有这个接口的话，Bootstrap 会写死成 `M0Scenario`，一加场景就要改渲染层——
 * 而渲染层是唯一认识 `cc` 的一层，我改它一次就要让你重开一次编辑器。
 *
 * 本文件不得引入任何引擎依赖。
 */

import type { Body } from './body'
import type { InputFrame } from './input'
import type { World } from './world'

export interface PlayableScene {
  readonly world: World
  readonly player: Body

  /** 推进一个固定步。 */
  step(input: InputFrame): void

  /** 复位到可复现的初态。 */
  reset(): void

  /** 调试面板用的摘要（键值都必须是可打印的标量）。 */
  summary(): Record<string, number | string>

  /**
   * 当前该显示的**极简提示**（设计 §7 的教学手段）。
   * `null` = 什么都不显示 —— 这是**正常状态**，不是"没实现"。
   * 序章 3:00 之后恒为 null，那正是设计要的。
   */
  hint(): string | null

  /**
   * 需要"发光提示"的刚体 id；`-1` = 无。
   *
   * 这是设计 §7 里**唯一一种不弹文字的提示**：「如果 60 秒内没有动作，
   * 石头会微微发光（**极其克制的提示**）。不弹文字。」
   * 它必须走渲染而不是走文字 —— 所以单独开一个口子，而不是塞进 `hint()`。
   */
  glowBodyId(): number

  // ── 调试跳段（可选）─────────────────────────────────
  //
  // 段落出口改成**纯进度门控**之后（第 13 轮反馈：不要时间线），一个卡住的玩家
  // 看不到后面的内容。这两个方法给开发者一条旁路，**不参与任何游戏机制**：
  // 玩家路径上没有任何东西会调用它们，只有 `cocos/Bootstrap.ts` 的数字键会。

  /** 可跳的段落名（按顺序）；没有分段的场景返回空数组或不实现。 */
  debugStages?(): readonly string[]

  /** 跳到指定段落。名字必须在 `debugStages()` 里。 */
  debugSkip?(name: string): void
}
