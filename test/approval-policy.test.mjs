import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUDE_AUTHOR, effectiveApprovers, exclusionNote } from '../scripts/submission/approval-policy.mjs';

const REPO = dirname(fileURLToPath(new URL('.', import.meta.url).href)).replace(/\/test$/, '');
const SITES = ['scripts/submission/tier-gate.mjs', 'scripts/promote/verify-merged-pr.mjs'];

test('作者算不算数：当前策略是「算」（2026-09-01 用户拍板）', () => {
  assert.equal(EXCLUDE_AUTHOR, false);
  const all = ['U_me', 'U_other'];
  assert.deepEqual(effectiveApprovers({ all, authorId: 'U_me' }), all);
  assert.equal(exclusionNote({ all, authorId: 'U_me' }), '',
    '策略关掉时不该再说「已排除投稿者本人」—— 那句话会把人引到错误的排查方向');
});

test('策略翻回 true 时两个函数都要跟着变（证明它们真的读那个常量）', async () => {
  // 直接改常量做不到（ESM 的导出是只读绑定），所以改成读源码断言：
  // 两个函数体里都必须出现 EXCLUDE_AUTHOR，否则它们只是碰巧返回了对的值。
  const src = readFileSync(join(REPO, 'scripts/submission/approval-policy.mjs'), 'utf8');
  const body = (name) => {
    const i = src.indexOf(`export function ${name}`);
    assert.notEqual(i, -1, `找不到 ${name}`);
    return src.slice(i, src.indexOf('\n}', i));
  };
  for (const fn of ['effectiveApprovers', 'exclusionNote']) {
    assert.ok(body(fn).includes('EXCLUDE_AUTHOR'),
      `${fn} 没有读 EXCLUDE_AUTHOR —— 把常量翻回 true 不会改变它的行为`);
  }
});

// 🔴 **两处判定不许各写各的。** tier-gate（合并前）与 verify-merged-pr（promote 时）
//    问的是同一个问题；分叉的后果是「合并前过了、promote 时不过」——
//    PR 已经进了 main、发布却卡住，而两边的日志各自都说自己是对的。
//    早先这段逻辑就是各写一遍、靠注释提醒"必须一致"。注释拦不住复制粘贴。
test('🔴 两处审批判定必须共用 approval-policy，不许自己 filter 作者', () => {
  for (const rel of SITES) {
    const src = readFileSync(join(REPO, rel), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(src.includes('effectiveApprovers('),
      `${rel} 没有用 effectiveApprovers —— 它在自己判作者，会与另一处分叉`);
    assert.ok(!/\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\s*!==\s*authorId/.test(src),
      `${rel} 里还留着自己写的「排除 authorId」过滤 —— 那正是分叉的形状`);
  }
});
