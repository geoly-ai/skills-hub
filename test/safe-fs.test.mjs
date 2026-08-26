import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSafeSegment, parseSafeRelPath, assertNoSymlinkInChain, assertPlainFileOrDir,
  mountTable, mountEntryFor, assertSupportedFilesystem, assertNotMountPoint,
  assertNoMountPointsUnder, assertWritableDir, assertSameDevice, REJECTED_FSTYPES,
} from '../src/safe-fs.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'sfs-'));

// ── 字符集 ───────────────────────────────────────────────────────────────────

test('ASCII-only segment（D9）', () => {
  for (const ok of ['SKILL.md', 'skill.json', 'a-b_c.1', 'X']) assert.ok(isSafeSegment(ok), ok);
  for (const bad of ['', '中文.md', 'a b', 'a/b', 'a\\b', 'café', 'а']) {
    assert.ok(!isSafeSegment(bad), `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('🔴 `..` 要按 segment 判，不能只做字符串包含', () => {
  // a..b 是**合法**文件名，不能因为含 ".." 就拒
  assert.deepEqual(parseSafeRelPath('docs/a..b.md'), ['docs', 'a..b.md']);
  assert.throws(() => parseSafeRelPath('docs/../etc/passwd'), /含 \.\./);
  assert.throws(() => parseSafeRelPath('../x'), /含 \.\./);
  assert.throws(() => parseSafeRelPath('./x'), /含 \./);
});

test('相对路径的其它拒绝项', () => {
  assert.throws(() => parseSafeRelPath('/abs/path'), /相对路径/);
  assert.throws(() => parseSafeRelPath('a\\b'), /反斜杠/);
  assert.throws(() => parseSafeRelPath('a//b'), /空 segment/);
  assert.throws(() => parseSafeRelPath('a/中文/b'), /ASCII-only/);
  assert.throws(() => parseSafeRelPath(''), /为空/);
  assert.throws(() => parseSafeRelPath('a/'.repeat(13) + 'x'), /深度/);
  assert.throws(() => parseSafeRelPath('a\0b'), /NUL/);
});

// ── symlink ──────────────────────────────────────────────────────────────────

test('🔴 base 之下路径链中间的 symlink 也要拒 —— 只看末端会漏', () => {
  const d = tmp();
  mkdirSync(join(d, 'real', 'inner'), { recursive: true });
  writeFileSync(join(d, 'real', 'inner', 'f'), 'x');
  symlinkSync(join(d, 'real'), join(d, 'link'));

  // 末端 f 自己不是 symlink，但路径经过了 link
  assert.doesNotThrow(() => assertNoSymlinkInChain(d, 'real/inner/f'));
  assert.throws(() => assertNoSymlinkInChain(d, 'link/inner/f'), /符号链接/);
});

test('🔴 base 之上的 OS 级 symlink 不算问题（macOS 的 /var → /private/var）', () => {
  // tmpdir() 在 macOS 上就落在 /var 下面。从 / 开始查会把它判死，那是假阳性。
  const d = tmp();
  mkdirSync(join(d, 'skills'));
  assert.doesNotThrow(() => assertNoSymlinkInChain(d, 'skills'));
  assert.doesNotThrow(() => assertNoSymlinkInChain(join(d, 'skills')));
});

test('还不存在的层不算风险', () => {
  const d = tmp();
  assert.doesNotThrow(() => assertNoSymlinkInChain(d, 'not/yet/here'));
});

test('assertNoSymlinkInChain 的 base 要求绝对路径', () => {
  assert.throws(() => assertNoSymlinkInChain('relative/path'), /绝对路径/);
});

// ── 文件类型白名单 ───────────────────────────────────────────────────────────

test('只允许普通文件与目录', () => {
  const d = tmp();
  writeFileSync(join(d, 'f'), 'x');
  mkdirSync(join(d, 'sub'));
  symlinkSync(join(d, 'f'), join(d, 'l'));
  assert.doesNotThrow(() => assertPlainFileOrDir(join(d, 'f')));
  assert.doesNotThrow(() => assertPlainFileOrDir(join(d, 'sub')));
  assert.throws(() => assertPlainFileOrDir(join(d, 'l')), /符号链接/);
});

test('🔴 hardlink 只对普通文件判 —— 对目录判会把每棵正常的树都判死', () => {
  const d = tmp();
  writeFileSync(join(d, 'f'), 'x');
  linkSync(join(d, 'f'), join(d, 'f2'));
  assert.throws(() => assertPlainFileOrDir(join(d, 'f')), /硬链接/);
  // 目录的 nlink 天然是 2 + 子目录数，不能因此拒绝
  mkdirSync(join(d, 'p'));
  mkdirSync(join(d, 'p', 'c1'));
  mkdirSync(join(d, 'p', 'c2'));
  assert.doesNotThrow(() => assertPlainFileOrDir(join(d, 'p')));
});

// ── 文件系统类型 ─────────────────────────────────────────────────────────────

test('挂载表读得出来，且包含根挂载点', () => {
  const rows = mountTable({ refresh: true });
  assert.ok(rows.length > 0, '应能读到挂载表');
  assert.ok(rows.some((r) => r.mountPoint === '/'), '应包含 /');
  for (const r of rows) {
    assert.equal(typeof r.mountPoint, 'string');
    assert.ok(r.fstype.length > 0, `fstype 不应为空：${JSON.stringify(r)}`);
  }
});

test('最长前缀匹配：临时目录归到某个真实挂载点', () => {
  const e = mountEntryFor(tmp());
  assert.ok(e, '应匹配到挂载点');
  assert.ok(e.mountPoint.length > 0);
});

test('本地临时目录不该被拒', () => {
  assert.doesNotThrow(() => assertSupportedFilesystem(tmp()));
});

test('拒绝清单覆盖网络与 FUSE 文件系统', () => {
  for (const t of ['nfs', 'nfs4', 'cifs', 'smbfs', 'sshfs', 'overlay']) {
    assert.ok(REJECTED_FSTYPES.has(t), `应在拒绝清单里：${t}`);
  }
});

test('还不存在的路径也能预检（往上找已存在的祖先）', () => {
  const d = tmp();
  assert.doesNotThrow(() => assertSupportedFilesystem(join(d, 'not', 'created', 'yet')));
});

// ── 挂载点 ───────────────────────────────────────────────────────────────────

test('普通目录不是挂载点，其下也没有挂载点', () => {
  const d = tmp();
  mkdirSync(join(d, '.geoly'));
  assert.doesNotThrow(() => assertNotMountPoint(join(d, '.geoly')));
  assert.doesNotThrow(() => assertNoMountPointsUnder(join(d, '.geoly')));
});

test('🔴 根目录被正确识别为挂载点', () => {
  assert.throws(() => assertNotMountPoint('/'), /挂载点/);
});

test('/ 之下当然有挂载点', () => {
  assert.throws(() => assertNoMountPointsUnder('/'), /之下存在挂载点/);
});

// ── 可写性与设备 ─────────────────────────────────────────────────────────────

test('可写目录通过，不可写目录报明原因', () => {
  const d = tmp();
  assert.doesNotThrow(() => assertWritableDir(d));
  assert.throws(() => assertWritableDir(join(d, 'nope')), /不可写|安装需要/);
});

test('同设备判定', () => {
  const d = tmp();
  mkdirSync(join(d, 'a'));
  mkdirSync(join(d, 'b'));
  assert.doesNotThrow(() => assertSameDevice(join(d, 'a'), join(d, 'b')));
});
