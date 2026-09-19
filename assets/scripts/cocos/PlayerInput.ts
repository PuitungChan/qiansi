/**
 * 《牵丝》—— 输入适配层。
 *
 * 这一层唯一的职责是把引擎的键鼠/触摸事件**翻译成内核的 `InputFrame`**（每 tick 一帧）。
 * 内核不读键盘，也不读鼠标——那会直接摧毁 AC-05 的确定性（见 input.ts 的文件头）。
 *
 * ## 第 13 轮实机反馈后的操作方案（**整层重写**）
 *
 * 创始人三条原话：
 *   1. 「左半屏幕负责移动……有时候丝线需要连到左半屏幕的部分，操作起来很不方便，
 *      既然移动方向只有左右，那就使用左右两个按键进行移动就好，没有必要虚拟摇杆占据半个屏幕」
 *   2. 「在角色运动中点击丝线来切断这个方式依旧很不灵敏，是否能改为通过按键切断？」
 *   3. 「是否可以做成玩家长按屏幕瞄准，松手后发射丝线，松手的位置即是丝线附着的位置
 *      （如果松手的地方是空白那么不附着）」
 *
 * 于是：
 *
 * | 操作 | 触屏 | 键鼠 |
 * |---|---|---|
 * | 移动 | 左下 ◀ ▶ | `A`/`D` 或 `←`/`→` |
 * | 瞄准 | **按住屏幕任意空白处**（整屏都是瞄准区） | 按住鼠标左键 |
 * | 发射 | 松手 | 松开左键 |
 * | 收丝 / 放丝 | 右下「收」「放」 | 滚轮上 / 下（空格 / Shift 亦可） |
 * | 切断 | 右下「断」 | `Q` / 右键（**轻点丝线**作为备选保留） |
 *
 * 「轻点丝线 = 断」与「松手 = 发射」会打架，用**时长**分开：
 * 按下到松手 < `TAP_CUT_MS` 且松手点落在某根已附着的丝上 ⇒ 断那一根；
 * 否则就是一次发射（松手在空白处 ⇒ 内核不附着）。
 *
 * **按钮几何来自 `core/hud.ts` 的同一份数据**——渲染层画的就是输入层命中的矩形，
 * 两处不可能错位（见 hud.ts 的文件头）。
 *
 * 本文件认识 `cc`，但**不修改任何物理量**。
 */

import {
  EventKeyboard,
  EventMouse,
  EventTouch,
  Input,
  KeyCode,
  Vec2 as CcVec2,
  input,
} from 'cc'
import { type InputFrame, type ReelCommand, input as makeFrame, sanitizeMoveX } from '../core/input'
import type { PlayableScene } from '../core/playable'
import { buttonAt, type HudButtonId } from '../core/hud'
import { DT } from '../core/constants'
import { uiToWorld } from './Coordinates'

/** 滚轮一格等效持续收放的 tick 数。 */
const WHEEL_PULSE_TICKS = 6
/** 短按多久之内算"轻点"（毫秒）：轻点丝线 = 断，其余松手 = 发射。 */
const TAP_CUT_MS = 200

interface PointerState {
  down: boolean
  x: number
  y: number
  /** 按下时刻（毫秒） */
  downAt: number
}

function emptyPointer(): PointerState {
  return { down: false, x: 0, y: 0, downAt: 0 }
}

/** 松手后待处理的一次"轻点/发射"。由 `sample()` 决定它是断丝还是发射。 */
interface PendingRelease {
  x: number
  y: number
  heldMs: number
}

export class PlayerInput {
  private readonly keys = new Set<number>()

  /** 屏幕按钮的按下状态（触屏与鼠标共用）。 */
  private readonly buttons = new Set<HudButtonId>()

  /** 瞄准指针（鼠标或触摸，二选一，见 `activePointer`）。 */
  private readonly aim = emptyPointer()

  /** 松手那一帧留下的记录。 */
  private pendingRelease: PendingRelease | null = null
  /** 右键 = 断最近一根。 */
  private pendingCutNearest = false

  /** 边沿检测：按住不该每 tick 都断一次。 */
  private qWasDown = false
  private cutButtonWasDown = false
  /** 鼠标正按着哪个按钮（松开时要清掉，且不能只清一个）。 */
  private mouseButton: HudButtonId | null = null

  private reelPulse = 0
  private reelPulseDir: ReelCommand = 'hold'

  /**
   * 指针来源仲裁：**谁先按下谁独占**，另一来源在这次按下期间的事件全部忽略。
   * 用于消除"鼠标与触摸同时派发"导致的重复处理（第 4 轮实机反馈 #1 的根因之一）。
   */
  private activePointer: 'none' | 'mouse' | 'touch' = 'none'
  /** 触摸 id：瞄准手指 / 按钮手指分开跟踪，不再靠坐标判断归属。 */
  private aimTouchId: number | null = null
  private readonly buttonTouches = new Map<number, HudButtonId>()

  /** 最近一次瞄准点的世界坐标（渲染层画瞄准线与附着点标记）。 */
  aimWorld: { x: number; y: number } | null = null

  constructor() {
    this.bind()
  }

  // ── 事件绑定 ────────────────────────────────────────

  private bind(): void {
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this)
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this)
    input.on(Input.EventType.MOUSE_DOWN, this.onMouseDown, this)
    input.on(Input.EventType.MOUSE_MOVE, this.onMouseMove, this)
    input.on(Input.EventType.MOUSE_UP, this.onMouseUp, this)
    input.on(Input.EventType.MOUSE_WHEEL, this.onMouseWheel, this)
    input.on(Input.EventType.TOUCH_START, this.onTouchStart, this)
    input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this)
    input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this)
    input.on(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this)
  }

  dispose(): void {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this)
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this)
    input.off(Input.EventType.MOUSE_DOWN, this.onMouseDown, this)
    input.off(Input.EventType.MOUSE_MOVE, this.onMouseMove, this)
    input.off(Input.EventType.MOUSE_UP, this.onMouseUp, this)
    input.off(Input.EventType.MOUSE_WHEEL, this.onMouseWheel, this)
    input.off(Input.EventType.TOUCH_START, this.onTouchStart, this)
    input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this)
    input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this)
    input.off(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this)
  }

  // ── 键盘 ────────────────────────────────────────────

  private onKeyDown(e: EventKeyboard): void {
    this.keys.add(e.keyCode)
  }

  private onKeyUp(e: EventKeyboard): void {
    this.keys.delete(e.keyCode)
  }

  /** 调试热键（复位、跳段等）由 Bootstrap 直接查询，不走 InputFrame。 */
  isKeyDown(code: KeyCode): boolean {
    return this.keys.has(code)
  }

  private moveXFromKeys(): number {
    const left = this.keys.has(KeyCode.KEY_A) || this.keys.has(KeyCode.ARROW_LEFT)
    const right = this.keys.has(KeyCode.KEY_D) || this.keys.has(KeyCode.ARROW_RIGHT)
    return sanitizeMoveX((right ? 1 : 0) - (left ? 1 : 0))
  }

  // ── 鼠标 ────────────────────────────────────────────

  private onMouseDown(e: EventMouse): void {
    // 触摸正独占（有手指按着）⇒ 忽略鼠标，避免同一次输入被处理两遍
    if (this.activePointer === 'touch') return

    const button = e.getButton()
    if (button === EventMouse.BUTTON_RIGHT) {
      this.pendingCutNearest = true
      return
    }
    if (button !== EventMouse.BUTTON_LEFT) return

    this.activePointer = 'mouse'
    const loc = e.getUILocation()

    // 落点在屏幕按钮上 ⇒ 这是"按按钮"，不是瞄准
    const hit = buttonAt(loc.x, loc.y)
    if (hit !== null) {
      this.mouseButton = hit.id
      this.buttons.add(hit.id)
      return
    }

    this.beginAim(loc.x, loc.y)
  }

  private onMouseMove(e: EventMouse): void {
    if (this.activePointer === 'touch') return
    const loc = e.getUILocation()

    // 鼠标按住按钮后移出 ⇒ 松开（与触屏一致，避免"看着没按却一直在收丝"）
    if (this.mouseButton !== null) {
      const hit = buttonAt(loc.x, loc.y)
      if (hit === null || hit.id !== this.mouseButton) {
        this.buttons.delete(this.mouseButton)
        this.mouseButton = null
      }
      return
    }

    if (!this.aim.down) return
    this.aim.x = loc.x
    this.aim.y = loc.y
    // **按住不动也算瞄准**（松手就是发射）。第 13 轮之前"按住不动 = 收丝"，
    // 现在收丝有自己的按钮与滚轮，所以长按就是瞄准。
    this.aimWorld = uiToWorld(loc.x, loc.y)
  }

  private onMouseUp(e: EventMouse): void {
    if (e.getButton() !== EventMouse.BUTTON_LEFT) return
    const loc = e.getUILocation()

    if (this.mouseButton !== null) {
      this.buttons.delete(this.mouseButton)
      this.mouseButton = null
      if (this.activePointer === 'mouse') this.activePointer = 'none'
      return
    }
    if (!this.aim.down) return

    this.aim.down = false
    this.aimWorld = uiToWorld(loc.x, loc.y)
    this.pendingRelease = { x: loc.x, y: loc.y, heldMs: nowMs() - this.aim.downAt }
    if (this.activePointer === 'mouse') this.activePointer = 'none'
  }

  private onMouseWheel(e: EventMouse): void {
    const dy = e.getScrollY()
    if (dy === 0) return
    // 滚轮上 = 收丝，下 = 放丝（创始人第 13 轮指定的键鼠收放方式）
    this.reelPulseDir = dy > 0 ? 'in' : 'out'
    this.reelPulse = WHEEL_PULSE_TICKS
  }

  // ── 触屏 ────────────────────────────────────────────

  private onTouchStart(e: EventTouch): void {
    if (this.activePointer === 'mouse') return
    this.activePointer = 'touch'

    const loc = e.getUILocation()
    const id = e.getID()

    // 按钮优先：落在按钮上就只当按钮，绝不同时开始瞄准
    const hit = buttonAt(loc.x, loc.y)
    if (hit !== null) {
      if (this.buttonTouches.has(id)) return
      this.buttonTouches.set(id, hit.id)
      this.buttons.add(hit.id)
      return
    }

    // 其余整个屏幕都是瞄准区（这正是"取消左半屏摇杆"换来的东西）
    if (this.aimTouchId !== null) return
    this.aimTouchId = id
    this.beginAim(loc.x, loc.y)
  }

  private onTouchMove(e: EventTouch): void {
    const id = e.getID()
    const loc = e.getUILocation()

    // 手指滑出按钮 ⇒ 松开那个按钮
    const held = this.buttonTouches.get(id)
    if (held !== undefined) {
      const hit = buttonAt(loc.x, loc.y)
      if (hit === null || hit.id !== held) {
        this.buttons.delete(held)
        this.buttonTouches.delete(id)
      }
      return
    }

    if (id !== this.aimTouchId) return
    this.aim.x = loc.x
    this.aim.y = loc.y
    this.aimWorld = uiToWorld(loc.x, loc.y)
  }

  private onTouchEnd(e: EventTouch): void {
    const id = e.getID()
    const loc = e.getUILocation()

    const held = this.buttonTouches.get(id)
    if (held !== undefined) {
      this.buttonTouches.delete(id)
      this.buttons.delete(held)
      if (this.aimTouchId === null && this.buttonTouches.size === 0) this.activePointer = 'none'
      return
    }

    if (id !== this.aimTouchId) return
    this.aimTouchId = null
    if (this.buttonTouches.size === 0) this.activePointer = 'none'

    this.aim.down = false
    this.aimWorld = uiToWorld(loc.x, loc.y)
    this.pendingRelease = { x: loc.x, y: loc.y, heldMs: nowMs() - this.aim.downAt }
  }

  private beginAim(x: number, y: number): void {
    this.aim.down = true
    this.aim.x = x
    this.aim.y = y
    this.aim.downAt = nowMs()
    this.aimWorld = uiToWorld(x, y)
  }

  // ── 采样 ────────────────────────────────────────────

  /**
   * 产出一帧输入。**每个物理 tick 调用一次**，所以一次渲染帧里连续跑多个固定步时，
   * 只有第一步会携带一次性事件（发射/断丝），这正是我们要的确定性语义。
   */
  sample(sc: PlayableScene): InputFrame {
    // 移动：按钮 + 键盘，按钮优先（同向不叠加，避免意外加速）
    let moveX = this.moveXFromKeys()
    if (this.buttons.has('left')) moveX = -1
    else if (this.buttons.has('right')) moveX = 1

    // ── 断（优先级：按钮 > 右键 > 轻点丝线 > Q）──
    // 按钮与 Q 都做**边沿检测**：按住不该每 tick 断一根。
    let cutRope = -1
    const cutDown = this.buttons.has('cut')
    if (cutDown && !this.cutButtonWasDown) {
      cutRope = sc.world.pickNearestRope(sc.player.pos)
    }
    this.cutButtonWasDown = cutDown

    if (cutRope < 0 && this.pendingCutNearest) {
      cutRope = sc.world.pickNearestRope(sc.player.pos)
    }
    this.pendingCutNearest = false

    const qDown = this.keys.has(KeyCode.KEY_Q)
    if (cutRope < 0 && qDown && !this.qWasDown) {
      cutRope = sc.world.pickNearestRope(sc.player.pos)
    }
    this.qWasDown = qDown

    // ── 松手：轻点丝线 = 断；否则 = 发射 ──
    let aimPoint: { x: number; y: number } | null = null
    let firePressed = false
    if (this.pendingRelease !== null) {
      const rel = this.pendingRelease
      this.pendingRelease = null
      const p = uiToWorld(rel.x, rel.y)
      const rope = rel.heldMs < TAP_CUT_MS ? sc.world.pickRope(p) : -1
      if (rope >= 0 && cutRope < 0) {
        cutRope = rope
      } else {
        aimPoint = p
        firePressed = true
      }
    } else if (this.aim.down) {
      aimPoint = uiToWorld(this.aim.x, this.aim.y)
    }

    // ── 收 / 放 ──
    let reel: ReelCommand = 'hold'
    if (this.buttons.has('reelIn')) reel = 'in'
    else if (this.buttons.has('reelOut')) reel = 'out'
    else if (this.keys.has(KeyCode.SPACE)) reel = 'in'
    else if (this.keys.has(KeyCode.SHIFT_LEFT) || this.keys.has(KeyCode.SHIFT_RIGHT)) reel = 'out'
    if (this.reelPulse > 0) {
      reel = this.reelPulseDir
      this.reelPulse--
    }

    return makeFrame({
      moveX,
      aimPoint,
      firePressed,
      reel,
      cutRope,
      focus: this.keys.has(KeyCode.KEY_F),
    })
  }

  /** 是否正按着瞄准（渲染层据此画瞄准线与附着点标记）。 */
  get isAiming(): boolean {
    return this.aim.down
  }

  /** 哪个按钮正被按下（渲染层据此画按下高亮）。 */
  isButtonDown(id: HudButtonId): boolean {
    return this.buttons.has(id)
  }

  /** 单次固定步之间的收放脉冲衰减由 sample() 负责，这里只暴露 DT 供调用方参考。 */
  static readonly fixedDt = DT
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
