import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeDigest, txDigest } from '../src/tree-digest.mjs';

const T = () => mkdtempSync(join(tmpdir(), 'td-'));
const f = (d, p, c = 'x') => { mkdirSync(join(d, p, '..'), { recursive: true, mode: 0o755 }); writeFileSync(join(d, p), c, { mode: 0o644 }); };

test('相同内容 → 相同摘要；改一个字节 → 变', () => {
  const a = T(), b = T();
  f(a, 'x.md', 'hello'); f(b, 'x.md', 'hello');
  assert.equal(treeDigest(a), treeDigest(b));
  f(b, 'x.md', 'hellp');
  assert.notEqual(treeDigest(a), treeDigest(b));
});

test('mode 进摘要：0644 与 0755 不同', () => {
  const a = T(), b = T();
  f(a, 'x.sh'); f(b, 'x.sh');
  chmodSync(join(b, 'x.sh'), 0o755);
  assert.notEqual(treeDigest(a), treeDigest(b));
});

test('拒绝 symlink', () => {
  const d = T(); f(d, 'real.md');
  symlinkSync(join(d, 'real.md'), join(d, 'link.md'));
  assert.throws(() => treeDigest(d), /symlink/);
});

test('拒绝 hardlink（nlink != 1）', () => {
  const d = T(); f(d, 'a.md');
  linkSync(join(d, 'a.md'), join(d, 'b.md'));
  assert.throws(() => treeDigest(d), /hardlink/);
});

test('🔴 geoly-tree-v1 看不见空目录，geoly-tx-v1 看得见', () => {
  const a = T(), b = T();
  f(a, 'x.md'); f(b, 'x.md');
  mkdirSync(join(b, 'empty'), { mode: 0o755 });
  // 这正是不能拿 tree-v1 给 tx 成像的原因
  assert.equal(treeDigest(a), treeDigest(b), 'tree-v1 应看不见空目录');
  assert.notEqual(txDigest(a), txDigest(b), 'tx-v1 必须看得见空目录');
});

test('🔴 tx-v1 覆盖根目录本身：只有根 mode 变化时也应可判', () => {
  const d = T(); f(d, 'x.md');
  const before = txDigest(d);
  assert.ok(before.startsWith('geoly-tx-v1:sha256:'));
  assert.notEqual(before, treeDigest(d));
});

test('目录 mode 非 0755 → tx-v1 无法成像', () => {
  const d = T(); f(d, 'sub/x.md');
  chmodSync(join(d, 'sub'), 0o700);
  assert.throws(() => txDigest(d), /目录 mode/);
});

test('摘要带算法前缀', () => {
  const d = T(); f(d, 'x.md');
  assert.match(treeDigest(d), /^geoly-tree-v1:sha256:[0-9a-f]{64}$/);
  assert.match(txDigest(d), /^geoly-tx-v1:sha256:[0-9a-f]{64}$/);
});
