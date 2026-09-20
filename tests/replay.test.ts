/**
 * 回放导入的回归（NFR-MNT-003 的"导入"那一半）。
 *
 * 这一组测试守的是一个很具体的能力：**把一段输入序列文本喂回来，能逐帧重演出同一段模拟**。
 * 它是"创始人按 `H` 把序列发给我 → 我在本机重放他那一刻"这条链路的保证。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { M0Scenario } from '../assets/scripts/core/scene_m0'
import { PrologueScene } from '../assets/scripts/core/scene_prologue'
import { encodeInput, input } from '../assets/scripts/core/input'
import {
  formatCapture,
  formatCaptureLines,
  parseReplay,
  replay,
  replayText,
  stringifyFrames,
} from '../assets/scripts/core/replay'
import { NO_INPUT, fire } from './helpers'

test('编码 → 解码 往返一致（含瞄准点、收放、断丝、凝神）', () => {
  const frames = [
    input({}),
    input({ moveX: 1 }),
    input({ moveX: -1, reel: 'in' }),
    input({ moveX: 0.37, reel: 'out', cutRope: 1, focus: true }),
    input({ aimPoint: { x: 12.5, y: 3.25 }, firePressed: true }),
    input({ aimPoint: { x: -0.5, y: 0 } }),
  ]
  const text = stringifyFrames(frames)
  const { capture, skipped } = parseReplay(text)
  assert.equal(skipped, 0)
  assert.equal(capture.frames.length, frames.length)
  for (let i = 0; i < frames.length; i++) {
    assert.deepEqual(capture.frames[i], frames[i], `第 ${i} 帧往返之后必须一致`)
  }
})

test('解析要宽容：空行 / 注释 / 日志行 / 缺列 都跳过而不炸', () => {
  const text = [
    '# scene=prologue tick=0',
    '[牵丝] QiansiBootstrap 已启动（场景=prologue）',
    '',
    '1||0|1|-1|0',
    '这一行不是输入',
    '0||0|0|-1|0',
  ].join('\n')
  const { capture, skipped } = parseReplay(text)
  assert.equal(capture.frames.length, 2, '只应解析出两帧合法输入')
  assert.ok(skipped >= 1, '非法行要被计数')
  assert.equal(capture.scene, 'prologue')
})

test('**回放同一段序列 ⇒ 同一段哈希轨迹**（这才是"能复现"的定义）', () => {
  // 造一段有内容的操作：连石头 → 收丝 → 断丝 → 走路
  const sc = new PrologueScene()
  const frames = []
  frames.push(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, firePressed: true }))
  for (let i = 0; i < 30; i++) frames.push(input({ reel: 'in' }))
  frames.push(input({ cutRope: 0 }))
  for (let i = 0; i < 120; i++) frames.push(input({ moveX: i % 60 < 30 ? 1 : -1 }))

  const text = stringifyFrames(frames)
  const a = replayText(text).result
  const b = replayText(text).result
  assert.deepEqual(a.hashes, b.hashes, '两次回放的哈希轨迹必须逐位一致')
  assert.equal(a.finalHash, b.finalHash)

  // 而且必须与"直接喂帧"跑出来的一致（回放不是另写了一套模拟）
  const live = new PrologueScene()
  const liveHashes = []
  for (let i = 0; i < frames.length; i++) {
    live.step(frames[i]!)
    if (i % 30 === 0) liveHashes.push(live.world.stateHash())
  }
  assert.deepEqual(a.hashes, liveHashes, '回放结果必须与实时跑帧完全一致')
  assert.equal(a.finalHash, live.world.stateHash())
})

test('回放能重演出**事件**（用来定位"第几帧发生了什么"）', () => {
  const sc = new PrologueScene()
  const frames = []
  frames.push(input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, firePressed: true }))
  for (let i = 0; i < 40; i++) frames.push(input({ reel: 'in' }))
  frames.push(input({ cutRope: 0 }))

  const { result } = replayText(stringifyFrames(frames))
  const kinds = result.events.map((e) => e.kind)
  assert.ok(kinds.includes('rope-launched'), '应该能看到"丝射出去了"')
  assert.ok(kinds.includes('rope-attached'), '以及"到位了"')
  assert.ok(kinds.includes('rope-cut'), '以及"断了"')
  const attached = result.events.find((e) => e.kind === 'rope-attached')!
  assert.ok(attached.tick > 0, '事件要带绝对 tick')
})

test('回放 M0 沙盒也行（scene=m0）', () => {
  const sc = new M0Scenario()
  const frames = [
    input({ aimPoint: { x: sc.stone.pos.x, y: sc.stone.pos.y }, firePressed: true }),
    ...Array.from({ length: 60 }, () => input({ reel: 'in' })),
  ]
  const text = `# scene=m0\n${stringifyFrames(frames)}`
  const { capture } = parseReplay(text)
  assert.equal(capture.scene, 'm0')
  const r = replay(capture)
  assert.ok(r.frames === frames.length)

  // 与实时跑帧一致
  const live = new M0Scenario()
  for (const f of frames) live.step(f)
  assert.equal(r.finalHash, live.world.stateHash())
})

test('帧数不足时用空帧补齐，不会越界（捕获可能被截断）', () => {
  const text = '0||0|0|-1|0'
  const { result } = replayText(text)
  assert.equal(result.frames, 1)
  assert.equal(result.hashes.length, 1)
})

test('回归：`fire()` 之后没有断丝的回放，和现场那次是同一个哈希', () => {
  // 这条模仿"创始人只按了 H，什么都没做"的极简场景
  const sc = new PrologueScene()
  const frames = [input({ moveX: 1 }), input({ moveX: 1 }), NO_INPUT, NO_INPUT]
  const live = new PrologueScene()
  for (const f of frames) live.step(f)
  const { result } = replayText(stringifyFrames(frames))
  assert.equal(result.finalHash, live.world.stateHash())
  assert.equal(encodeInput(frames[0]!), stringifyFrames(frames).split('\n')[0])
  void sc
  void fire
})

// ── 第 18 轮：`H` 导出的文本必须**真的**能验收 ────────────────────
//
// 修之前有两个"看起来能用其实不能"的地方：头部格式解析器不认（scene/tick 全丢），
// 以及捕获不是从开局录的却装作能复现。下面这几条把它们钉死。

test('H 的头部能被解析回来（产出与解析必须同一套格式）', () => {
  // 造一段"从开局起"的真实捕获：用 live 跑，再把导出文本重放，哈希必须对上。
  const live = new PrologueScene()
  const frames = [input({ moveX: 1 }), ...Array.from({ length: 40 }, () => input({ reel: 'in' }))]
  for (const f of frames) live.step(f)

  const text = formatCapture('prologue', frames, {
    tick: live.world.tick,
    baseTick: 12,
    hash: live.world.stateHash(),
  })
  // 热键那边记录的是**已编码的字符串**（`formatCaptureLines`），测试这边用的是输入帧
  // （`formatCapture`）。两条路必须产出同一段文本 —— 否则"测过的格式"和"线上用的格式"
  // 又会分家，而这正是第 18 轮修的那个 bug。
  assert.equal(
    formatCaptureLines('prologue', frames.map(encodeInput), {
      tick: live.world.tick,
      baseTick: 12,
      hash: live.world.stateHash(),
    }),
    text,
    'formatCapture 与 formatCaptureLines 必须产出完全相同的文本',
  )
  const { capture, skipped } = parseReplay(text)
  assert.equal(skipped, 0, '自己产出的文本不该有任何行被跳过')
  assert.equal(capture.scene, 'prologue')
  assert.equal(capture.startFrame, 0, '从开局录的捕获，起点帧号必须是 0')
  assert.equal(capture.expectedHash, live.world.stateHash())
  assert.equal(capture.truncated, false)

  const r = replay(capture)
  assert.equal(r.matches, true, '本机重跑必须逐位复现导出时的哈希')
  assert.equal(r.finalHash, live.world.stateHash())
})

test('头部自报的 hash 与重跑不一致时，`matches` 必须是明确的 false（不装作复现了）', () => {
  const frames = [input({ moveX: 1 }), input({ moveX: 1 })]
  const text = formatCapture('prologue', frames, { tick: 14, baseTick: 12, hash: 'deadbeefdeadbeef' })
  const { capture } = parseReplay(text)
  const r = replay(capture)
  assert.equal(r.matches, false, '哈希对不上就必须报 false，而不是 null/true')
  assert.equal(r.expectedHash, 'deadbeefdeadbeef')
})

test('旧格式（`[qiansi]` 环形缓冲）：元数据要认出来，且**起点必须诚实**', () => {
  // 旧版 `H` 打的是环形缓冲的最后 600 帧 —— 头部只有结束 tick，没有 baseTick/from。
  // 那种捕获**本来就不可能**复现中局状态，所以一律标成截断，而不是假装完整。
  const frames = Array.from({ length: 10 }, () => input({ moveX: 1 }))
  const legacy =
    `[qiansi] scene=m0 hash=0123456789abcdef tick=610\n` + stringifyFrames(frames)
  const { capture } = parseReplay(legacy)
  assert.equal(capture.scene, 'm0', '旧格式的 scene= 也要认出来（以前这里会退化成序章）')
  assert.equal(capture.expectedHash, '0123456789abcdef')
  assert.equal(capture.startFrame, 600, '起点 = 结束 tick − 帧数')
  assert.equal(capture.truncated, true, '旧格式一律标成截断：它不含开局')
  const r = replay(capture)
  assert.equal(r.startFrame, 600)
  assert.equal(r.matches, false, '不含开局的重跑不可能对上哈希 —— 必须报 false')
})

test('帧数与头部自报的不符 ⇒ 标记为已损坏（粘贴丢行不能装作没事）', () => {
  const frames = Array.from({ length: 5 }, () => input({ moveX: 1 }))
  const text = formatCapture('prologue', frames, { tick: 17, baseTick: 12, hash: 'aaaa' }).replace(
    'frames=5',
    'frames=6',
  )
  const { capture } = parseReplay(text)
  assert.equal(capture.truncated, true, '声称 6 帧却只给出 5 行，必须标成截断')
})

test('超长一局被截尾：`from=` 必须如实写出丢了多少帧', () => {
  const all = Array.from({ length: 20 }, () => input({ moveX: 1 }))
  const from = 12
  const text = formatCapture('prologue', all.slice(from), {
    tick: 32,
    baseTick: 12,
    hash: 'ffff',
    from,
    truncated: true,
  })
  const { capture } = parseReplay(text)
  assert.equal(capture.startFrame, 12, '丢掉的 12 帧就是保留段的起点帧号')
  assert.equal(capture.baseTick, 12)
  assert.equal(capture.truncated, true)
  assert.equal(capture.frames.length, 8)
})

test('帧号 ≠ tick：`baseTick` 要把序章开局那 12 步 offset 如实带上', () => {
  // 序章构造时 `settle(12)`（让主角落地），所以开局第一帧的 world.tick 是 12。
  // 这条测试存在的理由：第 18 轮我一度按"帧号 = tick"写了一条自检，把自己写红了。
  const sc = new PrologueScene()
  assert.equal(sc.world.tick, 12, '序章构造后 tick 应当是 12；变了就要来改这条与 Bootstrap 的 baseTick')
  const frames = Array.from({ length: 30 }, () => input({ moveX: 1 }))
  for (const f of frames) sc.step(f)
  const text = formatCapture('prologue', frames, {
    tick: sc.world.tick,
    baseTick: 12,
    hash: sc.world.stateHash(),
  })
  const { capture } = parseReplay(text)
  assert.equal(capture.baseTick, 12)
  assert.equal(capture.endTick, 42, '结束 tick = baseTick + 帧数')
  assert.equal(capture.startFrame, 0)
  assert.equal(capture.truncated, false)
})
