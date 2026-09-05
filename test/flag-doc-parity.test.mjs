// 🔴 `09-cli.md` 的 flag 表与代码之间**没有任何自动同步检查** ——
//    漂了不会红。2026-09-05 加扫描预算旋钮的子代理点名了这一条。
//
// ⚠️ 一份**说得出但做不到**（或反过来：做得到却没说）的 flag 表，
//    比没有表更坏：读者按它去敲，得到的是「没有这个开关」。
//    而 `REMOVED_FLAGS` 那一类尤其要紧 —— 它们是**故意不提供**的，
//    文档里必须写清「没有，以及为什么」，否则下一个人会以为是漏了、然后加回来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CTX = readFileSync(new URL('../src/commands/context.mjs', import.meta.url), 'utf8');
const DOC = readFileSync(new URL('../docs/m0/09-cli.md', import.meta.url), 'utf8');

/** `REMOVED_FLAGS` 的键 —— 从源码里取，不手抄（手抄的清单会自己漂）。 */
function removedFlags() {
  const block = CTX.slice(CTX.indexOf('const REMOVED_FLAGS'), CTX.indexOf('});', CTX.indexOf('const REMOVED_FLAGS')));
  return [...block.matchAll(/'(--[a-z-]+)':/g)].map((m) => m[1]);
}

/** 解析器真正认得的 flag（排除被点名拒绝的那些）。 */
function acceptedFlags() {
  const removed = new Set(removedFlags());
  const all = new Set([...CTX.matchAll(/'(--[a-z-]+)'/g)].map((m) => m[1]));
  return [...all].filter((f) => !removed.has(f)).sort();
}

/**
 * 「没有 …」那一句本身 —— 判据必须钉在**这一句**上，不是「文档里任何地方出现过」。
 *
 * ⚠️ 我第一版写的是 `DOC.includes(flag)`，而 `--allow-pending` 在本文出现 **3 次**
 *    （清单里一次、下面解释理由时又提了两次）。于是把它从清单里删掉，
 *    断言照样绿 —— **同一个「第二个出现点」的形状，在本仓库这是第五次**。
 *    一条抓不到漂移的漂移检查，比没有检查更坏：它给的是假的信心。
 */
function notProvidedSentence() {
  const i = DOC.indexOf('**没有**');
  assert.ok(i !== -1, '09-cli.md 里找不到「**没有** …」那一句 —— 清单本身没了');
  return DOC.slice(i, DOC.indexOf('。', i) + 1);
}

test('🔴 每个被点名拒绝的 flag 都必须列进 09-cli.md 的「没有」清单', () => {
  const sentence = notProvidedSentence();
  const missing = removedFlags().filter((f) => !sentence.includes(`\`${f}\``));
  assert.deepEqual(missing, [],
    '这些 flag 代码里会明确拒绝，但不在文档的「没有」清单里 —— '
    + `下一个人会以为是漏了然后加回来：\n  ${missing.join('\n  ')}`);
});

test('🔴 每个解析器认得的全局 flag 都必须出现在 09-cli.md 里', () => {
  const undocumented = acceptedFlags().filter((f) => !DOC.includes(f));
  assert.deepEqual(undocumented, [],
    '这些 flag 能用但文档没写 —— 用户没有任何办法知道它们存在：\n  '
    + undocumented.join('\n  '));
});

test('🔴 REMOVED_FLAGS 非空且每条都带理由 —— 只说「没有」等于没说', () => {
  const block = CTX.slice(CTX.indexOf('const REMOVED_FLAGS'), CTX.indexOf('});', CTX.indexOf('const REMOVED_FLAGS')));
  const flags = removedFlags();
  assert.ok(flags.length > 0, 'REMOVED_FLAGS 空了 —— 那些「故意不提供」的判断没了');
  for (const f of flags) {
    // 理由至少要有一句话，且要指向规范的某一节（否则下次有人问「为什么不给」就没有出处）
    const seg = block.slice(block.indexOf(`'${f}':`));
    const reason = seg.slice(0, seg.indexOf('\n\n') === -1 ? 400 : seg.indexOf('\n\n'));
    assert.match(reason, /§|md/,
      `${f} 的拒绝理由里没有指向规范的出处 —— 「就是没有」不构成理由`);
  }
});
