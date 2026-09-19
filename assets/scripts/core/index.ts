/**
 * 《牵丝》确定性物理内核 —— 统一出口。
 *
 * 这个模块**不导入 `cc`，也不导入任何第三方包**（见 DECISIONS D-017）。
 * 它既能在 Cocos Creator 里被渲染层 import，也能被本机 Node 直接跑测试：
 *
 *   npm test
 *
 * 目录约定：
 *   core/    ← 纯逻辑，零引擎依赖，本机可验证（确定性 / 物理 / 伤害 / 绳索）
 *   cocos/   ← 引擎适配，只有这一层认识 `cc`
 */

export * from './vec2'
export * from './constants'
export * from './body'
export * from './collide'
export * from './damage'
export * from './events'
export * from './hash'
export * from './input'
export * from './rope'
export * from './aim'
export * from './world'
export * from './scene_m0'
export * from './scene_prologue'
export * from './playable'
export * from './hints'
export * from './texts'
export * from './demo'
