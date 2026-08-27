// §5.6 阶段 C 的两道「不能只信 journal」的门 —— Codex 第二轮挖出来的两条丢数据路径。
//
// 🔴 两条都属于同一个反复被踩的教训：**「journal 说 X」不是判据，磁盘说了才算。**
//    §5.6 前提 1 只写了 tar（「崩在 checkpoint 之前必须从磁盘重验 A」），
//    但同一条道理对 manifest 与 retired 一样成立。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arm, disarm, reset } from '../src/fault-inject.mjs';
import { layout } from '../src/ledger.mjs';
import { readJournal, writeJournal } from '../src/journal.mjs';
import { runCleanup } from '../src/install.mjs';
import { KSCENARIOS, kFreshTarget, kCleanup } from './kernel-scenarios.test.mjs';

const AT = '2026-08-26T00:00:00Z';
const S = () => KSCENARIOS['kernel-tx'];

/** 停在指定注入点，返回 target */
function stopAt(point, tag) {
  const target = kFreshTarget(tag);
  disarm(); reset();
  S().setup(target);
  arm({ name: point, nth: 1, mode: 'throw' });
  try { S().run(target); } catch (e) { if (e?.name !== 'FaultInjected') { disarm(); reset(); kCleanup(target); throw e; } }
  disarm(); reset();
  return target;
}

test('🔴 journal 说 manifest=durable 也不算数：manifest 文件缺了就禁止进入阶段 C', () => {
  const target = stopAt('cleanup:B:pre-manifest', 'mf');
  try {
    const P = layout(target, 1);
    assert.ok(!existsSync(join(P.attic, 'manifest.json')), '前提：manifest 还没写出来');
    const J = readJournal(P.journal);
    J.manifest = 'durable';                       // 伪造成「B 已完成」
    writeJournal(P.journal, J);
    assert.throws(
      () => runCleanup(target, readJournal(P.journal), P, { floor: null, now: AT }),
      /manifest\.json 缺失，禁止进入清理阶段 C/,
      '🔴 只信 journal 的 manifest=durable 就去删 retired —— 会留下无法 --from-generation 复位的 generation',
    );
    // 🔴 fail-closed 之后 retired 必须原封不动（停机不是丢数据的借口）
    assert.ok(existsSync(join(P.retired, 'alpha')));
    assert.ok(existsSync(join(P.retired, 'gamma')));
  } finally { kCleanup(target); }
});

test('🔴 manifest 在盘上但 items 键集与本代 journal 不一致 → 同样禁止进入阶段 C', () => {
  const target = stopAt('cleanup:C:pre-rmtree', 'mf2');
  try {
    const P = layout(target, 1);
    const mPath = join(P.attic, 'manifest.json');
    assert.ok(existsSync(mPath));
    const M = JSON.parse(readFileSync(mPath, 'utf8'));
    delete M.items.gamma;                          // 少记一项 —— 那一代就复位不全了
    writeFileSync(mPath, `${JSON.stringify(M, null, 2)}\n`);
    chmodSync(mPath, 0o644);
    assert.throws(
      () => runCleanup(target, readJournal(P.journal), P, { floor: null, now: AT }),
      /items 键集与本代 journal 不一致|解析失败|canonical/,
    );
    assert.ok(existsSync(join(P.retired, 'gamma')), 'fail-closed 之后 retired 不得被删');
  } finally { kCleanup(target); }
});

test('🔴 tar 已 durable 而 retired 被外部改写：阶段 A 续做必须三方比对，不能只验 tar', () => {
  const target = stopAt('cleanup:A:post-tar-rename', 'rr');
  try {
    const P = layout(target, 1);
    // 崩点在 rename 之后、checkpoint 之前 ⇒ 此刻 tar 在、cleanup 仍缺席、retired 应当完整
    const J0 = readJournal(P.journal);
    const first = Object.keys(J0.items).sort().find((n) => J0.items[n].had_old);
    assert.ok(existsSync(join(P.attic, `${first}.tar`)));
    assert.equal(J0.items[first].cleanup, undefined);
    // 外部把 retired 改掉
    writeFileSync(join(P.retired, first, 'SKILL.md'), '# 外部改写\n');
    chmodSync(join(P.retired, first, 'SKILL.md'), 0o644);
    assert.throws(
      () => runCleanup(target, readJournal(P.journal), P, { floor: null, now: AT }),
      /阶段 A 续做时 retired\/.* 摘要.*外部改写过/,
      '🔴 只验 tar 就把被外部改写的 retired 当成可删对象 —— §5.6 要求的是**三方**比对',
    );
  } finally { kCleanup(target); }
});

