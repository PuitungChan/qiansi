// 《牵丝》本地测试用 TS 解析钩子。
//
// 目的：让 `assets/scripts/core/**` 里的 .ts 源文件既能被 Cocos Creator 编译，
// 又能被本机 Node 直接执行（零依赖、不装 tsc/vitest）。
//
// Cocos Creator 的 TS 管线要求 **无扩展名** 的相对导入（`import { x } from './vec2'`），
// 而 Node ESM 要求显式扩展名。本钩子只做一件事：当 Node 解析失败时，
// 依次补 `.ts` / `/index.ts` 再试一次。这样源码保持 Cocos 友好，本机也能跑。

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      for (const ext of ['.ts', '/index.ts']) {
        try {
          return await next(specifier + ext, context)
        } catch {
          // 继续尝试下一个候选
        }
      }
    }
    throw err
  }
}
