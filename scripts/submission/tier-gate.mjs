#!/usr/bin/env node
// §7 的审批人数门，**跑在合并之前** —— 06-submission.md §7 + §10。
//
// ── 🔴 为什么必须在合并前 ────────────────────────────────────────────────
// §10 要的是「Tier 2 需 **2** 名 CODEOWNERS approve」才能合并。
// 但分支保护的 Required approvals 是一个**静态数字**，配不出「按载荷内容决定」——
// 配成 2 会把 Tier 0 投稿也卡住（结果是没人投稿），配成 1 则 Tier 2 形同虚设。
//
// 我原先把这一半推给了 promote 时的 `assertApprovalsSatisfyTier`，
// 并说「效果一样，只是判的地方靠后」。**那是错的**（Codex 2026-08-31）：
// 「进了 main 但没发布」和「从来没进过 main」是两回事 ——
// main 上的内容会被 clone、被 fork、被搜索引擎抓，promote 拒掉它
// 并不能把它从历史里拿走。
//
// 所以这道门跑在投稿 PR 上，并挂进 `pr-gate`：required checks 是**固定名字**，
// 而一个必需的 check 失败，PR 就合不了 —— 用「门的成败」表达了
// Required approvals 表达不了的动态人数。
//
// ── ⚠️ 一处已知的粗糙 ───────────────────────────────────────────────────
// GitHub **不会**因为「有人新增了一条 approve」而重跑 workflow
// （`pull_request` 的事件类型里没有 review）。所以一张 Tier 2 的 PR 在拿到
// 第二名 approve 之后，这道门仍然停在上一次的失败上，要**手动 re-run**。
// 这是不便，不是漏洞：方向是安全的（少了不放行），且 re-run 一次就好。
// 🔴 不要为了省这一次 re-run 就把门改成「只警告」。

import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { parseStrict } from '../../src/canonical-json.mjs';
import { collectTree } from '../../src/packer.mjs';
import { scanSubmissions } from './run-gates.mjs';
import { executableEvidence } from './structural-gates.mjs';
import { capabilityTier } from '../promote/build-inputs.mjs';
import { currentApprovers } from '../promote/verify-merged-pr.mjs';

class TierError extends Error {
  constructor(code, msg) { super(msg); this.name = 'TierError'; this.code = code; }
}
const bad = (code, msg) => { throw new TierError(code, msg); };

/**
 * 本批投稿里**最高**的 Tier。
 *
 * 🔴 取最大值，不是逐个判：一张 PR 里既有 Tier 0 又有 Tier 2 时，
 *    整张 PR 都要按 Tier 2 审 —— 它们是一起合并的，一起进 main。
 *
 * 🔴 pack 的 Tier = 成员 capability 并集对应的最高 Tier（§7）。
 *    ⚠️ 本函数**算不出** pack 的 Tier：成员的 capability 在别的制品里，
 *    而这一步只看 `submissions/` 这一棵树。所以遇到 pack 一律按**最高档**
 *    处理 —— fail-safe，代价是一个全 Tier 0 成员的 pack 也要两名 approve。
 *    真要精确，得让这一步去读 `artifacts/` 里的成员 manifest，那是 base 上的
 *    事实、拿得到，但 pack 还有 R-19 那个更前面的问题（promote 现在根本收不了
 *    pack），所以先按最高档挡着。
 *
 * ── 🔴🔴 声明是投稿者写的，所以不能只信声明 ─────────────────────────────
 * `capabilities` 就在投稿自己的 `skill.json` 里。只按它算 Tier，等于
 * **让被检的一方决定要几个人审他** —— 写 `["network"]` 就只要一名。
 *
 * `assertCapabilityConsistency` 只在声明是 `["none"]` 时才比对载荷，
 * 所以「声明 network、实际带一堆 .sh」这条路上**一道门都没有**。
 *
 * 因此这里另算一个**下限**：载荷里只要有可执行位 / 脚本扩展名 / shebang，
 * 有效 Tier 至少是 2（那就是 `shell`）。最终 Tier = max(声明, 下限)。
 * 判据与结构门共用 `executableEvidence`，两处不会分叉。
 *
 * ⚠️ 这仍然只是**看得见的**迹象 —— 一段藏在 `SKILL.md` 正文里、让 agent 去
 *    执行命令的自然语言指令，任何静态判据都认不出来。那一条归 §8 人工门
 *    第 1、3、7 项。**不要把这道门说成「capability 声明被验证过了」。**
 *
 * @returns {{tier:number, why:string[]}}
 */
export function batchTier(submissionsRoot) {
  const why = [];
  let tier = 0;
  for (const s of scanSubmissions(submissionsRoot)) {
    const where = `${s.namespace}/${s.name}@${s.version}`;
    const packManifest = join(s.dir, 'pack.json');
    if (existsSync(packManifest)) {
      tier = 2;
      why.push(`${where}：pack —— 成员 capability 的并集这一步看不到，按最高档处理`);
      continue;
    }
    const skillManifest = join(s.dir, 'skill.json');
    if (!existsSync(skillManifest)) {
      // kind 判不出来是 run-gates 的活；这里不重复报，但也不能当 Tier 0 放过
      tier = 2;
      why.push(`${where}：既没有 skill.json 也没有 pack.json —— 按最高档处理`);
      continue;
    }
    let manifest;
    try {
      manifest = parseStrict(readFileSync(skillManifest, 'utf8'));
    } catch (e) {
      tier = 2;
      why.push(`${where}：skill.json 读不出来（${e.message.split('\n')[0]}）—— 按最高档处理`);
      continue;
    }
    let t = capabilityTier(manifest.capabilities);
    why.push(`${where}：capabilities=${JSON.stringify(manifest.capabilities)} → Tier ${t}`);

    // 🔴 载荷里的可执行迹象 —— 声明压不住它
    let evidence = [];
    try {
      evidence = executableEvidence(collectTree(s.dir));
    } catch (e) {
      evidence = [`载荷读不出来（${e.message.split('\n')[0]}）`];
    }
    if (evidence.length > 0 && t < 2) {
      why.push(`${where}：🔴 载荷里有可执行迹象，Tier ${t} → 2（声明压不住载荷）：`
        + evidence.slice(0, 3).join('；') + (evidence.length > 3 ? `……共 ${evidence.length} 处` : ''));
      t = 2;
    }
    if (t > tier) tier = t;
  }
  return { tier, why };
}

/** §7：Tier 0/1 一名，Tier 2 两名。 */
export const neededFor = (tier) => (tier >= 2 ? 2 : 1);

/**
 * @param {object} a
 * @param {number} a.tier
 * @param {Array} a.reviews        GitHub `/pulls/<n>/reviews` 映射过的形状
 * @param {string} a.prHeadSha
 * @param {string[]} a.maintainerIds
 * @param {string|null} a.authorId
 */
export function assertTierApprovals({ tier, reviews, prHeadSha, maintainerIds, authorId = null }) {
  const need = neededFor(tier);
  // 🔴 复用 promote 侧那一份 —— approve 是否挂在当前 head 上、是不是维护者、
  //    一个人只算最新一条，这些判据两处必须**完全一致**，否则会出现
  //    「合并前过了、promote 时不过」这种最难查的分叉。
  const all = currentApprovers({ reviews, prHeadSha, maintainerIds });
  const effective = authorId === null ? all : all.filter((a) => a !== authorId);
  if (effective.length < need) {
    bad('E_TIER_APPROVALS',
      `Tier ${tier} 需要 ${need} 名维护者 approve，当前只有 ${effective.length} 名。\n`
      + `  有效 approver：${effective.join('、') || '（无）'}\n`
      + '  🔴 §10 要求这一条在**合并之前**满足 —— 「进了 main 但没发布」\n'
      + '     和「从来没进过 main」是两回事：main 上的内容会被 clone、被 fork。\n'
      + '  ⚠️ 新增 approve **不会**自动重跑本门（GitHub 不为 review 事件触发\n'
      + '     pull_request）—— 拿到票之后手动 re-run 一次。');
  }
  return effective;
}

// ── CLI ────────────────────────────────────────────────────────────────────

const KNOWN = ['submissions', 'reviews', 'pr-head-sha', 'maintainer-ids', 'author-id'];

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad('E_TIER_INPUT', `不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const key = name.slice(2);
    if (!KNOWN.includes(key)) bad('E_TIER_INPUT', `不认识的选项 ${name}`);
    if (key in o) bad('E_TIER_INPUT', `${name} 给了不止一次`);
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad('E_TIER_INPUT', `${name} 需要一个值`);
    o[key] = val;
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  for (const k of ['submissions', 'reviews', 'pr-head-sha', 'maintainer-ids']) {
    if (o[k] === undefined) bad('E_TIER_INPUT', `缺少 --${k}`);
  }
  const { tier, why } = batchTier(o.submissions);
  for (const w of why) process.stderr.write(`  · ${w}\n`);
  process.stderr.write(`本批最高 Tier ${tier}，需要 ${neededFor(tier)} 名维护者 approve。\n`);

  const approvers = assertTierApprovals({
    tier,
    reviews: JSON.parse(readFileSync(o.reviews, 'utf8')),
    prHeadSha: o['pr-head-sha'],
    maintainerIds: o['maintainer-ids'].split(',').map((x) => x.trim()).filter(Boolean),
    authorId: o['author-id'] ?? null,
  });
  process.stderr.write(`✔ ${approvers.length} 名有效 approve：${approvers.join('、')}\n`);
  return 0;
}

export { TierError };

// 入口守卫比 realpath —— 见 scripts/release/build-timestamp.mjs 里的说明。
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return true; }
}

if (invokedDirectly()) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) {
    process.stderr.write(`${e.code ? `[${e.code}] ` : ''}${e.message}\n`);
    process.exit(1);
  }
}
