// 场景定义 —— 子进程与父进程**共用同一份**。
// trace 那一趟与注入那一趟必须跑逐字节相同的操作序列，否则「第 n 次命中」会错位。
//
// 约定：`setup()` 在**注入解除**的状态下跑（它是被测流程的输入，不是被测对象），
//       `run()` 才是被注入的那一段。crash-runner / child 负责切换。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeDigest } from '../../src/tree-digest.mjs';
import { mkdirChainFsync } from '../../src/atomic-fs.mjs';
import {
  emptyLedger, layout, makePlan, materialize, mkTargetDir, recover,
  recoverRollback, runForward, runForwardPrepared, seed, writeLedger,
} from './fake-tx.mjs';
import {
  checkAuditInvariants, checkRepairInvariants, makeEvents, recoverAuditArchive,
  recoverRepair, runAuditArchive, runRepair,
} from './fake-intents.mjs';

export const OLD_A = { 'SKILL.md': '# alpha v1\n', 'ref/x.md': 'old x\n' };
export const NEW_A = { 'SKILL.md': '# alpha v2\n', 'ref/x.md': 'new x\n', 'ref/y.md': 'new y\n' };
export const NEW_B = { 'SKILL.md': '# beta v1\n' };
export const OLD_C = { 'SKILL.md': '# gamma v1\n' };

const digestCache = new Map();
/**
 * 用一棵临时树算出 files 的 tree digest（物化方式与 fake-tx 完全一致）。
 * 🔴 算完就删 —— 矩阵一轮要调它上千次，不删会在 /tmp 里堆出几百个 `fx-dg-*`
 *    （Codex 第二轮的「临时目录泄漏」，实测一轮漏 112 个）。
 */
export function digestOf(files) {
  const key = JSON.stringify(files);
  if (!digestCache.has(key)) {
    const base = mkdtempSync(join(tmpdir(), 'fx-dg-'));
    try {
      const dir = join(base, 't');
      materialize(dir, files);
      digestCache.set(key, treeDigest(dir));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  return digestCache.get(key);
}

const GEN = 7;

export const SCENARIOS = {
  // ── 一次典型安装：swap（有旧树）+ install-new + retire-only ────────────────
  'fake-tx': {
    kind: 'tx',
    setup(target) {
      mkTargetDir(target);
      seed(target, { alpha: OLD_A, gamma: OLD_C });
    },
    run(target) {
      runForward(target, makePlan(target, GEN, [
        { name: 'alpha', op: 'swap', newFiles: NEW_A },
        { name: 'beta', op: 'install-new', newFiles: NEW_B },
        { name: 'gamma', op: 'retire-only' },
      ]));
    },
    recover: (target) => recover(target),
    expect: () => ({
      gen: GEN,
      items: [
        { name: 'alpha', op: 'swap', oldDigest: digestOf(OLD_A), newDigest: digestOf(NEW_A) },
        { name: 'beta', op: 'install-new', newDigest: digestOf(NEW_B) },
        { name: 'gamma', op: 'retire-only', oldDigest: digestOf(OLD_C) },
      ],
    }),
  },

  // ── 事务停在 prepared 之后回滚（§5.4.1）───────────────────────────────────
  'fake-tx-rollback': {
    kind: 'tx',
    setup(target) {
      mkTargetDir(target);
      seed(target, { alpha: OLD_A });
      runForwardPrepared(target, makePlan(target, GEN, [
        { name: 'alpha', op: 'swap', newFiles: NEW_A },
      ]));
    },
    run(target) { recoverRollback(target); },
    recover: (target) => recoverRollback(target),
    expect: () => ({
      gen: GEN,
      rolledBack: true,
      items: [{ name: 'alpha', op: 'swap', oldDigest: digestOf(OLD_A), newDigest: digestOf(NEW_A) }],
    }),
  },

  // ── §5.10 repair intent：隔离一个未收尾的事务并跑 child ────────────────────
  'fake-repair': {
    kind: 'repair',
    setup(target) {
      mkTargetDir(target);
      seed(target, { alpha: OLD_A });
      runForwardPrepared(target, makePlan(target, GEN, [
        { name: 'alpha', op: 'swap', newFiles: NEW_A },
      ]));
    },
    run(target) { runRepair(target, { gen: GEN, childGen: GEN + 1, names: ['alpha'] }); },
    recover: (target) => recoverRepair(target),
    expect: () => ({ gen: GEN, names: ['alpha'] }),
    check: (target, exp) => checkRepairInvariants(target, exp),
  },

  // ── audit plane 的归档小事务 ──────────────────────────────────────────────
  'fake-audit': {
    kind: 'audit',
    setup(target) {
      mkTargetDir(target);
      const P = layout(target);
      mkdirChainFsync(P.state);
      writeLedger(P, { ...emptyLedger(), audit: makeEvents(5) });
    },
    run(target) { runAuditArchive(target, 2); },
    recover: (target) => recoverAuditArchive(target),
    expect: () => ({ events: makeEvents(5) }),
    check: (target, exp) => checkAuditInvariants(target, exp.events),
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);
