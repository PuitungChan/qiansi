/**
 * 《牵丝》—— 屏幕按钮布局（**输入与渲染共用同一份几何**）。
 *
 * 为什么要单独一个文件：第 13 轮实机反馈把操作方案换成了"左右两个移动键 + 三个动作键"，
 * 于是**一部分触摸落在按钮上、一部分触摸落在空白处（瞄准）** —— 输入层必须知道
 * 按钮在哪，渲染层必须把按钮画在同一个地方。两处各写一份坐标，早晚会错位，
 * 而错位的表现是"按钮看着能按、实际按不到"，这种 bug 靠看代码是抓不住的。
 *
 * 所以这里的 `HUD_BUTTONS` 是**唯一来源**：
 *   · `cocos/PlayerInput.ts` 用 `buttonAt()` 做命中测试；
 *   · `cocos/GrayboxRenderer.ts` 用同一份矩形画按钮。
 * 两边都只 import 这一个模块，几何不可能对不上。`hud.test.ts` 守着这条性质。
 *
 * 坐标系：逻辑像素，**左下角为原点**（与 Cocos `getUILocation()` 一致）。
 * 本文件不得引入任何引擎依赖。
 */

import { UI_BUTTON_GAP, UI_BUTTON_MARGIN, UI_BUTTON_SIZE, VIEW_H, VIEW_W } from './constants'

/** 按钮标识。前两个是移动，后三个是动作。 */
export type HudButtonId = 'left' | 'right' | 'reelIn' | 'reelOut' | 'cut'

export interface HudButton {
  readonly id: HudButtonId
  /** 按钮画的字（灰盒用，极其短）。 */
  readonly label: string
  /** 左下角坐标（逻辑像素）。 */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

function rect(id: HudButtonId, label: string, x: number, y: number): HudButton {
  return { id, label, x, y, w: UI_BUTTON_SIZE, h: UI_BUTTON_SIZE }
}

const BOTTOM_Y = UI_BUTTON_MARGIN
const STEP = UI_BUTTON_SIZE + UI_BUTTON_GAP

/**
 * 五个按钮的位置。
 *
 * 左下角：◀ ▶ —— 沿用"左手管移动"的直觉，但只占两个方块的面积，
 * 剩下**整个屏幕**都能用来瞄准（这正是创始人抱怨"左半屏被摇杆占掉"要解决的事）。
 * 右下角（从右往左）：断 · 收 · 放 —— 「断」放在最好按的角落。
 */
export const HUD_BUTTONS: readonly HudButton[] = [
  rect('left', '◀', UI_BUTTON_MARGIN, BOTTOM_Y),
  rect('right', '▶', UI_BUTTON_MARGIN + STEP, BOTTOM_Y),
  rect('cut', '断', VIEW_W - UI_BUTTON_MARGIN - UI_BUTTON_SIZE, BOTTOM_Y),
  rect('reelIn', '收', VIEW_W - UI_BUTTON_MARGIN - UI_BUTTON_SIZE - STEP, BOTTOM_Y),
  rect('reelOut', '放', VIEW_W - UI_BUTTON_MARGIN - UI_BUTTON_SIZE - STEP * 2, BOTTOM_Y),
]

/** 点在按钮矩形内？（左闭右开，避免相邻按钮的边界被同时命中） */
export function pointInButton(b: HudButton, x: number, y: number): boolean {
  return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h
}

/**
 * 命中测试：落在哪个按钮上；不在任何按钮上返回 `null`。
 *
 * **顺序固定**（按 `HUD_BUTTONS` 的数组顺序），所以重叠时行为也是确定的。
 */
export function buttonAt(x: number, y: number): HudButton | null {
  for (const b of HUD_BUTTONS) {
    if (pointInButton(b, x, y)) return b
  }
  return null
}
