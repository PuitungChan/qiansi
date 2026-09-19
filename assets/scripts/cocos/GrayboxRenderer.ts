/**
 * 《牵丝》—— M0 灰盒渲染器。
 *
 * 职责边界（这是刻意的架构约束，见 DECISIONS D-017）：
 *   本文件**只读**模拟状态并画图，从不修改任何物理量。
 *   任何"渲染顺手改一下状态"的写法都会破坏 AC-05 的确定性。
 *
 * 视觉规则来自 `docs/牵丝_画面视觉规范.md`，但 M0 阶段**全灰盒、零美术**（D-012），
 * 因此这里只保留两条与玩法强相关的规则：
 *   1. 画面中除金线外全部低饱和 —— 灵丝必须是唯一焦点
 *   2. 张力用颜色与抖动表达（设计 §2.4），玩家不看 UI 也能读出"离断弦还有多远"
 */

import { Color, Graphics } from 'cc'
import type { Shape } from '../core/body'
import { chainPoints } from '../core/rope'
import type { M0Scenario } from '../core/scene_m0'
import { metersToPx, worldToLocal } from './Coordinates'

const C = {
  bg: new Color(24, 24, 26, 255),
  ground: new Color(58, 58, 62, 255),
  wall: new Color(46, 46, 50, 255),
  ceiling: new Color(46, 46, 50, 255),
  player: new Color(216, 216, 216, 255),
  playerAir: new Color(150, 170, 190, 255),
  stone: new Color(168, 168, 172, 255),
  armor: new Color(138, 138, 144, 255),
  armorHurt: new Color(180, 120, 120, 255),
  armorDead: new Color(70, 70, 74, 255),
  aim: new Color(122, 106, 58, 200),
  hudIdle: new Color(138, 138, 144, 255),
  hudUsed: new Color(232, 196, 106, 255),
  hudCooling: new Color(90, 90, 96, 255),
  panelBg: new Color(0, 0, 0, 170),
  panelText: new Color(220, 220, 220, 255),
  predict: new Color(232, 196, 106, 255),
} as const

/** 张力四档配色（设计 §2.4）。返回 [颜色, 抖动像素]。 */
function tensionStyle(ratio: number, tick: number): { color: Color; jitter: number } {
  if (ratio >= 0.95) return { color: new Color(255, 255, 255, 255), jitter: 0 }
  if (ratio >= 0.85) {
    // 剧烈抖动：用确定性的正弦而不是随机数——渲染也不许引入不确定性
    return {
      color: new Color(255, 215, 106, 255),
      jitter: 1.5 * Math.sin(tick * 1.7),
    }
  }
  if (ratio >= 0.6) return { color: new Color(232, 196, 106, 255), jitter: 0 }
  return { color: new Color(138, 106, 32, 255), jitter: 0 }
}

export interface RenderOptions {
  /** 是否在牵住物体时画预判线（FR-UI-003）。调试面板可关。 */
  showPrediction: boolean
  /** 是否显示调试面板。 */
  showDebug: boolean
  /** 当前瞄准点（世界坐标），拖拽牵丝时用来画瞄准线。 */
  aimPoint: { x: number; y: number } | null
  /** 预判线采样点（世界坐标），由 Bootstrap 用 core/aim 算好后传入。 */
  prediction: { x: number; y: number }[]
}

export class GrayboxRenderer {
  /** 把整个房间画到 Graphics 上。每帧先 clear。 */
  draw(g: Graphics, sc: M0Scenario, opts: RenderOptions): void {
    g.clear()

    this.drawBackground(g)
    this.drawTerrain(g, sc)
    this.drawBodies(g, sc)
    this.drawRopes(g, sc)
    if (opts.aimPoint !== null) this.drawAim(g, sc, opts.aimPoint)
    if (opts.showPrediction) this.drawPrediction(g, sc, opts.prediction)
    this.drawHud(g, sc)
  }

  /**
   * 全屏底色。**刻意画得比屏幕大**（8000×6000 px，覆盖到 21:9 都够）。
   *
   * 为什么需要它：Canvas 自带相机的 `clearFlags` 默认只清深度、**不清颜色**
   * （实测场景里是 `6 = DEPTH|STENCIL`），背景色其实是场景里那台 3D `Main Camera`
   * 提供的。2D 灰盒用不到那台相机，一旦删掉就没人清屏了。
   * 自己铺一层底，画面就与"场景里有没有别的相机"彻底解耦。
   */
  private drawBackground(g: Graphics): void {
    g.fillColor = C.bg
    g.rect(-4000, -3000, 8000, 6000)
    g.fill()
  }

  // ── 地形 ────────────────────────────────────────────

  private drawTerrain(g: Graphics, sc: M0Scenario): void {
    for (const b of sc.world.bodies) {
      if (b.kind !== 'static') continue
      const fill =
        b.name === 'ground' ? C.ground : b.name === 'ceiling' ? C.ceiling : C.wall
      this.fillAabb(g, b.pos.x, b.pos.y, halfW(b.shape), halfH(b.shape), fill)
    }
  }

  private drawBodies(g: Graphics, sc: M0Scenario): void {
    // 主角：着地/离地用不同色调，让"谁是主动方"一眼可读（设计 §2.2）
    const p = sc.player
    this.fillAabb(g, p.pos.x, p.pos.y, halfW(p.shape), halfH(p.shape), p.grounded ? C.player : C.playerAir)

    // 石块
    const s = sc.stone
    this.fillCircle(g, s.pos.x, s.pos.y, radiusOf(s.shape), C.stone)

    // 墨甲：血量用颜色深浅表达，不显示血条（FR-UI-005 / FR-CBT-008）
    const a = sc.armor
    const aFill = !a.alive ? C.armorDead : a.hp < a.maxHp ? C.armorHurt : C.armor
    this.fillAabb(g, a.pos.x, a.pos.y, halfW(a.shape), halfH(a.shape), aFill)
  }

  // ── 丝线 ────────────────────────────────────────────

  private drawRopes(g: Graphics, sc: M0Scenario): void {
    const tick = sc.world.tick
    const maxT = sc.world.config.tensionMax
    for (const r of sc.world.ropes) {
      if (r.state !== 'attached') continue
      const chain = sc.world.chains[r.index]
      if (chain === null) continue

      const ratio = maxT > 0 ? r.tension / maxT : 0
      const style = tensionStyle(ratio, tick)
      const pts = chainPoints(chain)

      // 线宽随张力变细变亮（设计 §8.1「越紧越细越亮」）。
      // 宽度整体调粗（v0.2.0 是 1.5–5px）：实机反馈「丝线太细了」，
      // 灰盒阶段的金线既是画面焦点、又是**唯一的 HUD**，必须一眼看得见。
      g.lineWidth = Math.max(4, 11 - 6 * Math.min(ratio / 0.95, 1))
      g.strokeColor = style.color

      const first = worldToLocal(pts[0]!)
      g.moveTo(first.x + style.jitter, first.y)
      for (let i = 1; i < pts.length; i++) {
        const q = worldToLocal(pts[i]!)
        g.lineTo(q.x, q.y + style.jitter)
      }
      g.stroke()

      // 端点亮一下，帮助玩家看清"丝在哪"
      const end = worldToLocal(pts[pts.length - 1]!)
      g.fillColor = style.color
      g.circle(end.x, end.y, 5)
      g.fill()

      // 丝在主角手上的那头也点一下，让"丝从哪来"一目了然
      const startPt = worldToLocal(pts[0]!)
      g.circle(startPt.x, startPt.y, 5)
      g.fill()
    }
  }

  /** 拖拽瞄准时的直线（黑色半透明金线，不必等连接成功）。 */
  private drawAim(g: Graphics, sc: M0Scenario, aim: { x: number; y: number }): void {
    const from = worldToLocal({
      x: sc.player.pos.x,
      y: sc.player.pos.y + 0.4,
    })
    const to = worldToLocal(aim)
    g.lineWidth = 2
    g.strokeColor = C.aim
    g.moveTo(from.x, from.y)
    g.lineTo(to.x, to.y)
    g.stroke()
  }

  /** 预判线：金色点线（FR-UI-003）。已由 core/aim 按"假设此刻断丝"算好。 */
  private drawPrediction(
    g: Graphics,
    sc: M0Scenario,
    prediction: { x: number; y: number }[],
  ): void {
    if (prediction.length === 0) return
    g.fillColor = C.predict
    for (const p of prediction) {
      const q = worldToLocal(p)
      g.circle(q.x, q.y, 2.5)
      g.fill()
    }
  }

  // ── HUD ─────────────────────────────────────────────

  /**
   * 丝线数量指示（FR-UI-001）：左上 4 枚圆点。
   * 已用 = 填充金色，未用 = 空心金环，重凝中 = 暗色实心。
   * 右上另画一条张力条 —— 它是调试辅助，R1 的正式 UI 只有圆点 + 听感。
   */
  private drawHud(g: Graphics, sc: M0Scenario): void {
    for (const d of sc.world.ropeDisplay()) {
      const cx = 30 + d.index * 34
      const cy = 1035
      if (d.state === 'attached') {
        g.fillColor = C.hudUsed
        g.circle(cx, cy, 8)
        g.fill()
      } else if (d.state === 'recovering') {
        g.fillColor = C.hudCooling
        g.circle(cx, cy, 8)
        g.fill()
      } else {
        g.lineWidth = 3
        g.strokeColor = C.hudIdle
        g.circle(cx, cy, 8)
        g.stroke()
      }
    }

    // 张力条（调试用；正式版按设计 §8.4 应改为纯听觉 + 线宽反馈）
    const r = sc.world.ropes[0]
    if (r !== undefined && r.state === 'attached') {
      const ratio = Math.min(r.tension / sc.world.config.tensionMax, 1)
      const w = 220
      const x = 1660
      const y = 1030
      g.fillColor = new Color(0, 0, 0, 140)
      g.rect(x, y, w, 10)
      g.fill()
      const style = tensionStyle(ratio, sc.world.tick)
      g.fillColor = style.color
      g.rect(x, y, w * ratio, 10)
      g.fill()
      // 85% 濒断刻度（设计 §2.4 / FR-UI-002 的 R2 版会有专门刻度）
      g.strokeColor = new Color(255, 255, 255, 120)
      g.lineWidth = 1
      g.moveTo(x + w * 0.85, y - 2)
      g.lineTo(x + w * 0.85, y + 12)
      g.stroke()
    }
  }

  // ── 基元 ────────────────────────────────────────────

  private fillAabb(g: Graphics, cx: number, cy: number, hw: number, hh: number, color: Color): void {
    const p = worldToLocal({ x: cx - hw, y: cy - hh })
    g.fillColor = color
    g.rect(p.x, p.y, metersToPx(hw * 2), metersToPx(hh * 2))
    g.fill()
  }

  private fillCircle(g: Graphics, cx: number, cy: number, r: number, color: Color): void {
    const p = worldToLocal({ x: cx, y: cy })
    g.fillColor = color
    g.circle(p.x, p.y, metersToPx(r))
    g.fill()
  }
}

export { tensionStyle }

function halfW(shape: Shape): number {
  return shape.kind === 'aabb' ? shape.hw : shape.radius
}
function halfH(shape: Shape): number {
  return shape.kind === 'aabb' ? shape.hh : shape.radius
}
function radiusOf(shape: Shape): number {
  return shape.kind === 'circle' ? shape.radius : shape.hw
}
