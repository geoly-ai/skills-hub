// 真事务内核的崩溃场景 + **独立实现**的不变式。
//
// 🔴 「独立」是这份文件存在的理由：期望值一律从**不可变的 fixture** 算出来，
//    绝不从被测模块生成的产物里读回来当期望 —— 否则测试就是在自证。
//    因此这里既不导入 test/harness/invariants.mjs，也不导入 fake-tx。
//
// 本文件同时被 test/kernel-fault-matrix.test.mjs 当作场景库导入。
// 它自己也带几条 happy-path 断言，因此照常是一个 .test.mjs。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { treeDigest } from '../src/tree-digest.mjs';
import { makeFloor } from '../src/trust.mjs';
import { stringify as stringifyCanonical } from '../src/canonical-json.mjs';
import { parseTar } from '../src/untar.mjs';
import {
  layout, readLedger, bootstrapLedger, ensureGenerationWatermark, nextGeneration,
  batchDigest, maybeArchiveAudit,
} from '../src/ledger.mjs';
import { readJournal, listJournalGenerations, writeJournal } from '../src/journal.mjs';
import { derivePlan } from '../src/plan.mjs';
import {
  runTransaction, stageTrees, commitPoint, applyItems, verifyAndCommit,
} from '../src/install.mjs';
import { recover } from '../src/recover.mjs';

// ── 不可变 fixture ───────────────────────────────────────────────────────────

export const OLD_ALPHA = { 'SKILL.md': '# alpha v1\n', 'ref/x.md': 'old x\n' };
export const NEW_ALPHA = { 'SKILL.md': '# alpha v2\n', 'ref/x.md': 'new x\n', 'ref/y.md': 'new y\n' };
export const NEW_BETA = { 'SKILL.md': '# beta v1\n' };
export const OLD_GAMMA = { 'SKILL.md': '# gamma v1\n' };

const AT = '2026-08-26T00:00:00Z';
const TARGET_META = (p) => ({ client: 'claude', fstype: 'apfs', path: p, realpath: p, scope: 'global' });

export function materializeFiles(dir, files) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o755 });
    let d = dirname(abs);
    while (d.length >= dir.length) { chmodSync(d, 0o755); if (d === dir) break; d = dirname(d); }
    writeFileSync(abs, content);
    chmodSync(abs, 0o644);
  }
}

const digestCache = new Map();
/** 从 fixture 独立算出期望摘要（算完就删临时目录，矩阵一轮要调上千次）*/
export function digestOf(files) {
  const key = JSON.stringify(files);
  if (!digestCache.has(key)) {
    const base = mkdtempSync(join(tmpdir(), 'kfx-dg-'));
    try {
      const d = join(base, 't');
      materializeFiles(d, files);
      digestCache.set(key, treeDigest(d));
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
  return digestCache.get(key);
}

/**
 * 🔴 每进程一个私有沙箱根。判据**不能建立在 `tmpdir()` 这种别人也能写的命名空间上**——
 * `kfx-t-` 这个前缀被四个测试文件共用（kernel-fault-matrix / kernel-scenarios /
 * kernel-hardening / recover-rollback），并行跑时互相污染计数，**两个方向都会假红**：
 * 多算了别人建的，或者自己的被别人删了。今天已经在 `fx-*` 上栽过同一次。
 */
export const KFX_ROOT = mkdtempSync(join(tmpdir(), `kfxroot-${process.pid}-`));

export function kFreshTarget(tag) {
  return join(mkdtempSync(join(KFX_ROOT, `kfx-t-${tag}-`)), 'skills');
}
export function kCleanup(target) {
  if (target) rmSync(dirname(target), { recursive: true, force: true });
}

/** I7 的收敛判据：把 target 与 .geoly 整棵树摘成一个可比较的字符串（忽略 .tmp）*/
export function snapshotTree(target) {
  const lines = [];
  (function rec(dir, prefix) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.tmp')) continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) { lines.push(`d ${prefix}${name}/`); rec(abs, `${prefix}${name}/`); }
      else lines.push(`f ${prefix}${name} ${createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16)}`);
    }
  })(target, '');
  return lines.join('\n');
}

// ── 独立的 tar 重算（不复用 install.mjs 的 archiveDigest —— 那是被测代码）─────

/**
 * 🔴 「文件在不在」永远不是判据：attic 里那份 tar 必须**从字节重算**，
 *    才谈得上「旧树还有一份完整副本」。
 */
export function tarTreeDigest(tarPath) {
  const { entries } = parseTar(readFileSync(tarPath));
  const dir = join(mkdtempSync(join(tmpdir(), 'kfx-tar-')), 'v');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    for (const e of entries) {
      const abs = join(dir, e.path);
      mkdirSync(dirname(abs), { recursive: true, mode: 0o755 });
      writeFileSync(abs, e.data);
      chmodSync(abs, e.mode);
    }
    let d2 = dir;
    (function fix(d) {
      chmodSync(d, 0o755);
      for (const n of readdirSync(d)) { const a = join(d, n); if (statSync(a).isDirectory()) fix(a); }
    })(d2);
    return treeDigest(dir);
  } finally { rmSync(dirname(dir), { recursive: true, force: true }); }
}

const safeDigest = (p) => { try { return existsSync(p) ? treeDigest(p) : null; } catch { return null; } };

// ── 通用不变式 ───────────────────────────────────────────────────────────────

const fail = (msg) => { throw new Error(msg); };

/** I1：磁盘上每一份 journal 都必须能通过 CRC 与 schema 校验 */
function checkJournalsWellFormed(target) {
  const P0 = layout(target);
  for (const g of listJournalGenerations(P0.journalDir)) {
    try { readJournal(layout(target, g).journal); } catch (e) { fail(`I1 违反：journal ${g} 不自洽 —— ${e.message}`); }
  }
}

/** I2：最多只有一个未完成事务 */
function checkAtMostOneLive(target) {
  const P0 = layout(target);
  const live = listJournalGenerations(P0.journalDir)
    .filter((g) => readJournal(layout(target, g).journal).phase !== 'completed');
  if (live.length > 1) fail(`I2 违反：同时存在 ${live.length} 个未完成事务`);
}

/**
 * I3：**旧树在任何时刻至少有一份完整副本**（§5.6 的逐段论证）。
 * 三处候选：target/<name>、tx/retired/<name>、attic/<gen>/<name>.tar（**重算内容**）。
 */
function checkOldTreeSurvives(target, expectations) {
  const P0 = layout(target);
  for (const { name, oldDigest, gen } of expectations) {
    if (!oldDigest) continue;
    const P = layout(target, gen);
    const cands = [];
    if (safeDigest(join(target, name)) === oldDigest) cands.push('T');
    if (safeDigest(join(P.retired, name)) === oldDigest) cands.push('R');
    const tar = join(P.attic, `${name}.tar`);
    if (existsSync(tar)) {
      let d = null;
      try { d = tarTreeDigest(tar); } catch { d = null; }
      if (d === oldDigest) cands.push('A');
    }
    // 事务已彻底收尾且该项本来就该消失（retire-only）时，A 是唯一副本 —— 仍然要求它在
    if (cands.length === 0) {
      fail(`I3 违反：${name} 的旧树三处副本全毁（T/R/A 都不是 ${oldDigest}）`);
    }
    void P0;
  }
}

/**
 * I6：🔴 **在 manifest durable 之前，不允许删除任何 retired 树**。
 * 判据：只要有任一项 `cleanup === 'done'`，本代 manifest 就必须已 durable 且文件自洽。
 */
function checkManifestBeforeDelete(target) {
  const P0 = layout(target);
  for (const g of listJournalGenerations(P0.journalDir)) {
    const P = layout(target, g);
    const J = readJournal(P.journal);
    const anyDeleted = Object.values(J.items).some((it) => it.cleanup === 'done' && it.had_old);
    if (!anyDeleted) continue;
    if (J.manifest !== 'durable') fail(`I6 违反：第 ${g} 代已经删过 retired，journal 却没记 manifest=durable`);
    if (!existsSync(join(P.attic, 'manifest.json'))) fail(`I6 违反：第 ${g} 代 manifest 文件不存在`);
  }
}

/** I4：不得同时存在「已完成的 journal」与它那一代的 tx 目录 */
function checkNoCompletedWithTx(target) {
  const P0 = layout(target);
  for (const g of listJournalGenerations(P0.journalDir)) {
    const P = layout(target, g);
    if (readJournal(P.journal).phase === 'completed' && existsSync(P.tx)) {
      fail(`I4 违反：第 ${g} 代 journal 已 completed 却还留着 tx`);
    }
  }
}

function txDirs(target) {
  const P0 = layout(target);
  if (!existsSync(P0.state)) return [];
  return readdirSync(P0.state).filter((n) => /^tx-\d+$/.test(n));
}

// ════════════════════════════════════════════════════════════════════════════
// 场景
// ════════════════════════════════════════════════════════════════════════════

const D_OLD_A = () => digestOf(OLD_ALPHA);
const D_NEW_A = () => digestOf(NEW_ALPHA);
const D_NEW_B = () => digestOf(NEW_BETA);
const D_OLD_G = () => digestOf(OLD_GAMMA);

function seedTarget(target) {
  mkdirSync(target, { recursive: true, mode: 0o755 });
  chmodSync(target, 0o755);
  materializeFiles(join(target, 'alpha'), OLD_ALPHA);
  materializeFiles(join(target, 'gamma'), OLD_GAMMA);
  const src = join(dirname(target), 'src');
  materializeFiles(join(src, 'alpha'), NEW_ALPHA);
  materializeFiles(join(src, 'beta'), NEW_BETA);
  // 🔴 stage 与 target 同设备时第 5 步是 rename，src/ 会被**搬空**；
  //    repair 的 resolver 需要一份没被消费过的副本。
  const ref = join(dirname(target), 'ref');
  materializeFiles(join(ref, 'alpha'), NEW_ALPHA);
  materializeFiles(join(ref, 'beta'), NEW_BETA);
  const P = layout(target);
  ensureGenerationWatermark(P);
  bootstrapLedger(P, TARGET_META(target));
  return src;
}

function makePlan(target) {
  const src = join(dirname(target), 'src');
  const P = layout(target);
  const gen = nextGeneration(P);
  const root = (k, d) => ({
    artifact: k.replace(/^direct:/, ''), intent: { no_bundled: false, pre: false },
    kind: 'direct', requested_at: AT, snapshot: 42, tree_digest: d,
  });
  return derivePlan({
    generation: gen,
    install: [
      {
        artifact: 'skill:g/alpha@2', installed_at: AT, name: 'alpha',
        requested_by: ['direct:skill:g/alpha@2'], snapshot: 42,
        srcDir: join(src, 'alpha'), tree_digest: D_NEW_A(),
      },
      {
        artifact: 'skill:g/beta@1', installed_at: AT, name: 'beta',
        requested_by: ['direct:skill:g/beta@1'], snapshot: 42,
        srcDir: join(src, 'beta'), tree_digest: D_NEW_B(),
      },
    ],
    ledger: readLedger(P.ledger),
    ledgerExisted: true,
    replace: new Set(['alpha', 'gamma']),
    retire: ['gamma'],
    roots: {
      'direct:skill:g/alpha@2': root('direct:skill:g/alpha@2', D_NEW_A()),
      'direct:skill:g/beta@1': root('direct:skill:g/beta@1', D_NEW_B()),
    },
    target,
  });
}

/** 给 hardening 测试用：同一份计划，供「注入了回调」的那一趟复用 */
export function makeProjectPlan(target) { return makePlan(target); }

/** 事务的两个合法终态：完全应用 / 完全未应用 */
function assertTerminalTx(target, where) {
  const P0 = layout(target);
  const L = readLedger(P0.ledger);
  if (L.transaction !== null) fail(`终态违反（${where}）：ledger.transaction 仍非 null`);
  if (txDirs(target).length) fail(`终态违反（${where}）：还留着 tx 目录 ${txDirs(target)}`);
  const dA = safeDigest(join(target, 'alpha'));
  const dB = safeDigest(join(target, 'beta'));
  const dG = safeDigest(join(target, 'gamma'));
  const applied = dA === D_NEW_A() && dB === D_NEW_B() && dG === null;
  const pristine = dA === D_OLD_A() && dB === null && dG === D_OLD_G();
  if (!applied && !pristine) {
    fail(`终态违反（${where}）：既不是「完全应用」也不是「完全未应用」`
      + `（alpha=${dA} beta=${dB} gamma=${dG}）`);
  }
  const names = Object.keys(L.entries).sort().join(',');
  if (applied && names !== 'alpha,beta') fail(`终态违反（${where}）：已应用但账本 entries=${names}`);
  if (pristine && names !== '') fail(`终态违反（${where}）：未应用但账本 entries=${names}`);
  if (applied) {
    // 完全应用时，两棵旧树的唯一副本必须是 attic 里那两份 tar，且内容重算相符
    for (const [n, d] of [['alpha', D_OLD_A()], ['gamma', D_OLD_G()]]) {
      const tar = join(layout(target, 1).attic, `${n}.tar`);
      if (!existsSync(tar)) fail(`终态违反（${where}）：已应用却没有 attic/1/${n}.tar`);
      if (tarTreeDigest(tar) !== d) fail(`终态违反（${where}）：attic/1/${n}.tar 内容重算不符`);
    }
    if (!existsSync(join(layout(target, 1).attic, 'manifest.json'))) {
      fail(`终态违反（${where}）：已应用却没有本代 manifest`);
    }
  }
}

function commonChecks(target, gen) {
  checkJournalsWellFormed(target);
  checkAtMostOneLive(target);
  checkNoCompletedWithTx(target);
  checkManifestBeforeDelete(target);
  checkOldTreeSurvives(target, [
    { gen, name: 'alpha', oldDigest: D_OLD_A() },
    { gen, name: 'gamma', oldDigest: D_OLD_G() },
  ]);
}

/**
 * `--reinstall` 的主路径是「重新解析安装」，因此必须注入 resolver。
 * 🔴 内核只接受一个**已经过完整验证链**的目录，自己再验一次摘要与结构；
 *    下载 / 验签 / 资产 sha256 属于 §02-6，不在内核范围。
 */
const TRUST_STATE = (target) => join(dirname(target), 'user-state');
export function seedTrustFloor(target) {
  const dir = TRUST_STATE(target);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const f = makeFloor({
    latest_snapshot: 42,
    now: new Date(AT),
    snapshot_sha256: `sha256:${'2a'.repeat(32)}`,
    timestamp_sha256: `sha256:${'1b'.repeat(32)}`,
    timestamp_version: 5,
  });
  writeFileSync(join(dir, 'trust.json'), stringifyCanonical(f));
  return f;
}

function repairOpts(target) {
  const ref = join(dirname(target), 'ref');
  const stateDir = TRUST_STATE(target);
  const expected = seedTrustFloor(target);
  return {
    // 🔴 repair child 从 registry 重新解析安装 ⇒ 必须显式给 floor，
    //    提交点之前会复验它（内核在这里 fail-closed，不允许 `?? null` 跳过）。
    floor: { expected, stateDir },
    mode: 'reinstall', now: AT, snapshot: 42,
    // §5.10：plan.snapshot 必须能按 §02-6.1 取回并验签 —— 那条链不在内核范围，注入之。
    assertSnapshotRetrievable: (n) => { if (n !== 42) throw new Error(`快照 ${n} 取不回来`); },
    resolver: (name) => ({ artifact: `skill:g/${name}@2`, dir: join(ref, name) }),
  };
}

export const KSCENARIOS = {
  // ── 一次典型安装：swap + install-new + retire-only ─────────────────────────
  'kernel-tx': {
    setup(target) { seedTarget(target); },
    run(target) { runTransaction(target, makePlan(target), { floor: null, now: AT }); },
    recover(target) { return recover(target, { mode: 'continue', now: AT }); },
    check(target, { recovered, where }) {
      commonChecks(target, 1);
      if (recovered) assertTerminalTx(target, where);
    },
  },

  // ── 事务停在 prepared 之后回滚（§5.4.1）───────────────────────────────────
  'kernel-rollback': {
    setup(target) {
      seedTarget(target);
      const plan = makePlan(target);
      const P = layout(target, plan.generation);
      stageTrees(P, plan);
      const J = commitPoint(P, plan, { floor: null });
      applyItems(target, J, P);     // 停在「已交换、phase 仍是 prepared」
    },
    run(target) { return recover(target, { mode: 'rollback', now: AT }); },
    recover(target) { return recover(target, { mode: 'rollback', now: AT }); },
    check(target, { recovered, where }) {
      commonChecks(target, 1);
      if (!recovered) return;
      const P0 = layout(target);
      const L = readLedger(P0.ledger);
      if (L.transaction !== null) fail(`回滚终态（${where}）：transaction 仍非 null`);
      if (Object.keys(L.entries).length) fail(`回滚终态（${where}）：账本 entries 非空`);
      if (safeDigest(join(target, 'alpha')) !== D_OLD_A()) fail(`回滚终态（${where}）：alpha 不是旧树`);
      if (safeDigest(join(target, 'gamma')) !== D_OLD_G()) fail(`回滚终态（${where}）：gamma 不是旧树`);
      if (existsSync(join(target, 'beta'))) fail(`回滚终态（${where}）：beta 还在（install-new 未复位）`);
      // 🔴 终结①：本代 attic 与其 manifest 必须删掉，否则会留下一个看起来「已完成」的代
      if (existsSync(layout(target, 1).attic)) fail(`回滚终态（${where}）：本代 attic 没删`);
      if (txDirs(target).length) fail(`回滚终态（${where}）：tx 目录没清`);
    },
  },

  // ── §5.10 repair intent：隔离一个 corrupt 事务并跑 child ───────────────────
  'kernel-repair': {
    setup(target) {
      seedTarget(target);
      const plan = makePlan(target);
      const P = layout(target, plan.generation);
      stageTrees(P, plan);
      const J = commitPoint(P, plan, { floor: null });
      applyItems(target, J, P);
      // 🔴 **自然地**造出物理 corrupt：第 7 步交换完之后、第 8 步校验之前，
      //    外部把落位的树改掉 —— 第 8 步重算摘要不符即写 state=corrupt。
      //    这棵树既不是旧树也不是新树，因此它**本身不可信**，会被隔离。
      writeFileSync(join(target, 'alpha', 'SKILL.md'), '# 被外部改过\n');
      chmodSync(join(target, 'alpha', 'SKILL.md'), 0o644);
      try { verifyAndCommit(target, J, P); } catch (e) { if (!e?.corrupt) throw e; }
    },
    run(target) { return recover(target, repairOpts(target)); },
    recover(target) { return recover(target, repairOpts(target)); },
    check(target, { recovered, where }) {
      checkJournalsWellFormed(target);
      const P0 = layout(target);
      const Q = join(P0.quarantineDir, '1');
      // R1：tx / journal 要么在原处、要么在隔离位置，**绝不两边都在、也绝不两边都没**
      if (existsSync(Q)) {
        for (const [what, orig, quar] of [
          ['tx', layout(target, 1).tx, join(Q, 'tx')],
          ['journal', layout(target, 1).journal, join(Q, 'journal.json')],
        ]) {
          const a = existsSync(orig), b = existsSync(quar);
          if (a && b) fail(`R1 违反（${where}）：${what} 原处与隔离位置同时存在`);
          if (!a && !b) fail(`R1 违反（${where}）：${what} 原处与隔离位置都不存在`);
        }
      }
      // 🔴 旧树不能丢：alpha 的旧树必须仍在某处（target / quarantine / attic）
      const cands = [
        safeDigest(join(target, 'alpha')),
        safeDigest(join(Q, 'targets', 'alpha')),
        safeDigest(join(Q, 'tx', 'retired', 'alpha')),
      ];
      const hasOld = cands.includes(D_OLD_A());
      const hasNew = cands.includes(D_NEW_A());
      if (!hasOld && !hasNew) fail(`R2 违反（${where}）：alpha 的树在任何位置都找不到`);
      if (!recovered) return;
      if (existsSync(P0.repairIntent)) fail(`repair 终态（${where}）：intent 还在`);
      // 🔴 quarantine 不自动删除（可能是唯一残存证据）
      if (!existsSync(Q)) fail(`repair 终态（${where}）：quarantine 被自动删掉了`);
      const L = readLedger(P0.ledger);
      if (L.transaction !== null) fail(`repair 终态（${where}）：transaction 仍非 null`);
      if (safeDigest(join(target, 'alpha')) !== D_NEW_A()) fail(`repair 终态（${where}）：alpha 不是目标树`);
    },
  },

  // ── audit plane 的归档小事务 ──────────────────────────────────────────────
  'kernel-audit': {
    setup(target) {
      mkdirSync(target, { recursive: true, mode: 0o755 });
      chmodSync(target, 0o755);
      const P = layout(target);
      ensureGenerationWatermark(P);
      const L = bootstrapLedger(P, TARGET_META(target));
      const { writeLedger } = { writeLedger: null };
      void writeLedger; void L;
      // 直接写进骨架：5 条事件
      const led = readLedger(P.ledger);
      led.audit = makeEvents(5);
      // 走正规写入口（canonical + 原子写 + 校验）
      import('../src/ledger.mjs').then(() => {});
      writeLedgerSync(P.ledger, led);
    },
    run(target) { return maybeArchiveAudit(layout(target), { maxEntries: 2 }); },
    recover(target) { return recover(target, { mode: 'continue', auditMaxEntries: 2, now: AT }); },
    check(target, { where }) { checkAuditInvariants(target, makeEvents(5), where); },
  },
};

// writeLedger 的同步别名（setup 里要用；避免顶层重复导入名冲突）
import { writeLedger as writeLedgerSync } from '../src/ledger.mjs';

export function makeEvents(n) {
  return Array.from({ length: n }, (_, i) => ({
    at: AT, event_id: i + 1, kind: 'installed-yanked', subject: { kind: 'entry', name: `s${i + 1}` },
  }));
}

/** audit 的不变式：**只增不减**，live ∪ archived 恰好等于全集，cursor 不超前 */
export function checkAuditInvariants(target, allEvents, where) {
  const P = layout(target);
  const L = readLedger(P.ledger);
  const seen = new Map();
  for (const e of L.audit) {
    if (seen.has(e.event_id)) fail(`A1 违反（${where}）：live 里 event_id ${e.event_id} 重复`);
    seen.set(e.event_id, JSON.stringify(e));
  }
  const liveIds = new Set(L.audit.map((e) => e.event_id));
  if (existsSync(P.auditArchiveDir)) {
    for (const f of readdirSync(P.auditArchiveDir).filter((n) => /^\d+\.json$/.test(n))) {
      const arc = JSON.parse(readFileSync(join(P.auditArchiveDir, f), 'utf8'));
      if (batchDigest(arc.events) !== arc.batch_digest) fail(`A2 违反（${where}）：${f} 的 batch_digest 与内容不符`);
      if (arc.seq !== arc.to_event) fail(`A2 违反（${where}）：${f} 的 seq != to_event`);
      for (const e of arc.events) {
        if (seen.has(e.event_id)) fail(`A1 违反（${where}）：${e.event_id} 同时在 live 与 archive`);
        seen.set(e.event_id, JSON.stringify(e));
      }
    }
  }
  for (const e of allEvents) {
    const s = seen.get(e.event_id);
    if (s === undefined) fail(`A3 违反（${where}）：event ${e.event_id} 丢了（audit 只增不减）`);
    if (s !== JSON.stringify(e)) fail(`A4 违反（${where}）：event ${e.event_id} 内容被改过`);
  }
  const archivedMax = Math.max(0, ...[...seen.keys()].filter((id) => !liveIds.has(id)));
  if ((L.audit_archived_until ?? 0) > archivedMax) {
    fail(`A5 违反（${where}）：audit_archived_until=${L.audit_archived_until} 超过实际已归档的最大 id ${archivedMax}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// happy path（本文件自己的断言）
// ════════════════════════════════════════════════════════════════════════════

test('happy path：swap + install-new + retire-only 一次跑完，终态与 fixture 相符', () => {
  const target = kFreshTarget('happy');
  try {
    KSCENARIOS['kernel-tx'].setup(target);
    KSCENARIOS['kernel-tx'].run(target);
    KSCENARIOS['kernel-tx'].check(target, { recovered: true, where: 'happy' });
    const P = layout(target);
    const L = readLedger(P.ledger);
    assert.equal(L.last_applied_generation, 1);
    assert.deepEqual(Object.keys(L.entries).sort(), ['alpha', 'beta']);
    assert.equal(L.entries.alpha.tree_digest, digestOf(NEW_ALPHA));
    assert.deepEqual(Object.keys(L.roots).sort(), ['direct:skill:g/alpha@2', 'direct:skill:g/beta@1']);
    // 🔴 completed 的 journal 是残留 —— 跑一次 recover 之后应当被清掉且无事可做
    const r = recover(target, { mode: 'continue', now: AT });
    assert.ok(['nothing', 'residue-cleared'].includes(r.outcome), JSON.stringify(r));
  } finally { kCleanup(target); }
});

test('happy path：prepared 之后 rollback，旧树逐字节回位', () => {
  const target = kFreshTarget('happy-rb');
  try {
    KSCENARIOS['kernel-rollback'].setup(target);
    KSCENARIOS['kernel-rollback'].run(target);
    KSCENARIOS['kernel-rollback'].check(target, { recovered: true, where: 'happy' });
    assert.equal(treeDigest(join(target, 'alpha')), digestOf(OLD_ALPHA));
  } finally { kCleanup(target); }
});

test('happy path：repair intent 隔离 corrupt 事务并由 child 装上目标树', () => {
  const target = kFreshTarget('happy-rp');
  try {
    KSCENARIOS['kernel-repair'].setup(target);
    KSCENARIOS['kernel-repair'].run(target);
    KSCENARIOS['kernel-repair'].check(target, { recovered: true, where: 'happy' });
    assert.equal(treeDigest(join(target, 'alpha')), digestOf(NEW_ALPHA));
    // 🔴 隔离区保持原样、只读、可取证
    assert.ok(existsSync(join(target, '.geoly', 'quarantine', '1', 'tx')));
    assert.ok(existsSync(join(target, '.geoly', 'quarantine', '1', 'journal.json')));
  } finally { kCleanup(target); }
});

test('happy path：audit 归档小事务，live ∪ archive 恰好等于全集', () => {
  const target = kFreshTarget('happy-au');
  try {
    KSCENARIOS['kernel-audit'].setup(target);
    const r = KSCENARIOS['kernel-audit'].run(target);
    assert.equal(r.outcome, 'archived');
    assert.equal(r.seq, 3);          // 🔴 seq = to_event
    KSCENARIOS['kernel-audit'].check(target, { where: 'happy' });
    const L = readLedger(layout(target).ledger);
    assert.deepEqual(L.audit.map((e) => e.event_id), [4, 5]);
    assert.equal(L.audit_archived_until, 3);
    // 🔴 阈值边界：live 数 == max **不归档**
    assert.equal(maybeArchiveAudit(layout(target), { maxEntries: 2 }).outcome, 'noop');
  } finally { kCleanup(target); }
});
