/**
 * 《牵丝》—— 输入适配层。
 *
 * 这一层唯一的职责是把引擎的键鼠/触摸事件**翻译成内核的 `InputFrame`**（每 tick 一帧）。
 * 内核不读键盘，也不读鼠标——那会直接摧毁 AC-05 的确定性（见 input.ts 的文件头）。
 *
 * 映射依据：
 *   - 键鼠：设计 §3.2 / FR-ACT-005 —— WASD 移动 · 拖拽牵丝 · 滚轮或空格/Shift 收放 · 点击丝线或 Q 断
 *   - 触屏：设计 §3.1 / FR-ACT-001~004 —— 左半屏摇杆 · 右半屏拖拽牵丝 · 按住收丝 · 点击丝线断开
 *
 * 两处交互冲突及解法（这是 M0 需要你实机确认的手感点）：
 *   1. **左键既是"拖拽牵丝"又是"点击断丝"** —— 用位移阈值区分：
 *      按下到松开位移 < `CLICK_SLOP_PX` 视为点击（尝试断丝），否则视为拖拽（尝试牵丝）。
 *   2. **触屏右半屏"按住"既是收丝又是点击断丝** —— 用时间阈值区分：
 *      按住超过 `HOLD_MS` 且未移动视为收丝，提前松手视为点击。
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
import type { M0Scenario } from '../core/scene_m0'
import { VIEW_W, DT } from '../core/constants'
import { uiToWorld } from './Coordinates'

/** 点击 / 拖拽的位移阈值（逻辑像素）。 */
const CLICK_SLOP_PX = 8
/** 触屏"按住收丝"的判定时长（毫秒）。 */
const HOLD_MS = 220
/** 滚轮一格等效持续收放的 tick 数。 */
const WHEEL_PULSE_TICKS = 6
/** 触屏左半屏虚拟摇杆的满偏半径（逻辑像素）。 */
const STICK_RADIUS_PX = 110

interface PointerState {
  down: boolean
  /** 按下时的 UI 坐标 */
  startX: number
  startY: number
  /** 当前 UI 坐标 */
  x: number
  y: number
  /** 按下时刻（毫秒） */
  downAt: number
  /** 是否已越过点击阈值 */
  dragged: boolean
}

function emptyPointer(): PointerState {
  return { down: false, startX: 0, startY: 0, x: 0, y: 0, downAt: 0, dragged: false }
}

export class PlayerInput {
  private readonly keys = new Set<number>()
  private readonly mouse = emptyPointer()
  private readonly touch = emptyPointer()

  /** 本 tick 待消费的一次性事件 */
  private pendingAttach: CcVec2 | null = null
  private pendingCutPoint: CcVec2 | null = null
  private reelPulse = 0
  private reelPulseDir: ReelCommand = 'hold'

  /** 最近一次指针所在的世界坐标（画瞄准线用）。 */
  aimWorld: { x: number; y: number } | null = null

  /** 是否处于"拖拽瞄准"状态。 */
  private aiming = false

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

  /** 调试热键（R 复位等）由 Bootstrap 直接查询，不走 InputFrame。 */
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
    if (e.getButton() !== EventMouse.BUTTON_LEFT) return
    const loc = e.getUILocation()
    const p = this.mouse
    p.down = true
    p.startX = loc.x
    p.startY = loc.y
    p.x = loc.x
    p.y = loc.y
    p.downAt = nowMs()
    p.dragged = false
  }

  private onMouseMove(e: EventMouse): void {
    const loc = e.getUILocation()
    const p = this.mouse
    p.x = loc.x
    p.y = loc.y
    if (p.down && !p.dragged) {
      if (Math.hypot(p.x - p.startX, p.y - p.startY) > CLICK_SLOP_PX) p.dragged = true
    }
    this.aimWorld = uiToWorld(loc.x, loc.y)
    this.aiming = p.down && p.dragged
  }

  private onMouseUp(e: EventMouse): void {
    if (e.getButton() !== EventMouse.BUTTON_LEFT) return
    const p = this.mouse
    if (!p.down) return
    const loc = e.getUILocation()
    p.down = false
    if (p.dragged) {
      // 拖拽松手 = 牵（FR-ACT-005）
      this.pendingAttach = new CcVec2(loc.x, loc.y)
    } else {
      // 原地点击 = 尝试断丝（FR-ACT-004「丝线即按钮」）
      this.pendingCutPoint = new CcVec2(loc.x, loc.y)
    }
    this.aiming = false
  }

  private onMouseWheel(e: EventMouse): void {
    const dy = e.getScrollY()
    if (dy === 0) return
    // 滚轮上 = 收丝，下 = 放丝（设计 §3.2）
    this.reelPulseDir = dy > 0 ? 'in' : 'out'
    this.reelPulse = WHEEL_PULSE_TICKS
  }

  // ── 触屏 ────────────────────────────────────────────

  private onTouchStart(e: EventTouch): void {
    const loc = e.getUILocation()
    if (loc.x < VIEW_W / 2) {
      // 左半屏 = 虚拟摇杆
      const t = this.touch
      t.down = true
      t.startX = loc.x
      t.startY = loc.y
      t.x = loc.x
      t.y = loc.y
      t.downAt = nowMs()
      t.dragged = false
      return
    }
    const p = this.mouse
    p.down = true
    p.startX = loc.x
    p.startY = loc.y
    p.x = loc.x
    p.y = loc.y
    p.downAt = nowMs()
    p.dragged = false
    this.aimWorld = uiToWorld(loc.x, loc.y)
  }

  private onTouchMove(e: EventTouch): void {
    const loc = e.getUILocation()
    if (loc.x < VIEW_W / 2 && this.touch.down) {
      this.touch.x = loc.x
      this.touch.y = loc.y
      this.touch.dragged = true
      return
    }
    const p = this.mouse
    p.x = loc.x
    p.y = loc.y
    if (p.down && Math.hypot(p.x - p.startX, p.y - p.startY) > CLICK_SLOP_PX) {
      p.dragged = true
      this.aimWorld = uiToWorld(loc.x, loc.y)
      this.aiming = true
    }
  }

  private onTouchEnd(e: EventTouch): void {
    const loc = e.getUILocation()
    if (loc.x < VIEW_W / 2) {
      this.touch.down = false
      return
    }
    const p = this.mouse
    p.down = false
    this.aiming = false
    const heldMs = nowMs() - p.downAt
    if (p.dragged) {
      this.pendingAttach = new CcVec2(loc.x, loc.y)
    } else if (heldMs >= HOLD_MS) {
      // 按住不放 = 收丝（设计 §3.1）；松手时补一拍，手感上不会"提前停"
      this.reelPulseDir = 'in'
      this.reelPulse = 2
    } else {
      this.pendingCutPoint = new CcVec2(loc.x, loc.y)
    }
  }

  // ── 采样 ────────────────────────────────────────────

  /**
   * 产出一帧输入。**每个物理 tick 调用一次**，所以在一次渲染帧里连续跑多个
   * 固定步时，只有第一步会携带一次性事件（牵/断），这正是我们要的确定性语义。
   */
  sample(sc: M0Scenario): InputFrame {
    let moveX = this.moveXFromKeys()
    if (this.touch.down) {
      const dx = this.touch.x - this.touch.startX
      moveX = sanitizeMoveX(dx / STICK_RADIUS_PX)
    }

    let attachPressed = false
    let attachPoint: { x: number; y: number } | null = null
    if (this.pendingAttach !== null) {
      attachPoint = uiToWorld(this.pendingAttach.x, this.pendingAttach.y)
      attachPressed = true
      this.pendingAttach = null
    }

    let cutRope = -1
    if (this.pendingCutPoint !== null) {
      const p = uiToWorld(this.pendingCutPoint.x, this.pendingCutPoint.y)
      cutRope = sc.world.pickRope(p)
      this.pendingCutPoint = null
    }

    let reel: ReelCommand = 'hold'
    if (this.keys.has(KeyCode.SPACE)) reel = 'in'
    else if (this.keys.has(KeyCode.SHIFT_LEFT) || this.keys.has(KeyCode.SHIFT_RIGHT)) reel = 'out'
    if (this.reelPulse > 0) {
      reel = this.reelPulseDir
      this.reelPulse--
    }

    return makeFrame({
      moveX,
      aimPoint: attachPoint,
      attachPressed,
      reel,
      cutRope,
      focus: this.keys.has(KeyCode.KEY_F),
    })
  }

  /** 是否有可用的瞄准点（渲染层用来画瞄准线）。 */
  get isAiming(): boolean {
    return this.aiming
  }

  /** 单次固定步之间的收放脉冲衰减由 sample() 负责，这里只暴露 DT 供调用方参考。 */
  static readonly fixedDt = DT
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
