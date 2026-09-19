/**
 * 《牵丝》—— AC-01 埋点（FR-LIV-003 / D-042）。
 *
 * ## 为什么这个模块存在
 *
 * AC-01 是**项目存续的判定点**：「≥ 60% 的首次玩家在 5 分钟遭遇战中，
 * **60 秒内自主使用石块击杀**」。而交接清单 §5.2 对测试的硬要求是
 * 「**不要给任何提示，不要让他在旁边看你操作**」——**靠人工拄表就破坏了测试条件**。
 *
 * 所以判定必须自动化：测完直接拿数据，"60 秒"可以逐帧复核。
 *
 * ## 三条纪律
 *
 * 1. **不引入不确定性**：时间戳一律由 `tick` 换算（`tick / 60`），**绝不用 wall-clock**。
 *    埋点数据不进 `stateHash`，但记录过程不能影响模拟。
 * 2. **不记录隐私**：只有游戏内事件（位置 / 操作 / 时间），没有任何个人信息、不联网。
 * 3. **永不抛错**：埋点坏了不该让游戏崩——所有方法对异常输入静默降级。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { TICK_HZ } from './constants'
import type { SimEvent } from './events'
import type { InputFrame } from './input'
import type { World } from './world'

export type TelemetryKind =
  /** 试玩开始 */
  | 'run_start'
  /** **AC-01 的计时起点**：墨卒入场 */
  | 'encounter_start'
  /** 周期性位置采样 */
  | 'pos'
  /** 牵上丝线（累计次数同时记在 `attachCount`） */
  | 'attach'
  /** 玩家主动断丝 */
  | 'cut'
  /** 超限断丝（D-032 后不该再出现，留着当哨兵） */
  | 'rope_broken'
  /** 陶罐被砸碎 */
  | 'jar_broken'
  /** 击杀。`by` 是凶器名字（`stone` = 石块，正是 AC-01 要找的） */
  | 'kill'
  /** 触发了 60 秒克制提示（石头开始发光） */
  | 'hint_glow'
  /** 进入新的序章段落（`name` 是段落名） */
  | 'stage'
  /** 试玩结束 */
  | 'run_end'

export interface TelemetryEvent {
  /** 距 `run_start` 的秒数（由 tick 换算，不是 wall-clock）。 */
  readonly t: number
  readonly tick: number
  readonly kind: TelemetryKind
  /** 其余字段一律是可直接打印的标量，便于导出 CSV。 */
  readonly [key: string]: number | string | boolean
}

/** 位置采样间隔（tick）。0.5 秒一次 —— 够画出"他卡在哪"，又不会把文件撑大。 */
const POS_SAMPLE_TICKS = 30

export class Telemetry {
  private readonly events: TelemetryEvent[] = []
  private readonly maxEvents: number
  private startTick = -1
  private encounterTick = -1
  private attachCount = 0
  private lastPosSample = -1

  constructor(maxEvents = 20000) {
    this.maxEvents = maxEvents
  }

  get length(): number {
    return this.events.length
  }

  /** 试玩开始。幂等——重复调用只记第一次。 */
  start(tick: number): void {
    if (this.startTick >= 0) return
    this.startTick = tick
    this.push(tick, 'run_start', {})
  }

  /**
   * **AC-01 的计时起点**。墨卒入场时调用一次。
   * @returns 是否本次真的开始了遭遇战（重复调用返回 false）
   */
  startEncounter(tick: number): boolean {
    if (this.encounterTick >= 0) return false
    this.encounterTick = tick
    this.push(tick, 'encounter_start', {})
    return true
  }

  get encounterStarted(): boolean {
    return this.encounterTick >= 0
  }

  /** 牵丝次数（"自主"的证据之一）。 */
  get attaches(): number {
    return this.attachCount
  }

  /**
   * 消费一个 tick：从世界事件与输入里抽取埋点。
   * **顺序固定**（先事件后输入），保证同一次回放产出同一条时间线。
   */
  consume(world: World, input: InputFrame): void {
    const tick = world.tick
    if (this.startTick < 0) this.start(tick)

    for (const e of world.events) this.fromSimEvent(tick, world, e)

    if (input.attachPressed) {
      // 真实"牵上了"由 rope-attached 事件确认；这里不记，避免把拖空也算一次
    }

    // 周期位置采样
    if (tick - this.lastPosSample >= POS_SAMPLE_TICKS) {
      this.lastPosSample = tick
      const p = world.player
      this.push(tick, 'pos', {
        px: round2(p.pos.x),
        py: round2(p.pos.y),
        grounded: p.grounded,
      })
    }
  }

  private fromSimEvent(tick: number, world: World, e: SimEvent): void {
    switch (e.kind) {
      case 'rope-attached': {
        this.attachCount++
        const target = world.bodyById(e.target)
        this.push(tick, 'attach', {
          rope: e.rope,
          target: target?.name ?? '?',
          targetX: target === null ? 0 : round2(target.pos.x),
          n: this.attachCount,
        })
        break
      }
      case 'rope-cut':
        this.push(tick, 'cut', { rope: e.rope })
        break
      case 'rope-broken':
        this.push(tick, 'rope_broken', { rope: e.rope, tension: round2(e.tension) })
        break
      case 'killed': {
        const victim = world.bodyById(e.target)
        const killer = world.bodyById(e.by)
        this.push(tick, 'kill', {
          victim: victim?.name ?? '?',
          by: killer?.name ?? '?',
        })
        if (victim?.name === 'jar') this.push(tick, 'jar_broken', {})
        break
      }
      default:
        break
    }
  }

  /** 触发克制提示（石头开始发光）时记一次，只记一次。 */
  markGlow(tick: number): void {
    if (this.events.some((e) => e.kind === 'hint_glow')) return
    this.push(tick, 'hint_glow', { afterSec: this.encounterStarted ? this.sinceEncounter(tick) : -1 })
  }

  /** 进入新的序章段落。分析时用它把时间线切成"他花了多久过第一段"。 */
  markStage(tick: number, name: string): void {
    this.push(tick, 'stage', { name, afterEncounterSec: this.sinceEncounter(tick) })
  }

  /** 某段落开始的秒数（相对试玩开始）；没进过返回 null。 */
  stageStartSec(name: string): number | null {
    for (const e of this.events) {
      if (e.kind === 'stage' && e.name === name) return e.t
    }
    return null
  }

  end(tick: number): void {
    this.push(tick, 'run_end', { totalSec: this.sinceStart(tick) })
  }

  // ── AC-01 ──────────────────────────────────────────

  /**
   * **AC-01 的判定**：遭遇战开始后多少秒用**石块**击杀了墨卒？
   *
   * @returns 秒数（≤ 该值即"60 秒内自主击杀"）；`null` = 未达成
   */
  ac01Seconds(): number | null {
    if (this.encounterTick < 0) return null
    for (const e of this.events) {
      if (e.kind !== 'kill') continue
      if (e.victim !== 'mote') continue
      if (e.by !== 'stone') continue
      const sec = (e.tick - this.encounterTick) / TICK_HZ
      return sec
    }
    return null
  }

  /** AC-01 是否达成（60 秒内、用石块）。 */
  ac01Passed(limitSec = 60): boolean {
    const s = this.ac01Seconds()
    return s !== null && s <= limitSec
  }

  /**
   * 距试玩开始的秒数。
   *
   * **刻意不四舍五入**：`t` 是逐帧复核的依据，"0.03 还是 0.0333" 在判定
   * "60 秒内"时是有区别的。位置坐标才需要 round2（见 `pos` 事件）。
   */
  private sinceStart(tick: number): number {
    return this.startTick < 0 ? 0 : (tick - this.startTick) / TICK_HZ
  }

  private sinceEncounter(tick: number): number {
    return this.encounterTick < 0 ? -1 : (tick - this.encounterTick) / TICK_HZ
  }

  // ── 导出 ────────────────────────────────────────────

  /** 全部事件（只读快照，测试与导出用）。 */
  snapshot(): readonly TelemetryEvent[] {
    return this.events
  }

  /** 事件字段的并集，按首次出现排序 —— 保证 CSV 表头稳定。 */
  private columns(): string[] {
    const cols: string[] = ['t', 'tick', 'kind']
    for (const e of this.events) {
      for (const k of Object.keys(e)) {
        if (!cols.includes(k)) cols.push(k)
      }
    }
    return cols
  }

  /** 一行一个 JSON 对象（JSONL）。这是**主导出格式**。 */
  toJSONL(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n')
  }

  /** CSV —— 直接丢进 Excel 看时间线。 */
  toCSV(): string {
    const cols = this.columns()
    const esc = (v: unknown): string => {
      const s = v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const rows = [cols.join(',')]
    for (const e of this.events) {
      rows.push(cols.map((c) => esc((e as Record<string, unknown>)[c])).join(','))
    }
    return rows.join('\n')
  }

  /** 给创始人看的单行摘要（AC-01 的结论）。 */
  summaryLine(): string {
    const s = this.ac01Seconds()
    const verdict = s === null ? '未达成' : `${s.toFixed(1)}s ${s <= 60 ? '✅ 通过' : '❌ 超过 60s'}`
    return (
      `AC-01 自主石块击杀：${verdict} ｜ 牵丝 ${this.attachCount} 次 ｜ ` +
      `事件 ${this.events.length} 条`
    )
  }

  clear(): void {
    this.events.length = 0
    this.startTick = -1
    this.encounterTick = -1
    this.attachCount = 0
    this.lastPosSample = -1
  }

  private push(tick: number, kind: TelemetryKind, extra: Record<string, number | string | boolean>): void {
    // 容量上限：埋点绝不因为跑太久而吃掉内存（D-042 的隐私与资源纪律）
    if (this.events.length >= this.maxEvents) return
    this.events.push({ t: this.sinceStart(tick), tick, kind, ...extra })
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
