/**
 * 《牵丝》—— 入口组件（M0 沙盒 / M1 序章 共用）。
 *
 * 把三块东西接起来：
 *   `core/`（纯逻辑，零引擎依赖） ←→ `cocos/`（渲染、输入、调试面板）
 *
 * ## 为什么必须有固定步长累加器
 *
 * Cocos 的 `update(dt)` 是**可变步长**的。内核要求固定 1/60 步长（FR-PHY-008），
 * 否则同一段操作在 60Hz 与 30Hz 设备上会得到不同结果，AC-05 直接作废。
 * 所以这里用累加器把渲染帧切成整数个固定步；并且设了每帧上限，
 * 避免卡顿时"补帧"把一帧拖成一个死亡螺旋。
 *
 * ## 场景是可插拔的
 *
 * 本组件只依赖 `core/playable.ts` 的 `PlayableScene` 窄接口（world / player / step /
 * reset / summary / hint）。**加一个新场景不需要改这一层** —— 而这一层是唯一认识 `cc` 的，
 * 改它就意味着你要重开一次编辑器。`M` 键在序章与 M0 沙盒之间切换。
 *
 * ## 场景极简约定
 *
 * 这个组件**自己创建**所有子节点（Graphics / Label），所以 M0Room.scene 里
 * 只需要一个挂了本组件的空节点。这样 `.scene` 文件里需要手写的内容降到最少，
 * 也避免了我无法验证的场景序列化格式成为风险点。
 */

import {
  Canvas,
  Color,
  Component,
  Graphics,
  KeyCode,
  Label,
  Layers,
  Node,
  ResolutionPolicy,
  UITransform,
  _decorator,
  view,
} from 'cc'
import { DT, VIEW_H, VIEW_W } from '../core/constants'
import { DEMO_TICKS, demoScript } from '../core/demo'
import { EMPTY_INPUT, type InputFrame, encodeInput } from '../core/input'
import { predictTrajectory } from '../core/aim'
import type { PlayableScene } from '../core/playable'
import { M0Scenario } from '../core/scene_m0'
import { PrologueScene } from '../core/scene_prologue'
import type { Telemetry } from '../core/telemetry'
import { DebugPanel, type DebugPanelState } from './DebugPanel'
import { GrayboxRenderer, type RenderOptions } from './GrayboxRenderer'
import { LabelLayer } from './LabelLayer'
import { labelSpecs } from './labels'
import { PlayerInput } from './PlayerInput'

const { ccclass } = _decorator

/** 每帧最多补几个固定步。防止卡顿后"追帧"变成死亡螺旋。 */
const MAX_STEPS_PER_FRAME = 5
/** 回放记录环形缓冲的长度（帧）。 */
const REPLAY_BUFFER = 600

type SceneKind = 'prologue' | 'm0'

@ccclass('QiansiBootstrap')
export class QiansiBootstrap extends Component {
  private scene!: PlayableScene
  private sceneKind: SceneKind = 'prologue'
  private renderer = new GrayboxRenderer()
  private panel = new DebugPanel()
  private playerInput!: PlayerInput
  private gfx!: Graphics
  private label!: Label
  private hintLabel!: Label
  /** 小字标签层（第 13 轮：让物体一眼可分；L 键开关）。 */
  private bodyLabels!: LabelLayer

  private acc = 0
  private lastFrame: InputFrame = EMPTY_INPUT
  private prediction: { x: number; y: number }[] = []

  // 调试开关
  private showPrediction = true
  private showDebug = true
  /** 小字标签（石/罐/卒/梁/桩）——灰盒读图辅助，L 切换。 */
  private showLabels = true
  private slowMo = false
  private ropeCount = 1
  private demoMode = false
  private demoIndex = 0
  private demoTicks = DEMO_TICKS
  private ropeBreaks = 0

  // 热键边沿检测
  private prevKeys = new Set<number>()

  // fps 统计
  private fpsAccum = 0
  private fpsFrames = 0
  private fps = 0

  // 回放记录
  private replay: string[] = []

  start(): void {
    // 设计分辨率在**代码里**设定，而不是依赖工程设置文件。
    // 理由：全部渲染坐标都是"以画布中心为原点、1 米 = 60 像素"（见 Coordinates.ts），
    // 一旦设计分辨率不是 1920×1080，整套换算就会错位。放在代码里，这个前提就
    // 与脚本同生共死，不会因为有人改了工程设置而悄悄失效（FR-RND-003 / NFR-DISP-001）。
    view.setDesignResolutionSize(VIEW_W, VIEW_H, ResolutionPolicy.FIXED_HEIGHT)

    this.assertUnderCanvas()

    this.buildRenderNode()

    this.playerInput = new PlayerInput()
    this.buildScene()

    // 调试面板与提示都是**非必需**的：它们出问题不该导致"整个游戏看不见"
    try {
      this.buildDebugLabel()
      this.buildHintLabel()
    } catch (err) {
      this.showDebug = false
      this.label = undefined as unknown as Label
      this.hintLabel = undefined as unknown as Label
      console.warn('[牵丝] 面板/提示节点创建失败，已自动关闭（不影响游戏本体）：', err)
    }

    // 小字标签层（第 13 轮）。单独一个 try：它挂了也只该关掉标签，不该影响别的东西。
    try {
      this.bodyLabels = new LabelLayer(this.node)
    } catch (err) {
      this.showLabels = false
      console.warn('[牵丝] 标签层创建失败，已关闭小字标签：', err)
    }

    // 这行日志是给你排查用的：**看到它 = 脚本编译并运行了**；看不到 = 脚本压根没跑起来。
    console.log(
      `[牵丝] QiansiBootstrap 已启动（场景=${this.sceneKind}）：固定 ${(1 / DT).toFixed(0)}Hz，` +
        `房间 ${VIEW_W / 60}×${VIEW_H / 60}m。若画面仍然空白，请把控制台报错发我。`,
    )
  }

  /**
   * 防呆：本组件必须挂在 **Canvas**（或它的子孙节点）上。
   *
   * 为什么必须检查：全部渲染坐标都是"以画布中心为原点"（`Coordinates.ts`）。
   * 如果脚本挂在 Scene 根节点或一个普通节点上，画面会整体偏出屏幕，
   * 而现象是"全黑"——这与"脚本没编译好"极难区分，会浪费很多排查时间。
   */
  private assertUnderCanvas(): void {
    let n: Node | null = this.node
    while (n !== null) {
      if (n.getComponent(Canvas) !== null) return
      n = n.parent
    }
    console.error(
      '[牵丝] QiansiBootstrap 必须挂在 Canvas 节点（或其子节点）上，当前节点不在 Canvas 之下。\n' +
        '修复：在层级管理器右键 → 创建 → UI 组件 → Canvas（会自动带一个 Camera 子节点），' +
        '然后把本脚本拖到该 Canvas 上。\n' +
        '注意：资源管理器里「新建 → Scene」建出来的是**空场景**，默认不含 Canvas。',
    )
  }

  onDestroy(): void {
    this.playerInput?.dispose()
  }

  /**
   * 渲染节点。**这是整个画面能不能显示出来的关键一步。**
   *
   * ⚠️ 坑（v0.2.0 的首个实机反馈）：Cocos 里 `new Node()` 创建的节点默认在
   * `Layers.Enum.DEFAULT`（`1<<30`）层，而 Canvas 自带相机的 `visibility` 是
   * `UI_2D | UI_3D`（`41943040`）——**两者不匹配，画的东西会被相机整个剔除，屏幕全空**。
   * 编辑器里手工创建的节点会被自动赋成 UI_2D，所以这个坑只在**运行时代码建节点**时出现，
   * 而且什么错都不报，只是看不见。必须显式 `layer = Layers.Enum.UI_2D`。
   */
  private buildRenderNode(): void {
    const gfxNode = new Node('Graybox')
    gfxNode.layer = Layers.Enum.UI_2D
    gfxNode.parent = this.node
    gfxNode.setPosition(0, 0, 0)
    this.gfx = gfxNode.addComponent(Graphics)
  }

  private buildDebugLabel(): void {
    const node = new Node('DebugPanel')
    node.layer = Layers.Enum.UI_2D
    node.parent = this.node
    const ui = node.addComponent(UITransform)
    ui.setAnchorPoint(0, 1)
    ui.setContentSize(900, 560)
    node.setPosition(-950, 530, 0)
    const label = node.addComponent(Label)
    label.string = ''
    label.useSystemFont = true
    label.fontSize = 14
    label.lineHeight = 17
    label.horizontalAlign = Label.HorizontalAlign.LEFT
    label.verticalAlign = Label.VerticalAlign.TOP
    label.enableWrapText = false
    label.color = new Color(225, 225, 225, 255)
    this.label = label
  }

  /**
   * 极简提示（设计 §7 唯一的教学手段）。
   *
   * 放在**屏幕中上方**、字号明显大于调试面板 —— 它必须一眼看到，但不能抢走玩法层的注意力。
   * 设计 §8.4 规定全游戏文本 ≤ 500 字，序章这 3 句就是其中最重要的 15 个字。
   */
  private buildHintLabel(): void {
    const node = new Node('Hint')
    node.layer = Layers.Enum.UI_2D
    node.parent = this.node
    const ui = node.addComponent(UITransform)
    ui.setAnchorPoint(0.5, 0.5)
    ui.setContentSize(1200, 80)
    node.setPosition(0, 330, 0)
    const label = node.addComponent(Label)
    label.string = ''
    label.useSystemFont = true
    label.fontSize = 40
    label.lineHeight = 48
    label.horizontalAlign = Label.HorizontalAlign.CENTER
    label.verticalAlign = Label.VerticalAlign.CENTER
    label.enableWrapText = false
    label.color = new Color(240, 226, 190, 235)
    this.hintLabel = label
  }

  /** 建/重建当前场景。 */
  private buildScene(): void {
    this.scene =
      this.sceneKind === 'prologue'
        ? new PrologueScene({ ropeCount: this.ropeCount })
        : new M0Scenario({ ropeCount: this.ropeCount })
    this.ropeBreaks = 0
    this.demoMode = false
    this.demoIndex = 0
    this.replay = []
  }

  update(dt: number): void {
    this.trackFps(dt)
    this.handleHotkeys()

    // 固定步长累加器：渲染帧 → 整数个 1/60 物理步
    const scale = this.slowMo ? 0.25 : 1
    this.acc += dt * scale
    let steps = 0
    while (this.acc >= DT && steps < MAX_STEPS_PER_FRAME) {
      this.tickOnce()
      this.acc -= DT
      steps++
    }
    if (steps >= MAX_STEPS_PER_FRAME) this.acc = 0

    this.render()
  }

  /** 推进恰好一个固定步。这是唯一写入模拟的地方。 */
  private tickOnce(): void {
    let frame: InputFrame
    if (this.demoMode && this.sceneKind === 'm0') {
      const script = demoScript()
      frame = script[Math.min(this.demoIndex, script.length - 1)] ?? EMPTY_INPUT
      this.demoIndex++
      if (this.demoIndex >= script.length) this.demoMode = false
    } else {
      frame = this.playerInput.sample(this.scene)
    }

    this.lastFrame = frame
    this.scene.step(frame)

    for (const e of this.scene.world.events) {
      if (e.kind === 'rope-broken') this.ropeBreaks++
    }

    this.replay.push(encodeInput(frame))
    if (this.replay.length > REPLAY_BUFFER) this.replay.shift()
  }

  private trackFps(dt: number): void {
    this.fpsAccum += dt
    this.fpsFrames++
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum
      this.fpsAccum = 0
      this.fpsFrames = 0
    }
  }

  // ── 调试热键（边沿触发）────────────────────────────

  private handleHotkeys(): void {
    const pressed = (code: KeyCode): boolean => {
      const down = this.playerInput.isKeyDown(code)
      const wasDown = this.prevKeys.has(code)
      if (down && !wasDown) {
        this.prevKeys.add(code)
        return true
      }
      if (!down) this.prevKeys.delete(code)
      return false
    }

    if (pressed(KeyCode.KEY_R)) this.scene.reset()
    if (pressed(KeyCode.KEY_P)) this.showPrediction = !this.showPrediction
    if (pressed(KeyCode.KEY_G)) this.showDebug = !this.showDebug
    if (pressed(KeyCode.KEY_L)) this.showLabels = !this.showLabels
    if (pressed(KeyCode.KEY_T)) this.slowMo = !this.slowMo

    // ── 数字键 = **调试跳段**（第 13 轮新增）──
    //
    // 段落出口改成纯进度门控之后（"做完上一步才进下一段"），一个卡在 3:00 的玩家
    // 看不到后面的内容。数字键给开发者一条旁路：1 教学 / 2 遭遇战 / 3 质量差 /
    // 4 双丝 / 5 已通关。它**不是游戏机制**，玩家路径上没有任何东西会调用它。
    const stages = this.scene.debugStages?.() ?? []
    const digits = [
      KeyCode.DIGIT_1,
      KeyCode.DIGIT_2,
      KeyCode.DIGIT_3,
      KeyCode.DIGIT_4,
      KeyCode.DIGIT_5,
    ]
    for (let i = 0; i < digits.length && i < stages.length; i++) {
      if (!pressed(digits[i]!)) continue
      this.scene.debugSkip?.(stages[i]!)
      console.log(`[牵丝] 调试跳段 → ${stages[i]}`)
    }

    if (pressed(KeyCode.KEY_M)) {
      this.sceneKind = this.sceneKind === 'prologue' ? 'm0' : 'prologue'
      this.buildScene()
      console.log(`[牵丝] 已切换到场景：${this.sceneKind}`)
    }
    if (pressed(KeyCode.KEY_N)) {
      this.ropeCount = (this.ropeCount % 4) + 1
      this.buildScene()
    }
    if (pressed(KeyCode.F1) && this.sceneKind === 'm0') {
      this.scene.reset()
      this.demoMode = true
      this.demoIndex = 0
    }
    if (pressed(KeyCode.F2)) this.demoMode = false
    if (pressed(KeyCode.KEY_J)) this.exportTelemetry()
    if (pressed(KeyCode.KEY_H)) {
      // 把最近的输入序列打到控制台 —— 我可以在本地用它精确复现你看到的那一刻（NFR-MNT-003）
      console.log(
        `[qiansi] scene=${this.sceneKind} hash=${this.scene.world.stateHash()} ` +
          `tick=${this.scene.world.tick}\n` +
          this.replay.join('\n'),
      )
    }
  }

  /**
   * `J` 键：导出 AC-01 埋点（D-042 / FR-LIV-003）。
   *
   * 浏览器里直接下载一个 `.jsonl` 文件；其他平台打印到控制台，复制即可。
   * **两条路都给**，因为"测试者在你旁边点了 J 却不知道文件在哪"会让整场测试白做。
   *
   * 刻意**不依赖 DOM 类型**（用结构化断言而不是 `Document`/`Blob` 类型）——
   * 这个文件要在 web 与 native 两种构建下都编译得过。
   */
  private exportTelemetry(): void {
    const holder = this.scene as unknown as { telemetry?: Telemetry }
    const t = holder.telemetry
    if (t === undefined) {
      console.log('[牵丝] 当前场景没有埋点（只有序章有）')
      return
    }
    const jsonl = t.toJSONL()
    console.log(`[牵丝] AC-01 埋点导出\n${t.summaryLine()}\n--- JSONL ---\n${jsonl}`)

    const g = globalThis as unknown as {
      document?: { createElement(tag: string): { href: string; download: string; click(): void } }
      Blob?: new (parts: string[], opts: { type: string }) => unknown
      URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void }
    }
    if (g.document === undefined || g.Blob === undefined || g.URL === undefined) return
    try {
      const blob = new g.Blob([jsonl], { type: 'application/x-ndjson' })
      const url = g.URL.createObjectURL(blob)
      const a = g.document.createElement('a')
      a.href = url
      a.download = 'qiansi-ac01.jsonl'
      a.click()
      g.URL.revokeObjectURL(url)
    } catch {
      // 没有 DOM 就算了 —— 控制台里已经有全文
    }
  }

  // ── 渲染 ────────────────────────────────────────────

  private render(): void {
    const w = this.scene.world

    // 预判线：只在牵住物体时出现（FR-UI-003），且按"假设此刻断丝"的自由弹道算（D-024）
    this.prediction = []
    const attached = w.ropes.filter((r) => r.state === 'attached')
    if (this.showPrediction && attached.length > 0) {
      const target = w.bodyById(attached[0]!.targetId)
      if (target !== null) {
        this.prediction = predictTrajectory(target.pos, target.vel, {
          gravityY: w.config.gravityY,
        })
      }
    }

    const opts: RenderOptions = {
      showPrediction: this.showPrediction,
      showDebug: this.showDebug,
      aimPoint: this.playerInput.isAiming ? this.playerInput.aimWorld : null,
      prediction: this.prediction,
      glowBodyId: this.scene.glowBodyId(),
      isButtonDown: (id) => this.playerInput.isButtonDown(id),
    }
    this.renderer.draw(this.gfx, this.scene, opts)

    // 小字标签（Graphics 画不了字，走 Label 节点池）
    this.bodyLabels?.sync(
      labelSpecs(this.scene, {
        showLabels: this.showLabels,
        isButtonDown: (id) => this.playerInput.isButtonDown(id),
      }),
    )

    // 极简提示（设计 §7）
    if (this.hintLabel !== undefined) {
      this.hintLabel.string = this.scene.hint() ?? ''
    }

    if (this.showDebug && this.label !== undefined) {
      this.drawPanelBackground(this.gfx)
      const state: DebugPanelState = {
        fps: this.fps,
        sceneName: this.sceneKind === 'prologue' ? '序章（12 分钟）' : 'M0 沙盒',
        demoMode: this.demoMode,
        demoIndex: this.demoIndex,
        demoTicks: this.demoTicks,
        showPrediction: this.showPrediction,
        slowMoScale: this.slowMo ? 0.25 : 1,
        frame: this.lastFrame,
        ropeBreaks: this.ropeBreaks,
      }
      this.label.string = this.panel.format(this.scene, state)
      this.label.node.active = true
    } else if (this.label !== undefined) {
      this.label.string = ''
      this.label.node.active = false
    }
  }

  /**
   * 调试面板底衬（画在同一张 Graphics 上，节点局部坐标以**画布中心**为原点）。
   *
   * 注意坐标系：屏幕是 x ∈ [−960, 960]、y ∈ [−540, 540]，
   * **左上角是 (−960, +540)** 而不是 (−960, −540)——后者是左下角。
   * `Graphics.rect(x, y, w, h)` 的 (x, y) 是矩形的**左下角**，所以这里的 y 要用
   * `540 − 高度`。第一版把面板画到了左下角、和左上角的文字错位，就是这个原因。
   */
  private drawPanelBackground(g: Graphics): void {
    const w = 960
    const h = 560
    g.fillColor = new Color(0, 0, 0, 170)
    g.rect(-960, 540 - h, w, h)
    g.fill()
  }
}
