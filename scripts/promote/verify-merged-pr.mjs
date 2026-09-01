#!/usr/bin/env node
// promote 前的**重新验证** —— 06-submission.md §3。
//
// 🔴 §3 的原话：「promote 时必须**重新验证**（不能只信『已 merge』这个事实）」，
//    四项：
//      1. 被合并的投稿 PR 的 head SHA 与 approve 时的 SHA 一致（approval 未失效）；
//      2. 该 PR 的变更路径只有 `submissions/**`；
//      3. 载荷重跑一遍全部结构门；
//      4. 版本号在该 `<ns>/<name>` 下从未被使用过（含已 yank）。
//
//    本模块做 1 与 4（2 复用 `pr-classify.assertPathsAllowed`，
//    3 复用 `submission/run-gates.mjs` —— 不另写一份，那是 R-11 的形状）。
//
// 🔴 **不碰网络**：approval 记录、head SHA、改动路径都由 `promote.yml` 从 API
//    取好后传进来。判定这一半才能在本机跑遍所有分支。
//
// ⚠️ **为什么「已 merge」不够**：分支保护可以配 stale-approval dismissal，
//    但那是**仓库设置**，不是我们能证明的东西。设置被改、或某次绕过，
//    都会让一个「approve 之后又推了一版」的 PR 带着旧审批进 promotion。
//    §3 要求在 promote 这一侧再判一次，判据是**每条 approve 挂在哪个 commit 上**。

import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { effectiveApprovers, exclusionNote } from '../submission/approval-policy.mjs';

class VerifyError extends Error {
  constructor(code, msg) { super(msg); this.name = 'VerifyError'; this.code = code; }
}
const bad = (code, msg) => { throw new VerifyError(code, msg); };

const RE_SHA = /^[0-9a-f]{40}$/;

/**
 * §3 第 1 项：approve 必须挂在**被合并的那个 PR head SHA** 上。
 *
 * 🔴 **`prHeadSha` 是 PR 的 `head.sha`，不是 `merge_commit_sha`。**
 *    squash / rebase 合并会生成一个**新** commit，而 review 的 `commit_id` 挂在
 *    原 head 上 —— 传错的话**所有**审批都会被判成失效、promote 永远跑不起来
 *    （Codex 2026-08-31）。参数名特意叫 `prHeadSha` 就是为了别传错。
 *
 * 🔴 **挂在旧 commit 上的 approve 一律不算**，哪怕 GitHub 界面上还显示成绿的。
 *    「approve 之后又推了一版」是投稿流程里最常见的失效方式 ——
 *    审的人看到的和最终合并的不是同一份内容。
 *
 * 🔴 **判据是不可变的 node id，不是 login**（同 pr-classify.mjs 那条）：
 *    login 可改名、大小写也可能不同 —— `Alice` 与 `alice` 会被算成两个人，
 *    而「排除投稿者本人」也会因此失效。
 *
 * 🔴 **只有 `maintainerIds` 里的人算数。** 不限定的话，一个机器人（如
 *    `dependabot[bot]`）的 APPROVED 就能满足审批门。§7 说的是「**维护者** approve」。
 *
 * 🔴 `PENDING` 的 review **跳过**，不报错：它是还没提交的草稿，
 *    GitHub 的 `submitted_at` 对它可以是 `null`。
 *
 * @param {object} a
 * @param {Array<{userId:string, userLogin?:string, state:string, commitId:string, submittedAt:string}>} a.reviews
 * @param {string} a.prHeadSha
 * @param {string[]} a.maintainerIds
 * @returns {string[]} 有效 approver 的 **id**（去重、按字节序）
 */
export function currentApprovers({ reviews, prHeadSha, maintainerIds }) {
  if (!RE_SHA.test(prHeadSha ?? '')) {
    bad('E_VERIFY_INPUT', `prHeadSha 必须是 40 位小写 hex，得到 ${JSON.stringify(prHeadSha)}`);
  }
  if (!Array.isArray(reviews)) bad('E_VERIFY_INPUT', 'reviews 必须是数组');
  if (!Array.isArray(maintainerIds) || maintainerIds.length === 0) {
    bad('E_VERIFY_INPUT', 'maintainerIds 必须是非空数组 —— 不限定的话一个机器人的 approve 就能过门');
  }
  const maintainers = new Set(maintainerIds);

  // 每人只看**最新一条**。
  // 🔴 平局用 `>=`：GitHub 的 submitted_at 精度只到秒，同一秒里的两条要按
  //    **数组顺序**（API 是按时间返回的）取后一条。用 `>` 的话，
  //    「先 APPROVED 后 CHANGES_REQUESTED、时间戳相同」会保留 APPROVED（Codex 2026-08-31）。
  const latest = new Map();
  for (const r of reviews) {
    if (r?.state === 'PENDING') continue;           // 草稿，还没提交
    for (const [k, v] of [['userId', r?.userId], ['state', r?.state],
      ['commitId', r?.commitId], ['submittedAt', r?.submittedAt]]) {
      if (typeof v !== 'string' || v === '') bad('E_VERIFY_INPUT', `review.${k} 必须是非空字符串`);
    }
    const prev = latest.get(r.userId);
    if (prev === undefined || r.submittedAt >= prev.submittedAt) latest.set(r.userId, r);
  }

  const stale = [];
  const notMaintainer = [];
  const approvers = [];
  for (const r of latest.values()) {
    if (r.state !== 'APPROVED') continue;
    const who = `${r.userLogin ?? '(未给 login)'}(id=${r.userId})`;
    if (!maintainers.has(r.userId)) { notMaintainer.push(who); continue; }
    if (r.commitId !== prHeadSha) { stale.push(`${who} approve 在 ${r.commitId.slice(0, 12)}`); continue; }
    approvers.push(r.userId);
  }
  // 🔴 **不静默丢弃** —— 被排掉的 approve 要让人看见，
  //    否则「怎么少了一票」没人查得出来。
  if (stale.length) {
    process.stderr.write(
      `⚠️ 以下 approve 挂在**旧 commit** 上，不计入（PR head 是 ${prHeadSha.slice(0, 12)}）：${stale.join('、')}\n`,
    );
  }
  if (notMaintainer.length) {
    process.stderr.write(`⚠️ 以下 approve 不是维护者，不计入：${notMaintainer.join('、')}\n`);
  }
  return [...new Set(approvers)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/**
 * §3 第 1 项的断言形态。
 *
 * @param {object} a
 * @param {Array} a.reviews
 * @param {string} a.prHeadSha
 * @param {string[]} a.maintainerIds
 * @param {number} a.needed         Tier 决定的最少人数（0/1 → 1，2 → 2）
 * @param {string|null} a.authorId  投稿者的 node id（不计入）
 */
export function assertApprovalsCurrent({ reviews, prHeadSha, maintainerIds, needed, authorId = null }) {
  if (!Number.isInteger(needed) || needed < 1) bad('E_VERIFY_INPUT', `needed 必须是正整数，得到 ${needed}`);
  const all = currentApprovers({ reviews, prHeadSha, maintainerIds });
  // 🔴 与 tier-gate 共用同一份策略 —— 分叉的后果是「合并前过了、promote 时不过」。
  const effective = effectiveApprovers({ all, authorId });
  if (effective.length < needed) {
    bad('E_APPROVAL_STALE',
      `PR head ${prHeadSha.slice(0, 12)} 上只有 ${effective.length} 条有效 approve，需要 ${needed} 条。\n`
      + '  🔴 §3：promote 时必须重新验证 approval 未失效 —— 「已 merge」这个事实本身不够，'
      + '分支保护的 stale-dismissal 是仓库设置，不是我们能证明的东西。'
      + exclusionNote({ all, authorId }),
    );
  }
  return effective;
}

/**
 * §3 第 4 项：版本号在该 `<ns>/<name>` 下从未被使用过（**含已 yank**）。
 *
 * 🔴 与 `submission/structural-gates.assertVersionUnused` 是**同一条规则的两次执行**：
 *    投稿 PR 上判过一次，promote 时再判一次。这不是冗余 —— 两次之间可能有别的
 *    PR 先合并并占用了同一个版本号，而投稿 PR 那次的判定是在**它自己的 base** 上做的。
 *
 * 🔴 **`existingIds` 只能来自「合并后的 main 上的 `artifacts/` 树」，且必须在
 *    promote 把文件搬过去**之前**扫。** 两个都不能用（Codex 2026-08-31）：
 *      · **上一张快照** —— 快照与 `artifacts/` 可能暂时不一致；一个已存在（甚至已 yank）
 *        但还没进快照的版本会被错误放行；
 *      · **搬完之后的树** —— 那里已经有本次的新目录，每个 newId 都会被判成「已占用」。
 *
 * ⚠️ **并发 promotion 仍有 TOCTOU**：两张 promotion PR 从同一基线各自判过「没占用」，
 *    P1 先合并之后 P2 带着过期判定也能合并。闭合要靠 `promote.yml` 的 concurrency
 *    串行化 + `validate-promotion` 在**最终 base** 上再判一次。前者已配；
 *    后者由 `verify-promotion.mjs` 的**不可变门**承担 —— 它拿 base 上编号最大的
 *    那张快照当判据，重用一个已发布版本号会表现为 `E_ARTIFACT_MUTATED`。
 */
export function assertVersionsStillFree({ newIds, existingIds }) {
  if (!Array.isArray(newIds) || newIds.length === 0) {
    bad('E_VERIFY_INPUT', 'newIds 必须是非空数组 —— 一次没有新增制品的 promote 没有意义');
  }
  const taken = newIds.filter((id) => existingIds.includes(id));
  if (taken.length) {
    bad('E_VERSION_TAKEN',
      `这些版本号在投稿被审之后已经被占用了：\n${taken.map((t) => `  · ${t}`).join('\n')}\n`
      + '  🔴 投稿 PR 上那次判定是在**它自己的 base** 上做的；两次之间可能有别的 PR 先合并。\n'
      + '  制品不可变，版本号不可重用（含已 yank）—— 请发新版本。');
  }
  // 本批内部也不能重复
  const dup = newIds.filter((id, i) => newIds.indexOf(id) !== i);
  if (dup.length) bad('E_VERSION_TAKEN', `本批内部有重复的 ArtifactId：${[...new Set(dup)].join('、')}`);
  return true;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad('E_VERIFY_INPUT', `不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad('E_VERIFY_INPUT', `${name} 需要一个值`);
    o[name.slice(2)] = val;
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  for (const k of ['reviews', 'pr-head-sha', 'maintainer-ids', 'needed']) {
    if (o[k] === undefined) bad('E_VERIFY_INPUT', `缺少 --${k}`);
  }
  // `--reviews` 是一份 JSON 数组（由 promote.yml 用 gh api 取好后写进文件再喂进来）
  const reviews = JSON.parse(readFileSync(o.reviews, 'utf8'));
  const approvers = assertApprovalsCurrent({
    reviews,
    prHeadSha: o['pr-head-sha'],
    maintainerIds: o['maintainer-ids'].split(',').map((x) => x.trim()).filter(Boolean),
    needed: Number(o.needed),
    authorId: o['author-id'] ?? null,
  });
  process.stdout.write(`${approvers.join(',')}\n`);
  process.stderr.write(`✔ ${approvers.length} 条有效 approve（维护者，且挂在 PR head 上）：${approvers.join('、')}\n`);
  return 0;
}

export { VerifyError };

// 入口守卫比 realpath —— 见 scripts/release/build-timestamp.mjs 里的说明。
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return true; }
}

if (invokedDirectly()) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
