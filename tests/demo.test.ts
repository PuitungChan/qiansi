/**
 * 演示脚本的确定性回归。
 *
 * `runDemo()` 的哈希是 M0 交付物的一部分（交接清单 §8「一段可回放的演示」）。
 * 把它锁在这里的意义：**任何一次手感调参都会改变演示结果**，于是这次改动
 * 必须被显式看见、显式确认——而不是悄悄地让回放失真。
 *
 * 如果这个测试红了，且你**确实**想接受新的手感：
 *   1. 先跑 `node --experimental-strip-types --import ./tests/register.mjs tests/_demo-hash.ts`
 *      或者在测试失败信息里读出 new hash；
 *   2. 确认新演示看起来仍然正确（甩得动、扔得远、能打到墨甲）；
 *   3. 更新下面的 `EXPECTED_HASH`，并在 CHANGELOG 里记一笔。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DEMO_TICKS, demoScript, runDemo } from '../assets/scripts/core/demo'
import { M0Scenario } from '../assets/scripts/core/scene_m0'

/**
 * 基线哈希。更新本常量时必须在 CHANGELOG 说明"为什么这次手感变化是对的"。
 *
 * 变更历史：
 * - `3c7f7016969b215f` v0.2.0 首版（张力超限会断丝）
 * - `8cf4d9e30c0b2f0e` D-032 起：张力到顶改为刚性约束，不再断丝
 * - `17801d9bc8f55fee` D-036 起：位置层约束改为交替迭代（修"石块和墨甲卡在一起"）
 * - `7d282cd6465751f3` D-039 起：道具摩擦 0.4 → 0.1（补偿 M0 没有自转，投掷射程翻倍）
 * - `87798a76fdf50d33` 批 1 起：`removed`（碎裂标记）进入状态哈希
 * - `a6b7857ff68efb22` 批 4 起：`unlockedRopes`（丝位解锁进度）进入状态哈希
 * - `c2856b1b7c876a42` 第 13 轮：丝线改为"松手发射 + 飞行 + 松手点即锚点"
 * - `ec2bc6634a4e0ea6` 第 14 轮：`D-057`（没在收丝时丝线不给主角施力）
 *   —— **断丝瞬间的甩速与命中都没变**（9.43 m/s / 墨甲掉到 20.1），说明甩动的手感
 *   本来就由刚性约束承担，不依赖那条被拿掉的弹簧力
 */
const EXPECTED_HASH = 'ec2bc6634a4e0ea6'

test('演示脚本长度固定且不含任何随机性', () => {
  const a = demoScript()
  const b = demoScript()
  assert.equal(a.length, DEMO_TICKS)
  assert.deepEqual(a, b, '两次调用必须产出完全相同的输入序列')
})

test('演示脚本两次运行产出相同哈希（回放可复现）', () => {
  const a = runDemo()
  const b = runDemo()
  assert.equal(a.hash, b.hash)
  assert.equal(a.armorHp, b.armorHp)
  assert.equal(a.releaseSpeed, b.releaseSpeed)
})

test('演示确实演示了"甩动"：断丝瞬间石块有可观速度', () => {
  const r = runDemo()
  assert.ok(
    r.releaseSpeed > 8,
    `断丝瞬间石块速度应 > 8 m/s，实际 ${r.releaseSpeed.toFixed(2)}`,
  )
})

test('演示确实演示了"投石"：石块能打到墨甲', () => {
  const r = runDemo()
  assert.ok(r.armorHit, '演示脚本应当能把石块甩到墨甲身上')
  assert.ok(r.armorHp < 30, `墨甲应掉血，实际 HP ${r.armorHp.toFixed(1)}`)
})

test('演示脚本全程不断弦（演示不该演示"新手陷阱"）', () => {
  const r = runDemo()
  assert.equal(r.ropeBroke, false, '演示脚本的设计意图是成功甩出，不该出现超限断弦')
})

test('断丝时机是确定性搜索出来的，且落在摆动阶段内', () => {
  const a = runDemo()
  const b = runDemo()
  assert.ok(a.plan.releaseTick > 40, '不该在开局收丝阶段就断')
  assert.ok(a.plan.releaseTick < 600, '不该拖到脚本末尾才断')
  assert.deepEqual(a.plan, b.plan, '搜索必须是确定性的')
  assert.ok(a.plan.missDistance < 1, '搜索应当找到一条确实打得中的弹道')
})

test('锁定演示哈希（手感回归护栏）', () => {
  const r = runDemo()
  if (EXPECTED_HASH === 'PLACEHOLDER') {
    // 首次落库：把实测值打出来，方便写进常量。
    console.log(
      `[demo] hash=${r.hash} releaseTick=${r.releaseTick} ` +
        `releaseSpeed=${r.releaseSpeed.toFixed(2)} armorHp=${r.armorHp.toFixed(1)}`,
    )
    return
  }
  assert.equal(r.hash, EXPECTED_HASH, '演示哈希变了——请确认这次手感变化是你想要的')})
