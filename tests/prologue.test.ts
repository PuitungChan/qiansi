/**
 * 序章 · 批 1（设计 §7 的 0:00–3:00）回归。
 *
 * 覆盖：场景装配、三句提示的推进、陶罐必须被"扔"才碎、确定性。
 *
 * 对应：设计 §7（序章前 12 分钟实作样板）、D-043（分批交付）、D-044（可破坏场景物）
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import * as C from '../assets/scripts/core/constants'
import { MOTE_STOP_DISTANCE, ROPE_RECONGEAL_SEC } from '../assets/scripts/core/constants'
import { createHintState, hintStep, hintText } from '../assets/scripts/core/hints'
import { input } from '../assets/scripts/core/input'
import { PROLOGUE, PrologueScene } from '../assets/scripts/core/scene_prologue'
import { TEXTS, totalTextLength } from '../assets/scripts/core/texts'
import { NO_INPUT } from './helpers'

test('序章刚开局只包含设计 §7 那几样东西', () => {
  const sc = new PrologueScene()
  assert.deepEqual(
    sc.world.bodies.map((b) => b.name),
    ['ground', 'ceiling', 'wall-left', 'wall-right', 'player', 'stone', 'jar', 'mote', 'beam', 'pot'],
  )
  // 墨卒与轻陶罐在构造时就占好 id（**数组下标就是刚体 id，不能中途 push**），
  // 但开局都是 removed —— 它们各自在 3:00 / 5:00 才"给出"。
  assert.equal(sc.mote.removed, true, '开局墨卒不该在场')
  assert.equal(sc.pot.removed, true, '开局轻陶罐不该在场')
  // 梁柱是**结构**，一直在场上（它同时是后续摆荡的锚点）
  assert.equal(sc.beam.removed, false)
  assert.equal(sc.beam.kind, 'static')
  assert.equal(sc.currentStage, 'tutorial', '开局是教学阶段')
  assert.equal(sc.world.ropes.length, 1, '序章从 1 根丝开始（设计 §3.3）')
  assert.equal(sc.player.grounded, true)
})

test('批 3：梁柱的名义质量 60、轻陶罐 0.6（设计 §2.6 / §7）', () => {
  const sc = new PrologueScene()
  assert.equal(sc.beam.damageMass, 60, '梁柱名义质量 60（设计 §7 原文）')
  assert.equal(sc.beam.kind, 'static', '梁柱是"锚点与移动手段"（设计 §2.6），不是可甩物体')
  assert.equal(sc.beam.anchorable, true, '必须可附着，否则"连梁柱"无从谈起')
  assert.equal(sc.pot.damageMass, 0.6, '轻陶罐质量 0.6')
  assert.equal(sc.pot.anchorable, true, '轻陶罐必须可附着，才能做质量差对照')
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

// ══════════════════════════════════════════════════════════
//  批 2：3:00–5:00 第一个墨卒 ★
// ══════════════════════════════════════════════════════════

/** 把玩家推到"三件事都学会了"的状态。 */
function learnThreeVerbs(sc: PrologueScene): void {
  sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))
  sc.step(input({ reel: 'in' }))
  sc.step(input({ cutRope: 0 }))
}

test('批 2：三件事都学会后，墨卒从右侧入场（设计 §7 3:00）', () => {
  const sc = new PrologueScene()
  assert.equal(sc.mote.removed, true)
  learnThreeVerbs(sc)
  // 入场前留一拍
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)

  assert.equal(sc.currentStage, 'encounter')
  assert.equal(sc.mote.removed, false, '墨卒应已入场')
  assert.ok(sc.mote.pos.x > 20, `墨卒应从右侧入场，实际 x=${sc.mote.pos.x.toFixed(1)}`)
  assert.equal(sc.telemetry.encounterStarted, true)
})

test('批 2：3:00 之后**不再有任何文字提示**（设计 §7）', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.currentStage, 'encounter')
  assert.equal(sc.hint(), null, '遭遇战阶段必须零文字提示')
})

test('批 2：墨卒朝主角缓慢爬来，到跟前停下（不会挤到玩家身上）', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  const x0 = sc.mote.pos.x

  for (let i = 0; i < 60 * 20; i++) sc.step(NO_INPUT) // 20 秒
  assert.ok(sc.mote.pos.x < x0, `墨卒应向左靠近主角，实际 ${x0.toFixed(1)} → ${sc.mote.pos.x.toFixed(1)}`)
  const gap = Math.abs(sc.mote.pos.x - sc.player.pos.x)
  assert.ok(gap >= MOTE_STOP_DISTANCE - 0.6, `不该挤到玩家身上，实际间距 ${gap.toFixed(2)}m`)
})

test('批 2：60 秒没动作 → 石头开始发光，且**不弹文字**（设计 §7）', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.glowBodyId(), -1, '刚入场时不该发光')

  // 59 秒：还不该亮
  for (let i = 0; i < 60 * 59; i++) sc.step(NO_INPUT)
  assert.equal(sc.glowBodyId(), -1, '59 秒时不该发光')

  // 越过 60 秒
  for (let i = 0; i < 90; i++) sc.step(NO_INPUT)
  assert.equal(sc.glowBodyId(), sc.stone.id, '60 秒后石头应开始发光')
  assert.equal(sc.hint(), null, '发光是**不弹文字**的提示')
})

test('批 2：玩家动手（牵上丝线）之后，发光提示永久熄灭', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  for (let i = 0; i < 60 * 61; i++) sc.step(NO_INPUT)
  assert.equal(sc.glowBodyId(), sc.stone.id)

  // 玩家开始动手
  sc.step(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, attachPressed: true }))
  assert.equal(sc.glowBodyId(), -1, '玩家动手之后不该再提示他')
})

test('✅ AC-01：石块 20 m/s 一下砸死墨卒（附录 B「墨卒 HP 5，一下死」）', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.moteDead, false)

  // 把石块摆到墨卒面前高速撞过去（模拟一次成功的投石）
  sc.stone.pos = { x: sc.mote.pos.x - 3, y: 0.6 }
  sc.stone.vel = { x: 20, y: 0 }
  for (let i = 0; i < 60; i++) sc.step(NO_INPUT)

  assert.equal(sc.moteDead, true, '墨卒应一下死——它是教学工具，不是挑战')
  assert.equal(sc.telemetry.ac01Seconds() !== null, true, '埋点应记到这次击杀')
  assert.equal(sc.telemetry.ac01Passed(60), true, '且在 60 秒内')
})

test('埋点：AC-01 判定要求"用**石块**击杀"，别的凶器不算', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)

  // 用陶罐（0.6 质量）去撞——m_eff 太小 + 速度不够，既打不死也追不到账
  sc.jar.pos = { x: sc.mote.pos.x - 2, y: 0.4 }
  sc.jar.vel = { x: 20, y: 0 }
  for (let i = 0; i < 60; i++) sc.step(NO_INPUT)

  const kills = sc.telemetry.snapshot().filter((e) => e.kind === 'kill')
  for (const k of kills) {
    assert.notEqual(k.by, 'jar', '陶罐不该被记成凶器')
  }
})

test('埋点：时间戳由 tick 换算，不含 wall-clock（确定性）', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 120; i++) sc.step(NO_INPUT)

  const evts = sc.telemetry.snapshot()
  assert.ok(evts.length > 0)
  assert.equal(evts[0]!.kind, 'run_start')

  // `t` 是**相对试玩开始**的秒数（分析时最有用："他在第几秒砸死的"），
  // 而 `tick` 是绝对 tick。两者必须严格自洽、且完全由 tick 推出。
  const t0 = evts[0]!.tick
  for (const e of evts) {
    assert.ok(Number.isFinite(e.t), 't 必须是有限数')
    assert.ok(
      Math.abs(e.t - (e.tick - t0) / 60) < 1e-9,
      `t 必须严格等于 (tick - 起点)/60：${e.t} vs ${(e.tick - t0) / 60}`,
    )
  }
  // 事件顺序必须单调不减
  for (let i = 1; i < evts.length; i++) {
    assert.ok(evts[i]!.tick >= evts[i - 1]!.tick, '事件必须按 tick 单调')
  }
})

test('埋点：两次相同回放产出完全相同的 JSONL（可复现）', () => {
  const play = (): string => {
    const sc = new PrologueScene()
    learnThreeVerbs(sc)
    for (let i = 0; i < 200; i++) {
      sc.step(input({ moveX: Math.floor(i / 40) % 2 === 0 ? 1 : -1 }))
    }
    sc.stone.pos = { x: sc.mote.pos.x - 3, y: 0.6 }
    sc.stone.vel = { x: 20, y: 0 }
    for (let i = 0; i < 60; i++) sc.step(NO_INPUT)
    return sc.telemetry.toJSONL()
  }
  const a = play()
  assert.equal(a, play())
  assert.ok(a.includes('"kind":"kill"'))
})

test('埋点：CSV 导出有稳定表头，行数 = 事件数', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 120; i++) sc.step(NO_INPUT)
  const lines = sc.telemetry.toCSV().split('\n')
  assert.equal(lines.length, sc.telemetry.length + 1, 'CSV 行数 = 表头 + 事件数')
  assert.ok(lines[0]!.startsWith('t,tick,kind'))
})

test('批 2 reset：墨卒回到"未入场"，埋点清空', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.mote.removed, false)
  assert.ok(sc.telemetry.length > 0)

  sc.reset()
  assert.equal(sc.mote.removed, true)
  assert.equal(sc.currentStage, 'tutorial')
  assert.equal(sc.telemetry.length, 0)
  assert.equal(sc.telemetry.encounterStarted, false)
})

// ══════════════════════════════════════════════════════════
//  批 3：5:00–8:00 质量差（重梁柱 vs 轻陶罐）
// ══════════════════════════════════════════════════════════

/** 进入遭遇战。 */
function toEncounter(sc: PrologueScene): void {
  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.currentStage, 'encounter')
}

/** 用石块砸死墨卒（模拟一次成功的投石）。 */
function killMote(sc: PrologueScene): void {
  sc.stone.pos = { x: sc.mote.pos.x - 3, y: 0.6 }
  sc.stone.vel = { x: 20, y: 0 }
  for (let i = 0; i < 80; i++) sc.step(NO_INPUT)
  assert.equal(sc.moteDead, true)
}

test('批 3：墨卒被击杀后，进入质量差段并给出轻陶罐（设计 §7 5:00）', () => {
  const sc = new PrologueScene()
  toEncounter(sc)
  assert.equal(sc.pot.removed, true, '质量差段之前不该有轻陶罐')

  killMote(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)

  assert.equal(sc.currentStage, 'massdiff')
  assert.equal(sc.pot.removed, false, '轻陶罐应已给出')
  assert.ok(sc.telemetry.stageStartSec('massdiff') !== null, '埋点应记下段落切换')
})

test('批 3：质量差段**也是零文字提示**（设计 §7「这一幕不需要任何文字」）', () => {
  const sc = new PrologueScene()
  toEncounter(sc)
  killMote(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.currentStage, 'massdiff')
  assert.equal(sc.hint(), null)
  assert.equal(sc.glowBodyId(), -1, '这段也没有发光提示——物理自己会说话')
})

test('批 3：**连梁柱 → 收丝 → 自己被拉了过去**（设计 §7 原文）', () => {
  const sc = new PrologueScene()
  toEncounter(sc)
  killMote(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)

  // 走到够得着横梁的位置（梁横在 x=10..26、y≈13）
  for (let i = 0; i < 90; i++) sc.step(input({ moveX: 1 }))
  const x0 = sc.player.pos.x
  const y0 = sc.player.pos.y

  // 瞄准梁的**边缘**（不是中心）也应该连得上——大物体必须按表面算
  sc.step(
    input({
      aimPoint: { x: C.BEAM_CENTER_X - C.BEAM_HALF_W, y: C.BEAM_CENTER_Y - C.BEAM_HALF_H },
      attachPressed: true,
    }),
  )
  assert.equal(sc.world.ropes[0]!.state, 'attached', '瞄准梁的边缘就该连得上')
  assert.equal(sc.world.ropes[0]!.targetId, sc.beam.id)

  let airborne = false
  for (let i = 0; i < 180; i++) {
    sc.step(input({ reel: 'in' }))
    if (!sc.player.grounded) airborne = true
  }

  assert.ok(airborne, '连梁柱收丝应该把主角**拽离地面**（"重的东西用来移动"）')
  assert.ok(
    sc.player.pos.y > y0 + 1,
    `主角应被明显拉上去：y ${y0.toFixed(1)} → ${sc.player.pos.y.toFixed(1)}`,
  )
  assert.ok(sc.player.pos.x >= x0 - 0.5, '不应被拉向反方向')
})

test('批 3：**连轻陶罐 → 收丝 → 它被拉了过来**（与梁柱形成对照）', () => {
  const sc = new PrologueScene()
  toEncounter(sc)
  killMote(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)

  const px0 = sc.player.pos.x
  const qx0 = sc.pot.pos.x
  const gap0 = Math.abs(qx0 - px0)

  sc.step(input({ aimPoint: { x: sc.pot.pos.x, y: sc.pot.pos.y }, attachPressed: true }))
  assert.equal(sc.world.ropes[0]!.targetId, sc.pot.id, '应该连上的是轻陶罐')

  for (let i = 0; i < 90; i++) sc.step(input({ reel: 'in' }))

  const gap1 = Math.abs(sc.pot.pos.x - sc.player.pos.x)
  assert.ok(gap1 < gap0 - 1, `陶罐应被拉过来：间距 ${gap0.toFixed(1)} → ${gap1.toFixed(1)}`)
  assert.ok(
    Math.abs(sc.player.pos.x - px0) < 0.5,
    `着地的主角基本不该动，实际位移 ${(sc.player.pos.x - px0).toFixed(2)}`,
  )
})

test('批 3：两分钟没打死墨卒也会推进（不卡死），且不影响 AC-01 判定', () => {
  const sc = new PrologueScene()
  toEncounter(sc)
  // 什么都不做，等过设计给的两分钟上限
  for (let i = 0; i < 60 * (C.ENCOUNTER_MAX_SEC + 3); i++) sc.step(NO_INPUT)

  assert.equal(sc.currentStage, 'massdiff', '到点必须推进，否则失败者永远看不到后面的内容')
  assert.equal(sc.telemetry.ac01Seconds(), null, '没击杀就是没击杀')
  assert.equal(sc.telemetry.ac01Passed(60), false)
})
