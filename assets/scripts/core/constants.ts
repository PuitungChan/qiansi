/**
 * 《牵丝》确定性物理内核 —— 常数表。
 *
 * 这里是**需求文档数值的唯一落地点**：设计文档 §2.4 / §3 / §9、SRS §6.1~§6.3
 * 里的每个数字都必须在这里能找到，并且带来源标注。
 * 任何"魔法数字"出现在其他文件里都是缺陷。
 *
 * 单位制（见 DECISIONS D-018）：
 *   长度 = 米(m) · 质量 = 质量单位(kg 语义) · 时间 = 秒(s) · 力 = 牛顿(N)
 *   g = 20 m/s²  ⇒ 质量 1 的物体重 20 N
 *
 * 本文件不得引入任何引擎依赖。
 */

// ── 时间 ──────────────────────────────────────────────
/** 物理步长固定 1/60s。FR-PHY-008 / D-018。改这个数字等于改掉确定性的前提。 */
export const TICK_HZ = 60
export const DT = 1 / 60

// ── 空间 ──────────────────────────────────────────────
/** 渲染比例：1 米 = 60 逻辑像素。1920×1080 ⇒ 32m × 18m 房间。D-018 */
export const PPM = 60
export const VIEW_W = 1920
export const VIEW_H = 1080

// ── 重力 ──────────────────────────────────────────────
/** 设计 §2.4：g = 20 m/s²，比真实大，2D 手感更好。Y 轴向上，故为负。 */
export const GRAVITY_Y = -20

// ── 主角 ──────────────────────────────────────────────
/** 设计 §2.4：主角质量 m_p = 0.5，全场最轻的可动单位之一。FR-PHY-003 */
export const PLAYER_MASS_AIRBORNE = 0.5
/** 着地时等效质量视为 ∞。用有限大质量实现（D-019）。 */
export const PLAYER_MASS_GROUNDED = 1e6
/** 着地判定阈值：接触法线 y 分量大于此值才算"脚踩实体"。D-019 */
export const GROUNDED_NORMAL_Y = 0.7
/** 主角几何：0.8m × 1.6m 的轴对齐盒（灰盒）。D-025 */
export const PLAYER_HALF_W = 0.4
export const PLAYER_HALF_H = 0.8
/**
 * 丝线的出丝点相对主角中心的抬高量（米）。
 *
 * 为什么不能锚在身体中心：主角中心（y≈0.78）比石块中心（y≈0.48）高不了多少，
 * 若从中心出丝，4m 外收丝的方向几乎是水平的，石块只会被**贴着地面拖**，
 * 永远抬不起来——而设计 §7 明确要求"石头被拉向主角……悬在半空，开始摆动"。
 * 锚在胸口高度后，近距离的拉力有明显向上分量，石块会被提起并摆动。
 */
export const PLAYER_HAND_OFFSET_Y = 0.4
/**
 * 收丝机的"权限"：由**收丝动作本身**能制造的张力上限，占 `T_max` 的比例。
 *
 * 为什么必须有：张力来自弹簧伸长 `T = k·ΔL`，而 ΔL 由"目标丝长"与"实际长度"之差决定。
 * 如果允许玩家把目标丝长一路收到最短，那么只要物体被挡住（顶在墙上、卡在主角身上），
 * ΔL 就会无限增长、张力无限上升——**新手在序章"按住不放"就一定会自己把丝绷断**，
 * 与设计 §7「按住不放 → 石头被拉向主角」的教学节奏直接冲突（实测峰值 752 N）。
 *
 * 物理上的正解是**绞盘在额定负载处堵转**。因此实现为：丝上张力一旦达到
 * `REEL_STALL_RATIO × T_max`，收丝就暂停缩短目标长度；张力降下来又会自动恢复。
 * 于是"按住不放"最多把张力推到 80%（对应设计 §2.4 的"轻微波动"档），
 * 而**超限断弦改由动力学负载触发**——甩动的离心力、急停、被坠落物猛拽。
 * 这才是设计 §2.4 里"超限断弦"的本意：它是**操作失误的惩罚**，不是**新手陷阱**。
 *
 * 取值 0.8 ⇒ 收丝能维持的最大张力 320 N ⇒ 在该张力下的速度上限 `v = √(T·r/m)`，
 * 半径 0.5m 时约 6.3 m/s、半径 5m 时约 20 m/s——**要甩得快就必须在大半径上甩**，
 * 这正是设计 §4.2「流星」要教的东西。
 */
export const REEL_STALL_RATIO = 0.8
/** 设计文档未给主角移动速度，M0 起点值。D-020 —— 待真机调参 */
export const PLAYER_MOVE_SPEED = 6
export const PLAYER_AIR_CONTROL_SPEED = 1.5
/** 目标速度逼近的加速度上限（着地 / 离地）。D-020 */
export const PLAYER_GROUND_ACCEL = 60
export const PLAYER_AIR_ACCEL = 12

// ── 丝线 ──────────────────────────────────────────────
/** 单场景最多 4 根。FR-PHY-010 / 设计 §3.3 */
export const MAX_ROPES = 4
/** Verlet 绳索 8–12 段。FR-PHY-010 */
export const ROPE_SEGMENTS = 10
/** 基础长度 6m，最长 12m。设计 §2.4 */
export const ROPE_LEN_BASE = 6
export const ROPE_LEN_MAX = 12
/** 收丝下限。文档未给，M0 起点值：丝不能收到 0（否则物体贴合主角）。D-020 */
export const ROPE_LEN_MIN = 0.5
/** 收丝速度上限 8 m/s（素丝）/ 14 m/s（疾丝）。FR-PHY-002 */
export const ROPE_REEL_SPEED_BASE = 8
export const ROPE_REEL_SPEED_FAST = 14

/** 弹簧刚度。D-021 / D-028 —— 待创始人拍板 */
export const ROPE_STIFFNESS = 1000
/**
 * 阻尼比 ζ。D-021 / D-028 —— 待创始人拍板。
 *
 * 取值偏小是刻意的：弹簧-阻尼绳在**突然绷紧**时的峰值张力约为 `v·√(k·m)`，
 * 阻尼项在绷紧瞬间还会叠加 `2ζ√(k·m)·v`。ζ 取 0.5 时，玩家只是"跑开拉直丝线"
 * 就会瞬间产生 ~480 N 的张力（实测 383–397 N），把丝绷断——这会让正常移动都在断丝。
 * 取 0.2 后同样动作的峰值约 356 N，留出安全余量，而"故意猛拽"仍能超限断裂。
 */
export const ROPE_DAMPING_RATIO = 0.2
/**
 * 张力上限：素丝 400 / 韧丝 700（FR-PHY-004 / 设计 §2.4）。
 *
 * ⚠️ **这里指的是"显示刻度"，不是牛顿**，物理断裂载荷另见 `TENSION_BREAK_FORCE_BASE`。
 * 设计文档只写"张力值 0–400"，没有写单位。曾经把它当作牛顿（依据是
 * `400 N` 恰好等于墨甲自重 `20 × 20`，见 D-021），但实测定标发现这个口径下
 * **玩家只是向左跑开、把丝拉直，2 个 tick 就超过 400 N 把丝绷断了**——
 * 连正常移动都会断丝，游戏无法进行。详见 D-029 的实测数据与反推过程。
 */
export const TENSION_DISPLAY_MAX_BASE = 400
export const TENSION_DISPLAY_MAX_TOUGH = 700

/**
 * **物理断裂载荷（牛顿）**：素丝 1200 N / 韧丝 2100 N。
 *
 * 反推依据（取设计文档自己的参考算例）：附录 A 把"石块(4) @ 20 m/s"当作一次
 * 正常投掷，而一次自然甩动的半径约 2 m，此时向心力
 * `F = m·v²/r = 4 × 400 / 2 = 800 N`。要让这个正常操作留出约 30% 的余量，
 * 断裂载荷取 `800 / 0.7 ≈ 1143 N`，圆整为 **1200 N**。
 * 韧丝维持设计文档的 400:700 比例 ⇒ `1200 × 700/400 = 2100 N`。
 *
 * 对照检查：
 * | 场景 | 物理张力 | 占上限 |
 * |---|---|---|
 * | 静吊石块（4kg） | 80 N | 7% |
 * | 玩家跑开把丝拉直（6 m/s 绷紧瞬间） | ~379 N | 32% |
 * | 石块 20 m/s @ r=4m | 400 N | 33% |
 * | 石块 20 m/s @ r=2m | 800 N | 67% |
 * | 石块 25 m/s @ r=2m | 1250 N | 104% → **断弦** |
 * | 石块 20 m/s @ r=1m | 1600 N | 133% → **断弦** |
 */
export const TENSION_BREAK_FORCE_BASE = 1200
export const TENSION_BREAK_FORCE_TOUGH = 2100
/** 张力表现分档。FR-PHY-005（R2）—— 内核先算好，渲染层 R1 只画颜色。 */
export const TENSION_WARN_RATIO = 0.6
export const TENSION_SHAKE_RATIO = 0.85
export const TENSION_CRITICAL_RATIO = 0.95
/** 断丝后该丝位重凝 1.5s。FR-PHY-007 */
export const ROPE_RECONGEAL_SEC = 1.5
/** 超限断弦时主角反噬硬直 0.8s。FR-PHY-006 / 设计 §2.4 */
export const BREAK_STUN_SEC = 0.8
/**
 * 牵丝瞄准容差（米）：松手时瞄准点与可附着物中心的距离上限。
 * 文档未给，M0 起点值 —— 取得比物件半径略大，容忍触屏/鼠标的手抖。D-020
 */
export const ROPE_ATTACH_TOLERANCE = 1.2
/**
 * 断丝点击的命中判定半径。FR-ACT-009 要求 ≥ 22 逻辑像素。
 * 22 逻辑像素 ÷ 60 px/m ≈ 0.367 m。
 */
export const ROPE_HIT_RADIUS_M = 22 / PPM
/** 撞击伤害的最小接近速度（m/s）：低于此值视为"贴上去"而不是"砸上去"。 */
export const MIN_IMPACT_SPEED = 0.5

// ── 撞击 / 伤害 ───────────────────────────────────────
/** 冲击伤害要求 m_eff ≥ 3，否则目标纹丝不动。设计 §2.5 */
export const IMPACT_MIN_MASS = 3
/** 冲击伤害分母。D = min(m_att, m_tgt) × v_rel / 4 */
export const IMPACT_DIVISOR = 4
/** 切割伤害要求 v_rel ≥ 15，否则被弹开。设计 §2.5 */
export const CUT_MIN_SPEED = 15
/** 切割伤害分母。D = v_rel² / 60 */
export const CUT_DIVISOR = 60
/** 撕裂要求反向张力差 > 300。FR-CBT-004（R3） */
export const TEAR_TENSION_DIFF = 300
/** 墨巢承重点伤害倍率。设计 §6.2 / 附录 B */
export const NEST_CORE_MULTIPLIER = 3

// ── 碰撞求解 ──────────────────────────────────────────
/** 顺序冲量迭代次数。固定值 ⇒ 确定性。 */
export const SOLVER_ITERATIONS = 8
/** 位置修正的容许穿透（m）。 */
export const SLOP = 0.002
/** 位置修正比例（Baumgarte）。 */
export const BAUMGARTE = 0.25
/** 默认恢复系数与摩擦系数（灰盒）。 */
export const DEFAULT_RESTITUTION = 0.05
export const DEFAULT_FRICTION = 0.6

// ── 预判线 ────────────────────────────────────────────
/** 约 0.3s 轨迹。FR-UI-003 */
export const AIM_PREDICT_SEC = 0.3
/**
 * 预判线采样点个数。
 * 取 9 是因为它能**整除** 0.3s 对应的 18 个物理步（每 2 步一个点），
 * 从而保证采样点在轨迹上等距分布——点线画出来才会匀。见 aim.ts 的 stride 说明。
 */
export const AIM_PREDICT_SAMPLES = 9

// ── 场景 ──────────────────────────────────────────────
/** M0 灰盒房间尺寸（米）。1920×1080 @ 60px/m。 */
export const M0_ROOM_W = 32
export const M0_ROOM_H = 18
