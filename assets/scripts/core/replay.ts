/**
 * 《牵丝》—— **回放导入**（NFR-MNT-003 的另一半）。
 *
 * ## 它解决什么问题
 *
 * 创始人试玩时按 `H` 会把输入序列打到控制台。以前那串文本**只能靠人肉阅读** ——
 * 前三轮里我为了定位"瞄准的 UI 全没了""砸上去却不掉血""被拉到天上"，
 * 只能靠推理与自写探针。有了这个文件之后，**把那串文本贴进一个文件就能在本机逐帧重放**
 * 他当时看到的每一帧（含事件、哈希、位置）。
 *
 * ## 用法
 *
 * ```bash
 * node --experimental-strip-types --import ./tests/register.mjs scripts/replay.ts capture.txt --events
 * ```
 *
 * 输入格式：`encodeInput()` 的输出，每行一帧；`#` 开头是注释，空行忽略。
 * 头部注释里带 `scene=` / `tick=` / `hash=`；`hash` 就是**验收依据**——
 * CLI 会用本机重跑出来的最终哈希去比它，对不上就明确报错（而不是让你猜）。
 *
 * ## 第 18 轮修掉的两个"看起来能用其实不能"的地方
 *
 * 1. **头部解析**：`H` 以前打的是 `[qiansi] scene=… hash=…`，而 `parseReplay()` 只从
 *    `#` 注释行读元数据 ⇒ 场景永远默认成序章、起点永远当 0。现在两代格式都认。
 * 2. **起点必须诚实**：捕获如果不是从 tick 0 开始的（旧版的 600 帧环形缓冲就会这样），
 *    本机从开局重跑**不可能**对上哈希。这种事不能装作没发生 —— `ReplayResult.faithful`
 *    会说清楚，CLI 也会把"对不上"标成预期的而不是 bug。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { type InputFrame, decodeInput, encodeInput } from './input'
import type { PlayableScene } from './playable'
import { M0Scenario } from './scene_m0'
import { PrologueScene } from './scene_prologue'

export interface ReplayCapture {
  /** 场景名：`prologue` 或 `m0`。 */
  readonly scene: 'prologue' | 'm0'
  /**
   * 第一帧在**会话里的帧号**。0 = 这份捕获从开局第一帧起就在录（`from=`）。
   *
   * ⚠️ **不是 tick**。序章在构造时会 `settle(12)`（让主角落地），所以 `world.tick`
   * 比帧号大 12 —— 一帧一步，但**帧号 ≠ tick**。第 18 轮我一度按"帧号 = tick"写了
   * 一条自检，结果把自己写红了，才把这个前提补进注释。
   */
  readonly startFrame: number
  /** 录制起点那一刻的世界 tick（`baseTick=`），用于把帧号换算成 tick。没有就是 null。 */
  readonly baseTick: number | null
  /** 导出那一刻的世界 tick（`tick=`）。 */
  readonly endTick: number | null
  /** 头部记录的、导出那一刻的状态哈希（没有就是 null）。CLI 拿它当验收依据。 */
  readonly expectedHash: string | null
  /** 头部自报"开头被截掉了"。 */
  readonly truncated: boolean
  readonly frames: readonly InputFrame[]
}

/**
 * 解析一段捕获文本。无法解析的行**跳过并计数**，不抛异常（要能直接吃控制台粘贴）。
 *
 * 元数据只从 `#` 注释行读；同时**兼容旧版** `[qiansi] scene=… hash=… tick=…` 那一行。
 */
export function parseReplay(text: string): { capture: ReplayCapture; skipped: number } {
  let scene: 'prologue' | 'm0' = 'prologue'
  /** 头部显式写的 `from=`（第一帧的会话帧号）。 */
  let startFrame = 0
  let baseTick: number | null = null
  let endTick: number | null = null
  let declaredFrames: number | null = null
  let expectedHash: string | null = null
  let truncated = false
  const frames: InputFrame[] = []
  let skipped = 0

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()

    // 元数据行：新格式是 `# …`，旧格式是 `[qiansi] …`。两者都扫一遍。
    const isMeta = line.startsWith('#') || line.startsWith('[qiansi]')
    if (isMeta) {
      const s = /scene\s*=\s*(\w+)/.exec(line)
      if (s !== null) scene = s[1] === 'm0' ? 'm0' : 'prologue'
      // 用 `[^a-zA-Z]` 挡住 `baseTick=`：它是"起点 tick"，不是"结束 tick"。
      const t = /(?:^|[^a-zA-Z])tick\s*=\s*(\d+)/.exec(line)
      if (t !== null) endTick = Number(t[1])
      const b = /baseTick\s*=\s*(\d+)/.exec(line)
      if (b !== null) baseTick = Number(b[1])
      const h = /hash\s*=\s*([0-9a-f]{4,32})/i.exec(line)
      if (h !== null) expectedHash = h[1]!
      const from = /from\s*=\s*(\d+)/.exec(line)
      if (from !== null) startFrame = Number(from[1])
      const f = /frames\s*=\s*(\d+)/.exec(line)
      if (f !== null) declaredFrames = Number(f[1])
      if (/truncated\s*=\s*1/.test(line)) truncated = true
      continue
    }

    const frame = decodeInput(line)
    if (frame === null) {
      if (line.length > 0) skipped++
      continue
    }
    frames.push(frame)
  }

  // 帧数与头部自报的不符 ⇒ 粘贴时丢/多行。不能装作没事：这份捕获已经不可信了。
  if (declaredFrames !== null && declaredFrames !== frames.length) truncated = true

  // 旧格式（`[qiansi]`）只有结束 tick、没有 `from=`/`baseTick=`。它当年打的是环形缓冲，
  // 起点一般不是 0 —— 但我们无法知道，所以**如实标成截断**而不是假装完整。
  if (endTick !== null && baseTick === null) {
    baseTick = 0
    startFrame = Math.max(0, endTick - frames.length)
    if (startFrame > 0) truncated = true
  }

  return {
    capture: { scene, startFrame, baseTick, endTick, expectedHash, truncated, frames },
    skipped,
  }
}

export interface ReplayResult {
  /** 每 30 帧存一次的状态哈希（和 `determinism.test.ts` 同一口径）。 */
  readonly hashes: readonly string[]
  /** 逐帧的模拟事件（带绝对 tick），用于定位"哪一帧发生了什么"。 */
  readonly events: readonly { tick: number; kind: string; detail: string }[]
  readonly finalHash: string
  /** 重放了多少帧。**注意一帧 = 一步，但帧号 ≠ tick**（序章构造时 settle 了 12 步）。 */
  readonly frames: number
  /** 这份捕获的起点是会话的第几帧。**只有 0 才意味着"重跑能逐位复现导出时的状态"**。 */
  readonly startFrame: number
  /** 捕获自报的状态哈希。 */
  readonly expectedHash: string | null
  /** 重跑结果与 `expectedHash` 是否一致。没有 `expectedHash` 时为 null。 */
  readonly matches: boolean | null
}

function makeScene(kind: 'prologue' | 'm0'): PlayableScene {
  return kind === 'm0' ? new M0Scenario() : new PrologueScene()
}

/**
 * 跑一遍捕获。
 *
 * **每个 tick 只喂一帧**（多出来的帧丢掉、不够就补空帧）—— 因为捕获可能来自
 * "渲染帧里跑了多个固定步"的时刻，而回放必须严格一帧一 tick。
 */
export function replay(capture: ReplayCapture): ReplayResult {
  const sc = makeScene(capture.scene)
  const hashes: string[] = []
  const events: { tick: number; kind: string; detail: string }[] = []
  const empty: InputFrame = {
    moveX: 0,
    aimPoint: null,
    firePressed: false,
    reel: 'hold',
    cutRope: -1,
    focus: false,
  }

  for (let i = 0; i < capture.frames.length; i++) {
    const frame = capture.frames[i] ?? empty
    sc.step(frame)
    if (i % 30 === 0) hashes.push(sc.world.stateHash())
    for (const e of sc.world.events) {
      events.push({ tick: sc.world.tick, kind: e.kind, detail: describe(e) })
    }
  }

  const finalHash = sc.world.stateHash()
  return {
    hashes,
    events,
    finalHash,
    frames: capture.frames.length,
    startFrame: capture.startFrame,
    expectedHash: capture.expectedHash,
    matches: capture.expectedHash === null ? null : capture.expectedHash === finalHash,
  }
}

/** 把一条模拟事件压成一行文字（给 CLI 用）。 */
function describe(e: { kind: string; [k: string]: unknown }): string {
  const keys = Object.keys(e).filter((k) => k !== 'kind')
  return keys.map((k) => `${k}=${JSON.stringify(e[k])}`).join(' ')
}

/** 便捷：把一段文本直接跑完。 */
export function replayText(text: string): { result: ReplayResult; skipped: number } {
  const { capture, skipped } = parseReplay(text)
  return { result: replay(capture), skipped }
}

/** 把一串输入帧编回文本（导出用；与 `encodeInput` 一致，方便测试往返）。 */
export function stringifyFrames(frames: readonly InputFrame[]): string {
  return frames.map(encodeInput).join('\n')
}

/**
 * 造一段可复现的捕获文本：**头部格式与 `H` 热键打出来的完全一致**。
 *
 * 存在的理由：`H` 的头部格式以前和解析器对不上（第 18 轮修的正是这个），
 * 两边各写一遍格式就还会再次对不上。所以由这里产出、由 `parseReplay` 消费，
 * `tests/replay.test.ts` 会锁住这个往返。
 *
 * `lines` 是**已经 encode 过的**输入行 —— 热键那边记录的就是字符串（它不该为了导出
 * 再解码一遍），所以这里直接吃字符串，避免"解码→编码"的往返损耗。
 */
export function formatCaptureLines(
  scene: 'prologue' | 'm0',
  lines: readonly string[],
  meta: { tick: number; baseTick: number; hash: string; from?: number; truncated?: boolean },
): string {
  const from = meta.from ?? 0
  const truncated = meta.truncated ?? false
  return (
    `# scene=${scene} tick=${meta.tick} baseTick=${meta.baseTick} hash=${meta.hash}\n` +
    `# frames=${lines.length} from=${from} truncated=${truncated ? 1 : 0}\n` +
    lines.join('\n')
  )
}

/** 输入帧版本，便于测试与脚本使用。 */
export function formatCapture(
  scene: 'prologue' | 'm0',
  frames: readonly InputFrame[],
  meta: { tick: number; baseTick: number; hash: string; from?: number; truncated?: boolean },
): string {
  return formatCaptureLines(scene, frames.map(encodeInput), meta)
}
