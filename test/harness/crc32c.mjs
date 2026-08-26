// crc32c（Castagnoli）—— journal 自校验用，规范见 11-wire-contract.md §5。
// 事务内核落地时这份实现应当搬进 src/；现在放在 harness 里，
// 是为了让假事务的 journal 与规范同形（不变式 I1 要验它）。

const POLY = 0x82f63b78; // 反射多项式
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ POLY : c >>> 1;
  TABLE[i] = c >>> 0;
}

export function crc32c(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** §11 §5：小写 hex，**8 个字符，固定宽度补零** */
export function crc32cHex(buf) {
  return crc32c(buf).toString(16).padStart(8, '0');
}
