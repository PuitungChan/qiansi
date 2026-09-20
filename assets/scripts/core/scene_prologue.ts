/**
 * 《牵丝》—— 序章场景（R1 / M1 的实现对象）。
 *
 * 按 **D-043** 分批实现设计 §7 的序章前 12 分钟。当前进度：
 *
 * | 时间段 | 内容 | 状态 |
 * |---|---|---|
 * | 0:00–1:00 | 牵 | ✅ 批 1 |
 * | 1:00–2:00 | 收 | ✅ 批 1 |
 * | 2:00–3:00 | 断（砸碎陶罐） | ✅ 批 1 |
 * | 3:00–5:00 | **第一个墨卒 ★** | ✅ 批 2 |
 * | 5:00–8:00 | 质量差 | ✅ 批 3 |
 * | 8:00–12:00 | 双丝 + 悬吊横梁 + 深沟 | ✅ 批 4 |
 *
 * ## 8:00–12:00 的过沟路线（**这一段的设计结论，见 D-049**）
 *
 * 深沟 6m 宽、玩家没有跳跃 ⇒ 只有用丝才能过去。路线是**两步**，正好用上第二根丝：
 *
 * 1. 站在沟左沿（x≈14.6）连**悬吊横梁**（支点是它的左端 19,10.65）→ 收丝
 *    → 人被拉到沟心之后、横梁正下方（19, ≈9.9），**离地**；
 * 2. 连**对岸吊桩**（28,11）→ **断掉第一根**（不断的话第一根会把人拽回去）→ 收丝
 *    → 被拉到吊桩下方 → 断丝 → 落到右平台。
 *
 * 几何上它必须是两步：从沟左沿到对岸吊桩是 16.7m，超过丝长上限 12m。
 * 这条推导写在 constants.ts 的 `FAR_POST_*` 上——**改那两个常数前先读它**。
 * 注意这一步**不需要荡**：收丝是直接控制，人到不了的地方靠"被拉过去"解决，
 * 与批 3 教的质量差是同一件事。
 *
 * ⚠️ 这不是**唯一**的过法：主横梁（10..26，y≈13）横在沟上方，玩家可以连上它、
 * 收丝吊起来、再沿它横向滑（锚点是"离主角最近的表面点"，会跟着人滑），
 * 最后从平台上方落下。设计 §7 给这一段的定性正是「**一个问题多个解法**」，
 * 所以这是**特性不是漏洞**；但它也意味着"第二根丝"是**方便**而不是**必需**。
 * 这一条留给 8:00 那一段的实机试玩判断（见 D-049 的"待确认"）。
 *
 * ## 两个阶段之间怎么切换（一条需要创始人确认的判断）
 *
 * 设计 §7 用**时间轴**写序章（0:00–1:00、3:00–5:00……）。但这个时间轴是**设计的节奏意图**，
 * 不是可执行的规则——而同一节又写着「**连上后**……提示消失」，说明它更在意"玩家做到了"。
 *
 * 所以本场景用**进度门控**：玩家把牵/收/断三件事都做过之后（`hintStep === 'done'`），
 * 再等 1 秒，墨卒入场。理由：手慢的玩家不该在还没学会"牵"的时候就面对敌人——
 * 那会让 AC-01 测出的不是"会不会自己想"，而是"看不看得懂"。
 *
 * ## 3:00–5:00 是**没有任何提示**的两分钟
 *
 * 设计 §7 原文：「这是整个游戏最重要的一分钟。玩家必须自己把前三个动作串起来。」
 * 唯一的保底是**石头微微发光**（60 秒没动作时触发，**不弹文字**）。
 *
 * 本文件不得引入任何引擎依赖。
 */

import { type Body, aabb, circle } from './body'
import * as C from './constants'
import { advanceHints, createHintState, hintStep, hintText, type HintState } from './hints'
import type { InputFrame } from './input'
import type { Guidance, PlayableScene } from './playable'
import { Telemetry } from './telemetry'
import { t } from './texts'
import { World, type WorldConfig } from './world'

/** 序章出场位置（米）。全部集中在这里，方便关卡调参。 */
export const PROLOGUE = {
  playerX: 4,
  stoneX: 8,
  /** 陶罐放在投掷方向上 ~5m 处：够远到必须"扔"，又远在射程内（D-039 的有效射程 ~15m）。 */
  jarX: 13,
} as const

/** 三件事都学会之后，墨卒入场前留的一拍（tick）。给玩家一秒钟意识到"我成了"。 */
const ENCOUNTER_DELAY_TICKS = 60

/** 调试可跳的段落（`cocos/Bootstrap.ts` 的数字键按这个顺序绑定 1..5）。 */
const SKIP_STAGES: readonly string[] = ['tutorial', 'encounter', 'massdiff', 'dual', 'cleared']

export type PrologueStage =
  /** 0:00–3:00：教牵/收/断，有提示 */
  | 'tutorial'
  /** 3:00–5:00：墨卒入场，**零提示** */
  | 'encounter'
  /** 5:00–8:00：质量差教学（重梁柱 vs 轻陶罐），**零提示** */
  | 'massdiff'
  /** 8:00–12:00：双丝 + 悬吊横梁 + 深沟（= 门），**零提示** */
  | 'dual'
  /** 已穿过深沟（D-041：这就是通关） */
  | 'cleared'

interface Spawn {
  readonly body: Body
  readonly x: number
  readonly y: number
  readonly removed: boolean
}

export class PrologueScene implements PlayableScene {
  readonly world: World
  readonly player: Body
  /** 唯一的弹丸。设计 §7 0:00「空场景。一块石头。」 */
  readonly stone: Body
  /** 可破坏场景物。设计 §7 2:00–3:00 的靶子。 */
  readonly jar: Body
  /** 第一个敌人。设计 §7 3:00–5:00，质量 1 / HP 5（附录 B「一下死，它是教学工具」）。 */
  readonly mote: Body
  /**
   * **梁柱**（设计 §2.6 / §7 5:00–8:00）：名义质量 60 的不可动结构。
   * 连上它收丝 → **你被拉过去**（"重的东西用来移动"）。
   */
  readonly beam: Body
  /**
   * **轻陶罐**（设计 §7 5:00–8:00）：质量 0.6，可附着。
   * 连上它收丝 → **它被拉过来**（"轻的东西用来打"）。
   * 与梁柱构成"质量差"的对照——这一幕**不需要任何文字**。
   */
  readonly pot: Body
  /** **悬吊横梁**（设计 §7 8:00–12:00）：挂在深沟上方，过沟的**第一步**。 */
  readonly swingBeam: Body
  /** **对岸吊桩**（8:00–12:00）：右平台上方的固定锚点，过沟的**第二步**。 */
  readonly farPost: Body
  /** **沟对面的第二个墨卒**（8:00–12:00）：站在对岸当靶子。 */
  readonly mote2: Body

  /** AC-01 埋点（D-042）。 */
  readonly telemetry = new Telemetry()

  private stage: PrologueStage = 'tutorial'
  private hints: HintState = createHintState()
  private encounterCountdown = -1
  private massDiffCountdown = -1
  private dualCountdown = -1
  private glowLatched = false
  private attachedSinceEncounter = false
  /** 质量差这节课"上到了没有"：两个对照物都连过一次。 */
  private touchedBeam = false
  private touchedPot = false
  /** 掉进沟里的次数（埋点与调试用）。 */
  private falls = 0
  /** 对岸墨卒的巡逻方向。 */
  private mote2Dir = -1

  private readonly spawns: Spawn[] = []

  constructor(config: Partial<WorldConfig> = {}) {
    // 序章**预建 2 个丝位**（FR-PRG-006 的 1→2），但开局只解锁 1 个；
    // 8:00 的双丝段把 `unlockedRopes` 提到 2。
    // 预建而不是运行时 push：`ropes` 的下标就是丝位编号，push 会让 HUD 顺序与哈希漂移。
    const cfg: Partial<WorldConfig> = { ...config }
    if ((cfg.ropeCount ?? 0) < 2) cfg.ropeCount = 2
    this.world = new World(cfg)
    this.world.unlockedRopes = 1
    const w = this.world

    // ── 地形：单屏房间制（FR-LVL-004），32m × 18m ──
    //
    // 地面被**深沟**切成两段（设计 §7 8:00–12:00「一道深沟」）。
    // 沟就是序章那道「门」（D-041）：玩家没有跳跃，所以任何宽度的沟都走不过去——
    // 只有理解"用丝"才能过。这就是设计 §6.1 说的「门是唯一的教学手段」。
    const groundLeft = w.addBody({
      name: 'ground-left',
      kind: 'static',
      tag: 'static',
      shape: aabb(C.CHASM_LEFT_X / 2, C.TERRAIN_HALF_H),
      pos: { x: C.CHASM_LEFT_X / 2, y: -C.TERRAIN_HALF_H },
      friction: 0.8,
    })
    const groundRight = w.addBody({
      name: 'ground-right',
      kind: 'static',
      tag: 'static',
      shape: aabb((C.M0_ROOM_W - C.CHASM_RIGHT_X) / 2, C.TERRAIN_HALF_H),
      pos: { x: (C.M0_ROOM_W + C.CHASM_RIGHT_X) / 2, y: -C.TERRAIN_HALF_H },
      friction: 0.8,
    })
    const pitFloor = w.addBody({
      name: 'pit-floor',
      kind: 'static',
      tag: 'static',
      // **铺满整个房间**，不只是沟底。
      //
      // 沟底（15..21）本来只是给"掉下去的人"一个落点，但它有个漏洞：
      // 任何物体只要在 y=-12 以下、又恰好落在 x<15 或 x>21，脚下就是虚空，
      // 会**永远下落**（y → -∞ 让状态哈希变成 NaN，AC-05 直接崩）。
      // 批 4 的墨卒就是这么掉出去的。铺满之后，"世界之外"这件事不再存在。
      // 玩家掉沟仍然由 `checkFall` 在 y ≤ -2 时接走，永远落不到这里。
      shape: aabb(C.M0_ROOM_W / 2, C.TERRAIN_HALF_H),
      pos: { x: C.M0_ROOM_W / 2, y: C.CHASM_FLOOR_Y - C.TERRAIN_HALF_H },
      friction: 0.4,
    })
    const ceil = w.addBody({
      name: 'ceiling',
      kind: 'static',
      tag: 'static',
      shape: aabb(C.M0_ROOM_W / 2, C.TERRAIN_HALF_H),
      pos: { x: C.M0_ROOM_W / 2, y: C.M0_ROOM_H + C.TERRAIN_HALF_H },
      friction: 0.2,
    })
    // 侧墙要一直延伸到沟底，否则玩家会从侧面掉出世界
    const wallHalfH = (C.M0_ROOM_H - C.CHASM_FLOOR_Y) / 2
    const wallMidY = (C.M0_ROOM_H + C.CHASM_FLOOR_Y) / 2
    const leftWall = w.addBody({
      name: 'wall-left',
      kind: 'static',
      tag: 'static',
      shape: aabb(C.TERRAIN_HALF_H, wallHalfH),
      pos: { x: -C.TERRAIN_HALF_H, y: wallMidY },
      friction: 0.2,
    })
    const rightWall = w.addBody({
      name: 'wall-right',
      kind: 'static',
      tag: 'static',
      shape: aabb(C.TERRAIN_HALF_H, wallHalfH),
      pos: { x: C.M0_ROOM_W + C.TERRAIN_HALF_H, y: wallMidY },
      friction: 0.2,
    })

    // ── 主角 ──
    const player = w.addBody({
      name: 'player',
      kind: 'dynamic',
      tag: 'player',
      shape: aabb(C.PLAYER_HALF_W, C.PLAYER_HALF_H),
      pos: { x: PROLOGUE.playerX, y: C.PLAYER_HALF_H + 0.01 },
      mass: C.PLAYER_MASS_AIRBORNE,
      friction: 0.5,
      restitution: 0,
    })
    w.setPlayer(player)

    // ── 石块：设计 §2.6 质量 4，万用弹丸 ──
    const stone = w.addBody({
      name: 'stone',
      kind: 'dynamic',
      tag: 'prop',
      shape: circle(0.5),
      pos: { x: PROLOGUE.stoneX, y: 0.51 },
      mass: 4,
      friction: C.PROP_FRICTION,
      restitution: 0.1,
      anchorable: true,
    })

    // ── 陶罐（本段当作**可破坏靶子**使用）────────────────────
    //
    // ⚠️ 第 14 轮按创始人实机反馈改了三处：
    //   ① **做成静态靶子（推不动）**。原话「第二，墨卒移动会把陶罐推进沟里」，
    //      实测到的推手有两个：墨卒（已用位置护栏挡住）、**以及在地上滚的石块**
    //      —— 只要罐子还是动态的，"被推过沟沿"这件事就永远堵不干净。
    //      做成静态之后它**物理上不可能**被推进沟里。
    //      代价说清楚：静态的它**没有"轻"的手感**（收丝会把你拉过去，而不是把它拉过来）。
    //      质量差教学用的是 5:00 给出的那个**轻陶罐 `pot`**（仍然是动态 0.6），两者角色不同。
    //   ② **保持不可附着**。我上一轮一度改成可附着（因为原话「丝线附着不上陶罐」），
    //      但创始人随后明确要求"就按你原来的方案设计成不可吸附"。它是靶子，不是锚点；
    //      标签也改成「靶」，免得玩家以为它能勾。见 D-058 的修订。
    //   ③ **易碎**（`fragile: true`）：撞到就碎。
    //      没有这一条时它要 **v ≥ 15 m/s** 才会碎（冲击被 `min(4, 0.6)=0.6 < 3` 挡下，
    //      只剩切割，而切割门槛是 15）—— 而实测玩家朝目标方向的正常甩投是 **15~16 m/s**，
    //      且只有约 2/3 的手法能做到 ⇒ 第一课"砸碎陶罐"时灵时不灵，创始人原话「砸不碎陶罐」。
    const jar = w.addBody({
      name: 'jar',
      kind: 'static',
      tag: 'prop',
      shape: circle(0.3),
      pos: { x: PROLOGUE.jarX, y: 0.31 },
      damageMass: 0.6, // 设计 §2.6 的口径质量（静态刚体的 mass 是 0，见 D-047 的做法）
      friction: C.PROP_FRICTION,
      restitution: 0.1,
      anchorable: false,
      hp: 1,
      weakness: 'any',
      shattersOnDeath: true,
      fragile: true,
    })

    // ── 墨卒：**构造时就建好，但先 `removed`** ────────────────
    //
    // 为什么不等到遭遇战再 addBody：**`bodies` 数组的下标就是刚体 id**，
    // 中途 push 一个进去会让求解器顺序改变、哈希漂移（AC-05 直接崩）。
    // 所以先占好 id，用 `removed` 控制它是否"存在于场上"。
    const mote = w.addBody({
      name: 'mote',
      kind: 'dynamic',
      tag: 'enemy',
      shape: circle(0.4),
      pos: { x: C.PROLOGUE_MOTE_SPAWN_X, y: 0.41 },
      mass: C.MOTE_MASS,
      friction: 0.4,
      restitution: 0.05,
      anchorable: false, // R1 阶段敌人不可被牵（D-038）
      hp: C.MOTE_HP,
      weakness: 'any', // 设计 §4.1：墨卒「弱点：任意」
      vulnerable: true, // 教学敌人：撞上就掉血，不做门槛判定（见 Body.vulnerable）
    })
    mote.removed = true

    // ── 梁柱：**不可动的结构**（设计 §2.6 定性为"锚点与移动手段"）────
    //
    // 为什么 static：见 constants.ts 里 BEAM_* 的推导——设计 §2.2 与 §7
    // 在"谁被拉过去"上互相矛盾，取 §2.6 的定性（它是锚点）才能让 §7 成立。
    //
    // 为什么横在高处（y≈13）而不是竖在地上：
    // ① 竖在地上的柱子会挡住墨卒的行走路线与投掷弹道；
    // ② 从下方收丝时，拉力有明显向上分量 → 玩家**被拽离地面** →
    //    "离地"状态与后续的摆荡才有起点（设计 §4.2 摆荡要求"离地状态"）。
    const beam = w.addBody({
      name: 'beam',
      kind: 'static',
      tag: 'static',
      shape: aabb(C.BEAM_HALF_W, C.BEAM_HALF_H),
      pos: { x: C.BEAM_CENTER_X, y: C.BEAM_CENTER_Y },
      damageMass: C.BEAM_DAMAGE_MASS, // 名义质量 60（静态刚体的 mass 是 0）
      friction: 0.4,
      anchorable: true,
    })

    // ── 轻陶罐：质量差教学的"轻"那一端（5:00 才给出，先 removed）──
    const pot = w.addBody({
      name: 'pot',
      kind: 'dynamic',
      tag: 'prop',
      shape: circle(C.POT_RADIUS),
      pos: { x: C.POT_SPAWN_X, y: C.POT_RADIUS + 0.01 },
      mass: C.POT_MASS,
      friction: C.PROP_FRICTION,
      restitution: 0.1,
      anchorable: true,
    })
    pot.removed = true

    // ── 悬吊横梁（设计 §7 8:00–12:00）──────────────────────
    //
    // 挂在深沟上方、**左端落在沟心之后**（19, 10.65）。它是过沟的第一步：
    // 站在沟左沿连上它、收丝，人就被拉到沟心之后、离地 10m 的位置，
    // 从那里才够得着对岸横梁（第二步）。几何推导见 constants.ts。
    const swingBeam = w.addBody({
      name: 'swing-beam',
      kind: 'static',
      tag: 'static',
      shape: aabb(C.SWING_BEAM_HALF_W, C.SWING_BEAM_HALF_H),
      pos: { x: C.SWING_BEAM_CENTER_X, y: C.SWING_BEAM_CENTER_Y },
      friction: 0.4,
      anchorable: true,
    })

    // ── 对岸吊桩（8:00–12:00 过沟的**第二步**）──────────
    //
    // 它必须**远到"从沟左沿一步够不着"**（16.7m > 12m 上限），否则深沟就不是门；
    // 又必须**近到"从悬吊横梁下够得着"**（8.7m）。它做得比附着容差小，
    // 所以锚点是它的中心——一个固定的落点，人挂在它下面、断丝就能直直落到平台上。
    const farPost = w.addBody({
      name: 'far-post',
      kind: 'static',
      tag: 'static',
      shape: aabb(C.FAR_POST_HALF_W, C.FAR_POST_HALF_H),
      pos: { x: C.FAR_POST_CENTER_X, y: C.FAR_POST_CENTER_Y },
      friction: 0.4,
      anchorable: true,
    })

    // ── 第二个墨卒：站在**沟对面**（8:00 才入场）──────────────
    const mote2 = w.addBody({
      name: 'mote2',
      kind: 'dynamic',
      tag: 'enemy',
      shape: circle(0.4),
      pos: { x: C.MOTE2_SPAWN_X, y: 0.41 },
      mass: C.MOTE_MASS,
      friction: 0.4,
      restitution: 0.05,
      anchorable: false,
      hp: C.MOTE_HP,
      weakness: 'any',
      vulnerable: true,
    })
    mote2.removed = true

    this.player = player
    this.stone = stone
    this.jar = jar
    this.mote = mote
    this.beam = beam
    this.pot = pot
    this.swingBeam = swingBeam
    this.farPost = farPost
    this.mote2 = mote2
    this.spawns.push(
      { body: groundLeft, x: groundLeft.pos.x, y: groundLeft.pos.y, removed: false },
      { body: groundRight, x: groundRight.pos.x, y: groundRight.pos.y, removed: false },
      { body: pitFloor, x: pitFloor.pos.x, y: pitFloor.pos.y, removed: false },
      { body: ceil, x: ceil.pos.x, y: ceil.pos.y, removed: false },
      { body: leftWall, x: leftWall.pos.x, y: leftWall.pos.y, removed: false },
      { body: rightWall, x: rightWall.pos.x, y: rightWall.pos.y, removed: false },
      { body: player, x: player.pos.x, y: player.pos.y, removed: false },
      { body: stone, x: stone.pos.x, y: stone.pos.y, removed: false },
      { body: jar, x: jar.pos.x, y: jar.pos.y, removed: false },
      { body: mote, x: mote.pos.x, y: mote.pos.y, removed: true },
      { body: beam, x: beam.pos.x, y: beam.pos.y, removed: false },
      { body: pot, x: pot.pos.x, y: pot.pos.y, removed: true },
      { body: swingBeam, x: swingBeam.pos.x, y: swingBeam.pos.y, removed: false },
      { body: farPost, x: farPost.pos.x, y: farPost.pos.y, removed: false },
      { body: mote2, x: mote2.pos.x, y: mote2.pos.y, removed: true },
    )

    w.settle(12)
  }

  // ── 主循环 ──────────────────────────────────────────

  step(input: InputFrame): void {
    this.advanceStage()
    this.scriptMote()
    this.scriptMote2()

    this.world.step(input)

    advanceHints(this.hints, input, this.world.events)
    this.trackEncounter(input)
    this.updateGlow()
    this.checkFall()
    this.checkCleared()

    this.telemetry.consume(this.world, input)

    // 引导埋点：记下每句提示**第一次**出现的时刻。
    // AC-01 的"无提示"版本靠它算（见 D-058 与 telemetry.ac01UnaidedSeconds）。
    // 必须放在 consume **之后**：run_start 是 consume 里惰性起的头，
    // 放到前面会让"这条时间线的第一条事件"变成 hint_shown（确定性回放测试会红）。
    this.telemetry.markHint(this.world.tick, this.stepKey())
  }

  /** 教学阶段 → 遭遇战 → 质量差 → 双丝。见文件头"进度门控"的说明。 */
  private advanceStage(): void {
    switch (this.stage) {
      case 'tutorial':
        this.advanceFromTutorial()
        break
      case 'encounter':
        this.advanceFromEncounter()
        break
      case 'massdiff':
        this.advanceFromMassDiff()
        break
      default:
        break
    }
  }

  private advanceFromTutorial(): void {
    if (this.encounterCountdown < 0) {
      if (hintStep(this.hints) !== 'done') return
      this.encounterCountdown = ENCOUNTER_DELAY_TICKS
      return
    }

    this.encounterCountdown--
    if (this.encounterCountdown > 0) return

    // 墨卒入场
    this.stage = 'encounter'
    this.mote.removed = false
    this.mote.pos = { x: C.PROLOGUE_MOTE_SPAWN_X, y: 0.41 }
    this.mote.vel = { x: 0, y: 0 }
    this.telemetry.startEncounter(this.world.tick)
  }

  /**
   * 遭遇战结束 → 质量差。
   *
   * **出口只有一个：墨卒被击杀。**（第 13 轮反馈：「无需再有时间线，玩家完成上一个操作
   * 就进入下一个场景」——原先那条 `ENCOUNTER_MAX_SEC = 120` 的到点兜底已删除。）
   *
   * 也就是说，一个想不到用石头的玩家会**一直停在 3:00**。这是刻意的：
   * 这一段正是设计 §7 那句「这是整个游戏最重要的一分钟。玩家必须自己把前三个动作串起来」
   * ——AC-01 要量的就是"他会不会自己想到"。为了人工检查后面的内容，
   * 调试面板的跳段键与 `skipTo()` 另有一条路。
   */
  private advanceFromEncounter(): void {
    if (this.mote.alive) return
    if (this.massDiffCountdown < 0) {
      this.massDiffCountdown = ENCOUNTER_DELAY_TICKS
      return
    }
    this.massDiffCountdown--
    if (this.massDiffCountdown > 0) return

    // 质量差段：给出轻陶罐（梁柱一直在场上，它是结构）
    this.stage = 'massdiff'
    this.pot.removed = false
    this.pot.pos = { x: C.POT_SPAWN_X, y: C.POT_RADIUS + 0.01 }
    this.pot.vel = { x: 0, y: 0 }
    this.telemetry.markStage(this.world.tick, 'massdiff')
  }

  /**
   * 质量差 → 双丝。
   *
   * 出口：**这节课上到了** —— 玩家把梁柱和轻陶罐**都连过一次**
   * （亲身体会到"一个把你拉过去、一个被你拉过来"）。原先的三分钟兜底已随
   * "不要时间线"一起删除。用"两个都摸过"而不是"摸过任意一个"，
   * 是因为质量差这个知识点**必须成对才成立**。
   */
  private advanceFromMassDiff(): void {
    if (!(this.touchedBeam && this.touchedPot)) return
    if (this.dualCountdown < 0) {
      this.dualCountdown = ENCOUNTER_DELAY_TICKS
      return
    }
    this.dualCountdown--
    if (this.dualCountdown > 0) return

    // 双丝段：解锁第二根丝（FR-PRG-006 的 1→2），放出对岸的墨卒
    this.stage = 'dual'
    this.world.unlockedRopes = Math.min(2, this.world.ropes.length)
    this.mote2.removed = false
    this.mote2.pos = { x: C.MOTE2_SPAWN_X, y: 0.41 }
    this.mote2.vel = { x: 0, y: 0 }
    this.telemetry.markStage(this.world.tick, 'dual')
  }

  /**
   * **调试跳段**：直接把场景推进到指定段落，供人工检查后面的内容。
   *
   * 为什么需要它：段落出口改成纯进度门控之后，一个卡在 3:00 的人看不到后面两段。
   * 这个方法是**开发者工具**，不是游戏机制——玩家路径上没有任何东西会调用它
   * （`cocos/Bootstrap.ts` 的数字键才是入口）。跳段同样会补齐该段应有的前置状态
   * （陶罐给出、第二根丝解锁、对岸墨卒入场），所以从哪一段开始都能正常玩下去。
   */
  skipTo(stage: PrologueStage): void {
    const order: PrologueStage[] = ['tutorial', 'encounter', 'massdiff', 'dual', 'cleared']
    if (order.indexOf(stage) < 0) return

    if (stage === 'tutorial') {
      this.reset()
      return
    }

    // 先把前面几段该发生的事一次性补上
    this.hints.everAttached = true
    this.hints.everReeled = true
    this.hints.everCut = true
    this.encounterCountdown = -1
    this.massDiffCountdown = -1
    this.dualCountdown = -1

    // 遭遇战
    this.stage = 'encounter'
    this.mote.removed = false
    this.mote.pos = { x: C.PROLOGUE_MOTE_SPAWN_X, y: 0.41 }
    this.mote.vel = { x: 0, y: 0 }
    this.telemetry.startEncounter(this.world.tick)

    if (stage === 'encounter') return

    // 质量差：墨卒算已解决（把"打完"这件事补上）
    this.mote.hp = 0
    this.mote.alive = false
    this.stage = 'massdiff'
    this.pot.removed = false
    this.pot.pos = { x: C.POT_SPAWN_X, y: C.POT_RADIUS + 0.01 }
    this.pot.vel = { x: 0, y: 0 }
    this.touchedBeam = true
    this.touchedPot = true
    this.telemetry.markStage(this.world.tick, 'massdiff')

    if (stage === 'massdiff') return

    // 双丝
    this.stage = 'dual'
    this.world.unlockedRopes = Math.min(2, this.world.ropes.length)
    this.mote2.removed = false
    this.mote2.pos = { x: C.MOTE2_SPAWN_X, y: 0.41 }
    this.mote2.vel = { x: 0, y: 0 }
    this.telemetry.markStage(this.world.tick, 'dual')

    if (stage === 'dual') return

    // 已通关：直接站在对岸平台上，并把段落本身也切过去
    this.player.pos = { x: C.CHASM_RIGHT_X + 2, y: C.PLAYER_HALF_H + 0.01 }
    this.player.vel = { x: 0, y: 0 }
    this.stage = 'cleared'
    this.telemetry.markStage(this.world.tick, 'cleared')
    this.telemetry.end(this.world.tick)
  }

  /**
   * **过关**（D-041）：穿过深沟、**站到对岸平台上** = 通关。
   * 敌人不必清空——这与设计 §6.1「『门』是唯一的教学手段」和
   * 「无丝」（纯环境击杀）命名都一致。
   *
   * 判定要**同时**满足"着地"和"高度在对岸平台附近"，不能只看着地：
   * 沟上方挂着悬吊横梁与主横梁，玩家完全可以站在 9 米高的梁上——
   * 那也 `grounded`，但那是"站在梁上"，不是"过了沟"。
   * 实测中漏掉高度这一条时，收丝贴到主横梁上的玩家在 12 米高处被判了通关。
   */
  private checkCleared(): void {
    if (this.stage === 'cleared') return
    if (this.stage !== 'dual') return
    if (!this.player.grounded) return
    if (this.player.pos.x < C.CHASM_RIGHT_X + 0.5) return
    if (this.player.pos.y > C.CHASM_CLEAR_MAX_Y) return
    this.stage = 'cleared'
    this.telemetry.markStage(this.world.tick, 'cleared')
    this.telemetry.end(this.world.tick)
  }

  /**
   * 掉进沟里 → **软重生**（不是死亡）。
   *
   * R1 不实现主角承伤与死亡（D-040），而且设计 §11.2 明确写着
   * 「主角可以随时用丝位移逃命，**容错来自移动而非攻击**」。
   * 惩罚一个还在学操作的人会让 AC-01 测出的东西变味，所以这里只把他放回沟边。
   *
   * 第 14 轮补：**可动物件也一起救回来**。
   * 它们掉进沟底就再也拿不到了（沟深 12 米、玩家不会跳），而段落是**纯进度门控**
   * （D-054）—— 也就是说"把石块扔进沟里"会变成**死局**。深沟不是垃圾桶。
   * 主角放回沟边、物件放回出生点，规则一致：掉下去不是惩罚，只是白费一次。
   */
  private checkFall(): void {
    if (this.player.pos.y <= C.CHASM_FALL_Y && this.inChasm(this.player.pos.x)) {
      this.falls++
      this.player.pos = { x: C.CHASM_RESPAWN_X, y: C.PLAYER_HALF_H + 0.05 }
      this.player.vel = { x: 0, y: 0 }
      this.player.grounded = false
      this.telemetry.markFall(this.world.tick, this.falls)
    }

    for (const s of this.spawns) {
      const b = s.body
      if (b === this.player || b.kind === 'static' || b.removed) continue
      // 掉进沟里 ⇒ 送回出生点（纯进度门控下，否则"把石块扔进沟里"就是死局）；
      // **世界之下**（比沟底还低）也算掉出去 —— 加厚地形之后应该到不了那里，
      // 但这是最后一道保险：一旦有东西到了这里，它只会永远下落
      // （y → −∞ 会让状态哈希变成 NaN，AC-05 直接崩）。见 `TERRAIN_HALF_H`。
      const inChasm = this.inChasm(b.pos.x) && b.pos.y <= C.CHASM_FALL_Y
      const belowWorld = b.pos.y < C.CHASM_FLOOR_Y - C.TERRAIN_HALF_H - 1
      if (!inChasm && !belowWorld) continue
      b.pos = { x: s.x, y: s.y }
      b.vel = { x: 0, y: 0 }
      b.grounded = false
    }
  }

  private inChasm(x: number): boolean {
    return x > C.CHASM_LEFT_X && x < C.CHASM_RIGHT_X
  }

  /** 沟对面的墨卒：在右平台上缓慢往返（不追人——它在对岸当靶子）。 */
  private scriptMote2(): void {
    const m = this.mote2
    if (m.removed || !m.alive) {
      m.vel = { x: 0, y: m.vel.y }
      return
    }
    if (m.pos.x <= C.MOTE2_PATROL_MIN_X) this.mote2Dir = 1
    else if (m.pos.x >= C.MOTE2_PATROL_MAX_X) this.mote2Dir = -1
    m.vel = { x: this.mote2Dir * C.MOTE2_PATROL_SPEED, y: m.vel.y }
  }

  /**
   * 墨卒的行为：**朝主角缓慢爬来**（设计 §7「一个墨卒从右侧缓慢爬来」），
   * 到跟前就停下——它是教学工具，不该挤到玩家身上。
   * 全部由脚本驱动，无随机 ⇒ 确定性不受影响。
   *
   * **不许越过沟沿**（`PROLOGUE_MOTE_LEDGE_GUARD_X`）：深沟（批 4）把左平台切到 x=15 为止，
   * 而它只会盯着主角走。玩家一旦跑到平台右端，它就会跟着走出去、掉沟、永远下落——
   * 表现为"这一关的敌人没了，AC-01 永远达不成"。所以脚本驱动的东西要有护栏。
   */
  private scriptMote(): void {
    const m = this.mote
    if (m.removed || !m.alive) {
      m.vel = { x: 0, y: m.vel.y }
      return
    }

    // **硬护栏：位置也不许越线**（第 14 轮补）。
    //
    // 原先只护栏"脚本给的向右速度"，挡不住**接触推挤**：玩家一路往右走，
    // 墨卒被顶着越过沟沿（实测到 x=15.29），陶罐也被它顶着从 13 推到 15.95
    // 掉进沟里 —— 创始人原话「第二，墨卒移动会把陶罐推进沟里」。
    // 脚本驱动的教学怪必须有"不许进这个区域"的硬边界，速度护栏不够。
    if (m.pos.x > C.PROLOGUE_MOTE_LEDGE_GUARD_X) {
      m.pos = { x: C.PROLOGUE_MOTE_LEDGE_GUARD_X, y: m.pos.y }
      if (m.vel.x > 0) m.vel.x = 0
    }

    let vx = 0
    const gap = m.pos.x - this.player.pos.x
    if (gap > C.MOTE_STOP_DISTANCE) vx = -C.MOTE_SPEED
    else if (gap < -C.MOTE_STOP_DISTANCE) vx = C.MOTE_SPEED

    // 护栏：往右走会走出平台就停下（往左永远安全，左边是墙）
    if (vx > 0 && m.pos.x >= C.PROLOGUE_MOTE_LEDGE_GUARD_X) vx = 0
    m.vel = { x: vx, y: m.vel.y }
  }

  private trackEncounter(input: InputFrame): void {
    void input
    for (const e of this.world.events) {
      if (e.kind !== 'rope-attached') continue
      if (this.stage === 'encounter') this.attachedSinceEncounter = true
      if (e.target === this.beam.id) this.touchedBeam = true
      if (e.target === this.pot.id) this.touchedPot = true
    }
  }

  /**
   * 克制提示（设计 §7）：60 秒没有动作 → 石头微微发光，**不弹文字**。
   * 一旦玩家牵上丝线（他开始动手了）就永久熄灭——发光是给**卡住的人**的。
   */
  private updateGlow(): void {
    if (this.stage !== 'encounter' || this.glowLatched) return
    if (!this.telemetry.encounterStarted) return
    const elapsedSec =
      (this.world.tick - this.encounterStartTick()) / C.TICK_HZ
    if (elapsedSec < C.HINT_GLOW_DELAY_SEC) return
    this.glowLatched = true
    this.telemetry.markGlow(this.world.tick)
  }

  private encounterStartTick(): number {
    // encounter_start 是遭遇战的第一条事件，直接取它的 tick
    for (const e of this.telemetry.snapshot()) {
      if (e.kind === 'encounter_start') return e.tick
    }
    return this.world.tick
  }

  // ── 表现层查询 ──────────────────────────────────────

  /**
   * 屏幕中间那一句 = 当前这一步该干什么。
   *
   * 第 14 轮起它**贯穿全程**（创始人：「我完全不知道我该干什么」）。
   * 设计 §7 原来要求"3:00 之后零文字"，那是为了测"玩家会不会自己想到用石头"；
   * 创始人现在明确要教，所以那一条被他自己推翻了（见 texts.ts 的文件头）。
   */
  hint(): string | null {
    return t(this.stepKey())
  }

  /**
   * 当前这一步的**文案键**。
   *
   * 单独抽出来是为了让埋点记**键**而不是文字（`hint_shown` 事件）——
   * 文字会改、键不会；AC-01 的"无提示"版本就是靠 `stepEncounterExplicit` 这个键算的。
   */
  private stepKey(): TextKey {
    switch (this.stage) {
      case 'tutorial': {
        const s = hintStep(this.hints)
        // 第 15 轮：三件事学完就直接进遭遇战，不再有"去砸罐子"那一步
        // （创始人：「砸碎靶子罐头的教程可以去掉了」）。
        if (s === 'done') return 'stepTutorialDone'
        if (s === 'attach') return 'hintAttach'
        if (s === 'reel') return 'hintReel'
        return 'hintCut'
      }
      case 'encounter':
        if (!this.mote.alive) return 'cleared'
        return this.encounterElapsedSec() >= C.ENCOUNTER_EXPLICIT_HINT_SEC
          ? 'stepEncounterExplicit'
          : 'stepEncounterVague'
      case 'massdiff':
        return 'stepMassDiff'
      case 'dual':
        return 'stepDual'
      default:
        return 'cleared'
    }
  }

  /**
   * 整块引导：目标行 + 当前这一步 + 物体作用。
   *
   * 内容的取舍原则：**只教"该干什么"，不教"数值"**。
   * 唯一一处例外是墨卒的 HP（`noteMote`）——因为"一下就能砸死"这件事
   * 直接决定了玩家敢不敢试第一次。
   */
  guidance(): Guidance {
    const step = t(this.stepKey())
    switch (this.stage) {
      case 'tutorial':
        return {
          goal: t('goalTutorial'),
          step,
          // 第 15 轮：不再介绍罐子（它已经不在教程里了）。
          notes: [t('noteStone')],
        }

      case 'encounter':
        return {
          goal: t('goalEncounter'),
          step,
          notes: [t('noteStone'), t('noteMote')],
        }

      case 'massdiff':
        return {
          goal: t('goalMassDiff'),
          step,
          notes: [t('noteBeam'), t('notePot')],
        }

      case 'dual':
        return {
          goal: t('goalDual'),
          step,
          notes: [t('noteChasm'), t('noteSwingBeam'), t('noteFarPost')],
        }

      default:
        return { goal: t('goalCleared'), step, notes: [] }
    }
  }

  private encounterElapsedSec(): number {
    if (!this.telemetry.encounterStarted) return 0
    return (this.world.tick - this.encounterStartTick()) / C.TICK_HZ
  }

  glowBodyId(): number {
    if (!this.glowLatched || this.attachedSinceEncounter) return -1
    if (!this.mote.alive || this.mote.removed) return -1
    return this.stone.id
  }

  // ── 状态查询 ────────────────────────────────────────

  get currentStage(): PrologueStage {
    return this.stage
  }

  get jarBroken(): boolean {
    return !this.jar.alive
  }

  get moteDead(): boolean {
    return !this.mote.alive
  }

  /** 是否已通关（穿过深沟，D-041）。 */
  get cleared(): boolean {
    return this.stage === 'cleared'
  }

  /** 调试跳段：可跳的段落名（见 `skipTo`）。 */
  debugStages(): readonly string[] {
    return SKIP_STAGES
  }

  debugSkip(name: string): void {
    const s = SKIP_STAGES.find((x) => x === name)
    if (s !== undefined) this.skipTo(s as PrologueStage)
  }

  /** 教学进度（调试面板与埋点用）。 */
  hintProgress(): HintState {
    return { ...this.hints }
  }

  // ── 复位 ────────────────────────────────────────────

  reset(): void {
    for (const s of this.spawns) {
      s.body.pos = { x: s.x, y: s.y }
      s.body.vel = { x: 0, y: 0 }
      s.body.grounded = false
      s.body.hp = s.body.maxHp
      s.body.alive = true
      s.body.ignorePlayer = false
      s.body.removed = s.removed
    }
    this.world.tick = 0
    this.world.stunRemaining = 0
    for (const r of this.world.ropes) {
      r.state = 'idle'
      r.targetId = -1
      r.targetLength = 0
      r.length = 0
      r.tension = 0
      r.recongealRemaining = 0
      r.peakTension = 0
      r.lastBreakReason = 'none'
    }
    for (let i = 0; i < this.world.chains.length; i++) this.world.chains[i] = null
    this.hints = createHintState()
    this.stage = 'tutorial'
    this.encounterCountdown = -1
    this.massDiffCountdown = -1
    this.dualCountdown = -1
    this.glowLatched = false
    this.attachedSinceEncounter = false
    this.touchedBeam = false
    this.touchedPot = false
    this.falls = 0
    this.mote2Dir = -1
    this.world.unlockedRopes = 1
    this.telemetry.clear()
    this.world.settle(12)
  }

  summary(): Record<string, number | string> {
    const w = this.world
    const r0 = w.ropes[0]
    return {
      scene: `序章·批4（${this.stage}）`,
      tick: w.tick,
      playerX: this.player.pos.x,
      playerY: this.player.pos.y,
      playerGrounded: this.player.grounded ? 1 : 0,
      playerMass: this.player.mass,
      stoneX: this.stone.pos.x,
      jarBroken: this.jarBroken ? 1 : 0,
      mote: this.mote.removed ? '(未入场)' : `${this.mote.pos.x},hp${this.mote.hp}`,
      pot: this.pot.removed ? '(未给出)' : this.pot.pos.x,
      mote2: this.mote2.removed ? '(未入场)' : `${this.mote2.pos.x},hp${this.mote2.hp}`,
      chasm: `${C.CHASM_LEFT_X}~${C.CHASM_RIGHT_X}`,
      falls: this.falls,
      cleared: this.cleared ? 1 : 0,
      rope1: r0?.state ?? 'none',
      rope2: w.ropes[1]?.state ?? 'none',
      ropeCount: `${w.unlockedRopes}/${w.ropes.length}`,
      ropeTension: r0?.tension ?? 0,
      hint: this.hint() ?? '(无)',
      glow: this.glowBodyId() >= 0 ? '石头' : '-',
      ac01: this.telemetry.ac01Seconds() === null ? '(未达成)' : this.telemetry.ac01Seconds()!,
      hash: w.stateHash(),
    }
  }
}
