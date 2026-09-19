/**
 * 确定性回归（AC-05 / FR-PHY-008 / NFR-REL-003）。
 *
 * 「同一回放在 3 台设备 + 服务端产生相同哈希」是这个项目三条产品线
 * （速通 / 排行榜 / 回放分享）的共同前提，也是 R1 必须验证的两个存续判定点之一。
 *
 * 这组测试在**本机**证明了：给定相同的输入帧序列，内核的状态哈希逐位一致。
 * 它证明不了"跨设备"——那需要 AC-05 的完整验证流程（3 台真机 + 服务端），
 * 但只要内核不引入 wall-clock、随机数、遍历顺序依赖，IEEE-754 的四则运算
 * 在任意合规实现上就是逐位一致的，跨设备一致性由此可推。
 *
 * ⚠️ 注意：本测试里的"伪随机"输入是**测试专用**的固定种子 LCG，
 * 用来生成多样化的操作序列。内核本身**不含任何随机数**（FR-PHY-008）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { combineHashes, fnv1a32, hashFloat64, hashFloat64Wide } from '../assets/scripts/core/hash'
import { type InputFrame, encodeInput, input } from '../assets/scripts/core/input'
import { M0Scenario } from '../assets/scripts/core/scene_m0'

/** 固定种子线性同余发生器 —— 只用于生成测试输入序列。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** 生成一段确定性的操作脚本。 */
function script(ticks: number, seed: number): InputFrame[] {
  const rnd = lcg(seed)
  const frames: InputFrame[] = []
  let attached = false
  for (let i = 0; i < ticks; i++) {
    const r = rnd()
    const moveX = r < 0.3 ? -1 : r < 0.6 ? 1 : 0
    const reel = r < 0.45 ? 'in' : r < 0.7 ? 'out' : 'hold'
    // 第 10 tick 固定发起一次牵丝（瞄准石块初始位置附近）
    const attachPressed = i === 10
    const aimPoint = attachPressed ? { x: 8, y: 0.5 } : null
    // 每 137 tick 断一次丝
    const cutRope = attached && i % 137 === 0 ? 0 : -1
    if (attachPressed) attached = true
    if (cutRope >= 0) attached = false
    frames.push(input({ moveX, reel, attachPressed, aimPoint, cutRope }))
  }
  return frames
}

function play(seed: number, ticks = 900): { hashes: string[]; replay: string; final: string } {
  const sc = new M0Scenario()
  const frames = script(ticks, seed)
  const hashes: string[] = []
  const replay: string[] = []
  for (let i = 0; i < frames.length; i++) {
    sc.step(frames[i])
    replay.push(encodeInput(frames[i]))
    if (i % 30 === 0) hashes.push(sc.world.stateHash())
  }
  return { hashes, replay: replay.join('\n'), final: sc.world.stateHash() }
}

test('AC-05 同一输入序列 ⇒ 完全相同的状态哈希轨迹', () => {
  const a = play(20260919)
  const b = play(20260919)
  assert.equal(a.hashes.length, b.hashes.length)
  assert.deepEqual(a.hashes, b.hashes, '两次运行的哈希轨迹必须逐位一致')
  assert.equal(a.final, b.final)
  assert.equal(a.replay, b.replay, '回放录制也必须是逐字节一致的')
})

test('AC-05 输入不同 ⇒ 哈希不同（哈希确实反映了模拟状态）', () => {
  const a = play(1)
  const b = play(2)
  assert.notEqual(a.final, b.final)
})

test('AC-05 状态哈希对末位差异敏感（不会把不同状态哈希成同一个值）', () => {
  const sc = new M0Scenario()
  for (let i = 0; i < 60; i++) sc.step(input({ moveX: 1, reel: 'in' }))
  const h1 = sc.world.stateHash()
  sc.stone.pos = { x: sc.stone.pos.x + 1e-12, y: sc.stone.pos.y }
  const h2 = sc.world.stateHash()
  assert.notEqual(h1, h2)
})

test('哈希建立在浮点原始位型上，而不是四舍五入后的文本', () => {
  // 1e-16 的差异在 toFixed(6) 下会被抹平；如果哈希是文本近似，这里就会相等
  const a = hashFloat64([1.0000000000000002])
  const b = hashFloat64([1.0000000000000004])
  assert.notEqual(a, b)
  assert.equal(hashFloat64([1, 2, 3]), hashFloat64([1, 2, 3]))
  assert.notEqual(hashFloat64([1, 2, 3]), hashFloat64([1, 3, 2]))
})

test('NaN / Infinity 不产生跨平台不确定的位型', () => {
  // 所有非有限值都被折叠成确定的位型，避免不同引擎的 NaN 载荷差异
  assert.equal(hashFloat64([Number.NaN]), hashFloat64([Number.NaN]))
  assert.equal(hashFloat64([Number.POSITIVE_INFINITY]), hashFloat64([Number.NEGATIVE_INFINITY]))
})

test('哈希工具本身的稳定性', () => {
  assert.equal(fnv1a32(new Uint8Array([0])), fnv1a32(new Uint8Array([0])))
  assert.notEqual(fnv1a32(new Uint8Array([0])), fnv1a32(new Uint8Array([1])))
  assert.equal(hashFloat64Wide([1, 2]).length, 16)
  assert.equal(combineHashes(['ab', 'c']), combineHashes(['ab', 'c']))
})

test('回放序列化可往返、且不含时间戳等非确定信息', () => {
  const f = input({
    moveX: 0.5,
    aimPoint: { x: 1.23456789, y: -0.0000004 },
    attachPressed: true,
    reel: 'in',
    cutRope: 2,
    focus: true,
  })
  const s = encodeInput(f)
  assert.equal(s, encodeInput(f))
  assert.ok(!s.includes('e'), '不应出现科学计数法（会因引擎而异）')
  // -0 经 String() 归一为 "0"，同样是为了跨引擎可比
  assert.equal(s, '0.5|1.234568,0|1|1|2|1')
})

test('场景复位后哈希回到初值（reset 是可复现的）', () => {
  const sc = new M0Scenario()
  const h0 = sc.world.stateHash()
  for (let i = 0; i < 120; i++) sc.step(input({ moveX: 1 }))
  assert.notEqual(sc.world.stateHash(), h0)
  sc.reset()
  assert.equal(sc.world.stateHash(), h0, 'reset() 之后必须回到完全相同的初始状态')
})
