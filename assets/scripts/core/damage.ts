/**
 * 《牵丝》确定性物理内核 —— 伤害三公式（设计 §2.5 / FR-CBT-002/003）。
 *
 *   冲击伤害  D_impact = min(m_att, m_tgt) × v_rel / 4     要求 m_eff ≥ 3
 *   切割伤害  D_cut    = v_rel² / 60                        要求 v_rel ≥ 15
 *   撕裂      （处决）  双丝反向拉且张力差 > 300              仅对可缠绕目标（R3）
 *
 * ## 结算口径（DECISIONS D-022）
 *
 * 一次撞击**只结算一条公式**，按目标弱点择一：
 *
 * | 目标弱点 | 结算方式 | 依据 |
 * |---|---|---|
 * | `any`（墨卒） | 取冲击与切割中较高的一条 | 设计 §4.1 写"任意" |
 * | `impact`（墨甲） | 只结算冲击 | 设计 §4.1 写弱点是动量 mv |
 * | `cut`（墨刃） | 只结算切割 | 设计 §4.1 写弱点是速度 v² |
 * | `tear`（墨缚）/ `structure`（墨巢） | 不因普通撞击受伤 | 需专用规则 |
 *
 * 为什么不能两条相加：石块(4)@25m/s 打墨甲会变成 25 + 10.4 = 35.4 ≥ 30 HP，
 * **一次就死**，与附录 B「墨甲需要两次石块投掷」直接冲突。详见 D-022。
 *
 * ## 与附录 A / B 的自洽性（已用 tests/damage.test.ts 锁定）
 *
 * - 石块(4)@20 打墨甲 → 冲击 20（HP 30，两次击杀）✓ 附录 B
 * - 石块(4)@20 打墨卒 → 切割 6.67（HP 5，一下死）✓ 设计 §7 序章
 * - 石块(4)@25 打墨刃 → 切割 10.4（HP 12，打不死）✓ 设计 §4.1「石块打不了墨刃」
 * - 陶罐(0.6)@40 打墨刃 → 切割 26.7（HP 12，一下死）✓ 设计 §4.1
 * - 陶罐(0.6)@40 打墨甲 → 0（冲击被 m_eff<3 挡下；墨甲弱点为 impact）✓ 设计 §4.1「陶罐打不了墨甲」
 *
 * 本文件不得引入任何引擎依赖。
 */

import type { Weakness } from './body'
import {
  CUT_DIVISOR,
  CUT_MIN_SPEED,
  IMPACT_DIVISOR,
  IMPACT_MIN_MASS,
  NEST_CORE_MULTIPLIER,
} from './constants'

export type DamageType = 'impact' | 'cut' | 'none' | 'structure'

export interface DamageResult {
  readonly type: DamageType
  readonly amount: number
  /** 是否达到公式的生效门槛（`m_eff ≥ 3` / `v_rel ≥ 15`）。未达标时 amount 恒为 0。 */
  readonly effective: boolean
}

export const NO_DAMAGE: DamageResult = { type: 'none', amount: 0, effective: false }

/** 冲击伤害。未达 `m_eff ≥ 3` 门槛时返回 0（目标纹丝不动）。 */
export function impactDamage(mAttacker: number, mTarget: number, vRel: number): number {
  if (!Number.isFinite(mAttacker) || !Number.isFinite(mTarget)) return 0
  if (!Number.isFinite(vRel) || !(vRel > 0)) return 0
  const mEff = Math.min(mAttacker, mTarget)
  if (mEff < IMPACT_MIN_MASS) return 0
  return (mEff * vRel) / IMPACT_DIVISOR
}

/** 切割伤害。未达 `v_rel ≥ 15` 门槛时返回 0（被弹开）。 */
export function cutDamage(vRel: number): number {
  if (!Number.isFinite(vRel) || !(vRel >= CUT_MIN_SPEED)) return 0
  return (vRel * vRel) / CUT_DIVISOR
}

/**
 * 按目标弱点结算一次撞击。
 *
 * @param attackerMass 攻击物质量
 * @param targetMass   目标质量（冲击伤害的 `m_eff = min(...)` 需要它）
 * @param weakness     目标弱点分类（设计 §4.1 的"物理量分类"）
 * @param vRel         撞击瞬间的相对法向速度（标量，正数）
 * @param coreHit      是否命中墨巢承重点（R3 用；M0 恒为 false）
 */
export function resolveImpactAgainst(
  attackerMass: number,
  targetMass: number,
  weakness: Weakness,
  vRel: number,
  coreHit = false,
): DamageResult {
  if (!(vRel > 0)) return NO_DAMAGE

  switch (weakness) {
    case 'impact': {
      const amt = impactDamage(attackerMass, targetMass, vRel)
      return amt > 0
        ? { type: 'impact', amount: amt, effective: true }
        : { type: 'impact', amount: 0, effective: false }
    }
    case 'cut': {
      const amt = cutDamage(vRel)
      return amt > 0
        ? { type: 'cut', amount: amt, effective: true }
        : { type: 'cut', amount: 0, effective: false }
    }
    case 'any': {
      // 墨卒：两种物理量都吃，取更高的一条（不同时结算）。
      const imp = impactDamage(attackerMass, targetMass, vRel)
      const cut = cutDamage(vRel)
      if (cut >= imp && cut > 0) return { type: 'cut', amount: cut, effective: true }
      if (imp > 0) return { type: 'impact', amount: imp, effective: true }
      return NO_DAMAGE
    }
    case 'structure': {
      if (!coreHit) return NO_DAMAGE
      const d = cutDamage(vRel) * NEST_CORE_MULTIPLIER
      return { type: 'structure', amount: d, effective: d > 0 }
    }
    case 'tear':
      // 撕裂是处决，不接受普通撞击。由 combat 层的双丝反向张力差规则处理（R3）。
      return NO_DAMAGE
    default:
      return NO_DAMAGE
  }
}

/** 人类可读的伤害描述，供调试面板与（R2 的）伤害预读复用。 */
export function describeDamage(r: DamageResult, weakness: Weakness): string {
  if (!r.effective || r.amount <= 0) {
    return weakness === 'impact' ? '冲击（不足）' : '切割（不足）'
  }
  const label =
    r.type === 'impact' ? '冲击' : r.type === 'cut' ? '切割' : '承重点'
  return `${label} ${r.amount.toFixed(1)}`
}
