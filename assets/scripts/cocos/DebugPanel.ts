/**
 * 《牵丝》—— M0 调试面板（NFR-MNT-002）。
 *
 * AC-17 要求调试面板显示 **质量 / 速度 / 动量 / 张力**。这里把它做成一个**纯格式化函数**：
 * 输入场景状态，输出一屏文本。这样面板本身也能被单元测试覆盖，而不需要跑起编辑器。
 *
 * 面板内容刻意包含 `hash` 一栏：M0 阶段唯一的"客观手感证据"就是**回放哈希**。
 * 你试玩时如果觉得"这次甩得不对"，把 hash 报出来，我就能在本地精确复现那一刻。
 */

import type { InputFrame } from '../core/input'
import type { M0Scenario } from '../core/scene_m0'
import { MAX_ROPES } from '../core/constants'

export interface DebugPanelState {
  fps: number
  /** 当前是否在播放演示脚本。 */
  demoMode: boolean
  /** 演示播放进度（第几帧 / 总帧数）。 */
  demoIndex: number
  demoTicks: number
  /** 预判线开关。 */
  showPrediction: boolean
  /** 慢动作倍数。 */
  slowMoScale: number
  /** 本 tick 实际喂给内核的输入。 */
  frame: InputFrame
  /** 累计超限断弦次数。 */
  ropeBreaks: number
}

const HELP = [
  '── 操作（设计 §3.2 键鼠） ──',
  'A / D        移动',
  '按住左键拖向目标后松手   牵（拖向空处取消）',
  '滚轮上 / 空格           收丝',
  '滚轮下 / Shift          放丝',
  '点击丝线 / Q            断丝',
  '',
  '── 调试热键 ──',
  'R   复位场景        P  预判线开关',
  'G   面板开关        T  慢动作 0.25×',
  'N   丝线数量 1→4    F1 播放演示 / F2 停止',
]

export class DebugPanel {
  format(sc: M0Scenario, st: DebugPanelState): string {
    const w = sc.world
    const r0 = w.ropes[0]
    const ratio = r0 !== undefined && w.config.tensionMax > 0 ? r0.tension / w.config.tensionMax : 0

    const lines: string[] = []
    lines.push(`《牵丝》M0 灰盒  fps=${st.fps.toFixed(0)}  tick=${w.tick}${st.slowMoScale < 1 ? '  [慢动作]' : ''}`)
    lines.push(`hash ${w.stateHash()}`)
    lines.push('')
    lines.push('─ 主角 ─')
    lines.push(
      `质量 ${sc.player.mass.toFixed(sc.player.grounded ? 0 : 2)}` +
        `   ${sc.player.grounded ? '着地 → 等效 ∞（锚点）' : '离地 → 0.5（被甩方）'}`,
    )
    lines.push(
      `位置 (${sc.player.pos.x.toFixed(2)}, ${sc.player.pos.y.toFixed(2)})` +
        `  速度 (${sc.player.vel.x.toFixed(2)}, ${sc.player.vel.y.toFixed(2)})`,
    )
    lines.push(
      `动量 ${mag(sc.player.momentum).toFixed(2)}  动能 ${sc.player.kineticEnergy.toFixed(2)}`,
    )
    lines.push('')
    lines.push('─ 石块 ─')
    lines.push(
      `位置 (${sc.stone.pos.x.toFixed(2)}, ${sc.stone.pos.y.toFixed(2)})` +
        `  速度 ${Math.hypot(sc.stone.vel.x, sc.stone.vel.y).toFixed(2)} m/s`,
    )
    lines.push(
      `动量 ${mag(sc.stone.momentum).toFixed(2)}  动能 ${sc.stone.kineticEnergy.toFixed(2)}`,
    )
    lines.push('')
    lines.push('─ 丝线 ─')
    lines.push(
      `状态 ${r0?.state ?? '-'}  长度 ${(r0?.length ?? 0).toFixed(2)}m` +
        `  目标 ${(r0?.targetLength ?? 0).toFixed(2)}m`,
    )
    lines.push(
      `张力 ${(r0?.tension ?? 0).toFixed(1)} N  占额定 ${(ratio * 100).toFixed(0)}%` +
        `  峰值 ${(r0?.peakTension ?? 0).toFixed(1)} N`,
    )
    lines.push(`重凝剩余 ${((r0?.recongealRemaining ?? 0) * 1000).toFixed(0)} ms  累计断弦 ${st.ropeBreaks}`)
    lines.push('')
    lines.push('─ 墨甲 ─')
    lines.push(
      `HP ${sc.armor.hp.toFixed(1)} / ${sc.armor.maxHp}` +
        `   ${sc.armor.alive ? '存活' : '已击杀（M0 不实现死亡流程）'}`,
    )
    lines.push(
      `位置 (${sc.armor.pos.x.toFixed(2)}, ${sc.armor.pos.y.toFixed(2)})  弱点 ${sc.armor.weakness}`,
    )
    lines.push('')
    lines.push('─ 输入（本 tick 实际喂给内核的一帧）─')
    lines.push(
      `moveX ${st.frame.moveX.toFixed(2)}  reel ${st.frame.reel}` +
        `  attach ${st.frame.attachPressed ? 'Y' : '-'}  cut ${st.frame.cutRope}`,
    )
    lines.push(
      `演示 ${st.demoMode ? `播放中 ${st.demoIndex}/${st.demoTicks}` : '关闭'}` +
        `   预判线 ${st.showPrediction ? '开' : '关'}   丝位上限 ${MAX_ROPE_COUNT(cfg(sc))}`,
    )
    lines.push('')
    for (const l of HELP) lines.push(l)
    return lines.join('\n')
  }
}

function mag(v: { x: number; y: number }): number {
  return Math.hypot(v.x, v.y)
}

function cfg(sc: M0Scenario): number {
  return sc.world.ropes.length
}

function MAX_ROPE_COUNT(n: number): string {
  return `${n}（上限 ${MAX_ROPES}）`
}
