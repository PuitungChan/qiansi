/**
 * 物理与丝线的集成行为。
 *
 * 对应：FR-PHY-001/003/006/007/011/014 · AC-19 / AC-20 / AC-21
 * 口径依据：DECISIONS D-019（着地模型）、D-020（连接语义与移动）、D-026（M0 敌人行为）
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PLAYER_MASS_AIRBORNE, PLAYER_MASS_GROUNDED, ROPE_RECONGEAL_SEC } from '../assets/scripts/core/constants'
import { input } from '../assets/scripts/core/input'
import { M0Scenario } from '../assets/scripts/core/scene_m0'
import { addEnemy, addProp, emptyWorld, flatScene, NO_INPUT, runIdle, speedOf } from './helpers'

// ── FR-PHY-003 / AC-20：着地 / 离地的等效质量 ──────────────

test('AC-20 主角着地时等效质量视为 ∞，离地时为 0.5（FR-PHY-003）', () => {
  const { world, player } = flatScene()
  assert.equal(player.grounded, true)
  assert.equal(player.mass, PLAYER_MASS_GROUNDED)

  // 抬到空中 → 离地
  player.pos = { x: 0, y: 8 }
  player.vel = { x: 0, y: 0 }
  runIdle(world, 1)
  assert.equal(player.grounded, false)
  assert.equal(player.mass, PLAYER_MASS_AIRBORNE)

  // 落回地面 → 恢复 ∞
  runIdle(world, 120)
  assert.equal(player.grounded, true)
  assert.equal(player.mass, PLAYER_MASS_GROUNDED)
})

test('AC-20 着地时甩得动重物（主角是锚点，自己不动）', () => {
  const { world, player } = flatScene()
  const heavy = addProp(world, { x: 6, mass: 40, radius: 1 })
  world.step(input({ aimPoint: { x: heavy.pos.x, y: heavy.pos.y }, attachPressed: true }))

  const playerX0 = player.pos.x
  const heavyX0 = heavy.pos.x
  for (let i = 0; i < 60; i++) world.step(input({ reel: 'in' }))

  const playerMoved = Math.abs(player.pos.x - playerX0)
  const heavyMoved = Math.abs(heavy.pos.x - heavyX0)
  assert.ok(playerMoved < 0.2, `着地时主角不该被拉走，实际位移 ${playerMoved.toFixed(3)}`)
  assert.ok(heavyMoved > 1, `重物应被拉过来，实际位移 ${heavyMoved.toFixed(3)}`)
})

test('AC-20 离地时被重物拉走（物体是锚点，主角飞过去）', () => {
  const { world, player } = flatScene()

  // 先离地（质量切到 0.5），再连接——顺序很重要：
  // 若先连接再把主角瞬移开，会在连接瞬间产生几千牛的伸长，直接触发超限断弦，
  // 那就测不到"被拉走"了。
  player.pos = { x: 0, y: 8 }
  player.vel = { x: 0, y: 0 }
  runIdle(world, 1)
  assert.equal(player.grounded, false)

  const heavy = addProp(world, { x: 6, mass: 40, radius: 1 })
  world.step(input({ aimPoint: { x: heavy.pos.x, y: heavy.pos.y }, attachPressed: true }))
  assert.equal(world.ropes[0]!.state, 'attached')

  const playerX0 = player.pos.x
  for (let i = 0; i < 20; i++) {
    world.step(input({ reel: 'in' }))
    assert.equal(player.mass, PLAYER_MASS_AIRBORNE, '被拉走的过程中应保持离地质量')
  }
  for (let i = 0; i < 40; i++) world.step(input({ reel: 'in' }))

  assert.ok(
    Math.abs(player.pos.x - playerX0) > 1,
    `离地时主角应被重物拉走，实际位移 ${(player.pos.x - playerX0).toFixed(3)}`,
  )
})

// ── FR-PHY-001 / AC-19：丝只能拉，不能推 ──────────────────

test('AC-19 松弛的丝不产生任何力，也不会把物体推开', () => {
  const { world, player } = flatScene()
  const prop = addProp(world, { x: 5, mass: 4 })
  world.step(input({ aimPoint: { x: prop.pos.x, y: prop.pos.y }, attachPressed: true }))
  assert.equal(world.ropes[0]!.state, 'attached')

  // 放丝把丝放到最长 → 松弛
  for (let i = 0; i < 90; i++) world.step(input({ reel: 'out' }))
  assert.equal(world.ropes[0]!.tension, 0)

  prop.vel = { x: 0, y: 0 }
  const x0 = prop.pos.x
  // 主角朝物体冲过去：如果丝会推，物体会被顶开
  for (let i = 0; i < 40; i++) world.step(input({ moveX: 1 }))
  assert.equal(world.ropes[0]!.tension, 0)
  assert.ok(prop.pos.x <= x0 + 0.05, `物体不该被推动，实际位移 ${(prop.pos.x - x0).toFixed(3)}`)
})

test('AC-19 连接瞬间不产生拉力（D-020：丝长 = 当前距离）', () => {
  const s = flatScene()
  const prop = addProp(s.world, { x: 5, mass: 4 })
  s.world.step(input({ aimPoint: { x: prop.pos.x, y: prop.pos.y }, attachPressed: true }))
  const r = s.world.ropes[0]!
  assert.equal(r.state, 'attached')
  assert.equal(r.tension, 0)
  assert.ok(Math.abs(r.targetLength - r.length) < 1e-9)
})

test('AC-19 放丝与断丝行为可区分（FR-PHY-011）', () => {
  const { world } = flatScene()
  const prop = addProp(world, { x: 5, mass: 4 })
  world.step(input({ aimPoint: { x: prop.pos.x, y: prop.pos.y }, attachPressed: true }))

  // 放丝：丝仍在，丝位仍可用
  for (let i = 0; i < 30; i++) world.step(input({ reel: 'out' }))
  assert.equal(world.ropes[0]!.state, 'attached')
  assert.ok(world.ropes[0]!.targetLength > 5)

  // 断丝：丝离开，丝位进入重凝
  world.step(input({ cutRope: 0 }))
  assert.equal(world.ropes[0]!.state, 'recovering')
  assert.equal(world.ropes[0]!.targetId, -1)
})

// ── FR-PHY-007 / AC-21：断丝重凝 ─────────────────────────

test('AC-21 断丝后该丝位 1.5s 不可用，之后自动恢复（FR-PHY-007）', () => {
  const { world } = flatScene()
  const prop = addProp(world, { x: 5, mass: 4 })
  world.step(input({ aimPoint: { x: prop.pos.x, y: prop.pos.y }, attachPressed: true }))
  world.step(input({ cutRope: 0 }))

  assert.equal(world.ropes[0]!.state, 'recovering')
  assert.ok(Math.abs(world.ropes[0]!.recongealRemaining - ROPE_RECONGEAL_SEC) < 1e-6)

  // 冷却期间无法再附着（石块移到容差外但仍在最大丝长内）
  prop.pos = { x: 10, y: 0.51 }
  prop.vel = { x: 0, y: 0 }
  runIdle(world, 60)
  assert.equal(world.ropes[0]!.state, 'recovering')
  world.step(input({ aimPoint: { x: prop.pos.x, y: prop.pos.y }, attachPressed: true }))
  assert.equal(world.ropes[0]!.state, 'recovering', '冷却期内不应附着成功')

  // 90 tick = 1.5s
  runIdle(world, 40)
  assert.equal(world.ropes[0]!.state, 'idle')
  world.step(input({ aimPoint: { x: prop.pos.x, y: prop.pos.y }, attachPressed: true }))
  assert.equal(world.ropes[0]!.state, 'attached', '冷却结束后应可再次附着')
})

// ── FR-PHY-004/006：张力与超限断弦 ───────────────────────

test('收丝机在额定负载处堵转：一直按住收丝不会自己把丝绷断', () => {
  const sc = new M0Scenario()
  sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))
  for (let i = 0; i < 300; i++) sc.step(input({ reel: 'in' }))

  const r = sc.world.ropes[0]!
  assert.equal(r.state, 'attached', '纯收丝不应导致断弦')
  assert.ok(
    r.tension < sc.world.config.tensionMax,
    `张力应停在额定值以下，实际 ${r.tension.toFixed(1)}`,
  )
  assert.equal(sc.world.stunRemaining, 0)
})

test('超限断弦：张力过载时断裂并硬直 0.8s（FR-PHY-006）', () => {
  const sc = new M0Scenario()
  sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))

  // 模拟"被猛拽"：给石块一个远离主角的高速
  sc.stone.vel = { x: 30, y: 20 }
  let brokeOn = -1
  for (let i = 0; i < 30; i++) {
    sc.step(NO_INPUT)
    if (sc.world.ropes[0]!.state !== 'attached') {
      brokeOn = i
      break
    }
  }
  assert.ok(brokeOn >= 0, '过载应导致断弦')
  assert.equal(sc.world.ropes[0]!.lastBreakReason, 'over-tension')
  assert.ok(sc.world.stunRemaining > 0.7, `硬直应接近 0.8s，实际 ${sc.world.stunRemaining}`)
})

test('硬直期间不响应移动输入（FR-PHY-006）', () => {
  const sc = new M0Scenario()
  sc.world.stunRemaining = 0.8
  const x0 = sc.player.pos.x
  sc.step(input({ moveX: 1 }))
  assert.equal(sc.player.pos.x, x0, '硬直期间主角不该移动')
})

// ── FR-PHY-014：物理量记录 ───────────────────────────────

test('FR-PHY-014 每个刚体都暴露质量 / 速度 / 动能 / 动量', () => {
  const { world } = flatScene()
  const prop = addProp(world, { x: 3, mass: 4, vx: 10, vy: 0 })
  runIdle(world, 1)
  assert.ok(Math.abs(prop.momentum.x - prop.mass * prop.vel.x) < 1e-9)
  assert.ok(Math.abs(prop.momentum.y - prop.mass * prop.vel.y) < 1e-9)
  assert.ok(
    Math.abs(prop.kineticEnergy - 0.5 * prop.mass * speedOf(prop) ** 2) < 1e-9,
  )
})

// ── FR-CBT-002/003：撞击导致伤害 ─────────────────────────

function fireStoneAt(world: import('../assets/scripts/core/world').World, x: number, vx: number, y = 0.51) {
  const stone = addProp(world, { x, mass: 4, vx })
  stone.pos = { x, y }
  return stone
}

test('石块 @20 m/s 打墨甲造成约 20 伤害，需要两次击杀（附录 B 基线）', () => {
  // 主角远远挪开，避免石块生成在主角身体内部被挤停
  const { world } = flatScene({}, { playerX: -40 })
  const armor = addEnemy(world, { x: 5, mass: 20, hp: 30, weakness: 'impact' })

  const total = { dmg: 0 }
  const stone = fireStoneAt(world, 0, 20)
  for (let i = 0; i < 60; i++) {
    world.step(NO_INPUT)
    for (const e of world.events) {
      if (e.kind === 'damage' && e.target === armor.id) total.dmg += e.amount
    }
  }
  assert.ok(total.dmg > 17 && total.dmg < 21, `单次冲击应约 20，实际 ${total.dmg.toFixed(2)}`)
  assert.ok(armor.alive, '一次击杀不应致死')
  assert.ok(armor.hp > 0)

  // 第二发
  stone.pos = { x: 0, y: 0.51 }
  stone.vel = { x: 20, y: 0 }
  const dmg2 = { v: 0 }
  for (let i = 0; i < 60; i++) {
    world.step(NO_INPUT)
    for (const e of world.events) {
      if (e.kind === 'damage' && e.target === armor.id) dmg2.v += e.amount
    }
  }
  assert.ok(dmg2.v > 17, `第二发应再次造成约 20，实际 ${dmg2.v.toFixed(2)}`)
  assert.equal(armor.alive, false, '两次石块投掷应击杀墨甲')
})

test('石块 @20 m/s 一下打死墨卒（设计 §7 序章）', () => {
  const { world } = flatScene({}, { playerX: -40 })
  const minion = addEnemy(world, { x: 5, mass: 1, hp: 5, weakness: 'any', half: 0.4 })
  fireStoneAt(world, 0, 20)
  for (let i = 0; i < 60; i++) world.step(NO_INPUT)
  assert.equal(minion.alive, false, '墨卒应一下死——它是教学工具，不是挑战')
})

test('陶罐(0.6) @40 打墨甲完全无效，打墨刃一下死（设计 §4.1 物理即克制）', () => {
  const a = flatScene({}, { playerX: -40 })
  const armor = addEnemy(a.world, { x: 5, mass: 20, hp: 30, weakness: 'impact' })
  const potA = addProp(a.world, { x: 0, mass: 0.6, radius: 0.3, vx: 40 })
  potA.pos = { x: 0, y: 0.31 }
  for (let i = 0; i < 60; i++) a.world.step(NO_INPUT)
  assert.equal(armor.hp, 30, '陶罐质量不够，墨甲纹丝不动')

  const b = flatScene({}, { playerX: -40 })
  const blade = addEnemy(b.world, { x: 5, mass: 0.5, hp: 12, weakness: 'cut', half: 0.3 })
  const potB = addProp(b.world, { x: 0, mass: 0.6, radius: 0.3, vx: 40 })
  potB.pos = { x: 0, y: 0.31 }
  for (let i = 0; i < 60; i++) b.world.step(NO_INPUT)
  assert.equal(blade.alive, false, '高速轻弹丸应能一击穿透墨刃')
})

test('主角走路撞不死任何敌人（玩家不产生力量）', () => {
  const { world, player } = flatScene()
  const minion = addEnemy(world, { x: 3, mass: 1, hp: 5, weakness: 'any', half: 0.4 })
  for (let i = 0; i < 120; i++) world.step(input({ moveX: 1 }))
  assert.ok(player.pos.x > 2, '主角应确实走到了墨卒身边')
  assert.equal(minion.hp, 5, '主角(0.5)撞墨卒不该造成任何伤害')
})
