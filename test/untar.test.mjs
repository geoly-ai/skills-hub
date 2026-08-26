// 受限 tar 解析器 —— 每一类恶意输入一条测试。
// 🔴 断言的是**报出了哪一项违规**，不是「抛了错」：
//    「抛了错」这种断言在实现把 A 的检查删掉、B 的检查提前时依然是绿的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { untarGz, parseTar, gunzipCanonical, canonicalUstarSplit, crc32, MAX_FILES } from '../src/untar.mjs';
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
