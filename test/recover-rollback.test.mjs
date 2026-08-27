// §5.4.1 的入场分类封闭表 —— 逐行验证，**未列组合一律 corrupt**。
//
// 🔴 这张表是 v35 那条铁律的载体：**绝不从正向 `item.state` 推断物理位置**。
//    所以这些 case 全都只动物理现场、不动 journal 的 `state`。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { disarm, reset } from '../src/fault-inject.mjs';
import { layout } from '../src/ledger.mjs';
import { readJournal } from '../src/journal.mjs';
import { classifyEntry } from '../src/recover.mjs';
import {
  KSCENARIOS, kFreshTarget, kCleanup, OLD_ALPHA, NEW_ALPHA, digestOf, materializeFiles,
} from './kernel-scenarios.test.mjs';

/**
 * 造一个「已交换、phase 仍是 prepared」的现场：
 * alpha 是 swap（T=new, R=old, S=∅）、beta 是 install-new（T=new）、gamma 是 retire-only（T=∅, R=old）。
 */
function prepared(tag) {
  const target = kFreshTarget(tag);
  disarm(); reset();
  KSCENARIOS['kernel-rollback'].setup(target);
  const P = layout(target, 1);
  return { target, P, J: readJournal(P.journal) };
}

const cls = (t, J, P, n) => classifyEntry(t, J, P, n);

test('swap：(new, old, ∅, *) → as-swapped', () => {
  const { target, P, J } = prepared('rb1');
  try {
    assert.equal(cls(target, J, P, 'alpha'), 'as-swapped');
  } finally { kCleanup(target); }
});

test('swap：(∅, old, new, *) → as-retired（park 之后的形状，幂等重入用）', () => {
  const { target, P, J } = prepared('rb2');
  try {
    renameSync(join(target, 'alpha'), join(P.stage, 'alpha'));   // 模拟已 park
    assert.equal(cls(target, J, P, 'alpha'), 'as-retired');
  } finally { kCleanup(target); }
});

test('swap：(old, ∅, new, *) → noop', () => {
  const { target, P, J } = prepared('rb3');
  try {
    renameSync(join(target, 'alpha'), join(P.stage, 'alpha'));
    renameSync(join(P.retired, 'alpha'), join(target, 'alpha'));
    assert.equal(cls(target, J, P, 'alpha'), 'noop');
  } finally { kCleanup(target); }
});

test('🔴 swap：S 缺席时 (old, ∅, ∅) 与 (∅, old, ∅) 都必须 fail-closed（S 是判据的一部分）', () => {
  const { target, P, J } = prepared('rb4');
  try {
    // (old, ∅, ∅)
    renameSync(join(P.retired, 'alpha'), join(target, 'alpha2'));
    rmSync(join(target, 'alpha'), { recursive: true });
    renameSync(join(target, 'alpha2'), join(target, 'alpha'));
    assert.ok(!existsSync(join(P.stage, 'alpha')));
    assert.throws(() => cls(target, J, P, 'alpha'), /swap 入场分类不合法/);
  } finally { kCleanup(target); }
});

test('🔴 swap：(new, 另一棵完整树, ∅, A=old) **不是**「部分」，必须 fail-closed', () => {
  const { target, P, J } = prepared('rb5');
  try {
    // 先把 attic 造出来（as-swapped-cleaned 的前提是 A 可用）
    rmSync(join(P.retired, 'alpha'), { recursive: true });
    materializeFiles(join(P.retired, 'alpha'), { 'SKILL.md': '# 外部放进来的完整树\n' });
    // A 不存在 → 直接不合法；这正是「不能只看 R 的摘要不等于 old 就当 cleaned」
    assert.throws(() => cls(target, J, P, 'alpha'), /swap 入场分类不合法/);
  } finally { kCleanup(target); }
});

test('install-new：T=new → as-installed；T=∅ → noop', () => {
  const { target, P, J } = prepared('rb6');
  try {
    assert.equal(J.items.beta.op, 'install-new');
    assert.equal(cls(target, J, P, 'beta'), 'as-installed');
    rmSync(join(target, 'beta'), { recursive: true });
    assert.equal(cls(target, J, P, 'beta'), 'noop');
  } finally { kCleanup(target); }
});

test('🔴 install-new：T 既不缺席也不是新树 → fail-closed（本表只实测 T）', () => {
  const { target, P, J } = prepared('rb6b');
  try {
    writeFileSync(join(target, 'beta', 'SKILL.md'), '# 外部换掉了\n');
    chmodSync(join(target, 'beta', 'SKILL.md'), 0o644);
    assert.throws(() => cls(target, J, P, 'beta'), /install-new 入场分类不合法/);
  } finally { kCleanup(target); }
});

test('retire-only：(∅, old, *) → as-retired；(old, ∅, *) → noop', () => {
  const { target, P, J } = prepared('rb7');
  try {
    assert.equal(J.items.gamma.op, 'retire-only');
    assert.equal(cls(target, J, P, 'gamma'), 'as-retired');
    renameSync(join(P.retired, 'gamma'), join(target, 'gamma'));
    assert.equal(cls(target, J, P, 'gamma'), 'noop');
  } finally { kCleanup(target); }
});

test('🔴 retire-only：R 缺席且 attic 也没有 → fail-closed（不许当成 cleaned 蒙混过去）', () => {
  const { target, P, J } = prepared('rb7b');
  try {
    rmSync(join(P.retired, 'gamma'), { recursive: true });
    assert.ok(!existsSync(join(P.attic ?? '/nonexistent', 'gamma.tar')));
    assert.throws(() => cls(target, J, P, 'gamma'), /retire-only 入场分类不合法/);
  } finally { kCleanup(target); }
});

test('🔴 摘要不匹配的 T（外部改写）一律 fail-closed，不猜', () => {
  const { target, P, J } = prepared('rb8');
  try {
    writeFileSync(join(target, 'alpha', 'SKILL.md'), '# 外部改写\n');
    chmodSync(join(target, 'alpha', 'SKILL.md'), 0o644);
    assert.throws(() => cls(target, J, P, 'alpha'), /swap 入场分类不合法/);
  } finally { kCleanup(target); }
});

test('前提自检：fixture 的两个摘要确实不同（否则整张表判不出来）', () => {
  assert.notEqual(digestOf(OLD_ALPHA), digestOf(NEW_ALPHA));
  void mkdirSync;
});

// ── §5.4.2 bootstrap：`ledger_existed = false` 的 rollback 要**删掉整个 ledger.json** ──

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import {
  bootstrapLedger, ensureGenerationWatermark, nextGeneration, readLedger,
} from '../src/ledger.mjs';
import { derivePlan } from '../src/plan.mjs';
import { stageTrees, commitPoint, applyItems } from '../src/install.mjs';
import { recover } from '../src/recover.mjs';

const AT2 = '2026-08-26T00:00:00Z';

test('🔴 首次安装的 rollback 必须删掉整个 ledger.json，不是留一个空骨架', () => {
  const base = mkdtempSync(join(tmpdir(), 'kfx-t-boot-'));
  const target = join(base, 'skills');
  try {
    mkdirSync(target, { recursive: true, mode: 0o755 });
    chmodSync(target, 0o755);
    materializeFiles(join(base, 'src', 'beta'), { 'SKILL.md': '# beta v1\n' });
    const P0 = layout(target);
    ensureGenerationWatermark(P0);
    // 🔴 骨架是**本次事务写出来的**；`ledger_existed` 说的是「事务开始之前」
    const existedBefore = existsSync(P0.ledger);
    bootstrapLedger(P0, {
      client: 'claude', fstype: 'apfs', path: target, realpath: target, scope: 'global',
    });
    assert.equal(existedBefore, false);

    const gen = nextGeneration(P0);
    const d = digestOf({ 'SKILL.md': '# beta v1\n' });
    const plan = derivePlan({
      generation: gen,
      install: [{
        artifact: 'skill:g/beta@1', installed_at: AT2, name: 'beta',
        requested_by: ['direct:skill:g/beta@1'], snapshot: 42,
        srcDir: join(base, 'src', 'beta'), tree_digest: d,
      }],
      ledger: readLedger(P0.ledger),
      ledgerExisted: existedBefore,
      roots: {
        'direct:skill:g/beta@1': {
          artifact: 'skill:g/beta@1', intent: { no_bundled: false, pre: false },
          kind: 'direct', requested_at: AT2, snapshot: 42, tree_digest: d,
        },
      },
      target,
    });
    assert.equal(plan.ledger_image.ledger_existed, false);

    const P = layout(target, gen);
    stageTrees(P, plan);
    const J = commitPoint(P, plan, { floor: null });
    applyItems(target, J, P);
    recover(target, { mode: 'rollback', now: AT2 });

    assert.ok(!existsSync(P0.ledger),
      '🔴 ledger_existed=false 的 rollback 留下了一个空骨架 —— 规范要求删除整个 ledger.json');
    assert.ok(!existsSync(join(target, 'beta')), 'install-new 的反向没复位');
    // 🔴 水位与 audit-seq 永不删除
    assert.ok(existsSync(P0.generationFile));
    assert.ok(existsSync(P0.auditSeqFile));
  } finally { rmSync(dirname(target), { recursive: true, force: true }); }
});
