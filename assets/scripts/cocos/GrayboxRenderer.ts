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
import type { Body, Shape } from '../core/body'
import { M0_ROOM_H, ROPE_LEN_MAX, VIEW_H, VIEW_ORIGIN_Y, VIEW_W } from '../core/constants'
import { HUD_BUTTONS, type HudButtonId } from '../core/hud'
import type { PlayableScene } from '../core/playable'
import { chainPoints } from '../core/rope'
import { metersToPx, uiToLocal, worldToLocal } from './Coordinates'

const C = {
  bg: new Color(24, 24, 26, 255),
  /** 深沟内部：比背景更黑，读起来是"没有底" */
  void: new Color(6, 6, 8, 255),
  ground: new Color(58, 58, 62, 255),
  /** 地面顶面的一条亮边：让"哪里能站"一眼可读 */
  groundTop: new Color(96, 96, 102, 255),
  wall: new Color(46, 46, 50, 255),
  ceiling: new Color(46, 46, 50, 255),
  /** 悬吊物连到天花板的那条虚线（比墙略亮一点，读得出"吊着"） */
  hang: new Color(72, 72, 78, 255),
  /** 可附着的结构（梁柱 / 悬吊横梁 / 吊桩）：暖一档，和地形分开 */
  anchorable: new Color(86, 78, 62, 255),
  /** 可附着的物体（石块 / 陶罐）的高亮描边 */
  anchorEdge: new Color(160, 142, 96, 200),
  player: new Color(216, 216, 216, 255),
  playerAir: new Color(150, 170, 190, 255),
  playerEye: new Color(40, 40, 46, 255),
  stone: new Color(168, 168, 172, 255),
  stoneEdge: new Color(120, 120, 126, 255),
  /** 易碎场景物（陶罐）：暖赭色，形状上再加一个"罐口" */
  fragile: new Color(186, 150, 104, 255),
  fragileEdge: new Color(136, 104, 66, 255),
  /** 敌人：墨色，带两点"眼睛"——一眼和石头分开 */
  armor: new Color(104, 84, 116, 255),
  armorHurt: new Color(168, 96, 96, 255),
  armorDead: new Color(58, 52, 62, 255),
  armorEye: new Color(242, 236, 226, 255),
  aim: new Color(122, 106, 58, 200),
  aimOk: new Color(150, 220, 140, 235),
  aimBad: new Color(210, 130, 120, 200),
  /** 射程圈：告诉玩家"丝最多够到这么远" */
  range: new Color(96, 92, 74, 150),
  hudIdle: new Color(138, 138, 144, 255),
  hudUsed: new Color(232, 196, 106, 255),
  hudCooling: new Color(90, 90, 96, 255),
  hudButton: new Color(0, 0, 0, 120),
  hudButtonDown: new Color(232, 196, 106, 150),
  hudButtonEdge: new Color(150, 146, 136, 170),
  panelBg: new Color(0, 0, 0, 170),
  panelText: new Color(220, 220, 220, 255),
  predict: new Color(232, 196, 106, 255),
  flying: new Color(232, 196, 106, 190),
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
  /** 当前瞄准点（世界坐标），按住瞄准时用来画瞄准线与附着点。 */
  aimPoint: { x: number; y: number } | null
  /** 预判线采样点（世界坐标），由 Bootstrap 用 core/aim 算好后传入。 */
  prediction: { x: number; y: number }[]
  /** 需要"发光提示"的刚体 id（-1 = 无）。见 PlayableScene.glowBodyId()。 */
  glowBodyId: number
  /** 哪些按钮正被按下（画按下态）。 */
  isButtonDown?: (id: HudButtonId) => boolean
}

export class GrayboxRenderer {
  /** 把整个房间画到 Graphics 上。每帧先 clear。 */
  draw(g: Graphics, sc: PlayableScene, opts: RenderOptions): void {
    g.clear()

    this.drawBackground(g)
    this.drawChasm(g, sc)
    this.drawTerrain(g, sc)
    this.drawBodies(g, sc)
    if (opts.glowBodyId >= 0) this.drawGlow(g, sc, opts.glowBodyId)
    this.drawRopes(g, sc)
    if (opts.aimPoint !== null) this.drawAim(g, sc, opts.aimPoint)
    if (opts.showPrediction) this.drawPrediction(g, sc, opts.prediction)
    this.drawHud(g, sc, opts)
  }

  /**
   * **深沟**：把地面之间的空档画成"没有底的黑洞"。
   *
   * 第 13 轮实机反馈「我看不到沟在哪里」，根因有两个：
   *   ① 取景把 y<0 整个切在屏幕外（已由 `VIEW_ORIGIN_Y` 修掉）；
   *   ② 就算看得见，沟的位置也只是"背景色"，与"墙外面"长得一样。
   * 所以这里主动把它画成**比背景更黑**、并给两侧崖壁描一条边、再画几条渐隐的深度线。
   *
   * 沟的位置**从地形量出来**（两块 ground 之间的空档），不硬编码关卡坐标——
   * M0 沙盒是一整块地面，于是这里什么都不画 ✓。
   */
  private drawChasm(g: Graphics, sc: PlayableScene): void {
    const gap = groundGap(sc)
    if (gap === null) return

    const bottom = VIEW_ORIGIN_Y
    const leftTop = worldToLocal({ x: gap.left, y: 0 })
    const rightTop = worldToLocal({ x: gap.right, y: 0 })
    const bottomLeft = worldToLocal({ x: gap.left, y: bottom })

    // 1) 洞：纯黑
    g.fillColor = C.void
    g.rect(leftTop.x, bottomLeft.y, rightTop.x - leftTop.x, leftTop.y - bottomLeft.y)
    g.fill()

    // 2) 两侧崖壁的亮边：强调"这里断掉了"
    g.lineWidth = 3
    g.strokeColor = C.groundTop
    g.moveTo(leftTop.x, leftTop.y)
    g.lineTo(leftTop.x, bottomLeft.y)
    g.moveTo(rightTop.x, rightTop.y)
    g.lineTo(rightTop.x, bottomLeft.y)
    g.stroke()

    // 3) 深度线：越深越淡，给一个"往下很深"的读数
    for (let i = 1; i <= 3; i++) {
      const y = leftTop.y - i * 70
      if (y < bottomLeft.y) break
      g.lineWidth = 1
      g.strokeColor = new Color(80, 80, 86, Math.max(24, 90 - i * 22))
      g.moveTo(leftTop.x, y)
      g.lineTo(rightTop.x, y)
      g.stroke()
    }
  }

  /**
   * **克制提示**：给一个刚体套一层缓慢脉动的金环（设计 §7「石头会微微发光」）。
   *
   * 它存在的意义是"**不弹文字**"——所以必须做得足够轻，轻到玩家以为是自己注意到的。
   * 因此：只有描边没有填充、透明度低、脉动周期长（≈2 秒一次）。
   * 相位由 `tick` 推出来，**不用 wall-clock**，否则回放与录屏对不上。
   */
  private drawGlow(g: Graphics, sc: PlayableScene, id: number): void {
    const b = sc.world.bodyById(id)
    if (b === null || b.removed) return
    const pulse = 0.5 + 0.5 * Math.sin(sc.world.tick * 0.055)
    const base = b.shape.kind === 'circle' ? b.shape.radius : b.shape.hw
    const c = worldToLocal(b.pos)

    g.lineWidth = 1.5 + 2 * pulse
    g.strokeColor = new Color(232, 196, 106, Math.round(50 + 90 * pulse))
    g.circle(c.x, c.y, metersToPx(base + 0.22 + 0.12 * pulse))
    g.stroke()

    g.lineWidth = 1
    g.strokeColor = new Color(232, 196, 106, Math.round(20 + 45 * pulse))
    g.circle(c.x, c.y, metersToPx(base + 0.55 + 0.25 * pulse))
    g.stroke()
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

  private drawTerrain(g: Graphics, sc: PlayableScene): void {
    for (const b of sc.world.bodies) {
      if (b.kind !== 'static' || b.removed) continue
      // 按**名字语义**上色：地面/沟底用亮一档的灰，墙与天花板暗一档。
      // 不按具体名字硬编码，这样加新地形（深沟、平台）不用改渲染层。
      const isFloor = b.name.includes('ground') || b.name.includes('floor')
      let fill: Color = isFloor ? C.ground : C.wall
      // **可附着的结构**单独配色（梁柱 / 悬吊横梁 / 吊桩）。
      // 序章 8:00 那一段的全部玩法就是"找到能勾的东西"，它们必须一眼可辨。
      if (b.anchorable) fill = C.anchorable

      // ── 悬吊物：画一条细线连到天花板 ──
      //
      // 「悬吊横梁」「对岸吊桩」都是**悬在空中的**静态结构。灰盒里如果只画一个方块，
      // 玩家看到的是"浮在空中的石头"，读不出"这是可以勾住的吊点"。
      // 一条竖线花不了几个像素，却把它变成"吊在那儿的"。
      // 判据同样是名字语义（swing/post），不硬编码具体 id。
      if (b.name.includes('swing') || b.name.includes('post')) {
        this.strokeHangLine(g, b.pos.x, b.pos.y + halfH(b.shape))
      }

      this.fillAabb(g, b.pos.x, b.pos.y, halfW(b.shape), halfH(b.shape), fill)

      // 可附着结构再加一条亮边，和"只是地形"的东西彻底分开
      if (b.anchorable) this.strokeAabb(g, b.pos.x, b.pos.y, halfW(b.shape), halfH(b.shape), C.anchorEdge)
      // 地面顶面一条亮边：哪里能站，一眼可读
      if (isFloor) {
        const top = worldToLocal({ x: b.pos.x - halfW(b.shape), y: b.pos.y + halfH(b.shape) })
        g.lineWidth = 2
        g.strokeColor = C.groundTop
        g.moveTo(top.x, top.y)
        g.lineTo(top.x + metersToPx(halfW(b.shape) * 2), top.y)
        g.stroke()
      }
    }
  }

  /** 从 (x, y) 往上画一条虚线到天花板。虚线节距固定，不含时间，录屏可复现。 */
  private strokeHangLine(g: Graphics, x: number, y: number): void {
    const from = worldToLocal({ x, y })
    const to = worldToLocal({ x, y: M0_ROOM_H })
    g.strokeColor = C.hang
    g.lineWidth = 2
    for (let py = from.y; py < to.y; py += 16) {
      g.moveTo(from.x, py)
      g.lineTo(from.x, Math.min(py + 8, to.y))
    }
    g.stroke()
  }

  /**
   * 动态刚体。**每一类都有独特的外形**，不只靠颜色——
   * 第 13 轮实机反馈「分不清哪个是石头哪个是罐头哪个是敌人」。
   *
   * | 物体 | 外形 |
   * |---|---|
   * | 主角 | 亮方块 + 一个"朝向眼" |
   * | 石块 | 灰圆 + 内圈（石头） |
   * | 陶罐 | 赭色圆 + 上方一个小"罐口" |
   * | 墨卒 | 墨色圆 + 两点白"眼睛"（活的才画） |
   */
  private drawBodies(g: Graphics, sc: PlayableScene): void {
    for (const b of sc.world.bodies) {
      if (b.kind === 'static' || b.removed) continue
      const fill = colorOf(b)

      if (b.tag === 'player') {
        this.fillAabb(g, b.pos.x, b.pos.y, halfW(b.shape), halfH(b.shape), fill)
        this.strokeAabb(g, b.pos.x, b.pos.y, halfW(b.shape), halfH(b.shape), C.playerEye)
        // 朝向眼：一小块深色，贴在"面朝哪边"上（用速度方向，静止时朝右）
        const face = b.vel.x < -0.2 ? -1 : 1
        const eye = worldToLocal({ x: b.pos.x + face * halfW(b.shape) * 0.45, y: b.pos.y + 0.25 })
        g.fillColor = C.playerEye
        g.circle(eye.x, eye.y, 5)
        g.fill()
        continue
      }

      if (b.shape.kind === 'circle') {
        this.fillCircle(g, b.pos.x, b.pos.y, b.shape.radius, fill)
        if (b.name.includes('jar') || b.name.includes('pot')) {
          // 罐口：小圆台，和"石头"彻底分开
          const neck = worldToLocal({ x: b.pos.x, y: b.pos.y + b.shape.radius * 0.95 })
          g.fillColor = C.fragileEdge
          g.rect(neck.x - 6, neck.y, 12, 10)
          g.fill()
          g.lineWidth = 2
          g.strokeColor = C.fragileEdge
          g.circle(neck.x, neck.y - metersToPx(b.shape.radius) + 1, metersToPx(b.shape.radius))
          g.stroke()
        } else if (b.tag === 'enemy') {
          // 眼睛：一眼认出"这是活的、这是敌人"
          if (b.alive) {
            const l = worldToLocal({ x: b.pos.x - 0.13, y: b.pos.y + 0.06 })
            const r = worldToLocal({ x: b.pos.x + 0.13, y: b.pos.y + 0.06 })
            g.fillColor = C.armorEye
            g.circle(l.x, l.y, 4)
            g.fill()
            g.circle(r.x, r.y, 4)
            g.fill()
          }
          g.lineWidth = 2
          g.strokeColor = C.armorDead
          g.circle(worldToLocal(b.pos).x, worldToLocal(b.pos).y, metersToPx(b.shape.radius))
          g.stroke()
        } else {
          // 石块：内圈让它看起来是"实心的石头"
          const c = worldToLocal(b.pos)
          g.lineWidth = 2
          g.strokeColor = C.stoneEdge
          g.circle(c.x, c.y, metersToPx(b.shape.radius) * 0.55)
          g.stroke()
        }
        // 可附着物体加一圈淡金描边：告诉玩家"这个能勾"
        if (b.anchorable) {
          const c = worldToLocal(b.pos)
          g.lineWidth = 3
          g.strokeColor = C.anchorEdge
          g.circle(c.x, c.y, metersToPx(b.shape.radius) + 4)
          g.stroke()
        }
        continue
      }

      this.fillAabb(g, b.pos.x, b.pos.y, b.shape.hw, b.shape.hh, fill)
    }
  }

  // ── 丝线 ────────────────────────────────────────────

  private drawRopes(g: Graphics, sc: PlayableScene): void {
    const tick = sc.world.tick
    const maxT = sc.world.config.tensionMax
    for (const r of sc.world.ropes) {
      // ── 飞行中的丝（第 13 轮新增）──
      //
      // 创始人：「我想看到发射丝线从角色射到物体上的一个动态过程，而不是瞬间出现一条相连的线。」
      // 所以它不是"一条已经连上的线"，而是**一根正在射出去的丝**：
      // 细、直、偏暗，头上有一个亮点，看起来就是在飞。
      if (r.state === 'flying') {
        const from = worldToLocal(r.flyFrom)
        const tip = worldToLocal(r.flyTip)
        g.lineWidth = 3
        g.strokeColor = C.flying
        g.moveTo(from.x, from.y)
        g.lineTo(tip.x, tip.y)
        g.stroke()
        g.fillColor = C.hudUsed
        g.circle(tip.x, tip.y, 6)
        g.fill()
        continue
      }

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

  /**
   * 瞄准时的界面（第 13 轮的新规则）：**松手点即附着点**。
   *
   * 三样东西缺一不可，因为"松手在空白处不附着"这条规则必须**按下去就能看见**，
   * 而不是松手才知道：
   *   ① 从主角到瞄准点的线；
   *   ② **射程圈**（半径 = 丝长上限）——丝是有射程的，圈外连不上；
   *   ③ **附着点标记**：命中时在吸附点上画一个绿环并把该物体描亮，落空时画红叉。
   */
  private drawAim(g: Graphics, sc: PlayableScene, aim: { x: number; y: number }): void {
    const from = worldToLocal({
      x: sc.player.pos.x,
      y: sc.player.pos.y + 0.4,
    })

    // 射程圈
    const center = worldToLocal(sc.player.pos)
    g.lineWidth = 1
    g.strokeColor = C.range
    g.circle(center.x, center.y, metersToPx(ROPE_LEN_MAX))
    g.stroke()

    const to = worldToLocal(aim)
    g.lineWidth = 2
    g.strokeColor = C.aim
    g.moveTo(from.x, from.y)
    g.lineTo(to.x, to.y)
    g.stroke()

    // 这一枪能不能连上？
    const preview = sc.world.aimPreview(sc.player, aim)
    if (preview.valid) {
      const p = worldToLocal(preview.point)
      g.lineWidth = 3
      g.strokeColor = C.aimOk
      g.circle(p.x, p.y, 10)
      g.stroke()
      g.fillColor = C.aimOk
      g.circle(p.x, p.y, 4)
      g.fill()
      // 把目标物体也描一圈，明确"你会挂在这个东西上"
      const target = sc.world.bodyById(preview.targetId)
      if (target !== null) this.strokeShape(g, target, C.aimOk)
    } else {
      g.lineWidth = 3
      g.strokeColor = C.aimBad
      g.moveTo(to.x - 9, to.y - 9)
      g.lineTo(to.x + 9, to.y + 9)
      g.moveTo(to.x + 9, to.y - 9)
      g.lineTo(to.x - 9, to.y + 9)
      g.stroke()
    }
  }

  /** 预判线：金色点线（FR-UI-003）。已由 core/aim 按"假设此刻断丝"算好。 */
  private drawPrediction(
    g: Graphics,
    sc: PlayableScene,
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
   * HUD。
   *
   * ⚠️ **坐标口径**：`Graphics` 画在节点局部坐标里（画布中心为原点，
   * x ∈ [−960, 960]、y ∈ [−540, 540]）。而 HUD 的布局数字（`core/hud.ts` 里的按钮、
   * 下面的圆点位置）用的是"左下角为原点"的 UI 口径。两者混用会把 HUD 画到屏幕外——
   * **这个 bug 真的存在过**：丝位圆点与张力条一直把 UI 坐标当局部坐标用，
   * 于是画在了 y ≈ 1035（屏幕外），玩家从来没见过它。
   * 现在统一走 `uiToLocal()`。
   */
  private drawHud(g: Graphics, sc: PlayableScene, opts: RenderOptions): void {
    // ── 屏幕按钮（第 13 轮的输入方案：左移动 + 右动作）──
    for (const b of HUD_BUTTONS) {
      const p = uiToLocal(b.x, b.y)
      const down = opts.isButtonDown?.(b.id) ?? false
      g.fillColor = down ? C.hudButtonDown : C.hudButton
      g.rect(p.x, p.y, b.w, b.h)
      g.fill()
      g.lineWidth = 2
      g.strokeColor = down ? C.hudUsed : C.hudButtonEdge
      g.rect(p.x, p.y, b.w, b.h)
      g.stroke()
    }

    // ── 丝位指示（FR-UI-001）──
    for (const d of sc.world.ropeDisplay()) {
      const p = uiToLocal(30 + d.index * 34, VIEW_H - 45)
      if (d.state === 'attached') {
        g.fillColor = C.hudUsed
        g.circle(p.x, p.y, 8)
        g.fill()
      } else if (d.state === 'flying') {
        g.fillColor = C.flying
        g.circle(p.x, p.y, 8)
        g.fill()
      } else if (d.state === 'recovering') {
        g.fillColor = C.hudCooling
        g.circle(p.x, p.y, 8)
        g.fill()
      } else {
        g.lineWidth = 3
        g.strokeColor = C.hudIdle
        g.circle(p.x, p.y, 8)
        g.stroke()
      }
    }

    // ── 张力条（调试用；正式版按设计 §8.4 应改为纯听觉 + 线宽反馈）──
    const r = sc.world.ropes[0]
    if (r !== undefined && r.state === 'attached') {
      const ratio = Math.min(r.tension / sc.world.config.tensionMax, 1)
      const w = 220
      const p = uiToLocal(VIEW_W - 260, VIEW_H - 50)
      g.fillColor = new Color(0, 0, 0, 140)
      g.rect(p.x, p.y, w, 10)
      g.fill()
      const style = tensionStyle(ratio, sc.world.tick)
      g.fillColor = style.color
      g.rect(p.x, p.y, w * ratio, 10)
      g.fill()
      // 85% 濒断刻度（设计 §2.4 / FR-UI-002 的 R2 版会有专门刻度）
      g.strokeColor = new Color(255, 255, 255, 120)
      g.lineWidth = 1
      g.moveTo(p.x + w * 0.85, p.y - 2)
      g.lineTo(p.x + w * 0.85, p.y + 12)
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

  private strokeAabb(g: Graphics, cx: number, cy: number, hw: number, hh: number, color: Color): void {
    const p = worldToLocal({ x: cx - hw, y: cy - hh })
    g.lineWidth = 2
    g.strokeColor = color
    g.rect(p.x, p.y, metersToPx(hw * 2), metersToPx(hh * 2))
    g.stroke()
  }

  private fillCircle(g: Graphics, cx: number, cy: number, r: number, color: Color): void {
    const p = worldToLocal({ x: cx, y: cy })
    g.fillColor = color
    g.circle(p.x, p.y, metersToPx(r))
    g.fill()
  }

  /** 给一个刚体描边（瞄准命中时高亮用）。 */
  private strokeShape(g: Graphics, b: Body, color: Color): void {
    g.lineWidth = 3
    g.strokeColor = color
    if (b.shape.kind === 'circle') {
      const p = worldToLocal(b.pos)
      g.circle(p.x, p.y, metersToPx(b.shape.radius) + 3)
    } else {
      const p = worldToLocal({ x: b.pos.x - b.shape.hw, y: b.pos.y - b.shape.hh })
      g.rect(p.x, p.y, metersToPx(b.shape.hw * 2), metersToPx(b.shape.hh * 2))
    }
    g.stroke()
  }
}


/** 两块地面之间最大的空档（= 深沟）。找不到就返回 null。 */
function groundGap(sc: PlayableScene): { left: number; right: number } | null {
  const spans: { left: number; right: number }[] = []
  for (const b of sc.world.bodies) {
    if (b.kind !== 'static' || b.removed) continue
    if (!b.name.includes('ground')) continue
    if (b.shape.kind !== 'aabb') continue
    spans.push({ left: b.pos.x - b.shape.hw, right: b.pos.x + b.shape.hw })
  }
  if (spans.length < 2) return null
  spans.sort((a, b) => a.left - b.left)
  let best = 0
  let gap: { left: number; right: number } | null = null
  for (let i = 1; i < spans.length; i++) {
    const w = spans[i]!.left - spans[i - 1]!.right
    if (w > best) {
      best = w
      gap = { left: spans[i - 1]!.right, right: spans[i]!.left }
    }
  }
  return best >= 0.5 ? gap : null
}

export { tensionStyle }

/**
 * 刚体 → 灰盒颜色。**按 tag 与状态推导，不按名字硬编码** ——
 * 这样 M0 沙盒与序章场景能共用同一个渲染器（见 core/playable.ts）。
 */
function colorOf(b: Body): Color {
  switch (b.tag) {
    case 'player':
      // 着地/离地用不同色调，让"谁是主动方"一眼可读（设计 §2.2）
      return b.grounded ? C.player : C.playerAir
    case 'prop':
      // 易碎物（陶罐）用略暖的灰，和石块区分开
      return b.shattersOnDeath ? C.fragile : C.stone
    case 'enemy':
      // 血量用颜色深浅表达，不显示血条（FR-UI-005 / FR-CBT-008）
      return !b.alive ? C.armorDead : b.hp < b.maxHp ? C.armorHurt : C.armor
    default:
      return C.stone
  }
}

function halfW(shape: Shape): number {
  return shape.kind === 'aabb' ? shape.hw : shape.radius
}
function halfH(shape: Shape): number {
  return shape.kind === 'aabb' ? shape.hh : shape.radius
}
