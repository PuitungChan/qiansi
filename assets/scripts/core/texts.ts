/**
 * 《牵丝》—— 玩家可见文案表。
 *
 * NFR-I18N-003（R1）要求「文案全走资源表」。这是那张表。
 * **任何出现在屏幕上的玩家可见文字都必须从这里取**，不许内联。
 *
 * 设计 §8.4：全游戏唯一允许的文字是「命名」，除此之外总量 ≤ 500 字（FR-UI-007）。
 * 所以这张表应该**长得很慢**——每加一句都该问一次"能不能不说话就教会"。
 *
 * ⚠️ 调试面板的文案**不在这里**：那是开发期 UI，不是玩家可见内容（见 DebugPanel.ts）。
 *
 * 本文件不得引入任何引擎依赖。
 */

export const TEXTS = {
  // ── 序章前 3 分钟的三句提示（设计 §7）────────────────
  // 这三句是整个 M1 的教学手段：**只教操作，不教用途**。
  // 设计 §7 原文：「不教"这可以用来打架"，只教"这会让东西飞"。」
  hintAttach: '按住，拖向石头',
  hintReel: '按住不放',
  hintCut: '点一下丝线',

  // ── 通关（批 4 用，先占位）──────────────────────────
  cleared: '过了',
} as const

export type TextKey = keyof typeof TEXTS

/** 取文案。集中走这里是为了将来做多语言时只有一个入口。 */
export function t(key: TextKey): string {
  return TEXTS[key]
}

/** 全游戏玩家可见文本的字数统计（AC-33 用）。 */
export function totalTextLength(): number {
  let n = 0
  for (const k of Object.keys(TEXTS) as TextKey[]) n += TEXTS[k].length
  return n
}
