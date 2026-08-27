// recover —— §5.2 第 2 步的分流、§5.4 幂等前向续做、§5.4.1 rollback、
// §5.8 `--from-generation` 的复位、§5.10 `--reinstall` 的 repair intent 状态机。
//
// 规格：04-install.md §5.2（十步的第 2 步：2a → 2b-1 → 2b-2 → 2c）、§5.4、§5.4.1、
// §5.4.2（双文件规则）、§5.5、§5.6、§5.8 / §5.8.1、§5.10；09-cli.md §1.1。
//
// 🔴 三条已经被踩过的坑，本模块处处遵守：
//   · **绝不从正向 `item.state` 推断物理位置** —— 入场一律实测 T/R/S/A（§5.4.1 v35 铁律）；
//   · **「文件在不在」永远不是判据** —— attic 是否算恢复源要**重算内容**；
//   · **预检不保证世界不会变** —— 每个动作点自己复验并 fail-closed（R-3）。

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from './canonical-json.mjs';
import { treeDigest, txDigest } from './tree-digest.mjs';
import { writeAtomic, mkdirChainFsync, renameDirFsync, rmtreeFsync } from './atomic-fs.mjs';
import { fp } from './fault-inject.mjs';
import {
  Corrupt, bad, readJournal, writeJournal, sweepTmp, listJournalGenerations,
  assertConsistent, allItemKeys, readJsonStrict, assertKeys, assertSafeName, isUint, isTreeDigest, isTxDigest,
} from './journal.mjs';
import {
  layout, readLedger, writeLedger, applyImageSide, resumeAuditArchive, maybeArchiveAudit,
  dropOrExceptionLedger, sha256, nextGeneration, REPAIR_INTENT_SCHEMA,
  DEFAULT_AUDIT_MAX_ENTRIES,
} from './ledger.mjs';
import {
  applyItems, verifyAndCommit, runCleanup, idempotentRenameDir, verifyArchive, restoreArchive,
  commitPoint, stageTrees, nowUtc, isPartialOrAbsent, assertLockfileHook, runLockfileRecalc,
} from './install.mjs';
import {
  validateManifest, comparePostimage, REVERSE_OP, strictlyMatches,
} from './plan.mjs';

export { Corrupt };

/**
 * 「有残留事务，需要人来选方向」不是 corrupt —— 退出码 5，措辞是提示不是报错。
 */
export class NeedsRecover extends Error {
  constructor(msg) { super(msg); this.name = 'NeedsRecover'; this.needsRecover = true; this.code = 5; }
}

/**
 * 🔴 §3.4：`.geoly` 及其下全部状态路径必须以 **`lstat` 无跟随**方式打开，遇 symlink 即拒绝。
 *    §10 那句泛称的「拒绝路径链 symlink」只覆盖 target 本身，不足以覆盖状态目录 ——
 *    把 `journal/` 或 `ledger.json` 换成 symlink 就能让我们去读/写 target 之外的东西。
 *
 * ⚠️ **这是入口门，不是原子保证**（同 R-1 / R-2）：Node 不暴露 `openat`/`fstatat`，
 *    检查与使用之间的窗口消不掉。它的价值是**尽早、集中地报出已知死路**。
 */
export function assertStatePathsNoSymlink(P) {
  const check = (p) => {
    let st;
    try { st = lstatSync(p); } catch (e) {
      if (e?.code === 'ENOENT') return null;
      bad(`.geoly 状态路径 ${p} 无法 lstat（${e.code}）—— 看不见就不能声称它是安全的`);
      return null;
    }
    if (st.isSymbolicLink()) bad(`.geoly 状态路径是 symlink，拒绝：${p}`);
    return st;
  };
  const root = check(P.state);
  if (root === null) return;
  if (!root.isDirectory()) bad(`.geoly 不是普通目录：${P.state}`);
  // 有界递归：状态目录不该有几万个条目；真有就说明现场不对，fail-closed 而不是硬扫
  let budget = 50_000;
  (function rec(dir, depth) {
    for (const name of readdirSync(dir)) {
      if (--budget < 0) bad('.geoly 下的条目数超过 5 万，拒绝继续扫描（现场不对）');
      const abs = join(dir, name);
      const st = check(abs);
      if (st === null || !st.isDirectory()) continue;
      // 🔴 `attic/` 与 `quarantine/` 必须**整棵**扫：manifest.json 与 *.tar 是被**直接读**的，
      //    它们要是 symlink 就会让恢复从状态目录之外取证（Codex 第三轮 #18）。
      //    `tx-*` 的载荷由 treeDigest / txDigest 那一套无跟随遍历把关，只扫两层即可。
      const deep = dir === P.state
        ? ['attic', 'quarantine', 'audit-archive', 'journal'].includes(name)
        : depth < 3;
      if (deep || depth < 2) rec(abs, depth + 1);
    }
  })(P.state, 0);
}

// ════════════════════════════════════════════════════════════════════════════
// §5.2 第 2 步：分流
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} target
 * @param {object} opts
 * @param {'auto'|'continue'|'rollback'|'reinstall'} [opts.mode]
 *        `auto` = 普通命令启动时那一趟（只自动续做清理与 pre-commit 丢弃，
 *        遇到需要人选方向的残留就 `NeedsRecover` 停机）。
 */
export function recover(target, opts = {}) {
  const mode = opts.mode ?? 'auto';
  const P0 = layout(target);
  if (!existsSync(P0.state)) return { outcome: 'nothing' };
  assertStatePathsNoSymlink(P0);
  // 🔴 入口预检：项目级 target 缺 onLedgerChanged 就在这里报，不要等到收尾之后
  assertLockfileHook(P0, opts);

  // §5.4：journal 原子写失败留下的 `.tmp` 一律忽略并删除
  sweepTmp(P0.state);
  sweepTmp(P0.journalDir);

  // ── 2a · 先清 audit intent ────────────────────────────────────────────────
  // 🔴 存在 → **完成它，或 fail-closed 停机**。绝不跳过、绝不删除。
  const audit = resumeAuditArchive(P0);

  // ── 2b-1 · 先认 repair intent，再看普通残留 ───────────────────────────────
  if (existsSync(P0.repairIntent)) {
    if (mode !== 'reinstall') {
      throw new NeedsRecover('存在未完成的 repair intent：请先跑 `recover --reinstall`');
    }
    const r = resumeRepair(target, opts);
    return { outcome: 'repair', audit, ...r };
  }

  // ── 2b-2 · 通用分支 ───────────────────────────────────────────────────────
  const gens = listJournalGenerations(P0.journalDir);
  const txGens = readdirSync(P0.state)
    .map((n) => /^tx-(\d+)$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);

  // 🔴 多代共存是**正常**的：completed 的 journal 是残留，不是损坏。
  //    只有「不止一个未完成事务」才是真的 corrupt。
  const live = [];
  for (const g of gens) {
    const J = readJournal(layout(target, g).journal);
    if (J.phase !== 'completed') live.push({ g, J });
  }
  if (live.length > 1) bad(`同时存在 ${live.length} 个未完成事务：${live.map((x) => x.g).join(',')}`);

  let result;
  if (live.length === 0) {
    result = clearResidue(target, P0, gens, txGens);
  } else {
    const { g, J } = live[0];
    const P = layout(target, g);
    result = driveLive(target, J, P, mode, opts);
  }

  // ── 2c · 确认已无未完成安装事务之后，才做阈值归档 ─────────────────────────
  let archived = { outcome: 'noop' };
  if (noUnfinishedInstallTx(target, P0)) {
    archived = maybeArchiveAudit(P0, { maxEntries: opts.auditMaxEntries ?? DEFAULT_AUDIT_MAX_ENTRIES });
  }
  return { ...result, audit, archived };
}

function noUnfinishedInstallTx(target, P0) {
  for (const g of listJournalGenerations(P0.journalDir)) {
    if (readJournal(layout(target, g).journal).phase !== 'completed') return false;
  }
  return true;
}

/**
 * §5.4.2 的双文件规则 + §5.6 第 2 步表的「`phase = completed` 的残留」。
 * 没有任何未完成 journal 时可达的几种形状。
 */
function clearResidue(target, P0, gens, txGens) {
  let touched = false;
  const completedGens = new Set(gens);
  for (const g of txGens) {
    const P = layout(target, g);
    if (!completedGens.has(g)) {
      // 有 tx 无 journal → **pre-commit**，允许直接删（结构上可证明未动 target）。
      // 🔴 例外：repair-intent 指向该 tx 时绝不按 pre-commit 处理 —— 已在 2b-1 拦下。
      rmtreeFsync(P.tx);
      touched = true;
      continue;
    }
    rmtreeFsync(P.tx);          // completed 却留着 tx：直接清掉残留
    touched = true;
  }
  if (existsSync(P0.ledger)) {
    const L = readLedger(P0.ledger);
    if (L.transaction !== null) {
      // transaction ≠ null 而 journal 不存在（或已 completed）→ journal 权威，ledger 被修正
      writeLedger(P0.ledger, { ...L, transaction: null });
      touched = true;
    }
  }
  // completed 的 journal 本身是残留，清掉（generation 水位在独立文件里，不受影响）
  for (const g of gens) {
    const P = layout(target, g);
    if (existsSync(P.journal)) { rmtreeFsync(P.journal); touched = true; }
  }
  return { outcome: touched ? 'residue-cleared' : 'nothing' };
}

function driveLive(target, J, P, mode, opts) {
  // 🔴 direction=rollback 一旦持久化，恢复**只能续做 rollback，不得转回正向**
  if (J.direction === 'rollback') {
    runRollback(target, J, P, opts);
    return { outcome: 'resumed-rollback', generation: J.generation };
  }
  // 🔴 `cleanup_pending` **不等于**「只能往前」：§5.4.1 的一致性矩阵里
  //    `done + tar_durable` / `done + done` 两行本来就是给它准备的
  //    （旧树此刻在 retired/ 或 attic/）。用户显式选了方向就必须尊重（Codex 第二轮 #5）。
  if (J.phase === 'cleanup_pending' && mode !== 'rollback') {
    runCleanup(target, J, P, opts);
    return { outcome: 'cleanup-finished', generation: J.generation };
  }
  if (J.phase !== 'prepared' && J.phase !== 'cleanup_pending') bad(`未知 phase ${J.phase}`);

  const physCorrupt = Object.entries(J.items).filter(([, it]) => it.state === 'corrupt').map(([n]) => n);
  const adoptBad = Object.entries(J.adopt_assertions ?? {})
    .filter(([, a]) => a.state === 'assertion-corrupt').map(([n]) => n);
  const unadoptBad = Object.entries(J.unadopt_assertions ?? {})
    .filter(([, a]) => a.state === 'assertion-corrupt').map(([n]) => n);

  if (mode === 'auto') {
    throw new NeedsRecover(
      `第 ${J.generation} 代事务停在 prepared：请跑 \`recover --continue\` 或 \`recover --rollback\``
      + (physCorrupt.length ? `（物理 corrupt：${physCorrupt.join(',')} —— 只能 --reinstall 或人工）` : ''));
  }

  if (mode === 'rollback') {
    // 🔴 混合异常的命令级优先级（§5.4 通用规则，写死）
    if (physCorrupt.length) bad(`--rollback 拒绝：存在物理 corrupt（${physCorrupt.join(',')}）`);
    if (unadoptBad.length) {
      bad(`--rollback 拒绝：unadopt 的 assertion-corrupt（${unadoptBad.join(',')}）——`
        + '恢复认领会让账本错误认领一棵非制品目录，唯一自动出路是 --continue');
    }
    beginRollback(target, J, P);
    runRollback(target, J, P, opts);
    return { outcome: 'rolled-back', generation: J.generation };
  }

  if (mode === 'continue') {
    if (physCorrupt.length) bad(`--continue 拒绝：存在物理 corrupt（${physCorrupt.join(',')}）`);
    if (adoptBad.length) bad(`--continue 拒绝：adopt 的 assertion-corrupt（${adoptBad.join(',')}）——出路是 --rollback`);
    applyItems(target, J, P);
    verifyAndCommit(target, J, P);
    runCleanup(target, J, P, opts);
    return { outcome: 'resumed-forward', generation: J.generation };
  }

  if (mode === 'reinstall') {
    if (adoptBad.length || unadoptBad.length) {
      bad('--reinstall 不自动执行：存在 assertion-corrupt（§5.4 通用规则），物理项也只能转人工');
    }
    if (!physCorrupt.length) bad('--reinstall 仅物理 corrupt 可用；当前没有物理 corrupt 项');
    const r = beginRepair(target, J, P, opts);
    return { outcome: 'repair', generation: J.generation, ...r };
  }
  bad(`未知的 recover 模式 ${mode}`);
  return null;
}

/** §5.5 的报告：逐项报告，**不自动选、不猜** */
export function inspect(target) {
  const P0 = layout(target);
  const out = { generations: [], repairIntent: existsSync(P0.repairIntent), auditIntent: existsSync(P0.auditIntent) };
  for (const g of listJournalGenerations(P0.journalDir)) {
    const J = readJournal(layout(target, g).journal);
    out.generations.push({
      generation: g,
      phase: J.phase,
      direction: J.direction ?? null,
      items: Object.fromEntries(Object.entries(J.items).map(([n, it]) =>
        [n, { op: it.op, state: it.state, cleanup: it.cleanup ?? null }])),
      adopt: Object.fromEntries(Object.entries(J.adopt_assertions ?? {}).map(([n, a]) => [n, a.state])),
      unadopt: Object.fromEntries(Object.entries(J.unadopt_assertions ?? {}).map(([n, a]) => [n, a.state])),
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// §5.4.1 rollback
// ════════════════════════════════════════════════════════════════════════════

/** 实测 T / R / S / A。🔴 attic 是否算「可用恢复源」必须**重验内容**。 */
function observe(target, J, P, name) {
  const it = J.items[name];
  const T = join(target, name), R = join(P.retired, name), S = join(P.stage, name);
  const digestOf = (p) => { if (!existsSync(p)) return null; try { return treeDigest(p); } catch { return 'unreadable'; } };
  const dT = digestOf(T), dR = digestOf(R), dS = digestOf(S);
  let aOk = false;
  if (it && it.op !== 'install-new') {
    const tar = join(P.attic, `${name}.tar`);
    if (existsSync(tar)) {
      try { verifyArchive(tar, it.old_digest, P.state); aOk = true; } catch { aOk = false; }
    }
  }
  return { T, R, S, dT, dR, dS, aOk, hasR: existsSync(R), hasS: existsSync(S) };
}

/**
 * §5.4.1「入场分类的封闭表」。🔴 **正向 `item.state` 只用于一致性校验，不参与判定。**
 * 未列组合一律 `corrupt`。表里的 `S` 列也是判据的一部分（Codex 第二轮 #3）。
 */
export function classifyEntry(target, J, P, name) {
  const it = J.items[name];
  const o = observe(target, J, P, name);
  const where = `${name}：T=${o.dT} R=${o.dR} S=${o.dS} A=${o.aOk}`;

  if (it.op === 'install-new') {
    // 🔴 本表**只实测 T**（规格的 install-new 表只有一列）
    if (o.dT === null) return 'noop';
    if (o.dT === it.new_digest) return 'as-installed';
    return bad(`install-new 入场分类不合法 ${where}`);
  }
  if (it.op === 'retire-only') {
    // 表：(old, ∅, *) / (∅, old, *) / (∅, 部分|∅, old)
    if (o.dT === it.old_digest && !o.hasR) return 'noop';
    if (o.dT === null && o.dR === it.old_digest) return 'as-retired';
    if (o.dT === null && o.aOk && isPartialOrAbsent(P, name, it)) return 'as-retired-cleaned';
    return bad(`retire-only 入场分类不合法 ${where}`);
  }
  // op = swap —— 表：(old,∅,new,*) / (∅,old,new,*) / (new,old,∅,*) / (new,部分|∅,∅,old)
  if (o.dT === it.old_digest && !o.hasR && o.dS === it.new_digest) return 'noop';
  if (o.dT === null && o.dR === it.old_digest && o.dS === it.new_digest) return 'as-retired';
  if (o.dT === it.new_digest && o.dR === it.old_digest && !o.hasS) return 'as-swapped';
  if (o.dT === it.new_digest && !o.hasS && o.aOk && isPartialOrAbsent(P, name, it)) return 'as-swapped-cleaned';
  return bad(`swap 入场分类不合法 ${where}`);
}

/** 该 entry_class 的恢复源与是否要 park T（封闭表的后两列） */
const CLASS_SPEC = {
  noop: { source: null, park: false },
  'as-retired': { source: 'R', park: false },
  'as-retired-cleaned': { source: 'A', park: false },
  'as-swapped': { source: 'R', park: true },
  'as-swapped-cleaned': { source: 'A', park: true },
  'as-installed': { source: null, park: true },
};

/**
 * 🔴 **入场预检在持久化 `direction=rollback` 之前全部做完** ——
 *    任一不满足就**拒绝整个 rollback，不写 `direction`**，
 *    否则会把一个注定做不完的回滚**锁死在 rollback 方向**。
 */
export function beginRollback(target, J, P) {
  const { phys, ad, un } = allItemKeys(J);
  const rb = { items: {} };

  for (const name of phys.sort()) {
    const it = J.items[name];
    const cls = classifyEntry(target, J, P, name);
    // (op, state, cleanup, entry_class) 闭合一致性矩阵 —— 只校验，不调度
    assertConsistent(name, it, cls);
    const spec = CLASS_SPEC[cls];
    const o = observe(target, J, P, name);
    if (spec.source === 'R' && o.dR !== it.old_digest) bad(`入场预检：${name} 选 R 但 R 摘要不符`);
    if (spec.source === 'A' && !o.aOk) bad(`入场预检：${name} 选 A 但 attic 归档不可用或摘要不符`);
    // 🔴 要被移走的 T：**按实测判定，不看正向 state**；最终以封闭表的 park 列为准
    if (spec.park) {
      // 三个要 park 的分类（as-swapped / as-swapped-cleaned / as-installed）park 的都是**新树**
      if (o.dT !== it.new_digest) bad(`入场预检：${name} 按分类要 park T，但实测 T=${o.dT} != ${it.new_digest}`);
    } else if (o.dT !== null && it.op !== 'install-new' && o.dT !== it.old_digest) {
      bad(`入场预检：${name} 不需要 park，但实测 T=${o.dT} 既不是旧树也不缺席`);
    }
    rb.items[name] = { entry_class: cls, rstate: cls === 'noop' ? 'restored' : 'pending' };
  }
  for (const name of ad) {
    const a = J.adopt_assertions[name];
    if (a.state === 'ok') {
      const m = strictlyMatches(join(target, name), a.tree_digest);
      if (!m.ok) bad(`adopt[${name}] 入场分类不合法：${m.why}`);
    }
    // 🔴 assertion-corrupt 时**不检查 T**（v42 修：否则「允许 rollback」自己堵死）
    rb.items[name] = { entry_class: 'noop', rstate: 'restored' };
  }
  for (const name of un) {
    const a = J.unadopt_assertions[name];
    if (a.state !== 'ok') bad(`unadopt[${name}] 的 assertion-corrupt 不允许 rollback`);
    const m = strictlyMatches(join(target, name), a.tree_digest);
    if (!m.ok) bad(`unadopt[${name}] 入场分类不合法：${m.why}`);
    rb.items[name] = { entry_class: 'noop', rstate: 'restored' };
  }

  fp('rollback:pre-direction', {});
  // 🔴 `direction = rollback` 与全部 entry_class / 初始 rstate **必须在同一次原子写里落盘**，
  //    写完才允许动手。
  J.direction = 'rollback';
  J.rollback = rb;
  writeJournal(P.journal, J);
  fp('rollback:post-direction', {});
  return J;
}

/** 🔴 逐项反向段：**以 `entry_class` + `rstate` 调度，正向 `state` 不参与**。 */
export function runRollback(target, J, P, opts = {}) {
  if (J.direction !== 'rollback') bad('runRollback：direction 不是 rollback');
  for (const name of Object.keys(J.rollback.items).sort()) {
    const r = J.rollback.items[name];
    if (r.rstate === 'restored') continue;
    const it = J.items[name];
    if (!it) bad(`rollback：${name} 是逻辑项却不是 restored`);
    const T = join(target, name), R = join(P.retired, name), S = join(P.stage, name);
    const cls = r.entry_class;

    // 「cleaned」两类：先从 A 重建 R，再走与非 cleaned 相同的后续段
    if ((cls === 'as-retired-cleaned' || cls === 'as-swapped-cleaned') && r.rstate === 'pending') {
      if (!existsSync(R) || safeDigest(R) !== it.old_digest) {
        const tar = join(P.attic, `${name}.tar`);
        verifyArchive(tar, it.old_digest, P.state);
        const un = join(P.unpack, name);
        restoreArchive(tar, un, it.old_digest);
        if (existsSync(R)) rmtreeFsync(R);       // 部分树先清掉，再把重建好的整棵搬过去
        mkdirChainFsync(P.retired);
        renameDirFsync(un, R);
      }
    }

    if (CLASS_SPEC[cls].park && r.rstate === 'pending') {
      fp('rollback:item:pre-park-t', { name });
      if (cls === 'as-installed') {
        // 🔴 `install-new` 的反向**不得在 target 内递归删除** —— park 到 `undo/`
        mkdirChainFsync(P.undo);
        idempotentRenameDir(T, join(P.undo, name), it.new_digest);
      } else {
        mkdirChainFsync(P.stage);
        idempotentRenameDir(T, S, it.new_digest);
      }
      fp('rollback:item:post-park-t', { name });
      r.rstate = cls === 'as-installed' ? 'restored' : 't_parked';
      writeJournal(P.journal, J);
      fp('rollback:item:post-rstate', { name });
      if (r.rstate === 'restored') continue;
    }

    fp('rollback:item:pre-restore', { name });
    idempotentRenameDir(R, T, it.old_digest);
    fp('rollback:item:post-restore', { name });
    r.rstate = 'restored';
    writeJournal(P.journal, J);
    fp('rollback:item:post-rstate', { name });
  }
  finalizeRollback(target, J, P, opts);
  return J;
}

function safeDigest(p) { try { return treeDigest(p); } catch { return null; } }



/**
 * 终结顺序（§5.4.1，每步 fsync；本身也要可崩溃续做）：
 * ① 删除**本代**的 attic/<gen>/ 与其 manifest
 * ② 写账本（ledger_existed 决定 patch 还是删库/例外账本）
 * ③ 重算 lockfile（在 repo 锁下 —— 由调用方通过 opts.onLedgerChanged 接线）
 * ④ 清理 <tx>/undo/、<tx>/unpack/ 与整个 tx 目录
 * ⑤ journal：**同一次原子写删除 direction 与 rollback**，phase = completed
 */
function finalizeRollback(target, J, P, opts) {
  // ① 🔴 阶段 B 之后回滚时 manifest 已经写出来了；不删它就会留下一个看起来
  //    「已完成」的 generation，之后被 --from-generation 误用
  if (existsSync(P.attic)) rmtreeFsync(P.attic);

  // ②
  const { ledger_existed: existed, pre } = J.ledger_image;
  if (existed) {
    const L = readLedger(P.ledger);
    writeLedger(P.ledger, { ...applyImageSide(L, pre), transaction: null });
  } else {
    dropOrExceptionLedger(P);
  }
  // ③ 🔴 §5.1 末尾：**`recover` 的任一子操作成功后，也必须在 repo 锁下重算项目 lockfile**。
  //    「有没有注入」在 recover 入口就查过了；这里只负责调用（Codex 第二轮 #6）。
  runLockfileRecalc(target, P, opts);

  // ④
  if (existsSync(P.undo)) rmtreeFsync(P.undo);
  if (existsSync(P.unpack)) rmtreeFsync(P.unpack);
  if (existsSync(P.tx)) rmtreeFsync(P.tx);

  // ⑤ 🔴 同一次原子写删掉两者
  delete J.direction;
  delete J.rollback;
  J.phase = 'completed';
  writeJournal(P.journal, J);
  fp('rollback:post-finalize', {});
  // 随后按常规清掉 completed journal
  if (existsSync(P.journal)) rmtreeFsync(P.journal);
  if (existsSync(P.ledger)) {
    const L = readLedger(P.ledger);
    if (L.transaction !== null) writeLedger(P.ledger, { ...L, transaction: null });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// §5.8 `--from-generation`：**不是回滚，是一次新的正向事务**
// ════════════════════════════════════════════════════════════════════════════

/**
 * ① 读 manifest → ② 按 §5.8.1 做 postimage 三方比对（不过即拒绝）→
 * ③ 开一个**新的正向事务**，逐项按各自的 `reverse_op` → ④ 收尾提交过滤后的 delta。
 *
 * @param {string[]} [opts.only]  🔴 可重复；闭包不完整时**拒绝并列出**要一起选的全部 name
 */
export function planFromGeneration(target, N, opts = {}) {
  const P = layout(target, N);
  const mPath = join(P.attic, 'manifest.json');
  if (!existsSync(mPath)) bad(`第 ${N} 代不可复位：attic/${N}/manifest.json 缺失`);
  const M = validateManifest(readJsonStrict(mPath, 'attic-manifest'));
  if (M.generation !== N) bad(`attic manifest 的 generation ${M.generation} != ${N}`);
  const L = readLedger(P.ledger);
  const { conflicts, selection } = comparePostimage(M, L, target, { only: opts.only });
  if (conflicts.length) {
    const nearer = readdirSync(P.atticDir).filter((n) => /^\d+$/.test(n)).map(Number)
      .filter((g) => g > N).sort((a, b) => a - b);
    bad(`第 ${N} 代的 postimage 三方比对不通过：\n  ${conflicts.join('\n  ')}`
      + (nearer.length ? `\n仍有 manifest 的更近 generation：${nearer.join(',')}（**条件提示，不是承诺**）` : ''));
  }

  // 逐项按 reverse_op 编译成一个普通的正向计划
  const items = {};
  const sources = {};
  const adopt = {};
  const unadopt = {};
  for (const name of selection.items) {
    const mi = M.items[name];
    if (mi.reverse_op === 'unadopt') { unadopt[name] = adoptFieldsFor(M, name, 'unadopt'); continue; }
    if (mi.reverse_op === 'adopt') { adopt[name] = adoptFieldsFor(M, name, 'adopt'); continue; }
    if (!existsSync(join(target, name)) && mi.reverse_op !== 'install-new') {
      // reverse_op = swap 需要 target 上此刻就是本代装上去的那棵树；比对已保证了这一点
      bad(`复位 ${name}：reverse_op=${mi.reverse_op} 但 target 上没有这个目录`);
    }
    items[name] = { reverse_op: mi.reverse_op, tar: mi.tar, old_digest: mi.old_digest };
    if (mi.tar) sources[name] = join(P.attic, mi.tar);
  }
  return { manifest: M, selection, reverseItems: items, sources, adopt, unadopt };
}

/**
 * 🔴 `unadopt → adopt` 的字段映射与等式（v43）：
 *   `artifact` 取自 **`ledger_delta.entries[name].artifact`**；
 *   `tree_digest` 必须 == 该 entry 的 digest，且 == `postimage.digests[name]` 的 D；
 *   🔴 **不得取 `old_digest`** —— 它在 unadopt manifest 里是 `null`。
 */
function adoptFieldsFor(M, name, want) {
  const d = M.postimage.digests[name];
  if (want === 'adopt') {
    const e = M.ledger_delta.entries[name];
    if (!e) bad(`复位 ${name}：ledger_delta.entries[${name}] 缺失，无法重新认领`);
    if (!d || d.present !== true) bad(`复位 ${name}：postimage.digests 未记录 present:true`);
    if (e.tree_digest !== d.digest) bad(`复位 ${name}：entry 的 digest 与 postimage 的 D 不等`);
    return { artifact: e.artifact, state: 'ok', tree_digest: e.tree_digest };
  }
  // unadopt：撤销认领，字段来自本代 postimage 里那条 entry
  const e = M.postimage.entries[name];
  if (!e) bad(`复位 ${name}：postimage.entries[${name}] 缺失，无法撤销认领`);
  return { artifact: e.artifact, state: 'ok', tree_digest: e.tree_digest };
}

// ════════════════════════════════════════════════════════════════════════════
// §5.10 repair intent
// ════════════════════════════════════════════════════════════════════════════

const INTENT_STATES = ['planned', 'isolated', 'child_registered', 'child_done', 'done'];

export function validateRepairIntent(I) {
  assertKeys(I, ['schema', 'repair_id', 'generation', 'isolate', 'plan', 'state', 'created_at'],
    ['child'], 'repair-intent');
  if (I.schema !== REPAIR_INTENT_SCHEMA) bad(`repair-intent.schema 必须是 ${REPAIR_INTENT_SCHEMA}`);
  if (typeof I.repair_id !== 'string' || I.repair_id === '') bad('repair-intent.repair_id 必填');
  if (!isUint(I.generation)) bad('repair-intent.generation 必须是非负整数');
  if (!INTENT_STATES.includes(I.state)) bad(`repair-intent.state 未知取值 ${I.state}`);

  assertKeys(I.isolate, ['tx', 'journal', 'ledger_transaction', 'targets'], [], 'repair-intent.isolate');
  assertKeys(I.isolate.tx, ['dir', 'fingerprint'], [], 'repair-intent.isolate.tx');
  if (I.isolate.tx.dir !== `tx-${I.generation}`) bad('repair-intent.isolate.tx.dir 与 generation 不一致');
  if (!isTxDigest(I.isolate.tx.fingerprint)) bad('repair-intent.isolate.tx.fingerprint 必须是 geoly-tx-v1 摘要');
  assertKeys(I.isolate.journal, ['path', 'digest'], [], 'repair-intent.isolate.journal');
  if (I.isolate.journal.path !== `journal/${I.generation}.json`) bad('repair-intent.isolate.journal.path 与 generation 不一致');
  assertKeys(I.isolate.ledger_transaction, ['digest'], [], 'repair-intent.isolate.ledger_transaction');
  for (const [n, t] of Object.entries(I.isolate.targets)) {
    assertSafeName(n, 'repair-intent.isolate.targets 的键');
    assertKeys(t, ['observed'], [], `repair-intent.isolate.targets[${n}]`);
    if (!isTreeDigest(t.observed)) bad(`repair-intent.isolate.targets[${n}].observed 必须是树摘要`);
  }

  assertKeys(I.plan, ['snapshot', 'items', 'repair_ledger_image'], [], 'repair-intent.plan');
  if (!isUint(I.plan.snapshot)) bad('repair-intent.plan.snapshot 必须是非负整数');
  const rli = I.plan.repair_ledger_image;
  assertKeys(rli, ['closure_entries', 'closure_roots', 'pre', 'post'], [], 'repair-intent.plan.repair_ledger_image');
  for (const k of ['closure_entries', 'closure_roots']) {
    if (!Array.isArray(rli[k]) || rli[k].some((x) => typeof x !== 'string')) bad(`repair_ledger_image.${k} 必须是字符串数组`);
  }
  for (const side of ['pre', 'post']) {
    assertKeys(rli[side], ['entries', 'roots'], [], `repair_ledger_image.${side}`);
    // 🔴 repair-intent 文件自身用「字段缺席」表达「应不存在」，**不写 null**
    for (const m of ['entries', 'roots']) {
      for (const [k, v] of Object.entries(rli[side][m])) {
        if (v === null) bad(`repair_ledger_image.${side}.${m}[${k}] 不得写 null（用字段缺席）`);
      }
    }
  }
  // planned 阶段与 isolated 之后的**字段集定死，多一个少一个都算非法 intent**
  const planned = I.state === 'planned';
  for (const [n, p] of Object.entries(I.plan.items)) {
    const where = `repair-intent.plan.items[${n}]`;
    assertSafeName(n, 'repair-intent.plan.items 的键');
    const req = planned ? ['target'] : ['target', 'cur', 'child_op'];
    assertKeys(p, req, planned ? ['old_digest'] : ['old_digest', 'restore_from'], where);
    assertKeys(p.target, ['present'], ['digest'], `${where}.target`);
    if (typeof p.target.present !== 'boolean') bad(`${where}.target.present 必须是布尔`);
    if (p.target.present && !isTreeDigest(p.target.digest)) bad(`${where}.target.digest 必须是树摘要`);
    if (!p.target.present && 'digest' in p.target) bad(`${where}.target：present=false 时不得带 digest`);
    if ('old_digest' in p && !isTreeDigest(p.old_digest)) bad(`${where}.old_digest 必须是树摘要`);
    if (!planned) {
      if (!['absent', 'old', 'target', 'other'].includes(p.cur)) bad(`${where}.cur 未知取值 ${p.cur}`);
      if (!['swap', 'install-new', 'retire-only', 'logical-only'].includes(p.child_op)) {
        bad(`${where}.child_op 未知取值 ${p.child_op}`);
      }
      const needs = p.child_op === 'swap' || p.child_op === 'install-new';
      if (needs && !p.restore_from) bad(`${where}.restore_from 在 child_op=${p.child_op} 时必填`);
      if (!needs && 'restore_from' in p) bad(`${where}.restore_from 只在 install-new / swap 时出现`);
      if (p.restore_from) {
        assertKeys(p.restore_from, ['artifact', 'tree_digest', 'source'], ['slot'], `${where}.restore_from`);
        if (!isTreeDigest(p.restore_from.tree_digest)) bad(`${where}.restore_from.tree_digest 必须是树摘要`);
        // 🔴 必须 == target.digest
        if (p.restore_from.tree_digest !== p.target.digest) bad(`${where}.restore_from.tree_digest != target.digest`);
        const srcOk = p.restore_from.source === 'registry' || p.restore_from.source === 'quarantine'
          || p.restore_from.source === 'quarantine-tx' || /^attic\/\d+$/.test(p.restore_from.source);
        if (!srcOk) bad(`${where}.restore_from.source 未知取值 ${p.restore_from.source}`);
        if (p.restore_from.source === 'quarantine-tx') {
          if (!['stage', 'retired', 'undo'].includes(p.restore_from.slot)) {
            bad(`${where}.restore_from.slot 在 source=quarantine-tx 时必填且只能是 stage/retired/undo`);
          }
        } else if ('slot' in p.restore_from) bad(`${where}.restore_from.slot 只在 source=quarantine-tx 时出现`);
      }
    }
  }
  if ('child' in I) {
    assertKeys(I.child, ['generation', 'tx_dir', 'committed'], [], 'repair-intent.child');
    if (!isUint(I.child.generation)) bad('repair-intent.child.generation 必须是非负整数');
    if (I.child.tx_dir !== `tx-${I.child.generation}`) bad('repair-intent.child.tx_dir 与 generation 不一致');
    if (typeof I.child.committed !== 'boolean') bad('repair-intent.child.committed 必须是布尔');
  }
  // 🔴 `state` × `child` 的合法组合（其余一律 fail-closed）
  const hasChild = 'child' in I;
  const legal = { planned: false, isolated: false, child_registered: true, child_done: true, done: true };
  if (legal[I.state] !== hasChild) bad(`repair-intent：state=${I.state} 与 child ${hasChild ? '存在' : '缺席'} 的组合非法`);
  return I;
}

const readIntent = (P) => validateRepairIntent(readJsonStrict(P.repairIntent, 'repair-intent'));
const writeIntent = (P, I) => { validateRepairIntent(I); writeAtomic(P.repairIntent, stringify(I)); };

/** quarantine 的四个落点（§5.10「隔离的范围」）*/
function quarPaths(P) {
  return {
    root: P.quarantine,
    tx: join(P.quarantine, 'tx'),                 // 🔴 规格是 quarantine/<gen>/tx/
    journal: join(P.quarantine, 'journal.json'),
    targets: join(P.quarantine, 'targets'),
  };
}

/** §5.10 ①②：枚举完整 plan，写 intent（state=planned）*/
export function beginRepair(target, J, P, opts = {}) {
  const gen = J.generation;
  const L = readLedger(P.ledger);
  if (L.transaction === null) bad('repair：ledger.transaction 为 null，无法绑定被隔离的事务');
  if (L.transaction.generation !== gen) bad('repair：ledger.transaction 属于他代');

  // 🔴 只隔离**因自身 corrupt 而不可信**的 target 树（§5.10「隔离的范围」第四行）。
  //    判据不是「这一项是 corrupt」，而是「那棵树既不是旧树也不是新树」——
  //    树本身可信时把它一起搬走，等于替用户挪了一个完好的目录。
  const targets = {};
  for (const [n, it] of Object.entries(J.items)) {
    if (it.state !== 'corrupt') continue;
    const dir = join(target, n);
    if (!existsSync(dir)) continue;
    let d;
    try { d = treeDigest(dir); } catch { d = null; }
    if (d !== null && (d === it.old_digest || d === it.new_digest)) continue;
    if (d === null) bad(`repair：${n} 的目标树无法成像，不写 intent、转人工`);
    targets[n] = { observed: d };
  }

  // 🔴 `repair_ledger_image` 在**第 ① 步、任何隔离动作之前**计算并持久化
  const rli = computeRepairLedgerImage(L, J);
  // 校验：当前账本在 closure 上的投影必须精确等于 pre
  const projNow = projection(L, rli.closure_entries, rli.closure_roots);
  if (stringify(projNow) !== stringify(rli.pre)) bad('repair：当前账本在 closure 上的投影与 repair_ledger_image.pre 不等');

  const items = {};
  for (const name of Object.keys(J.items).sort()) {
    const it = J.items[name];
    const e = rli.post.entries[name];
    const tgt = e ? { digest: e.tree_digest, present: true } : { present: false };
    // 🔴 与原 journal 意图严格对应：两者不一致即 corrupt
    const wantDigest = it.op === 'retire-only' ? undefined : it.new_digest;
    if (tgt.present ? tgt.digest !== wantDigest : wantDigest !== undefined) {
      bad(`repair：${name} 的目标断言与原 journal 意图不一致`);
    }
    const p = { target: tgt };
    if (it.op !== 'install-new') p.old_digest = it.old_digest;
    items[name] = p;
  }

  const I = {
    schema: REPAIR_INTENT_SCHEMA,
    created_at: opts.now ?? nowUtc(),
    generation: gen,
    isolate: {
      journal: { digest: sha256(readFileSync(P.journal)), path: `journal/${gen}.json` },
      ledger_transaction: { digest: sha256(Buffer.from(stringify(L.transaction), 'utf8')) },
      targets,
      // 🔴 `geoly-tx-v1`：目录项也进摘要（含空目录、含 tx 根本身）
      tx: { dir: `tx-${gen}`, fingerprint: txDigest(P.tx) },
    },
    plan: { items, repair_ledger_image: rli, snapshot: bindSnapshot(J, opts) },
    repair_id: opts.repairId ?? sha256(Buffer.from(`${target}|${gen}|${I0seed()}`, 'utf8')).slice(7, 23),
    state: 'planned',
  };
  writeIntent(P, I);
  fp('repair:step2:post-intent', { gen });
  return resumeRepair(target, { ...opts, mode: 'reinstall' });
  function I0seed() { return opts.now ?? nowUtc(); }
}

/**
 * 🔴 `plan.snapshot` 的绑定（§5.10）：它必须等于**原 journal 记录的解析快照**，
 *    不能是「随便挑一个当前快照」（Codex 第二轮 #8）。
 *
 * 原 journal 里记着解析快照的地方是 `ledger_image.post.entries[*].snapshot` ——
 * 一个事务里的成员来自同一次解析，因此该值必须唯一；不唯一或缺失即 corrupt。
 * 调用方传了 `opts.snapshot` 就必须与它相等（多一个来源 = 多一份真相）。
 * 🔴 还要能按 §02-6.1 的历史读取路径取回并验签 —— 那条链不在内核范围，
 *    由 `opts.assertSnapshotRetrievable(N)` 注入；不注入就如实拒绝自动 repair。
 */
function bindSnapshot(J, opts) {
  // 🔴 **只取 `post`**（Codex 第三轮 #8）：`pre` 记的是**上一次**安装时的快照，
  //    正常的升级事务里 pre 与 post 本来就不同 —— 把两者并起来要求唯一，
  //    会把每一个合法的升级事务都判成「快照不唯一」而拒掉自动 repair。
  const seen = new Set();
  for (const e of Object.values(J.ledger_image.post.entries)) if (e) seen.add(e.snapshot);
  if (seen.size === 0) bad('repair：原 journal 的 post 里找不到解析快照，plan.snapshot 无从绑定，转人工');
  if (seen.size > 1) bad(`repair：原 journal 的 post 里解析快照不唯一（${[...seen].join(',')}），转人工`);
  const n = [...seen][0];
  if (opts.snapshot !== undefined && opts.snapshot !== n) {
    bad(`repair：opts.snapshot=${opts.snapshot} 与原 journal 记录的解析快照 ${n} 不符`);
  }
  // 🔴 §5.10：该快照必须能按 §02-6.1 的历史读取路径**取回并验签**。
  //    那条链不在内核范围，只能注入 —— 但**不注入不等于放行**（注释说了拒绝就要真拒绝）。
  if (typeof opts.assertSnapshotRetrievable !== 'function') {
    bad('repair：必须注入 assertSnapshotRetrievable(N)（plan.snapshot 要能取回并验签，§5.10）');
  }
  opts.assertSnapshotRetrievable(n);
  return n;
}

/** §5.10「投影」的正式定义 */
function projection(L, closureEntries, closureRoots) {
  const entries = {}, roots = {};
  for (const k of closureEntries) if (Object.hasOwn(L.entries, k)) entries[k] = L.entries[k];
  for (const k of closureRoots) if (Object.hasOwn(L.roots, k)) roots[k] = L.roots[k];
  return { entries, roots };
}

/**
 * 输入 = **原 journal 的 `ledger_image`（pre 与 post 的并集）+ 当前 ledger**；
 * 在 **root ↔ entry 二部图**上，从受影响 seed 取**不动点闭包**。
 */
function computeRepairLedgerImage(L, J) {
  const seedEntries = new Set([
    ...Object.keys(J.ledger_image.pre.entries), ...Object.keys(J.ledger_image.post.entries),
    ...Object.keys(J.items),
  ]);
  const seedRoots = new Set([
    ...Object.keys(J.ledger_image.pre.roots), ...Object.keys(J.ledger_image.post.roots),
  ]);
  for (;;) {
    let grew = false;
    for (const n of [...seedEntries]) {
      for (const rk of L.entries[n]?.requested_by ?? []) if (!seedRoots.has(rk)) { seedRoots.add(rk); grew = true; }
    }
    for (const rk of [...seedRoots]) {
      for (const [n, e] of Object.entries(L.entries)) {
        if (e.requested_by.includes(rk) && !seedEntries.has(n)) { seedEntries.add(n); grew = true; }
      }
    }
    if (!grew) break;
  }
  const ce = [...seedEntries].sort();
  const cr = [...seedRoots].sort();
  const after = applyImageSide(L, J.ledger_image.post, {});
  return {
    closure_entries: ce,
    closure_roots: cr,
    post: projection(after, ce, cr),
    pre: projection(L, ce, cr),
  };
}

/**
 * §5.10 ③–⑥ 的恢复与续做。
 * 🔴 **恢复一律按「物理实况」定位，不按 `state` 断言** ——
 *    `state=planned` **不代表**「tx 还在原处」。
 */
export function resumeRepair(target, opts = {}) {
  const P0 = layout(target);
  const I0 = readIntent(P0);
  const P = layout(target, I0.generation);
  const Q = quarPaths(P);
  let I = I0;

  // ── ③ 隔离四项（幂等）───────────────────────────────────────────────────
  // 🔴 只在**隔离阶段**做。`state` 一旦进到 `child_registered` 及以后，child 会
  //    合法地把 `target/<name>` 重新装回来 —— 那时再跑一遍 ③ 会把它误判成
  //    「原处与隔离位置同时存在」。`state × child` 的合法组合表已经保证了
  //    `child_registered` 蕴含「④ 已完成」，所以这里用 state 分阶段是成立的，
  //    与「恢复按物理实况定位」不冲突（阶段内部仍然全靠实测）。
  if (I.state !== 'planned' && I.state !== 'isolated') {
    assertSameTransaction(Q, I);
    return driveChild(target, P, Q, I, opts);
  }
  mkdirChainFsync(Q.targets);
  fp('repair:step3:pre-isolate-tx', {});
  isolateOne('tx', P.tx, Q.tx, () => txDigest(P.tx), () => txDigest(Q.tx), I.isolate.tx.fingerprint);
  fp('repair:step3:post-isolate-tx', {});
  isolateOne('journal', P.journal, Q.journal,
    () => sha256(readFileSync(P.journal)), () => sha256(readFileSync(Q.journal)), I.isolate.journal.digest);
  fp('repair:step3:post-isolate-journal', {});
  for (const [n, t] of Object.entries(I.isolate.targets)) {
    isolateOne(`target:${n}`, join(target, n), join(Q.targets, n),
      () => treeDigest(join(target, n)), () => treeDigest(join(Q.targets, n)), t.observed);
  }
  fp('repair:step3:post-isolate-target', {});
  clearLedgerTransaction(P, I);
  fp('repair:step3:post-clear-ledger-transaction', {});

  // ── ④ 重验四项全部到位 → state=isolated（同次补入 cur / child_op / restore_from）─
  assertSameTransaction(Q, I);
  if (I.state === 'planned') {
    const items = {};
    for (const [name, p] of Object.entries(I.plan.items)) {
      const cur = measureCur(target, name, p);
      const childOp = deriveChildOp(cur, p.target);
      const next = { ...p, child_op: childOp, cur };
      if (childOp === 'swap' || childOp === 'install-new') {
        next.restore_from = pickRestoreFrom(P, Q, I, name, p, opts);
      }
      items[name] = next;
    }
    I = { ...I, plan: { ...I.plan, items }, state: 'isolated' };
    writeIntent(P, I);
    fp('repair:step4:post-isolated', {});
  } else if (I.state === 'isolated') {
    // 🔴 `planned` / `isolated`，**创建 child 之前**：重测 cur，与已持久化的值必须一致
    for (const [name, p] of Object.entries(I.plan.items)) {
      if (measureCur(target, name, p) !== p.cur) bad(`repair：${name} 的 cur 重测与已持久化的值不一致`);
    }
  }

  // ── ⑤/⑥ child ────────────────────────────────────────────────────────────
  return driveChild(target, P, Q, I, opts);
}

function isolateOne(what, orig, quar, digestOrig, digestQuar, expect) {
  const a = existsSync(orig), b = existsSync(quar);
  if (a && b) bad(`repair：${what} 在原处与隔离位置**同时存在**`);
  // 🔴 §5.10 观测表：**两边都在 / 两边都不在 / 任一处存在但不落入记录的等价类** 一律 corrupt。
  //    `target:*` 也没有例外 —— 它是 beginRepair 已经观测到并写进 intent 的树，
  //    两边都没有就是证据已经丢了（Codex 第二轮 #7）。
  if (!a && !b) bad(`repair：${what} 在原处与隔离位置**都不存在**`);
  if (b) {
    if (digestQuar() !== expect) bad(`repair：${what} 在隔离位置但不落入记录的等价类`);
    return;                                    // 已完成，跳过
  }
  if (digestOrig() !== expect) bad(`repair：${what} 在原位置但不落入记录的等价类`);
  mkdirChainFsync(join(quar, '..'));
  renameDirFsync(orig, quar);
}

function clearLedgerTransaction(P, I) {
  const L = readLedger(P.ledger);
  if (L.transaction === null) return;          // 已完成，跳过
  const d = sha256(Buffer.from(stringify(L.transaction), 'utf8'));
  if (d !== I.isolate.ledger_transaction.digest) {
    bad('repair：ledger.transaction 既不匹配记录的摘要、也不是 null（有第三方改过账本）');
  }
  // 🔴 只改这一个键，用 §11 的 patch 语义
  writeLedger(P.ledger, { ...L, transaction: null });
}

/**
 * 🔴 同事务绑定：分别核验摘要**不够**，还必须验证四项属于**同一个事务**。
 * 并且每次进来都要**重验隔离证据的持续身份** —— 只在隔离那一刻验过一次，
 * 之后 child 阶段证据被改写就再也发现不了（Codex 第二轮 #10）。
 */
function assertSameTransaction(Q, I) {
  if (!existsSync(Q.tx)) bad('repair：tx 不在隔离位置');
  if (!existsSync(Q.journal)) bad('repair：journal 不在隔离位置');
  if (txDigest(Q.tx) !== I.isolate.tx.fingerprint) bad('repair：隔离 tx 的 geoly-tx-v1 指纹已变');
  if (sha256(readFileSync(Q.journal)) !== I.isolate.journal.digest) bad('repair：隔离 journal 的摘要已变');
  for (const [n, t] of Object.entries(I.isolate.targets)) {
    const q = join(Q.targets, n);
    if (!existsSync(q)) bad(`repair：隔离的 target ${n} 不在隔离位置`);
    if (safeDigest(q) !== t.observed) bad(`repair：隔离的 target ${n} 观测指纹已变`);
  }
  const j = readJsonStrict(Q.journal, 'quarantined journal');
  if (j.generation !== I.generation) bad('repair：隔离 journal 的 generation 与 intent 不一致');
  if (j.tx_dir !== I.isolate.tx.dir) bad('repair：隔离 journal 的 tx_dir 与实际隔离的 tx 不一致');
}

/** 🔴 `cur` 的取值域是**封闭的四个**，不是「任意 digest」 */
function measureCur(target, name, p) {
  const dir = join(target, name);
  if (!existsSync(dir)) return 'absent';
  let d;
  try { d = treeDigest(dir); } catch { return 'other'; }
  if (p.old_digest && d === p.old_digest) return 'old';
  if (p.target.present && d === p.target.digest) return 'target';
  return 'other';
}

/** 「当前实况 × 目标断言」—— 唯一能决定动作的两个量 */
function deriveChildOp(cur, tgt) {
  if (cur === 'other') bad('repair：cur=other（既非旧树也非目标树）→ corrupt 停机');
  if (cur === 'absent') return tgt.present ? 'install-new' : 'logical-only';
  if (!tgt.present) return 'retire-only';
  if (cur === 'target') return 'logical-only';
  return 'swap';
}

/**
 * `restore_from` 的定位与验法（§5.10）。
 * 🔴 `quarantine-tx` 是**只读恢复介质**：**无跟随复制**到 child 的 `stage/`，
 *    禁止 rename、禁止 hardlink、禁止以任何方式修改 quarantine 内容。
 */
function pickRestoreFrom(P, Q, I, name, p, opts) {
  const want = p.target.digest;
  // ① quarantine 里那棵被隔离的 target 树。
  //    🔴 先匹配 intent 里记录的**观测指纹**，再要求它等于目标摘要 —— 两道都要过。
  const qt = join(Q.targets, name);
  const observedOk = I.isolate.targets[name] !== undefined
    && safeDigest(qt) === I.isolate.targets[name].observed;
  if (observedOk && safeDigest(qt) === want) {
    return { artifact: opts.artifactFor?.(name) ?? 'unknown', source: 'quarantine', tree_digest: want };
  }
  // ② 隔离 tx 的候选槽（两步制：先由 journal 状态枚举候选，再用实测摘要定生死）
  for (const slot of candidateSlots(Q, I, name)) {
    const dir = join(Q.tx, slot, name);
    if (existsSync(dir) && safeDigest(dir) === want) {
      return { artifact: opts.artifactFor?.(name) ?? 'unknown', slot, source: 'quarantine-tx', tree_digest: want };
    }
  }
  // ③ attic 的某一代
  if (existsSync(P.atticDir)) {
    for (const g of readdirSync(P.atticDir).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a)) {
      const mp = join(P.atticDir, String(g), 'manifest.json');
      if (!existsSync(mp)) continue;
      let M;
      try { M = validateManifest(readJsonStrict(mp, 'attic-manifest')); } catch { continue; }
      const mi = M.items[name];
      if (!mi || !mi.tar || mi.old_digest !== want) continue;
      const tar = join(P.atticDir, String(g), mi.tar);
      try { verifyArchive(tar, want, P.state); } catch { continue; }
      return { artifact: opts.artifactFor?.(name) ?? 'unknown', source: `attic/${g}`, tree_digest: want };
    }
  }
  // ④ registry —— 🔴 这是 `--reinstall`「重新解析安装」的**主路径**。
  //    下载 / 验签 / 资产 sha256 / 解包重算属于 §02-6 的完整验证链，不在内核范围，
  //    由调用方注入 `resolver(name) -> { artifact, dir }`（dir 已过完整验证链）。
  if (opts.resolver) {
    const r = opts.resolver(name);
    if (safeDigest(r.dir) !== want) bad(`repair：resolver 给的树摘要不符（${name}）`);
    return { artifact: r.artifact, source: 'registry', tree_digest: want };
  }
  bad(`repair：${name} 找不到可用的 restore_from（quarantine / quarantine-tx / attic 都没有摘要 == ${want} 的介质，`
    + '且未注入 registry resolver）—— 枚举不出完整计划即拒绝自动执行，转人工');
  return null;
}

/**
 * §5.10 候选槽表。🔴 **两步制**：这里只**枚举候选**，实测摘要在调用点定生死。
 */
function candidateSlots(Q, I, name) {
  const j = readJsonStrict(Q.journal, 'quarantined journal');
  const it = j.items?.[name];
  if (!it) return [];
  if (j.direction === 'rollback') {
    const r = j.rollback?.items?.[name];
    if (!r) return [];
    const k = `${r.entry_class}|${r.rstate}`;
    return ({
      'as-retired|pending': ['retired'],
      'as-retired-cleaned|pending': ['retired'],
      'as-swapped|pending': ['retired'],
      'as-swapped|t_parked': ['stage', 'retired'],
      'as-swapped-cleaned|pending': ['retired'],
      'as-swapped-cleaned|t_parked': ['stage', 'retired'],
    })[k] ?? [];
  }
  const cleanup = it.cleanup ?? '-';
  const k = `${it.op}|${it.state}|${cleanup}`;
  return ({
    'swap|planned|-': ['stage'],
    'swap|retired|-': ['stage', 'retired'],     // 🔴 两个都候选
    'swap|swapped|-': ['retired'],
    'swap|verified|-': ['retired'],
    'swap|done|-': ['retired'],
    'swap|done|tar_durable': ['retired'],
    'install-new|planned|-': ['stage'],
    'retire-only|retired|-': ['retired'],
    'retire-only|verified|-': ['retired'],
    'retire-only|done|-': ['retired'],
    'retire-only|done|tar_durable': ['retired'],
  })[k] ?? [];
}

/**
 * child 的子状态机 + `child_registered` 的四观测量矩阵。
 * 🔴 `child_done` / `done` 的三项前置断言**优先于整张矩阵判定**。
 */
function driveChild(target, P, Q, I, opts) {
  const P0 = layout(target);

  if (I.state === 'child_done' || I.state === 'done') {
    assertDonePreconditions(target, P0, I);
    if (I.state === 'child_done') {
      I = { ...I, state: 'done' };
      writeIntent(P, I);
      fp('repair:step6:post-state-done', {});
    }
    rmtreeFsync(P0.repairIntent);
    fp('repair:step6:post-intent-removed', {});
    return { repair: 'done', generation: I.generation };
  }

  if (I.state === 'isolated') {
    // 🔴 此时**磁盘上不得有任何 child 残留**
    const L = readLedger(P0.ledger);
    if (L.transaction !== null) bad('repair：state=isolated 而 ledger.transaction 非 null');
    // 🔴 先过 2c 的阈值归档，再登记 child
    maybeArchiveAudit(P0, { maxEntries: opts.auditMaxEntries ?? DEFAULT_AUDIT_MAX_ENTRIES });
    const childGen = nextGeneration(P0);
    I = { ...I, child: { committed: false, generation: childGen, tx_dir: `tx-${childGen}` }, state: 'child_registered' };
    writeIntent(P, I);
    fp('repair:step5:post-child-register', {});
  }

  // state = child_registered
  const guarded = childGuards(target, P0, I);
  fp('repair:step5:pre-child-create', {});
  const action = childMatrix(guarded);
  return applyChildAction(target, P, Q, I, guarded, action, opts);
}

function assertDonePreconditions(target, P0, I) {
  if (!I.child || I.child.committed !== true) bad('repair：进入 child_done/done 必须 child.committed == true');
  const CP = layout(target, I.child.generation);
  if (existsSync(CP.tx)) bad('repair：进入 child_done/done 时不得有 child tx');
  if (existsSync(CP.journal)) bad('repair：进入 child_done/done 时不得有 child journal');
  const L = readLedger(P0.ledger);
  if (L.transaction !== null) bad('repair：进入 child_done/done 时 ledger.transaction 必须是 null');
}

/** **前置守卫**（任一命中即 corrupt；`1` 转人工、不嵌套 repair）*/
function childGuards(target, P0, I) {
  const cg = I.child.generation;
  const CP = layout(target, cg);
  // 0 · tx 属于他代
  for (const n of readdirSync(P0.state)) {
    const m = /^tx-(\d+)$/.exec(n);
    if (m && Number(m[1]) !== cg) bad(`repair 守卫 0：存在他代 tx（${n}）`);
  }
  // 0″ · 存在任何不属于 child.generation 的 journal 残留（.tmp 已在 recover 入口扫掉）
  for (const g of listJournalGenerations(P0.journalDir)) {
    if (g !== cg) bad(`repair 守卫 0″：存在他代 journal 残留（${g}.json）`);
  }
  const L = readLedger(P0.ledger);
  // 0′ · transaction 属于他代
  if (L.transaction !== null && L.transaction.generation !== cg) {
    bad('repair 守卫 0′：ledger.transaction 属于他代');
  }
  // 1 · journal 为 corrupt
  let journal = '无';
  let J = null;
  if (existsSync(CP.journal)) {
    J = readJournal(CP.journal);       // CRC/schema 失败即 corrupt 停机（守卫 1）
    journal = J.phase;
  }
  return {
    cg, CP, J,
    committed: I.child.committed,
    journal,
    tx: existsSync(CP.tx) ? '本代' : '无',
    transaction: L.transaction === null ? 'null' : '本代',
  };
}

/** 矩阵（守卫全过之后，逐行唯一匹配）；未列组合 fail-closed */
function childMatrix(o) {
  const k = `${o.committed}|${o.journal}|${o.tx}|${o.transaction}`;
  const M = {
    'false|无|无|null': 'create-tx',                 // 2
    'false|无|无|本代': 'half-commit-rebind',        // 3
    'false|无|本代|null': 'precommit-rebind',        // 4
    'false|无|本代|本代': 'precommit-rebind',        // 5
    'false|prepared|本代|null': 'set-committed',     // 6
    'false|prepared|本代|本代': 'set-committed',
    'false|cleanup_pending|本代|null': 'set-committed',
    'false|cleanup_pending|本代|本代': 'set-committed',
    'true|prepared|本代|null': 'resume-child',       // 8
    'true|prepared|本代|本代': 'resume-child',
    'true|cleanup_pending|本代|null': 'resume-cleanup', // 9
    'true|cleanup_pending|本代|本代': 'resume-cleanup',
    // 10 ✅ 正常可达（tx 已删、completed 未写）—— v28 在这里判 corrupt，是误杀
    'true|cleanup_pending|无|null': 'finish-completed',
    'true|cleanup_pending|无|本代': 'finish-completed',
    'true|completed|无|本代': 'clear-then-final',    // 12
    'true|completed|无|null': 'drop-journal-final',  // 13
    'true|无|无|null': 'final-verify',               // 15
  };
  const a = M[k];
  if (a) return a;
  // 7 / 11 / 14 / 16 与其余一切
  bad(`repair child 矩阵：(committed,journal,tx,transaction)=(${k}) → fail-closed`);
  return null;
}

function applyChildAction(target, P, Q, I, g, action, opts) {
  const P0 = layout(target);
  const CP = g.CP;
  switch (action) {
    case 'half-commit-rebind':
    case 'precommit-rebind': {
      // 🔴 先按双文件规则清掉 transaction，再**重绑一个新 generation**（水位只增、旧号作废）
      const L = readLedger(P0.ledger);
      if (L.transaction !== null) writeLedger(P0.ledger, { ...L, transaction: null });
      if (existsSync(CP.tx)) rmtreeFsync(CP.tx);
      const ng = nextGeneration(P0);
      const I2 = { ...I, child: { committed: false, generation: ng, tx_dir: `tx-${ng}` } };
      writeIntent(P, I2);
      return resumeRepair(target, opts);
    }
    case 'set-committed': {
      // child journal 已提交而父 intent 还没来得及写 committed:true → **先补写 true**
      const I2 = { ...I, child: { ...I.child, committed: true } };
      writeIntent(P, I2);
      return resumeRepair(target, opts);
    }
    case 'create-tx': {
      createChildTransaction(target, P, Q, I, opts);
      return resumeRepair(target, opts);
    }
    case 'resume-child': {
      applyItems(target, g.J, CP);
      verifyAndCommit(target, g.J, CP);
      runCleanup(target, g.J, CP, opts);
      return resumeRepair(target, opts);
    }
    case 'resume-cleanup': {
      runCleanup(target, g.J, CP, opts);
      return resumeRepair(target, opts);
    }
    case 'finish-completed': {
      const L = readLedger(P0.ledger);
      if (L.transaction !== null) writeLedger(P0.ledger, { ...L, transaction: null });
      g.J.phase = 'completed';
      writeJournal(CP.journal, g.J);
      return resumeRepair(target, opts);
    }
    case 'clear-then-final': {
      const L = readLedger(P0.ledger);
      writeLedger(P0.ledger, { ...L, transaction: null });
      return resumeRepair(target, opts);
    }
    case 'drop-journal-final': {
      rmtreeFsync(CP.journal);
      return resumeRepair(target, opts);
    }
    case 'final-verify': {
      finalVerify(target, P, I);
      const I2 = { ...I, state: 'child_done' };
      writeIntent(P, I2);
      fp('repair:step6:post-child-done', {});
      return driveChild(target, P, Q, I2, opts);
    }
    default:
      return bad(`repair：未知动作 ${action}`);
  }
}

/** 🔴 重验最终 ledger 与目标树是否符合 `plan.repair_ledger_image.post` */
function finalVerify(target, P, I) {
  const rli = I.plan.repair_ledger_image;
  const L = readLedger(P.ledger);
  const proj = projection(L, rli.closure_entries, rli.closure_roots);
  if (stringify(proj) !== stringify(rli.post)) {
    bad('repair 最终重验：账本在 closure 上的投影与 repair_ledger_image.post 不等');
  }
  for (const [name, p] of Object.entries(I.plan.items)) {
    const dir = join(target, name);
    if (p.target.present) {
      if (!existsSync(dir)) bad(`repair 最终重验：${name} 应存在却缺席`);
      if (treeDigest(dir) !== p.target.digest) bad(`repair 最终重验：${name} 摘要与目标断言不符`);
    } else if (existsSync(dir)) bad(`repair 最终重验：${name} 应缺席却存在`);
  }
}

/**
 * 建 child 事务。
 * 🔴 **repair-child 是「`old_digest` 取实测值」这条通则的例外**：写进 child journal 的
 *    是 `expected_old = plan.items[<name>].old_digest`（来自原 journal 的已验证值），
 *    不是此刻的实测值 —— 否则会**把一棵外部的树当成旧树退役掉**。
 */
function createChildTransaction(target, P, Q, I, opts) {
  const P0 = layout(target);
  const cg = I.child.generation;
  const CP = layout(target, cg);
  const L = readLedger(P0.ledger);

  const items = {};
  const sources = {};
  for (const [name, p] of Object.entries(I.plan.items)) {
    const op = p.child_op;
    if (op === 'logical-only') continue;      // 🔴 不建 stage / retired / attic item
    if (op === 'retire-only') {
      // 写 child prepared 之前：实测值必须等于 expected_old
      const got = safeDigest(join(target, name));
      if (got !== p.old_digest) bad(`repair child：${name} 实测 ${got} != expected_old ${p.old_digest}`);
      items[name] = { op: 'retire-only', had_old: true, state: 'planned', old_digest: p.old_digest };
      continue;
    }
    const src = materializeRestore(P, Q, I, name, p, CP, opts);
    if (op === 'install-new') {
      items[name] = { op: 'install-new', had_old: false, state: 'planned', new_digest: p.target.digest };
    } else {
      const got = safeDigest(join(target, name));
      if (got !== p.old_digest) bad(`repair child：${name} 实测 ${got} != expected_old ${p.old_digest}`);
      items[name] = {
        op: 'swap', had_old: true, state: 'planned',
        new_digest: p.target.digest, old_digest: p.old_digest,
      };
    }
    sources[name] = src;
  }

  // child 的 `ledger_image.pre` **必须等于「隔离完成之后」的实际账本投影**
  const rli = I.plan.repair_ledger_image;
  const materialize = (side) => {
    const entries = {}, roots = {};
    for (const k of rli.closure_entries) entries[k] = Object.hasOwn(side.entries, k) ? side.entries[k] : null;
    for (const k of rli.closure_roots) roots[k] = Object.hasOwn(side.roots, k) ? side.roots[k] : null;
    return { entries, roots };
  };
  const preProj = projection(L, rli.closure_entries, rli.closure_roots);
  if (stringify(preProj) !== stringify(rli.pre)) bad('repair child：隔离后的账本投影与 repair_ledger_image.pre 不等');
  const image = {
    ledger_existed: true,
    // 🔴 两个非 closure 字段另有来源：`last_applied_generation` 与整张 `frozen_attic`
    //    一律从「隔离后的账本」取值。
    post: { ...materialize(rli.post), last_applied_generation: cg },
    pre: { ...materialize(rli.pre), last_applied_generation: L.last_applied_generation },
  };
  if (L.frozen_attic) { image.pre.frozen_attic = L.frozen_attic; image.post.frozen_attic = L.frozen_attic; }

  const plan = {
    generation: cg,
    items,
    ledger_image: image,
    sources,
    tx_dir: `tx-${cg}`,
  };
  stageTrees(CP, plan);
  // 🔴 出处决定要不要过 floor 屏障（Codex 第二轮 #9）：
  //    只有 quarantine / quarantine-tx / attic 这类**本机既有证据**才允许 floor: null；
  //    只要有任何一项来自 registry，就必须由调用方显式给 floor —— 否则拒绝，
  //    不得用 `opts.floor ?? null` 把检查悄悄跳掉。
  const fromRegistry = Object.values(I.plan.items)
    .some((p) => p.restore_from?.source === 'registry');
  if (fromRegistry && !opts.floor) {
    bad('repair child 从 registry 重新解析安装，必须显式给 opts.floor（提交点前要复验 trust floor）');
  }
  const J = commitPoint(CP, plan, { floor: fromRegistry ? opts.floor : null, repairId: I.repair_id });
  // child journal 成功提交（phase = prepared 落盘）之后，才把 committed 翻成 true
  writeIntent(P, { ...I, child: { ...I.child, committed: true } });
  applyItems(target, J, CP);
  verifyAndCommit(target, J, CP);
  runCleanup(target, J, CP, opts);
}

/** 把 `restore_from` 指定的介质**无跟随复制**到 child 的 unpack 区，返回该目录 */
function materializeRestore(P, Q, I, name, p, CP, opts) {
  const rf = p.restore_from;
  const want = p.target.digest;
  const dest = join(CP.unpack, name);
  if (existsSync(dest)) rmtreeFsync(dest);
  mkdirChainFsync(join(dest, '..'));

  if (rf.source === 'quarantine' || rf.source === 'quarantine-tx') {
    const src = rf.source === 'quarantine' ? join(Q.targets, name) : join(Q.tx, rf.slot, name);
    // ①a 复制前：该候选 slot 的实测摘要 == target.digest
    if (safeDigest(src) !== want) bad(`repair：${rf.source} 介质摘要不符（①a）`);
    // ①b 复制前：隔离 tx 的 geoly-tx-v1 指纹 == isolate.tx.fingerprint
    if (txDigest(Q.tx) !== I.isolate.tx.fingerprint) bad('repair：隔离 tx 指纹在复制前已不符（①b）');
    copyReadOnly(src, dest);
    // ② 复制后：**再验一次**隔离 tx 的指纹（后验能发现持续性篡改）
    if (txDigest(Q.tx) !== I.isolate.tx.fingerprint) bad('repair：隔离 tx 指纹在复制后不符（②）');
    // ③ stage 完成后：除摘要外**重跑目标树的完整结构校验**
    const m = strictlyMatches(dest, want);
    if (!m.ok) bad(`repair：复制出来的树未通过结构校验（③）：${m.why}`);
    return dest;
  }
  const mAttic = /^attic\/(\d+)$/.exec(rf.source);
  if (mAttic) {
    const g = mAttic[1];
    restoreArchive(join(P.atticDir, g, `${name}.tar`), dest, want);
    const m = strictlyMatches(dest, want);
    if (!m.ok) bad(`repair：attic 还原出来的树未通过结构校验：${m.why}`);
    return dest;
  }
  if (rf.source === 'registry') {
    if (!opts.resolver) bad(`repair：source=registry 需要注入 resolver（不在内核范围）`);
    const r = opts.resolver(name);
    // 🔴 调用方已过完整验证链；这里再验一次落位后的摘要与结构，不因「上游说验过了」而放行
    copyReadOnly(r.dir, dest);
    const m = strictlyMatches(dest, want);
    if (!m.ok) bad(`repair：registry 还原出来的树未通过结构校验：${m.why}`);
    return dest;
  }
  return bad(`repair：未知 restore_from.source ${rf.source}`);
}

/** 🔴 **无跟随复制**。禁止 rename、禁止 hardlink、禁止以任何方式修改 quarantine 内容。 */
function copyReadOnly(src, dest) {
  mkdirChainFsync(dest);
  for (const name of readdirSync(src).sort()) {
    const abs = join(src, name);
    const st = require$lstat(abs);
    if (st.isSymbolicLink()) bad(`repair 复制：拒绝 symlink ${abs}`);
    if (st.isDirectory()) { copyReadOnly(abs, join(dest, name)); continue; }
    if (!st.isFile()) bad(`repair 复制：拒绝非普通文件 ${abs}`);
    writeAtomic(join(dest, name), readFileSync(abs));
    const mode = st.mode & 0o777;
    if (mode !== 0o644) require$chmod(join(dest, name), mode);
  }
}

// 这两个只在 copyReadOnly 里用到，单独引出来是为了让「除此之外全部走 atomic-fs」一眼可查
import { lstatSync as require$lstat, chmodSync as require$chmod } from 'node:fs';

export { REVERSE_OP };
