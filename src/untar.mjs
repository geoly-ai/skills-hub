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
import { InflateRaw, constants as zlibConstants } from 'node:zlib';
import { parseSafeRelPath } from './safe-fs.mjs';

// ── 上限（01-artifacts.md §5） ──────────────────────────────────────────────
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件 2 MiB
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024; // 解压后总计 16 MiB
export const MAX_FILES = 2000;
export const MAX_DEPTH = 12;
export const MAX_RATIO = 200; // 压缩比 200:1
const BLOCK = 512;
const USTAR_NAME = 100;
const USTAR_PREFIX = 155;
// tar 本身的块开销：每条 512 头 + 至多 511 填充，再加两个结束块
const MAX_TAR_BYTES = MAX_TOTAL_BYTES + MAX_FILES * BLOCK * 2 + 4 * BLOCK;

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
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) viol('E_GZIP_HEADER', 'gzip magic 不是 1f 8b');
  if (buf[2] !== 8) viol('E_GZIP_HEADER', `CM=${buf[2]}，只接受 8（deflate）`);
  if (buf[3] !== 0) {
    const names = ['FTEXT', 'FHCRC', 'FEXTRA', 'FNAME', 'FCOMMENT', 'RES1', 'RES2', 'RES3'];
    const set = names.filter((_, i) => buf[3] & (1 << i));
    viol('E_GZIP_HEADER', `FLG 必须为 0，出现 ${set.join('/')}`);
  }
  const mtime = buf.readUInt32LE(4);
  if (mtime !== 0) viol('E_GZIP_HEADER', `gzip MTIME 必须是 0，得到 ${mtime}`);
  // 🔴 XFL：canonical 要求 level 9，zlib 在 level 9 时写 XFL=2。
  //    这是「level 9」在字节上唯一可观测的痕迹，不判就等于没要求 level 9。
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

  // 🔴 压缩比按**整个 gzip 文件**算 —— 尾随字节已在上面被排除，分母无法被垫大
  if (buf.length > 0 && out.length / buf.length > MAX_RATIO) {
    viol('E_RATIO', `压缩比 ${(out.length / buf.length).toFixed(1)}:1 超过 ${MAX_RATIO}:1`);
  }
  if (crc32(out) !== wantCrc) viol('E_GZIP_CRC', 'gzip CRC32 不符');
  if ((out.length >>> 0) !== wantIsize) viol('E_GZIP_ISIZE', `gzip ISIZE 不符（${out.length >>> 0} vs ${wantIsize}）`);
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
 * 🔴 拒 GNU base-256（首字节高位置 1）—— 那是能表达 >8GB 的扩展编码，
 *    也是绕过长度校验的经典手法。
 */
function octalField(blk, off, len, name, idx, { allowAllNul = false } = {}) {
  const b = blk.subarray(off, off + len);
  if (b[0] & 0x80) viol('E_BASE256', `${name} 用了 GNU base-256 数字编码`, `entry #${idx}`);
  if (allowAllNul && isZero(b)) return 0;
  const body = b.subarray(0, len - 1);
  if (b[len - 1] !== 0) viol('E_OCTAL', `${name} 必须以 NUL 结尾（canonical 八进制布局）`, `entry #${idx}`);
  for (let i = 0; i < body.length; i++) {
    if (body[i] < 0x30 || body[i] > 0x37) {
      viol('E_OCTAL', `${name} 不是 ${len - 1} 位八进制 ASCII`, `entry #${idx}`);
    }
  }
  return parseInt(body.toString('latin1'), 8);
}

/** chksum 域：POSIX 写作 6 位八进制 + NUL + 空格；也接受 7 位 + NUL */
function checksumField(blk, idx) {
  const b = blk.subarray(148, 156);
  if (/^[0-7]{6}\0 $/.test(b.toString('latin1')) || /^[0-7]{7}\0$/.test(b.toString('latin1'))) {
    return parseInt(b.toString('latin1').slice(0, b.toString('latin1').indexOf('\0')), 8);
  }
  return viol('E_CHECKSUM', 'chksum 字段布局不合法', `entry #${idx}`);
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
  if (path === '') viol('E_PATH_EMPTY', '路径为空', where);
  if (path.startsWith('/')) viol('E_PATH_ABS', `绝对路径：${path}`, where);
  if (path.includes('\\')) viol('E_PATH_BACKSLASH', `路径含反斜杠：${path}`, where);
  if (path.includes('\0')) viol('E_PATH_NUL', '路径含 NUL', where);
  const segs = path.split('/');
  if (segs.length > MAX_DEPTH) viol('E_DEPTH', `路径深度 ${segs.length} 超过 ${MAX_DEPTH}：${path}`, where);
  for (const s of segs) {
    if (s === '') viol('E_PATH_EMPTY_SEGMENT', `空 segment（//、首/尾斜杠）：${path}`, where);
    // 🔴 `..` 按 segment 判，不做字符串 includes —— `a..b` 是合法文件名
    if (s === '.' || s === '..') viol('E_PATH_DOTDOT', `segment 是 ${s}：${path}`, where);
    if (!RE_SEGMENT.test(s)) viol('E_PATH_CHARSET', `segment 不是 ASCII-only [A-Za-z0-9._-]：${JSON.stringify(s)}`, where);
    if (s[0] === '.' || s[0] === '-') viol('E_PATH_LEADING', `segment 以 ${s[0]} 开头：${s}`, where);
    if (s.endsWith('.')) viol('E_PATH_TRAILING_DOT', `segment 以 . 结尾：${s}`, where);
    const stem = (s.includes('.') ? s.slice(0, s.indexOf('.')) : s).toUpperCase();
    if (RESERVED.has(stem)) viol('E_PATH_RESERVED', `segment 是保留设备名：${s}`, where);
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
    const tf = blk[156];
    if (tf !== 0x30 && tf !== 0x00) {
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
    const devmajor = octalField(blk, 329, 8, 'devmajor', idx, { allowAllNul: true });
    const devminor = octalField(blk, 337, 8, 'devminor', idx, { allowAllNul: true });

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
      viol('E_PATH_USTAR', `路径无法被 ustar 的 prefix(155)+name(100) 切分：${path}`, where);
    }
    if (canon.prefix !== prefix || canon.name !== name) {
      viol('E_PATH_USTAR_SPLIT',
        `非 canonical 的 ustar 切分：头里是 prefix=${JSON.stringify(prefix)}/name=${JSON.stringify(name)}，` +
        `canonical 是 prefix=${JSON.stringify(canon.prefix)}/name=${JSON.stringify(canon.name)}`, where);
    }

    if (seenPath.has(path)) viol('E_DUP_PATH', `重复路径 ${path}`, where);
    const fold = path.toLowerCase();
    if (seenFold.has(fold)) viol('E_CASE_COLLIDE', `大小写折叠后与已有条目重名：${path}`, where);
    seenPath.add(path);
    seenFold.add(fold);

    // ⑥ 顺序：与树摘要相同的 path 字节序，严格升序（02-registry.md §4.1，参与确定性）
    const pathBuf = Buffer.from(path, 'utf8');
    if (prevPathBuf !== null && Buffer.compare(prevPathBuf, pathBuf) >= 0) {
      viol('E_ORDER', `条目顺序不是 path 字节序严格升序：${prevPathBuf.toString()} 之后出现 ${path}`, where);
    }
    prevPathBuf = pathBuf;

    // ⑦ 上限与数据区
    if (size > MAX_FILE_BYTES) viol('E_FILE_SIZE', `单文件 ${size} 字节超过 ${MAX_FILE_BYTES}：${path}`, where);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) viol('E_TOTAL_SIZE', `解压总计超过 ${MAX_TOTAL_BYTES} 字节`, where);
    if (entries.length + 1 > MAX_FILES) viol('E_FILE_COUNT', `文件数超过 ${MAX_FILES}`, where);

    const dataStart = off + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + padded > tar.length) viol('E_TRUNCATED', `${path} 的数据区被截断`, where);
    const data = tar.subarray(dataStart, dataStart + size);
    const pad = tar.subarray(dataStart + size, dataStart + padded);
    if (!isZero(pad)) viol('E_DATA_PAD', `${path} 数据区尾部的 512 对齐填充非全零（夹带）`, where);

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
