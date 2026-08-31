// promote 前的重新验证 —— 06-submission.md §3。
//
// 🔴 §3：「promote 时必须**重新验证**（不能只信『已 merge』这个事实）」。
//    这一份钉的核心是：**approve 之后又推了一版**的 PR，不能带着旧审批进 promotion。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  currentApprovers, assertApprovalsCurrent, assertVersionsStillFree,
} from '../scripts/promote/verify-merged-pr.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-vmp-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const expectCode = (code, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

/** 静音 stderr 跑一段（那些「approve 失效」的告警本身另有用例覆盖）。 */
function quiet(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const buf = [];
  process.stderr.write = (s) => { buf.push(String(s)); return true; };
  try { return { value: fn(), err: buf.join('') }; } finally { process.stderr.write = orig; }
}

const M1 = 'MDQ6User_m1'; const M2 = 'MDQ6User_m2'; const AUTHOR = 'MDQ6User_author';
const MAINT = [M1, M2];
const rv = (userId, state, commitId, submittedAt, userLogin = userId) =>
  ({ userId, userLogin, state, commitId, submittedAt });
const ca = (over = {}) => currentApprovers({ prHeadSha: HEAD, maintainerIds: MAINT, ...over });

// ════════════════════════════════════════════════════════════════════════════
// §3 第 1 项：approve 必须挂在被合并的 head 上
// ════════════════════════════════════════════════════════════════════════════

test('挂在合并 head 上的 approve 才算', () => {
  const { value } = quiet(() => ca({ reviews: [rv(M1, 'APPROVED', HEAD, '2026-08-01T00:00:00Z')] }));
  assert.deepEqual(value, [M1]);
});

test('🔴 approve 之后又推了一版 —— 那条 approve 不算，且要**说出来**', () => {
  // 审的人看到的和最终合并的不是同一份内容 —— 这是投稿流程里最常见的失效方式
  const { value, err } = quiet(() => ca({ reviews: [rv(M1, 'APPROVED', OLD, '2026-08-01T00:00:00Z')] }));
  assert.deepEqual(value, [], 'GitHub 界面上可能还显示成绿的，但它不作数');
  assert.match(err, /挂在\*\*旧 commit\*\* 上/, '静默丢弃的话，「怎么少了一票」没人查得出来');
});

test('🔴 一个人只看最新一条：先 approve 后 request changes 不算赞成', () => {
  const { value } = quiet(() => ca({ reviews: [
    rv(M1, 'APPROVED', HEAD, '2026-08-01T00:00:00Z'),
    rv(M1, 'CHANGES_REQUESTED', HEAD, '2026-08-02T00:00:00Z'),
  ] }));
  assert.deepEqual(value, []);
  const { value: v2 } = quiet(() => ca({ reviews: [
    rv(M1, 'CHANGES_REQUESTED', HEAD, '2026-08-01T00:00:00Z'),
    rv(M1, 'APPROVED', HEAD, '2026-08-02T00:00:00Z'),
  ] }));
  assert.deepEqual(v2, [M1]);
});

test('COMMENTED 不算赞成', () => {
  const { value } = quiet(() => ca({ reviews: [rv(M1, 'COMMENTED', HEAD, '2026-08-01T00:00:00Z')] }));
  assert.deepEqual(value, []);
});

test('assertApprovalsCurrent：Tier 2 要两条**有效**的', () => {
  const reviews = [
    rv(M1, 'APPROVED', HEAD, '2026-08-01T00:00:00Z'),
    rv(M2, 'APPROVED', OLD, '2026-08-01T00:00:00Z'),   // 失效
  ];
  quiet(() => expectCode('E_APPROVAL_STALE',
    () => assertApprovalsCurrent({ reviews, prHeadSha: HEAD, maintainerIds: MAINT, needed: 2 })));
  const { value } = quiet(() => assertApprovalsCurrent({ reviews, prHeadSha: HEAD, maintainerIds: MAINT, needed: 1 }));
  assert.deepEqual(value, [M1]);
});

test('🔴 投稿者自己的 approve 不计入', () => {
  const reviews = [
    rv(AUTHOR, 'APPROVED', HEAD, '2026-08-01T00:00:00Z'),
    rv(M1, 'APPROVED', HEAD, '2026-08-01T00:00:00Z'),
  ];
  const maint = [...MAINT, AUTHOR];
  quiet(() => expectCode('E_APPROVAL_STALE', () => assertApprovalsCurrent({
    reviews, prHeadSha: HEAD, maintainerIds: maint, needed: 2, authorId: AUTHOR })));
  const { value } = quiet(() => assertApprovalsCurrent({
    reviews, prHeadSha: HEAD, maintainerIds: maint, needed: 1, authorId: AUTHOR }));
  assert.deepEqual(value, [M1]);
});

test('输入形状要严格', () => {
  expectCode('E_VERIFY_INPUT', () => ca({ reviews: [], prHeadSha: 'abc' }));
  expectCode('E_VERIFY_INPUT', () => ca({ reviews: [], prHeadSha: 'A'.repeat(40) }));
  expectCode('E_VERIFY_INPUT', () => ca({ reviews: [{ userId: M1, state: 'APPROVED', commitId: HEAD }] }));
  expectCode('E_VERIFY_INPUT', () => assertApprovalsCurrent({
    reviews: [], prHeadSha: HEAD, maintainerIds: MAINT, needed: 0 }));
  // 🔴 不给 maintainerIds 就拒 —— 不限定的话一个机器人的 approve 就能过门
  expectCode('E_VERIFY_INPUT', () => currentApprovers({ reviews: [], prHeadSha: HEAD, maintainerIds: [] }));
});

// ════════════════════════════════════════════════════════════════════════════
// §3 第 4 项：版本号仍然空着
// ════════════════════════════════════════════════════════════════════════════

test('🔴 投稿被审之后版本号被别的 PR 占了 → 拒', () => {
  // 投稿 PR 上那次判定是在**它自己的 base** 上做的；两次之间可能有别的 PR 先合并
  expectCode('E_VERSION_TAKEN', () => assertVersionsStillFree({
    newIds: ['skill:geoly/a@1.0.0'], existingIds: ['skill:geoly/a@1.0.0'],
  }));
  assert.equal(assertVersionsStillFree({
    newIds: ['skill:geoly/a@1.0.1'], existingIds: ['skill:geoly/a@1.0.0'],
  }), true);
});

test('🔴 本批内部重复的 ArtifactId 也要拒', () => {
  expectCode('E_VERSION_TAKEN', () => assertVersionsStillFree({
    newIds: ['skill:geoly/a@1.0.0', 'skill:geoly/a@1.0.0'], existingIds: [],
  }));
});

test('空的 newIds 没有意义 —— 拒，不静默通过', () => {
  expectCode('E_VERIFY_INPUT', () => assertVersionsStillFree({ newIds: [], existingIds: [] }));
});

// ════════════════════════════════════════════════════════════════════════════

test('🔴 CLI 真调用：失效的 approve 要让它非零退出（入口守卫）', () => {
  const root = mkroot();
  const f = join(root, 'reviews.json');
  writeFileSync(f, JSON.stringify([rv(M1, 'APPROVED', OLD, '2026-08-01T00:00:00Z')]));
  const bad = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/promote/verify-merged-pr.mjs'),
    '--reviews', f, '--pr-head-sha', HEAD, '--maintainer-ids', MAINT.join(','), '--needed', '1',
  ], { encoding: 'utf8' });
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /只有 0 条有效 approve/);

  writeFileSync(f, JSON.stringify([rv(M1, 'APPROVED', HEAD, '2026-08-01T00:00:00Z')]));
  const ok = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/promote/verify-merged-pr.mjs'),
    '--reviews', f, '--pr-head-sha', HEAD, '--maintainer-ids', MAINT.join(','), '--needed', '1',
  ], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), M1, '🔴 退出码 0 但没输出 —— 入口守卫判假的症状');
});

test('🔴 机器人的 approve 不算 —— 只有 maintainerIds 里的人算数', () => {
  // 不限定的话，一个 dependabot[bot] 的 APPROVED 就能满足审批门
  const { value, err } = quiet(() => ca({
    reviews: [rv('MDQ6Bot_dependabot', 'APPROVED', HEAD, '2026-08-01T00:00:00Z', 'dependabot[bot]')],
  }));
  assert.deepEqual(value, []);
  assert.match(err, /不是维护者/, '被排掉的也要让人看见');
});

test('🔴 同一秒的两条 review：按数组顺序取后一条', () => {
  // GitHub 的 submitted_at 精度只到秒；用 `>` 的话「先 APPROVED 后
  // CHANGES_REQUESTED、时间戳相同」会保留 APPROVED
  const T = '2026-08-01T00:00:00Z';
  const { value } = quiet(() => ca({ reviews: [
    rv(M1, 'APPROVED', HEAD, T),
    rv(M1, 'CHANGES_REQUESTED', HEAD, T),
  ] }));
  assert.deepEqual(value, [], '同一秒里后一条才作数');
});

test('🔴 PENDING 的 review 跳过，不报错（它的 submitted_at 可以是 null）', () => {
  const { value } = quiet(() => ca({ reviews: [
    { userId: M1, state: 'PENDING', commitId: HEAD, submittedAt: null },
    rv(M2, 'APPROVED', HEAD, '2026-08-01T00:00:00Z'),
  ] }));
  assert.deepEqual(value, [M2], '一条草稿不该让整次验证中止');
});

test('🔴 判据是 node id 不是 login：Alice 与 alice 不是两个人', () => {
  const { value } = quiet(() => ca({
    reviews: [
      rv(M1, 'APPROVED', HEAD, '2026-08-01T00:00:00Z', 'Alice'),
      rv(M1, 'APPROVED', HEAD, '2026-08-02T00:00:00Z', 'alice'),
    ],
  }));
  assert.deepEqual(value, [M1], '同一个 id 就是同一个人，凑不出两票');
});
