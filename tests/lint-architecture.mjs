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
console.log(`架构红线：core/ 共 ${coreFiles.length} 个文件，${violations} 处外部依赖`)

process.exit(failures + violations === 0 ? 0 : 1)
