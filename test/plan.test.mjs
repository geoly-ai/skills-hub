// plan：op 推导、§4.2 的受管化出口、manifest / postimage、`--only` 闭包。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { treeDigest } from '../src/tree-digest.mjs';
import { ledgerSkeleton } from '../src/ledger.mjs';
import {
  REVERSE_OP, buildLedgerImage, comparePostimage, derivePlan, ledgerDeltaFromImage,
  selectClosure, strictPayloadCheck, strictlyMatches, validateManifest,
} from '../src/plan.mjs';

const AT = '2026-08-26T00:00:00Z';
const META = (p) => ({ client: 'claude', fstype: 'apfs', path: p, realpath: p, scope: 'global' });
const D = (c) => `geoly-tree-v1:sha256:${String(c).repeat(64).slice(0, 64)}`;

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
function fresh() {
  const base = mkdtempSync(join(tmpdir(), 'kp-'));
  const target = join(base, 'skills');
  mkdirSync(target, { recursive: true, mode: 0o755 });
  return { base, target };
}
const drop = (b) => rmSync(b, { recursive: true, force: true });

const req = (name, dir, digest) => ({
  artifact: `skill:g/${name}@2`, installed_at: AT, name,
  requested_by: [`direct:skill:g/${name}@2`], snapshot: 42, srcDir: dir, tree_digest: digest,
});

test('op 推导：不存在 → install-new；已认领且不同 → swap；retire → retire-only', () => {
  const { base, target } = fresh();
  try {
    mk(join(target, 'a'), { 'SKILL.md': 'old a\n' });
    mk(join(target, 'g'), { 'SKILL.md': 'g\n' });
    const src = join(base, 'src');
    mk(join(src, 'a'), { 'SKILL.md': 'new a\n' });
    mk(join(src, 'b'), { 'SKILL.md': 'b\n' });
    const ledger = {
      ...ledgerSkeleton(META(target)),
      entries: {
        a: { artifact: 'skill:g/a@1', generation: 1, installed_at: AT, requested_by: [], snapshot: 1, state: 'ok', tree_digest: treeDigest(join(target, 'a')) },
        g: { artifact: 'skill:g/g@1', generation: 1, installed_at: AT, requested_by: [], snapshot: 1, state: 'ok', tree_digest: treeDigest(join(target, 'g')) },
      },
    };
    const plan = derivePlan({
      generation: 2, ledger, ledgerExisted: true, retire: ['g'], target,
      install: [req('a', join(src, 'a'), treeDigest(join(src, 'a'))), req('b', join(src, 'b'), treeDigest(join(src, 'b')))],
    });
    assert.equal(plan.items.a.op, 'swap');
    assert.equal(plan.items.b.op, 'install-new');
    assert.equal(plan.items.g.op, 'retire-only');
    assert.ok(!('old_digest' in plan.items.b));
    assert.ok(!('new_digest' in plan.items.g));
  } finally { drop(base); }
});

test('🔴 §4.2：未被账本认领的同名目录默认阻断，出路只有 --replace（不提供泛化 --force）', () => {
  const { base, target } = fresh();
  try {
    mk(join(target, 'a'), { 'SKILL.md': 'squatter\n' });
    const src = join(base, 'src');
    mk(join(src, 'a'), { 'SKILL.md': 'real\n' });
    const ledger = ledgerSkeleton(META(target));
    assert.throws(() => derivePlan({
      generation: 1, ledger, ledgerExisted: true, target, install: [req('a', join(src, 'a'), treeDigest(join(src, 'a')))],
    }), /默认阻断/);
    const plan = derivePlan({
      generation: 1, ledger, ledgerExisted: true, target, replace: new Set(['a']),
      install: [req('a', join(src, 'a'), treeDigest(join(src, 'a')))],
    });
    assert.equal(plan.items.a.op, 'swap');
  } finally { drop(base); }
});

test('🔴 §4.2 的「逐字节相同」分支：不构造物理 swap，改为 adopt 断言', () => {
  const { base, target } = fresh();
  try {
    mk(join(target, 'a'), { 'SKILL.md': 'same\n' });
    const src = join(base, 'src');
    mk(join(src, 'a'), { 'SKILL.md': 'same\n' });
    const d = treeDigest(join(src, 'a'));
    assert.equal(treeDigest(join(target, 'a')), d);
    const plan = derivePlan({
      generation: 1, ledger: ledgerSkeleton(META(target)), ledgerExisted: true, target, replace: new Set(['a']),
      install: [req('a', join(src, 'a'), d)],
    });
    // 🔴 不能落成物理 swap —— 那会撞上「禁止 old_digest == new_digest」而被拒
    assert.deepEqual(plan.items, {});
    assert.deepEqual(plan.adopt_assertions.a, { artifact: 'skill:g/a@2', state: 'ok', tree_digest: d });
    assert.ok(!('unadopt_assertions' in plan), '空的逻辑项字段必须整个缺席');
  } finally { drop(base); }
});

test('🔴 「严格验明」不只是摘要相等：空目录 / 坏 mode / symlink 都要被抓出来', () => {
  const { base } = fresh();
  try {
    const d = join(base, 'tree');
    mk(d, { 'SKILL.md': 'x\n' });
    assert.deepEqual(strictPayloadCheck(d), []);
    mkdirSync(join(d, 'empty'), { mode: 0o755 });
    assert.match(strictPayloadCheck(d).join(';'), /空目录 empty/);
    rmSync(join(d, 'empty'), { recursive: true });
    chmodSync(join(d, 'SKILL.md'), 0o600);
    assert.match(strictPayloadCheck(d).join(';'), /mode 只允许/);
    chmodSync(join(d, 'SKILL.md'), 0o644);
    const m = strictlyMatches(d, D('0'));
    assert.equal(m.ok, false);
  } finally { drop(base); }
});

test('🔴 同一事务内 name 必须唯一（结构门）', () => {
  const { base, target } = fresh();
  try {
    const src = join(base, 'src');
    mk(join(src, 'a'), { 'SKILL.md': 'a\n' });
    assert.throws(() => derivePlan({
      generation: 1, ledger: ledgerSkeleton(META(target)), ledgerExisted: true, target,
      install: [req('a', join(src, 'a'), treeDigest(join(src, 'a'))), req('a', join(src, 'a'), treeDigest(join(src, 'a')))],
    }), /name 重复/);
  } finally { drop(base); }
});

test('🔴 ledger_image 的覆盖面含 root 与 requested_by 边，不只是 entry', () => {
  const ledger = ledgerSkeleton(META('/x'));
  const img = buildLedgerImage({
    adopt: {}, auditAppend: [], frozenAttic: undefined, generation: 3, ledgerExisted: true,
    install: [{ artifact: 'skill:g/a@2', installed_at: AT, name: 'a', requested_by: ['pack:g/p@1'], snapshot: 42, tree_digest: D('a') }],
    items: { a: { op: 'install-new' } }, ledger, removeRoots: [], retire: [],
    roots: { 'pack:g/p@1': { artifact: 'pack:g/p@1', intent: { no_bundled: false, pre: false }, kind: 'pack', requested_at: AT, snapshot: 42, tree_digest: D('p') } },
    unadopt: {},
  });
  assert.equal(img.pre.entries.a, null, '「原本不存在」用 null 哨兵');
  assert.equal(img.pre.roots['pack:g/p@1'], null);
  assert.deepEqual(img.post.entries.a.requested_by, ['pack:g/p@1']);
  assert.equal(img.post.last_applied_generation, 3);
});

test('🔴 reverse_op 是互逆映射（manifest 的 op 与 reverse_op 枚举相同）', () => {
  assert.deepEqual(REVERSE_OP, {
    adopt: 'unadopt', 'install-new': 'retire-only', 'retire-only': 'install-new',
    swap: 'swap', unadopt: 'adopt',
  });
  for (const [a, b] of Object.entries(REVERSE_OP)) assert.equal(REVERSE_OP[b], a, `${a} 与 ${b} 不互逆`);
});

// ── postimage 三方比对与 --only 闭包 ────────────────────────────────────────

function manifestFixture() {
  return validateManifest({
    schema: 'geoly.skills.attic-manifest/1',
    created_at: AT,
    generation: 1,
    items: { a: { old_digest: D('1'), op: 'swap', reverse_op: 'swap', tar: 'a.tar' } },
    ledger_delta: { entries: { a: null }, roots: { 'direct:skill:g/a@2': null } },
    postimage: {
      digests: { a: { digest: D('2'), present: true } },
      entries: { a: { artifact: 'skill:g/a@2', generation: 1, installed_at: AT, requested_by: ['direct:skill:g/a@2'], snapshot: 42, state: 'ok', tree_digest: D('2') } },
      in_edges: { a: ['direct:skill:g/a@2'] },
      out_edges: { 'direct:skill:g/a@2': ['a'] },
      roots: { 'direct:skill:g/a@2': { artifact: 'skill:g/a@2', intent: { no_bundled: false, pre: false }, kind: 'direct', requested_at: AT, snapshot: 42, tree_digest: D('2') } },
    },
  });
}

test('🔴 postimage 三方比对：后来新增的共享 root 会以「入边多了一条」被抓住', () => {
  const { base, target } = fresh();
  try {
    const M = manifestFixture();
    mk(join(target, 'a'), { 'SKILL.md': 'x\n' });
    const cur = {
      ...ledgerSkeleton(META(target)),
      entries: { a: { ...M.postimage.entries.a, requested_by: ['direct:skill:g/a@2', 'pack:g/later@1'] } },
      roots: { ...M.postimage.roots },
    };
    const { conflicts } = comparePostimage(M, cur, target);
    assert.ok(conflicts.some((c) => c.includes('in_edges[a]')),
      `🔴 后续代新增的共享 root 没被抓住：${JSON.stringify(conflicts)}`);
  } finally { drop(base); }
});

test('🔴 postimage 还比对目标树的实测摘要，不只是账本', () => {
  const { base, target } = fresh();
  try {
    const M = manifestFixture();
    mk(join(target, 'a'), { 'SKILL.md': 'x\n' });   // 摘要必然 != D(2)
    const cur = { ...ledgerSkeleton(META(target)), entries: { a: M.postimage.entries.a }, roots: { ...M.postimage.roots } };
    const { conflicts } = comparePostimage(M, cur, target);
    assert.ok(conflicts.some((c) => c.includes('目标树 a 摘要与当时不同')), JSON.stringify(conflicts));
  } finally { drop(base); }
});

test('🔴 --only 的闭包不完整时**拒绝并列出**要一起选的全部 name，不自动扩张', () => {
  const M = validateManifest({
    schema: 'geoly.skills.attic-manifest/1',
    created_at: AT, generation: 1,
    items: {
      a: { old_digest: D('1'), op: 'swap', reverse_op: 'swap', tar: 'a.tar' },
      b: { old_digest: D('3'), op: 'swap', reverse_op: 'swap', tar: 'b.tar' },
    },
    ledger_delta: { entries: { a: null, b: null }, roots: { 'pack:g/p@1': null } },
    postimage: {
      digests: { a: { digest: D('2'), present: true }, b: { digest: D('4'), present: true } },
      entries: { a: null, b: null },
      in_edges: { a: ['pack:g/p@1'], b: ['pack:g/p@1'] },
      out_edges: { 'pack:g/p@1': ['a', 'b'] },
      roots: { 'pack:g/p@1': null },
    },
  });
  assert.throws(() => selectClosure(M, { only: ['a'] }), /还要一起选 b/);
  const sel = selectClosure(M, { only: ['a', 'b'] });
  assert.deepEqual(sel.entries, ['a', 'b']);
  // 🔴 --only 必须**同时过滤 delta**
  assert.deepEqual(Object.keys(sel.delta.entries).sort(), ['a', 'b']);
});

test('🔴 本代 ledger_delta.frozen_attic 有变化时禁止部分复位（target 级、切不开）', () => {
  const M = manifestFixture();
  M.ledger_delta.frozen_attic = { mig: [1] };
  assert.throws(() => selectClosure(M, { only: ['a'] }), /禁止部分复位/);
});

test('🔴 manifest 的 op / reverse_op 必须互逆，tar / old_digest 按 op 定 null', () => {
  const M = manifestFixture();
  assert.throws(() => validateManifest({ ...M, items: { a: { ...M.items.a, reverse_op: 'install-new' } } }), /不互逆/);
  assert.throws(() => validateManifest({
    ...M, items: { a: { old_digest: D('1'), op: 'install-new', reverse_op: 'retire-only', tar: 'a.tar' } },
  }), /必须是 null/);
  assert.throws(() => validateManifest({
    ...M, postimage: { ...M.postimage, digests: { a: { present: false, digest: D('2') } } },
  }), /未知字段/);
});

test('ledger_delta 就是 ledger_image.pre（「复位后应有的值」），且不含任何 audit 字段', () => {
  const img = {
    ledger_existed: true,
    post: { audit_append: [], entries: { a: null }, last_applied_generation: 2, roots: {} },
    pre: { entries: { a: null }, last_applied_generation: 1, roots: {} },
  };
  const d = ledgerDeltaFromImage(img);
  assert.deepEqual(Object.keys(d).sort(), ['entries', 'roots']);
  assert.equal(d.entries.a, null);
});
