/**
 * 《牵丝》确定性物理内核 —— 状态哈希。
 *
 * AC-05 要求「同一回放在 3 台设备 + 服务端产生相同哈希」。
 * 要做到这一点，哈希必须建立在**浮点数的原始二进制位**上，而不是 `toFixed()` 之类的文本近似——
 * 文本近似会把"跨设备真的算出不同结果"这种致命问题掩盖成"看起来一样"。
 *
 * 实现：把状态量写进 `Float64Array`，再按字节跑 FNV-1a 32 位。
 * IEEE-754 double 在任意合规 JS 实现上逐位一致，因此这个哈希是可跨设备比较的。
 *
 * 本文件不得引入任何引擎依赖。
 */

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

export function fnv1a32(bytes: Uint8Array, seed = FNV_OFFSET): number {
  let h = seed >>> 0
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    // 32 位 FNV 质数乘法，用 Math.imul 保证在 32 位整数域内不丢精度
    h = Math.imul(h, FNV_PRIME) >>> 0
  }
  return h >>> 0
}

/** 把一串 double 精确地哈希成 8 位十六进制字符串。 */
export function hashFloat64(values: ArrayLike<number>, seed = FNV_OFFSET): string {
  const n = values.length
  const buf = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = values[i]
    // NaN / Infinity 在 JSON 与比较里都很麻烦，这里折叠成确定的位型。
    buf[i] = Number.isFinite(v) ? v : Number.isNaN(v) ? -0 : 0
  }
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  return (fnv1a32(bytes, seed) >>> 0).toString(16).padStart(8, '0')
}

/** 把 32 位哈希扩成一个较长的摘要，降低碰撞概率（现场调试足够）。 */
export function hashFloat64Wide(values: ArrayLike<number>): string {
  const a = hashFloat64(values, FNV_OFFSET)
  const b = hashFloat64(values, (FNV_OFFSET ^ 0x9e3779b9) >>> 0)
  return a + b
}

/** 组合多个子哈希（用于"分模块对比"——能快速定位是哪一块状态先跑偏）。 */
export function combineHashes(parts: readonly string[]): string {
  let h = FNV_OFFSET
  for (let p = 0; p < parts.length; p++) {
    const s = parts[p]
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, FNV_PRIME) >>> 0
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
