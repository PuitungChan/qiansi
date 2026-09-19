/**
 * 牵丝的**新操作语义**（第 13 轮实机反馈）。
 *
 * 创始人三条原话决定了这一整块行为：
 *   1. 「是否可以做成玩家长按屏幕瞄准，松手后发射丝线，松手的位置即是丝线附着的位置
 *      （如果松手的地方是空白那么不附着）」
 *   2. 「现在你做出来的丝线无论发射到物体的哪个位置，最终呈现出来都是附着在了物体的中间，
 *      我觉得这个不太好，有时候我可能想把丝线射到横梁的边上」
 *   3. 「我想看到发射丝线从角色射到物体上的一个动态过程，而不是瞬间出现一条相连的线」
 *
 * 对应：FR-ACT-002（牵）/ FR-PHY-013（附着）/ D-052
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { aabb, circle } from '../assets/scripts/core/body'
import * as C from '../assets/scripts/core/constants'
import { input } from '../assets/scripts/core/input'
import { PrologueScene } from '../assets/scripts/core/scene_prologue'
import { addProp, emptyWorld, fire, fireNoWait, flatScene, NO_INPUT, rawHost } from './helpers'

// ── 飞行 ──────────────────────────────────────────────

test('松手发射后，丝**先飞过去**（flying），到位那一刻才连上（attached）', () => {
  const world = emptyWorld().world
  const prop = addProp(world, { x: 5, mass: 4 })
  const host = rawHost(world)

  fireNoWait(host, prop.pos)
  assert.equal(world.ropes[0]!.state, 'flying', '刚松手应该是"飞出去"，不是"已连上"')
  assert.equal(world.ropes[0]!.targetId, prop.id, '目标在发射那一刻就锁定了')

  // 飞行的每一帧，丝头都应该在动（这就是"看得到过程"）
  const tip0 = { ...world.ropes[0]!.flyTip }
  world.step(NO_INPUT)
  const tip1 = { ...world.ropes[0]!.flyTip }
  assert.ok(
    Math.hypot(tip1.x - tip0.x, tip1.y - tip0.y) > 0,
    '丝头每帧都要往前挪——否则玩家看不到"射出去"的过程',
  )

  // 一路推到连上
  let ticks = 1
  while (world.ropes[0]!.state === 'flying' && ticks < 60) {
    world.step(NO_INPUT)
    ticks++
  }
  assert.equal(world.ropes[0]!.state, 'attached')
  // 距离 5m / 40 m/s ≈ 7.5 帧
  const expect = Math.ceil(5 / (C.ROPE_LAUNCH_SPEED * C.DT))
  assert.ok(
    Math.abs(ticks - expect) <= 2,
    `飞行时长应约为 ${expect} 帧，实际 ${ticks} 帧（速度 = ${C.ROPE_LAUNCH_SPEED} m/s）`,
  )
})

test('飞行期间**不传递任何力**：丝还在半路，物体和主角都不该被拉', () => {
  const world = emptyWorld().world
  const heavy = world.addBody({
    name: 'heavy',
    kind: 'dynamic',
    tag: 'prop',
    shape: aabb(1, 1),
    pos: { x: 6, y: 0 },
    mass: 60,
    friction: 0,
    restitution: 0,
    anchorable: true,
  })
  heavy.vel = { x: 0, y: 0 }

  fireNoWait(rawHost(world), heavy.pos)
  assert.equal(world.ropes[0]!.state, 'flying')

  // 只推进 2 帧（远不到位）
  world.step(input({ reel: 'in' }))
  world.step(input({ reel: 'in' }))
  assert.equal(world.ropes[0]!.state, 'flying', '还没到位')
  assert.equal(world.ropes[0]!.tension, 0, '飞行中张力必须恒为 0')
  assert.ok(Math.abs(heavy.pos.x - 6) < 1e-9, '飞行期间重物不该被拉动')
  assert.ok(
    Math.abs(heavy.vel.x) < 1e-9,
    `飞行期间不该给物体任何速度，实际 vx=${heavy.vel.x}`,
  )
})

test('目标在飞行途中消失 ⇒ 丝作废（不留一条指向虚空的线）', () => {
  const world = emptyWorld().world
  const prop = addProp(world, { x: 5, mass: 4 })
  fireNoWait(rawHost(world), prop.pos)
  assert.equal(world.ropes[0]!.state, 'flying')

  prop.removed = true
  world.step(NO_INPUT)
  assert.equal(world.ropes[0]!.state, 'recovering', '目标没了就该收丝重凝')
  assert.equal(world.ropes[0]!.targetId, -1)
})

// ── 附着点 ────────────────────────────────────────────

test('**附着点就是松手的那一点**，不再被吸到物体中心（创始人的原话）', () => {
  const world = emptyWorld().world
  const beam = world.addBody({
    name: 'beam',
    kind: 'static',
    tag: 'static',
    shape: aabb(5, 0.6),
    pos: { x: 6, y: 3 },
    anchorable: true,
  })

  // 故意瞄横梁的**左端**（离中心 4.5m）
  const aim = { x: 1.5, y: 3 }
  fire(rawHost(world), aim)

  const r = world.ropes[0]!
  assert.equal(r.state, 'attached')
  assert.equal(r.targetId, beam.id)
  const anchorX = beam.pos.x + r.anchorOffset.x
  const anchorY = beam.pos.y + r.anchorOffset.y
  assert.ok(
    Math.abs(anchorX - aim.x) < 1e-9 && Math.abs(anchorY - aim.y) < 1e-9,
    `锚点应等于松手点 (${aim.x}, ${aim.y})，实际 (${anchorX}, ${anchorY})`,
  )
  assert.ok(Math.abs(r.anchorOffset.x - -4.5) < 1e-9, '局部偏移应记录在物体坐标系里')
})

test('瞄物体**外沿一点点**（容差内）⇒ 吸附到最近的表面点；再远就不附着', () => {
  const world = emptyWorld().world
  world.addBody({
    name: 'rock',
    kind: 'static',
    tag: 'static',
    shape: aabb(1, 1),
    pos: { x: 4, y: 0 },
    anchorable: true,
  })
  const host = rawHost(world)

  // 距表面 0.4m（容差 0.9 之内）⇒ 连上，且落在表面上
  const near = { x: 4 + 1 + 0.4, y: 0 }
  assert.equal(fire(host, near), true, '容差内应该连得上')
  assert.ok(
    Math.abs(world.ropes[0]!.anchorOffset.x - 1) < 1e-9,
    '锚点应吸附到表面（x 偏移 = 半宽 1）',
  )

  world.step(input({ cutRope: 0 }))
  for (let i = 0; i < 100; i++) world.step(NO_INPUT) // 等重凝

  // 距表面 2m（容差之外）⇒ 不附着
  const far = { x: 4 + 1 + 2, y: 0 }
  assert.equal(fire(host, far), false, '松手在空白处不该附着')
  assert.equal(world.ropes[0]!.state, 'idle', '落空不该占用丝位')
})

test('落空会发一个 `rope-missed` 事件（渲染层/埋点据此给反馈）', () => {
  const world = emptyWorld().world
  addProp(world, { x: 5, mass: 4 })
  fireNoWait(rawHost(world), { x: -8, y: 6 }) // 空处
  assert.ok(
    world.events.some((e) => e.kind === 'rope-missed'),
    '松手在空白处应发 miss 事件',
  )
})

test('超出丝长上限的松手点不附着（丝是有射程的）', () => {
  const world = emptyWorld().world
  const far = addProp(world, { x: 20, mass: 4 }) // 20m > 12m 上限
  assert.equal(fire(rawHost(world), far.pos), false, '超出射程不该连得上')
})

test('**锚点锁在物体上**：物体被推走，锚点跟着它走（不再沿物体表面滑动）', () => {
  const world = emptyWorld().world
  const beam = world.addBody({
    name: 'beam',
    kind: 'static',
    tag: 'static',
    shape: aabb(5, 0.6),
    pos: { x: 6, y: 3 },
    anchorable: true,
  })
  const aim = { x: 2, y: 3 }
  fire(rawHost(world), aim)
  const offsetBefore = { ...world.ropes[0]!.anchorOffset }

  // 把横梁整体挪 1m：锚点的**局部偏移**必须不变（这就是"锁在物体上"）
  beam.pos = { x: 7, y: 3 }
  world.step(NO_INPUT)
  assert.deepEqual(world.ropes[0]!.anchorOffset, offsetBefore, '局部偏移不该随物体移动而变')
})

test('aimPreview：命中时报告落点，落空时 valid=false（瞄准时就看得见能不能连）', () => {
  const world = emptyWorld().world
  const rock = addProp(world, { x: 5, mass: 4 })
  const player = world.player

  const hit = world.aimPreview(player, { x: 5 + 2, y: 0 })
  assert.equal(hit.valid, false, '离表面 2m 应为落空')

  const on = world.aimPreview(player, rock.pos)
  assert.equal(on.valid, true)
  assert.equal(on.targetId, rock.id)
  assert.ok(Math.hypot(on.point.x - rock.pos.x, on.point.y - rock.pos.y) < 1e-9, '落点=松手点')
})

// ── 与场景的联动 ──────────────────────────────────────

test('序章：把丝射到**悬吊横梁的右端**，人就挂在右端（而不是被拉到梁心）', () => {
  const sc = new PrologueScene()
  sc.skipTo('dual')

  const beam = sc.swingBeam
  const aim = { x: beam.pos.x + C.SWING_BEAM_HALF_W, y: beam.pos.y }
  // 站在梁够得着的范围内
  sc.player.pos = { x: aim.x - 6, y: sc.player.pos.y }
  assert.equal(fire(sc, aim), true, '应该连得上悬吊横梁')

  const r = sc.world.ropes[0]!
  assert.equal(r.targetId, beam.id)
  assert.ok(
    Math.abs(beam.pos.x + r.anchorOffset.x - aim.x) < 1e-9,
    '锚点必须是松手的那一端，不该滑到中心',
  )
  assert.ok(Math.abs(r.anchorOffset.x - C.SWING_BEAM_HALF_W) < 1e-9)
})

test('序章：松手在空白处不会白白占掉丝位（新手会乱试，这不该有惩罚）', () => {
  const sc = new PrologueScene()
  assert.equal(fire(sc, { x: 20, y: 8 }), false, '空白处不该连上')
  assert.equal(sc.world.ropes[0]!.state, 'idle')
  assert.equal(sc.world.ropeDisplay()[0]!.state, 'idle', 'HUD 圆点应该还是"空闲"')
})

test('序章：丝也受射程限制（瞄得到不等于够得着）', () => {
  const sc = new PrologueScene()
  // 玩家在 x=4，吊桩在 x=28 —— 24m，远超 12m 上限
  assert.equal(fire(sc, { x: C.FAR_POST_CENTER_X, y: C.FAR_POST_CENTER_Y }), false)
})

test('圆形物体的锚点：瞄中心就挂中心，瞄边缘就挂边缘', () => {
  // 用 flatScene（有地面）：两次发射之间要等 1.5s 重凝，主角不能在这期间掉出世界
  const { world } = flatScene()
  const ball = world.addBody({
    name: 'ball',
    kind: 'static',
    tag: 'static',
    shape: circle(0.5),
    pos: { x: 5, y: 2 },
    anchorable: true,
  })
  const host = rawHost(world)

  assert.equal(fire(host, { x: 5, y: 2 }), true)
  assert.ok(Math.abs(world.ropes[0]!.anchorOffset.x) < 1e-9, '瞄中心 → 锚点在中心')
  world.step(input({ cutRope: 0 }))
  for (let i = 0; i < 100; i++) world.step(NO_INPUT)

  assert.equal(fire(host, { x: 5.5, y: 2 }), true)
  assert.ok(
    Math.abs(world.ropes[0]!.anchorOffset.x - 0.5) < 1e-9,
    '瞄右边缘 → 锚点在右边缘',
  )
  assert.equal(world.ropes[0]!.targetId, ball.id)
})

test('主角与场景的接触面：着地时丝射向重物，主角不动（着地 = 锚点没被改坏）', () => {
  const { world, player } = flatScene()
  const prop = addProp(world, { x: 5, mass: 4 })
  const x0 = player.pos.x
  fire(rawHost(world), prop.pos)
  for (let i = 0; i < 120; i++) world.step(input({ reel: 'in' }))
  assert.ok(
    Math.abs(player.pos.x - x0) < 0.5,
    `着地的主角不该被拉动，实际位移 ${(player.pos.x - x0).toFixed(2)}`,
  )
})
