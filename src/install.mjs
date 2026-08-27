// install —— §5.2 的第 5–10 步、§5.3 的逐项段模型、§5.6 的三阶段清理，
// 外加 attic 归档用的 canonical ustar 写入与重验。
//
// 规格：04-install.md §5.2 / §5.2.1 / §5.3 / §5.4（幂等五分支）/ §5.6 / §5.7、
// 01-artifacts.md §4/§5/§6、ERRATA E-5（尾部恰好两个零块）、E-6（不 shell out）。
//
// 🔴 本模块**不 import recover.mjs**。段函数（`applyItems` / `verifyAndCommit` /
//    `runCleanup` / `idempotentRenameDir`）在这里导出，由 recover 复用 ——
//    「正向首跑与 --continue 共用同一段代码」是 §5.4 幂等前向恢复的前提。

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stringify } from './canonical-json.mjs';
import { treeDigest } from './tree-digest.mjs';
import {
  writeAtomic, mkdirChainFsync, renameDirFsync, rmtreeFsync, fsyncDir, sameDevice,
} from './atomic-fs.mjs';
import { fp } from './fault-inject.mjs';
import { parseTar, canonicalUstarSplit, assertArtifactPath } from './untar.mjs';
import { writeEntries } from './artifact.mjs';
import {
  Corrupt, bad, readJournal, writeJournal, sweepTmp, JOURNAL_SCHEMA,
} from './journal.mjs';
import {
  layout, readLedger, writeLedger, applyImageSide, isGenerationFrozen,
} from './ledger.mjs';
import { buildManifest, validateManifest, strictlyMatches, REVERSE_OP } from './plan.mjs';
import { readJsonStrict } from './journal.mjs';
import { assertFloorUnchanged } from './trust.mjs';

export { Corrupt };

const BLOCK = 512;

// ════════════════════════════════════════════════════════════════════════════
// canonical ustar 写入（attic 的 `<name>.tar`）
// ════════════════════════════════════════════════════════════════════════════

function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width - 1) bad(`tar：数值 ${n} 放不进 ${width} 字节的八进制域`);
  return Buffer.from(s.padStart(width - 1, '0') + '\0', 'latin1');
}

/**
 * 🔴 E-5/E-6：**自己写字节，不 shell out 到系统 tar**。
 * macOS 的 `tar` 会注入 AppleDouble（`._*`）成员携带 xattr，而 `tar -tvf` 看不见它 ——
 * 打出来的包会被我们自己的校验器拒掉，打包的人却只会觉得校验器有 bug。
 *
 * 形状与 src/untar.mjs 的 `parseTar` 逐条对齐：ustar 普通文件条目、
 * uid/gid/mtime/dev 全 0、uname/gname 空、mode ∈ {0644,0755}、
 * 路径按 canonical ustar 切分、按 path 字节序严格升序、**尾部恰好两个零块**。
 */
export function writeCanonicalTar(entries) {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const chunks = [];
  let prev = null;
  for (const e of sorted) {
    if (prev !== null && prev === e.path) bad(`tar：重复路径 ${e.path}`);
    prev = e.path;
    // 🔴 写入端必须走**和读取端同一条**路径校验，否则我们能写出自己读不回来的
    // 归档：`writeCanonicalTar([{path:'../x'}])` 原本会成功，而 parseTar 报
    // E_PATH_DOTDOT。这与 devmajor 那次是同一类错误 —— 写入端与读取端各自
    // 合理但接受集合不同。判据：**writer 接受的每一个输入，parser 都必须接受。**
    assertArtifactPath(e.path, `tar:${e.path}`);
    const split = canonicalUstarSplit(e.path);
    if (split === null) bad(`tar：路径无法被 ustar 切分：${e.path}`);
    if (e.mode !== 0o644 && e.mode !== 0o755) bad(`tar：mode 只允许 0644/0755，得到 0${e.mode.toString(8)}`);
    const h = Buffer.alloc(BLOCK);
    Buffer.from(split.name, 'utf8').copy(h, 0);
    octal(e.mode, 8).copy(h, 100);
    octal(0, 8).copy(h, 108);              // uid
    octal(0, 8).copy(h, 116);              // gid
    octal(e.data.length, 12).copy(h, 124); // size
    octal(0, 12).copy(h, 136);             // mtime
    h.fill(0x20, 148, 156);                // chksum 先填空格
    h[156] = 0x30;                         // typeflag '0'
    Buffer.from('ustar\0', 'latin1').copy(h, 257);
    Buffer.from('00', 'latin1').copy(h, 263);
    // 🔴 devmajor/devminor 必须显式写成 7 位八进制，不能留成 Buffer.alloc 的全 NUL。
    // 两种写法都表示 0，但 canonical 编码只能有一种 —— 摘要绑的是字节（ERRATA E-3）。
    // 合并时才发现：写入端留空 NUL、读取端（加固后）要求八进制，
    // 两边各自都说得通，一合就 15 个测试全红。往返测试见 test/install.test.mjs。
    octal(0, 8).copy(h, 329);              // devmajor
    octal(0, 8).copy(h, 337);              // devminor
    Buffer.from(split.prefix, 'utf8').copy(h, 345);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += h[i];
    // POSIX：6 位八进制 + NUL + 空格
    Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'latin1').copy(h, 148);
    chunks.push(h, e.data);
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(2 * BLOCK));    // 🔴 恰好两个零块，不多不少
  return Buffer.concat(chunks);
}

/** 把一棵树读成 tar 条目（无跟随；类型/mode 由 treeDigest 的同一套规则把关） */
export function treeToEntries(root) {
  const out = [];
  (function rec(dir) {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) bad(`归档：拒绝 symlink ${abs}`);
      if (st.isDirectory()) { rec(abs); continue; }
      if (!st.isFile()) bad(`归档：拒绝非普通文件 ${abs}`);
      if (st.nlink !== 1) bad(`归档：拒绝 hardlink ${abs}`);
      const mode = st.mode & 0o777;
      out.push({ path: relative(root, abs).split(sep).join('/'), mode, data: readFileSync(abs) });
    }
  })(root);
  return out;
}

/**
 * 🔴 从磁盘**重算**归档的树摘要 —— 不信任何自称的字段。
 * 解到一个隔离目录再算，复用 `treeDigest` 这**唯一一份**实现
 *（自己再写一份 leaf 编码 = 两份实现可以互相不同意，而其中一份错了没人发现）。
 */
export function archiveDigest(tarPath, scratchParent) {
  const bytes = readFileSync(tarPath);
  const { entries } = parseTar(bytes);
  const dir = join(scratchParent, `.verify-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirChainFsync(dir);
  try {
    writeEntries(dir, entries);
    return treeDigest(dir);
  } finally {
    rmtreeFsync(dir);
  }
}

/** 完整重验一份 attic 归档；返回重算出来的摘要。`expect` 给了就必须相等。 */
export function verifyArchive(tarPath, expect, scratchParent) {
  if (!existsSync(tarPath)) bad(`attic 归档不存在：${tarPath}`);
  const real = archiveDigest(tarPath, scratchParent);
  if (expect !== undefined && real !== expect) {
    bad(`attic 归档摘要 ${real} 与期望 ${expect} 不符：${tarPath}`);
  }
  return real;
}

/** 把归档还原到 destDir 并重验（rollback 的 `as-*-cleaned` 用） */
export function restoreArchive(tarPath, destDir, expect) {
  const { entries } = parseTar(readFileSync(tarPath));
  if (existsSync(destDir)) rmtreeFsync(destDir);
  mkdirChainFsync(destDir);
  writeEntries(destDir, entries);
  const got = treeDigest(destDir);
  if (got !== expect) bad(`归档还原后摘要 ${got} 与期望 ${expect} 不符：${tarPath}`);
  return got;
}

// ════════════════════════════════════════════════════════════════════════════
// §5.4 的幂等 rename（五分支，规范强制）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 **两端都要验**（v10 只验 `Y`）：
 *   ① `Y` 存在且摘要 == 期望 **且 `X` 缺席** → 已完成，跳过；
 *   ② `Y` 存在且摘要符，**但 `X` 也存在** → 外部重建/替换过源 → **停机 corrupt**；
 *   ③ `Y` 缺席、`X` 存在且摘要 == 期望 → 执行；
 *   ④ `Y` 缺席、`X` 存在但摘要不符 → **停机 corrupt**；
 *   ⑤ 两者都不存在 → **停机 corrupt**。
 */
export function idempotentRenameDir(from, to, expectDigest) {
  const hasFrom = existsSync(from);
  const hasTo = existsSync(to);
  if (hasTo) {
    let dTo = null;
    try { dTo = treeDigest(to); } catch (e) { bad(`目标 ${to} 无法成像：${e.message}`); }
    if (dTo === expectDigest) {
      if (hasFrom) bad(`分支②：${to} 已正确但 ${from} 也在（外部重建过源）`);
      return 'skipped';                                   // ①
    }
    bad(`${to} 存在但摘要 ${dTo} != 期望 ${expectDigest}`);
  }
  if (!hasFrom) bad(`分支⑤：${from} 与 ${to} 都不存在`);
  let dFrom = null;
  try { dFrom = treeDigest(from); } catch (e) { bad(`源 ${from} 无法成像：${e.message}`); }
  if (dFrom !== expectDigest) bad(`分支④：${from} 摘要 ${dFrom} != 期望 ${expectDigest}`);
  renameDirFsync(from, to);                               // ③
  return 'done';
}

// ════════════════════════════════════════════════════════════════════════════
// 第 5 步：建 tx 目录链、把已验证的树放入 stage
// ════════════════════════════════════════════════════════════════════════════

function copyTreeFsync(src, dest) {
  mkdirChainFsync(dest);
  for (const name of readdirSync(src).sort()) {
    const abs = join(src, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) bad(`stage：拒绝 symlink ${abs}`);
    if (st.isDirectory()) { copyTreeFsync(abs, join(dest, name)); continue; }
    if (!st.isFile()) bad(`stage：拒绝非普通文件 ${abs}`);
    const to = join(dest, name);
    writeAtomic(to, readFileSync(abs));
    const mode = st.mode & 0o777;
    // writeAtomic 固定用 0644 建 tmp；0755 要补一次 chmod。
    // 🔴 这不是「信 chmod 成功」—— 第 5 步末尾会重算整棵树的摘要，mode 进摘要，
    //    chmod 没生效会在那里被抓住。
    if (mode !== 0o644) chmodSync(to, mode);
  }
  fsyncDir(dest);
}

/** 第 5 步。跨设备则复制 + fsync；同设备直接 rename 进来。 */
export function stageTrees(P, plan) {
  mkdirChainFsync(P.stage);
  mkdirChainFsync(P.retired);
  for (const [name, it] of Object.entries(plan.items)) {
    if (it.op === 'retire-only') continue;
    const dest = join(P.stage, name);
    if (existsSync(dest)) {
      // 幂等：已经 stage 过且摘要符就跳过（`.tmp` 一律先扫掉）
      if (treeDigest(dest) === it.new_digest) continue;
      rmtreeFsync(dest);
    }
    const src = plan.sources?.[name];
    if (!src || !existsSync(src)) bad(`第 5 步：${name} 没有可 stage 的源目录`);
    if (sameDevice(src, P.stage)) renameDirFsync(src, dest);
    else copyTreeFsync(src, dest);
    // 🔴 **重算树摘要** —— 不信调用方给的值
    const got = treeDigest(dest);
    if (got !== it.new_digest) bad(`第 5 步：${name} stage 后摘要 ${got} != 计划的 ${it.new_digest}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 第 6 步：提交点
// ════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 **提交点之前的最后一刻**：复验 trust floor（抗回滚在「解析」与「安装」之间的接缝）。
 *
 * 背景：`snapshot.resolveCurrent()` 推进 floor 之后就**释放了 metadata 锁**，之后才下载与安装。
 * 并发的另一个进程若在这个空档里把 floor 又推进一次，本进程仍会按**旧快照**装完。
 *
 * 🔴 **这是一次检查，不是提交屏障 —— 必须如实说清楚。**
 * 真屏障要在同一个临界区里持有 metadata 锁直到写入生效点，而那做不到：
 *   · §5.1 的全序是 `metadata → repo → target`，安装事务此刻已经持着 target 锁，
 *     再去取 metadata 锁就是**反序**，正是规范明令禁止的（会出现「双方各持一半」）；
 *   · `src/lock.mjs` 还**禁止重入**，同一进程不能对同一路径再 acquire 一次。
 * 因此闭合它需要改 §5.1 的加锁全序（或把 floor 的权威搬进 target 锁），属于规范级改动。
 *
 * 放在这里的理由：**提交点之前是最后一个「放弃是免费的」时刻**（target 未被改动，
 * tx 目录可直接丢弃）。过了提交点，事务已经被承诺，恢复只能续做或回滚，
 * 不得再拿「现在的 floor」去重新评估当初的选择 —— 否则一次并发推进就会把一个
 * 已提交的事务永久卡死。§5.8 的「`--from-generation` 豁免当前状态门」是同一条道理。
 *
 * 🔴 `floor` **必须显式给**：`undefined` 直接拒绝。没有 registry 出处的事务
 *    （从 attic 复位、从 quarantine 重建）要显式写 `floor: null` —— 让调用方**做决定**，
 *    而不是让「忘了传」静默等于「不检查」。
 */
export function assertFloorBarrier(opts) {
  if (!('floor' in opts)) {
    bad('提交点前的 trust floor 复验：opts.floor 必须显式给出（无 registry 出处时显式传 null）');
  }
  if (opts.floor === null) return { checked: false, reason: 'no-registry-provenance' };
  const { stateDir, expected } = opts.floor;
  if (!stateDir || !expected) bad('opts.floor 必须是 { stateDir, expected }');
  assertFloorUnchanged(stateDir, expected);      // E_FLOOR_MOVED / E_FLOOR_VANISHED
  return { checked: true };
}

/**
 * 🔴 ledger 与 journal **各自原子写**，中间可能只成功一个 —— §5.4.2 的双文件规则
 *    专治那一格。写 ledger 的是「transaction 指针」，不是 post。
 */
export function commitPoint(P, plan, opts = {}) {
  const { repairId } = opts;
  assertFloorBarrier(opts);
  const J = {
    schema: JOURNAL_SCHEMA,
    generation: plan.generation,
    items: plan.items,
    ledger_image: plan.ledger_image,
    phase: 'prepared',
    tx_dir: plan.tx_dir,
  };
  if (plan.adopt_assertions) J.adopt_assertions = plan.adopt_assertions;
  if (plan.unadopt_assertions) J.unadopt_assertions = plan.unadopt_assertions;
  if (repairId) J.repair_id = repairId;

  fp('tx:step6:pre-ledger', { gen: plan.generation });
  const L = readLedger(P.ledger);
  writeLedger(P.ledger, { ...L, transaction: { generation: plan.generation, tx_dir: plan.tx_dir } });
  fp('tx:step6:between-ledger-journal', { gen: plan.generation });
  mkdirChainFsync(P.journalDir);
  writeJournal(P.journal, J);
  fp('tx:step6:post-journal', { gen: plan.generation });
  return J;
}

// ════════════════════════════════════════════════════════════════════════════
// 第 7 步：§5.3 的逐项段（正向首跑与 --continue 共用）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 段模型：每个已持久化的 `state` 界定一个段，`--continue` = 把该段从头到尾
 *    幂等地重跑一遍。因此本函数**同时**是正向首跑与恢复续做的实现。
 *
 * `swap`      : planned →〔② T→R〕→ retired →〔④ S→T〕→ swapped
 * `install-new`: planned →〔④ S→T〕→ swapped
 * `retire-only`: planned →〔② T→R〕→ retired → verified（无新树可验）
 */
export function applyItems(target, J, P) {
  for (const name of Object.keys(J.items).sort()) {
    const it = J.items[name];
    if (it.state === 'corrupt') bad(`${name} 停在 corrupt，只能 --reinstall 或人工介入`);
    const T = join(target, name);
    const R = join(P.retired, name);
    const S = join(P.stage, name);

    if (it.had_old && it.state === 'planned') {
      // 🔴 §5.6：§5.3 的 ② 真正 rename **之前再实测一次并比对** —— 第 6 步与第 7 步
      //    之间用户可能改了 target。这一步就是幂等五分支里 planned 段的源端校验，
      //    不是另加一次独立断言。
      fp('tx:item:pre-retire-rename', { name });
      idempotentRenameDir(T, R, it.old_digest);
      fp('tx:item:post-retire-rename', { name });
      it.state = 'retired';
      writeJournal(P.journal, J);
      fp('tx:item:post-state-retired', { name });
    }

    if (it.op === 'retire-only') {
      if (it.state === 'retired') {
        it.state = 'verified';       // §5.3：无新树可验，从 retired **直接进 verified**
        writeJournal(P.journal, J);
      }
      continue;
    }

    if (it.state === 'planned' || it.state === 'retired') {
      fp('tx:item:pre-swap-rename', { name });
      idempotentRenameDir(S, T, it.new_digest);
      fp('tx:item:post-swap-rename', { name });
      it.state = 'swapped';
      writeJournal(P.journal, J);
      fp('tx:item:post-state-swapped', { name });
    }
  }
  return J;
}

// ════════════════════════════════════════════════════════════════════════════
// 第 8 / 9 步
// ════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 §4.2 / §5.10：`adopt` / `unadopt` 是**逻辑项**，写 ledger post **之前**必须
 *    再验一次目标目录仍满足断言。否则外部在初验之后改树，账本会**认领错误内容**。
 *    失败时把 `state` **原子持久化**为 `assertion-corrupt`（它不是物理 corrupt，分流不同）。
 */
export function reverifyAssertions(target, J, P) {
  const check = (key, name, a, what) => {
    const dir = join(target, name);
    const m = strictlyMatches(dir, a.tree_digest);
    if (m.ok) return true;
    if (a.state !== 'assertion-corrupt') {
      a.state = 'assertion-corrupt';
      writeJournal(P.journal, J);
    }
    bad(`${what} 断言失败（${key}[${name}]）：${m.why}`);
    return false;
  };
  for (const [name, a] of Object.entries(J.adopt_assertions ?? {})) {
    if (a.state === 'assertion-corrupt') {
      bad(`adopt[${name}] 处于 assertion-corrupt：--continue 拒绝，出路是 --rollback`);
    }
    check('adopt_assertions', name, a, 'adopt');
  }
  for (const [name, a] of Object.entries(J.unadopt_assertions ?? {})) {
    // unadopt 的 assertion-corrupt 的**唯一自动出路**就是这里：严格复验成功即转回 ok
    const dir = join(target, name);
    const m = strictlyMatches(dir, a.tree_digest);
    if (m.ok) {
      if (a.state !== 'ok') { a.state = 'ok'; writeJournal(P.journal, J); }
      continue;
    }
    if (a.state !== 'assertion-corrupt') {
      a.state = 'assertion-corrupt';
      writeJournal(P.journal, J);
    }
    bad(`unadopt[${name}] 断言失败：${m.why}。`
      + '首选出路：把该目录**严格恢复为断言的摘要**后再跑 recover --continue');
  }
}

export function verifyAndCommit(target, J, P) {
  // ── 第 8 步：对落位目录重算树摘要 ─────────────────────────────────────────
  for (const name of Object.keys(J.items).sort()) {
    const it = J.items[name];
    if (it.state !== 'swapped') continue;
    let got = null;
    try { got = treeDigest(join(target, name)); } catch { got = null; }
    if (got !== it.new_digest) {
      // 🔴 不符 → 该项 state: corrupt，transaction 保持非 null，**retired/ 一律不动**
      it.state = 'corrupt';
      writeJournal(P.journal, J);
      bad(`第 8 步校验不符：${name} 实算 ${got}，期望 ${it.new_digest}`);
    }
    it.state = 'verified';
    writeJournal(P.journal, J);
    fp('tx:step8:post-state-verified', { name });
  }
  if (J.phase !== 'prepared') return J;

  reverifyAssertions(target, J, P);

  // ── 第 9 步：账本 patch + journal 置 cleanup_pending ──────────────────────
  fp('tx:step9:pre-ledger', {});
  const L = readLedger(P.ledger);
  const next = applyImageSide(L, J.ledger_image.post, { archiveDir: P.auditArchiveDir });
  // transaction 保留至清理结束（🔴 它**不进镜像**，由这里按结果置）
  writeLedger(P.ledger, { ...next, transaction: { generation: J.generation, tx_dir: J.tx_dir } });
  fp('tx:step9:between-ledger-journal', {});
  for (const it of Object.values(J.items)) it.state = 'done';
  J.phase = 'cleanup_pending';
  writeJournal(P.journal, J);
  fp('tx:step9:post-journal', {});
  return J;
}

// ════════════════════════════════════════════════════════════════════════════
// 第 10 步：§5.6 三阶段清理
// ════════════════════════════════════════════════════════════════════════════

/**
 * 【A 全部 tar 先落地，一棵 retired 都不删】→【B 写整代 manifest】→【C 才允许删】
 *
 * 🔴 三条前提，缺一不可：
 *   1. 崩在 checkpoint 之前，**必须从磁盘重验 A 的摘要，不能只信 journal**；
 *   2. 每一次 `fsync` 失败都必须 fail-closed；
 *   3. 自动清理只在 `journal.phase = cleanup_pending` 之后进入。
 */
export function runCleanup(target, J, P, opts = {}) {
  if (J.phase !== 'cleanup_pending') bad(`runCleanup：phase 必须是 cleanup_pending，得到 ${J.phase}`);
  const names = Object.keys(J.items).sort();
  const keepGenerations = opts.keepGenerations ?? 3;
  const createdAt = opts.now ?? nowUtc();

  // ── 阶段 A ────────────────────────────────────────────────────────────────
  for (const name of names) {
    const it = J.items[name];
    if (it.cleanup === 'done') continue;
    const tar = join(P.attic, `${name}.tar`);
    if (it.cleanup === 'tar_durable') {
      // 🔴 前提 1：journal 说 tar_durable 不算数，每次都从磁盘重验
      if (it.had_old) verifyArchive(tar, it.old_digest, P.state);
      continue;
    }
    if (!it.had_old) {
      // install-new 没有旧树，跳过 ①–④ 直接置 tar_durable（manifest 里记 "tar": null）
      it.cleanup = 'tar_durable';
      writeJournal(P.journal, J);
      fp('cleanup:A:post-state-tar-durable', { name });
      continue;
    }
    const R = join(P.retired, name);
    mkdirChainFsync(P.attic);
    if (!existsSync(tar)) {
      sweepTmp(P.attic);                       // §5.4：`.tmp` 残留一律先删再重写
      const tmp = join(P.attic, `${name}.tar.tmp`);
      writeAtomic(tmp, writeCanonicalTar(treeToEntries(R)));
      fp('cleanup:A:post-tar-tmp', { name });
      // ② 🔴 三方比对：tar 内容（**重算**）== retired/<name>/ == journal 的 old_digest
      const aDigest = archiveDigest(tmp, P.state);
      const rDigest = treeDigest(R);
      if (aDigest !== rDigest || rDigest !== it.old_digest) {
        bad(`阶段 A 三方比对失败：${name}（tar=${aDigest} retired=${rDigest} journal=${it.old_digest}）`);
      }
      fp('cleanup:A:post-compare', { name });
      renameDirFsync(tmp, tar);
      fp('cleanup:A:post-tar-rename', { name });
    } else {
      // 🔴 崩在 tar rename 之后、checkpoint 之前：**A 与 R 都要重验**（Codex 第二轮 #2）。
      //    只验 A 会让「外部改写过的 R」在阶段 C 被当成可删对象删掉 ——
      //    而 §5.6 的阶段 A 要求的是**三方**比对，不是两方。
      //    此刻 cleanup 缺席 ⇒ 阶段 C 对该项还没跑过 ⇒ R 必须仍是完整旧树。
      verifyArchive(tar, it.old_digest, P.state);
      const rNow = treeDigest(R);
      if (rNow !== it.old_digest) {
        bad(`阶段 A 续做时 retired/${name} 摘要 ${rNow} != ${it.old_digest}（外部改写过），停机`);
      }
    }
    it.cleanup = 'tar_durable';
    writeJournal(P.journal, J);
    fp('cleanup:A:post-state-tar-durable', { name });
  }
  // 逻辑项不参与 A / C（没有旧树、也没有 retired/）

  // ── 阶段 B ────────────────────────────────────────────────────────────────
  const mPath = join(P.attic, 'manifest.json');
  if (J.manifest !== 'durable') {
    fp('cleanup:B:pre-manifest', {});
    mkdirChainFsync(P.attic);
    if (existsSync(mPath)) {
      // 幂等：已存在且自洽就沿用（重写会换掉 created_at，破坏 I7 收敛）
      assertManifestUsable(mPath, J, P);
    } else {
      const L = readLedger(P.ledger);
      writeAtomic(mPath, stringify(buildManifest(J, L, target, { createdAt })));
    }
    fp('cleanup:B:post-manifest', {});
    J.manifest = 'durable';
    writeJournal(P.journal, J);
    fp('cleanup:B:post-state-manifest-durable', {});
  } else {
    // 🔴 §5.6 前提 1 的推广（Codex 第二轮 P0-1）：journal 说 `manifest = durable`
    //    **不算数**，每次进阶段 C 之前都要**从磁盘重验 manifest**。
    //    只信 journal 的话，manifest 被删/被改之后照样会去删 retired/，
    //    留下一个「已完成却无法 --from-generation 复位」的 generation；
    //    tar 也缺时旧树直接彻底丢失。
    assertManifestUsable(mPath, J, P);
  }

  // ── 阶段 C ────────────────────────────────────────────────────────────────
  for (const name of names) {
    const it = J.items[name];
    if (it.cleanup === 'done') continue;
    if (it.had_old) {
      // 🔴 删之前再看一眼 R 是什么：它要么还是完整旧树（正常）、要么是上一次删到一半
      //    留下的部分树（续做）。**其它任何东西都不许删** —— 那是外部塞进来的现场证据
      //    （Codex 第三轮 (c)-3）。旧树本身此刻已在 tar 里，不构成丢失，但别人的数据会。
      const R = join(P.retired, name);
      if (existsSync(R)) {
        const dR = safeTreeDigest(R);
        if (dR !== it.old_digest && !isPartialOrAbsent(P, name, it)) {
          bad(`阶段 C：retired/${name} 既不是完整旧树也不是「删到一半」的部分树，拒绝删除`);
        }
      }
      fp('cleanup:C:pre-rmtree', { name });
      rmtreeFsync(R);
      fp('cleanup:C:post-rmtree', { name });
    }
    it.cleanup = 'done';
    writeJournal(P.journal, J);
    fp('cleanup:C:post-state-done', { name });
  }

  rmtreeFsync(P.tx);
  fp('cleanup:post-tx-rm', {});
  pruneAttic(P, keepGenerations);
  J.phase = 'completed';
  writeJournal(P.journal, J);
  fp('cleanup:post-phase-completed', {});
  const L = readLedger(P.ledger);
  if (L.transaction !== null) writeLedger(P.ledger, { ...L, transaction: null });
  fp('cleanup:post-clear-transaction', {});
  // 🔴 `completed` 的 journal 是**残留**（§5.6 第 2 步表）。规范允许它由下一次运行清掉，
  //    但那会让「恢复」这件事需要跑两趟才收敛 —— I7 要求一趟就到不动点。
  //    因此正常路径在**清空 transaction 之后**顺手删掉它；崩在中间留下的那一份
  //    仍由 recover 的 clearResidue 兜底。generation 水位在独立文件里，不受影响。
  if (existsSync(P.journal)) rmtreeFsync(P.journal);
  // §5.1 末尾：install / update / remove / recover 成功之后都要在 repo 锁下重算 lockfile。
  // 「有没有注入」在入口就查过了（assertLockfileHook），这里只负责**调用**。
  runLockfileRecalc(target, P, opts);
  return J;
}

/**
 * 🔴 只有**项目级** target 有 lockfile；判据取自账本自己的 `target.scope`，
 *    不靠调用方口头声明。读不出账本时按最严格的一边（project）处理。
 */
export function isProjectScope(P) {
  try { return existsSync(P.ledger) ? readLedger(P.ledger).target.scope === 'project' : false; } catch { return true; }
}

/**
 * 🔴 **入口就查，不要等到收尾**（自己踩的：第一版把它放在 runCleanup 末尾，
 *    于是「忘了注入」在事务**已经提交完**之后才炸 —— 那时 journal 都删了，
 *    下一次 recover 无事可做，lockfile 永远不会被重算）。
 *    「缺少一个必需的输入」属于预检，应当在**放弃还免费**的时候报出来。
 */
export function assertLockfileHook(P, opts) {
  if (!isProjectScope(P)) return;
  if (typeof opts.onLedgerChanged !== 'function') {
    bad('项目级 target 必须注入 onLedgerChanged（§5.1：账本变更后要在 repo 锁下重算 lockfile）');
  }
}

export function runLockfileRecalc(target, P, opts) {
  if (!isProjectScope(P)) return;
  assertLockfileHook(P, opts);
  opts.onLedgerChanged(target);
}

export function safeTreeDigest(p) { try { return treeDigest(p); } catch { return null; } }

/**
 * 🔴 §5.4.1 封闭表里 `R` 那一列的 **`部分|∅`** 到底是什么。
 *
 * 它指的是「阶段 C 的递归删除删到一半」留下的树，**不是**「任意一棵摘要不等于
 * `old_digest` 的树」。后者可能是外部放进来的完整现场证据 —— 把它当成「部分」
 * 会让 rollback / cleanup 直接删掉它。
 *
 * 可判定的判据：`R` 的**文件路径集合是归档里那棵旧树的真子集**。
 * 递归删除只会让条目变少，绝不会变出新条目。
 *
 * ⚠️ **诚实边界**（Codex 第三轮 (b)）：这只是「文件递归删除中断」的判据，
 *    **不是**「R 一定只是删到一半」的充分证明 —— `geoly-tree-v1` 与 tar 都不覆盖
 *    空目录，所以「旧树 + 外部新增空目录」这类差异在这里看不见。
 */
export function isPartialOrAbsent(P, name, it) {
  const R = join(P.retired, name);
  if (!existsSync(R)) return true;
  const dR = safeTreeDigest(R);
  if (dR === null) return true;                    // 读不出树 = 结构已破 = 部分
  if (dR === it.old_digest) return false;          // 完整旧树，不是「部分」
  const tar = join(P.attic, `${name}.tar`);
  if (!existsSync(tar)) return false;
  let full;
  try { full = new Set(parseTar(readFileSync(tar)).entries.map((e) => e.path)); } catch { return false; }
  const cur = new Set();
  try {
    (function rec(d, rel) {
      for (const n of readdirSync(d).sort()) {
        const abs = join(d, n);
        const r = rel === '' ? n : `${rel}/${n}`;
        if (lstatSync(abs).isDirectory()) rec(abs, r); else cur.add(r);
      }
    })(R, '');
  } catch { return true; }
  if (cur.size >= full.size) return false;
  for (const p of cur) if (!full.has(p)) return false;
  return true;                                     // 真子集 ⇒ 删到一半
}

/**
 * 🔴 进入阶段 C 之前对 manifest 的完整可用性检查：文件在、schema 自洽、代号相符、
 *    **item 键集与本代 journal 一致**、每个非 install-new 项的 tar 在且摘要相符。
 *    「文件在不在」不是判据 —— 判据是「它能不能真的用来复位这一代」。
 */
function assertManifestUsable(mPath, J, P) {
  if (!existsSync(mPath)) bad(`attic/${J.generation}/manifest.json 缺失，禁止进入清理阶段 C`);
  const M = validateManifest(readJsonStrict(mPath, 'attic-manifest'));
  if (M.generation !== J.generation) bad(`attic manifest 的 generation ${M.generation} != ${J.generation}`);
  const want = [
    ...Object.keys(J.items),
    ...Object.keys(J.adopt_assertions ?? {}),
    ...Object.keys(J.unadopt_assertions ?? {}),
  ].sort();
  const got = Object.keys(M.items).sort();
  if (stringify(want) !== stringify(got)) {
    bad(`attic manifest 的 items 键集与本代 journal 不一致（manifest ${got}，journal ${want}）`);
  }
  // 🔴 逐项**语义绑定**（Codex 第三轮 P0-1 未修尽处）：只查「tar 非 null 的那些」不够 ——
  //    把一个 swap 项改写成 `install-new + tar:null` 就能绕过检查，
  //    然后阶段 C 照样删 retired，而那一代已经没有可用归档了。
  for (const [name, mi] of Object.entries(M.items)) {
    const it = J.items[name];
    if (it) {
      if (mi.op !== it.op) bad(`attic manifest 的 ${name}.op=${mi.op} 与 journal 的 ${it.op} 不符`);
      if (mi.reverse_op !== REVERSE_OP[it.op]) bad(`attic manifest 的 ${name}.reverse_op 与 op 不互逆`);
      if (it.op === 'install-new') {
        if (mi.tar !== null || mi.old_digest !== null) bad(`attic manifest 的 ${name}：install-new 必须 tar/old_digest 皆 null`);
      } else {
        if (mi.tar !== `${name}.tar`) bad(`attic manifest 的 ${name}.tar 必须是 ${name}.tar`);
        if (mi.old_digest !== it.old_digest) bad(`attic manifest 的 ${name}.old_digest 与 journal 不符`);
        verifyArchive(join(P.attic, mi.tar), it.old_digest, P.state);
      }
      continue;
    }
    // 逻辑项（adopt / unadopt）：没有旧树，manifest 里必须是 tar/old_digest 皆 null
    const logical = (J.adopt_assertions?.[name] && 'adopt') || (J.unadopt_assertions?.[name] && 'unadopt');
    if (!logical) bad(`attic manifest 记了 ${name}，但它既不是本代物理项也不是逻辑项`);
    if (mi.op !== logical) bad(`attic manifest 的 ${name}.op=${mi.op} 与逻辑项类型 ${logical} 不符`);
    if (mi.reverse_op !== REVERSE_OP[logical]) bad(`attic manifest 的 ${name}.reverse_op 与 op 不互逆`);
    if (mi.tar !== null || mi.old_digest !== null) bad(`attic manifest 的 ${name}：逻辑项必须 tar/old_digest 皆 null`);
  }
  return M;
}

/**
 * 按保留代数清理旧 attic。🔴 `--keep-generations` **只管 `attic/`** ——
 * `audit-archive/` 永不按代清理（它是审计历史，不是可丢弃的备份）。
 * 🔴 冻结的代（`frozen_attic`）跳过。manifest 与该代全部 tar **一起**删。
 */
export function pruneAttic(P, keep) {
  if (!existsSync(P.atticDir)) return [];
  const L = existsSync(P.ledger) ? readLedger(P.ledger) : null;
  const gens = readdirSync(P.atticDir).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a);
  const removed = [];
  let kept = 0;
  for (const g of gens) {
    if (L && isGenerationFrozen(L, g)) continue;   // 冻结的不占保留名额，也不删
    kept++;
    if (kept <= keep) continue;
    rmtreeFsync(join(P.atticDir, String(g)));
    removed.push(g);
  }
  return removed;
}

export function nowUtc(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ════════════════════════════════════════════════════════════════════════════
// 第 5–10 步的编排
// ════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 本函数**不做**第 1–4 步（取锁、发现残留事务、预检、下载与验包）。
 *    那是命令面的事；把它们混进来会诱使调用方以为「调一次就安全了」。
 *    调用前必须已经过 recover 的第 2 步分流。
 */
export function runTransaction(target, plan, opts = {}) {
  const P = layout(target, plan.generation);
  assertLockfileHook(P, opts);          // 🔴 入口预检：缺必需输入要在动手之前报
  stageTrees(P, plan);
  const J = commitPoint(P, plan, opts);
  applyItems(target, J, P);
  verifyAndCommit(target, J, P);
  runCleanup(target, J, P, opts);
  return J;
}

/** 读回某一代 journal（供 recover 与测试用） */
export function loadJournal(target, gen) {
  const P = layout(target, gen);
  return { P, J: readJournal(P.journal) };
}

