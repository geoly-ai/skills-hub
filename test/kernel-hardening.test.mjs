// Codex 第三轮挖出来的两条 P0 与几条 P1 的反证。
//
// 🔴 共同的教训：**schema 校验只看值不看键**，而键随后要进 `join()` / `rename` / `rmtree`；
//    **「manifest 在盘上」不等于「它能用来复位这一代」**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { arm, disarm, reset } from '../src/fault-inject.mjs';
import { stringify } from '../src/canonical-json.mjs';
import { assertSafeName, readJournal, validateJournal, writeJournal, JOURNAL_SCHEMA } from '../src/journal.mjs';
import {
  batchDigest, ensureGenerationWatermark, bootstrapLedger, layout, ledgerSkeleton, readLedger,
  resumeAuditArchive, validateLedger, writeLedger,
} from '../src/ledger.mjs';
import { validateManifest } from '../src/plan.mjs';
import { runCleanup, runTransaction } from '../src/install.mjs';
import { assertStatePathsNoSymlink, recover, validateRepairIntent } from '../src/recover.mjs';
import {
  KSCENARIOS, kFreshTarget, kCleanup, makeProjectPlan, materializeFiles, digestOf, OLD_ALPHA,
} from './kernel-scenarios.test.mjs';

const AT = '2026-08-26T00:00:00Z';
const D = (c) => `geoly-tree-v1:sha256:${String(c).repeat(64).slice(0, 64)}`;
const META = (p) => ({ client: 'claude', fstype: 'apfs', path: p, realpath: p, scope: 'global' });
const S = () => KSCENARIOS['kernel-tx'];

function stopAt(point, tag) {
  const target = kFreshTarget(tag);
  disarm(); reset();
  S().setup(target);
  arm({ name: point, nth: 1, mode: 'throw' });
  try { S().run(target); } catch (e) { if (e?.name !== 'FaultInjected') { disarm(); reset(); kCleanup(target); throw e; } }
  disarm(); reset();
  return target;
}

// ── P0-A：持久化 map 的 key 也是不可信输入 ─────────────────────────────────

test('🔴 持久化 map 的键必须过路径 grammar —— `../` 会让 rmtree/rename 打到 .geoly 之外', () => {
  for (const bad0 of ['..', '../evil', '/abs', 'a/b', '.geoly', '', '.']) {
    assert.throws(() => assertSafeName(bad0, 'x'), /不是合法的单段目录名|状态目录名|路径 segment/, `${JSON.stringify(bad0)} 应当被拒`);
  }
  assert.equal(assertSafeName('plaud-theme-dev', 'x'), 'plaud-theme-dev');
});

test('🔴 journal.items 的键做路径穿越 → 拒绝', () => {
  const J = {
    schema: JOURNAL_SCHEMA, generation: 7, phase: 'prepared', tx_dir: 'tx-7',
    items: { '../../../etc/evil': { op: 'install-new', had_old: false, state: 'planned', new_digest: D('1') } },
    ledger_image: {
      ledger_existed: true,
      post: { entries: {}, last_applied_generation: 7, roots: {} },
      pre: { entries: {}, last_applied_generation: 6, roots: {} },
    },
  };
  assert.throws(() => validateJournal(J), /journal\.items 的键/);
});

test('🔴 ledger.entries / manifest.items / repair-intent.plan.items 的键同样要过', () => {
  const sk = ledgerSkeleton(META('/x'));
  assert.throws(() => validateLedger({
    ...sk,
    entries: { '../x': { artifact: 'skill:g/x@1', generation: 1, installed_at: AT, requested_by: [], snapshot: 1, state: 'ok', tree_digest: D('1') } },
  }), /ledger\.entries 的键/);

  assert.throws(() => validateManifest({
    schema: 'geoly.skills.attic-manifest/1', created_at: AT, generation: 1,
    items: { '../x': { old_digest: D('1'), op: 'swap', reverse_op: 'swap', tar: '../x.tar' } },
    ledger_delta: { entries: {}, roots: {} },
    postimage: { digests: {}, entries: {}, in_edges: {}, out_edges: {}, roots: {} },
  }), /attic-manifest\.items 的键/);

  assert.throws(() => validateRepairIntent({
    schema: 'geoly.skills.repair-intent/1', created_at: AT, generation: 1, repair_id: 'x', state: 'planned',
    isolate: {
      journal: { digest: `sha256:${'a'.repeat(64)}`, path: 'journal/1.json' },
      ledger_transaction: { digest: `sha256:${'b'.repeat(64)}` },
      targets: { '../evil': { observed: D('1') } },
      tx: { dir: 'tx-1', fingerprint: `geoly-tx-v1:sha256:${'c'.repeat(64)}` },
    },
    plan: { items: {}, repair_ledger_image: { closure_entries: [], closure_roots: [], post: { entries: {}, roots: {} }, pre: { entries: {}, roots: {} } }, snapshot: 1 },
  }), /repair-intent\.isolate\.targets 的键/);
});

// ── P0-B：manifest 逐项语义必须绑定到本代 journal ───────────────────────────

test('🔴 把 manifest 里的 swap 项改写成 install-new + tar:null，必须挡在阶段 C 之前', () => {
  const target = stopAt('cleanup:C:pre-rmtree', 'mtamper');
  try {
    const P = layout(target, 1);
    const mPath = join(P.attic, 'manifest.json');
    const M = JSON.parse(readFileSync(mPath, 'utf8'));
    assert.equal(M.items.alpha.op, 'swap');
    M.items.alpha = { old_digest: null, op: 'install-new', reverse_op: 'retire-only', tar: null };
    writeFileSync(mPath, `${JSON.stringify(M, null, 2)}\n`);
    chmodSync(mPath, 0o644);
    // 🔴 tar **留着** —— 否则会先被阶段 A 的重验（纵深防御的另一层）拦下，
    //    那样就证不出 manifest 的语义绑定这一层
    assert.throws(
      () => runCleanup(target, readJournal(P.journal), P, { floor: null, now: AT }),
      /op=install-new 与 journal 的 swap 不符|解析失败|canonical/,
      '🔴 manifest 的 op 被改写却照样进阶段 C —— 那一代已经没有可用归档了',
    );
    assert.ok(existsSync(join(P.retired, 'alpha')), 'fail-closed 之后 retired 不得被删');
  } finally { kCleanup(target); }
});

// ── P1：阶段 C 不许删「既不是旧树也不是部分树」的东西 ───────────────────────

test('🔴 阶段 C：retired 被换成另一棵完整的外部树 → 拒绝删除（那是别人的现场证据）', () => {
  const target = stopAt('cleanup:C:pre-rmtree', 'cforeign');
  try {
    const P = layout(target, 1);
    rmSync(join(P.retired, 'alpha'), { recursive: true });
    materializeFiles(join(P.retired, 'alpha'), { 'SKILL.md': '# 外部放进来的完整树\n', 'extra.md': 'x\n' });
    assert.throws(
      () => runCleanup(target, readJournal(P.journal), P, { floor: null, now: AT }),
      /既不是完整旧树也不是「删到一半」的部分树/,
    );
    assert.ok(existsSync(join(P.retired, 'alpha', 'extra.md')), '外部证据不得被删');
  } finally { kCleanup(target); }
});

test('阶段 C：上一次删到一半留下的**部分**树仍然可以续删（判据不能误杀合法中断）', () => {
  const target = stopAt('cleanup:C:pre-rmtree', 'cpartial');
  try {
    const P = layout(target, 1);
    rmSync(join(P.retired, 'alpha', 'ref'), { recursive: true });   // 真子集：少了 ref/x.md
    const J = runCleanup(target, readJournal(P.journal), P, { floor: null, now: AT });
    assert.equal(J.phase, 'completed');
    assert.ok(!existsSync(P.tx));
  } finally { kCleanup(target); }
});

// ── P1：audit 归档批次必须与 live 前缀逐字节对应 ────────────────────────────

test('🔴 归档批次与 live 前缀不一致（live 被改写过）→ 停机，不许把改写版丢掉', () => {
  const base = mkdtempSync(join(tmpdir(), 'kfx-t-au-'));
  const target = join(base, 'skills');
  try {
    mkdirSync(target, { recursive: true, mode: 0o755 });
    const P = layout(target);
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    const ev = (id, note) => ({
      at: AT, event_id: id, kind: 'installed-yanked',
      subject: { kind: 'entry', name: 'x' }, ...(note ? { note } : {}),
    });
    writeLedger(P.ledger, { ...readLedger(P.ledger), audit: [ev(1, '改写过'), ev(2)] });
    mkdirSync(P.auditArchiveDir, { recursive: true, mode: 0o755 });
    writeFileSync(join(P.auditArchiveDir, '1.json'), stringify({
      schema: 'geoly.skills.audit-archive/1',
      batch_digest: batchDigest([ev(1)]), events: [ev(1)], from_event: 1, seq: 1, to_event: 1,
    }));
    writeFileSync(P.auditIntent, stringify({
      schema: 'geoly.skills.audit-archive-intent/1',
      batch_digest: batchDigest([ev(1)]), from_event: 1, seq: 1, to_event: 1,
    }));
    assert.throws(() => resumeAuditArchive(P), /与归档内容不同/);
    assert.equal(readLedger(P.ledger).audit.length, 2, 'fail-closed 之后 live 不得被动');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ── §3.4：状态路径无跟随 ────────────────────────────────────────────────────

test('🔴 `.geoly` 下的状态路径是 symlink → 拒绝（含 attic 深处的 manifest / tar）', () => {
  const target = kFreshTarget('sym');
  try {
    disarm(); reset();
    S().setup(target);
    S().run(target);
    const P = layout(target, 1);
    assertStatePathsNoSymlink(layout(target));      // 干净时不该报

    const evil = join(dirname(target), 'outside.tar');
    writeFileSync(evil, 'x');
    rmSync(join(P.attic, 'alpha.tar'));
    symlinkSync(evil, join(P.attic, 'alpha.tar'));
    assert.throws(() => assertStatePathsNoSymlink(layout(target)), /状态路径是 symlink/);
    // 🔴 recover 入口就要挡住，而不是等到去读它的时候
    assert.throws(() => recover(target, { mode: 'continue', now: AT }), /状态路径是 symlink/);
  } finally { kCleanup(target); }
});

// ── P1：repair 的 snapshot 绑定 ─────────────────────────────────────────────

test('🔴 repair 必须注入 assertSnapshotRetrievable —— 不注入不等于放行', () => {
  const target = kFreshTarget('snap');
  try {
    KSCENARIOS['kernel-repair'].setup(target);
    assert.throws(
      () => recover(target, { mode: 'reinstall', now: AT }),
      /必须注入 assertSnapshotRetrievable/,
    );
  } finally { kCleanup(target); }
});

test('前提自检：fixture 摘要可用', () => { assert.ok(digestOf(OLD_ALPHA).startsWith('geoly-tree-v1:')); void writeJournal; });

// ── §5.1：项目级 target 的账本变了就必须重算 lockfile ───────────────────────

test('🔴 项目级 target：没注入 onLedgerChanged 就 fail-closed，不许静默留下陈旧 lockfile', () => {
  const target = kFreshTarget('proj');
  try {
    disarm(); reset();
    S().setup(target);
    const P0 = layout(target);
    const L = readLedger(P0.ledger);
    writeLedger(P0.ledger, { ...L, target: { ...L.target, scope: 'project' } });
    assert.throws(
      () => S().run(target),
      /必须注入 onLedgerChanged/,
      '🔴 项目级账本变了却没重算 lockfile —— 下一次 install 会按陈旧的它装出不一样的东西',
    );
    // 🔴 入口就拒 ⇒ 事务**一点都没开始**，target 与 .geoly 都还是原样
    const P1 = layout(target, 1);
    assert.ok(!existsSync(P1.tx), '入口预检失败之后不该留下 tx 目录');
    assert.ok(!existsSync(P1.journal), '入口预检失败之后不该留下 journal');
    assert.equal(readLedger(P0.ledger).transaction, null);

    // 注入之后必须真的被调用（而不是「有这个字段就放行」）
    let called = 0;
    runTransaction(target, makeProjectPlan(target), {
      floor: null, now: AT, onLedgerChanged: (t) => { called++; assert.equal(t, target); },
    });
    assert.equal(called, 1, '注入了却没被调用 —— 那这道门等于摆设');
  } finally { kCleanup(target); }
});
