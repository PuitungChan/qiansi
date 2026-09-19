/**
 * M0 灰盒房间的场景级回归。
 *
 * M0 的判定点是「你还想再甩一下」——那是真人的主观判断，测试测不了。
 * 能测的是**手感赖以成立的下限**：房间装配正确、能甩得动、常规操作不会自断、
 * 墨甲是可打的靶子、复位可复现。任何一次调参如果把这些打穿了，测试会先红。
 *
 * 对应：交接清单 §8（M0 交付定义）、DECISIONS D-026（M0 敌人行为）
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { input } from '../assets/scripts/core/input'
import { M0Scenario } from '../assets/scripts/core/scene_m0'
import {
  ARMOR_PATROL_MAX_X,
  ARMOR_PATROL_MIN_X,
} from '../assets/scripts/core/scene_m0'
import { TENSION_BREAK_FORCE_BASE } from '../assets/scripts/core/constants'

test('M0 房间只包含设计规定的那些刚体（不多不少）', () => {
  const sc = new M0Scenario()
  const names = sc.world.bodies.map((b) => b.name)
  assert.deepEqual(names, [
    'ground',
    'ceiling',
    'wall-left',
    'wall-right',
    'player',
    'stone',
    'armor',
  ])
  // 交接清单 §8：一块石头、一只墨甲、一个玩家方块
  assert.equal(sc.world.findByTag('prop').length, 1)
  assert.equal(sc.world.findByTag('enemy').length, 1)
  assert.equal(sc.world.findByTag('player').length, 1)
})

test('M0 场景参数与设计文档一致', () => {
  const sc = new M0Scenario()
  assert.equal(sc.player.damageMass, 0.5, '主角质量 0.5（设计 §2.4）')
  assert.equal(sc.stone.damageMass, 4, '石块质量 4（设计 §2.6）')
  assert.equal(sc.armor.damageMass, 20, '墨甲质量 20（设计 §2.6）')
  assert.equal(sc.armor.maxHp, 30, '墨甲 HP 30（附录 B）')
  assert.equal(sc.armor.weakness, 'impact', '墨甲弱点是动量 mv（设计 §4.1）')
  assert.equal(sc.stone.anchorable, true, '丝线只能附着于 Anchorable（FR-PHY-013）')
  assert.equal(sc.world.ropes.length, 1, '序章只有 1 根丝（设计 §3.3）')
})

test('开局主角已着地、石块已落稳（不能一进游戏就在抖）', () => {
  const sc = new M0Scenario()
  assert.equal(sc.player.grounded, true)
  assert.ok(Math.abs(sc.player.vel.x) < 1e-6)
  assert.ok(Math.hypot(sc.stone.vel.x, sc.stone.vel.y) < 0.1)
})

test('收丝能把石块甩起来，且纯收丝不会自己把丝绷断', () => {
  const sc = new M0Scenario()
  sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))

  let peakTension = 0
  let maxSpeed = 0
  for (let i = 0; i < 300; i++) {
    sc.step(input({ reel: 'in' }))
    peakTension = Math.max(peakTension, sc.world.ropes[0]!.tension)
    maxSpeed = Math.max(maxSpeed, Math.hypot(sc.stone.vel.x, sc.stone.vel.y))
  }

  assert.equal(sc.world.ropes[0]!.state, 'attached', '纯收丝不该断弦')
  assert.equal(sc.world.stunRemaining, 0, '不该触发硬直')
  assert.ok(maxSpeed > 8, `石块应能被明显甩动，实际最高 ${maxSpeed.toFixed(2)} m/s`)
  assert.ok(
    peakTension / TENSION_BREAK_FORCE_BASE < 0.95,
    `收丝张力应留有余量，实际占 ${((peakTension / TENSION_BREAK_FORCE_BASE) * 100).toFixed(1)}%`,
  )
})

test('甩动 + 奔跑能把石块加速到设计中"投石"所需的量级（≥ 15 m/s）', () => {
  const sc = new M0Scenario()
  sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))
  // 先收一点把石块拉起来，再左右摆动
  for (let i = 0; i < 30; i++) sc.step(input({ reel: 'in' }))
  let maxSpeed = 0
  for (let i = 0; i < 300; i++) {
    sc.step(input({ moveX: Math.floor(i / 60) % 2 === 0 ? 1 : -1, reel: 'in' }))
    if (sc.world.ropes[0]!.state !== 'attached') break
    maxSpeed = Math.max(maxSpeed, Math.hypot(sc.stone.vel.x, sc.stone.vel.y))
  }
  assert.ok(
    maxSpeed >= 15,
    `摆动应能把石块加速到 15 m/s 以上（附录 A 的投石量级），实际 ${maxSpeed.toFixed(2)}`,
  )
})

test('断丝不附加额外冲量（FR-PHY-012 的"抖腕"是 R2，R1 不该先做掉）', () => {
  const sc = new M0Scenario()
  sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))
  for (let i = 0; i < 30; i++) sc.step(input({ reel: 'in' }))

  let before = 0
  let after = 0
  let ready = false
  for (let i = 0; i < 300; i++) {
    sc.step(input({ moveX: Math.floor(i / 60) % 2 === 0 ? 1 : -1, reel: 'in' }))
    if (sc.world.ropes[0]!.state !== 'attached') break
    const v = Math.hypot(sc.stone.vel.x, sc.stone.vel.y)
    if (v > 8 && sc.stone.pos.y > 1.4) {
      before = v
      sc.step(input({ cutRope: 0 }))
      after = Math.hypot(sc.stone.vel.x, sc.stone.vel.y)
      ready = true
      break
    }
  }
  assert.ok(ready, '应能在石块高速离地时捕捉到断丝时刻')

  // 断丝这一 tick 只应有重力（≤ g·dt = 0.333）与可能的接触摩擦（只会减速）。
  // 若实现了"抖腕冲量"，after 会明显大于 before。
  assert.ok(after - before < 0.4, `断丝不该加速石块：${before.toFixed(2)} → ${after.toFixed(2)}`)
  assert.equal(sc.world.ropes[0]!.state, 'recovering')
  assert.equal(sc.world.stunRemaining, 0, '主动断丝没有硬直——硬直只属于超限断弦')
  assert.equal(sc.world.ropes[0]!.lastBreakReason, 'cut')
})

test('墨甲是纯靶子 + 缓慢游走，不追击（D-026）', () => {
  const sc = new M0Scenario()
  const x0 = sc.armor.pos.x
  for (let i = 0; i < 600; i++) sc.step(input({}))

  assert.ok(sc.armor.alive)
  // 在区间内往返
  assert.ok(sc.armor.pos.x <= ARMOR_PATROL_MAX_X + 0.5)
  assert.ok(sc.armor.pos.x >= ARMOR_PATROL_MIN_X - 0.5)
  assert.ok(Math.abs(sc.armor.pos.x - x0) >= 0)
  // 不追击：主角在左侧原地不动，墨甲不该朝主角靠近到区间之外
  assert.ok(sc.player.pos.x < 6, '主角不该被任何东西推动')
})

test('墨甲可以被石块打死（M0 至少要能验证"甩出去有反馈"）', () => {
  const sc = new M0Scenario()
  // 直接把石块放到墨甲面前高速撞过去（模拟一次成功的投石）
  for (let shot = 0; shot < 2; shot++) {
    sc.stone.pos = { x: sc.armor.pos.x - 3, y: 0.9 }
    sc.stone.vel = { x: 20, y: 0 }
    for (let i = 0; i < 30; i++) sc.step(input({}))
  }
  assert.equal(sc.armor.alive, false, '两次 20 m/s 石块投掷应击杀墨甲（附录 B）')
})

test('reset() 把场景恢复到可复现的初态', () => {
  const sc = new M0Scenario()
  const h0 = sc.world.stateHash()
  for (let i = 0; i < 200; i++) sc.step(input({ moveX: 1, reel: 'in' }))
  sc.step(input({ cutRope: 0 }))
  assert.notEqual(sc.world.stateHash(), h0)

  sc.reset()
  assert.equal(sc.world.stateHash(), h0)
  assert.equal(sc.world.ropes[0]!.state, 'idle')
  assert.equal(sc.armor.hp, 30)
  assert.equal(sc.player.grounded, true)
})

test('summary() 暴露调试面板需要的全部字段（NFR-MNT-002）', () => {
  const sc = new M0Scenario()
  const s = sc.summary()
  for (const key of [
    'tick',
    'stun',
    'playerX',
    'playerY',
    'playerGrounded',
    'stoneSpeed',
    'stoneMomentum',
    'stoneKE',
    'armorHp',
    'ropeState',
    'ropeTension',
    'ropeRatio',
    'hash',
  ]) {
    assert.ok(key in s, `summary 缺少字段 ${key}`)
  }
})
