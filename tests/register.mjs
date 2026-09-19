// 注册 TS 解析钩子。用法：
//   node --experimental-strip-types --import ./tests/register.mjs --test "tests/*.test.ts"
import { register } from 'node:module'

register('./ts-hooks.mjs', import.meta.url)
