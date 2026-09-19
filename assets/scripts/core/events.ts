/**
 * 《牵丝》确定性物理内核 —— 模拟事件。
 *
 * 内核**只产生事件，不产生表现**。渲染层、音效层、埋点层（FR-LIV-003）都是事件的消费者。
 * 这样做的直接好处：命名系统（FR-NAM-001~003，R2）要求的"完全基于确定性物理量"判定，
 * 可以在纯内核层实现并被单元测试覆盖。
 *
 * 本文件不得引入任何引擎依赖。
 */

import type { DamageType } from './damage'
import type { Vec2 } from './vec2'

export type SimEvent =
  /** 丝线成功附着到目标。 */
  | { readonly kind: 'rope-attached'; readonly rope: number; readonly target: number }
  /** 玩家主动断开（点击丝线 / Q）。无硬直，但丝位进入 1.5s 重凝。 */
  | { readonly kind: 'rope-cut'; readonly rope: number; readonly target: number }
  /** 张力超限断裂。附加 0.8s 硬直。 */
  | {
      readonly kind: 'rope-broken'
      readonly rope: number
      readonly target: number
      readonly tension: number
    }
  /** 丝位重凝完成，重新可用。 */
  | { readonly kind: 'rope-recovered'; readonly rope: number }
  /** 一次进入接触（用于撞击反馈/音效）。 */
  | {
      readonly kind: 'impact'
      readonly a: number
      readonly b: number
      readonly speed: number
      readonly at: Vec2
    }
  /** 造成伤害。 */
  | {
      readonly kind: 'damage'
      readonly target: number
      readonly amount: number
      readonly type: DamageType
      readonly hpAfter: number
      readonly at: Vec2
    }
  /** 目标死亡。M0 不实现死亡流程，仅供调试面板与埋点。 */
  | { readonly kind: 'killed'; readonly target: number; readonly at: Vec2 }

/** 事件类型过滤助手，渲染层用。 */
export function eventsOf<K extends SimEvent['kind']>(
  events: readonly SimEvent[],
  kind: K,
): Extract<SimEvent, { kind: K }>[] {
  const out: Extract<SimEvent, { kind: K }>[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.kind === kind) out.push(e as Extract<SimEvent, { kind: K }>)
  }
  return out
}
