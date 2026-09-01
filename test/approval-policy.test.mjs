import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_BYPASS_IDS, EXCLUDE_AUTHOR, approvalsWaived, effectiveApprovers, exclusionNote,
} from '../scripts/submission/approval-policy.mjs';
import { assertTierApprovals } from '../scripts/submission/tier-gate.mjs';
import { assertApprovalsCurrent } from '../scripts/promote/verify-merged-pr.mjs';

const REPO = dirname(fileURLToPath(new URL('.', import.meta.url).href)).replace(/\/test$/, '');
// 🔴 **不要在这里维护一份「已知调用点」清单。**
//    2026-09-01 的教训：这条不变式最初写死了两个文件，于是它证明的是
//    「我知道的那两处没分叉」，而不是「没有分叉」。实际有**三处** ——
//    `scripts/promote/build-inputs.mjs` 里的 assertApprovalsSatisfyTier
//    自己又写了一遍作者排除，谁也没提到谁，直到第一次真跑 promote 才红。
//    现在改成**全仓搜实现形状**：新增一处而不接策略，这条会自己发现。
const CODE_DIRS = ['scripts'];

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
test('🔴 任何自己 filter 作者的地方都必须改用 approval-policy（全仓搜，不维护清单）', () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(join(REPO, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.mjs')) files.push(rel);
    }
  };
  for (const d of CODE_DIRS) walk(d);
  assert.ok(files.length > 5, '一个源文件都没扫到 —— 这条断言正在空跑');

  // 「自己排除作者」的两种实现形状：与 authorId 比，或与 author 比。
  const SELF_FILTER = /\.filter\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\s*!==\s*(authorId|author)\b/;
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(join(REPO, f), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
    // approval-policy.mjs 自己那一处 filter 是**唯一该存在的实现**，跳过。
    if (f.endsWith('/approval-policy.mjs')) continue;
    if (SELF_FILTER.test(src) && !src.includes('approval-policy.mjs')) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `这些文件自己判作者、却没接 approval-policy：${offenders.join('、')}。\n`
    + '  🔴 分叉的后果是「合并前过了、promote 时不过」——PR 已经进了 main、发布却卡住。');
});

// 🔴 三处都必须真的读同一份策略 —— 上面那条只证明「没有自己写的 filter」，
//    证明不了「确实调用了共享函数」。少了这条，一处直接 `return all` 也能过。
test('🔴 三处审批判定都必须调用 effectiveApprovers', () => {
  for (const rel of [
    'scripts/submission/tier-gate.mjs',
    'scripts/promote/verify-merged-pr.mjs',
    'scripts/promote/build-inputs.mjs',
  ]) {
    const src = readFileSync(join(REPO, rel), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(src.includes('effectiveApprovers('), `${rel} 没有用 effectiveApprovers`);
    assert.ok(src.includes('approvalsWaived('), `${rel} 没有用 approvalsWaived —— 豁免会在这一处失效`);
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
