// §7 的审批人数门，跑在**合并之前** —— 06-submission.md §7 + §10。
//
// 🔴 这一份钉的是「合并前 ≠ 合并后」：「进了 main 但没发布」和「从来没进过 main」
//    是两回事 —— main 上的内容会被 clone、被 fork、被搜索引擎抓。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
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

// 2026-09-01：作者排除**已关闭**（`scripts/submission/approval-policy.mjs`）。
// 原因见那里的长注释：维护者只有 2 人时，排除作者把「维护者自己的 Tier 2 投稿」
// 变成了永远解不开的死锁，而它当时挡住的**只有我们自己**（外部投稿者不是维护者，
// 两个维护者都算数）。这条测试从「不计入」翻成「计入」，是策略变更不是回归。
test('作者本人的 approve 计入（作者排除已关闭）', () => {
  const eff = assertTierApprovals({
    tier: 0, reviews: [rv(AUTHOR)], prHeadSha: HEAD,
    maintainerIds: [AUTHOR, M1], authorId: AUTHOR,
  });
  assert.deepEqual(eff, [AUTHOR]);
});

// 🔴 关掉作者排除**没有**把 Tier 2 降成一个人 —— 作者只能算 2 票里的 1 票。
//    这条是上面那条的边界：别把「我可以批自己的」读成「我一个人什么都能发」。
test('🔴 Tier 2 仍要两个不同的人，作者只算其中一个', () => {
  quiet(() => expectCode('E_TIER_APPROVALS', () => assertTierApprovals({
    tier: 2, reviews: [rv(AUTHOR)], prHeadSha: HEAD,
    maintainerIds: [AUTHOR, M1], authorId: AUTHOR,
  })));
  const eff = assertTierApprovals({
    tier: 2, reviews: [rv(AUTHOR), rv(M1)], prHeadSha: HEAD,
    maintainerIds: [AUTHOR, M1], authorId: AUTHOR,
  });
  assert.equal(eff.length, 2);
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

// ── 🔴🔴 声明压不住载荷 ────────────────────────────────────────────────────

test('🔴🔴 声明 network、载荷里全是 .sh → Tier 抬到 2', () => {
  // 只按声明算，等于让被检的一方决定要几个人审他。
  // assertCapabilityConsistency 只在声明是 ["none"] 时才比对载荷，
  // 所以「声明 network、实际带脚本」这条路上一道门都没有。
  const root = join(mkroot(), 'submissions');
  const dir = join(root, 'geoly', 'a@1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# a\n');
  writeFileSync(join(dir, 'skill.json'), JSON.stringify({ name: 'a', capabilities: ['network'] }));
  writeFileSync(join(dir, 'setup.sh'), 'echo hi\n');

  const r = quiet(() => batchTier(root));
  assert.equal(r.tier, 2, '声明说 Tier 1，载荷说 Tier 2 —— 取高的');
  assert.match(r.why.join('\n'), /声明压不住载荷/);
  assert.match(r.why.join('\n'), /setup\.sh/, '要指名道姓，否则审的人不知道是哪一处');
});

test('🔴 shebang 与可执行位同样抬档', () => {
  for (const [file, content, mode] of [
    ['tool', '#!/bin/sh\necho hi\n', 0o644],
    ['plain.md', 'no shebang\n', 0o755],
  ]) {
    const root = join(mkroot(), 'submissions');
    const dir = join(root, 'geoly', 'a@1.0.0');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# a\n');
    writeFileSync(join(dir, 'skill.json'), JSON.stringify({ name: 'a', capabilities: ['none'] }));
    writeFileSync(join(dir, file), content, { mode });
    chmodSync(join(dir, file), mode);
    assert.equal(quiet(() => batchTier(root)).tier, 2, file);
  }
});

test('干净的 Tier 0 投稿不会被误抬', () => {
  const root = join(mkroot(), 'submissions');
  const dir = join(root, 'geoly', 'a@1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# a\n\n普通正文。\n');
  writeFileSync(join(dir, 'skill.json'), JSON.stringify({ name: 'a', capabilities: ['none'] }));
  writeFileSync(join(dir, 'references.md'), '# 参考\n');
  assert.equal(quiet(() => batchTier(root)).tier, 0, '误抬的话，所有投稿都要两名 —— 门会被关掉');
});
