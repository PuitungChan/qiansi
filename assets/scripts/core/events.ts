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
  /**
   * 丝线**射出去**了（第 13 轮反馈新增）：锁定目标与附着点，开始飞行。
   * 飞行期间不传力；到位时才发 `rope-attached`。
   */
  | {
      readonly kind: 'rope-launched'
      readonly rope: number
      readonly target: number
      /** 附着点（世界坐标，已经吸附到目标表面）。 */
      readonly at: Vec2
    }
  /**
   * 松手点在空白处 ⇒ **没有附着**（创始人明确的规则）。
   * 它不是"失败"，只是"这儿没东西可勾"；渲染层可以据此给一帧反馈。
   */
  | { readonly kind: 'rope-missed'; readonly rope: number; readonly at: Vec2 }
  /** 丝线成功附着到目标（= 飞行到位）。 */
  | { readonly kind: 'rope-attached'; readonly rope: number; readonly target: number }
  /** 玩家主动断开（屏幕「断」按钮 / `Q` / 右键 / 点丝线）。无硬直，但丝位进入 1.5s 重凝。 */
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
      /** **攻击者刚体 id**。AC-01 必须知道"是不是石块砸死的"，所以这里必须带来源。 */
      readonly by: number
      readonly amount: number
      readonly type: DamageType
      readonly hpAfter: number
      readonly at: Vec2
    }
  /** 目标死亡。M0/M1 不实现死亡流程，仅供调试面板与埋点。 */
  | { readonly kind: 'killed'; readonly target: number; readonly by: number; readonly at: Vec2 }
  // ── 敌人行为（第 20 轮 / FR-CBT-011 / FR-CBT-012）────
  //
  // 这五条都是**可回放、可埋点**的玩法事件（不是表现）。放在内核里而不是渲染层，
  // 是为了"创始人按 H 导出的回放能把它们重新打出来"—— 定位"我明明被射中了却没变黑"
  // 这类问题时，事件时间线比截图有用得多。
  /** 墨缚伸触须**缠住**了一根丝（那根丝随后既不能收也不能放，但可以断）。 */
  | { readonly kind: 'bind-grab'; readonly body: number; readonly rope: number }
  /** 墨缚松开了触须（到时 / 那根丝被断掉 / 墨缚死亡）。 */
  | { readonly kind: 'bind-release'; readonly body: number; readonly rope: number }
  /** 墨巢射出一枚墨点。 */
  | { readonly kind: 'nest-fire'; readonly body: number; readonly x: number; readonly y: number }
  /** 墨点命中主角 ⇒ 视野被污染。 */
  | {
      readonly kind: 'ink-hit'
      readonly dot: number
      readonly pollution: number
      readonly visible: number
    }
  /** **撕裂处决**（FR-CBT-004）：两根丝反向拉且张力差 > 300 ⇒ 直接击杀。 */
  | {
      readonly kind: 'tear'
      readonly body: number
      readonly ropeA: number
      readonly ropeB: number
      readonly tensionA: number
      readonly tensionB: number
      readonly angle: number
    }

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
