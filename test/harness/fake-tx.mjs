// 假事务 —— 故障注入框架的**自证载体**。
//
// 为什么需要它：事务内核（§5.2 十步 / §5.3 段模型 / §5.6 三阶段清理 / §5.4.1 rollback）
// 还没实现，而 M0 §6 要求框架**先于**它落地。假事务是最小但**同构**的替身：
// 同样的状态文件布局、同样的段顺序、同样的原子写纪律，因此
//   · 现在就能证明框架能在任意一个注入点上崩掉并验证不变式；
//   · 事务内核落地后，把 CATALOG 里那些点的 owner 从「fake-tx」换成真实模块即可，
//     注入点名字与不变式一个都不用改。
//
// 🔴 刻意**不**做的事：真 tar（用一份确定性 archive 顶替）、锁、下载、验签、
//    多 target、pack。那些不影响崩溃恢复的形状。
//
// 规格：04-install.md §5.2 / §5.2.1 / §5.3 / §5.4 / §5.4.1 / §5.6，11-wire-contract.md §5。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify, parseStrict } from '../../src/canonical-json.mjs';
import { treeDigest } from '../../src/tree-digest.mjs';
import {
  writeAtomic, mkdirChainFsync, renameDirFsync, rmtreeFsync, fsyncDir,
} from '../../src/atomic-fs.mjs';
import { fp } from '../../src/fault-inject.mjs';
import { crc32cHex } from './crc32c.mjs';

export class Corrupt extends Error {
  constructor(msg) { super(`corrupt: ${msg}`); this.name = 'Corrupt'; this.corrupt = true; }
}

// ── 布局 ─────────────────────────────────────────────────────────────────────

export function layout(target, gen) {
  const state = join(target, '.geoly');
  return {
    target,
    state,
    ledger: join(state, 'ledger.json'),
    journalDir: join(state, 'journal'),
    journal: gen === undefined ? null : join(state, 'journal', `${gen}.json`),
    tx: gen === undefined ? null : join(state, `tx-${gen}`),
    stage: gen === undefined ? null : join(state, `tx-${gen}`, 'stage'),
    retired: gen === undefined ? null : join(state, `tx-${gen}`, 'retired'),
    attic: gen === undefined ? null : join(state, 'attic', String(gen)),
  };
}

// ── 树的物化与读取 ───────────────────────────────────────────────────────────

/** files: { 'rel/path': '内容' } */
export function materialize(dir, files) {
  mkdirChainFsync(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirChainFsync(join(abs, '..'));
    writeAtomic(abs, content);
  }
  fsyncDir(dir);
}

function readTree(dir) {
  const out = {};
  (function rec(d, prefix) {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) rec(abs, prefix + name + '/');
      else out[prefix + name] = readFileSync(abs, 'utf8');
    }
  })(dir, '');
  return out;
}

/** 确定性 archive —— 顶替 tar。它自己带一份 tree_digest，于是三方比对是真的三方。 */
function writeArchive(path, srcDir) {
  const body = stringify({
    schema: 'geoly.fake.archive/1',
    files: readTree(srcDir),
    tree_digest: treeDigest(srcDir),
  });
  writeAtomic(path, body);
}

export function readArchive(path) {
  return parseStrict(readFileSync(path, 'utf8'));
}

/**
 * 🔴 archive 的摘要必须**从内容重算**，不能只信它自带的 `tree_digest` 字段
 * （Codex 第二轮 P0-3）：否则一份 `tree_digest` 写对、`files` 写错的 archive
 * 会被当成合法备份，而它正是「唯一那份旧副本」。
 */
export function archiveDigest(a) {
  const dir = join(mkdtempSync(join(tmpdir(), 'fx-ar-')), 'v');
  try {
    materialize(dir, a.files);
    return treeDigest(dir);
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
}

/** 从磁盘完整重验一份 archive；返回重算出来的摘要 */
export function verifyArchive(path, expectDigest) {
  const a = readArchive(path);
  if (a.schema !== 'geoly.fake.archive/1') throw new Corrupt(`archive schema 不符 ${path}`);
  const real = archiveDigest(a);
  if (real !== a.tree_digest) throw new Corrupt(`archive 自称 ${a.tree_digest}，内容实算 ${real}`);
  if (expectDigest !== undefined && real !== expectDigest) {
    throw new Corrupt(`archive 摘要 ${real} 与期望 ${expectDigest} 不符 ${path}`);
  }
  return real;
}

function restoreArchive(path, destDir, expectDigest) {
  verifyArchive(path, expectDigest);           // 先重验，再还原
  materialize(destDir, readArchive(path).files);
  if (treeDigest(destDir) !== expectDigest) throw new Corrupt(`archive 还原后摘要不符 ${path}`);
}

// ── journal / ledger 读写 ────────────────────────────────────────────────────

export function writeJournal(paths, obj) {
  const { crc32c: _drop, ...rest } = obj;
  const withCrc = { ...rest, crc32c: crc32cHex(Buffer.from(stringify(rest), 'utf8')) };
  writeAtomic(paths.journal, stringify(withCrc));
}

export function readJournal(path) {
  const text = readFileSync(path, 'utf8');
  const obj = parseStrict(text);
  const { crc32c: got, ...rest } = obj;
  if (typeof got !== 'string') throw new Corrupt(`journal 缺 crc32c：${path}`);
  const want = crc32cHex(Buffer.from(stringify(rest), 'utf8'));
  if (got !== want) throw new Corrupt(`journal crc32c 不符：${path} 记 ${got}，实算 ${want}`);
  return obj;
}

export function writeLedger(paths, obj) {
  writeAtomic(paths.ledger, stringify(obj));
}

export function readLedger(path) {
  return parseStrict(readFileSync(path, 'utf8'));
}

const emptyLedger = () => ({
  schema: 'geoly.skills.ledger/2',
  audit_archived_until: 0,
  entries: {},
  last_applied_generation: 0,
  transaction: null,
});

// ── §5.4 的幂等 rename（五分支，规范强制）───────────────────────────────────

export function idempotentRenameDir(from, to, expectDigest) {
  const hasFrom = existsSync(from);
  const hasTo = existsSync(to);
  if (hasTo && treeDigest(to) === expectDigest) {
    if (hasFrom) throw new Corrupt(`分支②：${to} 已正确但 ${from} 也在（外部重建过源）`);
    return 'skipped';                                   // 分支①
  }
  if (!hasTo && hasFrom) {
    if (treeDigest(from) !== expectDigest) throw new Corrupt(`分支④：${from} 摘要不符`);
    renameDirFsync(from, to);                           // 分支③
    return 'done';
  }
  if (!hasTo && !hasFrom) throw new Corrupt(`分支⑤：${from} 与 ${to} 都不存在`);
  throw new Corrupt(`${to} 存在但摘要不符`);
}

/** §5.4：journal 原子写失败留下的 `.tmp` 一律忽略并删除 */
export function sweepTmp(dir) {
  if (!existsSync(dir)) return [];
  const gone = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.tmp')) { rmtreeFsync(join(dir, name)); gone.push(name); }
  }
  return gone;
}

// ── 计划 ─────────────────────────────────────────────────────────────────────

/**
 * items: [{ name, op: 'swap'|'install-new'|'retire-only', oldFiles?, newFiles? }]
 * 返回一个可序列化的 plan，正向与恢复共用。
 */
export function makePlan(target, gen, items) {
  return { generation: gen, tx_dir: `tx-${gen}`, items: items.map((i) => ({ ...i })) };
}

// ── 正向：第 5–10 步 ─────────────────────────────────────────────────────────

export function runForward(target, plan) {
  const { J, P } = runForwardPrepared(target, plan);
  verifyAndCommit(target, J, P);
  runCleanup(target, J, P);
  return J;
}

/**
 * 只跑第 5–7 步，停在「已交换、phase 仍是 prepared」。
 * 给 rollback 与 repair 场景造现场用 —— 那两个场景的**输入**就是一个未收尾的事务。
 */
export function runForwardPrepared(target, plan) {
  const gen = plan.generation;
  const P = layout(target, gen);
  const sorted = [...plan.items].sort((a, b) => (a.name < b.name ? -1 : 1));

  // ── 第 5 步：建 tx 目录链、把新树放入 stage、重算摘要 ─────────────────────
  mkdirChainFsync(P.stage);
  mkdirChainFsync(P.retired);
  const jitems = {};
  for (const it of sorted) {
    const rec = { op: it.op, had_old: it.op !== 'install-new', state: 'planned' };
    if (it.op !== 'retire-only') {
      materialize(join(P.stage, it.name), it.newFiles);
      rec.new_digest = treeDigest(join(P.stage, it.name));
    }
    if (rec.had_old) {
      // §5.6：old_digest 必须是「首次 rename 之前的实测值」
      rec.old_digest = treeDigest(join(target, it.name));
    }
    jitems[it.name] = rec;
  }

  const ledgerExisted = existsSync(P.ledger);
  const pre = ledgerExisted ? readLedger(P.ledger) : emptyLedger();
  const post = structuredClone(pre);
  post.last_applied_generation = gen;
  for (const it of sorted) {
    if (it.op === 'retire-only') delete post.entries[it.name];
    else post.entries[it.name] = { generation: gen, tree_digest: jitems[it.name].new_digest };
  }
  post.transaction = null;

  // ── 第 6 步：提交点。ledger 与 journal 各自原子写 ─────────────────────────
  fp('tx:step6:pre-ledger', { gen });
  writeLedger(P, { ...pre, transaction: { generation: gen, tx_dir: plan.tx_dir } });
  fp('tx:step6:between-ledger-journal', { gen });
  mkdirChainFsync(P.journalDir);
  const J = {
    schema: 'geoly.skills.journal/1',
    generation: gen,
    tx_dir: plan.tx_dir,
    phase: 'prepared',
    items: jitems,
    ledger_image: { ledger_existed: ledgerExisted, pre, post },
  };
  writeJournal(P, J);
  fp('tx:step6:post-journal', { gen });

  // ── 第 7 步：逐项交换（§5.3）─────────────────────────────────────────────
  applyItems(target, J, P);
  return { J, P };
}

/** §5.3 的段序列，写成幂等的 —— 正向首跑与 `--continue` 共用同一段代码 */
function applyItems(target, J, P) {
  for (const name of Object.keys(J.items).sort()) {
    const it = J.items[name];
    const T = join(target, name);
    const R = join(P.retired, name);
    const S = join(P.stage, name);

    if (it.had_old && it.state === 'planned') {
      fp('tx:item:pre-retire-rename', { name });
      idempotentRenameDir(T, R, it.old_digest);
      fp('tx:item:post-retire-rename', { name });
      it.state = 'retired';
      writeJournal(P, J);
      fp('tx:item:post-state-retired', { name });
    }
    if (it.op === 'retire-only') {
      if (it.state === 'retired') {
        it.state = 'verified';                 // §5.3：无新树可验，直接 verified
        writeJournal(P, J);
      }
      continue;
    }
    if (it.state === 'planned' || it.state === 'retired') {
      fp('tx:item:pre-swap-rename', { name });
      idempotentRenameDir(S, T, it.new_digest);
      fp('tx:item:post-swap-rename', { name });
      it.state = 'swapped';
      writeJournal(P, J);
      fp('tx:item:post-state-swapped', { name });
    }
  }
}

function verifyAndCommit(target, J, P) {
  // 第 8 步：对落位目录重算摘要
  for (const name of Object.keys(J.items).sort()) {
    const it = J.items[name];
    if (it.state !== 'swapped') continue;
    const got = treeDigest(join(target, name));
    if (got !== it.new_digest) {
      it.state = 'corrupt';
      writeJournal(P, J);
      throw new Corrupt(`第 8 步校验不符：${name}`);
    }
    it.state = 'verified';
    writeJournal(P, J);
    fp('tx:step8:post-state-verified', { name });
  }
  if (J.phase !== 'prepared') return;

  // 第 9 步：账本 + journal 置 cleanup_pending
  fp('tx:step9:pre-ledger', {});
  writeLedger(P, { ...J.ledger_image.post, transaction: { generation: J.generation, tx_dir: J.tx_dir } });
  fp('tx:step9:between-ledger-journal', {});
  for (const it of Object.values(J.items)) it.state = 'done';
  J.phase = 'cleanup_pending';
  writeJournal(P, J);
  fp('tx:step9:post-journal', {});
}

// ── §5.6 三阶段清理 ──────────────────────────────────────────────────────────

export function runCleanup(target, J, P) {
  const names = Object.keys(J.items).sort();

  // 【阶段 A】全部 tar 先落地，一棵 retired 都不删
  for (const name of names) {
    const it = J.items[name];
    if (it.cleanup === 'done') continue;
    if (it.cleanup === 'tar_durable') {
      // 🔴 §5.6 前提 1：journal 说 tar_durable 不算数，**每次都要从磁盘重验 A**。
      //    journal 说 durable 而磁盘上 A 损坏 → corrupt 停机（Codex 第二轮 P0-3）。
      if (it.had_old) verifyArchive(join(P.attic, `${name}.tar`), it.old_digest);
      continue;
    }
    if (!it.had_old) { it.cleanup = 'tar_durable'; writeJournal(P, J); continue; }
    const R = join(P.retired, name);
    const tarTmp = join(P.attic, `${name}.tar.tmp`);
    const tar = join(P.attic, `${name}.tar`);
    mkdirChainFsync(P.attic);
    if (!existsSync(tar)) {
      sweepTmp(P.attic);                       // §5.4：.tmp 残留一律先删再重写
      writeArchive(tarTmp, R);
      fp('cleanup:A:post-tar-tmp', { name });
      // ② 🔴 三方比对：tar 内容（**重算**，不信字段）== retired/<name>/ == journal.old_digest
      const aDigest = verifyArchive(tarTmp);
      const rDigest = treeDigest(R);
      if (aDigest !== rDigest || rDigest !== it.old_digest) {
        throw new Corrupt(`阶段 A 三方比对失败：${name}`);
      }
      fp('cleanup:A:post-compare', { name });
      renameDirFsync(tarTmp, tar);
      fp('cleanup:A:post-tar-rename', { name });
    } else {
      // 🔴 §5.6 前提 1：崩在 checkpoint 之前必须从磁盘重验 A，不能只信 journal
      verifyArchive(tar, it.old_digest);
    }
    it.cleanup = 'tar_durable';
    writeJournal(P, J);
    fp('cleanup:A:post-state-tar-durable', { name });
  }

  // 【阶段 B】全部 tar 都 durable 之后，写整代 manifest
  if (J.manifest !== 'durable') {
    fp('cleanup:B:pre-manifest', {});
    mkdirChainFsync(P.attic);
    writeAtomic(join(P.attic, 'manifest.json'), stringify({
      schema: 'geoly.skills.attic-manifest/1',
      generation: J.generation,
      items: Object.fromEntries(names.map((n) => [n, {
        op: J.items[n].op,
        tar: J.items[n].had_old ? `${n}.tar` : null,
        old_digest: J.items[n].old_digest ?? null,
      }])),
      postimage: J.ledger_image.post,
    }));
    fp('cleanup:B:post-manifest', {});
    J.manifest = 'durable';
    writeJournal(P, J);
    fp('cleanup:B:post-state-manifest-durable', {});
  }

  // 【阶段 C】才允许删
  for (const name of names) {
    const it = J.items[name];
    if (it.cleanup === 'done') continue;
    if (it.had_old) {
      fp('cleanup:C:pre-rmtree', { name });
      rmtreeFsync(join(P.retired, name));
      fp('cleanup:C:post-rmtree', { name });
    }
    it.cleanup = 'done';
    writeJournal(P, J);
    fp('cleanup:C:post-state-done', { name });
  }

  rmtreeFsync(P.tx);
  fp('cleanup:post-tx-rm', {});
  J.phase = 'completed';
  writeJournal(P, J);
  fp('cleanup:post-phase-completed', {});
  const led = readLedger(P.ledger);
  writeLedger(P, { ...led, transaction: null });
  fp('cleanup:post-clear-transaction', {});
}

// ── §5.4.1 rollback：自己也是一个有 journal 的方向 ──────────────────────────

/**
 * 入场分类（§5.4.1 封闭表的最小子集）。
 * 🔴 铁律：**绝不从正向的 item.state 推断物理位置** —— 一律实测 T / R / S / A。
 */
function classify(target, J, P, name) {
  const it = J.items[name];
  const T = join(target, name), R = join(P.retired, name), S = join(P.stage, name);
  const dT = existsSync(T) ? treeDigest(T) : null;
  const dR = existsSync(R) ? treeDigest(R) : null;
  const dS = existsSync(S) ? treeDigest(S) : null;
  const tarPath = P.attic ? join(P.attic, `${name}.tar`) : null;
  // 🔴 attic 是否算「可用恢复源」必须**重验内容**，不能只看文件在不在
  let aOk = false;
  if (tarPath && existsSync(tarPath)) {
    try { verifyArchive(tarPath, it.old_digest); aOk = true; } catch { aOk = false; }
  }
  const where = `${name}：T=${dT} R=${dR} S=${dS} A=${aOk}`;

  if (it.op === 'install-new') {
    if (dT === it.new_digest && dS === null) return 'as-installed';
    if (dT === null && dS === it.new_digest) return 'noop';
    throw new Corrupt(`install-new 入场分类不合法 ${where}`);
  }
  if (it.op === 'retire-only') {
    if (dT === it.old_digest && dR === null) return 'noop';
    if (dT === null && dR === it.old_digest) return 'as-retired';
    if (dT === null && dR === null && aOk) return 'as-retired-cleaned';
    throw new Corrupt(`retire-only 入场分类不合法 ${where}`);
  }
  // op = swap
  if (dT === it.old_digest && dR === null) return 'noop';
  if (dT === null && dR === it.old_digest) return 'as-retired';
  if (dT === it.new_digest && dR === it.old_digest) return 'as-swapped';
  if (dT === it.new_digest && dR === null && aOk) return 'as-swapped-cleaned';
  throw new Corrupt(`swap 入场分类不合法 ${where}`);
}

export function beginRollback(target, J, P) {
  const rb = { items: {} };
  // 🔴 **先把全部项分类完（含恢复源预检），确认都能回滚，才允许写 direction。**
  //    classify 抛 Corrupt 时 direction 还没落盘 —— 否则一条死路会被永久锁进 rollback
  //    方向，而 §5.4.1 又规定 direction 一旦持久化就不许转回正向（Codex 第二轮 P0-4）。
  for (const name of Object.keys(J.items).sort()) {
    const entry_class = classify(target, J, P, name);
    // noop 没有任何反向段要跑，初始就是 restored
    rb.items[name] = { entry_class, rstate: entry_class === 'noop' ? 'restored' : 'pending' };
  }
  fp('rollback:pre-direction', {});
  // 🔴 direction 与 rollback 同时存在；且分类结果**写完再动手**
  J.direction = 'rollback';
  J.rollback = rb;
  writeJournal(P, J);
  fp('rollback:post-direction', {});
  return J;
}

export function runRollback(target, J, P) {
  if (J.direction !== 'rollback') throw new Corrupt('runRollback：direction 不是 rollback');
  for (const name of Object.keys(J.rollback.items).sort()) {
    const r = J.rollback.items[name];
    const it = J.items[name];
    const T = join(target, name), R = join(P.retired, name), S = join(P.stage, name);

    if (r.rstate === 'restored') continue;

    const needsPark = r.entry_class === 'as-swapped'
      || r.entry_class === 'as-swapped-cleaned'
      || r.entry_class === 'as-installed';

    if (needsPark && r.rstate === 'pending') {
      fp('rollback:item:pre-park-t', { name });
      idempotentRenameDir(T, S, it.new_digest);
      fp('rollback:item:post-park-t', { name });
      r.rstate = 't_parked';
      writeJournal(P, J);
    } else if (r.rstate === 'pending') {
      r.rstate = 't_parked';
      writeJournal(P, J);
    }

    fp('rollback:item:pre-restore', { name });
    if (r.entry_class === 'as-retired' || r.entry_class === 'as-swapped') {
      idempotentRenameDir(R, T, it.old_digest);
    } else if (r.entry_class === 'as-swapped-cleaned' || r.entry_class === 'as-retired-cleaned') {
      if (!existsSync(T)) restoreArchive(join(P.attic, `${name}.tar`), T, it.old_digest);
      if (treeDigest(T) !== it.old_digest) throw new Corrupt(`attic 还原后摘要不符 ${name}`);
    } // noop / as-installed：本来就不该有旧树
    fp('rollback:item:post-restore', { name });
    r.rstate = 'restored';
    writeJournal(P, J);
    fp('rollback:item:post-rstate', { name });
  }

  // 终结：账本回到 pre；🔴 direction 与 rollback **同一次原子写**删掉
  const { ledger_existed: existed, pre } = J.ledger_image;
  writeLedger(P, existed ? pre : { ...emptyLedger(), transaction: null });
  delete J.direction;
  delete J.rollback;
  J.phase = 'completed';
  writeJournal(P, J);
  fp('rollback:post-finalize', {});
  rmtreeFsync(P.tx);
  const led = readLedger(P.ledger);
  writeLedger(P, { ...led, transaction: null });
  return J;
}

// ── §5.2 第 2 步 + §5.4 幂等前向恢复 ────────────────────────────────────────

/**
 * 恢复。返回 { outcome, detail }。
 *   outcome ∈ 'nothing' | 'pre-commit-discarded' | 'resumed-forward'
 *           | 'resumed-rollback' | 'cleanup-finished' | 'residue-cleared'
 * 🔴 恢复只允许「前进」或「fail-closed 抛 Corrupt」，绝不静默半成功。
 */
export function recover(target) {
  const P0 = layout(target);
  if (!existsSync(P0.state)) return { outcome: 'nothing' };
  sweepTmp(P0.state);
  sweepTmp(P0.journalDir);

  const txDirs = readdirSync(P0.state).filter((n) => n.startsWith('tx-')).sort();
  const journals = existsSync(P0.journalDir)
    ? readdirSync(P0.journalDir).filter((n) => n.endsWith('.json')).sort()
    : [];

  // 有 tx 无 journal → pre-commit，直接删（§5.4.2 双文件规则）
  if (journals.length === 0) {
    if (txDirs.length === 0) return { outcome: 'nothing' };
    for (const d of txDirs) rmtreeFsync(join(P0.state, d));
    if (existsSync(P0.ledger)) {
      const led = readLedger(P0.ledger);
      if (led.transaction) writeLedger(P0, { ...led, transaction: null });
    }
    return { outcome: 'pre-commit-discarded', detail: txDirs };
  }

  // 🔴 多代共存是**正常**的：completed 的 journal 是残留，不是损坏
  //    （Codex 第二轮 P0-2 —— 以前一律判 corrupt，第二代事务直接跑不起来）。
  //    只有「不止一个未完成事务」才是真的 corrupt。
  const gens = journals.map((f) => Number(f.replace('.json', ''))).sort((a, b) => a - b);
  const live = gens.filter((g) => readJournal(layout(target, g).journal).phase !== 'completed');
  if (live.length > 1) throw new Corrupt(`同时存在 ${live.length} 个未完成事务：${live.join(',')}`);
  const gen = live.length === 1 ? live[0] : gens[gens.length - 1];
  const P = layout(target, gen);
  const J = readJournal(P.journal);
  sweepTmp(P.attic ?? P.state);

  if (J.phase === 'completed') {
    let touched = false;
    if (existsSync(P.tx)) { rmtreeFsync(P.tx); touched = true; }
    if (existsSync(P.ledger)) {
      const led = readLedger(P.ledger);
      if (led.transaction) { writeLedger(P, { ...led, transaction: null }); touched = true; }
    }
    return { outcome: touched ? 'residue-cleared' : 'nothing' };
  }

  // 🔴 direction=rollback 一旦持久化，只能续做 rollback，不得转回正向
  if (J.direction === 'rollback') {
    if (!J.rollback) throw new Corrupt('direction 与 rollback 必须同时存在');
    runRollback(target, J, P);
    return { outcome: 'resumed-rollback' };
  }
  if (J.rollback) throw new Corrupt('有 rollback 却没有 direction');

  if (J.phase === 'cleanup_pending') {
    runCleanup(target, J, P);
    return { outcome: 'cleanup-finished' };
  }
  if (J.phase !== 'prepared') throw new Corrupt(`未知 phase ${J.phase}`);
  if (Object.values(J.items).some((i) => i.state === 'corrupt')) {
    throw new Corrupt('有 item 处于 corrupt，需 recover --rollback');
  }

  applyItems(target, J, P);
  verifyAndCommit(target, J, P);
  runCleanup(target, J, P);
  return { outcome: 'resumed-forward' };
}

/** 恢复到 rollback 方向（`recover --rollback`）。事务未 completed 时可用。 */
export function recoverRollback(target) {
  const P0 = layout(target);
  if (!existsSync(P0.journalDir)) return recover(target);
  sweepTmp(P0.state);
  sweepTmp(P0.journalDir);
  const journals = readdirSync(P0.journalDir).filter((n) => n.endsWith('.json')).sort();
  if (journals.length === 0) return recover(target);
  const gen = Number(journals[0].replace('.json', ''));
  const P = layout(target, gen);
  const J = readJournal(P.journal);
  if (J.phase === 'completed') return recover(target);
  if (J.direction === 'rollback') { runRollback(target, J, P); return { outcome: 'resumed-rollback' }; }
  if (Object.values(J.items).some((i) => i.state === 'corrupt')) {
    throw new Corrupt('任一项 corrupt → 整个事务不允许 rollback');
  }
  beginRollback(target, J, P);
  runRollback(target, J, P);
  return { outcome: 'rolled-back' };
}

// ── 快照（不变式 I7 的收敛判据）─────────────────────────────────────────────

/** 把 target 与 .geoly 整棵树摘成一个可比较的字符串。忽略 .tmp（按定义未提交）。 */
export function snapshot(target) {
  const lines = [];
  (function rec(dir, prefix) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.tmp')) continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) { lines.push(`d ${prefix}${name}/`); rec(abs, `${prefix}${name}/`); }
      else lines.push(`f ${prefix}${name} ${readFileSync(abs, 'utf8').length}`);
    }
  })(target, '');
  return lines.join('\n');
}

export { emptyLedger };

/** 建一个干净的 target 与初始旧树 */
export function seed(target, oldTrees) {
  mkdirChainFsync(target);
  for (const [name, files] of Object.entries(oldTrees)) materialize(join(target, name), files);
  return target;
}

export function mkTargetDir(base) {
  mkdirSync(base, { recursive: true, mode: 0o755 });
  return base;
}
