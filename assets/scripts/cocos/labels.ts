/**
 * 《牵丝》—— 这一帧要显示哪些小字标签。
 *
 * 第 13 轮实机反馈原话：「我看不到沟在哪里梁柱在哪里，也分不清哪个是石头哪个是罐头哪个是敌人」。
 * 取景的 bug 单独修了（见 `VIEW_ORIGIN_Y`），剩下的"分不清"靠**形状 + 颜色 + 小字**一起解决。
 * 这个文件负责小字那一半。
 *
 * 三条约束：
 *   1. **只给需要辨认的东西贴标签**。地面、墙、天花板不贴——它们不需要名字。
 *   2. 标签的**位置**取自刚体当前坐标，所以它会跟着物体动（陶罐被扔出去时字也跟着飞）。
 *   3. 这是**灰盒阶段的读图辅助**，不是游戏文案：设计 §8.4 的 500 字预算管的是玩家可见文案，
 *      而这一层在 R2 做美术时会整层关掉。`L` 键可以随时关掉它来对照。
 *
 * 本文件认识 `cc`（因为要 `Color`），但不碰任何物理量。
 */

import { Color } from 'cc'
import type { Body } from '../core/body'
import { HUD_BUTTONS, type HudButtonId } from '../core/hud'
import type { PlayableScene } from '../core/playable'
import { worldToScreen } from './Coordinates'
import type { LabelSpec } from './LabelLayer'

const BUTTON_TEXT = new Color(232, 226, 208, 240)
const BUTTON_TEXT_DOWN = new Color(28, 24, 16, 255)
const BODY_TEXT = new Color(226, 226, 226, 235)
const HAZARD_TEXT = new Color(236, 150, 140, 235)
/** 敌人血量数字：满血 / 已掉血 */
const HP_FULL_TEXT = new Color(214, 188, 138, 235)
const HP_LOSS_TEXT = new Color(240, 152, 134, 245)

/** 刚体名字 → 标签文字。**没写的就不贴**（比如地面、墙）。 */
const BODY_LABEL: Record<string, string> = {
  player: '我',
  stone: '石',
  // ⚠️ 两个罐子的标签**故意不一样**：靶子那个不可附着（创始人明确要求"就按你原来的
  // 方案设计成不可吸附"），轻陶罐那个可附着。同名会让人以为"两个都能勾"，
  // 从而再踩一次「丝线附着不上陶罐」的坑。
  jar: '靶',
  pot: '罐',
  mote: '卒',
  mote2: '卒',
  beam: '梁',
  'swing-beam': '悬梁',
  'far-post': '吊桩',
}

/** 标签相对刚体中心的抬高量（米）：太小会压在物体上。 */
const LABEL_LIFT = 1.1

export interface LabelOptions {
  /** 是否显示标签（`L` 键）。 */
  showLabels: boolean
  /** 按下的按钮（渲染成反白）。 */
  isButtonDown: (id: HudButtonId) => boolean
}

export function labelSpecs(sc: PlayableScene, opts: LabelOptions): LabelSpec[] {
  const out: LabelSpec[] = []

  // ── 按钮文字（永远显示：它们是操作入口）──
  for (const b of HUD_BUTTONS) {
    const down = opts.isButtonDown(b.id)
    out.push({
      key: `btn:${b.id}`,
      text: b.label,
      x: b.x + b.w / 2,
      y: b.y + b.h / 2,
      size: 44,
      color: down ? BUTTON_TEXT_DOWN : BUTTON_TEXT,
    })
  }

  if (!opts.showLabels) return out

  // ── 刚体标签 ──
  for (const b of sc.world.bodies) {
    if (b.removed) continue
    const text = BODY_LABEL[b.name]
    if (text === undefined) continue
    const s = worldToScreen({ x: b.pos.x, y: b.pos.y + LABEL_LIFT + halfH(b.shape) })
    out.push({
      key: `body:${b.id}`,
      text,
      x: s.x,
      // 注意：worldToScreen 给的是"窗口 UI 坐标"（左下角为原点），LabelLayer 正好吃这个
      y: s.y,
      size: 26,
      color: b.tag === 'enemy' ? HAZARD_TEXT : BODY_TEXT,
    })

    // 敌人：名字下面再挂一行**血量数字**（第 14 轮，创始人要求"清楚的看到砸了多少血量"）。
    // 分段的血条画在 Graphics 上（Graphics 画不了字），数字在这里。
    // 死亡渐隐期间不再显示（那时候血量已经没有意义了）。
    if (b.tag === 'enemy' && b.maxHp > 0 && b.alive && b.fadeTicks <= 0) {
      const hurt = b.hp < b.maxHp
      out.push({
        key: `hp:${b.id}`,
        text: `${Math.max(0, Math.round(b.hp))}/${Math.round(b.maxHp)}`,
        x: s.x,
        y: worldToScreen({ x: b.pos.x, y: b.pos.y + 0.75 }).y + 6,
        size: 22,
        color: hurt ? HP_LOSS_TEXT : HP_FULL_TEXT,
      })
    }
  }

  // ── 深沟：它不是刚体（是一道空隙），单独标一个 ──
  const pit = pitMarker(sc)
  if (pit !== null) {
    const s = worldToScreen(pit)
    out.push({ key: 'hazard:chasm', text: '深沟', x: s.x, y: s.y, size: 30, color: HAZARD_TEXT })
  }

  return out
}

/**
 * 沟的名字该贴在哪。
 *
 * 判据是"两块地面之间真的有缝"——不去硬编码序章的沟坐标，而是**从地形自己量出来**：
 * 取所有 `ground*` 刚体的 x 区间，找最大的那个空档。M0 沙盒是一整块地面，
 * 于是它返回 `null`、不贴标签 ✓ 这也是"渲染层不写死关卡数据"的延续。
 */
function pitMarker(sc: PlayableScene): { x: number; y: number } | null {
  const spans: { left: number; right: number }[] = []
  for (const b of sc.world.bodies) {
    if (b.kind !== 'static' || b.removed) continue
    if (!b.name.includes('ground')) continue
    if (b.shape.kind !== 'aabb') continue
    spans.push({ left: b.pos.x - b.shape.hw, right: b.pos.x + b.shape.hw })
  }
  if (spans.length < 2) return null

  spans.sort((a, b) => a.left - b.left)
  let bestGap = 0
  let bestX = 0
  for (let i = 1; i < spans.length; i++) {
    const gap = spans[i]!.left - spans[i - 1]!.right
    if (gap > bestGap) {
      bestGap = gap
      bestX = (spans[i]!.left + spans[i - 1]!.right) / 2
    }
  }
  if (bestGap < 0.5) return null
  // 贴在沟口上方一点点，不要沉到沟里
  return { x: bestX, y: 1.2 }
}

function halfH(shape: Body['shape']): number {
  return shape.kind === 'aabb' ? shape.hh : shape.radius
}
