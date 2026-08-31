// §7 的审批人数门，跑在**合并之前** —— 06-submission.md §7 + §10。
//
// 🔴 这一份钉的是「合并前 ≠ 合并后」：「进了 main 但没发布」和「从来没进过 main」
//    是两回事 —— main 上的内容会被 clone、被 fork、被搜索引擎抓。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { batchTier, neededFor, assertTierApprovals } from '../scripts/submission/tier-gate.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-tier-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const expectCode = (code, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

/** 静音 stderr（currentApprovers 的告警本身另有用例覆盖）。 */
function quiet(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stderr.write = orig; }
}

function submissions(specs) {
  const root = join(mkroot(), 'submissions');
  for (const { name, version = '1.0.0', kind = 'skill', capabilities, raw } of specs) {
    const dir = join(root, 'geoly', `${name}@${version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`);
    if (raw !== undefined) { writeFileSync(join(dir, 'skill.json'), raw); continue; }
    if (kind === 'pack') writeFileSync(join(dir, 'pack.json'), JSON.stringify({ name }));
    else writeFileSync(join(dir, 'skill.json'), JSON.stringify({ name, capabilities }));
  }
  return root;
}

const M1 = 'MDQ6User_m1'; const M2 = 'MDQ6User_m2'; const AUTHOR = 'MDQ6User_author';
const HEAD = 'a'.repeat(40);
const rv = (userId, state = 'APPROVED', commitId = HEAD) =>
  ({ userId, userLogin: userId, state, commitId, submittedAt: '2026-08-01T00:00:00Z' });

// ── Tier 计算 ──────────────────────────────────────────────────────────────

test('capability → Tier（§7 那张表）', () => {
  assert.equal(quiet(() => batchTier(submissions([{ name: 'a', capabilities: ['none'] }]))).tier, 0);
  assert.equal(quiet(() => batchTier(submissions([{ name: 'a', capabilities: ['network'] }]))).tier, 1);
  assert.equal(quiet(() => batchTier(submissions([{ name: 'a', capabilities: ['shell'] }]))).tier, 2);
});

test('🔴 一张 PR 里取**最高** Tier —— 它们是一起进 main 的', () => {
  const root = submissions([
    { name: 'a', capabilities: ['none'] },
    { name: 'b', capabilities: ['credentials'] },
  ]);
  assert.equal(quiet(() => batchTier(root)).tier, 2);
});

test('🔴 pack 按最高档处理 —— 成员的 capability 这一步看不到', () => {
  // fail-safe：算不出来就按最严的判，代价是一个全 Tier 0 成员的 pack 也要两名
  const r = quiet(() => batchTier(submissions([{ name: 'm', kind: 'pack' }])));
  assert.equal(r.tier, 2);
  assert.match(r.why[0], /pack/);
});

test('🔴 manifest 读不出来 / kind 判不出来 → 也按最高档，不当 Tier 0 放过', () => {
  assert.equal(quiet(() => batchTier(submissions([{ name: 'a', raw: '不是 json' }]))).tier, 2);
  const root = join(mkroot(), 'submissions');
  mkdirSync(join(root, 'geoly', 'a@1.0.0'), { recursive: true });
  writeFileSync(join(root, 'geoly', 'a@1.0.0', 'SKILL.md'), '#\n');
  assert.equal(quiet(() => batchTier(root)).tier, 2);
});

test('why 要说清楚每个制品是怎么算出来的', () => {
  const r = quiet(() => batchTier(submissions([{ name: 'a', capabilities: ['network'] }])));
  assert.match(r.why[0], /geoly\/a@1\.0\.0/);
  assert.match(r.why[0], /Tier 1/);
});

test('neededFor：0/1 → 1，2 → 2', () => {
  assert.equal(neededFor(0), 1);
  assert.equal(neededFor(1), 1);
  assert.equal(neededFor(2), 2);
});

// ── 审批人数 ───────────────────────────────────────────────────────────────

test('Tier 0：一名就够', () => {
  const r = quiet(() => assertTierApprovals({
    tier: 0, reviews: [rv(M1)], prHeadSha: HEAD, maintainerIds: [M1, M2],
  }));
  assert.deepEqual(r, [M1]);
});

test('🔴 Tier 2：一名不够，两名才行', () => {
  quiet(() => expectCode('E_TIER_APPROVALS', () => assertTierApprovals({
    tier: 2, reviews: [rv(M1)], prHeadSha: HEAD, maintainerIds: [M1, M2],
  })));
  const r = quiet(() => assertTierApprovals({
    tier: 2, reviews: [rv(M1), rv(M2)], prHeadSha: HEAD, maintainerIds: [M1, M2],
  }));
  assert.equal(r.length, 2);
});

test('🔴 判据与 promote 侧**完全一致**：旧 commit 上的 approve 不算', () => {
  // 两处分叉的话，会出现「合并前过了、promote 时不过」这种最难查的问题
  quiet(() => expectCode('E_TIER_APPROVALS', () => assertTierApprovals({
    tier: 0, reviews: [rv(M1, 'APPROVED', 'b'.repeat(40))], prHeadSha: HEAD, maintainerIds: [M1],
  })));
});

test('🔴 投稿者自己的 approve 不计入', () => {
  quiet(() => expectCode('E_TIER_APPROVALS', () => assertTierApprovals({
    tier: 0, reviews: [rv(AUTHOR)], prHeadSha: HEAD,
    maintainerIds: [AUTHOR, M1], authorId: AUTHOR,
  })));
});

test('🔴 非维护者的 approve 不计入', () => {
  quiet(() => expectCode('E_TIER_APPROVALS', () => assertTierApprovals({
    tier: 0, reviews: [rv('MDQ6Bot_dependabot')], prHeadSha: HEAD, maintainerIds: [M1],
  })));
});

test('🔴 报错要说明「新增 approve 不会自动重跑」，否则人会以为门坏了', () => {
  const e = quiet(() => expectCode('E_TIER_APPROVALS', () => assertTierApprovals({
    tier: 2, reviews: [rv(M1)], prHeadSha: HEAD, maintainerIds: [M1, M2],
  })));
  assert.match(e.message, /手动 re-run/);
  assert.match(e.message, /合并之前/);
});

// ── CLI ────────────────────────────────────────────────────────────────────

test('🔴 CLI：Tier 2 只有一票 → 非零退出', () => {
  const root = submissions([{ name: 'a', capabilities: ['shell'] }]);
  const rf = join(mkroot(), 'reviews.json');
  writeFileSync(rf, JSON.stringify([rv(M1)]));
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/submission/tier-gate.mjs'),
    '--submissions', root, '--reviews', rf,
    '--pr-head-sha', HEAD, '--maintainer-ids', `${M1},${M2}`,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_TIER_APPROVALS\]/);
  assert.match(r.stderr, /本批最高 Tier 2/);
});

test('CLI：Tier 0 一票通过', () => {
  const root = submissions([{ name: 'a', capabilities: ['none'] }]);
  const rf = join(mkroot(), 'reviews.json');
  writeFileSync(rf, JSON.stringify([rv(M1)]));
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/submission/tier-gate.mjs'),
    '--submissions', root, '--reviews', rf,
    '--pr-head-sha', HEAD, '--maintainer-ids', `${M1},${M2}`,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('🔴 CLI：维护者名单为空 → 拒（不限定的话机器人的 approve 就能过门）', () => {
  const root = submissions([{ name: 'a', capabilities: ['none'] }]);
  const rf = join(mkroot(), 'reviews.json');
  writeFileSync(rf, JSON.stringify([rv(M1)]));
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/submission/tier-gate.mjs'),
    '--submissions', root, '--reviews', rf,
    '--pr-head-sha', HEAD, '--maintainer-ids', '',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 1);
});

test('🔴 CLI 拒拼错的选项', () => {
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/submission/tier-gate.mjs'), '--submision', 'x',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_TIER_INPUT\]/);
});
