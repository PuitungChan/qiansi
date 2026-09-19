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
}
