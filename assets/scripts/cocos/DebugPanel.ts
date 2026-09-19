/**
 * 《牵丝》—— M0/M1 调试面板（NFR-MNT-002）。
 *
 * AC-17 要求调试面板显示 **质量 / 速度 / 动量 / 张力**。这里把它做成一个**纯格式化函数**：
 * 输入场景摘要，输出一屏文本。这样面板本身也能被单元测试覆盖，而不需要跑起编辑器。
 *
 * ## 为什么改成读 `summary()` 而不是直接读 M0Scenario 的字段
 *
 * 面板原先直接访问 `scenario.stone` / `scenario.armor`，于是**一加新场景（序章）就编译不过**。
 * 现在它只依赖 `PlayableScene.summary()` 这个窄接口 —— 场景自己决定要暴露什么，
 * 面板只负责排版。加场景不用再动这一层。
 *
 * 面板内容刻意包含 `hash`：它是"客观手感证据"。试玩时觉得"这一下甩得不对"，
 * 把 hash 报出来就能在本地精确复现那一刻。
 */

import type { InputFrame } from '../core/input'
import type { PlayableScene } from '../core/playable'

export interface DebugPanelState {
  fps: number
  /** 当前场景名（用于区分 M0 沙盒与序章）。 */
  sceneName: string
  /** 是否在播放演示脚本（仅 M0 沙盒）。 */
  demoMode: boolean
  demoIndex: number
  demoTicks: number
  showPrediction: boolean
  slowMoScale: number
  /** 本 tick 实际喂给内核的输入。 */
  frame: InputFrame
  ropeBreaks: number
}

const HELP = [
  '── 操作（设计 §3.2 键鼠） ──',
  'A / D                  移动',
  '按住左键拖向目标后松手    牵（拖向空处取消）',
  '按住左键不动            收丝（设计 §7「按住不放」）',
  '滚轮上 / 空格 收丝      滚轮下 / Shift  放丝',
  '右键 / Q / 轻点丝线      断丝',
  '',
  '── 调试热键 ──',
  'R 复位   P 预判线   G 面板   T 慢动作 0.25x',
  'N 丝线数量 1->4（仅 M0）  F1 播放 / F2 停止演示（仅 M0）',
  'M 切换场景：序章（M1） <-> M0 沙盒',
]

export class DebugPanel {
  format(scene: PlayableScene, st: DebugPanelState): string {
    const s = scene.summary()
    const lines: string[] = []

    lines.push(
      `《牵丝》${st.sceneName}  fps=${st.fps.toFixed(0)}${st.slowMoScale < 1 ? '  [慢动作]' : ''}`,
    )
    lines.push(`hash ${scene.world.stateHash()}`)
    lines.push('')

    // 场景摘要：键值逐行排，顺序由场景自己决定
    for (const key of Object.keys(s)) {
      const v = s[key]
      const shown = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v
      lines.push(`${key.padEnd(16)} ${shown}`)
    }

    lines.push('')
    lines.push('─ 输入（本 tick 实际喂给内核的一帧）─')
    lines.push(
      `moveX ${st.frame.moveX.toFixed(2)}  reel ${st.frame.reel}` +
        `  attach ${st.frame.attachPressed ? 'Y' : '-'}  cut ${st.frame.cutRope}`,
    )
    lines.push(
      `累计断弦 ${st.ropeBreaks}   预判线 ${st.showPrediction ? '开' : '关'}` +
        (st.demoMode ? `   演示 ${st.demoIndex}/${st.demoTicks}` : ''),
    )
    lines.push('')
    for (const l of HELP) lines.push(l)
    return lines.join('\n')
  }
}
