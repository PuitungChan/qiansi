/**
 * 序章 · 批 1（设计 §7 的 0:00–3:00）回归。
 *
 * 覆盖：场景装配、三句提示的推进、陶罐必须被"扔"才碎、确定性。
 *
 * 对应：设计 §7（序章前 12 分钟实作样板）、D-043（分批交付）、D-044（可破坏场景物）
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ROPE_RECONGEAL_SEC } from '../assets/scripts/core/constants'
import { createHintState, hintStep, hintText } from '../assets/scripts/core/hints'
import { input } from '../assets/scripts/core/input'
import { PROLOGUE, PrologueScene } from '../assets/scripts/core/scene_prologue'
import { TEXTS, totalTextLength } from '../assets/scripts/core/texts'
import { NO_INPUT } from './helpers'

test('序章批 1 只包含设计 §7 那几样东西（空场景 + 一块石头 + 一个陶罐）', () => {
  const sc = new PrologueScene()
  assert.deepEqual(
    sc.world.bodies.map((b) => b.name),
    ['ground', 'ceiling', 'wall-left', 'wall-right', 'player', 'stone', 'jar'],
  )
  assert.equal(sc.world.findByTag('enemy').length, 0, '批 1 一个敌人都没有')
  assert.equal(sc.world.ropes.length, 1, '序章从 1 根丝开始（设计 §3.3）')
  assert.equal(sc.player.grounded, true)
})

test('序章参数与设计 §2.6 的质量表一致', () => {
  const sc = new PrologueScene()
  assert.equal(sc.player.damageMass, 0.5, '主角 0.5')
  assert.equal(sc.stone.damageMass, 4, '石块 4')
  assert.equal(sc.jar.damageMass, 0.6, '陶罐 0.6')
  assert.equal(sc.jar.shattersOnDeath, true, '陶罐死亡即碎裂消失')
  assert.equal(sc.jar.anchorable, false, '陶罐是弹药，不是锚点')
  // 陶罐在投掷方向上，且远在射程内（D-039 有效射程 ~15m，D-031 交战距离 ≤ 8m）
  const dist = PROLOGUE.jarX - PROLOGUE.playerX
  assert.ok(dist > 4 && dist <= 10, `陶罐距离 ${dist}m 应落在"必须扔、但扔得到"的区间`)
})

test('设计 §7 的三句提示按"玩家做到了"推进，而不是按秒表', () => {
  const s = createHintState()
  assert.equal(hintText(s), TEXTS.hintAttach)
  s.everAttached = true
  assert.equal(hintText(s), TEXTS.hintReel)
  s.everReeled = true
  assert.equal(hintText(s), TEXTS.hintCut)
  s.everCut = true
  assert.equal(hintText(s), null, '三件都学会之后必须什么都不显示')
  assert.equal(hintStep(s), 'done')
})

test('提示推进由真实操作驱动（连上 → 收丝 → 断丝）', () => {
  const sc = new PrologueScene()
  assert.equal(sc.hint(), TEXTS.hintAttach)

  // 牵上石块
  sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))
  assert.equal(sc.hint(), TEXTS.hintReel)

  // 收丝
  sc.step(input({ reel: 'in' }))
  assert.equal(sc.hint(), TEXTS.hintCut)

  // 断丝
  sc.step(input({ cutRope: 0 }))
  assert.equal(sc.hint(), null, '断完丝之后进入"无提示"状态——这是设计要的，不是 bug')
})

test('陶罐：轻轻蹭到不会碎，扔上去才会碎（D-044）', () => {
  // 慢速：从 x=11 以 3 m/s 滑向 x=13 的陶罐
  const slow = new PrologueScene()
  slow.stone.pos = { x: 11, y: 0.51 }
  slow.stone.vel = { x: 3, y: 0 }
  for (let i = 0; i < 90; i++) slow.step(NO_INPUT)
  assert.equal(slow.jarBroken, false, '3 m/s 蹭上去不该碎（切割门槛 v ≥ 15 之外，且伤害 < 1）')

  // 投掷速度：20 m/s
  const fast = new PrologueScene()
  fast.stone.pos = { x: 11, y: 0.51 }
  fast.stone.vel = { x: 20, y: 0 }
  for (let i = 0; i < 90; i++) fast.step(NO_INPUT)
  assert.equal(fast.jarBroken, true, '20 m/s 砸上去应该碎')
  assert.equal(fast.jar.removed, true, '碎裂后应从世界移除（碰撞与渲染一起）')
})

test('碎裂的陶罐不再参与碰撞', () => {
  const sc = new PrologueScene()
  sc.jar.hp = 0
  sc.jar.alive = false
  sc.jar.removed = true
  const x0 = sc.stone.pos.x
  sc.stone.pos = { x: PROLOGUE.jarX, y: 0.51 }
  sc.stone.vel = { x: 10, y: 0 }
  for (let i = 0; i < 30; i++) sc.step(NO_INPUT)
  assert.ok(sc.stone.pos.x > PROLOGUE.jarX + 0.5, '石块应直接穿过去，而不是被"空气陶罐"挡住')
  assert.ok(x0 >= 0)
})

test('序章 reset() 回到可复现的初态（含提示进度）', () => {
  const sc = new PrologueScene()
  const h0 = sc.world.stateHash()
  sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))
  sc.step(input({ reel: 'in' }))
  assert.notEqual(sc.hint(), TEXTS.hintAttach)

  sc.reset()
  assert.equal(sc.world.stateHash(), h0)
  assert.equal(sc.hint(), TEXTS.hintAttach, '提示进度也要回到起点')
  assert.equal(sc.jarBroken, false)
  assert.equal(sc.world.ropes[0]!.state, 'idle')
})

test('序章批 1 也是确定性的（同一输入序列 → 同一哈希）', () => {
  const play = (): string => {
    const sc = new PrologueScene()
    sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))
    for (let i = 0; i < 120; i++) {
      sc.step(input({ moveX: Math.floor(i / 30) % 2 === 0 ? 1 : -1, reel: 'in' }))
    }
    sc.step(input({ cutRope: 0 }))
    for (let i = 0; i < 120; i++) sc.step(NO_INPUT)
    return sc.world.stateHash()
  }
  assert.equal(play(), play())
})

test('NFR-I18N-003：玩家可见文案全部走资源表，且总量远低于 500 字', () => {
  assert.ok(totalTextLength() > 0)
  assert.ok(
    totalTextLength() <= 500,
    `全游戏文本 ${totalTextLength()} 字，必须 ≤ 500（FR-UI-007）`,
  )
  // 这三句必须逐字等于设计 §7 的原文
  assert.equal(TEXTS.hintAttach, '按住，拖向石头')
  assert.equal(TEXTS.hintReel, '按住不放')
  assert.equal(TEXTS.hintCut, '点一下丝线')
})

test('断丝重凝在序章同样生效（AC-21 不因换场景而失效）', () => {
  const sc = new PrologueScene()
  sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))
  sc.step(input({ cutRope: 0 }))
  assert.equal(sc.world.ropes[0]!.state, 'recovering')
  assert.ok(Math.abs(sc.world.ropes[0]!.recongealRemaining - ROPE_RECONGEAL_SEC) < 1e-6)
})
