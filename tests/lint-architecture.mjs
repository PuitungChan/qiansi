// 静态体检：所有 .ts 能否被 Node 的类型擦除解析（抓语法错误），
// 以及 core/ 是否真的零引擎依赖（这是 D-017 的架构红线）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

let failures = 0
const files = [...walk(join(root, 'assets')), ...walk(join(root, 'tests'))]
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  try {
    stripTypeScriptTypes(src, { mode: 'strip' })
  } catch (err) {
    failures++
    console.error(`✗ 语法: ${relative(root, f)} — ${err.message}`)
  }
}
console.log(`语法检查：${files.length} 个 .ts 文件，${failures} 个失败`)

// 架构红线：core/ 不许 import 'cc'，也不许 import 任何第三方包
const coreFiles = walk(join(root, 'assets/scripts/core'))
let violations = 0
for (const f of coreFiles) {
  const src = readFileSync(f, 'utf8')
  const re = /from\s+['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) {
    const spec = m[1]
    if (!spec.startsWith('.')) {
      violations++
      console.error(`✗ 依赖: ${relative(root, f)} 引入了外部模块 "${spec}"（core/ 必须零依赖）`)
    }
  }
}
/** 去掉注释（行注释与块注释），避免"注释里提到某常量"被误判成使用。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

console.log(`架构红线：core/ 共 ${coreFiles.length} 个文件，${violations} 处外部依赖`)

// ── 未导入就使用的常量（第 14 轮加：真的漏过一次）────────────────
//
// 背景：本机没有 Cocos Creator，`cocos/**` **只能做语法检查**（上面那段），
// 而"用了没 import 的标识符"是**语法合法、运行时报 ReferenceError** 的东西 ——
// 语法检查抓不到，编译期也抓不到（类型擦除不做类型检查）。
//
// 真实事故：`GrayboxRenderer.drawAim()` 里用了 `PLAYER_HAND_OFFSET_Y`，却没有 import。
// 结果**瞄准期间整帧在画完世界之后就中断**：瞄准线、绿圈、红叉、射程提示、HUD、
// 小字标签、引导文字一起消失，而玩家看到的是"瞄准的 UI 全没了"。
// 这类 bug 靠读代码很难发现（用 grep 搜到的是**用法**那一行，看着像是有的）。
//
// 所以加一条针对性检查：`core/constants.ts` 导出的全大写常量，
// 在 `cocos/**` 里**出现即必须 import**（或者在本文件里自己声明过）。
const constantsSrc = readFileSync(join(root, 'assets/scripts/core/constants.ts'), 'utf8')
const exportedConsts = new Set()
{
  const re = /export const ([A-Z][A-Z0-9_]*)\s*=/g
  let m
  while ((m = re.exec(constantsSrc)) !== null) exportedConsts.add(m[1])
}

let missingImports = 0
for (const f of walk(join(root, 'assets/scripts/cocos'))) {
  const src = readFileSync(f, 'utf8')
  // 本文件 import 进来的名字
  const imported = new Set()
  {
    const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from/g
    let m
    while ((m = re.exec(src)) !== null) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) imported.add(name)
      }
    }
  }
  // 本文件自己声明的名字（const/let/function/class）
  const local = new Set()
  {
    const re = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g
    let m
    while ((m = re.exec(src)) !== null) local.add(m[1])
  }

  for (const name of exportedConsts) {
    if (imported.has(name) || local.has(name)) continue
    // 只看"真的被用到"的（词边界匹配），而且**要先把注释剥掉**——
    // 否则"注释里提到了某个常量"会被误报（第一次跑就误报了 labels.ts）。
    if (!new RegExp(`\\b${name}\\b`).test(stripComments(src))) continue
    missingImports++
    console.error(
      `✗ 漏导入: ${relative(root, f)} 用了 ${name}，但既没 import 也没在本文件声明` +
        `（运行时会 ReferenceError）`,
    )
  }
}
console.log(`漏导入检查：cocos/ 共 ${walk(join(root, 'assets/scripts/cocos')).length} 个文件，${missingImports} 处`)

// ── 导入了**不存在的名字**（第 20 轮加：真的踩过一次）────────────────
//
// 第 15 轮加的是"用了没导入"；这一条是它的**镜像**："导入了但对面没导出"。
// 两者都是**语法合法、运行时才炸**的东西：
//   · 前者 → `ReferenceError: X is not defined`
//   · 后者 → `SyntaxError: The requested module './x' does not provide an export named 'Y'`
//
// 真实事故（第 20 轮）：`core/enemies.ts` 写了 `import { normalize } from './vec2'`，
// 而那个文件导出的名字是 **`norm`**。语法检查通过、漏导入检查通过，
// 直到测试跑到 import 那一刻才炸 —— 而且报错信息里**没有出现 enemies.ts**，
// 只有一句 "module './vec2' does not provide an export named 'normalize'"，
// 定位成本全在那句"哪个文件写的"上。
//
// 做法：对本仓库内所有 .ts，取出 `import { … } from './x'` 的每个名字，
// 到目标文件里核对它是否被导出。**宁可不报也不误报**：
//   · 目标文件里有 `export *` ⇒ 跳过（无法静态枚举）
//   · 非相对路径（第三方包）⇒ 跳过
//   · `import * as ns` / 默认导入 ⇒ 跳过
function exportsOf(src) {
  const out = new Set()
  // export const/let/var/function/class/interface/type/enum/abstract class
  {
    const re =
      /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
    let m
    while ((m = re.exec(src)) !== null) out.add(m[1])
  }
  // export { a, b as c }
  {
    const re = /^\s*export\s*\{([^}]*)\}/gm
    let m
    while ((m = re.exec(src)) !== null) {
      for (const part of m[1].split(',')) {
        const raw = part.trim()
        if (raw.length === 0) continue
        const name = raw.split(/\s+as\s+/).pop()?.trim()
        if (name) out.add(name)
      }
    }
  }
  return out
}

const allTs = [...walk(join(root, 'assets')), ...walk(join(root, 'tests')), ...walk(join(root, 'scripts'))]
let badImports = 0
for (const f of allTs) {
  const src = readFileSync(f, 'utf8')
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](\.[^'"]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) {
    const names = m[1]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !p.startsWith('type '))
      .map((p) => p.split(/\s+as\s+/)[0]?.trim())
      .filter(Boolean)
    if (names.length === 0) continue

    const target = resolveTs(join(dirname(f), m[2]))
    if (target === null) continue
    const targetSrc = readFileSync(target, 'utf8')
    if (/^\s*export\s+\*/m.test(targetSrc)) continue // 无法静态枚举，宁可不报
    const avail = exportsOf(targetSrc)

    for (const name of names) {
      if (avail.has(name)) continue
      badImports++
      console.error(
        `✗ 导入不存在: ${relative(root, f)} 从 ${m[2]} 导入了 ${name}，` +
          `但 ${relative(root, target)} 没有导出这个名字` +
          (avail.size > 0 ? `（它导出的是：${[...avail].slice(0, 12).join(', ')}${avail.size > 12 ? ' …' : ''}）` : ''),
      )
    }
  }
}
console.log(`导入存在性检查：${allTs.length} 个 .ts 文件，${badImports} 处不存在的导入`)

/** 把 `./x` 解析成实际文件（补 .ts / /index.ts）。找不到就返回 null。 */
function resolveTs(base) {
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
    try {
      if (statSync(cand).isFile()) return cand
    } catch {
      // 不存在，继续试下一个
    }
  }
  return null
}

process.exit(failures + violations + missingImports + badImports === 0 ? 0 : 1)
