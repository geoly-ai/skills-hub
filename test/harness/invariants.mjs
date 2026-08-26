// 不变式 —— 崩溃恢复的断言面。
//
// 🔴 §5.4 的教训：**枚举物理状态行不通**（物理中间态随步骤组合爆炸，手工枚举必漏）。
//    所以这里断言的是「恢复后 journal / ledger / 目录树三者自洽」这类**不变式**，
//    而不是「崩在第 k 点之后磁盘应该长成什么样」。
//
// 每条不变式都标了它在打哪个规范条款，以及**为什么它不恒真**
// （恒真的不变式等于没测 —— 见每条的「能被违反的方式」）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { treeDigest } from '../../src/tree-digest.mjs';
import { parseStrict, stringify } from '../../src/canonical-json.mjs';
import { crc32cHex } from './crc32c.mjs';
import { layout, verifyArchive } from './fake-tx.mjs';

export class InvariantViolation extends Error {
  constructor(id, msg) {
    super(`${id} 违反：${msg}`);
    this.name = 'InvariantViolation';
    this.id = id;
  }
}

const bad = (id, msg) => { throw new InvariantViolation(id, msg); };

function digestOrNull(p) {
  if (!existsSync(p)) return null;
  try { return treeDigest(p); } catch { return 'UNREADABLE'; }
}

function findJournal(target) {
  const P0 = layout(target);
  if (!existsSync(P0.journalDir)) return null;
  const files = readdirSync(P0.journalDir).filter((n) => n.endsWith('.json'));
  if (files.length === 0) return null;
  if (files.length > 1) bad('I1', `假事务只应有一份 journal，发现 ${files.join(',')}`);
  return { gen: Number(files[0].replace('.json', '')), path: join(P0.journalDir, files[0]) };
}

/**
 * @param {string} target
 * @param {object} expect  { gen, items: [{name, op, oldDigest?, newDigest?}] }
 * @param {object} [opts]  { afterSuccessfulRecovery: boolean }
 */
export function checkAll(target, expect, opts = {}) {
  const done = opts.afterSuccessfulRecovery === true;
  const P0 = layout(target);
  const jref = findJournal(target);
  const P = layout(target, jref ? jref.gen : expect.gen);

  // ── I1 journal 要么整体缺席，要么可解析且 crc32c 通过 ─────────────────────
  // 依据：§11 §5「禁止原地覆写」+ journal 的 crc32c 自校验。
  // 能被违反的方式：原地覆写 journal、写一半、crc 覆盖范围算错。
  let J = null;
  if (jref) {
    let text;
    try { text = readFileSync(jref.path, 'utf8'); } catch (e) { bad('I1', `journal 读不出：${e.message}`); }
    let obj;
    try { obj = parseStrict(text); } catch (e) { bad('I1', `journal 不是合法 canonical JSON：${e.message}`); }
    const { crc32c: got, ...rest } = obj;
    if (typeof got !== 'string' || got.length !== 8) bad('I1', 'crc32c 必须是 8 字符小写 hex');
    const want = crc32cHex(Buffer.from(stringify(rest), 'utf8'));
    if (got !== want) bad('I1', `crc32c 不符：记 ${got}，实算 ${want}`);
    J = obj;
    // §5.4.1：direction 与 rollback 同时存在或同时缺席
    if ((J.direction === undefined) !== (J.rollback === undefined)) {
      bad('I1', 'direction 与 rollback 必须同时存在或同时缺席');
    }
    if (J.rollback) {
      const a = Object.keys(J.rollback.items).sort().join(',');
      const b = Object.keys(J.items).sort().join(',');
      if (a !== b) bad('I1', `rollback.items 键集必须严格等于 journal.items：${a} vs ${b}`);
    }
  }

  // ── I2 双文件规则：ledger 与 journal 只落一边时必须落在合法组合里 ─────────
  // 依据：§5.2 第 6 步「各自原子写，可能已有一份落盘」+ §5.4.2。
  // 能被违反的方式：先写 journal 后写 ledger（顺序反了），或恢复时把
  //                「有 journal 无 ledger」当成 pre-commit 直接删。
  const hasLedger = existsSync(P0.ledger);
  const led = hasLedger ? parseStrict(readFileSync(P0.ledger, 'utf8')) : null;
  if (J && !hasLedger) {
    bad('I2', 'journal 已落盘却没有 ledger —— 提交点必须先写 ledger 再写 journal');
  }
  if (led?.transaction && !J) {
    // 合法：ledger 先落、journal 未落（pre-commit）。但恢复完之后不许再有。
    if (done) bad('I2', '恢复完成后 ledger.transaction 仍非 null 而 journal 缺席');
  }
  if (done && led?.transaction) bad('I2', `恢复完成后 ledger.transaction 应为 null，实为 ${JSON.stringify(led.transaction)}`);

  // ── I3 旧树永不同时消失 ───────────────────────────────────────────────────
  // 依据：§5.6「任何时刻旧树至少有一份完整副本」。
  // 能被违反的方式：清理阶段 C 早于 B、tar 未 durable 就删 retired、
  //                rollback 把 R 删了又没落 attic —— 这是最值钱的一条。
  for (const it of expect.items) {
    if (it.op === 'install-new') continue;
    const T = join(target, it.name);
    const R = P.retired ? join(P.retired, it.name) : null;
    const tar = P.attic ? join(P.attic, `${it.name}.tar`) : null;
    const copies = [];
    if (digestOrNull(T) === it.oldDigest) copies.push('T');
    if (R && digestOrNull(R) === it.oldDigest) copies.push('R');
    if (tar && existsSync(tar)) {
      // 🔴 **重算**，不信 archive 自带的 tree_digest 字段（Codex 第二轮 P0-3）：
      //    否则一份字段写对、内容写错的 archive 会被算成「完整副本」。
      try { verifyArchive(tar, it.oldDigest); copies.push('A'); } catch { /* 损坏的不算副本 */ }
    }
    if (copies.length === 0) {
      bad('I3', `${it.name} 的旧树在 T / retired / attic 三处都没有完整副本（old=${it.oldDigest}）`);
    }
  }

  // ── I4 提交点之后，新树也永不同时消失 ────────────────────────────────────
  // 依据：§5.3「两次 rename 之间是安全的 —— 两份都在」。
  // 只在「事务已提交、尚未 completed、且方向不是 rollback」时成立：
  // rollback 的**目的**就是把新树丢掉，completed 之后 stage 已删。
  if (J && J.phase !== 'completed' && !J.direction) {
    for (const it of expect.items) {
      if (it.op === 'retire-only') continue;
      const T = join(target, it.name);
      const S = P.stage ? join(P.stage, it.name) : null;
      const okT = digestOrNull(T) === it.newDigest;
      const okS = S ? digestOrNull(S) === it.newDigest : false;
      if (!okT && !okS) bad('I4', `${it.name} 的新树在 stage 与 target 都不完整（new=${it.newDigest}）`);
    }
  }

  // ── I5 不存在「Y 正确而 X 也在」的重影 ───────────────────────────────────
  // 依据：§5.4 幂等表的分支 ②。恢复**成功**之后绝不允许留下重影；
  //       恢复过程中遇到它必须判 corrupt 停机（由 driver 断言）。
  // 能被违反的方式：rename 只 fsync 了目标侧、恢复只验 Y 不验 X。
  if (done) {
    for (const it of expect.items) {
      const T = join(target, it.name);
      const R = P.retired ? join(P.retired, it.name) : null;
      const S = P.stage ? join(P.stage, it.name) : null;
      if (R && existsSync(R) && existsSync(T) && digestOrNull(R) === digestOrNull(T)) {
        bad('I5', `${it.name} 在 target 与 retired 里各有一份相同的树（重影）`);
      }
      if (S && existsSync(S) && existsSync(T) && digestOrNull(S) === digestOrNull(T)) {
        bad('I5', `${it.name} 在 target 与 stage 里各有一份相同的树（重影）`);
      }
    }
  }

  // ── I6 清理阶段 B 必须严格早于 C ─────────────────────────────────────────
  // 依据：§5.6「在 ⑥ 落盘之前，不允许删除任何 retired 树」。
  // 能被违反的方式：逐项 ①…⑥（v11 的老写法）—— 第一份 tar durable 就去删 retired。
  if (J && (J.phase === 'cleanup_pending' || J.phase === 'completed') && !J.direction) {
    const anyCleaned = Object.entries(J.items)
      .some(([, v]) => v.cleanup === 'done' && v.had_old);
    if (anyCleaned && J.manifest !== 'durable') {
      bad('I6', '有 retired 树已被删除，但 manifest 还没 durable —— C 跑到了 B 前面');
    }
    if (anyCleaned && P.attic && !existsSync(join(P.attic, 'manifest.json'))) {
      bad('I6', 'journal 说 manifest durable，磁盘上却没有 manifest.json');
    }
    // 反向：manifest 已 durable 时，每个 had_old 项的 tar 必须真在盘上
    if (J.manifest === 'durable') {
      for (const [name, v] of Object.entries(J.items)) {
        if (v.had_old && !existsSync(join(P.attic, `${name}.tar`))) {
          bad('I6', `manifest 已 durable，但 ${name}.tar 不在 attic 里`);
        }
      }
    }
  }

  // ── I7 收敛（由 driver 跑两遍恢复比对快照）—— 这里只查残留 ───────────────
  if (done) {
    for (const dir of [P0.state, P0.journalDir, P.attic].filter((d) => d && existsSync(d))) {
      const stray = readdirSync(dir).filter((n) => n.endsWith('.tmp'));
      if (stray.length) bad('I7', `${dir} 里残留 .tmp：${stray.join(',')}`);
    }
    if (P.tx && existsSync(P.tx)) bad('I7', `恢复完成后 tx 目录仍在：${P.tx}`);
  }

  // ── I8 原子性：最终账本要么是提交前像，要么是提交后像，不得混合 ──────────
  // 依据：§5.2 第 6 步是提交点。
  // 能被违反的方式：第 9 步逐项 patch 账本而不是整体原子写。
  if (done && J && led) {
    const norm = (o) => stringify({ ...o, transaction: null });
    const pre = norm(J.ledger_image.pre);
    const post = norm(J.ledger_image.post);
    const now = norm(led);
    if (now !== pre && now !== post) {
      bad('I8', '恢复后的账本既不是 pre 也不是 post —— 出现了跨提交点的混合态');
    }
  }

  return { journal: J, ledger: led };
}
