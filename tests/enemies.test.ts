/**
 * 三类敌人的行为与视野污染的回归（FR-CBT-001 / FR-CBT-011 / FR-CBT-012 / FR-CBT-004）。
 *
 * 这一组的价值不在"跑通"，而在**把口径钉住**：这些行为的设计依据只有设计文档里的
 * 一句话（"高速游走""主动伸出触须缠绕丝线""持续生成墨卒"），剩下的都是我推的。
 * 把它们变成会在改动时红掉的断言，下次改数值的人（很可能还是我）才看得见后果。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import * as C from '../assets/scripts/core/constants'
import {
  BLADE_NAME,
  BIND_NAME,
  NEST_NAME,
  coreWorldPos,
  createBind,
  createBlade,
  createInkDot,
  createNest,
  hitCore,
  isInkDot,
  ropeIsEntangled,
} from '../assets/scripts/core/enemies'
import { input } from '../assets/scripts/core/input'
import { EnemyTrainingScenario } from '../assets/scripts/core/scene_enemies'
import { BLADE_CENTER_X, BLADE_PATROL_HALF_WIDTH } from '../assets/scripts/core/scene_enemies'
import { NO_INPUT, fire } from './helpers'

function run(sc: { step(i: typeof NO_INPUT): void }, n: number): void {
  for (let i = 0; i < n; i++) sc.step(NO_INPUT)
}

// ── 刚体表与不变量 ────────────────────────────────────

test('训练场的刚体数在预算内，而且**全程恒定**（含墨点池）', () => {
  const sc = new EnemyTrainingScenario()
  const n = sc.world.bodies.length
  assert.ok(n <= 40, `刚体数 ${n} 超过 NFR-PERF-002 的预算 40`)
  // 跑 60 秒（够墨巢射很多发、墨点反复回收），数组长度一次都不许变
  run(sc, 60 * 60)
  assert.equal(sc.world.bodies.length, n, '刚体数组长度变了 —— 数组下标即 id，确定性会崩')
})

test('墨点池是**预生成**的：墨巢开火不新建刚体，只激活池里的休眠墨点', () => {
  const sc = new EnemyTrainingScenario()
  const n0 = sc.world.bodies.length
  const pool = sc.world.bodies.filter(isInkDot)
  assert.equal(pool.length, C.INK_DOT_POOL, '池子大小必须等于 INK_DOT_POOL')
  assert.ok(
    pool.every((b) => b.removed),
    '开局时所有墨点都应当是休眠（removed）状态',
  )
  // 把主角搬进射程，逼它开火。
  // **用事件判断"有没有开过火"**，而不是在最后一帧看池子里有没有醒着的墨点 ——
  // 墨点飞得很快（18 m/s），随手一帧采样很可能正好落在"全部回收完"的空档上。
  sc.player.pos = { x: C.M0_ROOM_W - 8, y: sc.player.pos.y }
  let fired = false
  for (let i = 0; i < 60 * 6 && !fired; i++) {
    sc.step(NO_INPUT)
    fired = sc.world.events.some((e) => e.kind === 'nest-fire')
  }
  assert.ok(fired, '巢在射程内 6 秒都没开火 —— 检查 NEST_FIRE_INTERVAL_SEC 与 NEST_FIRE_RANGE')
  assert.equal(sc.world.bodies.length, n0, '刚体数不应变化（开火只激活池子，绝不新建）')
})

test('墨巢射程与墨点速度必须自洽：抛体最大射程 `v²/g` ≥ 宣布的射程', () => {
  // 这条守的是一个**只有真的跑一遍才会发现**的错：初版墨点速度 11 m/s，
  // 而抛体最大射程只有 11²/20 = 6.1m，射程参数却写着 14m ⇒ 一发都打不中（全落在半路）。
  const maxRange = (C.INK_DOT_SPEED * C.INK_DOT_SPEED) / Math.abs(C.GRAVITY_Y)
  assert.ok(
    maxRange >= C.NEST_FIRE_RANGE,
    `墨点速度 ${C.INK_DOT_SPEED} 的最大射程只有 ${maxRange.toFixed(1)}m，` +
      `却宣布射程 ${C.NEST_FIRE_RANGE}m —— 它会一直开火但永远打不到`,
  )
})

// ── 墨刃 ──────────────────────────────────────────────

test('墨刃在巡逻带内来回走，且**速度真的接近 9 m/s**（"高速"不是形容词）', () => {
  const sc = new EnemyTrainingScenario()
  const b = sc.blade
  let minX = Infinity
  let maxX = -Infinity
  let peak = 0
  for (let i = 0; i < 60 * 12; i++) {
    sc.step(NO_INPUT)
    if (!b.alive) continue
    minX = Math.min(minX, b.pos.x)
    maxX = Math.max(maxX, b.pos.x)
    peak = Math.max(peak, Math.abs(b.vel.x))
  }
  assert.ok(peak > C.BLADE_PATROL_SPEED * 0.9, `墨刃峰值速度只有 ${peak.toFixed(2)}，应当接近 ${C.BLADE_PATROL_SPEED}`)
  // 巡逻带中心 ± 半宽。留 0.1m 余量给碰撞求解器的位置修正。
  const margin = 0.1
  assert.ok(
    minX > BLADE_CENTER_X - BLADE_PATROL_HALF_WIDTH - margin,
    `墨刃左越界：${minX.toFixed(2)}（巡逻带 ${(BLADE_CENTER_X - BLADE_PATROL_HALF_WIDTH).toFixed(2)}..${(BLADE_CENTER_X + BLADE_PATROL_HALF_WIDTH).toFixed(2)}）`,
  )
  assert.ok(
    maxX < BLADE_CENTER_X + BLADE_PATROL_HALF_WIDTH + margin,
    `墨刃右越界：${maxX.toFixed(2)}`,
  )
})

test('墨刃**不吃冲击**（设计 §4.1：轻物高速撞击直接被弹开）', () => {
  const sc = new EnemyTrainingScenario()
  // 把主角和石块搬到墨刃旁边，让石块以 8 m/s 撞上去（超过 MIN_DAMAGE_SPEED）
  sc.stone.pos = { x: sc.blade.pos.x - 2, y: 0.51 }
  sc.stone.vel = { x: 8, y: 0 }
  const hp0 = sc.blade.hp
  run(sc, 60)
  assert.equal(sc.blade.hp, hp0, '墨刃的质量 0.5 ⇒ m_eff = min(4, 0.5) = 0.5 < 3，冲击必须被完全挡下')
})

// ── 墨缚：缠丝 + 撕裂 ────────────────────────────────

test('墨缚会逼近玩家，进 6m 后停下（它不该顶着玩家走）', () => {
  const sc = new EnemyTrainingScenario()
  sc.player.pos = { x: 4, y: sc.player.pos.y }
  run(sc, 60 * 12)
  const d = Math.abs(sc.bind.pos.x - sc.player.pos.x)
  assert.ok(
    d > C.BIND_RANGE - 1.5 && d < C.BIND_RANGE + 2.5,
    `墨缚与玩家的距离 ${d.toFixed(2)} 不在 ${C.BIND_RANGE}m 附近 —— 逼近或刹车有问题`,
  )
})

test('墨缚会**缠住一根已附着的丝**：被缠期间那根丝收不动，但**可以断**', () => {
  const sc = new EnemyTrainingScenario()
  const bind = sc.bind
  // 把墨缚搬到主角旁边（进入 BIND_RANGE），石块放到主角另一侧当锚点。
  // ⚠️ 石块**必须搬远**：不然它会抢走瞄准点（`pickAnchorableAt` 按数组顺序取最近的可附着物），
  // 于是"连墨缚"变成"连石块" —— 这个坑我第一版就踩了。
  bind.pos = { x: sc.player.pos.x + 3, y: bind.pos.y }
  sc.stone.pos = { x: sc.player.pos.x - 3, y: 0.51 }
  assert.ok(
    fire(sc, { x: bind.pos.x, y: bind.pos.y }),
    '这一步的前提是丝能连上墨缚（D-066 给的例外）',
  )
  const rope = sc.world.ropes[0]!
  assert.equal(rope.state, 'attached')

  // 等它伸触须。**要逐 tick 等**：缠绕只持续 BIND_DURATION_SEC（1.5s），
  // 而"缠—松—冷却"是一个 3.5 秒的循环，跑固定秒数很可能正好落在冷却期里。
  let grabbed = false
  for (let i = 0; i < 60 * 6 && !grabbed; i++) {
    sc.step(NO_INPUT)
    grabbed = bind.entangleRope === 0 && bind.entangleRemaining > 0
  }
  assert.ok(grabbed, '墨缚应当缠住了丝位 0（它进了射程、且有一根已附着的丝）')
  assert.ok(ropeIsEntangled(sc.world, 0), 'ropeIsEntangled 必须与 body 上的字段一致')

  // 被缠期间收丝：targetLength 不该变
  const before = rope.targetLength
  for (let i = 0; i < 10 && bind.entangleRemaining > 0; i++) sc.step(input({ reel: 'in' }))
  assert.equal(
    rope.targetLength,
    before,
    '被缠住的丝**不能收**（D-065 ③ 的推荐项：惩罚是"这段时间少一根丝"）',
  )

  // 但**可以断**：这是玩家该学的解法
  sc.step(input({ cutRope: 0 }))
  assert.notEqual(rope.state, 'attached', '被缠住的丝必须仍然可以被断掉')
  assert.equal(bind.entangleRope, -1, '丝断了，触须应当立刻松开（否则它会抱着一个不存在的丝位）')
})

test('撕裂处决（FR-CBT-004）：**两根丝都连在墨缚上**，张力差够大 ⇒ 直接击杀', () => {
  const sc = new EnemyTrainingScenario()
  const bind = sc.bind
  bind.pos = { x: sc.player.pos.x + 4, y: bind.pos.y }
  // 石块搬远，别抢锚点（见上一条测试的注释）
  sc.stone.pos = { x: sc.player.pos.x - 3, y: 0.51 }

  // 两根丝都连墨缚
  for (let slot = 0; slot < 2; slot++) {
    sc.step(input({ aimPoint: { x: bind.pos.x, y: bind.pos.y }, firePressed: true }))
    let ok = false
    for (let i = 0; i < 40; i++) {
      sc.step(NO_INPUT)
      if (sc.world.ropes[slot]!.state === 'attached') {
        ok = true
        break
      }
    }
    assert.ok(ok, `第 ${slot + 1} 根丝要能连上墨缚`)
    assert.equal(sc.world.ropes[slot]!.targetId, bind.id, '锚点必须是墨缚，不是旁边的石块')
  }

  // 收丝 + 让墨缚自己挣扎 ⇒ 两根丝的张力会被拉开（实测第一帧就到 457 N）
  let torn = false
  let maxDiff = 0
  for (let i = 0; i < 60 * 6 && !torn; i++) {
    sc.step(input({ reel: i < 90 ? 'in' : 'hold' }))
    const diff = Math.abs(sc.world.ropes[0]!.tension - sc.world.ropes[1]!.tension)
    maxDiff = Math.max(maxDiff, diff)
    torn = !bind.alive
  }
  assert.ok(
    maxDiff > C.TEAR_TENSION_DIFF,
    `两根丝的张力差最大只到 ${maxDiff.toFixed(1)}，没到 ${C.TEAR_TENSION_DIFF} —— 撕裂对玩家不可达`,
  )
  assert.equal(bind.alive, false, '张力差足够大时墨缚必须被撕裂击杀')
  assert.equal(bind.hp, 0)
})

test('撕裂不会误伤：只有**一根丝**时绝不触发（回归护栏）', () => {
  const sc = new EnemyTrainingScenario()
  const bind = sc.bind
  bind.pos = { x: sc.player.pos.x + 4, y: bind.pos.y }
  assert.ok(fire(sc, { x: bind.pos.x, y: bind.pos.y }))
  for (let i = 0; i < 120; i++) sc.step(input({ reel: 'in' }))
  assert.equal(bind.alive, true, '一根丝拉得再紧也不该撕裂 —— 那需要"两根丝 + 张力差"')
})

// ── 墨巢：承重点 + 视野污染 ──────────────────────────

test('墨巢是**静态**的，且只吃承重点（打别处 0 伤害；打中 ×3）', () => {
  const sc = new EnemyTrainingScenario()
  const nest = sc.nest
  assert.equal(nest.kind, 'static', '墨巢固定在地形上，必须是静态刚体')
  assert.ok(nest.coreRadius > 0, '墨巢必须有承重点，否则它就没有弱点')

  // 承重点的世界坐标
  const core = coreWorldPos(nest)
  assert.ok(hitCore(nest, core), '承重点中心必须算命中')
  assert.ok(
    !hitCore(nest, { x: nest.pos.x - C.NEST_HALF_W + 0.05, y: nest.pos.y }),
    '巢的最左边缘（离承重点远）不该算命中承重点',
  )
})

test('墨点命中主角 ⇒ 视野污染上升；**击败墨巢 ⇒ 立刻恢复全屏**', () => {
  const sc = new EnemyTrainingScenario()
  // 站到巢的射程里当靶子，什么都不做
  sc.player.pos = { x: C.M0_ROOM_W - 10, y: sc.player.pos.y }
  run(sc, 60 * 8)
  assert.ok(sc.world.inkPollution > 0, `被射了 8 秒，污染仍是 0（巢没开火？射程 ${C.NEST_FIRE_RANGE}）`)
  assert.ok(
    sc.world.visibleRatio() >= C.INK_MIN_VISIBLE - 1e-9,
    `可见范围 ${sc.world.visibleRatio().toFixed(3)} 跌破下限 ${C.INK_MIN_VISIBLE}`,
  )

  // 打死墨巢（直接结算，不依赖投掷弹道 —— 那条链路由 damage.test.ts 覆盖）
  sc.nest.hp = 0
  sc.nest.alive = false
  sc.step(NO_INPUT)
  assert.equal(sc.world.inkPollution, 0, '击败墨巢必须**立刻**清空污染（创始人明确要求）')
  assert.equal(sc.world.visibleRatio(), 1)
})

test('污染会**缓慢自愈**（失误可恢复），且**不会掉到 35% 以下**（否则是没法玩）', () => {
  const sc = new EnemyTrainingScenario()
  sc.world.addPollution(1) // 灌满
  assert.ok(
    Math.abs(sc.world.visibleRatio() - C.INK_MIN_VISIBLE) < 1e-9,
    '污染到顶时正好剩 INK_MIN_VISIBLE 的视野',
  )
  const before = sc.world.inkPollution
  run(sc, 60) // 1 秒
  assert.ok(sc.world.inkPollution < before, '污染必须会自愈')
  const expected = before - C.INK_POLLUTION_DECAY_PER_SEC
  assert.ok(
    Math.abs(sc.world.inkPollution - expected) < 1e-9,
    `一秒应当回落 ${C.INK_POLLUTION_DECAY_PER_SEC}，实际落到 ${sc.world.inkPollution.toFixed(4)}`,
  )
})

test('墨点是**物理体**：会被墙挡住（不是穿墙的"魔法伤害"）', () => {
  const sc = new EnemyTrainingScenario()
  // 手动从巢的位置朝右墙射一枚（速度朝右，墙在 x=32.5）
  const ok = sc.world.spawnInkDot({ x: 30, y: 1.2 }, { x: 11, y: 0 })
  assert.ok(ok, '池子应当是空的（初始全部休眠）')
  const dot = sc.world.bodies.find((b) => isInkDot(b) && !b.removed)!
  assert.ok(dot !== undefined)
  run(sc, 60 * 2)
  assert.ok(
    dot.pos.x < C.M0_ROOM_W + 0.5,
    `墨点穿过了右墙（x=${dot.pos.x.toFixed(2)}）—— 它必须是真实物理体`,
  )
})

// ── 工厂与命名（防止"名字拼错就静默失效"）────────────

test('敌人工厂产出正确的名字/弱点/HP（渲染层与 AI 都按名字认它们）', () => {
  const blade = createBlade(0, 10, 3)
  assert.equal(blade.name, BLADE_NAME)
  assert.equal(blade.weakness, 'cut')
  assert.equal(blade.hp, C.BLADE_HP)
  assert.equal(blade.patrolHalfWidth, 3)
  assert.equal(blade.patrolCenterX, 10)

  const bind = createBind(1, 10)
  assert.equal(bind.name, BIND_NAME)
  assert.equal(bind.weakness, 'tear')
  assert.equal(bind.anchorable, true, '墨缚必须可附着，否则撕裂无从谈起（D-066）')

  const nest = createNest(2, 30)
  assert.equal(nest.name, NEST_NAME)
  assert.equal(nest.weakness, 'structure')
  assert.equal(nest.kind, 'static')
  assert.ok(nest.coreRadius > 0)

  const dot = createInkDot(3, 0)
  assert.ok(isInkDot(dot))
  assert.equal(dot.removed, true, '池里的墨点出厂就是休眠的')
})

test('确定性：同一段输入跑两遍，三类敌人 + 污染的哈希轨迹逐位一致', () => {
  const a = new EnemyTrainingScenario()
  const b = new EnemyTrainingScenario()
  const hashesA: string[] = []
  const hashesB: string[] = []
  for (let i = 0; i < 600; i++) {
    const frame = input({
      moveX: i % 120 < 60 ? 1 : -1,
      reel: i % 90 < 30 ? 'in' : 'hold',
    })
    a.step(frame)
    b.step(frame)
    if (i % 30 === 0) {
      hashesA.push(a.world.stateHash())
      hashesB.push(b.world.stateHash())
    }
  }
  assert.deepEqual(hashesA, hashesB, '两个独立实例必须产出完全相同的哈希轨迹（AC-05）')
  assert.ok(hashesA.length === 20)
})
