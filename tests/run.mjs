/**
 * 单进程测试运行器。
 *
 * 为什么不用 `node --test "tests/*.test.ts"`：内置测试运行器会为**每个测试文件
 * spawn 一个子进程**，而本项目的执行沙箱禁止进程间管道（会报 `spawn EPERM`）。
 * 这里改成在当前进程内依次 `import()` 所有 `*.test.ts`，由 `node:test` 在
 * 同进程内调度执行——语义完全等价，且没有子进程。
 *
 * 用法：
 *   npm test
 * 等价于：
 *   node --experimental-strip-types --import ./tests/register.mjs tests/run.mjs
 *
 * 在不受沙箱限制的 CI 上，也可以用 package.json 里的 `test:isolated`
 * 走官方的多进程测试运行器。
 */

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()

if (files.length === 0) {
  console.error('没有找到任何 *.test.ts 文件')
  process.exit(1)
}

for (const f of files) {
  // Windows 上 import() 只接受 file:// URL，绝对路径会被当成 "d:" 协议。
  await import(pathToFileURL(join(here, f)).href)
}
