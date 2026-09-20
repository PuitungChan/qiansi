/**
 * 把创始人按 `H` 导出的输入序列**逐帧重放**出来。
 *
 * 用法：
 *   node --experimental-strip-types --import ./tests/register.mjs scripts/replay.ts capture.txt
 *   node --experimental-strip-types --import ./tests/register.mjs scripts/replay.ts capture.txt --events
 *
 * 输入文件就是控制台里那一段（`# …` 注释行与旧的 `[qiansi] …` 行都会被识别；
 * 解析失败的行会被跳过并报数）。
 *
 * 输出：每 30 tick 的状态哈希、模拟事件、终态哈希，以及一句**结论**：
 *
 * - `✅ 逐位复现`：本机重跑的哈希与导出时那一刻的哈希一致 ⇒ 我看到的就是你看到的。
 * - `❌ 对不上`：代码版本不同（或捕获被截断/粘贴丢行）。这是最先该排除的一件事。
 * - `⚠️ 起点不是 0`：捕获本身不含开局，**本来就不可能**对上哈希 —— 不是 bug，
 *   但这份捕获只能用来复现"输入节奏"，不能用来复现状态。
 */

import { readFileSync } from 'node:fs'
import { parseReplay, replay } from '../assets/scripts/core/replay'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))

if (file === undefined) {
  console.error('用法: replay.ts <capture.txt> [--events] [--quiet]')
  process.exit(2)
}

const text = readFileSync(file, 'utf8')
const { capture, skipped } = parseReplay(text)
const tickOf = (frameIndex: number): number | null =>
  capture.baseTick === null ? null : capture.baseTick + capture.startFrame + frameIndex
console.log(
  `场景=${capture.scene}  起点=会话第 ${capture.startFrame} 帧` +
    (capture.baseTick === null ? '' : `（世界 tick ${capture.baseTick + capture.startFrame}）`) +
    `  帧数=${capture.frames.length}  跳过的行=${skipped}` +
    (capture.truncated ? '  (头部自报已截断/行数不符)' : ''),
)

if (capture.frames.length === 0) {
  console.error(
    '没有解析出任何输入帧 —— 检查粘贴的文本格式（每行应为 moveX|aimX,aimY|fire|reel|cut|focus）',
  )
  process.exit(1)
}

const result = replay(capture)

console.log('\n── 每 30 帧的状态哈希 ──')
for (let i = 0; i < result.hashes.length; i++) {
  const tk = tickOf(i * 30)
  const label = tk === null ? `帧 ${String(capture.startFrame + i * 30).padStart(6)}` : `tick ${String(tk).padStart(6)}`
  console.log(`${label}  ${result.hashes[i]}`)
}

const interesting = new Set([
  'rope-launched',
  'rope-attached',
  'rope-cut',
  'rope-missed',
  'damage',
  'killed',
  'impact',
  'fall',
  'stage',
])
const pick = args.includes('--events') || args.includes('-e')
  ? result.events
  : result.events.filter((e) => interesting.has(e.kind))

console.log('\n── 模拟事件 ──')
if (pick.length === 0) console.log('(没有)')
for (const e of pick.slice(0, 400)) {
  console.log(`tick ${String(e.tick).padStart(6)}  ${e.kind.padEnd(14)} ${e.detail}`)
}
if (pick.length > 400) console.log(`… 还有 ${pick.length - 400} 条`)

console.log(
  `\n终态哈希 ${result.finalHash}  （重放 ${result.frames} 帧` +
    (capture.endTick === null ? '）' : `，导出时世界 tick=${capture.endTick}）`),
)

// ── 结论 ──────────────────────────────────────────────
if (result.expectedHash === null) {
  console.log('ℹ️  这份捕获没有带 `hash=`，无法自动比对（不影响上面的事件轨迹）。')
} else if (capture.startFrame > 0) {
  console.log(
    `⚠️  捕获自报 hash=${result.expectedHash}，但起点是会话第 ${capture.startFrame} 帧（不是开局），` +
      `本机重跑不可能对上 —— 想逐位复现请按 R 清掉记录、复现一次、再按 H 导出。`,
  )
} else if (result.matches === true) {
  console.log(`✅ 逐位复现：本机重跑 hash=${result.finalHash} 与导出时一致。`)
} else {
  console.log(
    `❌ 对不上：本机 ${result.finalHash} ≠ 捕获 ${result.expectedHash}。` +
      `优先怀疑"我这边的代码和你跑的不是同一版"，其次怀疑捕获被截断或粘贴丢了行。`,
  )
  process.exitCode = 3
}
