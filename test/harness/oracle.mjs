// 恢复结果的**独立裁决器**（oracle）。
//
// Codex 第一轮的第 3/6 条：光有不变式还不够 —— 恢复器可以「稳定地做错事」，
// 而每次都自己报 corrupt 也能让测试全绿。所以除了不变式，还要一个
// **与恢复器无关**的裁决：恢复之后允许落在哪几个终态。
//
// 允许的终态只有三个：
//   A. committed  —— 事务已完整生效（每个 item 都是新树，账本 == post）
//   B. reverted   —— 事务未生效（每个 item 都是旧树，账本 == pre）
//   C. fail-closed —— 恢复器抛 Corrupt 且**没有把状态推进得更坏**
// 任何「一半新一半旧」都不合法。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { treeDigest } from '../../src/tree-digest.mjs';
import { parseStrict, stringify } from '../../src/canonical-json.mjs';
import { layout } from './fake-tx.mjs';

function digestOrNull(p) {
  if (!existsSync(p)) return null;
  try { return treeDigest(p); } catch { return 'UNREADABLE'; }
}

/**
 * @returns {'committed'|'reverted'|'mixed'|'absent'}
 */
export function classifyTarget(target, expect) {
  const marks = new Set();
  for (const it of expect.items) {
    const d = digestOrNull(join(target, it.name));
    if (it.op === 'install-new') {
      marks.add(d === it.newDigest ? 'new' : d === null ? 'old' : 'other');
    } else if (it.op === 'retire-only') {
      marks.add(d === null ? 'new' : d === it.oldDigest ? 'old' : 'other');
    } else {
      marks.add(d === it.newDigest ? 'new' : d === it.oldDigest ? 'old' : 'other');
    }
  }
  if (marks.has('other')) return 'mixed';
  if (marks.size !== 1) return 'mixed';
  return marks.has('new') ? 'committed' : 'reverted';
}

/**
 * 账本落在 pre 还是 post。判据取自 journal 自带的 `ledger_image`
 * （比对时都把 `transaction` 归一成 null —— 它是事务指针，不属于像的内容）。
 * @returns {'pre'|'post'|'other'|'absent'|'unknown'}
 */
export function classifyLedger(target) {
  const P = layout(target);
  if (!existsSync(P.ledger)) return 'absent';
  const led = parseStrict(readFileSync(P.ledger, 'utf8'));
  const j = findJournal(target);
  if (!j) return 'unknown';                    // 没有 journal 就没有判据
  const norm = (o) => stringify({ ...o, transaction: null });
  if (norm(led) === norm(j.ledger_image.pre)) return 'pre';
  if (norm(led) === norm(j.ledger_image.post)) return 'post';
  return 'other';
}

function findJournal(target) {
  const P0 = layout(target);
  if (!existsSync(P0.journalDir)) return null;
  const files = readdirSync(P0.journalDir).filter((n) => n.endsWith('.json')).sort();
  if (files.length === 0) return null;
  try {
    return parseStrict(readFileSync(join(P0.journalDir, files[files.length - 1]), 'utf8'));
  } catch { return null; }
}

/**
 * 裁决一次「崩溃 → 恢复」的结果。
 * 🔴 **target 与 ledger 必须一起裁**（Codex 第二轮 P0-5）：
 *    只看目录树时，「树是新的而账本还是 pre」「树是旧的而账本已是 post」都会被放行，
 *    而那正是提交点两边不一致 —— 恢复器最容易犯的错。
 * @param {object} r { corrupt, corruptMessage, target, expect, rolledBack }
 */
export function adjudicate(r) {
  const { target, expect } = r;
  const t = classifyTarget(target, expect);
  const l = classifyLedger(target);
  const dump = () => expect.items
    .map((it) => `  ${it.name}: ${digestOrNull(join(target, it.name))}`).join('\n');

  // 🔴 fail-closed 不是免检牌：停机时也不许留下混合态，也不许账本落在 pre/post 之外。
  if (r.corrupt) {
    if (t === 'mixed') {
      throw new Error(`oracle：恢复 fail-closed，但目录树已经是**混合态** ——\n${dump()}\n`
        + `报 corrupt 不等于可以把状态推坏。原因：${r.corruptMessage}`);
    }
    if (l === 'other') {
      throw new Error(`oracle：恢复 fail-closed，但账本既不是 pre 也不是 post。`
        + `原因：${r.corruptMessage}`);
    }
    return { verdict: 'fail-closed', target: t, ledger: l, detail: r.corruptMessage };
  }

  if (t === 'mixed') {
    throw new Error(`oracle：恢复后落在**混合态** —— 有的 item 是新树、有的是旧树。\n${dump()}`);
  }
  if (expect.rolledBack && t !== 'reverted') {
    throw new Error('oracle：这是一次 rollback，恢复后却是 committed —— '
      + '§5.4.1 的「direction 一旦持久化就不得转回正向」被违反了');
  }
  // 提交点两边必须一致
  if (t === 'committed' && !['post', 'unknown'].includes(l)) {
    throw new Error(`oracle：目录树已是新版（committed），账本却是 ${l} —— 提交点两边不一致`);
  }
  if (t === 'reverted' && !['pre', 'unknown', 'absent'].includes(l)) {
    throw new Error(`oracle：目录树是旧版（reverted），账本却是 ${l} —— 提交点两边不一致`);
  }
  return { verdict: t, ledger: l };
}
