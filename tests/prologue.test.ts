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
import { NO_INPUT, fire } from './helpers'

test('序章刚开局只包含设计 §7 那几样东西', () => {
  const sc = new PrologueScene()
  assert.deepEqual(
    sc.world.bodies.map((b) => b.name),
    [
      'ground-left',
      'ground-right',
      'pit-floor',
      'ceiling',
      'wall-left',
      'wall-right',
      'player',
      'stone',
      'jar',
      'mote',
      'beam',
      'pot',
      'swing-beam',
      'far-post',
      'mote2',
    ],
  )
  // 分阶段出场的物体都在构造时占好 id（**数组下标就是刚体 id，不能中途 push**），
  // 各自到自己那一段才 `removed = false`。
  assert.equal(sc.mote.removed, true, '3:00 才入场')
  assert.equal(sc.pot.removed, true, '5:00 才给出')
  assert.equal(sc.mote2.removed, true, '8:00 才入场')
  // 结构类的（梁柱、悬吊横梁、对岸吊桩）一直在场上
  assert.equal(sc.beam.removed, false)
  assert.equal(sc.swingBeam.removed, false)
  assert.equal(sc.farPost.removed, false)
  assert.equal(sc.currentStage, 'tutorial', '开局是教学阶段')
  assert.equal(sc.player.grounded, true)
})

test('序章开局只解锁 1 根丝，但预建了 2 个丝位（FR-PRG-006 的 1→2）', () => {
  const sc = new PrologueScene()
  assert.equal(sc.world.ropes.length, 2, '预建 2 个丝位')
  assert.equal(sc.world.unlockedRopes, 1, '开局只解锁 1 根（设计 §3.3：序章 1 根）')
  assert.equal(sc.world.ropeDisplay().length, 1, 'HUD 只显示已解锁的')
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
  // 靶子**不可附着**：创始人先前提"附着不上陶罐"，我改成可附着，
  // 随后他明确要求「就按你原来的方案设计成不可吸附吧」⇒ 改回来。
  // 它是靶子，不是锚点。见 D-058 的修订。
  assert.equal(sc.jar.anchorable, false, '靶子不可附着')
  // **易碎**：撞到就碎。没有这一条它要 v ≥ 15 才会碎，而玩家朝目标方向的
  // 正常甩投是 15~16 m/s ⇒ 第一课"砸碎罐子"时灵时不灵（创始人原话「砸不碎陶罐」）。
  assert.equal(sc.jar.fragile, true, '靶子必须易碎（见 Body.fragile）')
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

test('提示推进由真实操作驱动（连上 → 收丝 → 断丝 → 去砸陶罐）', () => {
  const sc = new PrologueScene()
  assert.equal(sc.hint(), TEXTS.hintAttach)

  // 牵上石块
  fire(sc, sc.stone.pos)
  assert.equal(sc.hint(), TEXTS.hintReel)

  // 收丝
  sc.step(input({ reel: 'in' }))
  assert.equal(sc.hint(), TEXTS.hintCut)

  // 断丝：三件事学完，但**提示不会消失**
  // ⚠️ 第 14 轮：设计 §7 原来要求"三件都学会之后什么都不显示"，
  // 创始人试玩后推翻了它（「我完全不知道我该干什么」）。现在会接着说下一步。
  sc.step(input({ cutRope: 0 }))
  assert.equal(sc.hint(), TEXTS.stepBreakJar, '三件事学完就该告诉玩家下一步：去砸陶罐')
})

test('引导：目标行随段落变化，物体说明按段出现（第 14 轮创始人要求）', () => {
  const sc = new PrologueScene()
  assert.equal(sc.guidance().goal, TEXTS.goalTutorial)
  assert.ok(
    sc.guidance().notes.some((n) => n.includes('石头')),
    '开局就该说清石头是干什么的',
  )

  sc.skipTo('dual')
  assert.equal(sc.guidance().goal, TEXTS.goalDual, '到了深沟段，目标要变成"过沟"')
  const notes = sc.guidance().notes.join(' ')
  assert.ok(notes.includes('深沟') && notes.includes('悬吊横梁') && notes.includes('吊桩'),
    `过沟段的物体说明要覆盖三样关键东西，实际：${notes}`)
  assert.equal(sc.guidance().step, TEXTS.stepDual)
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
  fire(sc, sc.stone.pos)
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
    fire(sc, sc.stone.pos)
    for (let i = 0; i < 120; i++) {
      sc.step(input({ moveX: Math.floor(i / 30) % 2 === 0 ? 1 : -1, reel: 'in' }))
    }
    sc.step(input({ cutRope: 0 }))
    for (let i = 0; i < 120; i++) sc.step(NO_INPUT)
    return sc.world.stateHash()
  }
  assert.equal(play(), play())
})

test('NFR-I18N-003：玩家可见文案全部走资源表（字数预算已被创始人放宽）', () => {
  assert.ok(totalTextLength() > 0)
  // ⚠️ 第 14 轮：创始人明确要求序章"加上文字提示：介绍当前场景的物体的作用、
  // 现在这一步该干什么、这个游戏要干什么才能通过这一关"。
  // 设计 §8.4 的 ≤ 500 字预算因此被**他自己**放宽（见 texts.ts 文件头）。
  // 这里不再断言"≤ 500"，改为断言"有一个上限、并且超了就看得见"：
  assert.ok(
    totalTextLength() <= 900,
    `全游戏文本 ${totalTextLength()} 字 —— 已经被放宽到 900，超过就说明又加了一堆话，该复查`,
  )
  // 三句提示仍然在表里（文字改成了"按哪里"的完整说法，键名没变）
  assert.ok(TEXTS.hintAttach.length > 0)
  assert.ok(TEXTS.hintReel.length > 0)
  assert.ok(TEXTS.hintCut.length > 0)
})

test('断丝重凝在序章同样生效（AC-21 不因换场景而失效）', () => {
  const sc = new PrologueScene()
  fire(sc, sc.stone.pos)
  sc.step(input({ cutRope: 0 }))
  assert.equal(sc.world.ropes[0]!.state, 'recovering')
  assert.ok(Math.abs(sc.world.ropes[0]!.recongealRemaining - ROPE_RECONGEAL_SEC) < 1e-6)
})

// ══════════════════════════════════════════════════════════
//  批 2：3:00–5:00 第一个墨卒 ★
// ══════════════════════════════════════════════════════════

/** 把玩家推到"三件事都学会了"的状态。 */
function learnThreeVerbs(sc: PrologueScene): void {
  fire(sc, sc.stone.pos)
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
  // 深沟（批 4）把左平台切到 x=15 为止，所以"从右侧"现在是"从主角右边、
  // 平台之内"，不再是 M0 那个 x=30。它必须落在**陶罐内侧**，否则弹道被陶罐挡掉。
  assert.ok(sc.mote.pos.x > sc.player.pos.x, `墨卒应从主角右侧入场，实际 x=${sc.mote.pos.x.toFixed(1)}`)
  assert.ok(sc.mote.pos.x < C.CHASM_LEFT_X, '而且必须站在左平台上，否则它会自己走进沟里')
  assert.ok(sc.mote.pos.x < sc.jar.pos.x, '而且要在陶罐内侧，否则石块先打到陶罐')
  assert.equal(sc.telemetry.encounterStarted, true)
})

test('批 2（第 14 轮改）：遭遇战**先给方向、攒够时间再给解法**', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.currentStage, 'encounter')
  // ⚠️ 设计 §7 原来要求"3:00 之后零文字提示"（为了测"玩家会不会自己想到"）。
  // 创始人试玩后推翻了它（「我完全不知道我该干什么」），但仍然要求保留"先自己想"的空间，
  // 所以做成两级：先方向、`ENCOUNTER_EXPLICIT_HINT_SEC` 秒后再点破。
  assert.equal(sc.hint(), TEXTS.stepEncounterVague, '刚入场只给方向，不直接给答案')

  for (let i = 0; i < 60 * (C.ENCOUNTER_EXPLICIT_HINT_SEC + 1); i++) sc.step(NO_INPUT)
  assert.equal(sc.hint(), TEXTS.stepEncounterExplicit, '攒够时间就把完整解法说出来')
  assert.equal(sc.mote.alive, true, '（这一段测试里玩家什么都没做，墨卒当然还活着）')
})

test('埋点：每句引导第一次出现的时刻都被记下来（AC-01 的"无提示"版本靠它）', () => {
  const sc = new PrologueScene()
  sc.step(NO_INPUT)
  assert.ok(sc.telemetry.firstHintSec('hintAttach') !== null, '开局那句要被记下')

  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.telemetry.firstHintSec('stepEncounterExplicit'), null, '还没到点破的时候')

  for (let i = 0; i < 60 * (C.ENCOUNTER_EXPLICIT_HINT_SEC + 1); i++) sc.step(NO_INPUT)
  const taught = sc.telemetry.firstHintSec('stepEncounterExplicit')
  assert.ok(taught !== null && taught >= C.ENCOUNTER_EXPLICIT_HINT_SEC, `点破时刻应 ≥ ${C.ENCOUNTER_EXPLICIT_HINT_SEC} 秒，实际 ${taught}`)
  assert.equal(sc.telemetry.ac01UnaidedSeconds(), null, '没击杀 ⇒ 无提示版本也未达成')
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

test('批 2：60 秒没动作 → 石头**仍然**会发光（发光机制没被文字取代）', () => {
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
})

test('批 2：玩家动手（牵上丝线）之后，发光提示永久熄灭', () => {
  const sc = new PrologueScene()
  learnThreeVerbs(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  for (let i = 0; i < 60 * 61; i++) sc.step(NO_INPUT)
  assert.equal(sc.glowBodyId(), sc.stone.id)

  // 玩家开始动手
  fire(sc, sc.stone.pos)
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

test('批 3（第 14 轮改）：质量差段**有话说**了 —— 明确告诉玩家"重的那根把你拉过去"', () => {
  const sc = new PrologueScene()
  toEncounter(sc)
  killMote(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.currentStage, 'massdiff')
  assert.equal(sc.hint(), TEXTS.stepMassDiff)
  assert.equal(sc.glowBodyId(), -1, '这段不需要发光提示——文字已经说清了')
  const notes = sc.guidance().notes.join(' ')
  assert.ok(notes.includes('梁柱') && notes.includes('轻陶罐'), `物体说明要覆盖两个对照物，实际：${notes}`)
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

  // 瞄准梁的**某个点**（不是梁心）就应该挂在那一点上——第 13 轮的新规则
  const aim = { x: sc.player.pos.x, y: C.BEAM_CENTER_Y - C.BEAM_HALF_H }
  fire(sc, aim)
  assert.equal(sc.world.ropes[0]!.state, 'attached', '瞄梁上任意一点就该连得上')
  assert.equal(sc.world.ropes[0]!.targetId, sc.beam.id)
  assert.ok(
    Math.abs(sc.world.ropes[0]!.anchorOffset.x + sc.beam.pos.x - aim.x) < 1e-9 &&
      Math.abs(sc.world.ropes[0]!.anchorOffset.y + sc.beam.pos.y - aim.y) < 1e-9,
    '附着点必须**就是松手的那一点**，不该被吸到物体中心',
  )

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

  fire(sc, sc.pot.pos)
  assert.equal(sc.world.ropes[0]!.targetId, sc.pot.id, '应该连上的是轻陶罐')

  for (let i = 0; i < 90; i++) sc.step(input({ reel: 'in' }))

  const gap1 = Math.abs(sc.pot.pos.x - sc.player.pos.x)
  assert.ok(gap1 < gap0 - 1, `陶罐应被拉过来：间距 ${gap0.toFixed(1)} → ${gap1.toFixed(1)}`)
  assert.ok(
    Math.abs(sc.player.pos.x - px0) < 0.5,
    `着地的主角基本不该动，实际位移 ${(sc.player.pos.x - px0).toFixed(2)}`,
  )
})

test('批 3（第 13 轮改）：**没打死墨卒就一直停在遭遇战** —— 段落推进只有进度门控，没有时间轴', () => {
  const sc = new PrologueScene()
  toEncounter(sc)
  // 什么都不做，干等 5 分钟（远超原先那条 120 秒兜底）
  for (let i = 0; i < 60 * 300; i++) sc.step(NO_INPUT)

  assert.equal(sc.currentStage, 'encounter', '创始人明确要求：没有时间线，做完上一步才进下一段')
  assert.equal(sc.mote.alive, true, '墨卒还在，课还没上完')
  assert.equal(sc.telemetry.ac01Seconds(), null, '没击杀就是没击杀')
  assert.equal(sc.telemetry.ac01Passed(60), false)
})

test('批 3：质量差这节课"上到了"就进双丝（梁柱与轻陶罐各连一次）', () => {
  const sc = new PrologueScene()
  toEncounter(sc)
  killMote(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.currentStage, 'massdiff')

  // 走到够得着横梁的位置，连一次
  for (let i = 0; i < 90; i++) sc.step(input({ moveX: 1 }))
  fire(sc, { x: sc.player.pos.x, y: C.BEAM_CENTER_Y - C.BEAM_HALF_H })
  assert.equal(sc.world.ropes[0]!.targetId, sc.beam.id)
  sc.step(input({ cutRope: 0 }))
  for (let i = 0; i < 100; i++) sc.step(NO_INPUT) // 等丝位重凝

  // 再连一次轻陶罐
  fire(sc, sc.pot.pos)
  assert.equal(sc.world.ropes[0]!.targetId, sc.pot.id, '应该连上轻陶罐')
  sc.step(input({ cutRope: 0 }))

  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.currentStage, 'dual', '两个对照物都摸过就该进双丝段')
})

test('批 3（第 13 轮改）：只摸一个对照物**不会**推进（质量差必须成对才成立）', () => {
  const sc = new PrologueScene()
  toEncounter(sc)
  killMote(sc)
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.currentStage, 'massdiff')

  // 只连轻陶罐，不碰梁柱
  fire(sc, sc.pot.pos)
  assert.equal(sc.world.ropes[0]!.targetId, sc.pot.id)
  for (let i = 0; i < 60 * 240; i++) sc.step(NO_INPUT)

  assert.equal(sc.currentStage, 'massdiff', '没摸过梁柱就还没上完这节课，不该推进')
})

// ══════════════════════════════════════════════════════════
//  批 4：8:00–12:00 双丝 + 悬吊横梁 + 深沟（= 门，D-041）
// ══════════════════════════════════════════════════════════

/**
 * 走到双丝段。
 *
 * 用 `skipTo('dual')`（调试跳段）而不是"把前面两段真的玩一遍"：
 * 这一段之后的测试关心的都是**双丝段本身**的行为，前置两段各有自己的测试守着。
 * 好处是这些测试不会因为前面某段的细节调参而跟着一起红。
 */
function toDualByTimeout(sc: PrologueScene): void {
  sc.skipTo('dual')
  assert.equal(sc.currentStage, 'dual')
}

test('批 4：进入双丝段 → 解锁第二根丝、对岸墨卒入场（设计 §7 8:00）', () => {
  const sc = new PrologueScene()
  toDualByTimeout(sc)

  assert.equal(sc.world.unlockedRopes, 2, '第二根丝应在这一段解锁（FR-PRG-006 的 1→2）')
  assert.equal(sc.world.ropeDisplay().length, 2, 'HUD 应显示 2 枚圆点')
  assert.equal(sc.mote2.removed, false, '对岸墨卒应入场')
  assert.ok(sc.mote2.pos.x > C.CHASM_RIGHT_X, '它应站在沟对面')
  assert.equal(sc.hint(), TEXTS.stepDual, '这一段要给出过沟的完整两步（第 14 轮：创始人要求教明白）')
})

/** 走到沟左沿并**站稳**（不是一路走出平台）。 */
function toLedge(sc: PrologueScene): void {
  for (let i = 0; i < 60 * 4; i++) {
    sc.step(input({ moveX: sc.player.pos.x < 14.6 ? 1 : 0 }))
    if (sc.player.grounded && sc.player.pos.x >= 14.5) break
  }
  for (let i = 0; i < 30; i++) sc.step(NO_INPUT)
  assert.ok(sc.player.grounded, '应站在沟左沿上')
}

/** 收丝收到人**停下来**（悬着不动），而不是"收固定帧数"。 */
function reelUntilSettled(sc: PrologueScene, maxFrames = 300): void {
  let calm = 0
  for (let i = 0; i < maxFrames && calm <= 20; i++) {
    sc.step(input({ reel: 'in' }))
    calm = Math.abs(sc.player.vel.x) < 0.05 && Math.abs(sc.player.vel.y) < 0.05 ? calm + 1 : 0
  }
}

/**
 * **走一遍设计路线过沟**（写在测试里就是"这一关可通关"的证据）：
 *   1. 沟左沿连**悬吊横梁** → 收丝 → 被拉到沟正上方、离地 8 米；
 *   2. 连**对岸吊桩** → **断掉第一根**（不断的话第一根会把人拽回去）→ 收丝 → 被拉到对岸；
 *   3. 断丝 → 落到右平台。
 */
function crossChasm(sc: PrologueScene): void {
  toLedge(sc)
  const swingL = {
    x: C.SWING_BEAM_CENTER_X - C.SWING_BEAM_HALF_W,
    y: C.SWING_BEAM_CENTER_Y - C.SWING_BEAM_HALF_H,
  }

  // 第一步
  fire(sc, swingL)
  assert.equal(sc.world.ropes[0]!.targetId, sc.swingBeam.id, '第一步应连上悬吊横梁')
  reelUntilSettled(sc)
  const p1 = sc.player.pos
  assert.ok(
    p1.x > C.CHASM_LEFT_X && p1.x < C.CHASM_RIGHT_X,
    `收丝后应悬在沟的正上方（${C.CHASM_LEFT_X}~${C.CHASM_RIGHT_X}），实际 x=${p1.x.toFixed(1)}`,
  )
  assert.ok(p1.y > 5, `而且要真的离地（这就是设计 §4.2 说的"离地状态"），实际 y=${p1.y.toFixed(1)}`)

  // 第二步
  fire(sc, { x: C.FAR_POST_CENTER_X, y: C.FAR_POST_CENTER_Y })
  assert.equal(sc.world.ropes[1]!.targetId, sc.farPost.id, '第二步应连上对岸吊桩')
  sc.step(input({ cutRope: 0 }))
  assert.equal(sc.world.ropes[0]!.state, 'recovering', '必须断掉第一根，否则它会把人拽回沟心')
  reelUntilSettled(sc)
  assert.ok(
    sc.player.pos.x > C.CHASM_RIGHT_X,
    `第二步收完丝人应在对岸上空，实际 x=${sc.player.pos.x.toFixed(1)}`,
  )
  assert.equal(sc.cleared, false, '**还在空中，不算过关**——过关要求"站到平台上"')

  // 落地。
  //
  // ⚠️ 收丝是把人**一路收到锚点边上**（第 14 轮起主角这一端只在收丝时吃弹簧力，
  // 所以"贴着锚点停下来"是必然结果）。于是收到底之后人可能：
  //   · 挂在吊桩**旁边** ⇒ 断丝直接落到平台；
  //   · 或者被挤到吊桩**顶上**站着（实测两种都出现过，取决于接近角度）。
  // 后者不是 bug，但**不能算过关**（过关要求站在平台上）——所以这里补一段"往前走"，
  // 这也正是真人会做的事：发现自己站在一个小方块上，就往下走。
  sc.step(input({ cutRope: 1 }))
  for (let i = 0; i < 60; i++) sc.step(NO_INPUT)
  for (let i = 0; i < 400 && !sc.cleared; i++) sc.step(input({ moveX: 1 }))
  // 万一往右走是墙，再往回走一次（对岸平台在 21..32，桩在 27..29）
  for (let i = 0; i < 400 && !sc.cleared; i++) sc.step(input({ moveX: -1 }))
}

test('✅ 批 4 过关（D-041）：走完设计路线、站上对岸平台 = 通关，敌人不必清空', () => {
  const sc = new PrologueScene()
  toDualByTimeout(sc)
  assert.equal(sc.cleared, false)
  assert.equal(sc.mote2.alive, true, '过关时对岸的墨卒可以还活着')

  crossChasm(sc)

  assert.equal(sc.cleared, true, '穿过「门」就是过关')
  assert.equal(sc.hint(), '过了', '通关要有反馈')
  assert.ok(sc.player.grounded, '落地才算数')
  assert.ok(sc.player.pos.x > C.CHASM_RIGHT_X, '人确实在对岸')
  assert.equal(sc.mote2.alive, true, '一次都没打它也能过关')
  assert.ok(sc.telemetry.snapshot().some((e) => e.kind === 'stage' && e.name === 'cleared'))
})

test('批 4 反例：一路向右走是过不去的（沟就是那道门）', () => {
  const sc = new PrologueScene()
  toDualByTimeout(sc)

  let maxX = sc.player.pos.x
  for (let i = 0; i < 60 * 8; i++) {
    sc.step(input({ moveX: 1 }))
    maxX = Math.max(maxX, sc.player.pos.x)
  }

  assert.ok(maxX < C.CHASM_RIGHT_X, `走不过去，最远只到 x=${maxX.toFixed(1)}`)
  assert.equal(sc.cleared, false)
  assert.ok(
    sc.telemetry.snapshot().filter((e) => e.kind === 'fall').length > 0,
    '而且他确实掉下去过——不是被一堵空气墙挡住',
  )
})

test('批 4：深沟只能靠丝过——从沟左沿够不着对岸吊桩（一步到不了）', () => {
  const sc = new PrologueScene()
  toDualByTimeout(sc)
  toLedge(sc)

  // 一步到位连对岸吊桩：超丝长上限，必须连不上
  fire(sc, { x: C.FAR_POST_CENTER_X, y: C.FAR_POST_CENTER_Y })
  assert.equal(sc.world.ropes[0]!.targetId, -1, '够不着才对——否则沟就不是门')
  const d = Math.hypot(
    C.FAR_POST_CENTER_X - sc.player.pos.x,
    C.FAR_POST_CENTER_Y - sc.player.pos.y,
  )
  assert.ok(d > C.ROPE_LEN_MAX, `左沿到吊桩 ${d.toFixed(1)}m 应超过丝长上限 ${C.ROPE_LEN_MAX}m`)
  // 而悬吊横梁够得着（"门"必须有解法）
  fire(sc, {
    x: C.SWING_BEAM_CENTER_X - C.SWING_BEAM_HALF_W,
    y: C.SWING_BEAM_CENTER_Y - C.SWING_BEAM_HALF_H,
  })
  assert.equal(sc.world.ropes[0]!.targetId, sc.swingBeam.id, '悬吊横梁必须够得着')
})

// ══════════════════════════════════════════════════════════
//  第 14 轮实机反馈的回归
// ══════════════════════════════════════════════════════════

test('#1 靶子**不能附着**（创始人后续要求），而**砸一下就碎**', () => {
  const sc = new PrologueScene()
  assert.equal(sc.jar.anchorable, false, '靶子是靶子，不是锚点')
  assert.equal(sc.jar.fragile, true, '而且必须易碎')

  // 站在它旁边也连不上
  sc.player.pos = { x: sc.jar.pos.x - 3, y: C.PLAYER_HALF_H + 0.01 }
  for (let i = 0; i < 10; i++) sc.step(NO_INPUT)
  assert.equal(fire(sc, sc.jar.pos), false, '不该连得上靶子')

  // 但**中等速度**的石头就该砸碎它（8 m/s；改之前要 v ≥ 15 才会碎）
  const slowEnough = new PrologueScene()
  slowEnough.stone.pos = { x: 11, y: 0.51 }
  slowEnough.stone.vel = { x: 8, y: 0 }
  for (let i = 0; i < 90; i++) slowEnough.step(NO_INPUT)
  assert.equal(slowEnough.jarBroken, true, '8 m/s 砸上去就该碎（易碎规则）')
})

test('#2 陶罐**推不进沟里**（创始人：「墨卒移动会把陶罐推进沟里」）', () => {
  const sc = new PrologueScene()
  // 进遭遇战（墨卒入场）
  fire(sc, sc.stone.pos)
  sc.step(input({ reel: 'in' }))
  sc.step(input({ cutRope: 0 }))
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.currentStage, 'encounter')

  // 玩家一路往右（这正是试玩时会做的事），墨卒会跟着，石块也会在地上滚
  for (let i = 0; i < 60 * 30; i++) sc.step(input({ moveX: 1 }))

  assert.ok(
    Math.abs(sc.jar.pos.x - PROLOGUE.jarX) < 0.01,
    `陶罐必须原地不动，实际 ${PROLOGUE.jarX} → ${sc.jar.pos.x.toFixed(2)}`,
  )
  assert.ok(sc.jar.pos.y > 0, `陶罐不该掉进沟里，实际 y=${sc.jar.pos.y.toFixed(2)}`)
  assert.ok(
    sc.mote.pos.x <= C.PROLOGUE_MOTE_LEDGE_GUARD_X + 0.05,
    `墨卒也必须被护栏挡住（不许越过 ${C.PROLOGUE_MOTE_LEDGE_GUARD_X}），实际 ${sc.mote.pos.x.toFixed(2)}`,
  )
})

test('#4 张力到顶只会**挡住**着地的主角，不会把他拽上天', () => {
  const sc = new PrologueScene()
  sc.skipTo('massdiff')
  // 站到横梁左侧下方（横梁 x 4..14）
  sc.player.pos = { x: 4, y: C.PLAYER_HALF_H + 0.01 }
  for (let i = 0; i < 20; i++) sc.step(NO_INPUT)
  assert.equal(fire(sc, { x: 4, y: C.BEAM_CENTER_Y - C.BEAM_HALF_H }), true)

  // 一直往右走 3 秒
  let maxY = sc.player.pos.y
  let airborneFrames = 0
  for (let i = 0; i < 180; i++) {
    sc.step(input({ moveX: 1 }))
    maxY = Math.max(maxY, sc.player.pos.y)
    if (!sc.player.grounded) airborneFrames++
  }

  assert.ok(
    maxY < 2,
    `着地的主角不该被拽离地面（实测过一帧 +29 m/s 直接上天），实际最高 y=${maxY.toFixed(2)}`,
  )
  assert.ok(airborneFrames < 30, `最多短暂离地，实际离地 ${airborneFrames} 帧`)
  assert.ok(
    Math.abs(sc.player.pos.x - 4) < 8,
    `应该被丝线挡在一个可达范围内，实际 x=${sc.player.pos.x.toFixed(2)}`,
  )
})

test('#4 收丝**仍然**能把主角拉过去（"人物能被拉走的方式是收丝"）', () => {
  const sc = new PrologueScene()
  sc.skipTo('massdiff')
  sc.player.pos = { x: 4, y: C.PLAYER_HALF_H + 0.01 }
  for (let i = 0; i < 20; i++) sc.step(NO_INPUT)
  fire(sc, { x: 4, y: C.BEAM_CENTER_Y - C.BEAM_HALF_H })

  const y0 = sc.player.pos.y
  for (let i = 0; i < 180; i++) sc.step(input({ reel: 'in' }))

  assert.ok(
    sc.player.pos.y > y0 + 2,
    `收丝必须把主角拉离地面（这是质量差那一课的核心），实际 ${y0.toFixed(2)} → ${sc.player.pos.y.toFixed(2)}`,
  )
  assert.equal(sc.player.grounded, false)
})

test('掉进沟里的**物件**会被送回出生点（纯进度门控下，否则是死局）', () => {
  const sc = new PrologueScene()
  sc.skipTo('dual')
  // 把石块扔进沟里
  sc.stone.pos = { x: (C.CHASM_LEFT_X + C.CHASM_RIGHT_X) / 2, y: -5 }
  sc.stone.vel = { x: 0, y: -10 }
  sc.step(NO_INPUT)

  assert.ok(
    Math.abs(sc.stone.pos.x - PROLOGUE.stoneX) < 0.01,
    `石块应被送回出生点 ${PROLOGUE.stoneX}，实际 ${sc.stone.pos.x.toFixed(2)}`,
  )
  assert.equal(sc.stone.pos.y > 0, true)
})

test('#3 甩起来的一击**真的能打死墨卒**（端到端：连上→甩→断→命中）', () => {
  const sc = new PrologueScene()
  fire(sc, sc.stone.pos)
  sc.step(input({ reel: 'in' }))
  sc.step(input({ cutRope: 0 }))
  for (let i = 0; i < 70; i++) sc.step(NO_INPUT)
  assert.equal(sc.currentStage, 'encounter')

  // 走到石头左边（这样甩出去是朝右、正对墨卒）
  sc.player.pos = { x: sc.stone.pos.x - 3, y: C.PLAYER_HALF_H + 0.01 }
  for (let i = 0; i < 10; i++) sc.step(NO_INPUT)
  assert.ok(
    sc.mote.pos.x > sc.stone.pos.x,
    `墨卒应该在石头右边（间距 ${C.MOTE_STOP_DISTANCE}m 把它留在甩击空间之外），实际 石头=${sc.stone.pos.x.toFixed(1)} 墨卒=${sc.mote.pos.x.toFixed(1)}`,
  )

  // 等丝位重凝（刚断过丝，1.5s 内连不上——FR-PHY-007）
  for (let i = 0; i < 120 && sc.world.ropes[0]!.state !== 'idle'; i++) sc.step(NO_INPUT)
  assert.equal(sc.world.ropes[0]!.state, 'idle', '丝位重凝之后才连得上')

  assert.equal(fire(sc, sc.stone.pos), true, '先连上石头')
  // 一边左右跑一边按住收丝（这就是 M0 验收过的"甩"）
  let released = false
  for (let i = 0; i < 900 && !released; i++) {
    sc.step(input({ moveX: Math.floor(i / 20) % 2 === 0 ? -1 : 1, reel: 'in' }))
    const v = sc.stone.vel
    const speed = Math.hypot(v.x, v.y)
    // 甩到"朝右且够快（切割门槛 15）"就断丝
    if (speed >= C.CUT_MIN_SPEED && v.x > 0) {
      sc.step(input({ cutRope: 0 }))
      released = true
    }
  }
  assert.ok(released, '应该能在 15 秒内甩出一次"朝右且 ≥15 m/s"的投掷（这是这一课的核心动作）')

  for (let i = 0; i < 300 && sc.mote.alive; i++) sc.step(NO_INPUT)
  assert.equal(
    sc.mote.alive,
    false,
    `这一击应该打死墨卒（HP ${C.MOTE_HP}，15 m/s 的切割伤害是 ${((C.CUT_MIN_SPEED * C.CUT_MIN_SPEED) / 60).toFixed(2)}）`,
  )
  assert.ok(sc.telemetry.ac01Passed(60), '而且这次击杀应该被 AC-01 记到账上')
})

test('批 4：掉进沟里 → 软重生回沟边（R1 不做死亡，D-040）', () => {
  const sc = new PrologueScene()
  toDualByTimeout(sc)

  sc.player.pos = { x: (C.CHASM_LEFT_X + C.CHASM_RIGHT_X) / 2, y: -5 }
  sc.player.vel = { x: 0, y: -10 }
  sc.step(NO_INPUT)

  assert.ok(
    Math.abs(sc.player.pos.x - C.CHASM_RESPAWN_X) < 0.1,
    `应被放回沟边 x=${C.CHASM_RESPAWN_X}，实际 ${sc.player.pos.x.toFixed(1)}`,
  )
  assert.equal(sc.player.vel.y, 0, '速度应归零')
  assert.equal(sc.player.alive, true, 'R1 不实现死亡——掉下去不是死')
  const falls = sc.telemetry.snapshot().filter((e) => e.kind === 'fall')
  assert.equal(falls.length, 1, '埋点应记下这次掉落')
})

test('批 4：站在高处的结构上**不算**过关（过关要"站到对岸平台上"）', () => {
  const sc = new PrologueScene()
  toDualByTimeout(sc)

  // 站在悬吊横梁顶上：x 已经在对岸那一侧，但那不是"过了沟"
  sc.player.pos = { x: C.CHASM_RIGHT_X + 0.6, y: C.SWING_BEAM_CENTER_Y + C.SWING_BEAM_HALF_H + 0.81 }
  sc.player.vel = { x: 0, y: 0 }
  for (let i = 0; i < 40; i++) sc.step(NO_INPUT)

  assert.ok(
    sc.player.pos.y > C.CHASM_CLEAR_MAX_Y,
    `人应停在横梁上（实测 y=${sc.player.pos.y.toFixed(2)}）`,
  )
  assert.equal(sc.cleared, false, '站在 9 米高的梁上不是过关——漏掉高度判定时这里会误判通关')
})

test('批 4：收丝贴到静态结构上是**停下来**，不是陷进去抖（D-050）', () => {
  const sc = new PrologueScene()
  toDualByTimeout(sc)
  for (let i = 0; i < 60 * 3; i++) sc.step(input({ moveX: sc.player.pos.x < 13 ? 1 : 0 }))
  for (let i = 0; i < 30; i++) sc.step(NO_INPUT)

  // 连主横梁、一直收丝
  fire(sc, { x: sc.player.pos.x, y: C.BEAM_CENTER_Y - C.BEAM_HALF_H })
  assert.equal(sc.world.ropes[0]!.targetId, sc.beam.id)
  for (let i = 0; i < 200; i++) sc.step(input({ reel: 'in' }))

  const top = sc.player.pos.y + C.PLAYER_HALF_H
  const beamBottom = C.BEAM_CENTER_Y - C.BEAM_HALF_H
  assert.ok(
    top <= beamBottom + 0.25,
    `人应停在横梁下方，不该嵌进梁里（顶=${top.toFixed(2)} 梁底=${beamBottom}）`,
  )
  assert.ok(
    Math.abs(sc.player.vel.y) < 1,
    `贴住之后应该是静止的，实际 vy=${sc.player.vel.y.toFixed(1)}（曾经在梁里以 ±25 m/s 抖）`,
  )
  assert.equal(sc.cleared, false)
})

test('批 4 reset：丝位回到 1 根解锁、对岸墨卒收回', () => {
  const sc = new PrologueScene()
  toDualByTimeout(sc)
  assert.equal(sc.world.unlockedRopes, 2)

  sc.reset()
  assert.equal(sc.world.unlockedRopes, 1)
  assert.equal(sc.mote2.removed, true)
  assert.equal(sc.currentStage, 'tutorial')
  assert.equal(sc.cleared, false)
  assert.equal(sc.world.ropes[0]!.state, 'idle')
})
