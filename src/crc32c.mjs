// crc32c（Castagnoli）—— journal 自校验用，规范见 11-wire-contract.md §5。
//
// 🔴 覆盖范围由调用方给：§11 §5 说的是「**去掉 `crc32c` 这一个 key 之后**该对象的
//    canonical 字节（含结尾换行）」。本模块只管算，不管取哪些字节 ——
//    把「取哪些字节」写进这里会让它在别处（例如 audit archive）被误用。
//
// 这份实现原先躺在 test/harness/crc32c.mjs 里（框架先于内核落地）。搬到 src/ 之后
// 两份必须逐字节等价，test/crc32c.test.mjs 有一条测试把它们钉在一起。

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
