// 受限 tar 解析器 —— 每一类恶意输入一条测试。
// 🔴 断言的是**报出了哪一项违规**，不是「抛了错」：
//    「抛了错」这种断言在实现把 A 的检查删掉、B 的检查提前时依然是绿的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { untarGz, parseTar, gunzipCanonical, canonicalUstarSplit, assertArtifactPath, crc32, MAX_FILES } from '../src/untar.mjs';
import { makeTar, makeGz, makeTarGz, tarHeader } from './fixtures/trustchain-tar.mjs';

/** 跑一次，断言违规码正好是 want */
function expectViolation(want, fn) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.violation, want, `期望违规 ${want}，实际 ${e.violation}：${e.message}`);
    assert.equal(e.code, 2, '解包违规的退出码应为 2（完整性失败）');
    return e;
  }
  assert.fail(`期望违规 ${want}，但没有抛错`);
}

const OK_FILES = [
  { path: 'SKILL.md', data: '---\nname: x\n---\n' },
  { path: 'skill.json', data: '{}\n' },
];

// ── 正路 ────────────────────────────────────────────────────────────────────

test('canonical tar.gz 能解出条目，且路径/mode/内容正确', () => {
  const gz = makeTarGz([
    { path: 'SKILL.md', data: 'hello' },
    { path: 'bin/run.sh', mode: 0o755, data: '#!/bin/sh\n' },
  ]);
  const { entries, totals } = untarGz(gz);
  assert.deepEqual(entries.map(e => e.path), ['SKILL.md', 'bin/run.sh']);
  assert.equal(entries[1].mode, 0o755);
  assert.equal(entries[0].data.toString(), 'hello');
  assert.equal(totals.files, 2);
  assert.equal(totals.bytes, 'hello'.length + '#!/bin/sh\n'.length);
});

test('canonicalUstarSplit：短路径不切、长路径取最长合法 prefix', () => {
  assert.deepEqual(canonicalUstarSplit('a/b.md'), { prefix: '', name: 'a/b.md' });
  const deep = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd', 'eeeeeeeeee',
    'ffffffffff', 'gggggggggg', 'hhhhhhhhhh', 'iiiiiiiiii', 'jjjjjjjjjj', 'k.md'].join('/');
  const s = canonicalUstarSplit(deep);
  assert.ok(Buffer.byteLength(s.prefix) <= 155 && Buffer.byteLength(s.name) <= 100);
  assert.equal(`${s.prefix}/${s.name}`, deep);
});

// ── gzip 层 ─────────────────────────────────────────────────────────────────

test('gzip：FNAME 标志被拒（E_GZIP_HEADER）', () => {
  const raw = makeTar(OK_FILES);
  // FLG=FNAME，并在头后插入一个 NUL 结尾的文件名
  const gz = makeGz(raw, { flg: 0x08 });
  const withName = Buffer.concat([gz.subarray(0, 10), Buffer.from('evil.tar\0'), gz.subarray(10)]);
  expectViolation('E_GZIP_HEADER', () => gunzipCanonical(withName));
});

test('gzip：MTIME 非 0 被拒（E_GZIP_HEADER）', () => {
  expectViolation('E_GZIP_HEADER', () => gunzipCanonical(makeGz(makeTar(OK_FILES), { mtime: 1700000000 })));
});

test('gzip：OS 非 255 被拒 —— Node 自带的 gzipSync 就写 0x03（E_GZIP_HEADER）', () => {
  expectViolation('E_GZIP_HEADER', () => gunzipCanonical(gzipSync(makeTar(OK_FILES), { level: 9 })));
});

test('gzip：CM 非 deflate 被拒（E_GZIP_HEADER）', () => {
  expectViolation('E_GZIP_HEADER', () => gunzipCanonical(makeGz(makeTar(OK_FILES), { cm: 9 })));
});

test('gzip：CRC32 不符被拒（E_GZIP_CRC）', () => {
  expectViolation('E_GZIP_CRC', () => gunzipCanonical(makeGz(makeTar(OK_FILES), { crc: 0xdeadbeef })));
});

test('gzip：ISIZE 不符被拒（E_GZIP_ISIZE）', () => {
  const raw = makeTar(OK_FILES);
  expectViolation('E_GZIP_ISIZE', () => gunzipCanonical(makeGz(raw, { isize: raw.length + 1 })));
});

test('gzip：多 member 串接被拒（E_GZIP_MULTIMEMBER）', () => {
  const a = makeGz(makeTar(OK_FILES));
  const b = makeGz(makeTar([{ path: 'evil.md', data: 'x' }]));
  expectViolation('E_GZIP_MULTIMEMBER', () => gunzipCanonical(Buffer.concat([a, b])));
});

test('gzip：XFL 不是 2（非 level 9）被拒（E_GZIP_HEADER）', () => {
  expectViolation('E_GZIP_HEADER', () => gunzipCanonical(makeGz(makeTar(OK_FILES), { xfl: 0 })));
  expectViolation('E_GZIP_HEADER', () => gunzipCanonical(makeGz(makeTar(OK_FILES), { xfl: 4 })));
});

// 🔴 回归：Codex 第二轮实测出来的绕过。
// deflate 流结束之后追加垃圾 + 一份拷贝的 8 字节尾 —— CRC 与 ISIZE 都对得上，
// `inflateRawSync` / `gunzipSync` 都不报错，于是夹带被接受，
// **而且分母被垫大，压缩比从 988:1 掉到 113:1，直接绕过 200:1 的解压炸弹上限**。
test('🔴 回归：deflate 流之后追加垃圾被拒（E_GZIP_TRAILER），不再垫大压缩比分母', () => {
  const raw = makeTar([{ path: 'a.md', data: Buffer.alloc(2 * 1024 * 1024) }]);
  const gz = makeGz(raw);
  assert.ok(raw.length / gz.length > 900, '夹具本身必须是个真炸弹');
  for (const n of [1, 8192, 16384, 65536]) {
    const junkPlusTrailer = Buffer.alloc(n + 8);
    junkPlusTrailer.fill(0x5a, 0, n);
    gz.subarray(-8).copy(junkPlusTrailer, n); // 把真尾拷到末尾，让 CRC/ISIZE 仍然对得上
    const e = expectViolation('E_GZIP_TRAILER', () => gunzipCanonical(Buffer.concat([gz, junkPlusTrailer])));
    assert.match(e.message, /尾随数据/);
  }
});

test('🔴 回归：Codex 给的最小构造（8 字节垃圾 + 伪造 trailer）也被拒', () => {
  const g = makeTarGz([{ path: 'a.md', data: 'x' }]);
  const suffix = Buffer.alloc(16);
  g.subarray(-8).copy(suffix, 8);
  expectViolation('E_GZIP_TRAILER', () => untarGz(Buffer.concat([g, suffix])));
});

test('gzip：解压炸弹被 maxOutputLength 挡住（E_TOTAL_SIZE）', () => {
  const bomb = Buffer.alloc(64 * 1024 * 1024, 0); // 64 MiB 全零，压完只有几十 KB
  expectViolation('E_TOTAL_SIZE', () => gunzipCanonical(makeGz(bomb)));
});

test('gzip：压缩比超过 200:1 被拒（E_RATIO）', () => {
  // 5 MiB 全零：能解开（未超总量上限），但压缩比远超 200:1
  const raw = Buffer.alloc(5 * 1024 * 1024, 0);
  const gz = makeGz(raw);
  assert.ok(raw.length / gz.length > 200, '夹具本身要真的超过 200:1');
  expectViolation('E_RATIO', () => gunzipCanonical(gz));
});

// ── 路径穿越与路径 grammar ─────────────────────────────────────────────────

test('路径穿越 ../ 被拒（E_PATH_DOTDOT）', () => {
  expectViolation('E_PATH_DOTDOT', () => untarGz(makeTarGz([{ path: '../evil.md', data: 'x' }])));
});

test('深层路径穿越 a/../../evil 被拒（E_PATH_DOTDOT）', () => {
  expectViolation('E_PATH_DOTDOT', () => untarGz(makeTarGz([{ path: 'a/../../evil.md', data: 'x' }])));
});

test('绝对路径被拒（E_PATH_ABS）', () => {
  expectViolation('E_PATH_ABS', () => untarGz(makeTarGz([{ path: '/etc/passwd', data: 'x' }])));
});

test('反斜杠路径被拒（E_PATH_BACKSLASH）', () => {
  expectViolation('E_PATH_BACKSLASH', () => untarGz(makeTarGz([{ path: 'a\\b.md', data: 'x' }])));
});

test('非 ASCII 路径被拒（E_PATH_CHARSET，D9）', () => {
  expectViolation('E_PATH_CHARSET', () => untarGz(makeTarGz([{ path: 'skill-中文.md', data: 'x' }])));
});

test('a..b 是合法文件名 —— .. 必须按 segment 判，不是字符串 includes', () => {
  const { entries } = untarGz(makeTarGz([{ path: 'a..b.md', data: 'x' }]));
  assert.deepEqual(entries.map(e => e.path), ['a..b.md']);
});

test('以 . 开头的 segment 被拒（E_PATH_LEADING）', () => {
  expectViolation('E_PATH_LEADING', () => untarGz(makeTarGz([{ path: '.hidden.md', data: 'x' }])));
});

test('以 - 开头的 segment 被拒（E_PATH_LEADING）', () => {
  expectViolation('E_PATH_LEADING', () => untarGz(makeTarGz([{ path: '-rf.md', data: 'x' }])));
});

test('以 . 结尾的 segment 被拒（E_PATH_TRAILING_DOT）', () => {
  expectViolation('E_PATH_TRAILING_DOT', () => untarGz(makeTarGz([{ path: 'weird.', data: 'x' }])));
});

test('保留设备名 CON / NUL.txt 被拒（E_PATH_RESERVED）', () => {
  expectViolation('E_PATH_RESERVED', () => untarGz(makeTarGz([{ path: 'CON', data: 'x' }])));
  expectViolation('E_PATH_RESERVED', () => untarGz(makeTarGz([{ path: 'nul.txt', data: 'x' }])));
  expectViolation('E_PATH_RESERVED', () => untarGz(makeTarGz([{ path: 'a/COM9.md', data: 'x' }])));
});

test('空 segment（a//b）被拒（E_PATH_EMPTY_SEGMENT）', () => {
  expectViolation('E_PATH_EMPTY_SEGMENT', () => untarGz(makeTarGz([{ path: 'a//b.md', data: 'x' }])));
});

test('深度超过 12 被拒（E_DEPTH）', () => {
  const deep = Array.from({ length: 13 }, (_, i) => `d${i}`).join('/') + '/f.md';
  expectViolation('E_DEPTH', () => untarGz(makeTarGz([{ path: deep, data: 'x' }])));
});

test('重复路径被拒（E_DUP_PATH）', () => {
  const tar = makeTar([{ path: 'a.md', data: '1' }, { path: 'a.md', data: '2' }], { sort: false });
  expectViolation('E_DUP_PATH', () => parseTar(tar));
});

test('大小写折叠后重名被拒（E_CASE_COLLIDE，macOS 上会互相覆盖）', () => {
  expectViolation('E_CASE_COLLIDE', () => untarGz(makeTarGz([{ path: 'README.md', data: '1' }, { path: 'readme.md', data: '2' }])));
});

test('条目顺序不是 path 字节序升序被拒（E_ORDER）', () => {
  const tar = makeTar([{ path: 'b.md', data: '1' }, { path: 'a.md', data: '2' }], { sort: false });
  expectViolation('E_ORDER', () => parseTar(tar));
});

test('非 canonical 的 ustar 切分被拒（E_PATH_USTAR_SPLIT）', () => {
  // 同一条路径切成 prefix=''/name='a/b.md'（合法但非 canonical？）——
  // 这里反过来：短路径本应 prefix 为空，却硬塞进 prefix
  const h = tarHeader({ path: 'a/b.md', size: 1, over: { prefix: 'a', name: 'b.md' } });
  const tar = Buffer.concat([h, Buffer.alloc(512), Buffer.alloc(512), Buffer.alloc(512)]);
  tar[512] = 0x78; // 数据 1 字节
  const fixed = Buffer.concat([
    tarHeader({ path: 'a/b.md', size: 1, over: { prefix: 'a', name: 'b.md' } }),
    Buffer.concat([Buffer.from('x'), Buffer.alloc(511)]),
    Buffer.alloc(512), Buffer.alloc(512),
  ]);
  expectViolation('E_PATH_USTAR_SPLIT', () => parseTar(fixed));
  void tar;
});

// ── typeflag：每一类非普通文件 ─────────────────────────────────────────────

const TYPEFLAG_CASES = [
  ['1', 'hardlink'], ['2', 'symlink'], ['3', 'chardev'], ['4', 'blockdev'],
  ['5', 'directory'], ['6', 'fifo'], ['7', 'contiguous'],
  ['x', 'PAX 扩展头'], ['g', 'PAX 全局头'],
  ['L', 'GNU longname'], ['K', 'GNU longlink'], ['S', 'GNU sparse'],
  ['D', 'GNU dumpdir'], ['M', 'GNU multivolume'], ['V', 'GNU volume label'],
];
for (const [flag, label] of TYPEFLAG_CASES) {
  test(`typeflag '${flag}'（${label}）被拒（E_TYPEFLAG）`, () => {
    const h = tarHeader({ path: 'a.md', size: 0, typeflag: flag });
    const e = expectViolation('E_TYPEFLAG', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
    assert.match(e.message, /拒绝/);
  });
}

test('未知 typeflag（vendor 扩展 Z）被拒（E_TYPEFLAG）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, typeflag: 'Z' });
  const e = expectViolation('E_TYPEFLAG', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
  assert.match(e.message, /未知 typeflag 0x5a/);
});

test('symlink 条目即使 linkname 指向 ../ 也在 typeflag 这一关就被挡下', () => {
  const h = tarHeader({ path: 'a.md', size: 0, typeflag: '2', over: { linkname: '../../../etc/passwd' } });
  expectViolation('E_TYPEFLAG', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('普通文件条目带非零 linkname 被拒（E_LINKNAME）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { linkname: 'somewhere' } });
  expectViolation('E_LINKNAME', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

// ── §6.2：摘要不覆盖的东西 ─────────────────────────────────────────────────

test('uid 非 0 被拒（E_UID）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { uid: 501 } });
  expectViolation('E_UID', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('gid 非 0 被拒（E_GID）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { gid: 20 } });
  expectViolation('E_GID', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('mtime 非 0 被拒（E_MTIME）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { mtime: 1700000000 } });
  expectViolation('E_MTIME', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('uname 非空被拒（E_UNAME）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { uname: 'root' } });
  expectViolation('E_UNAME', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('gname 非空被拒（E_GNAME）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { gname: 'wheel' } });
  expectViolation('E_GNAME', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('devmajor/devminor 非 0 被拒（E_DEV）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { devmajor: 1 } });
  expectViolation('E_DEV', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('头部 500..511 保留区夹带数据被拒（E_HEADER_PAD）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { headerPad: 'SMUGGLED' } });
  expectViolation('E_HEADER_PAD', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('字段 NUL 之后夹带数据被拒（E_FIELD_PAD）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { raw: (b) => { b.write('EVIL', 20, 4, 'latin1'); } } });
  expectViolation('E_FIELD_PAD', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

// ── mode ────────────────────────────────────────────────────────────────────

test('mode 0777 被拒（E_MODE）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, mode: 0o777 });
  expectViolation('E_MODE', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('setuid 位（04755）被拒（E_MODE）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, mode: 0o4755 });
  const e = expectViolation('E_MODE', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
  assert.match(e.message, /04755/);
});

test('sticky 位（01755）被拒（E_MODE）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, mode: 0o1755 });
  expectViolation('E_MODE', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

// ── 数字域编码 ──────────────────────────────────────────────────────────────

test('GNU base-256 数字编码被拒（E_BASE256）', () => {
  const h = tarHeader({
    path: 'a.md', size: 0,
    over: { raw: (b) => { b[124] = 0x80; b.writeUInt32BE(0xffffffff, 132); } },
  });
  expectViolation('E_BASE256', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('非八进制的数字域被拒（E_OCTAL）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { raw: (b) => { b.write('0000009', 124, 7, 'latin1'); } } });
  expectViolation('E_OCTAL', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('数字域缺 NUL 终止被拒（E_OCTAL）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { raw: (b) => { b.write('00000000000', 124, 11, 'latin1'); b[135] = 0x20; } } });
  expectViolation('E_OCTAL', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

// ── magic / checksum / 结构 ────────────────────────────────────────────────

test('v7 老 tar（magic 全零）被拒（E_MAGIC）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { magic: '\0\0\0\0\0\0', version: '\0\0' } });
  expectViolation('E_MAGIC', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('GNU tar 变体（magic "ustar  "）被拒（E_MAGIC）', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { magic: 'ustar ', version: ' \0' } });
  expectViolation('E_MAGIC', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('头部 checksum 不符被拒（E_CHECKSUM）', () => {
  const h = tarHeader({ path: 'a.md', size: 0 });
  h.write('000000\0 ', 148, 8, 'latin1');
  expectViolation('E_CHECKSUM', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('缺少结束标记被拒（E_NO_EOF_MARKER）', () => {
  const h = tarHeader({ path: 'a.md', size: 0 });
  expectViolation('E_NO_EOF_MARKER', () => parseTar(h));
});

test('只有一个全零结束块被拒（E_NO_EOF_MARKER）', () => {
  const h = tarHeader({ path: 'a.md', size: 0 });
  expectViolation('E_NO_EOF_MARKER', () => parseTar(Buffer.concat([h, Buffer.alloc(512)])));
});

test('结束标记之后夹带非零数据被拒（E_TRAILING，tar smuggling）', () => {
  const tar = makeTar(OK_FILES, { trailing: Buffer.concat([Buffer.from('SMUGGLED'), Buffer.alloc(504)]) });
  expectViolation('E_TRAILING', () => parseTar(tar));
});

test('结束标记之后多余的全零块被拒（E_TRAILING_BLOCKS，非 canonical）', () => {
  const tar = makeTar(OK_FILES, { eofBlocks: 20 }); // GNU tar 默认补到 20 块
  expectViolation('E_TRAILING_BLOCKS', () => parseTar(tar));
});

test('tar 长度不是 512 倍数被拒（E_TRUNCATED）', () => {
  const tar = makeTar(OK_FILES);
  expectViolation('E_TRUNCATED', () => parseTar(tar.subarray(0, tar.length - 3)));
});

test('数据区被截断被拒（E_TRUNCATED）', () => {
  const h = tarHeader({ path: 'a.md', size: 1024 });
  expectViolation('E_TRUNCATED', () => parseTar(Buffer.concat([h, Buffer.alloc(512)])));
});

test('数据区尾部填充夹带数据被拒（E_DATA_PAD）', () => {
  const data = Buffer.from('hi');
  const h = tarHeader({ path: 'a.md', size: data.length });
  const pad = Buffer.alloc(510); pad.write('SMUGGLED', 0, 'latin1');
  expectViolation('E_DATA_PAD', () => parseTar(Buffer.concat([h, data, pad, Buffer.alloc(1024)])));
});

// ── 上限 ────────────────────────────────────────────────────────────────────

test('单文件超过 2 MiB 被拒（E_FILE_SIZE）', () => {
  // 走 parseTar：全零 2 MiB 会先撞上 200:1 的压缩比上限，测不到这一条
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41);
  expectViolation('E_FILE_SIZE', () => parseTar(makeTar([{ path: 'big.bin', data: big }])));
});

test('解压总计超过 16 MiB 被拒（E_TOTAL_SIZE）', () => {
  // 每个 1.9 MiB，10 个 = 19 MiB > 16 MiB。内容随机以免压缩比先触发。
  const files = Array.from({ length: 10 }, (_, i) => ({
    path: `f${i}.bin`,
    data: Buffer.from(Array.from({ length: 1900000 }, (_, k) => (k * 7 + i * 13) & 0xff)),
  }));
  expectViolation('E_TOTAL_SIZE', () => parseTar(makeTar(files)));
});

test('文件数超过 2000 被拒（E_FILE_COUNT）', () => {
  const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `f${String(i).padStart(5, '0')}.md`, data: 'x' }));
  expectViolation('E_FILE_COUNT', () => parseTar(makeTar(files)));
});

test('恰好 2000 个文件可以通过', () => {
  const files = Array.from({ length: MAX_FILES }, (_, i) => ({ path: `f${String(i).padStart(5, '0')}.md`, data: 'x' }));
  const { totals } = parseTar(makeTar(files));
  assert.equal(totals.files, MAX_FILES);
});

// ── crc32 自检 ──────────────────────────────────────────────────────────────

test('crc32 与 zlib 一致（夹具与实现共用它，得先证明它是对的）', () => {
  const data = Buffer.from('The quick brown fox jumps over the lazy dog');
  const gz = gzipSync(data);
  assert.equal(crc32(data), gz.readUInt32LE(gz.length - 8));
  void deflateRawSync;
});

// ── ERRATA E-6：macOS AppleDouble 注入 ─────────────────────────────────────
// 🔴 这些条目本来就会被 E_PATH_LEADING 挡住 —— 这里断言的是**报出了专门的码**，
//    因为打包的人从 `tar -tvf` 根本看不到这个成员，报「segment 以 . 开头」帮不到他。

test('AppleDouble 成员 ._SKILL.md 报专门的 E_APPLEDOUBLE，不是笼统的 E_PATH_LEADING', () => {
  const e = expectViolation('E_APPLEDOUBLE', () => untarGz(makeTarGz([{ path: '._SKILL.md', data: 'x' }])));
  assert.match(e.message, /COPYFILE_DISABLE=1/, '诊断里必须给出处方，否则等于没帮上忙');
  assert.match(e.message, /AppleDouble/);
});

test('AppleDouble 出现在子目录里（sub/._a.md）同样报 E_APPLEDOUBLE', () => {
  expectViolation('E_APPLEDOUBLE', () => untarGz(makeTarGz([{ path: 'sub/._a.md', data: 'x' }])));
});

test('E_APPLEDOUBLE 只针对 ._ 前缀 —— 单个 . 开头仍报 E_PATH_LEADING（不抢别人的码）', () => {
  expectViolation('E_PATH_LEADING', () => untarGz(makeTarGz([{ path: '.hidden', data: 'x' }])));
});

// ── 唯一字节编码（ERRATA E-3 的推论）：同一逻辑条目不得有第二种合法写法 ──────

test('typeflag NUL（v7 老 tar 的普通文件写法）被拒 —— ustar 下唯一规范值是 "0"', () => {
  const h = tarHeader({ path: 'a.md', size: 0, typeflag: '\0' });
  const e = expectViolation('E_TYPEFLAG', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
  assert.match(e.message, /v7|唯一性/);
});

test('devmajor/devminor 写成全 NUL 被拒 —— canonical 是八进制零，不接受第二种写法', () => {
  const h = tarHeader({ path: 'a.md', size: 0, over: { raw: (b) => { b.fill(0, 329, 345); } } });
  expectViolation('E_OCTAL', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
});

test('chksum 写成 7 位八进制 + NUL 被拒 —— canonical 只接受 6 位 + NUL + 空格', () => {
  const h = tarHeader({ path: 'a.md', size: 0 });
  // 取出实现认可的校验和，改写成等价的 7 位布局：值一样，字节不一样
  const val = parseInt(h.subarray(148, 154).toString('latin1'), 8);
  h.write(val.toString(8).padStart(7, '0') + '\0', 148, 8, 'latin1');
  const e = expectViolation('E_CHECKSUM', () => parseTar(Buffer.concat([h, Buffer.alloc(1024)])));
  assert.match(e.message, /布局/);
});

test('canonical 的 chksum 布局（6 位 + NUL + 空格）仍然通过 —— 收窄没有误伤正路', () => {
  const { entries } = untarGz(makeTarGz(OK_FILES));
  assert.equal(entries.length, 2);
});

// ── 诊断消息里的攻击者字节必须被转义 ───────────────────────────────────────
// 🔴 charset 检查排在 `..` / 绝对路径 / 反斜杠 / 空 segment / 深度**之后**，
//    那几条消息拿到的是原始字节。ANSI 转义序列会被终端与日志解释。

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// 用码点构造，避免源文件里出现裸控制字符
const CTRL = new RegExp('[\\u0000-\\u001f\\u007f]');

const INJECTION_CASES = [
  ['E_PATH_ABS', '/' + ESC + '[2Jwiped'],
  ['E_PATH_BACKSLASH', 'a\\' + ESC + '[31mred'],
  ['E_PATH_EMPTY_SEGMENT', 'a//' + ESC + '[1mX'],
  ['E_DEPTH', Array(14).fill('a' + ESC).join('/')],
];
for (const [want, path] of INJECTION_CASES) {
  test(`诊断消息不得原样吐出控制字符：${want}`, () => {
    const e = expectViolation(want, () => parseTar(makeTar([{ path, data: 'x' }])));
    assert.ok(!CTRL.test(e.message),
      `消息里出现了未转义的控制字符，可被用来注入终端转义序列：${JSON.stringify(e.message)}`);
  });
}

test('ANSI 转义注入：改终端标题的序列不会原样出现在消息里', () => {
  const evil = '/' + ESC + ']0;PWNED' + BEL + 'x';
  const e = expectViolation('E_PATH_ABS', () => parseTar(makeTar([{ path: evil, data: 'x' }])));
  assert.ok(!e.message.includes(ESC), '消息里仍含裸 ESC 字节');
  assert.ok(!e.message.includes(BEL), '消息里仍含裸 BEL 字节');
  assert.match(e.message, /\\u001b/, '应当以 uXXXX 的形式转义后出现，而不是被整段丢掉');
});

// ── ERRATA E-3：唯一切分（真·两种都结构合法的场景） ────────────────────────
// 🔴 原有的 E_PATH_USTAR_SPLIT 测试用的是「短路径硬塞进 prefix」——
//    那种 alt 切分其实不是「另一个合法切分」，证明力弱。这里用一条 145 字节、
//    **确实存在两个都满足 prefix≤155 且 name≤100 的切点**的路径。

const TWO_SPLIT_PATH = 'a'.repeat(50) + '/' + 'b'.repeat(60) + '/' + 'c'.repeat(30) + '.md';

test('E-3：两个切分都结构合法时，只接受 prefix 最长的那个', () => {
  const canon = canonicalUstarSplit(TWO_SPLIT_PATH);
  assert.equal(canon.prefix.length, 111, 'canonical 应取最长合法 prefix');
  assert.equal(canon.name.length, 33);

  // 另一个切点：prefix=50、name=94，两边都在字段容量内 —— 结构上完全合法
  const alt = { prefix: 'a'.repeat(50), name: 'b'.repeat(60) + '/' + 'c'.repeat(30) + '.md' };
  assert.ok(alt.prefix.length <= 155 && Buffer.byteLength(alt.name) <= 100,
    '前提：alt 必须真的是一个结构合法的切分，否则这条测试没有证明力');

  const { entries } = parseTar(makeTar([{ path: TWO_SPLIT_PATH, data: 'x' }]));
  assert.equal(entries[0].path, TWO_SPLIT_PATH, 'canonical 切分必须能通过');

  expectViolation('E_PATH_USTAR_SPLIT',
    () => parseTar(makeTar([{ path: TWO_SPLIT_PATH, data: 'x', over: alt }])));
});

test('name 与 prefix 双双填满字段（155 + 100，无 NUL 终止）仍能正确还原路径', () => {
  const p = 'p'.repeat(155) + '/' + 'n'.repeat(97) + '.md';
  assert.equal(Buffer.byteLength(p), 256);
  const { entries } = parseTar(makeTar([{ path: p, data: 'x' }]));
  assert.equal(entries[0].path, p);
});

test('归档中段的假 EOF 之后夹带真条目被拒（E_TRAILING）', () => {
  const dataBlk = Buffer.concat([Buffer.from('x'), Buffer.alloc(511)]);
  const sneaky = Buffer.concat([
    tarHeader({ path: 'a.md', size: 1 }), dataBlk,
    Buffer.alloc(512), Buffer.alloc(512), // 假 EOF：解析器在这里停下
    tarHeader({ path: 'z.md', size: 1 }), dataBlk, // 宽松的 reader 会继续读到它
    Buffer.alloc(512), Buffer.alloc(512),
  ]);
  expectViolation('E_TRAILING', () => parseTar(sneaky));
});

// ── 🔴 Codex 第三轮：分母在 deflate **流内部**被垫大 ───────────────────────
// 上一轮堵的是「流之后追加垃圾」。这一轮的构造在同一条合法 deflate 流里做手脚，
// bytesWritten 照样等于 body.length，E_GZIP_TRAILER 完全看不见。

/** 造 n 个零输出的 stored block：BFINAL=0、BTYPE=00、LEN=0、NLEN=0xffff */
function emptyStoredBlocks(n) {
  const pad = Buffer.alloc(n * 5);
  for (let i = 0; i < n; i++) { pad[i * 5 + 3] = 0xff; pad[i * 5 + 4] = 0xff; }
  return pad;
}

test('🔴 回归：deflate 内部塞零输出空块垫大分母，仍被 E_RATIO 挡住', () => {
  const raw = makeTar([{ path: 'a.md', data: Buffer.alloc(2 * 1024 * 1024) }]);
  const real = deflateRawSync(raw, { level: 9 });
  const gz = makeGz(raw, { body: Buffer.concat([emptyStoredBlocks(1675), real]) });

  // 前提：这份构造确实把观测到的压缩比压到了 200:1 以下 —— 否则测试没有证明力
  assert.ok(raw.length / gz.length < 200,
    `构造失效：观测压缩比仍是 ${(raw.length / gz.length).toFixed(1)}:1，没有真的绕过旧判定`);
  assert.ok(raw.length / (real.length + 18) > 900, '前提：真实压缩比应远超 200:1');

  const e = expectViolation('E_RATIO', () => gunzipCanonical(gz));
  assert.match(e.message, /canonical 重压缩/, '必须说明分母是重压缩算出来的，不是文件自称的');
});

test('🔴 回归：空块填充也会把 body 顶出 canonical 长度上限（E_GZIP_NONCANONICAL）', () => {
  // 用一份压缩比本来就不高的内容，把 E_RATIO 排除掉，单独考 body 长度这一关
  const raw = makeTar([{ path: 'a.md', data: randomBytes(200 * 1024) }]);
  const real = deflateRawSync(raw, { level: 9 });
  const gz = makeGz(raw, { body: Buffer.concat([emptyStoredBlocks(20000), real]) });
  expectViolation('E_GZIP_NONCANONICAL', () => gunzipCanonical(gz));
});

test('🔴 回归：XFL=2 撒谎（body 其实是 level 0）被拒（E_GZIP_NONCANONICAL）', () => {
  const raw = makeTar([{ path: 'a.md', data: 'hello' }]);
  const body = deflateRawSync(raw, { level: 0 });
  const l9 = deflateRawSync(raw, { level: 9 });
  assert.ok(body.length > l9.length * 5, '前提：level 0 与 level 9 的体积差必须足够大');
  const e = expectViolation('E_GZIP_NONCANONICAL', () => gunzipCanonical(makeGz(raw, { body, xfl: 2 })));
  assert.match(e.message, /level 9/);
});


test('正常制品不会被 canonical 长度上限误伤（level 9 原样打包）', () => {
  const raw = makeTar([{ path: 'a.md', data: randomBytes(64 * 1024) }]);
  const out = gunzipCanonical(makeGz(raw));
  assert.equal(out.length, raw.length);
});

// ── 同名既是文件又是目录 ───────────────────────────────────────────────────

test('同一个名字既当文件又当目录被拒（E_PATH_FILE_DIR_COLLIDE），且在落盘之前', () => {
  const e = expectViolation('E_PATH_FILE_DIR_COLLIDE',
    () => untarGz(makeTarGz([{ path: 'a', data: 'file' }, { path: 'a/b.md', data: 'x' }])));
  assert.match(e.message, /目录/);
});

test('大小写折叠后的文件/目录冲突也被拒（macOS 上会互相覆盖）', () => {
  expectViolation('E_PATH_FILE_DIR_COLLIDE',
    () => untarGz(makeTarGz([{ path: 'A', data: 'file' }, { path: 'a/b.md', data: 'x' }])));
});

test('多层祖先都要查：a/b 是文件时 a/b/c.md 被拒', () => {
  expectViolation('E_PATH_FILE_DIR_COLLIDE',
    () => untarGz(makeTarGz([{ path: 'a/b', data: 'file' }, { path: 'a/b/c.md', data: 'x' }])));
});

test('前缀相同但不在 segment 边界上的不算冲突（ab.md 与 a/b.md 可以共存）', () => {
  const { entries } = untarGz(makeTarGz([{ path: 'ab.md', data: 'x' }, { path: 'a/b.md', data: 'y' }]));
  assert.equal(entries.length, 2, 'a 不是 ab.md 的祖先，不该误伤');
});

test('正常的同目录多文件不被误伤', () => {
  const { entries } = untarGz(makeTarGz([
    { path: 'a/b.md', data: 'x' }, { path: 'a/c.md', data: 'y' }, { path: 'a/d/e.md', data: 'z' },
  ]));
  assert.equal(entries.length, 3);
});

// ── 上限的**下侧**边界：恰好等于上限必须通过 ───────────────────────────────
// 🔴 只测「超了被拒」是不够的：把某个 > 改成 >= 也照样绿，而那会拒掉合法制品。

test('恰好 2 MiB 的单文件可以通过（MAX_FILE_BYTES 边界）', () => {
  // 🔴 内容必须不可压缩：2 MiB 全零的真实压缩比约 990:1，会**合法地**触发 E_RATIO，
  //    那样这条测试考的就不是 MAX_FILE_BYTES 了。
  const { entries } = untarGz(makeTarGz([{ path: 'a.md', data: randomBytes(2 * 1024 * 1024) }]));
  assert.equal(entries[0].data.length, 2 * 1024 * 1024);
});

test('恰好 16 MiB 总计（8 × 2 MiB）可以通过（MAX_TOTAL_BYTES 边界）', () => {
  const files = Array.from({ length: 8 }, (_, i) => ({
    path: `f${i}.md`, data: randomBytes(2 * 1024 * 1024), // 同上：必须不可压缩
  }));
  const { totals } = untarGz(makeTarGz(files));
  assert.equal(totals.bytes, 16 * 1024 * 1024);
  assert.equal(totals.files, 8);
});

test('恰好 12 层深度可以通过（MAX_DEPTH 边界）', () => {
  const path = Array.from({ length: 11 }, (_, i) => `d${i}`).join('/') + '/leaf.md';
  assert.equal(path.split('/').length, 12);
  const { entries } = untarGz(makeTarGz([{ path, data: 'x' }]));
  assert.equal(entries[0].path, path);
});

test('13 层深度被拒（E_DEPTH）—— 与上一条一起把边界钉死', () => {
  const path = Array.from({ length: 12 }, (_, i) => `d${i}`).join('/') + '/leaf.md';
  assert.equal(path.split('/').length, 13);
  expectViolation('E_DEPTH', () => untarGz(makeTarGz([{ path, data: 'x' }])));
});

test('空 deflate 输出（0 字节 tar）一路走到 parseTar 才报 E_TRUNCATED', () => {
  // 断言的是「gzip 层全过、由 tar 层拒绝」：重压缩、比例、CRC/ISIZE 都不该在空输出上先炸
  expectViolation('E_TRUNCATED', () => untarGz(makeGz(Buffer.alloc(0))));
});

// ── 补齐没有测试的违规码 ───────────────────────────────────────────────────

test('deflate 流本身损坏被拒（E_GZIP_DEFLATE）', () => {
  const raw = makeTar(OK_FILES);
  const gz = Buffer.from(makeGz(raw));
  // 打乱 deflate body 的中段（避开 10 字节头与 8 字节尾）
  for (let i = 12; i < gz.length - 10; i++) gz[i] ^= 0xa5;
  const e = expectViolation('E_GZIP_DEFLATE', () => gunzipCanonical(gz));
  assert.match(e.message, /deflate 流损坏/);
});

test('assertArtifactPath 直接拿到含 NUL 的路径时报 E_PATH_NUL', () => {
  // 🔴 走 parseTar 到不了这里：cstrField 在 NUL 处截断，路径里不可能残留 NUL。
  //    但 assertArtifactPath 是导出的，artifact.mjs 也直接调它做纵深防御 ——
  //    这条判定是给「调用方给了别的来源的字符串」准备的，得证明它真的在。
  expectViolation('E_PATH_NUL', () => assertArtifactPath('a' + String.fromCharCode(0) + 'b/c.md'));
});

// ── 目录名之间的大小写冲突 ─────────────────────────────────────────────────
// 🔴 两条路径各自都不折叠重名，但目录在大小写不敏感的文件系统上是同一个。
//    不判的话：同一份 asset 在 Linux 上装得上、在 macOS 上装不上。

test('A/x.md 与 a/y.md 目录大小写冲突被拒（E_CASE_COLLIDE）', () => {
  // 前提：两条完整路径折叠后并不相同，所以旧的整条路径折叠判定抓不到它
  assert.notEqual('A/x.md'.toLowerCase(), 'a/y.md'.toLowerCase());
  const e = expectViolation('E_CASE_COLLIDE',
    () => untarGz(makeTarGz([{ path: 'A/x.md', data: '1' }, { path: 'a/y.md', data: '2' }])));
  assert.match(e.message, /目录/);
});

test('更深一层的目录大小写冲突也被拒（p/A/… 与 p/a/…）', () => {
  expectViolation('E_CASE_COLLIDE',
    () => untarGz(makeTarGz([{ path: 'p/A/x.md', data: '1' }, { path: 'p/a/y.md', data: '2' }])));
});

test('同一目录反复出现（拼写一致）不被误伤', () => {
  const { entries } = untarGz(makeTarGz([
    { path: 'A/x.md', data: '1' }, { path: 'A/y.md', data: '2' }, { path: 'A/z/w.md', data: '3' },
  ]));
  assert.equal(entries.length, 3);
});

test('拼写不同但折叠后也不同的目录可以共存（Ab 与 aB 才算冲突，Ab 与 Ac 不算）', () => {
  const { entries } = untarGz(makeTarGz([{ path: 'Ab/x.md', data: '1' }, { path: 'Ac/y.md', data: '2' }]));
  assert.equal(entries.length, 2);
});

// ── 🔴 Codex 第四轮：输入侧没有上限 ───────────────────────────────────────

test('超大 gzip 输入在任何解压之前就被拒（E_GZIP_SIZE）', () => {
  // 几百万个零输出 stored block：解压出来几乎什么都没有，却要我们完整 inflate + 重压缩。
  // maxOutputLength 只管输出侧，管不到这个。
  const n = 4_200_000; // 约 21 MB body，越过 ~19 MB 的输入上限
  const body = Buffer.alloc((n + 1) * 5);
  for (let i = 0; i <= n; i++) {
    const o = i * 5;
    body[o] = i === n ? 1 : 0; // 最后一块 BFINAL=1
    body[o + 3] = 0xff; body[o + 4] = 0xff;
  }
  const gz = Buffer.concat([
    Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255]), body, Buffer.alloc(8),
  ]);
  assert.ok(gz.length > 20 * 1024 * 1024, '前提：构造必须真的超过输入上限');
  const e = expectViolation('E_GZIP_SIZE', () => gunzipCanonical(gz));
  assert.match(e.message, /超过/);
});

test('正常大小的 gzip 不被输入上限误伤（16 MiB 不可压缩内容打包后仍可解）', () => {
  const files = Array.from({ length: 8 }, (_, i) => ({
    path: `f${i}.md`, data: randomBytes(2 * 1024 * 1024),
  }));
  const { totals } = untarGz(makeTarGz(files));
  assert.equal(totals.bytes, 16 * 1024 * 1024);
});

test('🔴 已知残留：不可压缩内容上 CANON_SLACK 挡不住伪造的 XFL（记录现状，不是期望）', () => {
  // Codex 第四轮的反例。留这条测试是为了**锁住已知边界**：
  // 哪天有人把 CANON_SLACK 说成「level 9 的证明」，这条会提醒他不是。
  const data = Buffer.alloc(200 * 1024);
  let x = 0x12345678;
  for (let i = 0; i < data.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; data[i] = x & 0xff;
  }
  const raw = makeTar([{ path: 'a.bin', data }]);
  const l0 = deflateRawSync(raw, { level: 0, windowBits: 15, memLevel: 8, strategy: 0 });
  const l9 = deflateRawSync(raw, { level: 9, windowBits: 15, memLevel: 8, strategy: 0 });
  assert.ok(l0.length < Math.floor(l9.length * 1.1) + 64,
    '前提：不可压缩内容上 level 0 与 level 9 的差必须落在 slack 之内，否则这条记录就过期了');

  // 现状：被接受。压缩比的安全性不依赖这一关（由 canonical 分母保证），
  // 这里只是 gzip 字节层面的非规范性。
  const { entries } = untarGz(makeGz(raw, { body: l0, xfl: 2 }));
  assert.equal(entries.length, 1);
});
