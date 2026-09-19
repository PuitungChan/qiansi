/**
 * 伤害三公式与弱点路由。
 *
 * 这组测试的作用是**把设计文档的数值口径钉死**：附录 A / 附录 B / 设计 §4.1 / §7
 * 里的每个参考算例都在这里有对应断言。任何一次"调平衡"如果破坏了这些等式，
 * 测试会立刻红掉——这就是 RTM 变更流程在代码层的兜底。
 *
 * 对应：FR-CBT-002 / FR-CBT-003 / AC-02 / DECISIONS D-022 / D-023
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cutDamage,
  describeDamage,
  impactDamage,
  resolveImpactAgainst,
} from '../assets/scripts/core/damage'
import { CUT_DIVISOR, IMPACT_DIVISOR, IMPACT_MIN_MASS } from '../assets/scripts/core/constants'

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps

test('冲击伤害：D = min(m_att, m_tgt) × v_rel / 4', () => {
  // 附录 A：石块(4) @ 20 m/s → 冲击 20
  assert.ok(near(impactDamage(4, 20, 20), 20))
  assert.ok(near(impactDamage(4, 20, 20), (Math.min(4, 20) * 20) / IMPACT_DIVISOR))
  // 附录 A：钟(25) @ 8 m/s，目标质量 ≥ 25 → 冲击 50
  assert.ok(near(impactDamage(25, 25, 8), 50))
  // m_eff 取 min：攻击物再重也不会超过目标质量那一侧
  assert.ok(near(impactDamage(100, 4, 20), impactDamage(4, 100, 20)))
})

test('冲击伤害门槛：m_eff < 3 时目标纹丝不动（0 伤害）', () => {
  // 附录 A：陶罐(0.6) @ 40 m/s 打墨甲(20) → m_eff = 0.6 < 3
  assert.equal(impactDamage(0.6, 20, 40), 0)
  assert.ok(IMPACT_MIN_MASS === 3)
  // 刚好卡在门槛上：3 可用，2.999 不可用
  assert.ok(impactDamage(3, 20, 20) > 0)
  assert.equal(impactDamage(2.999, 20, 20), 0)
  // 主角(0.5) 撞任何东西都产生不了冲击伤害——"玩家不产生力量"
  assert.equal(impactDamage(0.5, 20, 60), 0)
})

test('切割伤害：D = v_rel² / 60，门槛 v_rel ≥ 15', () => {
  // 附录 A：陶罐(0.6) @ 40 m/s → 切割 26.7
  assert.ok(near(cutDamage(40), 1600 / 60, 1e-9))
  assert.ok(near(cutDamage(40), (40 * 40) / CUT_DIVISOR))
  // 附录 A：石块(4) @ 25 m/s → 切割 10.4
  assert.ok(near(cutDamage(25), 625 / 60, 1e-9))
  // 门槛
  assert.equal(cutDamage(14.9), 0)
  assert.ok(cutDamage(15) > 0)
  // 主角移动速度 6 m/s 远低于门槛 ⇒ 走路撞不死东西
  assert.equal(cutDamage(6), 0)
})

test('弱点路由：一次撞击只结算一条公式（D-022）', () => {
  // 墨甲（impact）：只吃冲击。石块@20 → 20，不是 20 + 6.67
  const vsArmor = resolveImpactAgainst(4, 20, 'impact', 20)
  assert.equal(vsArmor.type, 'impact')
  assert.ok(near(vsArmor.amount, 20))

  // 墨刃（cut）：只吃切割。石块@25 → 10.4
  const vsBlade = resolveImpactAgainst(4, 0.5, 'cut', 25)
  assert.equal(vsBlade.type, 'cut')
  assert.ok(near(vsBlade.amount, 625 / 60, 1e-9))

  // 陶罐@40 打墨甲：冲击被 m_eff<3 挡下，墨甲又只吃冲击 ⇒ 完全无效
  const potVsArmor = resolveImpactAgainst(0.6, 20, 'impact', 40)
  assert.equal(potVsArmor.amount, 0)
  assert.equal(potVsArmor.effective, false)

  // 墨缚（tear）不吃普通撞击
  assert.equal(resolveImpactAgainst(4, 3, 'tear', 40).amount, 0)
})

test('墨卒（any）：两种物理量都吃，取更高的一条', () => {
  // 石块(4) @ 20 打墨卒(1)：冲击 = min(4,1)×20/4 = 5；切割 = 400/60 = 6.67 → 取切割
  const r = resolveImpactAgainst(4, 1, 'any', 20)
  assert.equal(r.type, 'cut')
  assert.ok(near(r.amount, 400 / 60, 1e-9))
  assert.ok(r.amount >= 5) // ≥ 墨卒 HP 5 ⇒ 一下死（设计 §7 序章）

  // 钟(25) @ 8 打墨卒：冲击 m_eff = min(25,1) = 1 < 3 被门槛挡下；
  // 切割 v = 8 < 15 也被挡下 ⇒ 完全无效。重物慢速撞轻目标打不中，符合设计 §4.1。
  const slow = resolveImpactAgainst(25, 1, 'any', 8)
  assert.equal(slow.amount, 0)
  assert.equal(slow.effective, false)
})

test('与附录 B 血量表的自洽性', () => {
  const HP = { 墨卒: 5, 墨刃: 12, 墨甲: 30, 墨缚: 20, 墨巢: 60 }

  // 墨甲：石块@20 → 20 < 30 ⇒ 需要两次（附录 B 原文）
  const stone20 = resolveImpactAgainst(4, 20, 'impact', 20).amount
  assert.ok(stone20 < HP['墨甲'] && stone20 * 2 >= HP['墨甲'])

  // 墨甲：钟(25)@8 → min(25,20)×8/4 = 40 ≥ 30 ⇒ 一次（重物投掷）
  const bell = resolveImpactAgainst(25, 20, 'impact', 8).amount
  assert.ok(bell >= HP['墨甲'])

  // 墨刃：石块@25 → 10.4 < 12 ⇒ 打不死（"石块打不了墨刃"）
  const stoneVsBlade = resolveImpactAgainst(4, 0.5, 'cut', 25).amount
  assert.ok(stoneVsBlade < HP['墨刃'])

  // 墨刃：陶罐@40 → 26.7 ≥ 12 ⇒ 一下死
  const potVsBlade = resolveImpactAgainst(0.6, 0.5, 'cut', 40).amount
  assert.ok(potVsBlade >= HP['墨刃'])
})

test('拒绝叠加：若两条相加会破坏附录 B，所以必须择一（回归护栏）', () => {
  const impact = impactDamage(4, 20, 25)
  const cut = cutDamage(25)
  // 叠加值会 ≥ 30 HP，一次击杀，与附录 B「两次」矛盾
  assert.ok(impact + cut >= 30)
  // 择一后不致死
  assert.ok(resolveImpactAgainst(4, 20, 'impact', 25).amount < 30)
})

test('非法输入不产生 NaN（NaN 会污染确定性哈希）', () => {
  for (const v of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    assert.equal(impactDamage(4, 20, v), 0)
    assert.equal(cutDamage(v), 0)
    assert.equal(resolveImpactAgainst(4, 20, 'impact', v).amount, 0)
  }
})

test('describeDamage 给出可读文案（R2 伤害预读复用）', () => {
  assert.equal(describeDamage(resolveImpactAgainst(4, 20, 'impact', 20), 'impact'), '冲击 20.0')
  // 陶罐(0.6) 打墨甲：m_eff < 3 被挡下 ⇒ 显示"不足"
  assert.match(describeDamage(resolveImpactAgainst(0.6, 20, 'impact', 40), 'impact'), /不足/)
  // 慢速撞击墨刃：v < 15 被挡下 ⇒ 显示"不足"
  assert.match(describeDamage(resolveImpactAgainst(4, 0.5, 'cut', 8), 'cut'), /不足/)
})
