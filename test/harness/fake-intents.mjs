// 假 repair intent（§5.10）与假 audit archive intent（§4 audit plane）。
//
// 为什么单独一份：M0 §6 点名要覆盖「repair intent/child」与「audit archive intent」。
// 它们**不是安装事务的一部分**，各有自己的状态文件与崩溃点，
// 光靠假安装事务的 trace 永远打不到（Codex 第一轮评审的第 4 条）。
//
// 同样是「最小但同构」：状态文件名、字段名、步骤顺序、原子写纪律都照规范，
// 只把下载/验签/真 tar 这些与崩溃恢复无关的部分省掉。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrict, stringify } from '../../src/canonical-json.mjs';
import { txDigest, treeDigest } from '../../src/tree-digest.mjs';
import { mkdirChainFsync, renameDirFsync, rmtreeFsync, writeAtomic, fsyncDir } from '../../src/atomic-fs.mjs';
import { fp } from '../../src/fault-inject.mjs';
import { Corrupt, layout, readLedger, writeLedger } from './fake-tx.mjs';

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

// ════════════════════════════════════════════════════════════════════════════
// repair intent（§5.10 的六步）
// ════════════════════════════════════════════════════════════════════════════

export function repairPaths(target, gen) {
  const state = join(target, '.geoly');
  return {
    state,
    intent: join(state, 'repair-intent.json'),
    quarantine: join(state, 'quarantine', String(gen)),
    ledger: join(state, 'ledger.json'),
  };
}

const readIntent = (p) => parseStrict(readFileSync(p, 'utf8'));

/**
 * 六步。每一步之间都有注入点；恢复一律**按物理实况定位，不按 state 断言**
 * （§5.10：state=planned 不代表 tx 还在原处）。
 */
export function runRepair(target, opts) {
  const { gen, childGen, names } = opts;
  const P = layout(target, gen);
  const Q = repairPaths(target, gen);

  // ① 枚举 plan + 记下四项的可验证身份
  const isolate = {
    tx: { dir: `tx-${gen}`, fingerprint: txDigest(P.tx) },
    journal: { path: `journal/${gen}.json`, digest: sha256(readFileSync(P.journal)) },
    ledger_transaction: { digest: sha256(stringify(readLedger(P.ledger).transaction)) },
    targets: Object.fromEntries(names.map((n) => [n, { observed: treeDigest(join(target, n)) }])),
  };
  const intent = {
    schema: 'geoly.skills.repair-intent/1',
    created_at: '2026-08-26T00:00:00Z',
    generation: gen,
    isolate,
    plan: { snapshot: 42, items: Object.fromEntries(names.map((n) => [n, { child_op: 'swap' }])) },
    repair_id: '0f3c',
    state: 'planned',
  };

  // ② 写 intent
  writeAtomic(Q.intent, stringify(intent));
  fp('repair:step2:post-intent', { gen });

  // ③ 隔离四项
  isolateAll(target, gen, names, Q, P);

  // ④ 重验四项全部到位，再置 isolated
  verifyIsolated(target, gen, names, Q, P, intent);
  intent.state = 'isolated';
  writeAtomic(Q.intent, stringify(intent));
  fp('repair:step4:post-isolated', {});

  // ⑤ 先登记 child，**然后**才创建那个新事务
  intent.child = { generation: childGen, tx_dir: `tx-${childGen}`, committed: false };
  intent.state = 'child_registered';
  writeAtomic(Q.intent, stringify(intent));
  fp('repair:step5:post-child-register', {});
  fp('repair:step5:pre-child-create', {});
  const childTx = join(Q.state, `tx-${childGen}`);
  mkdirChainFsync(join(childTx, 'stage'));

  // ⑥ child 完成 → child_done → done → 删 intent
  intent.child.committed = true;
  intent.state = 'child_done';
  writeAtomic(Q.intent, stringify(intent));
  fp('repair:step6:post-child-done', {});
  intent.state = 'done';
  writeAtomic(Q.intent, stringify(intent));
  fp('repair:step6:post-state-done', {});
  rmtreeFsync(Q.intent);
  fp('repair:step6:post-intent-removed', {});
  rmtreeFsync(childTx);
  return intent;
}

function isolateAll(target, gen, names, Q, P) {
  mkdirChainFsync(join(Q.quarantine, 'targets'));
  const qTx = join(Q.quarantine, `tx-${gen}`);
  const qJournal = join(Q.quarantine, `journal-${gen}.json`);

  fp('repair:step3:pre-isolate-tx', {});
  if (existsSync(P.tx) && !existsSync(qTx)) renameDirFsync(P.tx, qTx);
  fp('repair:step3:post-isolate-tx', {});

  if (existsSync(P.journal) && !existsSync(qJournal)) renameDirFsync(P.journal, qJournal);
  fp('repair:step3:post-isolate-journal', {});

  for (const n of names) {
    const from = join(target, n);
    const to = join(Q.quarantine, 'targets', n);
    if (existsSync(from) && !existsSync(to)) renameDirFsync(from, to);
  }
  fp('repair:step3:post-isolate-target', {});

  const led = readLedger(Q.ledger);
  if (led.transaction !== null) writeLedger({ ledger: Q.ledger }, { ...led, transaction: null });
  fp('repair:step3:post-clear-ledger-transaction', {});
}

/** §5.10：进入 isolated 之前必须重验四项全部到位，且四项属于**同一个事务** */
function verifyIsolated(target, gen, names, Q, P, intent) {
  const qTx = join(Q.quarantine, `tx-${gen}`);
  const qJournal = join(Q.quarantine, `journal-${gen}.json`);
  if (existsSync(P.tx)) throw new Corrupt('repair：tx 仍在原处');
  if (!existsSync(qTx)) throw new Corrupt('repair：tx 不在隔离位置');
  if (txDigest(qTx) !== intent.isolate.tx.fingerprint) throw new Corrupt('repair：tx 指纹不符');
  if (existsSync(P.journal)) throw new Corrupt('repair：journal 仍在原处');
  if (!existsSync(qJournal)) throw new Corrupt('repair：journal 不在隔离位置');
  if (sha256(readFileSync(qJournal)) !== intent.isolate.journal.digest) {
    throw new Corrupt('repair：journal 摘要不符');
  }
  for (const n of names) {
    const to = join(Q.quarantine, 'targets', n);
    if (existsSync(join(target, n))) throw new Corrupt(`repair：${n} 仍在原处`);
    if (treeDigest(to) !== intent.isolate.targets[n].observed) {
      throw new Corrupt(`repair：${n} 观测指纹不符`);
    }
  }
  if (readLedger(Q.ledger).transaction !== null) throw new Corrupt('repair：transaction 未清空');
  // 同事务绑定：三处的 generation 必须都等于 intent.generation
  const j = parseStrict(readFileSync(qJournal, 'utf8'));
  if (j.generation !== gen || j.tx_dir !== `tx-${gen}`) {
    throw new Corrupt('repair：journal 与 tx 不属于同一代');
  }
}

/** repair 的崩溃恢复：只按物理实况续做 */
export function recoverRepair(target) {
  const state = join(target, '.geoly');
  const intentPath = join(state, 'repair-intent.json');
  if (!existsSync(intentPath)) return { outcome: 'no-intent' };
  const intent = readIntent(intentPath);
  const gen = intent.generation;
  const P = layout(target, gen);
  const Q = repairPaths(target, gen);
  const names = Object.keys(intent.isolate.targets);

  isolateAll(target, gen, names, Q, P);
  verifyIsolated(target, gen, names, Q, P, intent);
  const next = { ...intent, state: 'isolated' };
  writeAtomic(Q.intent, stringify(next));

  const childGen = intent.child?.generation ?? gen + 1;
  next.child = { generation: childGen, tx_dir: `tx-${childGen}`, committed: true };
  next.state = 'child_done';
  writeAtomic(Q.intent, stringify(next));
  next.state = 'done';
  writeAtomic(Q.intent, stringify(next));
  rmtreeFsync(Q.intent);
  const childTx = join(state, `tx-${childGen}`);
  if (existsSync(childTx)) rmtreeFsync(childTx);
  return { outcome: 'repair-finished' };
}

/**
 * repair 的不变式：四项**要么在原处、要么在隔离位置，绝不两边都在、也绝不两边都没**。
 * 这是 §5.10 那张观测表的核心 —— 「两边都在 / 两边都不在」一律 corrupt。
 */
export function checkRepairInvariants(target, expect) {
  const { gen, names } = expect;
  const state = join(target, '.geoly');
  const intentPath = join(state, 'repair-intent.json');
  const P = layout(target, gen);
  const Q = repairPaths(target, gen);
  const qTx = join(Q.quarantine, `tx-${gen}`);
  const qJournal = join(Q.quarantine, `journal-${gen}.json`);

  // 🔴 「repair 到底开没开始」不能靠 intent 在不在判 —— 崩在写 intent 的原子写中途时
  //    intent 还没落盘，但那**不是**「修复已完成」。判据是 quarantine 目录链是否已建立。
  const started = existsSync(Q.quarantine);
  if (!started) {
    // 修复根本没开始：四项都该原封不动在原处
    if (!existsSync(P.tx) || !existsSync(P.journal)) {
      throw new Error('R0 违反：repair 尚未开始，原位置的 tx/journal 却已经不见了');
    }
    return;
  }

  const pairs = [
    ['tx', P.tx, qTx],
    ['journal', P.journal, qJournal],
    ...names.map((n) => [n, join(target, n), join(Q.quarantine, 'targets', n)]),
  ];
  for (const [what, orig, quar] of pairs) {
    const a = existsSync(orig), b = existsSync(quar);
    if (a && b) throw new Error(`R1 违反：${what} 在原处与隔离位置**同时存在**`);
    if (!a && !b) throw new Error(`R1 违反：${what} 在原处与隔离位置**都不存在**（内容丢了）`);
  }
  // intent 不在而 quarantine 在 = 修复已收尾，此时原位置不得再有半成品
  if (!existsSync(intentPath) && existsSync(P.tx)) {
    throw new Error('R2 违反：intent 已删，原位置却还有 tx —— 隔离没做完就收尾了');
  }
  const led = existsSync(Q.ledger) ? readLedger(Q.ledger) : null;
  if (led && !existsSync(intentPath) && led.transaction !== null) {
    throw new Error('R3 违反：修复完成而 ledger.transaction 仍非 null');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// audit archive intent（§4 audit plane 的四步）
// ════════════════════════════════════════════════════════════════════════════

export function auditPaths(target) {
  const state = join(target, '.geoly');
  return {
    state,
    ledger: join(state, 'ledger.json'),
    intent: join(state, 'audit-archive-intent.json'),
    archiveDir: join(state, 'audit-archive'),
  };
}

const batchDigest = (events) => sha256(stringify(events));

/** 归档 live audit 里按 event_id 升序的一个**前缀**（不是任意子集） */
export function runAuditArchive(target, keep) {
  const A = auditPaths(target);
  const led = readLedger(A.ledger);
  const live = [...(led.audit ?? [])].sort((a, b) => a.event_id - b.event_id);
  if (live.length <= keep) return { outcome: 'noop' }; // 🔴 空批次 no-op
  const batch = live.slice(0, live.length - keep);
  const seq = batch[batch.length - 1].event_id; // 🔴 seq = to_event
  const meta = {
    seq,
    from_event: batch[0].event_id,
    to_event: seq,
    batch_digest: batchDigest(batch),
  };

  // ① intent
  writeAtomic(A.intent, stringify({ schema: 'geoly.skills.audit-archive-intent/1', ...meta }));
  fp('audit-archive:step1:post-intent', { seq });

  finishAuditArchive(target, meta, batch);
  return { outcome: 'archived', seq };
}

function finishAuditArchive(target, meta, batchMaybe) {
  const A = auditPaths(target);
  const file = join(A.archiveDir, `${meta.seq}.json`);
  mkdirChainFsync(A.archiveDir);

  // ② 写 archive
  if (!existsSync(file)) {
    const batch = batchMaybe ?? sliceFromLedger(target, meta);
    writeAtomic(file, stringify({
      schema: 'geoly.skills.audit-archive/1',
      batch_digest: meta.batch_digest,
      events: batch,
      from_event: meta.from_event,
      seq: meta.seq,
      to_event: meta.to_event,
    }));
  }
  fp('audit-archive:step2:post-archive', { seq: meta.seq });

  // ②′ 🔴 正常路径也必须重验（v21 补的那一格）
  const got = parseStrict(readFileSync(file, 'utf8'));
  if (got.schema !== 'geoly.skills.audit-archive/1') throw new Corrupt('audit archive schema 不符');
  if (got.seq !== meta.seq || got.from_event !== meta.from_event || got.to_event !== meta.to_event) {
    throw new Corrupt('audit archive 的 seq/from/to 与 intent 不符');
  }
  if (batchDigest(got.events) !== meta.batch_digest) throw new Corrupt('audit archive batch_digest 不符');
  fp('audit-archive:step2:post-reverify', { seq: meta.seq });

  // ③ 账本 patch（幂等）
  const led = readLedger(A.ledger);
  const remaining = (led.audit ?? []).filter((e) => e.event_id > meta.to_event);
  if (remaining.length !== (led.audit ?? []).length || led.audit_archived_until !== meta.to_event) {
    writeLedger({ ledger: A.ledger }, {
      ...led, audit: remaining, audit_archived_until: meta.to_event,
    });
  }
  fp('audit-archive:step3:post-ledger-patch', { seq: meta.seq });

  // ④ 删 intent
  if (existsSync(A.intent)) rmtreeFsync(A.intent);
  fp('audit-archive:step4:post-intent-removed', { seq: meta.seq });
}

function sliceFromLedger(target, meta) {
  const led = readLedger(auditPaths(target).ledger);
  return (led.audit ?? [])
    .filter((e) => e.event_id >= meta.from_event && e.event_id <= meta.to_event)
    .sort((a, b) => a.event_id - b.event_id);
}

/** 🔴 §5.2 步骤 2a：先清 audit intent，**完成它或 fail-closed 停机，绝不跳过、绝不删除** */
export function recoverAuditArchive(target) {
  const A = auditPaths(target);
  if (!existsSync(A.intent)) return { outcome: 'no-intent' };
  const meta = parseStrict(readFileSync(A.intent, 'utf8'));
  finishAuditArchive(target, meta);
  return { outcome: 'audit-finished', seq: meta.seq };
}

/**
 * audit 的不变式：**只增不减**。
 * live ∪ archived 必须恰好等于原始事件全集，且 event_id 无重复、无空洞地被保住。
 */
export function checkAuditInvariants(target, allEvents) {
  const A = auditPaths(target);
  const led = readLedger(A.ledger);
  const seen = new Map();
  for (const e of led.audit ?? []) {
    if (seen.has(e.event_id)) throw new Error(`A1 违反：live 里 event_id ${e.event_id} 重复`);
    seen.set(e.event_id, stringify(e));
  }
  if (existsSync(A.archiveDir)) {
    for (const f of readdirSync(A.archiveDir).filter((n) => n.endsWith('.json'))) {
      const arc = parseStrict(readFileSync(join(A.archiveDir, f), 'utf8'));
      if (batchDigest(arc.events) !== arc.batch_digest) {
        throw new Error(`A2 违反：${f} 的 batch_digest 与内容不符`);
      }
      for (const e of arc.events) {
        if (seen.has(e.event_id)) throw new Error(`A1 违反：${e.event_id} 同时在 live 与 archive`);
        seen.set(e.event_id, stringify(e));
      }
    }
  }
  for (const e of allEvents) {
    const s = seen.get(e.event_id);
    if (s === undefined) throw new Error(`A3 违反：event ${e.event_id} 丢了（audit 只增不减）`);
    if (s !== stringify(e)) throw new Error(`A4 违反：event ${e.event_id} 内容被改过`);
  }
  // 🔴 cursor 只在 archive 已验证之后前进
  const until = led.audit_archived_until ?? 0;
  const archived = [...seen.keys()].filter((id) => !(led.audit ?? []).some((e) => e.event_id === id));
  const maxArchived = archived.length ? Math.max(...archived) : 0;
  if (until > maxArchived) {
    throw new Error(`A5 违反：audit_archived_until=${until} 超过了实际已归档的最大 id ${maxArchived}`);
  }
}

export { sha256 as _sha256 };

/** 造 N 条 audit 事件 */
export function makeEvents(n) {
  return Array.from({ length: n }, (_, i) => ({
    event_id: i + 1,
    kind: 'install',
    result: 'ok',
  }));
}

export function fsyncStateDir(target) {
  fsyncDir(join(target, '.geoly'));
}
