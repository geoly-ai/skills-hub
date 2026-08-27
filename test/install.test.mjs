// install：canonical ustar 写入 / 幂等五分支 rename / 提交点前的 trust floor 复验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { treeDigest } from '../src/tree-digest.mjs';
import { parseTar } from '../src/untar.mjs';
import { crc32cHex as srcCrc } from '../src/crc32c.mjs';
import { crc32cHex as harnessCrc } from './harness/crc32c.mjs';
import { makeFloor } from '../src/trust.mjs';
import { stringify } from '../src/canonical-json.mjs';
import {
  archiveDigest, assertFloorBarrier, idempotentRenameDir, restoreArchive, treeToEntries,
  verifyArchive, writeCanonicalTar,
} from '../src/install.mjs';

function mk(dir, files) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  for (const [rel, c] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o755 });
    writeFileSync(abs, c);
    chmodSync(abs, 0o644);
  }
}
const fresh = () => mkdtempSync(join(tmpdir(), 'ki-'));
const drop = (b) => rmSync(b, { recursive: true, force: true });

// ── crc32c 的两份实现必须逐字节一致 ────────────────────────────────────────

test('🔴 src/crc32c.mjs 与 test/harness/crc32c.mjs 必须逐字节等价（搬家不许改行为）', () => {
  const cases = ['', 'a', '123456789', 'geoly', 'äöü', 'x'.repeat(1000)];
  for (const c of cases) {
    const b = Buffer.from(c, 'utf8');
    assert.equal(srcCrc(b), harnessCrc(b), `crc32c 对 ${JSON.stringify(c.slice(0, 12))} 不一致`);
    assert.match(srcCrc(b), /^[0-9a-f]{8}$/);
  }
  // 已知向量：crc32c("123456789") == 0xe3069283
  assert.equal(srcCrc(Buffer.from('123456789')), 'e3069283');
});

// ── canonical ustar ─────────────────────────────────────────────────────────

test('🔴 attic 的 tar 必须能被我们自己的受限解析器接受（E-5：尾部恰好两个零块）', () => {
  const base = fresh();
  try {
    const d = join(base, 'tree');
    mk(d, { 'SKILL.md': '# a\n', 'ref/x.md': 'x\n' });
    const bytes = writeCanonicalTar(treeToEntries(d));
    assert.equal(bytes.length % 512, 0);
    const { entries } = parseTar(bytes);
    assert.deepEqual(entries.map((e) => e.path), ['SKILL.md', 'ref/x.md']);
    // 多补一个零块 → 非 canonical，必须被拒
    assert.throws(() => parseTar(Buffer.concat([bytes, Buffer.alloc(512)])), /TRAILING_BLOCKS|E_TRAILING/);
  } finally { drop(base); }
});

test('🔴 归档摘要从字节重算：只改内容、不改任何自称字段，也必须被抓住', () => {
  const base = fresh();
  try {
    const d = join(base, 'tree');
    mk(d, { 'SKILL.md': '# a\n' });
    const want = treeDigest(d);
    const tar = join(base, 'a.tar');
    writeFileSync(tar, writeCanonicalTar(treeToEntries(d)));
    assert.equal(archiveDigest(tar, base), want);
    assert.equal(verifyArchive(tar, want, base), want);
    writeFileSync(tar, writeCanonicalTar([{ data: Buffer.from('# 掉包\n'), mode: 0o644, path: 'SKILL.md' }]));
    assert.throws(() => verifyArchive(tar, want, base), /摘要.*不符/);
    // 还原也要重验
    assert.throws(() => restoreArchive(tar, join(base, 'out'), want), /摘要.*不符/);
  } finally { drop(base); }
});

test('🔴 0755 的可执行位进树摘要，tar 往返之后必须仍是 0755', () => {
  const base = fresh();
  try {
    const d = join(base, 'tree');
    mk(d, { 'run.sh': '#!/bin/sh\n' });
    chmodSync(join(d, 'run.sh'), 0o755);
    const want = treeDigest(d);
    const tar = join(base, 'a.tar');
    writeFileSync(tar, writeCanonicalTar(treeToEntries(d)));
    assert.equal(archiveDigest(tar, base), want);
  } finally { drop(base); }
});

// ── 幂等五分支 ──────────────────────────────────────────────────────────────

test('🔴 幂等 rename 的五个分支，一个都不能少', () => {
  const base = fresh();
  try {
    const X = join(base, 'X'), Y = join(base, 'Y');
    mk(X, { 'a.md': '1\n' });
    const d = treeDigest(X);

    // ③ Y 缺席、X 摘要符 → 执行
    assert.equal(idempotentRenameDir(X, Y, d), 'done');
    // ① Y 存在且符、X 缺席 → 跳过
    assert.equal(idempotentRenameDir(X, Y, d), 'skipped');
    // ② Y 正确但 X 也在 → corrupt（外部重建过源）
    mk(X, { 'a.md': '1\n' });
    assert.throws(() => idempotentRenameDir(X, Y, d), /分支②/);
    // ④ Y 缺席、X 摘要不符 → corrupt
    rmSync(Y, { recursive: true, force: true });
    writeFileSync(join(X, 'a.md'), '2\n');
    assert.throws(() => idempotentRenameDir(X, Y, d), /分支④/);
    // ⑤ 两端都不存在 → corrupt
    rmSync(X, { recursive: true, force: true });
    assert.throws(() => idempotentRenameDir(X, Y, d), /分支⑤/);
    // Y 存在但摘要不符（既不是①也不是②）
    mk(Y, { 'a.md': '9\n' });
    assert.throws(() => idempotentRenameDir(X, Y, d), /存在但摘要/);
  } finally { drop(base); }
});

// ── 提交点前的 trust floor 复验 ─────────────────────────────────────────────

test('🔴 floor 必须显式给：忘了传 = 拒绝，不等于「不检查」', () => {
  assert.throws(() => assertFloorBarrier({}), /必须显式给出/);
  assert.deepEqual(assertFloorBarrier({ floor: null }), { checked: false, reason: 'no-registry-provenance' });
});

test('🔴 floor 在解析与安装之间被推进 → 提交点之前 fail-closed（E_FLOOR_MOVED）', () => {
  const base = fresh();
  try {
    const stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true, mode: 0o755 });
    const floorAt = (v, snap) => makeFloor({
      latest_snapshot: snap,
      now: new Date('2026-08-26T00:00:00Z'),
      snapshot_sha256: 'sha256:' + String(snap).padStart(2, '0').repeat(32),
      timestamp_sha256: 'sha256:' + String(v).padStart(2, '0').repeat(32),
      timestamp_version: v,
    });
    const f1 = floorAt(5, 42);
    const f2 = floorAt(6, 43);
    writeFileSync(join(stateDir, 'trust.json'), stringify(f1));

    // 解析时看到的是 f1，安装时磁盘还是 f1 → 放行
    assert.deepEqual(assertFloorBarrier({ floor: { expected: f1, stateDir } }), { checked: true });

    // 🔴 并发进程在空档里把 floor 推到 f2 —— 本进程仍拿着 f1 → 提交点之前必须拒绝
    writeFileSync(join(stateDir, 'trust.json'), stringify(f2));
    assert.throws(
      () => assertFloorBarrier({ floor: { expected: f1, stateDir } }),
      (e) => e.violation === 'E_FLOOR_MOVED',
      '🔴 floor 在解析与安装之间被推进，提交点之前却放行了',
    );

    // floor 文件消失也要报（不是「没有就当没变」）
    rmSync(join(stateDir, 'trust.json'));
    assert.throws(
      () => assertFloorBarrier({ floor: { expected: f1, stateDir } }),
      (e) => e.violation === 'E_FLOOR_VANISHED',
    );
  } finally { drop(base); }
});


// ── 写入端与读取端必须逐字节自洽 ────────────────────────────────────────────

test('🔴 往返属性：我们写的 tar，我们自己的受限解析器必须无条件接受', async () => {
  // 这一条防的是「两边各自都说得通、一合就全红」。
  // 实测发生过：写入端把 devmajor 留成 Buffer.alloc 的全 NUL，
  // 读取端（对抗加固后）要求 7 位八进制 —— 两个模块分别开发时都自洽，
  // 合并后 15 个测试一起红。单看任何一侧都发现不了。
  const { writeCanonicalTar } = await import('../src/install.mjs');
  const { parseTar } = await import('../src/untar.mjs');

  const cases = [
    [{ path: 'SKILL.md', mode: 0o644, data: Buffer.from('# hi\n') }],
    [{ path: 'SKILL.md', mode: 0o644, data: Buffer.from('a') },
      { path: 'bin/run.sh', mode: 0o755, data: Buffer.from('#!/bin/sh\n') }],
    // 深路径、需要 prefix 切分的
    [{ path: 'a/b/c/d/e/f/g/deep-file-name.md', mode: 0o644, data: Buffer.alloc(0) }],
    // 数据长度恰好落在块边界上
    [{ path: 'exact.bin', mode: 0o644, data: Buffer.alloc(512, 7) }],
    [{ path: 'exact2.bin', mode: 0o644, data: Buffer.alloc(1024, 9) }],
  ];

  for (const entries of cases) {
    const tar = writeCanonicalTar(entries);
    const { entries: parsed } = parseTar(tar);   // 不接受就会抛 TarViolation
    assert.equal(parsed.length, entries.length, JSON.stringify(entries.map((e) => e.path)));
    for (let i = 0; i < entries.length; i++) {
      const want = [...entries].sort((a, b) =>
        Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))[i];
      assert.equal(parsed[i].path, want.path);
      assert.equal(parsed[i].mode, want.mode, `${want.path} 的 mode 必须往返不变`);
      assert.deepEqual(Buffer.from(parsed[i].data), want.data, `${want.path} 的内容必须往返不变`);
    }
  }
});

test('🔴 写出来的 tar 尾部恰好两个零块（E-5）', async () => {
  const { writeCanonicalTar } = await import('../src/install.mjs');
  const tar = writeCanonicalTar([{ path: 'x.md', mode: 0o644, data: Buffer.from('y') }]);
  let z = 0;
  for (let i = tar.length - 512; i >= 0; i -= 512) {
    if (!tar.subarray(i, i + 512).every((b) => b === 0)) break;
    z++;
  }
  assert.equal(z, 2, `尾部零块应恰好 2 个，实际 ${z}`);
  assert.equal(tar.length % 512, 0);
});

test('🔴 writer 接受的每个输入，parser 都必须接受（接受集合不许更大）', async () => {
  // 上一条往返测试只喂合法输入，所以照样绿 —— 而写入端曾经接受 `../x`，
  // 读取端报 E_PATH_DOTDOT。我们能写出自己读不回来的归档。
  // Codex 2026-08-27 跨块验收指出，与 devmajor 是同一类错误。
  const { writeCanonicalTar } = await import('../src/install.mjs');
  const { parseTar } = await import('../src/untar.mjs');

  const shouldReject = ['../x', './x', 'a/../b', '/abs', 'a//b', 'a\\b', '中文.md', '.', '..'];
  for (const path of shouldReject) {
    let wrote = null;
    try { wrote = writeCanonicalTar([{ path, mode: 0o644, data: Buffer.from('x') }]); } catch { /* 期望 */ }
    if (wrote !== null) {
      // 写入端放行了 —— 那读取端也必须放行，否则就是我们自己写了读不回来的东西
      assert.doesNotThrow(() => parseTar(wrote),
        `writer 接受了 ${JSON.stringify(path)} 但 parser 拒绝 —— 接受集合不对称`);
    }
  }
});

test('🔴 parseTar → writeCanonicalTar 逐字节还原（编码唯一性）', async () => {
  // E-3 的直接后果：一份内容只能有一种字节编码。若不成立，asset.sha256 就不是身份。
  const { writeCanonicalTar } = await import('../src/install.mjs');
  const { parseTar } = await import('../src/untar.mjs');
  for (const entries of [
    [{ path: 'SKILL.md', mode: 0o644, data: Buffer.from('# hi\n') }],
    [{ path: 'bin/run.sh', mode: 0o755, data: Buffer.from('#!/bin/sh\n') },
      { path: 'SKILL.md', mode: 0o644, data: Buffer.from('x') }],
    [{ path: 'edge511.bin', mode: 0o644, data: Buffer.alloc(511, 3) }],
    [{ path: 'edge512.bin', mode: 0o644, data: Buffer.alloc(512, 4) }],
    [{ path: 'edge513.bin', mode: 0o644, data: Buffer.alloc(513, 5) }],
    [{ path: 'zero.bin', mode: 0o644, data: Buffer.alloc(0) }],
    [{ path: 'binary.bin', mode: 0o644, data: Buffer.from([0, 1, 0, 2]) }],
  ]) {
    const bytes = writeCanonicalTar(entries);
    const round = writeCanonicalTar(parseTar(bytes).entries.map((e) => ({
      path: e.path, mode: e.mode, data: Buffer.from(e.data),
    })));
    assert.equal(Buffer.compare(bytes, round), 0,
      `逐字节还原失败：${entries.map((e) => e.path).join(',')}`);
  }
});

test('输入顺序不影响输出（按 path 字节序确定性排序）', async () => {
  const { writeCanonicalTar } = await import('../src/install.mjs');
  const es = [
    { path: 'z.md', mode: 0o644, data: Buffer.from('z') },
    { path: 'a.md', mode: 0o644, data: Buffer.from('a') },
    { path: 'm/n.md', mode: 0o644, data: Buffer.from('m') },
  ];
  const a = writeCanonicalTar(es);
  const b = writeCanonicalTar([...es].reverse());
  assert.equal(Buffer.compare(a, b), 0, '打乱输入顺序不得改变输出字节');
});
