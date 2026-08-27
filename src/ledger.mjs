// ledger —— 账本 `geoly.skills.ledger/2`、generation 单调水位、audit plane。
//
// 规格：04-install.md §3.2（布局）、§4（schema 与 audit plane）、§4.1（水位）、
// §5.4.2（ledger_image 的 patch 语义与 bootstrap 协议）、§5.9（reset-generation）、
// 11-wire-contract.md §2/§3/§5。
//
// 🔴 本模块**不 import recover.mjs**。audit intent 的崩溃恢复以 `resumeAuditArchive()`
//    的形式暴露，由 recover 的 2a 调用 —— 反过来会形成循环依赖。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseStrict, stringify } from './canonical-json.mjs';
import { writeAtomic, mkdirChainFsync, rmtreeFsync, fsyncDir } from './atomic-fs.mjs';
import { fp } from './fault-inject.mjs';
import {
  Corrupt, bad, assertKeys, assertSafeName, isUint, isTreeDigest, readJsonStrict, validateAuditEvent,
} from './journal.mjs';

export const LEDGER_SCHEMA = 'geoly.skills.ledger/2';
export const AUDIT_ARCHIVE_SCHEMA = 'geoly.skills.audit-archive/1';
export const AUDIT_INTENT_SCHEMA = 'geoly.skills.audit-archive-intent/1';
export const ATTIC_MANIFEST_SCHEMA = 'geoly.skills.attic-manifest/1';
export const REPAIR_INTENT_SCHEMA = 'geoly.skills.repair-intent/1';

/** §4 的默认阈值 */
export const DEFAULT_AUDIT_MAX_ENTRIES = 1000;

const sha256 = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');
export { sha256 };

// ── 布局（§3.2）─────────────────────────────────────────────────────────────

/**
 * 全部 per-target 状态**跟着物理目录走**（§3.1）。
 * `gen === undefined` 时与代相关的字段为 null —— 调用方必须显式给代，
 * 而不是让实现去「猜当前是哪一代」。
 */
export function layout(target, gen) {
  const state = join(target, '.geoly');
  const g = gen === undefined ? null : String(gen);
  return {
    target,
    state,
    lock: join(state, 'lock.db'),
    generationFile: join(state, 'generation'),
    auditSeqFile: join(state, 'audit-seq'),
    ledger: join(state, 'ledger.json'),
    journalDir: join(state, 'journal'),
    journal: g === null ? null : join(state, 'journal', `${g}.json`),
    tx: g === null ? null : join(state, `tx-${g}`),
    stage: g === null ? null : join(state, `tx-${g}`, 'stage'),
    retired: g === null ? null : join(state, `tx-${g}`, 'retired'),
    undo: g === null ? null : join(state, `tx-${g}`, 'undo'),
    unpack: g === null ? null : join(state, `tx-${g}`, 'unpack'),
    atticDir: join(state, 'attic'),
    attic: g === null ? null : join(state, 'attic', g),
    quarantineDir: join(state, 'quarantine'),
    quarantine: g === null ? null : join(state, 'quarantine', g),
    repairIntent: join(state, 'repair-intent.json'),
    auditIntent: join(state, 'audit-archive-intent.json'),
    auditArchiveDir: join(state, 'audit-archive'),
  };
}

// ── 校验 ─────────────────────────────────────────────────────────────────────

function validateTargetMeta(t) {
  assertKeys(t, ['client', 'scope', 'path', 'realpath', 'fstype'], [], 'ledger.target');
  for (const k of ['client', 'scope', 'path', 'realpath', 'fstype']) {
    if (typeof t[k] !== 'string' || t[k] === '') bad(`ledger.target.${k} 必须是非空字符串`);
  }
  if (!['global', 'project'].includes(t.scope)) bad(`ledger.target.scope 未知取值 ${t.scope}`);
}

function validateIntent(i, where, { allowYanked }) {
  const opt = allowYanked ? ['allow_yanked'] : [];
  assertKeys(i, ['no_bundled', 'pre'], opt, where);
  for (const k of ['no_bundled', 'pre', ...opt]) {
    if (k in i && typeof i[k] !== 'boolean') bad(`${where}.${k} 必须是布尔`);
  }
}

function validateRoot(key, r) {
  const where = `ledger.roots[${key}]`;
  assertKeys(r, ['kind', 'snapshot', 'intent', 'requested_at'],
    ['artifact', 'tree_digest'], where);
  if (!['pack', 'direct', 'all'].includes(r.kind)) bad(`${where}.kind 未知取值 ${r.kind}`);
  if (!isUint(r.snapshot)) bad(`${where}.snapshot 必须是非负整数`);
  // ⚠️ 账本的 intent **保留** allow_yanked（它如实记录本机历史）；
  //    lockfile 的 intent 里没有它 —— 未签名文件不得授予该例外（§8.1）。
  validateIntent(r.intent, `${where}.intent`, { allowYanked: true });
  if (r.kind === 'all') {
    if ('artifact' in r || 'tree_digest' in r) bad(`${where}：all root 不带 artifact / tree_digest`);
  } else {
    if (typeof r.artifact !== 'string' || r.artifact === '') bad(`${where}.artifact 必填`);
    if (!isTreeDigest(r.tree_digest)) bad(`${where}.tree_digest 必须是树摘要`);
  }
}

function validateEntry(name, e) {
  const where = `ledger.entries[${name}]`;
  // 🔴 entry 的键 == 磁盘目录名，是所有权判定单位，也会进 join()
  assertSafeName(name, 'ledger.entries 的键');
  assertKeys(e,
    ['artifact', 'tree_digest', 'snapshot', 'installed_at', 'generation', 'state', 'requested_by'],
    [], where);
  if (typeof e.artifact !== 'string' || e.artifact === '') bad(`${where}.artifact 必填`);
  if (!isTreeDigest(e.tree_digest)) bad(`${where}.tree_digest 必须是树摘要`);
  if (!isUint(e.snapshot)) bad(`${where}.snapshot 必须是非负整数`);
  if (!isUint(e.generation)) bad(`${where}.generation 必须是非负整数`);
  if (!['ok', 'corrupt'].includes(e.state)) bad(`${where}.state 只能是 ok / corrupt`);
  if (!Array.isArray(e.requested_by)) bad(`${where}.requested_by 必须是数组`);
  let prev = null;
  for (const k of e.requested_by) {
    if (typeof k !== 'string' || k === '') bad(`${where}.requested_by 元素必须是非空字符串`);
    // 参与确定性：去重 + 字节序（§8.1 root key grammar 与唯一性）
    if (prev !== null && Buffer.compare(Buffer.from(prev), Buffer.from(k)) >= 0) {
      bad(`${where}.requested_by 必须按字节序严格升序且去重`);
    }
    prev = k;
  }
}

export function validateLedger(L) {
  assertKeys(L,
    ['schema', 'target', 'last_applied_generation', 'roots', 'entries',
      'audit', 'audit_archived_until', 'transaction'],
    ['cli_version', 'frozen_attic', 'history_unproven'],
    'ledger');
  if (L.schema !== LEDGER_SCHEMA) bad(`ledger.schema 必须是 ${LEDGER_SCHEMA}，得到 ${L.schema}`);
  validateTargetMeta(L.target);
  if (!isUint(L.last_applied_generation)) bad('ledger.last_applied_generation 必须是非负整数');
  for (const k of ['roots', 'entries']) {
    if (L[k] === null || typeof L[k] !== 'object' || Array.isArray(L[k])) bad(`ledger.${k} 必须是对象`);
  }
  for (const [k, v] of Object.entries(L.roots)) validateRoot(k, v);
  for (const [k, v] of Object.entries(L.entries)) validateEntry(k, v);
  if (!Array.isArray(L.audit)) bad('ledger.audit 必须是数组');
  let prevId = -1;
  for (const e of L.audit) {
    validateAuditEvent(e, 'ledger.audit[]');
    // live 流按 event_id 升序且唯一 —— 归档取的是「按 event_id 升序后的一个前缀」
    if (e.event_id <= prevId) bad(`ledger.audit 必须按 event_id 严格升序且唯一（${e.event_id}）`);
    prevId = e.event_id;
  }
  if (!isUint(L.audit_archived_until)) bad('ledger.audit_archived_until 必须是非负整数');
  // 🔴 live 流必须整体位于 cursor 之后 —— 否则 live 与 archive 会重叠（Codex 第二轮 #15）
  for (const e of L.audit) {
    if (e.event_id <= L.audit_archived_until) {
      bad(`ledger.audit：event_id ${e.event_id} 不大于 audit_archived_until ${L.audit_archived_until}`);
    }
  }
  if ('frozen_attic' in L) {
    const fa = L.frozen_attic;
    if (fa === null || typeof fa !== 'object' || Array.isArray(fa)) bad('ledger.frozen_attic 必须是对象');
    for (const [label, gens] of Object.entries(fa)) {
      if (!Array.isArray(gens) || !gens.every(isUint)) {
        bad(`ledger.frozen_attic[${label}] 必须是非负整数数组`);
      }
    }
  }
  if ('history_unproven' in L && L.history_unproven !== true) {
    bad('ledger.history_unproven 只允许 true（只增不撤）');
  }
  if (L.transaction !== null) {
    assertKeys(L.transaction, ['generation', 'tx_dir'], [], 'ledger.transaction');
    if (!isUint(L.transaction.generation)) bad('ledger.transaction.generation 必须是非负整数');
    if (L.transaction.tx_dir !== `tx-${L.transaction.generation}`) {
      bad('ledger.transaction.tx_dir 与 generation 不一致');
    }
  }
  return L;
}

export function readLedger(path) {
  return validateLedger(readJsonStrict(path, 'ledger'));
}

export function writeLedger(path, L) {
  validateLedger(L);
  writeAtomic(path, stringify(L));
  return L;
}

// ── generation 单调水位（§4.1）──────────────────────────────────────────────

/** 🔴 纯十进制整数，不是 JSON。前导零、负号、空白、非数字一律拒绝。 */
export function readGenerationWatermark(P) {
  if (!existsSync(P.generationFile)) return null;
  const raw = readFileSync(P.generationFile, 'utf8');
  if (!/^\d+$/.test(raw)) bad(`generation 水位文件内容非法：${JSON.stringify(raw)}`);
  if (raw.length > 1 && raw[0] === '0') bad(`generation 水位文件有前导零：${raw}`);
  const n = Number(raw);
  if (!isUint(n)) bad(`generation 水位越界：${raw}`);
  return n;
}

function writeWatermark(P, n) {
  if (!isUint(n)) bad(`generation 水位越界：${n}`);
  writeAtomic(P.generationFile, String(n));
}

/**
 * 🔴 §4.1：取新 generation = 读该文件 → `+1` → **先原子写回并 fsync，再使用**。
 *    绝不「先用后写」—— 崩在中间就会复用。
 */
export function nextGeneration(P) {
  const cur = readGenerationWatermark(P);
  if (cur === null) bad('generation 水位文件缺失，不得取号（见 §4.1 的降级语义与 --reset-generation）');
  const next = cur + 1;
  if (!Number.isSafeInteger(next)) bad('generation 水位已达 2^53-1，无法取号');
  writeWatermark(P, next);
  return next;
}

/**
 * §4.1：target 内是否已有 hub 管理的内容。
 * 🔴 **必须含 `quarantine/` 与 `repair-intent.json`** —— v14 只数了 attic 与账本。
 */
export function hasHubContent(P) {
  if (!existsSync(P.state)) return false;
  if (existsSync(P.ledger)) return true;
  if (existsSync(P.atticDir)) return true;
  if (existsSync(P.journalDir)) return true;
  if (existsSync(P.auditArchiveDir)) return true;
  if (existsSync(P.quarantineDir)) return true;
  if (existsSync(P.repairIntent)) return true;
  if (readdirSync(P.state).some((n) => /^tx-\d+$/.test(n))) return true;
  return false;
}

/**
 * §4.1 的降级语义：水位缺失时**不静默扫描猜一个**。
 * - target 内没有任何 hub 管理的内容 → 从 0 开始，正常；
 * - 已有内容而水位没了 → 拒绝初始化，要求 `--reset-generation <N>`。
 */
export function ensureGenerationWatermark(P) {
  const cur = readGenerationWatermark(P);
  if (cur !== null) return cur;
  if (hasHubContent(P)) {
    bad('本地历史被重置：`.geoly/generation` 缺失而 target 内已有 hub 管理的内容。'
      + '不静默扫描猜一个 —— 请用 `recover --reset-generation <N>`（§5.9）');
  }
  mkdirChainFsync(P.state);
  writeWatermark(P, 0);
  return 0;
}

/**
 * §5.9 `--reset-generation <N>`。契约里的每一条都是拒绝条件，缺一不可。
 * @param {object} P layout
 * @param {number} N 新水位
 */
export function resetGeneration(P, N) {
  if (!isUint(N)) bad('--reset-generation 的 <N> 必须是非负整数');
  if (!Number.isSafeInteger(N + 1)) bad('N + 1 超过 2^53-1');
  // 前置：仅当水位缺失时可用
  if (existsSync(P.generationFile)) bad('--reset-generation 仅当 `.geoly/generation` 缺失时可用');
  // 🔴 前置：ledger 必须存在且可解析，且**不得自动重建**
  if (!existsSync(P.ledger)) {
    bad('--reset-generation 拒绝：ledger.json 缺失。出路只有两条 ——'
      + '① 人工恢复**同一份一致的 `.geoly` 状态集**（ledger + journal + attic + audit 全套），'
      + '不是凭 archive 手工拼一个 ledger；② 移走**整个 target** 后重装（🔴 放弃本地 audit）');
  }
  const L = readLedger(P.ledger);
  // 拦截：未完成的事务 / 归档 / repair
  const blockers = [];
  if (existsSync(P.journalDir) && readdirSync(P.journalDir).some((n) => /^\d+\.json$/.test(n))) {
    blockers.push('journal/');
  }
  if (readdirSync(P.state).some((n) => /^tx-\d+$/.test(n))) blockers.push('tx-*');
  if (existsSync(P.auditIntent)) blockers.push('audit-archive-intent.json');
  if (existsSync(P.repairIntent)) blockers.push('repair-intent.json');
  if (blockers.length) bad(`--reset-generation 拒绝：存在未完成状态 ${blockers.join(' / ')}，请先 recover`);

  // <N> 必须高于**全部**可观察到的 generation
  const observed = observedGenerations(P, L);
  const maxObserved = observed.length ? Math.max(...observed) : 0;
  if (N <= maxObserved) {
    bad(`--reset-generation 拒绝：<N>=${N} 不高于可观察到的最大 generation ${maxObserved}`
      + `（观察到 ${observed.sort((a, b) => a - b).join(',')}）`);
  }

  // 🔴 顺序不可颠倒：先原子写并 fsync 标记，再写 generation 水位。
  //    先写水位、崩在标记之前，后续运行会看到水位却不知道历史不可证明。
  if (L.history_unproven !== true) writeLedger(P.ledger, { ...L, history_unproven: true });
  writeWatermark(P, N);
  return N;
}

/** §5.9：可观察的 generation 集合 —— 六个来源，一个都不能少 */
export function observedGenerations(P, L) {
  const out = [];
  const dirGens = (dir, re) => {
    if (!existsSync(dir)) return;
    for (const n of readdirSync(dir)) { const m = re.exec(n); if (m) out.push(Number(m[1])); }
  };
  dirGens(P.atticDir, /^(\d+)$/);
  dirGens(P.quarantineDir, /^(\d+)$/);
  dirGens(P.state, /^tx-(\d+)$/);
  if (existsSync(P.journalDir)) {
    for (const n of readdirSync(P.journalDir)) {
      const m = /^(\d+)\.json$/.exec(n);
      if (!m) continue;
      out.push(Number(m[1]));
      // 🔴 即使是 completed 的，也要参与下界计算；并且内部的 generation 也算
      try {
        const j = parseStrict(readFileSync(join(P.journalDir, n), 'utf8'));
        if (isUint(j.generation)) out.push(j.generation);
      } catch { /* 读不出来就只用文件名 —— 但绝不因此放低下界 */ }
    }
  }
  if (L) {
    out.push(L.last_applied_generation);
    for (const e of Object.values(L.entries)) out.push(e.generation);
    for (const gens of Object.values(L.frozen_attic ?? {})) out.push(...gens);
  }
  return out;
}

// ── audit-seq（§4 audit plane）───────────────────────────────────────────────

export function readAuditSeq(P) {
  if (!existsSync(P.auditSeqFile)) return null;
  const raw = readFileSync(P.auditSeqFile, 'utf8');
  if (!/^\d+$/.test(raw)) bad(`audit-seq 内容非法：${JSON.stringify(raw)}`);
  if (raw.length > 1 && raw[0] === '0') bad(`audit-seq 有前导零：${raw}`);
  return Number(raw);
}

/**
 * 🔴 分配顺序（§4）：在 target 锁下 ① 读 seq → ② `+1` 原子写回并 fsync → ③ 才把该 id
 *    用在事件上。②成功而后续失败 → **允许烧号**（号可以有洞，不可以重复）。
 */
export function allocEventId(P) {
  const cur = readAuditSeq(P);
  if (cur === null) bad('audit-seq 缺失：已有 ledger 时一律拒绝（§4 audit-seq 生命周期）');
  const next = cur + 1;
  if (next > Number.MAX_SAFE_INTEGER) bad('event_id 达到 2^53-1，拒绝追加；需要归档并人工处置');
  writeAtomic(P.auditSeqFile, String(next));
  return next;
}

// ── bootstrap（§5.4.2）──────────────────────────────────────────────────────

export function ledgerSkeleton(targetMeta) {
  return {
    schema: LEDGER_SCHEMA,
    audit: [],
    audit_archived_until: 0,
    entries: {},
    // 🔴 是 `last_applied_generation: 0`，**不是** `generation` —— 与水位同名会被
    //    重新诱导成「从账本取号」。
    last_applied_generation: 0,
    roots: {},
    target: targetMeta,
    transaction: null,
  };
}

/**
 * §5.4.2 bootstrap 协议：**先成功写出 ledger 骨架，再写 journal**；
 * 骨架与 `audit-seq` 是**两份各自原子的文件**，不是一次跨文件原子操作。
 *
 * ① 先写 `audit-seq = 0`（若尚不存在）→ fsync。
 *    🔴 已存在**合法** seq 时**沿用、绝不重置**（「无 ledger 但有 seq」是合法状态）。
 * ② 再写 ledger 骨架 → fsync。
 */
export function bootstrapLedger(P, targetMeta) {
  mkdirChainFsync(P.state);
  const seq = readAuditSeq(P);          // 非法会在这里 fail-closed
  if (seq === null) writeAtomic(P.auditSeqFile, '0');
  const L = ledgerSkeleton(targetMeta);
  writeLedger(P.ledger, L);
  return L;
}

/**
 * §4「bootstrap 不得删掉承载 audit 的账本」。
 * rollback 在 `ledger_existed = false` 时要删掉整个 ledger.json，
 * **例外**：存在任何 live audit / `audit-archive/` / audit intent / `audit_archived_until > 0`
 * → 不删，改写一份**例外账本**：🔴 只清空 `entries` / `roots` / `transaction`，
 * audit plane（live `audit` 与 `audit_archived_until`）**一律原样保留**。
 */
export function hasAuditEvidence(P, L) {
  if (L && Array.isArray(L.audit) && L.audit.length > 0) return true;
  if (L && (L.audit_archived_until ?? 0) > 0) return true;
  if (existsSync(P.auditIntent)) return true;
  if (existsSync(P.auditArchiveDir)
      && readdirSync(P.auditArchiveDir).some((n) => /^\d+\.json$/.test(n))) return true;
  return false;
}

export function dropOrExceptionLedger(P) {
  if (!existsSync(P.ledger)) return { action: 'already-absent' };
  const L = readLedger(P.ledger);
  if (!hasAuditEvidence(P, L)) {
    rmtreeFsync(P.ledger);
    return { action: 'removed' };
  }
  writeLedger(P.ledger, {
    ...L,
    entries: {},
    roots: {},
    transaction: null,
    // 🔴 audit plane 原样保留 —— **不是**照骨架的 `audit: [] / 0` 来写
  });
  return { action: 'exception-ledger' };
}

// ── ledger_image 的 patch 语义（§5.4.2）─────────────────────────────────────

/**
 * 🔴 「按 `post` 写」= 对这些键做**原子 patch**，**未列出的键一律保持不变**。
 *    不是整文件替换 —— 否则 journal 权威时重建不出完整账本。
 *
 * - `null` 哨兵 = 删除该键；
 * - `frozen_attic` **按整张 map 存取**（不是逐 label patch）；
 * - `transaction` **不进镜像**，由调用方按结果置；
 * - 取号水位永不进镜像。
 */
export function applyImageSide(L, side, { archiveDir } = {}) {
  const out = { ...L, entries: { ...L.entries }, roots: { ...L.roots } };
  for (const [k, v] of Object.entries(side.entries)) {
    if (v === null) delete out.entries[k]; else out.entries[k] = v;
  }
  for (const [k, v] of Object.entries(side.roots)) {
    if (v === null) delete out.roots[k]; else out.roots[k] = v;
  }
  out.last_applied_generation = side.last_applied_generation;
  if ('frozen_attic' in side) {
    if (side.frozen_attic === null) delete out.frozen_attic;
    else out.frozen_attic = side.frozen_attic;
  }
  if (side.audit_append) {
    out.audit = mergeAuditAppend(out.audit, side.audit_append,
      { archiveDir, archivedUntil: L.audit_archived_until ?? 0 });
  }
  return out;
}

/**
 * §4「audit 永不回退」的 `audit_append` 合并。**去重必须 fail-closed。**
 *
 * 🔴 校验顺序（v20 定死，避免实现歧义）：
 *   ① 先校验**已持久化的 live 流**自身唯一、且与 `audit-archive/` 不相交；
 *   ② 再校验 `audit_append` **批内**唯一；
 *   ③ 最后逐条合并。
 * **不得把 replay 的候选先算成「live 内重复」。**
 */
export function mergeAuditAppend(live, append, { archiveDir, archivedUntil = 0 } = {}) {
  // ①
  const liveById = new Map();
  for (const e of live) {
    if (liveById.has(e.event_id)) bad(`audit：live 流内 event_id ${e.event_id} 重复`);
    liveById.set(e.event_id, stringify(e));
  }
  const archived = archiveDir ? readArchivedIds(archiveDir) : new Map();
  for (const id of liveById.keys()) {
    if (archived.has(id)) bad(`audit：event_id ${id} 同时在 live 与 audit-archive/`);
  }
  // ②
  const batch = new Map();
  for (const e of append) {
    validateAuditEvent(e, 'audit_append[]');
    // 🔴 新事件的 id 必须严格大于 cursor —— 否则 live 会与 archive 重叠、序列回退
    //    （Codex 第二轮 #15）
    if (e.event_id <= archivedUntil) {
      bad(`audit_append：event_id ${e.event_id} 不大于 audit_archived_until ${archivedUntil}`);
    }
    const s = stringify(e);
    if (batch.has(e.event_id)) {
      bad(`audit_append 批内 event_id ${e.event_id} 重复`);
    }
    batch.set(e.event_id, s);
  }
  // ③
  const out = [...live];
  for (const [id, s] of batch) {
    if (liveById.has(id)) {
      // 同 id 且 canonical 字节完全相同 → no-op（journal 重放的正常情形）
      if (liveById.get(id) !== s) bad(`audit：event_id ${id} 已存在但内容不同（fail-closed）`);
      continue;
    }
    if (archived.has(id)) {
      // 归档只发生在 journal 完成之后，replay 正常撞不到 archive
      if (archived.get(id) !== s) bad(`audit：event_id ${id} 与已归档事件冲突`);
      continue;
    }
    out.push(parseStrict(s));
  }
  out.sort((a, b) => a.event_id - b.event_id);
  return out;
}

/**
 * 🔴 读归档时**做完整 schema 校验**，不是「JSON 能 parse 就当证据」（Codex 第二轮 #14）。
 *    这些 id 会参与 audit_append 的去重判定 —— 一份损坏或伪造的归档不能进那道判定。
 */
function readArchivedIds(archiveDir) {
  const m = new Map();
  if (!existsSync(archiveDir)) return m;
  for (const n of readdirSync(archiveDir)) {
    if (!/^\d+\.json$/.test(n)) continue;
    const seq = Number(n.slice(0, -5));
    const arc = readJsonStrict(join(archiveDir, n), 'audit-archive');
    // 🔴 文件名与 seq 必须一致 —— 否则可以拿一份合法归档改个文件名来顶替另一批
    verifyArchiveFile(join(archiveDir, n), {
      batch_digest: arc.batch_digest, from_event: arc.from_event, seq, to_event: arc.to_event,
    });
    for (const e of arc.events) {
      if (m.has(e.event_id)) bad(`audit-archive：event_id ${e.event_id} 在归档间重复`);
      m.set(e.event_id, stringify(e));
    }
  }
  return m;
}

// ── audit 归档小事务（§4 的四步）─────────────────────────────────────────────

/** 🔴 `batch_digest` = 对 `events` 数组按 §11 canonical 序列化后的**原始字节**求 sha256 */
export const batchDigest = (events) => sha256(Buffer.from(stringify(events), 'utf8'));

function validateArchiveIntent(o) {
  assertKeys(o, ['schema', 'seq', 'from_event', 'to_event', 'batch_digest'], [], 'audit-archive-intent');
  if (o.schema !== AUDIT_INTENT_SCHEMA) bad(`audit-archive-intent.schema 必须是 ${AUDIT_INTENT_SCHEMA}`);
  for (const k of ['seq', 'from_event', 'to_event']) if (!isUint(o[k])) bad(`audit-archive-intent.${k} 必须是非负整数`);
  // 🔴 `seq = to_event`（不再单独分配，天然唯一且单调）
  if (o.seq !== o.to_event) bad('audit-archive-intent：seq 必须等于 to_event');
  if (o.from_event > o.to_event) bad('audit-archive-intent：from_event > to_event');
  if (typeof o.batch_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(o.batch_digest)) {
    bad('audit-archive-intent.batch_digest 形式非法');
  }
  return o;
}

/**
 * §4「阈值归档」：live 事件数 `== audit_max_entries` **不归档**；`>` 才归档，归档到 `== max`。
 * 归档前缀必须非空 —— 空前缀不写任何文件、不动 cursor（空批次 no-op）。
 *
 * 🔴 调用点由 §5.2 的步骤 **2c** 决定（「已确认无未完成安装事务之后」）；
 *    本函数不判断那件事，判断它的是 recover.mjs。
 */
export function maybeArchiveAudit(P, { maxEntries = DEFAULT_AUDIT_MAX_ENTRIES } = {}) {
  if (!existsSync(P.ledger)) return { outcome: 'noop' };
  const L = readLedger(P.ledger);
  const live = L.audit;
  if (live.length <= maxEntries) return { outcome: 'noop' };
  const batch = live.slice(0, live.length - maxEntries);
  if (batch.length === 0) return { outcome: 'noop' };
  const meta = {
    schema: AUDIT_INTENT_SCHEMA,
    batch_digest: batchDigest(batch),
    from_event: batch[0].event_id,
    seq: batch[batch.length - 1].event_id,
    to_event: batch[batch.length - 1].event_id,
  };
  // ① 写 intent → fsync
  writeAtomic(P.auditIntent, stringify(meta));
  fp('audit-archive:step1:post-intent', { seq: meta.seq });
  finishAuditArchive(P, meta, batch);
  return { outcome: 'archived', seq: meta.seq };
}

/**
 * ②②′③④。**幂等**，正常路径与崩溃恢复走**同一段**重验（§4 的 ②′）。
 */
function finishAuditArchive(P, meta, batchMaybe) {
  const file = join(P.auditArchiveDir, `${meta.seq}.json`);
  mkdirChainFsync(P.auditArchiveDir);

  // ② 写 archive。🔴 已存在时**绝不覆盖** —— 只重验。
  if (!existsSync(file)) {
    const batch = batchMaybe ?? sliceLiveForMeta(P, meta);
    writeAtomic(file, stringify({
      schema: AUDIT_ARCHIVE_SCHEMA,
      batch_digest: meta.batch_digest,
      events: batch,
      from_event: meta.from_event,
      seq: meta.seq,
      to_event: meta.to_event,
    }));
  }
  fp('audit-archive:step2:post-archive', { seq: meta.seq });

  // ②′ 🔴 **正常路径也必须重验**：重新打开，严格校验 schema、seq、范围、完整性与 batch_digest
  verifyArchiveFile(file, meta);
  fp('audit-archive:step2:post-reverify', { seq: meta.seq });

  // ③ 账本 patch：移除该前缀、置 audit_archived_until = to_event（幂等）
  const L = readLedger(P.ledger);
  // 🔴 归档的批次必须**与当前 live 前缀逐字节对应**（Codex 第三轮 #4）：
  //    只验归档自身、然后按 event_id 把 live 里的删掉，会在「live 在中间被改写」时
  //    把改写过的那一版**丢掉**而毫无察觉。audit 只增不减，这里必须 fail-closed。
  {
    const arc = readJsonStrict(file, 'audit-archive');
    const byId = new Map(arc.events.map((e) => [e.event_id, stringify(e)]));
    for (const e of L.audit) {
      if (e.event_id > meta.to_event) continue;
      const want = byId.get(e.event_id);
      if (want === undefined) bad(`audit 归档：live 里的 event_id ${e.event_id} 不在归档批次内`);
      if (want !== stringify(e)) bad(`audit 归档：live 里的 event_id ${e.event_id} 与归档内容不同，停机`);
    }
  }
  // 🔴 cursor **只前进**：当前值已经大于目标值时把它写小就是回退（Codex 第二轮 #13）
  if (L.audit_archived_until > meta.to_event) {
    bad(`audit cursor 只前进：当前 ${L.audit_archived_until} > 本批 to_event ${meta.to_event}，停机`);
  }
  const remaining = L.audit.filter((e) => e.event_id > meta.to_event);
  if (remaining.length !== L.audit.length || L.audit_archived_until !== meta.to_event) {
    writeLedger(P.ledger, { ...L, audit: remaining, audit_archived_until: meta.to_event });
  }
  fp('audit-archive:step3:post-ledger-patch', { seq: meta.seq });

  // ④ 删 intent → fsync 父目录
  if (existsSync(P.auditIntent)) rmtreeFsync(P.auditIntent);
  fp('audit-archive:step4:post-intent-removed', { seq: meta.seq });
}

function verifyArchiveFile(file, meta) {
  const got = readJsonStrict(file, 'audit-archive');
  assertKeys(got, ['schema', 'seq', 'from_event', 'to_event', 'events', 'batch_digest'], [], 'audit-archive');
  if (got.schema !== AUDIT_ARCHIVE_SCHEMA) bad(`audit-archive.schema 不符：${got.schema}`);
  if (got.seq !== meta.seq || got.from_event !== meta.from_event || got.to_event !== meta.to_event) {
    bad('audit-archive 的 seq / from_event / to_event 与 intent 不符');
  }
  if (!Array.isArray(got.events) || got.events.length === 0) bad('audit-archive.events 必须是非空数组');
  let prev = -1;
  for (const e of got.events) {
    validateAuditEvent(e, 'audit-archive.events[]');
    if (e.event_id <= prev) bad('audit-archive.events 必须按 event_id 严格升序');
    prev = e.event_id;
  }
  if (got.events[0].event_id !== got.from_event) bad('audit-archive：首个 event_id 与 from_event 不符');
  if (prev !== got.to_event) bad('audit-archive：末个 event_id 与 to_event 不符');
  // 🔴 §4：`seq = to_event`（不单独分配）—— 读历史归档时也要断言，不只在写的时候
  if (got.seq !== got.to_event) bad('audit-archive：seq 必须等于 to_event');
  if (batchDigest(got.events) !== meta.batch_digest) bad('audit-archive.batch_digest 与内容不符');
  return got;
}

function sliceLiveForMeta(P, meta) {
  const L = readLedger(P.ledger);
  const batch = L.audit.filter((e) => e.event_id >= meta.from_event && e.event_id <= meta.to_event);
  if (batch.length === 0) bad('audit intent 指向的批次在 live 流里已不存在，且 archive 文件也不在');
  return batch;
}

/**
 * 🔴 §5.2 步骤 **2a**：先清 audit intent。存在 → 按归档协议**完成它，或 fail-closed 停机**。
 *    **绝不跳过、绝不删除。**
 */
export function resumeAuditArchive(P) {
  if (!existsSync(P.auditIntent)) return { outcome: 'no-intent' };
  const meta = validateArchiveIntent(readJsonStrict(P.auditIntent, 'audit-archive-intent'));
  finishAuditArchive(P, meta);
  return { outcome: 'audit-finished', seq: meta.seq };
}

/** 供上层在动 attic 之前判断某代是否被冻结（§5.8 `--freeze-attic`）*/
export function isGenerationFrozen(L, gen) {
  for (const gens of Object.values(L.frozen_attic ?? {})) if (gens.includes(gen)) return true;
  return false;
}

export function fsyncState(P) {
  if (existsSync(P.state)) fsyncDir(P.state);
}

export { Corrupt };
