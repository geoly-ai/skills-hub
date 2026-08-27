// ledger / generation 水位 / audit plane 的单元测试。
//
// 重点在规范里那几条「一旦实现错了就丢数据或复用号」的规则：
// 水位的降级语义、bootstrap 的两份文件、ledger_image 的 patch（不是替换）、
// audit 只增不减与 fail-closed 去重、归档四步的幂等与重验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from '../src/canonical-json.mjs';
import {
  applyImageSide, batchDigest, bootstrapLedger, dropOrExceptionLedger, ensureGenerationWatermark,
  hasHubContent, layout, ledgerSkeleton, maybeArchiveAudit, mergeAuditAppend, nextGeneration,
  observedGenerations, readAuditSeq, readGenerationWatermark, readLedger, resetGeneration,
  resumeAuditArchive, validateLedger, writeLedger, allocEventId,
} from '../src/ledger.mjs';

const D = (c) => `geoly-tree-v1:sha256:${String(c).repeat(64).slice(0, 64)}`;
const AT = '2026-08-26T00:00:00Z';
const META = (p) => ({ client: 'claude', fstype: 'apfs', path: p, realpath: p, scope: 'global' });

function fresh() {
  const base = mkdtempSync(join(tmpdir(), 'kl-'));
  const target = join(base, 'skills');
  mkdirSync(target, { recursive: true, mode: 0o755 });
  return { base, target, P: layout(target) };
}
const drop = (b) => rmSync(b, { recursive: true, force: true });
const ev = (id, name = 'x') => ({ at: AT, event_id: id, kind: 'installed-yanked', subject: { kind: 'entry', name } });

// ── generation 水位 ─────────────────────────────────────────────────────────

test('🔴 水位：先原子写回再使用，绝不「先用后写」', () => {
  const { base, P } = fresh();
  try {
    assert.equal(ensureGenerationWatermark(P), 0);
    assert.equal(nextGeneration(P), 1);
    assert.equal(readGenerationWatermark(P), 1);   // 已经落盘
    assert.equal(nextGeneration(P), 2);
  } finally { drop(base); }
});

test('🔴 水位文件内容必须是纯十进制、无前导零', () => {
  const { base, P } = fresh();
  try {
    mkdirSync(P.state, { recursive: true, mode: 0o755 });
    writeFileSync(P.generationFile, '007');
    assert.throws(() => readGenerationWatermark(P), /前导零/);
    writeFileSync(P.generationFile, '3\n');
    assert.throws(() => readGenerationWatermark(P), /非法/);
  } finally { drop(base); }
});

test('🔴 水位缺失的降级语义：有 hub 内容就拒绝初始化，不静默扫描猜一个', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    rmSync(P.generationFile);
    assert.ok(hasHubContent(P));
    assert.throws(() => ensureGenerationWatermark(P), /本地历史被重置/);
  } finally { drop(base); }
});

test('🔴 quarantine / repair-intent 也算「已有 hub 内容」（v14 漏了这两处）', () => {
  const { base, P } = fresh();
  try {
    mkdirSync(join(P.quarantineDir, '3'), { recursive: true, mode: 0o755 });
    assert.ok(hasHubContent(P), 'quarantine/ 必须算');
  } finally { drop(base); }
});

test('🔴 --reset-generation：ledger 缺失一律拒绝，且不得自动重建', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    rmSync(P.generationFile);
    rmSync(P.ledger);
    assert.throws(() => resetGeneration(P, 99), /ledger\.json 缺失/);
    assert.ok(!existsSync(P.ledger), '拒绝之后不得自动重建 ledger');
  } finally { drop(base); }
});

test('🔴 --reset-generation：<N> 必须高于**全部**可观察 generation，含 quarantine 与 journal 文件名', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    mkdirSync(join(P.quarantineDir, '42'), { recursive: true, mode: 0o755 });
    mkdirSync(P.atticDir, { recursive: true, mode: 0o755 });
    mkdirSync(join(P.atticDir, '5'), { recursive: true, mode: 0o755 });
    rmSync(P.generationFile);
    const L = readLedger(P.ledger);
    assert.ok(observedGenerations(P, L).includes(42), '可观察集合必须含 quarantine/<gen>');
    assert.throws(() => resetGeneration(P, 42), /不高于可观察到的最大 generation 42/);
    assert.equal(resetGeneration(P, 43), 43);
    // 🔴 顺序：先标记再水位 —— 标记只增不撤
    assert.equal(readLedger(P.ledger).history_unproven, true);
    assert.equal(readGenerationWatermark(P), 43);
    assert.throws(() => resetGeneration(P, 44), /仅当/);
  } finally { drop(base); }
});

test('🔴 --reset-generation：存在未完成状态时先拒绝', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    rmSync(P.generationFile);
    writeFileSync(P.repairIntent, '{}');
    assert.throws(() => resetGeneration(P, 99), /未完成状态/);
  } finally { drop(base); }
});

// ── bootstrap ───────────────────────────────────────────────────────────────

test('🔴 bootstrap：audit-seq 先写、账本骨架后写；已有合法 seq 一律沿用绝不重置', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    assert.equal(readAuditSeq(P), 0);
    assert.equal(allocEventId(P), 1);
    assert.equal(allocEventId(P), 2);
    // 「无 ledger 但有 seq」是**合法状态**（pre-commit 清理只删骨架、不删 seq）
    rmSync(P.ledger);
    bootstrapLedger(P, META(target));
    assert.equal(readAuditSeq(P), 2, '🔴 沿用该 seq，绝不重置为 0');
  } finally { drop(base); }
});

test('🔴 已有 ledger 而 seq 缺失或非法 → 一律拒绝分配', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    rmSync(P.auditSeqFile);
    assert.throws(() => allocEventId(P), /audit-seq 缺失/);
    writeFileSync(P.auditSeqFile, 'abc');
    assert.throws(() => allocEventId(P), /内容非法/);
  } finally { drop(base); }
});

test('🔴 bootstrap 骨架用 last_applied_generation 而不是 generation（防被诱导成从账本取号）', () => {
  const sk = ledgerSkeleton(META('/x'));
  assert.equal(sk.last_applied_generation, 0);
  assert.ok(!('generation' in sk));
  assert.equal(sk.transaction, null);
  assert.deepEqual(sk.audit, []);
  assert.equal(sk.audit_archived_until, 0);
});

// ── ledger_image 的 patch 语义 ──────────────────────────────────────────────

test('🔴 「按 post 写」是 patch，不是整文件替换 —— 未列出的键必须保持不变', () => {
  const L = {
    ...ledgerSkeleton(META('/x')),
    entries: {
      keep: { artifact: 'skill:g/keep@1', generation: 1, installed_at: AT, requested_by: [], snapshot: 1, state: 'ok', tree_digest: D('a') },
      gone: { artifact: 'skill:g/gone@1', generation: 1, installed_at: AT, requested_by: [], snapshot: 1, state: 'ok', tree_digest: D('b') },
    },
  };
  const next = applyImageSide(L, {
    entries: { gone: null, added: { artifact: 'skill:g/added@1', generation: 2, installed_at: AT, requested_by: [], snapshot: 1, state: 'ok', tree_digest: D('c') } },
    last_applied_generation: 2,
    roots: {},
  });
  assert.deepEqual(Object.keys(next.entries).sort(), ['added', 'keep']);
  assert.equal(next.entries.keep.tree_digest, D('a'), '🔴 未列出的键被动了 = patch 实现成了替换');
  assert.equal(next.last_applied_generation, 2);
});

test('🔴 frozen_attic 按整张 map 存取（不是逐 label patch）', () => {
  const L = { ...ledgerSkeleton(META('/x')), frozen_attic: { alpha: [1], beta: [2] } };
  const next = applyImageSide(L, { entries: {}, frozen_attic: { alpha: [1, 3] }, last_applied_generation: 2, roots: {} });
  assert.deepEqual(next.frozen_attic, { alpha: [1, 3] });
  const gone = applyImageSide(L, { entries: {}, frozen_attic: null, last_applied_generation: 2, roots: {} });
  assert.ok(!('frozen_attic' in gone));
});

// ── audit plane ─────────────────────────────────────────────────────────────

test('🔴 audit_append 的去重必须 fail-closed：同 id 同字节 no-op，同 id 异内容停机', () => {
  const live = [ev(1), ev(2)];
  assert.deepEqual(mergeAuditAppend(live, [ev(2)]).map((e) => e.event_id), [1, 2], '同字节应当 no-op');
  assert.throws(() => mergeAuditAppend(live, [{ ...ev(2), note: '改过' }]), /内容不同/);
  assert.throws(() => mergeAuditAppend(live, [ev(3), ev(3)]), /批内 event_id 3 重复/);
  assert.throws(() => mergeAuditAppend([ev(1), ev(1)], [ev(2)]), /live 流内 event_id 1 重复/);
});

test('🔴 归档：阈值边界 == 不归档、> 才归档；seq = to_event；空批次 no-op', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    writeLedger(P.ledger, { ...readLedger(P.ledger), audit: [ev(1), ev(2), ev(3)] });
    assert.equal(maybeArchiveAudit(P, { maxEntries: 3 }).outcome, 'noop', '== max 不归档');
    const r = maybeArchiveAudit(P, { maxEntries: 2 });
    assert.equal(r.outcome, 'archived');
    assert.equal(r.seq, 1);
    const arc = JSON.parse(readFileSync(join(P.auditArchiveDir, '1.json'), 'utf8'));
    assert.equal(arc.seq, arc.to_event);
    assert.equal(arc.batch_digest, batchDigest(arc.events));
    const L = readLedger(P.ledger);
    assert.deepEqual(L.audit.map((e) => e.event_id), [2, 3]);
    assert.equal(L.audit_archived_until, 1);
    assert.equal(resumeAuditArchive(P).outcome, 'no-intent');
  } finally { drop(base); }
});

test('🔴 归档恢复：<seq>.json 已存在时必须重验、**绝不覆盖**，不符即 fail-closed', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    writeLedger(P.ledger, { ...readLedger(P.ledger), audit: [ev(1), ev(2), ev(3)] });
    // 手工造一个「崩在 ② 之后」的现场：intent 在、archive 文件在但内容被改过
    const meta = {
      schema: 'geoly.skills.audit-archive-intent/1',
      batch_digest: batchDigest([ev(1)]), from_event: 1, seq: 1, to_event: 1,
    };
    writeFileSync(P.auditIntent, stringify(meta));
    mkdirSync(P.auditArchiveDir, { recursive: true, mode: 0o755 });
    writeFileSync(join(P.auditArchiveDir, '1.json'), stringify({
      schema: 'geoly.skills.audit-archive/1',
      batch_digest: meta.batch_digest, events: [ev(1, '被改过')], from_event: 1, seq: 1, to_event: 1,
    }));
    assert.throws(() => resumeAuditArchive(P), /batch_digest 与内容不符/);
    // 🔴 fail-closed 之后 intent 与 archive 都必须原封不动
    assert.ok(existsSync(P.auditIntent));
    assert.equal(readLedger(P.ledger).audit.length, 3);
  } finally { drop(base); }
});

test('🔴 归档恢复：内容相符时是幂等续做（③ 是幂等 patch，④ 删 intent）', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    writeLedger(P.ledger, { ...readLedger(P.ledger), audit: [ev(1), ev(2), ev(3)] });
    const meta = {
      schema: 'geoly.skills.audit-archive-intent/1',
      batch_digest: batchDigest([ev(1)]), from_event: 1, seq: 1, to_event: 1,
    };
    writeFileSync(P.auditIntent, stringify(meta));
    const r = resumeAuditArchive(P);
    assert.equal(r.outcome, 'audit-finished');
    assert.ok(!existsSync(P.auditIntent));
    assert.deepEqual(readLedger(P.ledger).audit.map((e) => e.event_id), [2, 3]);
    assert.equal(readLedger(P.ledger).audit_archived_until, 1);
  } finally { drop(base); }
});

test('🔴 bootstrap rollback 不得删掉承载 audit 的账本，改写例外账本且 audit plane 原样保留', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    // 没有任何 audit 证据 → 删库
    assert.equal(dropOrExceptionLedger(P).action, 'removed');
    assert.ok(!existsSync(P.ledger));
    // 有 live audit → 例外账本
    bootstrapLedger(P, META(target));
    writeLedger(P.ledger, {
      ...readLedger(P.ledger),
      audit: [ev(7)],
      audit_archived_until: 3,
      entries: { a: { artifact: 'skill:g/a@1', generation: 1, installed_at: AT, requested_by: [], snapshot: 1, state: 'ok', tree_digest: D('a') } },
    });
    assert.equal(dropOrExceptionLedger(P).action, 'exception-ledger');
    const L = readLedger(P.ledger);
    assert.deepEqual(L.entries, {});
    assert.deepEqual(L.roots, {});
    assert.equal(L.transaction, null);
    assert.deepEqual(L.audit.map((e) => e.event_id), [7], '🔴 audit plane 必须原样保留，不能照骨架重置');
    assert.equal(L.audit_archived_until, 3);
  } finally { drop(base); }
});

// ── schema ──────────────────────────────────────────────────────────────────

test('🔴 ledger 的未知字段、错 schema、乱序 requested_by 一律拒绝', () => {
  const sk = ledgerSkeleton(META('/x'));
  assert.throws(() => validateLedger({ ...sk, 未来: 1 }), /未知字段/);
  assert.throws(() => validateLedger({ ...sk, schema: 'geoly.skills.ledger/3' }), /schema/);
  assert.throws(() => validateLedger({
    ...sk,
    entries: { a: { artifact: 'skill:g/a@1', generation: 1, installed_at: AT, requested_by: ['b', 'a'], snapshot: 1, state: 'ok', tree_digest: D('a') } },
  }), /字节序严格升序/);
  assert.throws(() => validateLedger({ ...sk, audit: [ev(2), ev(1)] }), /严格升序/);
});

// ── cursor 只前进 / live 与 archive 不重叠（Codex 第二轮 #13 #15）────────────

test('🔴 audit cursor 只前进：intent 的 to_event 低于当前 cursor 时必须停机，不许把它写小', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    // 现场：cursor 已经到 5，却出现一份 to_event = 3 的旧 intent（乱序 / 人为放回）
    writeLedger(P.ledger, { ...readLedger(P.ledger), audit: [ev(6)], audit_archived_until: 5 });
    mkdirSync(P.auditArchiveDir, { recursive: true, mode: 0o755 });
    writeFileSync(join(P.auditArchiveDir, '3.json'), stringify({
      schema: 'geoly.skills.audit-archive/1',
      batch_digest: batchDigest([ev(3)]), events: [ev(3)], from_event: 3, seq: 3, to_event: 3,
    }));
    writeFileSync(P.auditIntent, stringify({
      schema: 'geoly.skills.audit-archive-intent/1',
      batch_digest: batchDigest([ev(3)]), from_event: 3, seq: 3, to_event: 3,
    }));
    assert.throws(() => resumeAuditArchive(P), /cursor 只前进/);
    assert.equal(readLedger(P.ledger).audit_archived_until, 5, '🔴 cursor 被写小了 = 审计序列回退');
  } finally { drop(base); }
});

test('🔴 audit_append 不得追加 event_id <= cursor 的事件（否则 live 与 archive 重叠）', () => {
  assert.throws(() => mergeAuditAppend([ev(6)], [ev(4)], { archivedUntil: 5 }),
    /不大于 audit_archived_until/);
  assert.deepEqual(mergeAuditAppend([ev(6)], [ev(7)], { archivedUntil: 5 }).map((e) => e.event_id), [6, 7]);
});

test('🔴 账本自身也要保证 live 流整体位于 cursor 之后', () => {
  const sk = ledgerSkeleton(META('/x'));
  assert.throws(() => validateLedger({ ...sk, audit: [ev(3)], audit_archived_until: 5 }),
    /不大于 audit_archived_until/);
});

test('🔴 归档文件的 schema 校验参与去重判定：文件名与 seq 不符的归档必须被拒', () => {
  const { base, target, P } = fresh();
  try {
    ensureGenerationWatermark(P);
    bootstrapLedger(P, META(target));
    mkdirSync(P.auditArchiveDir, { recursive: true, mode: 0o755 });
    // 一份内容自洽、但文件名与 seq 不一致的归档 —— 可以用来顶替另一批
    writeFileSync(join(P.auditArchiveDir, '9.json'), stringify({
      schema: 'geoly.skills.audit-archive/1',
      batch_digest: batchDigest([ev(3)]), events: [ev(3)], from_event: 3, seq: 3, to_event: 3,
    }));
    assert.throws(
      () => mergeAuditAppend([], [ev(10)], { archiveDir: P.auditArchiveDir }),
      /seq \/ from_event \/ to_event 与 intent 不符/,
    );
  } finally { drop(base); }
});

test('🔴 audit 事件的 kind 是封闭枚举，advisory「没有就缺席」且形如 GSA-', () => {
  const sk = ledgerSkeleton(META('/x'));
  assert.throws(() => validateLedger({ ...sk, audit: [{ ...ev(1), kind: '随便写' }] }), /kind 未知取值/);
  assert.throws(() => validateLedger({ ...sk, audit: [{ ...ev(1), advisory: null }] }), /advisory/);
  assert.throws(() => validateLedger({ ...sk, audit: [{ ...ev(1), advisory: 'CVE-1' }] }), /GSA-/);
  assert.ok(validateLedger({ ...sk, audit: [{ ...ev(1), advisory: 'GSA-2026-1' }] }));
});
