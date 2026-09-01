import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_BYPASS_IDS, EXCLUDE_AUTHOR, approvalsWaived, effectiveApprovers, exclusionNote,
} from '../scripts/submission/approval-policy.mjs';
import { assertTierApprovals } from '../scripts/submission/tier-gate.mjs';
import { assertApprovalsCurrent } from '../scripts/promote/verify-merged-pr.mjs';

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

// ── 审批豁免：名单上的人自己投的稿跳过人数门 ──────────────────────────────
test('豁免名单里的作者：审批人数门放行', () => {
  assert.equal(approvalsWaived({ authorId: 'U_kgDODu4RvA' }), true);
});

// 🔴 三条一起构成「豁免不会漏给别人」：空值、别人、以及**login 而不是 id**。
test('🔴 豁免不许扩散：空值、他人、login 形态一律不放行', () => {
  for (const bad of [null, undefined, '', 'chovizzz', 'U_OTHER', 0, {}]) {
    assert.equal(approvalsWaived({ authorId: bad }), false, `authorId=${JSON.stringify(bad)} 不该被豁免`);
  }
});

// 🔴 判据必须是不可变 node id：login 能改名、也能被别人重新认领。
test('🔴 豁免名单里只许放 node id，不许放 login', () => {
  for (const id of APPROVAL_BYPASS_IDS) {
    assert.match(id, /^U_[A-Za-z0-9]+$/, `${id} 看起来不是 node id`);
  }
});

// 🔴 两处必须同步放行 —— 不同步 = 「合并前过了、promote 时不过」，
//    PR 已经进了 main、发布却卡住，两边日志各说各有理。
test('🔴 合并前与 promote 时必须同步豁免，且都要出声', () => {
  const AUTHOR = APPROVAL_BYPASS_IDS[0];
  const HEAD = 'a'.repeat(40);

  const say = [];
  const orig = process.stderr.write;
  process.stderr.write = (c) => (say.push(String(c)), true);
  try {
    // Tier 2 本来要两票，这里一票都没有
    assert.deepEqual(assertTierApprovals({
      tier: 2, reviews: [], prHeadSha: HEAD, maintainerIds: [AUTHOR], authorId: AUTHOR,
    }), []);
    assert.deepEqual(assertApprovalsCurrent({
      reviews: [], prHeadSha: HEAD, maintainerIds: [AUTHOR], needed: 2, authorId: AUTHOR,
    }), []);
  } finally { process.stderr.write = orig; }

  assert.equal(say.length, 2, '两处都必须打日志 —— 静默的豁免和坏掉的门事后看起来一样');
  for (const line of say) {
    assert.match(line, /审批豁免名单/);
    // ⚠️ 必须说清「只跳过人数」，否则读日志的人会以为这条投稿什么都没检查。
    assert.match(line, /只跳过审批人数/);
  }
});

// 🔴 别人投的稿一点都没被放宽 —— 这条是上面所有条的对照组。
test('🔴 非豁免作者：门照旧生效', () => {
  const HEAD = 'a'.repeat(40);
  assert.throws(() => assertTierApprovals({
    tier: 2, reviews: [], prHeadSha: HEAD, maintainerIds: ['U_M1', 'U_M2'], authorId: 'U_SOMEONE',
  }), /E_TIER_APPROVALS|Tier 2/);
});
