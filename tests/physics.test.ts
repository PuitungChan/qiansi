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
import { addEnemy, addProp, emptyWorld, fire, fireNoWait, flatScene, NO_INPUT, rawHost, runIdle, speedOf } from './helpers'

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
  fire(rawHost(world), heavy.pos)

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
  fire(rawHost(world), heavy.pos)
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
  fire(rawHost(world), prop.pos)
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
  fire(rawHost(s.world), prop.pos)
  const r = s.world.ropes[0]!
  assert.equal(r.state, 'attached')
  assert.equal(r.tension, 0)
  assert.ok(Math.abs(r.targetLength - r.length) < 1e-9)
})

test('AC-19 放丝与断丝行为可区分（FR-PHY-011）', () => {
  const { world } = flatScene()
  const prop = addProp(world, { x: 5, mass: 4 })
  fire(rawHost(world), prop.pos)

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
  fire(rawHost(world), prop.pos)
  world.step(input({ cutRope: 0 }))

  assert.equal(world.ropes[0]!.state, 'recovering')
  assert.ok(Math.abs(world.ropes[0]!.recongealRemaining - ROPE_RECONGEAL_SEC) < 1e-6)

  // 冷却期间无法再附着（石块移到容差外但仍在最大丝长内）
  prop.pos = { x: 10, y: 0.51 }
  prop.vel = { x: 0, y: 0 }
  runIdle(world, 60)
  assert.equal(world.ropes[0]!.state, 'recovering')
  fireNoWait(rawHost(world), prop.pos)
  assert.equal(world.ropes[0]!.state, 'recovering', '冷却期内不应附着成功')

  // 90 tick = 1.5s
  runIdle(world, 40)
  assert.equal(world.ropes[0]!.state, 'idle')
  fire(rawHost(world), prop.pos)
  assert.equal(world.ropes[0]!.state, 'attached', '冷却结束后应可再次附着')
})

// ── 张力：到顶变刚性（D-032，取代 FR-PHY-006 的"超限断裂"）────────

test('一直按住收丝不会把丝绷断（D-032）', () => {
  const sc = new M0Scenario()
  fire(sc, sc.stone.pos)
  for (let i = 0; i < 300; i++) sc.step(input({ reel: 'in' }))

  const r = sc.world.ropes[0]!
  assert.equal(r.state, 'attached', '纯收丝不应导致断丝')
  assert.ok(
    r.tension <= sc.world.config.tensionMax + 1e-6,
    `张力应被夹在上限内，实际 ${r.tension.toFixed(1)}`,
  )
  assert.equal(sc.world.stunRemaining, 0)
})

test('D-032 张力到顶不再断丝，而是拉紧（取代 FR-PHY-006 的"超限断裂"）', () => {
  const sc = new M0Scenario()
  fire(sc, sc.stone.pos)

  // 模拟"被猛拽"：给石块一个远离主角的高速。旧版这里会断丝 + 硬直。
  sc.stone.vel = { x: 30, y: 20 }
  let peak = 0
  for (let i = 0; i < 90; i++) {
    sc.step(NO_INPUT)
    peak = Math.max(peak, sc.world.ropes[0]!.tension)
  }

  assert.equal(sc.world.ropes[0]!.state, 'attached', '过载不该断丝')
  assert.equal(sc.world.stunRemaining, 0, '不该有硬直')
  assert.ok(peak <= sc.world.config.tensionMax + 1e-6, `峰值 ${peak.toFixed(1)} 应不超上限`)
  // 被猛拽之后应该被"拉回来"，而不是飞走
  assert.ok(
    Math.hypot(sc.stone.vel.x, sc.stone.vel.y) < 30,
    '石块应被拉紧的丝减速，而不是带着 30 m/s 飞走',
  )
})

test('D-032 拉紧时：轻的一端被拉向重的一端（着地的主角几乎不动）', () => {
  const { world, player } = flatScene()
  const heavy = addProp(world, { x: 6, mass: 40, radius: 1 })
  fire(rawHost(world), heavy.pos)
  assert.equal(player.grounded, true)

  const px0 = player.pos.x
  const hx0 = heavy.pos.x
  for (let i = 0; i < 90; i++) world.step(input({ reel: 'in' }))

  assert.ok(Math.abs(player.pos.x - px0) < 0.3, '着地主角几乎不动')
  assert.ok(Math.abs(heavy.pos.x - hx0) > 1, '重物被拉过来')
})

test('D-032 拉紧时：主角离地且物体更重 ⇒ 主角被拉过去', () => {
  const { world, player } = flatScene()

  player.pos = { x: 0, y: 8 }
  player.vel = { x: 0, y: 0 }
  runIdle(world, 1)
  assert.equal(player.grounded, false)

  const heavy = addProp(world, { x: 6, mass: 40, radius: 1 })
  fire(rawHost(world), heavy.pos)

  const px0 = player.pos.x
  for (let i = 0; i < 90; i++) world.step(input({ reel: 'in' }))
  assert.ok(Math.abs(player.pos.x - px0) > 1, '离地主角应被更重的物体拉走')
})

test('D-035 主角与 prop 类物体一律不碰撞（可以走过去）', () => {
  const { world, player } = flatScene({}, { playerX: 0 })
  const stone = addProp(world, { x: 3, mass: 4 })

  const sx0 = stone.pos.x
  for (let i = 0; i < 180; i++) world.step(input({ moveX: 1 }))

  // 主角走了完整的 18m（3 秒 × 6 m/s）——石块不再挡路
  assert.ok(
    player.pos.x > 17,
    `主角不该被石块挡住，实际走了 ${player.pos.x.toFixed(2)}m（理论 18m）`,
  )
  // 石块也不该被推着跑
  assert.ok(
    Math.abs(stone.pos.x - sx0) < 0.5,
    `石块不该被推着走，实际位移 ${(stone.pos.x - sx0).toFixed(2)}`,
  )
})

test('主角仍然会与敌人碰撞（豁免只针对 prop）', () => {
  // 对照实验：同一个位置放 prop 与放敌人，主角走过去的结果必须不同
  const a = flatScene({}, { playerX: 0 })
  const propA = addProp(a.world, { x: 3, mass: 4 })
  for (let i = 0; i < 120; i++) a.world.step(input({ moveX: 1 }))

  const b = flatScene({}, { playerX: 0 })
  const enemyB = addEnemy(b.world, { x: 3, mass: 20, hp: 30, weakness: 'impact' })
  for (let i = 0; i < 120; i++) b.world.step(input({ moveX: 1 }))

  // prop：被完全穿过，自己纹丝不动
  assert.ok(
    Math.abs(propA.pos.x - 3) < 0.5,
    `prop 不该被推动，实际位移 ${(propA.pos.x - 3).toFixed(2)}`,
  )
  // 敌人：碰撞生效，被主角推着走（着地的主角等效质量 ∞，推得动 20 质量的墨甲）
  assert.ok(
    enemyB.pos.x > 3.5,
    `敌人应被推动（碰撞生效），实际 ${enemyB.pos.x.toFixed(2)}`,
  )
})

test('D-037 被丝牵住的物体不造成伤害（「断丝 = 攻击」，设计 §2.3）', () => {
  const sc = new M0Scenario()
  fire(sc, sc.stone.pos)
  // 把墨甲搬到主角右侧，然后把石块收到它身上
  sc.armor.pos = { x: sc.player.pos.x + 2, y: 0.81 }
  let damageWhileHeld = 0
  for (let i = 0; i < 120; i++) {
    sc.step(input({ reel: 'in' }))
    for (const e of sc.world.events) {
      if (e.kind === 'damage' && e.target === sc.armor.id) damageWhileHeld += e.amount
    }
  }
  assert.equal(damageWhileHeld, 0, '牵在手上的石块不该造成任何伤害')
  assert.equal(sc.armor.hp, 30)

  // 断丝之后同一颗石块撞上去才算数
  sc.stone.vel = { x: 20, y: 0 }
  sc.step(input({ cutRope: 0 }))
  let damageAfterCut = 0
  for (let i = 0; i < 40; i++) {
    sc.step(NO_INPUT)
    for (const e of sc.world.events) {
      if (e.kind === 'damage' && e.target === sc.armor.id) damageAfterCut += e.amount
    }
  }
  assert.ok(damageAfterCut > 0, '断丝之后才应该造成伤害')
})

test('D-037 蹭到不算砸到：低于最小伤害速度不产生伤害', () => {
  const { world } = flatScene({}, { playerX: -40 })
  const armor = addEnemy(world, { x: 4, mass: 20, hp: 30, weakness: 'impact' })
  const stone = addProp(world, { x: 2, mass: 4 })
  stone.pos = { x: 2, y: 0.51 }
  stone.vel = { x: 3, y: 0 } // 3 m/s < MIN_DAMAGE_SPEED(6)
  for (let i = 0; i < 60; i++) world.step(NO_INPUT)
  assert.equal(armor.hp, 30, '慢速蹭上去不该掉血')
})

test('D-036 敌人不可被丝线附着（「墨丝」心法第四章才解锁，设计 §5）', () => {
  const sc = new M0Scenario()
  assert.equal(sc.armor.anchorable, false)
  // 站在墨甲旁边试着牵它 → 不该连上
  sc.player.pos = { x: sc.armor.pos.x - 2, y: sc.player.pos.y }
  fire(sc, sc.armor.pos)
  assert.equal(sc.world.ropes[0]!.state, 'idle', 'R1 阶段不该能牵住敌人')
})

test('D-039 投出的石块速度衰减不能太快（投掷射程回归护栏）', () => {
  // M0 没有自转（D-025），石块不能滚、只能滑。若用默认摩擦（0.4），
  // 等效 μ = √(0.4×0.8) = 0.566 ⇒ 减速度 11.3 m/s²，20 m/s 投出后：
  //   3m→18.1  6m→16.2  9m→14.0  12m→11.3  15m→7.7（快掉到伤害门槛 6 以下）
  // 创始人实机反馈「速度衰减太快，基本上要贴近敌人甩出去才能砸到」→ D-039 降到 0.1。
  const { world } = flatScene({}, { playerX: -40 })
  const stone = addProp(world, { x: 0, mass: 4 })
  stone.pos = { x: 0, y: 0.51 }
  stone.vel = { x: 20, y: 0 }

  const marks = [6, 12]
  const speedAt: Record<number, number> = {}
  let next = 0
  for (let i = 0; i < 240 && next < marks.length; i++) {
    world.step(NO_INPUT)
    while (next < marks.length && stone.pos.x >= marks[next]!) {
      speedAt[marks[next]!] = Math.hypot(stone.vel.x, stone.vel.y)
      next++
    }
  }

  assert.ok(speedAt[6]! > 17, `6m 处应保留大部分速度，实际 ${speedAt[6]!.toFixed(1)} m/s`)
  assert.ok(
    speedAt[12]! > 15,
    `12m 处应仍有足够伤害（>15 m/s），实际 ${speedAt[12]!.toFixed(1)} m/s —— ` +
      `衰减太快会让玩家只能贴脸投掷`,
  )
})

test('D-033 断丝时物体若在主角体内，不应把主角撞飞（实机反馈 #4）', () => {
  const sc = new M0Scenario()
  fire(sc, sc.stone.pos)
  // 疯狂收丝，把石块收进主角身体里
  for (let i = 0; i < 120; i++) sc.step(input({ reel: 'in' }))

  const d = Math.hypot(sc.stone.pos.x - sc.player.pos.x, sc.stone.pos.y - sc.player.pos.y)
  assert.ok(d < 1.0, `石块应已被收到主角身边，实际距离 ${d.toFixed(2)}`)

  const px0 = sc.player.pos.x
  sc.step(input({ cutRope: 0 }))
  assert.equal(sc.stone.ignorePlayer, true, '断丝瞬间应进入脱离豁免')
  for (let i = 0; i < 30; i++) sc.step(NO_INPUT)

  assert.ok(
    Math.abs(sc.player.pos.x - px0) < 0.5,
    `断丝不该把主角撞飞，实际位移 ${(sc.player.pos.x - px0).toFixed(2)}`,
  )
})

test('脱离豁免在两者分开后自动撤销（恢复正常碰撞）', () => {
  const sc = new M0Scenario()
  fire(sc, sc.stone.pos)
  for (let i = 0; i < 120; i++) sc.step(input({ reel: 'in' }))
  sc.step(input({ cutRope: 0 }))
  assert.equal(sc.stone.ignorePlayer, true)

  // 把石块扔远，等它离开主角的包围盒
  sc.stone.pos = { x: sc.player.pos.x + 6, y: 3 }
  sc.step(NO_INPUT)
  assert.equal(sc.stone.ignorePlayer, false, '分开之后应恢复碰撞')
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
