/**
 * 《牵丝》—— 文字标签池。
 *
 * `Graphics` 画不了字，所以"给小字标签"这件事必须用 `Label` 节点。
 * 每帧 `new Node()` 会疯狂产生垃圾（还会污染层级管理器），所以这里做一个**池**：
 * 标签数是固定的小数字（5 个按钮 + 十来个刚体 + 沟的名字），一次性建好，
 * 之后每帧只改 `string` 与 `position`。
 *
 * 位置口径：**UI 坐标（左下角为原点）**，内部用 `uiToLocal()` 转成节点局部坐标。
 * 与 `core/hud.ts` 的按钮几何同一套口径，避免"按钮在 A 处、字在 B 处"。
 *
 * 本文件认识 `cc`。标签是**灰盒阶段的读图辅助**（第 13 轮实机反馈
 * 「分不清哪个是石头哪个是罐头哪个是敌人」），R2 做美术时整层关掉即可。
 */

import { Color, Label, Layers, Node, UITransform } from 'cc'
import { uiToLocal } from './Coordinates'

export interface LabelSpec {
  /** 稳定标识（同一 key 复用同一个节点，不闪）。 */
  readonly key: string
  readonly text: string
  /** UI 坐标（左下角为原点）。 */
  readonly x: number
  readonly y: number
  readonly size: number
  readonly color: Color
}

interface Slot {
  readonly node: Node
  readonly label: Label
  key: string | null
}

export class LabelLayer {
  private readonly slots: Slot[] = []

  constructor(parent: Node) {
    // 先建一批：够用即可（5 按钮 + 14 刚体 + 2 地名）。
    for (let i = 0; i < 28; i++) this.slots.push(this.makeSlot(parent, i))
  }

  private makeSlot(parent: Node, i: number): Slot {
    const node = new Node(`Label${i}`)
    // ⚠️ 运行时代码建的节点默认在 `DEFAULT` 层，Canvas 相机看不见（必须显式 UI_2D）。
    node.layer = Layers.Enum.UI_2D
    node.parent = parent
    const ui = node.addComponent(UITransform)
    ui.setAnchorPoint(0.5, 0.5)
    ui.setContentSize(240, 40)
    const label = node.addComponent(Label)
    label.useSystemFont = true
    label.fontSize = 22
    label.lineHeight = 26
    label.horizontalAlign = Label.HorizontalAlign.CENTER
    label.verticalAlign = Label.VerticalAlign.CENTER
    label.enableWrapText = false
    node.active = false
    return { node, label, key: null }
  }

  /**
   * 用这一帧的标签覆盖池子。
   *
   * 复用规则：**按 key 复用**（同一个 key 每帧拿到同一个 slot），
   * 多出来的 slot 关掉。这样文字不会因为顺序变化而闪烁。
   */
  sync(specs: readonly LabelSpec[]): void {
    const used = new Set<Slot>()
    // 两趟：先给每个 key 找它上次用的 slot，再补空缺。
    for (const spec of specs) {
      let slot = this.slots.find((s) => s.key === spec.key && !used.has(s))
      if (slot === undefined) slot = this.slots.find((s) => !used.has(s))
      if (slot === undefined) break // 池子满了：宁可少画几个，也不每帧 new Node
      slot.key = spec.key
      used.add(slot)
      this.apply(slot, spec)
    }
    for (const s of this.slots) {
      if (used.has(s)) continue
      s.key = null
      s.node.active = false
    }
  }

  private apply(slot: Slot, spec: LabelSpec): void {
    const p = uiToLocal(spec.x, spec.y)
    slot.node.setPosition(p.x, p.y, 0)
    slot.node.active = spec.text.length > 0
    slot.label.string = spec.text
    slot.label.fontSize = spec.size
    slot.label.lineHeight = Math.round(spec.size * 1.2)
    slot.label.color = spec.color
  }
}
