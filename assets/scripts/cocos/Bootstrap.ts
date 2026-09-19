/**
 * 《牵丝》—— M0 入口组件。
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
 * ## 场景极简约定
 *
 * 这个组件**自己创建**所有子节点（Graphics / Label），所以 M0Room.scene 里
 * 只需要一个挂了本组件的空节点。这样 `.scene` 文件里需要手写的内容降到最少，
 * 也避免了我无法验证的场景序列化格式成为风险点。
 */

import {
  Color,
  Component,
  Graphics,
  KeyCode,
  Label,
  Node,
  ResolutionPolicy,
  UITransform,
  _decorator,
  view,
} from 'cc'
import { DEMO_TICKS, demoScript } from '../core/demo'
import { DT, VIEW_H, VIEW_W } from '../core/constants'
import { type InputFrame, EMPTY_INPUT, encodeInput } from '../core/input'
import { predictTrajectory } from '../core/aim'
import { M0Scenario } from '../core/scene_m0'
import { DebugPanel, type DebugPanelState } from './DebugPanel'
import { GrayboxRenderer, type RenderOptions } from './GrayboxRenderer'
import { PlayerInput } from './PlayerInput'

const { ccclass } = _decorator

/** 每帧最多补几个固定步。防止卡顿后"追帧"变成死亡螺旋。 */
const MAX_STEPS_PER_FRAME = 5
/** 回放记录环形缓冲的长度（帧）。 */
const REPLAY_BUFFER = 600

@ccclass('QiansiBootstrap')
export class QiansiBootstrap extends Component {
  private scenario!: M0Scenario
  private renderer = new GrayboxRenderer()
  private panel = new DebugPanel()
  private playerInput!: PlayerInput
  private gfx!: Graphics
  private label!: Label

  private acc = 0
  private lastFrame: InputFrame = EMPTY_INPUT
  private prediction: { x: number; y: number }[] = []

  // 调试开关
  private showPrediction = true
  private showDebug = true
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

    this.buildNodes()
    this.playerInput = new PlayerInput()
    this.scenario = new M0Scenario({ ropeCount: this.ropeCount })
    this.demoTicks = demoScript().length
  }

  onDestroy(): void {
    this.playerInput?.dispose()
  }

  private buildNodes(): void {
    const gfxNode = new Node('Graybox')
    gfxNode.parent = this.node
    gfxNode.setPosition(0, 0, 0)
    this.gfx = gfxNode.addComponent(Graphics)

    const labelNode = new Node('DebugPanel')
    labelNode.parent = this.node
    const ui = labelNode.addComponent(UITransform)
    ui.setAnchorPoint(0, 1)
    ui.setContentSize(900, 560)
    labelNode.setPosition(-950, 530, 0)
    this.label = labelNode.addComponent(Label)
    this.label.string = ''
    this.label.fontSize = 15
    this.label.lineHeight = 18
    this.label.horizontalAlign = Label.HorizontalAlign.LEFT
    this.label.verticalAlign = Label.VerticalAlign.TOP
    this.label.enableWrapText = false
    this.label.color = new Color(225, 225, 225, 255)
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
    if (this.demoMode) {
      const script = demoScript()
      frame = script[Math.min(this.demoIndex, script.length - 1)] ?? EMPTY_INPUT
      this.demoIndex++
      if (this.demoIndex >= script.length) this.demoMode = false
    } else {
      frame = this.playerInput.sample(this.scenario)
    }

    this.lastFrame = frame
    this.scenario.step(frame)

    for (const e of this.scenario.world.events) {
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

    if (pressed(KeyCode.KEY_R)) {
      this.scenario.reset()
      this.ropeBreaks = 0
      this.demoMode = false
      this.demoIndex = 0
      this.replay = []
    }
    if (pressed(KeyCode.KEY_P)) this.showPrediction = !this.showPrediction
    if (pressed(KeyCode.KEY_G)) this.showDebug = !this.showDebug
    if (pressed(KeyCode.KEY_T)) this.slowMo = !this.slowMo
    if (pressed(KeyCode.KEY_N)) {
      this.ropeCount = (this.ropeCount % 4) + 1
      this.rebuild()
    }
    if (pressed(KeyCode.F1)) {
      this.rebuild()
      this.demoMode = true
      this.demoIndex = 0
    }
    if (pressed(KeyCode.F2)) {
      this.demoMode = false
    }
    if (pressed(KeyCode.KEY_H)) {
      // 把最近的输入序列打到控制台 —— 我可以在本地用它精确复现你看到的那一刻（NFR-MNT-003）
      console.log(
        `[qiansi] hash=${this.scenario.world.stateHash()} tick=${this.scenario.world.tick}\n` +
          this.replay.join('\n'),
      )
    }
  }

  /** 按当前丝位数重建场景（丝位数量是构造期参数）。 */
  private rebuild(): void {
    this.scenario = new M0Scenario({ ropeCount: this.ropeCount })
    this.ropeBreaks = 0
    this.demoMode = false
    this.demoIndex = 0
    this.replay = []
  }

  // ── 渲染 ────────────────────────────────────────────

  private render(): void {
    const w = this.scenario.world

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
    }
    this.renderer.draw(this.gfx, this.scenario, opts)

    if (this.showDebug) {
      this.drawPanelBackground(this.gfx)
      const state: DebugPanelState = {
        fps: this.fps,
        demoMode: this.demoMode,
        demoIndex: this.demoIndex,
        demoTicks: this.demoTicks,
        showPrediction: this.showPrediction,
        slowMoScale: this.slowMo ? 0.25 : 1,
        frame: this.lastFrame,
        ropeBreaks: this.ropeBreaks,
      }
      this.label.string = this.panel.format(this.scenario, state)
      this.label.node.active = true
    } else {
      this.label.string = ''
      this.label.node.active = false
    }
  }

  /** 调试面板底衬（画在同一张 Graphics 上，节点局部坐标以房间中心为原点）。 */
  private drawPanelBackground(g: Graphics): void {
    g.fillColor = new Color(0, 0, 0, 170)
    g.rect(-960, -540, 640, 560)
    g.fill()
  }
}
