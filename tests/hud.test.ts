/**
 * 屏幕几何：取景、按钮布局、坐标换算。
 *
 * 这一组测试守的是**第 13 轮实机反馈里的两个真 bug**（都是"看代码看不出来、
 * 只有真的看一眼屏幕才会发现"的那一类）：
 *
 *   1. **深沟完全不显示**：取景窗口的左下角钉在世界 (0,0)，而地面顶面就在 y=0，
 *      于是整个可玩带贴在屏幕最下沿、`y < 0` 的沟被切在屏幕外。
 *      创始人原话：「我看不到沟在哪里」。
 *   2. **HUD 画在屏幕外**：丝位圆点与张力条把"UI 坐标"当"节点局部坐标"用，
 *      算出来的 y ≈ 1035 落在屏幕上方之外。玩家从来没见过它。
 *
 * 这两条现在都有断言守着。它们不依赖 Cocos（`Coordinates.ts` 是纯数学），
 * 所以能在本机跑。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHASM_LEFT_X,
  CHASM_RIGHT_X,
  VIEW_H,
  VIEW_ORIGIN_Y,
  VIEW_W,
  M0_ROOM_H,
} from '../assets/scripts/core/constants'
import { HUD_BUTTONS, buttonAt, pointInButton } from '../assets/scripts/core/hud'
import { PrologueScene } from '../assets/scripts/core/scene_prologue'
import { uiToLocal, uiToWorld, worldToLocal, worldToScreen } from '../assets/scripts/cocos/Coordinates'

// ── 取景 ──────────────────────────────────────────────

test('**地面与深沟都在可见窗口内**（第 13 轮实机反馈 #1 的回归）', () => {
  const ground = worldToScreen({ x: 8, y: 0 })
  assert.ok(ground.y > 0, `地面顶面 y=0 必须在屏幕**之内**，实际屏幕 y=${ground.y}`)
  assert.ok(
    ground.y < VIEW_H * 0.5,
    `地面应该在屏幕下半部（不然上面全是空的），实际 y=${ground.y} / ${VIEW_H}`,
  )

  // 沟要看得见：至少能看到沟口往下 4 米
  const pit = worldToScreen({ x: (CHASM_LEFT_X + CHASM_RIGHT_X) / 2, y: VIEW_ORIGIN_Y + 0.2 })
  assert.ok(pit.y >= 0, '沟底一侧必须在屏幕内（否则玩家看不到"这里有个洞"）')
  const pitTop = worldToScreen({ x: 18, y: 0 })
  assert.ok(pitTop.y - pit.y > 200, `沟在屏幕上至少要有 200px 高，实际 ${pitTop.y - pit.y}px`)
})

test('主横梁（y≈13）在可见窗口内，天花板允许在屏幕外', () => {
  const beamTop = worldToScreen({ x: 9, y: 13.6 })
  assert.ok(beamTop.y <= VIEW_H + 1, `横梁顶面不该被切掉，实际 ${beamTop.y} > ${VIEW_H}`)
  const ceil = worldToScreen({ x: 16, y: M0_ROOM_H })
  assert.ok(ceil.y > VIEW_H, '天花板在屏幕外是**预期**的：它只负责封闭碰撞')
})

test('坐标换算是自洽的：世界 ↔ 屏幕 ↔ UI ↔ 局部 往返一致', () => {
  const p = { x: 12.5, y: 3.25 }
  const s = worldToScreen(p)
  const back = uiToWorld(s.x, s.y)
  assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9, 'UI ↔ 世界 必须往返一致')

  const local = worldToLocal(p)
  const fromLocal = uiToLocal(s.x, s.y)
  assert.ok(
    Math.abs(local.x - fromLocal.x) < 1e-9 && Math.abs(local.y - fromLocal.y) < 1e-9,
    'worldToLocal 与 uiToLocal∘worldToScreen 必须是同一个点',
  )
})

test('屏幕四角在局部坐标里确实是 ±(VIEW/2)', () => {
  const bl = worldToLocal(uiToWorld(0, 0))
  assert.ok(Math.abs(bl.x + VIEW_W / 2) < 1e-9, '左下角 x 应为 −960')
  const tr = uiToLocal(VIEW_W, VIEW_H)
  assert.ok(Math.abs(tr.x - VIEW_W / 2) < 1e-9 && Math.abs(tr.y - VIEW_H / 2) < 1e-9)
})

// ── 屏幕按钮 ──────────────────────────────────────────

test('五个按钮都在屏幕内，且互不重叠（触屏按不到是最糟的 bug）', () => {
  assert.equal(HUD_BUTTONS.length, 5, '左右移动 + 收/放/断')
  for (const b of HUD_BUTTONS) {
    assert.ok(b.x >= 0 && b.y >= 0, `${b.id} 越出左/下边界`)
    assert.ok(b.x + b.w <= VIEW_W, `${b.id} 越出右边界`)
    assert.ok(b.y + b.h <= VIEW_H, `${b.id} 越出上边界`)
    // 底部一排不要挡住"地面"— 按钮高度不能超过屏幕 1/4（这条是手感，不是硬约束）
    assert.ok(b.h < VIEW_H / 4, `${b.id} 太高了，会挡画面`)
  }
  for (let i = 0; i < HUD_BUTTONS.length; i++) {
    for (let j = i + 1; j < HUD_BUTTONS.length; j++) {
      const a = HUD_BUTTONS[i]!
      const c = HUD_BUTTONS[j]!
      const overlap =
        a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h
      assert.ok(!overlap, `${a.id} 与 ${c.id} 重叠了`)
    }
  }
})

test('buttonAt 命中按钮中心；按钮之间的空隙与屏幕中部**不算按钮**（那是瞄准区）', () => {
  const left = HUD_BUTTONS.find((b) => b.id === 'left')!
  assert.equal(buttonAt(left.x + left.w / 2, left.y + left.h / 2)?.id, 'left')

  const cut = HUD_BUTTONS.find((b) => b.id === 'cut')!
  assert.equal(buttonAt(cut.x + cut.w / 2, cut.y + cut.h / 2)?.id, 'cut')

  // 屏幕正中：必须是空的，否则整屏瞄准就被按钮吃掉了
  assert.equal(buttonAt(VIEW_W / 2, VIEW_H / 2), null, '屏幕中央必须留给瞄准')
  // 左下角两个按钮之间
  const right = HUD_BUTTONS.find((b) => b.id === 'right')!
  assert.equal(buttonAt(right.x + right.w, right.y + right.h / 2), null, '按钮之间的缝不该命中')
})

test('边界是左闭右开：相邻按钮的公共边只属于其中一个', () => {
  const right = HUD_BUTTONS.find((b) => b.id === 'right')!
  assert.equal(pointInButton(right, right.x, right.y), true)
  assert.equal(pointInButton(right, right.x + right.w, right.y), false)
})

test('序章里，"站在平台上"的玩家不会落在任何按钮矩形上（按钮不会误吃世界交互）', () => {
  const sc = new PrologueScene()
  // 玩家能站的最低高度就是地面；按钮在屏幕底部，理论上可能盖住地面
  const s = worldToScreen({ x: sc.player.pos.x, y: sc.player.pos.y })
  assert.equal(buttonAt(s.x, s.y), null, '玩家所在的位置不该有按钮')
})
