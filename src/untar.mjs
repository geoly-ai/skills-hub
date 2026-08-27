// 受限 tar.gz 解析器 —— 规范：01-artifacts.md §4（路径 grammar）、§5（载荷规则与上限）、
// §6.2（摘要不覆盖的东西必须在别处消灭）、02-registry.md §4.1（canonical tar.gz）、
// 04-install.md §7（解包策略层）。
//
// 🔴 这不是一个 tar reader，是一个 **canonical 形状识别器**。
//
// 通用 tar 库的默认行为恰恰是我们要拒绝的那些：跟随 PAX longname、忽略未知
// typeflag、按 mtime 还原时间、把 `../` 交给调用方去防。本模块反过来做：
// 只接受「ustar 普通文件条目、uid/gid/mtime/dev 全 0、uname/gname 空、
// mode ∈ {0644,0755}、路径符合 §4」的条目，**其余一律拒绝，不做任何兼容**。
// 白名单比黑名单短得多，也就没有「忘了拒绝某个 typeflag」这一类洞。
//
// 🔴 **本模块不落盘**：返回内存里的条目，由 artifact.mjs 写到隔离临时目录。
// 解析器没有任何写盘能力 —— 即使路径判定漏了一项，它也写不出去。
//
// ⚠️ 与规范的分歧：04-install.md §7 要求「不自己写 tar reader，用成熟库 + 策略层」。
// 本实现选择了自写受限解析器（零运行时依赖）。取舍与理由见交付汇报，
// 需要上层拍板；§7 同时给了退路：「若没有库满足，则需在库之外先做一遍原始 tar 头扫描」，
// 本模块就是那一遍扫描的完整版。
import { InflateRaw, deflateRawSync, constants as zlibConstants } from 'node:zlib';
import { parseSafeRelPath } from './safe-fs.mjs';

// ── 上限（01-artifacts.md §5） ──────────────────────────────────────────────
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件 2 MiB
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024; // 解压后总计 16 MiB
export const MAX_FILES = 2000;
export const MAX_DEPTH = 12;
export const MAX_RATIO = 200; // 压缩比 200:1
// 🔴 canonical deflate 参数（02-registry.md §4.1 的 level 9）。全部显式钉死：
//    windowBits/memLevel/strategy 只要有一个走默认，换个 Node 就可能算出别的长度。
const CANON_DEFLATE = Object.freeze({
  level: 9, windowBits: 15, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY,
});
// gzip 定长封套：10 字节头 + 8 字节尾
const GZIP_ENVELOPE = 18;
// body 相对 canonical 重压缩结果允许的上浮。**不是** 逐字节相等：
// zlib 的输出跨版本/跨架构不保证一致（本机 Node 22 / 24 实测逐字节一致，但那不构成
// 跨平台保证），逐字节比会把「换台机器装不上」变成常态。
//
// ⚠️ **它证明的是「body 没有明显膨胀」，不是「body 一定是 level 9」。**
//    Codex 第四轮的反例：对**不可压缩**内容，level 0 与 level 9 的体积差远小于 10%
//    （实测 raw 206336 → level0 206366 / level9 205007），伪造 XFL=2 就能过这一关。
//    别把这个常量当成 level 9 的证明去依赖 —— 真正靠它挡住的是
//    stored-block 填充与明显的 level 降级。压缩比的安全性不依赖它，
//    那由 canonical 分母单独保证。
const CANON_SLACK = (n) => Math.floor(n * 1.1) + 64;
const BLOCK = 512;
const USTAR_NAME = 100;
const USTAR_PREFIX = 155;
// tar 本身的块开销：每条 512 头 + 至多 511 填充，再加两个结束块
const MAX_TAR_BYTES = MAX_TOTAL_BYTES + MAX_FILES * BLOCK * 2 + 4 * BLOCK;
// 🔴 输入侧也要有上限。`maxOutputLength` 只挡住**输出**：攻击者可以送一个几十 MB、
//    几乎不产生任何输出的 body（几百万个零输出 stored block），让我们先完整 inflate
//    一遍、再重压缩一遍，全程持有 buf/out/canonBody 三份内存。Codex 第四轮实测：
//    50 MB 输入 60 ms —— 单发不致命，但它是纯粹的白送，且并发时按输入大小线性放大。
//    合法 gzip 至多比它的解压结果大一丁点（deflate stored 每 65535 字节多 5 字节，
//    实测 18 MB 不可压缩内容膨胀 0.031%），所以 1% + 1 KiB 的余量足够宽。
const MAX_GZ_BYTES = Math.ceil(MAX_TAR_BYTES * 1.01) + 1024;

export class TarViolation extends Error {
  constructor(violation, msg, where) {
    super(`[${violation}] ${msg}${where ? `（${where}）` : ''}`);
    this.name = 'TarViolation';
    this.violation = violation;
    this.where = where;
    this.code = 2; // 完整性失败
  }
}
const viol = (v, m, w) => { throw new TarViolation(v, m, w); };

/**
 * 🔴 **攻击者控制的字节进诊断消息之前必须先转义。**
 *
 * 路径判定是分层的：charset（只允许 `[A-Za-z0-9._-]`）在 `..`／绝对路径／反斜杠／
 * 空 segment／深度这几项**之后**才跑，所以那几条消息拿到的 `path` 还是原始字节 ——
 * 里面可以塞 ANSI 转义序列（实测 `\x1b]0;…\x07` 能改终端标题、`\x1b[2J` 能清屏），
 * 而这些消息会被打进终端和日志。用 `JSON.stringify` 把控制字符转成 `\uXXXX`。
 *
 * 不靠「把 charset 检查提前」来解决：那只是让当前这一版恰好安全，
 * 下次有人加一条在 charset 之前的判定又会漏。**在出口处统一转义**才是不变量。
 */
const q = (x) => JSON.stringify(String(x));

// ── gzip ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * canonical gzip 解封（02-registry.md §4.1：`mtime=0`、`OS=255`、level 9、无 `FNAME`/`FCOMMENT`）。
 *
 * 🔴 FLG 必须**整字节为 0**：不只拒 FNAME/FCOMMENT，连 FEXTRA / FHCRC / FTEXT /
 * 保留位一并拒。它们都是「规范没定义的组合」，按 11-wire-contract.md §7 一律拒绝。
 */
export function gunzipCanonical(gz) {
  const buf = Buffer.isBuffer(gz) ? gz : Buffer.from(gz);
  if (buf.length < 18) viol('E_TRUNCATED', `gzip 只有 ${buf.length} 字节，装不下头+尾`);
  // 最先判、最便宜的一道闸：还没做任何解压就先把超大输入挡在外面
  if (buf.length > MAX_GZ_BYTES) {
    viol('E_GZIP_SIZE',
      `gzip 输入 ${buf.length} 字节，超过 ${MAX_GZ_BYTES} 上限`
      + `（解压后至多 ${MAX_TAR_BYTES} 字节，合法压缩流不可能比它大这么多）`);
  }
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) viol('E_GZIP_HEADER', 'gzip magic 不是 1f 8b');
  if (buf[2] !== 8) viol('E_GZIP_HEADER', `CM=${buf[2]}，只接受 8（deflate）`);
  if (buf[3] !== 0) {
    const names = ['FTEXT', 'FHCRC', 'FEXTRA', 'FNAME', 'FCOMMENT', 'RES1', 'RES2', 'RES3'];
    const set = names.filter((_, i) => buf[3] & (1 << i));
    viol('E_GZIP_HEADER', `FLG 必须为 0，出现 ${set.join('/')}`);
  }
  const mtime = buf.readUInt32LE(4);
  if (mtime !== 0) viol('E_GZIP_HEADER', `gzip MTIME 必须是 0，得到 ${mtime}`);
  // XFL：canonical 要求 level 9，zlib 在 level 9 时写 XFL=2。
  // ⚠️ XFL 只是**提示位**，攻击者可以随手填 2 而 body 其实是 level 0 —— Codex 第三轮实测：
  //    level 0 的 body 2053 字节、level 9 只要 72 字节，改个 XFL 就照单全收。
  //    所以它只是便宜的前置筛子，真正证明 level 9 的是下面的 canonical 重压缩比对。
  if (buf[8] !== 2) viol('E_GZIP_HEADER', `gzip XFL 必须是 2（level 9 的取值），得到 ${buf[8]}`);
  if (buf[9] !== 255) viol('E_GZIP_HEADER', `gzip OS 必须是 255（unknown），得到 ${buf[9]}`);

  const body = buf.subarray(10, buf.length - 8);
  const wantCrc = buf.readUInt32LE(buf.length - 8);
  const wantIsize = buf.readUInt32LE(buf.length - 4);

  // 🔴 必须知道 deflate 流**实际消耗了多少输入字节**。
  //
  // `inflateRawSync` 会**静默忽略**流结束之后的尾随字节，`gunzipSync` 也会忽略
  // member 之后的垃圾。Codex 第二轮实测：在一个 2 MiB 全零的合法归档后面追加
  // 16 KB 垃圾 + 一份拷贝的 8 字节尾，CRC 与 ISIZE 都对得上，于是
  //   ① 夹带的 16 KB 被完全接受；
  //   ② 分母被垫大，**压缩比从 988:1 掉到 113:1，直接绕过 200:1 的解压炸弹上限**。
  // 所以改用流对象拿 `bytesWritten`（已消耗的输入长度），要求它**恰好等于 body 长度**。
  const engine = new InflateRaw({ maxOutputLength: MAX_TAR_BYTES });
  if (typeof engine._processChunk !== 'function') {
    // 拿不到「消耗了多少输入」就无法证明没有夹带 → fail-closed，不降级
    viol('E_GZIP_ENGINE', '本 Node 的 zlib 无法报告已消耗的输入长度，拒绝解包');
  }
  let out;
  try {
    out = engine._processChunk(body, zlibConstants.Z_FINISH);
  } catch (e) {
    if (/BUFFER_TOO_LARGE|maxOutputLength/i.test(String(e.code) + e.message)) {
      viol('E_TOTAL_SIZE', `解压超过 ${MAX_TAR_BYTES} 字节上限（解压炸弹）`);
    }
    viol('E_GZIP_DEFLATE', `deflate 流损坏：${e.message}`);
  } finally {
    try { engine.close(); } catch { /* 已经关了 */ }
  }
  const consumed = engine.bytesWritten;
  if (consumed !== body.length) {
    const rest = body.subarray(consumed);
    // 多 member：紧跟着的是 8 字节 member 尾 + 下一个 gzip 头
    if (rest.length >= 10 && rest[8] === 0x1f && rest[9] === 0x8b) {
      viol('E_GZIP_MULTIMEMBER', `gzip 含多个 member，只接受一个（第一个 member 之后还有 ${rest.length} 字节）`);
    }
    viol('E_GZIP_TRAILER', `deflate 流之后还有 ${rest.length} 字节尾随数据（夹带，且会垫大压缩比的分母）`);
  }

  // 🔴 CRC / ISIZE 先验：它们是 O(n) 的便宜校验，而下面的 canonical 重压缩最坏要
  //    350 ms。先证明这份数据没坏，再为它花那笔 CPU —— 损坏输入不该付重压缩的钱。
  if (crc32(out) !== wantCrc) viol('E_GZIP_CRC', 'gzip CRC32 不符');
  if ((out.length >>> 0) !== wantIsize) viol('E_GZIP_ISIZE', `gzip ISIZE 不符（${out.length >>> 0} vs ${wantIsize}）`);

  // 🔴🔴 分母还能在**流内部**被垫大 —— 上一轮只堵住了流外部。
  //
  // Codex 第三轮实测的绕过：deflate 允许 `00 00 00 ff ff`（BFINAL=0、BTYPE=stored、
  // LEN=0）这种**零输出的空块**。往合法流前面插 1675 个，这些字节
  //   ① 属于同一条合法 deflate 流，`bytesWritten` 照样等于 body.length，
  //      上一轮的 E_GZIP_TRAILER 完全看不见它们；
  //   ② 把 gzip 文件从 10,495 字节前的规模垫到 10,495 字节，
  //      **压缩比从 989.9:1 压到 199.97:1，正好蹭过 200:1**。
  //
  // 结论：**任何由攻击者提供的长度都不能当分母。** 分母必须是「这份内容最少能压到
  // 多少字节」——也就是我们自己按 canonical 参数重压一遍的结果。攻击者控制不了它。
  let canonBody;
  try {
    canonBody = deflateRawSync(out, CANON_DEFLATE);
  } catch (e) {
    // 拿不到 canonical 基准就证明不了分母没被垫大 → fail-closed，不退回用文件自称的长度。
    // 退回等于把刚堵上的绕过重新打开，而且只在压缩器出问题时才打开 —— 最难发现的那种。
    viol('E_GZIP_ENGINE', `无法按 canonical 参数重压缩以核算压缩比，拒绝解包：${e.message}`);
  }
  const canonGzLen = canonBody.length + GZIP_ENVELOPE;
  // 取 min：投稿方若用了比 zlib 更强的压缩器（zopfli 等），真实文件可能比我们重压的还小，
  // 那就用它的真实长度，不给它凭空放宽。
  const denom = Math.min(buf.length, canonGzLen);
  if (denom > 0 && out.length / denom > MAX_RATIO) {
    viol('E_RATIO',
      `压缩比 ${(out.length / denom).toFixed(1)}:1 超过 ${MAX_RATIO}:1`
      + `（按 canonical 重压缩后的 ${denom} 字节算；文件自称 ${buf.length} 字节）`);
  }

  // 🔴 body 不得明显大于 canonical 重压缩的结果。这是 stored-block 填充的第二道闸，
  //    也挡得住明显的 level 降级；但它**不是 level 9 的证明**（见 CANON_SLACK 的注释：
  //    不可压缩内容上 level 0 与 level 9 差不到 10%，伪造 XFL 能过）。
  if (body.length > CANON_SLACK(canonBody.length)) {
    viol('E_GZIP_NONCANONICAL',
      `deflate body ${body.length} 字节，而按 canonical level 9 重压只需 ${canonBody.length} 字节`
      + `（上限 ${CANON_SLACK(canonBody.length)}）。多半塞了零输出的空块，或压缩等级明显低于 9`);
  }
  return out;
}

// ── tar 头部字段 ────────────────────────────────────────────────────────────

const isZero = (b) => { for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false; return true; };

/** NUL 结尾字符串；🔴 NUL 之后必须全零，否则是夹带（Codex 评审提出） */
function cstrField(blk, off, len, name, idx) {
  const b = blk.subarray(off, off + len);
  const z = b.indexOf(0);
  if (z === -1) return b.toString('latin1'); // 满字段无终止符，ustar 允许
  for (let i = z; i < b.length; i++) {
    if (b[i] !== 0) viol('E_FIELD_PAD', `${name} 字段 NUL 之后有非零字节（夹带）`, `entry #${idx}`);
  }
  return b.subarray(0, z).toString('latin1');
}

function assertZeroField(blk, off, len, name, code, idx) {
  const b = blk.subarray(off, off + len);
  if (!isZero(b)) viol(code, `${name} 必须全为 0（01-artifacts.md §6.2），得到 ${JSON.stringify(b.toString('latin1').replace(/\0+$/, ''))}`, `entry #${idx}`);
}

/**
 * 严格八进制数字域：`(len-1)` 位 `[0-7]` + 一个 NUL。
 *
 * 🔴 拒 GNU base-256（首字节高位置 1）—— 那是能表达 >8GB 的扩展编码，
 *    也是绕过长度校验的经典手法。
 *
 * 🔴🔴 **这个布局会拒掉真实 tar 工具的产出，是有意的，不要"修"。**
 *
 * POSIX 允许数字域用空格或 NUL 终止，于是同一个值有多种字节写法；而
 * `asset.sha256` 绑的是字节（ERRATA E-3）。canonical 只能有一种，这里定死
 * 「补零到 len-1 位 + NUL」。实测本机 `bsdtar 3.5.3`（macOS 系统 tar，
 * `--format ustar`）写的是另一套：
 *
 * ```
 * mode     '000644 \0'      ← 6 位 + 空格 + NUL，本实现报 E_OCTAL
 * size     '00000000003 '   ← 11 位 + 空格（无 NUL），本实现报 E_OCTAL
 * chksum   '012066\0 '      ← 与本实现一致
 * typeflag '0'              ← 与本实现一致
 * ```
 *
 * 也就是说**系统 tar 打的包一律装不上**。这与 ERRATA E-5/E-6 的结论一致：
 * packer 必须自己写字节、不得 shell out 到系统 `tar`（E-6 还给了另一个理由 ——
 * macOS 的 tar 会偷偷注入 AppleDouble 成员）。放宽这里等于把 E-3 重新打开。
 */
function octalField(blk, off, len, name, idx) {
  const b = blk.subarray(off, off + len);
  if (b[0] & 0x80) viol('E_BASE256', `${name} 用了 GNU base-256 数字编码`, `entry #${idx}`);
  const body = b.subarray(0, len - 1);
  if (b[len - 1] !== 0) viol('E_OCTAL', `${name} 必须以 NUL 结尾（canonical 八进制布局）`, `entry #${idx}`);
  for (let i = 0; i < body.length; i++) {
    if (body[i] < 0x30 || body[i] > 0x37) {
      viol('E_OCTAL', `${name} 不是 ${len - 1} 位八进制 ASCII`, `entry #${idx}`);
    }
  }
  return parseInt(body.toString('latin1'), 8);
}

/**
 * chksum 域：**只**接受 POSIX 规范布局「6 位八进制 + NUL + 空格」。
 *
 * 🔴 曾经也接受「7 位 + NUL」。那是同一个校验和的第二种字节写法 ——
 * 与 typeflag NUL、devmajor 全 NUL 同一类问题：一个逻辑条目多个合法字节形式，
 * 而 `asset.sha256` 绑的是字节（ERRATA E-3 的理由）。canonical 定死一种。
 * 6 位八进制上限 0o777777 = 262143，而一个 512 字节头的无符号字节和上限是
 * 512 × 255 = 130560，永远装得下，收窄没有表达力代价。
 */
function checksumField(blk, idx) {
  const s = blk.subarray(148, 156).toString('latin1');
  if (!/^[0-7]{6}\0 $/.test(s)) {
    return viol('E_CHECKSUM',
      'chksum 字段布局不合法：canonical 只接受 6 位八进制 + NUL + 空格', `entry #${idx}`);
  }
  return parseInt(s.slice(0, 6), 8);
}

const TYPEFLAG_NAMES = {
  0x31: 'hardlink(1)', 0x32: 'symlink(2)', 0x33: 'chardev(3)', 0x34: 'blockdev(4)',
  0x35: 'directory(5)', 0x36: 'fifo(6)', 0x37: 'contiguous(7)',
  0x78: 'PAX 扩展头(x)', 0x67: 'PAX 全局头(g)',
  0x4c: 'GNU longname(L)', 0x4b: 'GNU longlink(K)', 0x53: 'GNU sparse(S)',
  0x44: 'GNU dumpdir(D)', 0x4d: 'GNU multivolume(M)', 0x56: 'GNU volume label(V)',
  0x4e: 'GNU longnames(N)',
};

// ── 路径（01-artifacts.md §4） ──────────────────────────────────────────────

const RE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * §4.1 + §4.2 全量判定。每一条一个独立的违规码 —— 报出**是哪一项**。
 * 归一化/大小写折叠等跨条目的规则由调用方（`parseTar`）累积判定。
 */
export function assertArtifactPath(path, where) {
  const p = q(path);
  if (path === '') viol('E_PATH_EMPTY', '路径为空', where);
  if (path.startsWith('/')) viol('E_PATH_ABS', `绝对路径：${p}`, where);
  if (path.includes('\\')) viol('E_PATH_BACKSLASH', `路径含反斜杠：${p}`, where);
  if (path.includes('\0')) viol('E_PATH_NUL', '路径含 NUL', where);
  const segs = path.split('/');
  if (segs.length > MAX_DEPTH) viol('E_DEPTH', `路径深度 ${segs.length} 超过 ${MAX_DEPTH}：${p}`, where);
  for (const s of segs) {
    if (s === '') viol('E_PATH_EMPTY_SEGMENT', `空 segment（//、首/尾斜杠）：${p}`, where);
    // 🔴 `..` 按 segment 判，不做字符串 includes —— `a..b` 是合法文件名
    if (s === '.' || s === '..') viol('E_PATH_DOTDOT', `segment 是 ${s}：${p}`, where);
    if (!RE_SEGMENT.test(s)) viol('E_PATH_CHARSET', `segment 不是 ASCII-only [A-Za-z0-9._-]：${JSON.stringify(s)}`, where);
    // 🔴 ERRATA E-6：macOS 系统 tar 会为携带 xattr 注入 AppleDouble（`._*`）成员，
    //    而 §5 明确拒绝 xattr。这类条目本来也会被下一行的 E_PATH_LEADING 挡住，
    //    但报「segment 以 . 开头」对打包的人毫无帮助 —— 他从 `tar -tvf` 根本看不到
    //    这个成员，只会以为校验器有 bug。所以先于通用规则报出专门的码 + 处方。
    if (s.startsWith('._')) {
      viol('E_APPLEDOUBLE',
        `${JSON.stringify(s)} 是 macOS AppleDouble 成员（系统 tar 为携带 xattr 自动注入，`
        + `且 tar -tvf 不会列出它）。§5 拒绝 xattr。请用 COPYFILE_DISABLE=1 重新打包，`
        + `或改用自己写字节、不 shell out 到系统 tar 的 packer（ERRATA E-5/E-6）`, where);
    }
    if (s[0] === '.' || s[0] === '-') viol('E_PATH_LEADING', `segment 以 ${s[0]} 开头：${q(s)}`, where);
    if (s.endsWith('.')) viol('E_PATH_TRAILING_DOT', `segment 以 . 结尾：${q(s)}`, where);
    const stem = (s.includes('.') ? s.slice(0, s.indexOf('.')) : s).toUpperCase();
    if (RESERVED.has(stem)) viol('E_PATH_RESERVED', `segment 是保留设备名：${q(s)}`, where);
  }
  // 纵深防御：再过一遍地基模块。两边都判到才算过 —— 任一侧将来放松，另一侧还在。
  // 🔴 它抛的是普通 Error（没有 violation），得转成违规码，否则「报出具体违规项」
  //    这条契约会在**恰好是本层漏判**的那种情况下失效。
  try {
    parseSafeRelPath(path, { maxDepth: MAX_DEPTH });
  } catch (e) {
    viol('E_PATH_SAFE_FS', `safe-fs 的独立判定拒绝了这条路径（本层漏判）：${e.message}`, where);
  }
  return segs;
}

/**
 * §4.3 USTAR 可编码性 + **唯一编码**。
 *
 * 🔴 不只是「name ≤ 100 且 prefix ≤ 155」：同一条路径若能被切成多种 (prefix,name)，
 * 攻击者就能用非规范切法造出两个字节不同、解出来同路径的归档 ——
 * 而 `asset.sha256` 绑的是字节。所以这里定死唯一切法（prefix 取最长的合法切点，
 * 与 GNU tar 一致），观察到的切法必须与之相等。
 */
export function canonicalUstarSplit(path) {
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes <= USTAR_NAME) return { prefix: '', name: path };
  let best = null;
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (name === '' || prefix === '') continue;
    if (Buffer.byteLength(prefix, 'utf8') > USTAR_PREFIX) break; // 再往后只会更长
    if (Buffer.byteLength(name, 'utf8') > USTAR_NAME) continue;
    best = { prefix, name }; // 取最长的合法 prefix
  }
  return best;
}

// ── 主解析 ──────────────────────────────────────────────────────────────────

/**
 * 解析 canonical tar（已 gunzip 的字节）。
 * @returns {{entries: Array<{path:string,mode:number,data:Buffer}>, totals:{files:number,bytes:number}}}
 */
export function parseTar(tar) {
  if (tar.length === 0) viol('E_TRUNCATED', 'tar 为空');
  if (tar.length % BLOCK !== 0) viol('E_TRUNCATED', `tar 长度 ${tar.length} 不是 512 的整数倍`);

  const entries = [];
  const seenPath = new Set();
  const seenFold = new Set();
  // 折叠后的目录名 -> 它第一次出现时的实际拼写。用来抓「A/x.md 与 a/y.md」这种
  // 两条路径各自不重名、但在大小写不敏感的文件系统上指向同一个目录的情况。
  const dirCase = new Map();
  let totalBytes = 0;
  let prevPathBuf = null;
  let off = 0;
  let sawEof = false;
  let idx = 0;

  while (off < tar.length) {
    const blk = tar.subarray(off, off + BLOCK);

    if (isZero(blk)) {
      // 结束标记 = 恰好两个全零块，之后**什么都不能有**
      const second = tar.subarray(off + BLOCK, off + 2 * BLOCK);
      if (second.length !== BLOCK || !isZero(second)) viol('E_NO_EOF_MARKER', '结束标记不是两个连续的 512 全零块');
      const rest = tar.subarray(off + 2 * BLOCK);
      if (rest.length > 0) {
        if (!isZero(rest)) viol('E_TRAILING', `结束标记之后还有 ${rest.length} 字节非零数据（tar smuggling）`);
        viol('E_TRAILING_BLOCKS', `结束标记之后还有 ${rest.length / BLOCK} 个多余的全零块（非 canonical）`);
      }
      sawEof = true;
      break;
    }

    idx++;
    const where = `entry #${idx}`;

    // ① 头部 checksum：先验它，后面的字段才值得读
    const want = checksumField(blk, idx);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : blk[i];
    if (sum !== want) viol('E_CHECKSUM', `头部 checksum 不符（算出 ${sum}，头里写 ${want}）`, where);

    // ② magic / version：只接受 POSIX ustar，拒 v7 老 tar 与 GNU 变体（"ustar  \0"）
    const magic = blk.subarray(257, 263);
    const version = blk.subarray(263, 265);
    if (magic.toString('latin1') !== 'ustar\0') {
      viol('E_MAGIC', `magic 不是 ustar+NUL，得到 ${JSON.stringify(magic.toString('latin1'))}`, where);
    }
    if (version.toString('latin1') !== '00') {
      viol('E_MAGIC', `ustar version 不是 "00"，得到 ${JSON.stringify(version.toString('latin1'))}`, where);
    }

    // ③ typeflag：只接受普通文件。🔴 逐类报出是哪一种，不笼统说「类型不对」
    // 🔴 只接受 '0'（0x30）。v7 老 tar 用 NUL(0x00) 表示普通文件，那是**同一条逻辑
    //    条目的第二种字节编码** —— 接受它就等于把 E-3 刚消灭的「一个逻辑制品多个
    //    合法字节形式」放回来（`asset.sha256` 绑的是字节）。magic 已经强制 POSIX
    //    ustar，ustar 下 '0' 是唯一规范值，所以这里没有兼容性代价。
    const tf = blk[156];
    if (tf !== 0x30) {
      if (tf === 0x00) {
        viol('E_TYPEFLAG', 'typeflag 是 NUL（v7 老 tar 的普通文件写法）；'
          + 'ustar 下普通文件的唯一规范值是 ASCII "0"，两种编码并存会破坏 ERRATA E-3 的唯一性', where);
      }
      const known = TYPEFLAG_NAMES[tf];
      viol('E_TYPEFLAG', known
        ? `拒绝 ${known} 条目（01-artifacts.md §5 只允许普通文件；§4.1 只写文件条目、不写目录条目）`
        : `拒绝未知 typeflag 0x${tf.toString(16).padStart(2, '0')}`, where);
    }

    // ④ 01-artifacts.md §6.2：摘要不覆盖的东西，规范强制其取值
    assertZeroField(blk, 157, 100, 'linkname', 'E_LINKNAME', idx);
    assertZeroField(blk, 265, 32, 'uname', 'E_UNAME', idx);
    assertZeroField(blk, 297, 32, 'gname', 'E_GNAME', idx);
    assertZeroField(blk, 500, 12, '头部保留区(500..511)', 'E_HEADER_PAD', idx);

    const mode = octalField(blk, 100, 8, 'mode', idx);
    const uid = octalField(blk, 108, 8, 'uid', idx);
    const gid = octalField(blk, 116, 8, 'gid', idx);
    const size = octalField(blk, 124, 12, 'size', idx);
    const mtime = octalField(blk, 136, 12, 'mtime', idx);
    // 🔴 不给 devmajor/devminor 开 `allowAllNul`：全 NUL 与 "0000000\0" 都表示 0，
    //    两种都收下就是同一条逻辑条目的两种字节编码（同上 typeflag 的理由）。
    //    canonical 形式定死为八进制零；packer 自己写字节（E-5 推论），没有兼容代价。
    const devmajor = octalField(blk, 329, 8, 'devmajor', idx);
    const devminor = octalField(blk, 337, 8, 'devminor', idx);

    if (uid !== 0) viol('E_UID', `uid 必须是 0，得到 ${uid}`, where);
    if (gid !== 0) viol('E_GID', `gid 必须是 0，得到 ${gid}`, where);
    if (mtime !== 0) viol('E_MTIME', `mtime 必须是 0，得到 ${mtime}`, where);
    if (devmajor !== 0 || devminor !== 0) viol('E_DEV', `devmajor/devminor 必须是 0，得到 ${devmajor}/${devminor}`, where);
    // 🔴 mode 白名单：0o4755 之类带 setuid/setgid/sticky 的值会在这里落网
    if (mode !== 0o644 && mode !== 0o755) {
      viol('E_MODE', `mode 只允许 0644 / 0755，得到 0${mode.toString(8)}`, where);
    }

    // ⑤ 路径
    const name = cstrField(blk, 0, USTAR_NAME, 'name', idx);
    const prefix = cstrField(blk, 345, USTAR_PREFIX, 'prefix', idx);
    if (name === '') viol('E_PATH_EMPTY', 'name 字段为空', where);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    assertArtifactPath(path, where);

    const canon = canonicalUstarSplit(path);
    if (canon === null) {
      viol('E_PATH_USTAR', `路径无法被 ustar 的 prefix(155)+name(100) 切分：${q(path)}`, where);
    }
    if (canon.prefix !== prefix || canon.name !== name) {
      viol('E_PATH_USTAR_SPLIT',
        `非 canonical 的 ustar 切分：头里是 prefix=${JSON.stringify(prefix)}/name=${JSON.stringify(name)}，` +
        `canonical 是 prefix=${JSON.stringify(canon.prefix)}/name=${JSON.stringify(canon.name)}`, where);
    }

    if (seenPath.has(path)) viol('E_DUP_PATH', `重复路径 ${q(path)}`, where);
    const fold = path.toLowerCase();
    if (seenFold.has(fold)) viol('E_CASE_COLLIDE', `大小写折叠后与已有条目重名：${q(path)}`, where);

    // 🔴 同一个名字不能既是文件又是目录 —— 这样的归档在任何文件系统上都落不了地。
    //
    // 归档里只写文件条目、不写目录条目（§4.1），目录是由路径隐含的。于是
    // `a` 与 `a/b.md` 两条都「各自合法」：路径 grammar 过、不重复、大小写不撞、
    // 顺序也对（`a` 必然排在 `a/b.md` 前面，因为它是前缀）。
    //
    // 不在这里判的话，它会一路走到 artifact.mjs 的 writeEntries，在 `mkdir a` 撞上
    // 刚写好的文件 `a` 时报 **E_DEST_DIRTY**——那个码的意思是「隔离目录被别人动过」，
    // 是安全事件。把「归档自相矛盾」误报成「隔离目录被污染」会把排查引到完全错的方向，
    // 而且那时已经往磁盘写过东西了。**结构问题要在解析器里、落盘之前判掉。**
    const segsOf = path.split('/');
    for (let i = 1; i < segsOf.length; i++) {
      const ancestor = segsOf.slice(0, i).join('/');
      const aFold = ancestor.toLowerCase();
      if (seenPath.has(ancestor)) {
        viol('E_PATH_FILE_DIR_COLLIDE',
          `${q(path)} 要求 ${q(ancestor)} 是目录，但它已经作为文件条目出现过`, where);
      }
      if (seenFold.has(aFold)) {
        viol('E_PATH_FILE_DIR_COLLIDE',
          `${q(path)} 要求 ${q(ancestor)} 是目录，但大小写折叠后它已经作为文件条目出现过`
          + `（macOS 上会互相覆盖）`, where);
      }
      // 🔴 目录名之间的大小写冲突。§4.2 的折叠规则原文只说「与已有**条目**折叠后重名」，
      //    照字面实现只比整条路径，于是 `A/x.md` 与 `a/y.md` 两条都能过 ——
      //    可它们在 macOS 上是同一个目录。后果比「报错码不好看」严重：
      //    **同一份 asset 在 Linux 上装得上、在 macOS 上装不上**（mkdir 撞 EEXIST，
      //    还会被报成 E_DEST_DIRTY「隔离目录被污染」）。
      //    §4.2 折叠规则的立意就是消灭这种平台相关性，所以按立意补到目录上。
      const prevCase = dirCase.get(aFold);
      if (prevCase !== undefined && prevCase !== ancestor) {
        viol('E_CASE_COLLIDE',
          `目录 ${q(ancestor)} 与先前出现的 ${q(prevCase)} 大小写折叠后是同一个目录`
          + `（大小写不敏感的文件系统上会合并成一个）`, where);
      }
      dirCase.set(aFold, ancestor);
    }

    seenPath.add(path);
    seenFold.add(fold);

    // ⑥ 顺序：与树摘要相同的 path 字节序，严格升序（02-registry.md §4.1，参与确定性）
    const pathBuf = Buffer.from(path, 'utf8');
    if (prevPathBuf !== null && Buffer.compare(prevPathBuf, pathBuf) >= 0) {
      viol('E_ORDER',
        `条目顺序不是 path 字节序严格升序：${q(prevPathBuf.toString())} 之后出现 ${q(path)}`, where);
    }
    prevPathBuf = pathBuf;

    // ⑦ 上限与数据区
    if (size > MAX_FILE_BYTES) viol('E_FILE_SIZE', `单文件 ${size} 字节超过 ${MAX_FILE_BYTES}：${q(path)}`, where);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) viol('E_TOTAL_SIZE', `解压总计超过 ${MAX_TOTAL_BYTES} 字节`, where);
    if (entries.length + 1 > MAX_FILES) viol('E_FILE_COUNT', `文件数超过 ${MAX_FILES}`, where);

    const dataStart = off + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + padded > tar.length) viol('E_TRUNCATED', `${q(path)} 的数据区被截断`, where);
    const data = tar.subarray(dataStart, dataStart + size);
    const pad = tar.subarray(dataStart + size, dataStart + padded);
    if (!isZero(pad)) viol('E_DATA_PAD', `${q(path)} 数据区尾部的 512 对齐填充非全零（夹带）`, where);

    entries.push({ path, mode, data: Buffer.from(data) });
    off = dataStart + padded;
  }

  if (!sawEof) viol('E_NO_EOF_MARKER', '归档缺少两个 512 全零块的结束标记');
  return { entries, totals: { files: entries.length, bytes: totalBytes } };
}

/** gunzip + parseTar 的组合入口 */
export function untarGz(gzBytes) {
  return parseTar(gunzipCanonical(gzBytes));
}
