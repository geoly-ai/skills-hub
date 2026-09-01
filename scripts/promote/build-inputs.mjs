#!/usr/bin/env node
// promotion inputs —— 把**投稿 PR 的事实**变成 `build-snapshot.mjs --inputs` 吃的那份文件。
// 06-submission.md §1 / §6 / §7，05-lifecycle.md §7（所有权转让与失联接管）。
//
// 🔴 **这是 M2 交付汇报里待拍板项①的闭合点。** 快照 record 必填 `owner` 与
//    `review{pr, approved_by, head_sha, capability_tier}`，而这四样全是投稿 PR 的事实。
//    M2 把它们留成一个显式的 `--inputs` 文件、刻意不替 M3 拍板；由本脚本产出它，
//    `build-snapshot.mjs` **一行都不用改**。
//
// 🔴 **本脚本不碰网络、不调 GitHub API。** PR 号、head SHA、approver 名单、
//    本次新增了哪些 ArtifactId —— 全由 `promote.yml` 从 API / diff 取好后传参进来。
//    把「取事实」与「按事实判定」分开，判定这一半才能在本机跑遍所有分支。
//
// ══════════════════════════════════════════════════════════════════════════
// 🔴 第一版（2026-08-31）被 Codex 评审打回，四条阻断项的根因是同一个：
//    **拿手写的 manifest 测了这个生成器，从没让它过真正的制品校验器。**
//    修法记在这里，免得下一版又长回去：
//
//    ① `owner` **不在** manifest 里。`artifact.mjs` 的 SKILL_MANIFEST_KEYS /
//       PACK_MANIFEST_KEYS 是**精确键集**，都没有 `owner` —— 带 owner 的
//       skill.json 会被制品校验器直接拒。所以首次注册的 owner 只能是
//       **PR 侧的事实**（认证过的投稿者），由 `--claim-owner` 传进来。
//    ② pack **没有** `provenance`（PACK_MANIFEST_KEYS 里没有这个字段），
//       所以 pack 的 provenance 同样只能由 PR 侧给（`--provenance-of`）。
//    ③ pack 的成员 capability 不必新加输入：§6 的 pack lock 要求成员**已 published**，
//       于是它们要么在**上一张快照**里、要么在本批新增里 —— 两处都查得到。
//    ④ **不扫全量 `artifacts/` 去重写历史。** 只处理本次新增的 ArtifactId；
//       其余从上一张快照**继承**它们原本的 owner / review / status / provenance。
//       扫全量会把每个历史制品的 review 改写成本次 PR 的审批事实 ——
//       那是篡改审计记录，还会把 `deprecated` 抹成 `published`。
// ══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { stringify, parseStrict } from '../../src/canonical-json.mjs';
import { parseArtifactId, contractPathsChanged } from '../../src/pack.mjs';

export const INPUTS_SCHEMA = 'geoly.skills.promotion-inputs/1';
export const OWNERS_SCHEMA = 'geoly.skills.owners/1';

class PromoteError extends Error {
  constructor(msg) { super(msg); this.name = 'PromoteError'; }
}
const bad = (msg) => { throw new PromoteError(msg); };

// ── §7 capability 分级 ─────────────────────────────────────────────────────

const TIER_OF = Object.freeze({
  __proto__: null,
  none: 0,
  network: 1,
  'external-tool': 1,
  shell: 2,
  credentials: 2,
  'writes-repo': 2,
});
export const MAX_TIER = 2;

/**
 * §7 的那张表。
 *
 * 🔴 **认不出来的 capability 一律按最高档，不是忽略。** 一个没见过的能力名要么
 *    拼错了、要么比表里任何一项都新 —— 两种都不该按 Tier 0 放行。
 * ⚠️ Codex 2026-08-31 提醒：这比降级安全，但**仍会把语义未定义的能力签进快照**。
 *    真正的闭合是让 `skill.json` 的 schema 只收枚举值，那要连同安装侧的
 *    capability 确认与 §8 的审查问题一起改，属于规格侧动作，不在本脚本。
 * @returns {0|1|2}
 */
export function capabilityTier(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    bad('capabilities 必须是非空数组（`none` 也要显式写出来）');
  }
  let tier = 0;
  for (const c of capabilities) {
    if (typeof c !== 'string') bad(`capability 必须是字符串，得到 ${JSON.stringify(c)}`);
    if (!Object.hasOwn(TIER_OF, c)) {
      process.stderr.write(`⚠️ 不认识的 capability ${JSON.stringify(c)}：按最高档 Tier ${MAX_TIER} 处理\n`);
      tier = MAX_TIER;
      continue;
    }
    if (TIER_OF[c] > tier) tier = TIER_OF[c];
  }
  return tier;
}

/**
 * §7：Tier 0/1 要一名维护者 approve，Tier 2 要**两名**。
 *
 * 🔴 **同一个人 approve 两次不算两名** —— 判据是去重后的人数。「两名维护者」
 *    保护的是两双独立的眼睛，不是两条 approve 记录。
 * 🔴 **投稿者自己不算。** 规范没明写，但 Tier 2 的用意是独立复核。
 *
 * ⚠️ **诚实边界**（Codex 2026-08-31）：这里只数 login 字符串，**证明不了**
 *    「该人是维护者」「该 approve 针对的是这个 head_sha」「approve 当前有效」。
 *    那三件事只有 GitHub API 答得了，属于 `promote.yml` 取事实那一半的责任
 *    （§3 要求 promote 时重新验证 approval 未失效）。本函数只做**数量**判定。
 */
export function assertApprovalsSatisfyTier({ tier, approvedBy, author = null, where = 'review' }) {
  if (!Array.isArray(approvedBy)) bad(`${where}.approved_by 必须是数组`);
  const uniq = [...new Set(approvedBy.map((a) => {
    if (typeof a !== 'string' || a === '') bad(`${where}.approved_by 里有空项`);
    return a;
  }))];
  const effective = author === null ? uniq : uniq.filter((a) => a !== author);
  const need = tier >= MAX_TIER ? 2 : 1;
  if (effective.length < need) {
    bad(
      `${where}：Tier ${tier} 需要 ${need} 名维护者 approve，实际只有 ${effective.length} 名`
      + `（去重后：${effective.join(', ') || '(无)'}`
      + (author !== null && uniq.includes(author) ? `；已排除投稿者本人 ${author}` : '')
      + '）',
    );
  }
  return effective.sort();
}

// ── §6 namespace 所有权 + 05-lifecycle §7 转让/接管 ────────────────────────

export function readOwners(path) {
  if (!existsSync(path)) return { schema: OWNERS_SCHEMA, namespaces: {} };
  const doc = parseStrict(readFileSync(path, 'utf8'));
  if (doc.schema !== OWNERS_SCHEMA) bad(`owners.json 的 schema 应为 ${OWNERS_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
  if (doc.namespaces === null || typeof doc.namespaces !== 'object' || Array.isArray(doc.namespaces)) {
    bad('owners.json.namespaces 必须是对象（namespace → owner）');
  }
  for (const [ns, o] of Object.entries(doc.namespaces)) assertOwnerShape(o, `owners.namespaces[${ns}]`);
  return doc;
}

function assertOwnerShape(o, where) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) bad(`${where} 必须是对象`);
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'id,kind,login') bad(`${where} 的键集必须正好是 {kind, login, id}，得到 {${keys}}`);
  for (const k of ['kind', 'login', 'id']) {
    if (typeof o[k] !== 'string' || o[k] === '') bad(`${where}.${k} 必须是非空字符串`);
  }
  return o;
}

/**
 * §6：「与 `owners.json` 一致，**或首次注册**」。
 *
 * 🔴 **所有权转让 / 失联接管不需要本脚本发明机制。** 05-lifecycle.md §7 已经
 *    定死了它的形态：转让是「现 owner 与新 owner 在同一张 PR 里各自签字，维护者合并」，
 *    接管是「维护者可以接管，**必须留公开记录 `advisories/` 或 `registry/owners.json`
 *    的变更历史**」。
 *
 *    两者**都是通过在一张受审的 PR 里改 `owners.json` 完成的** —— 那张 PR 的评论
 *    是签字，git 历史就是公开记录。所以本脚本这一侧只要一条规则：
 *    **owner 一律以 `owners.json` 为准**。
 *
 *    ⚠️ 第一版我加了一个带 `evidence` 的 `ownerChange` 参数，Codex 2026-08-31 指出
 *    它校验完就把 evidence 扔了、留不下审计链。追下去发现问题更根本：
 *    **那是在 §7 已有的机制之外另造一套平行机制**。删掉它比给它补审计链更对 ——
 *    多一条能改 owner 的路径，就多一处要证明「它和 owners.json 不会分叉」。
 *
 * @param {object} a
 * @param {object} a.owners
 * @param {string} a.namespace
 * @param {object} [a.claims]  `namespace → owner`，**仅首次注册**时由 PR 侧给出
 * @param {string|null} [a.authorId]  投稿 PR 作者的不可变 node id
 *
 * 🔴🔴 **`claims` 必须按 namespace 索引，不能是一个标量。**
 *    第一版收的是单个 owner 对象，于是一次 promote 里
 *    「`a/foo` 没声明 + `b/bar` 声明了 b 的 owner」会把**两个** namespace
 *    都注册到 b 的 owner 名下 —— 一次静默的所有权错配（Codex 2026-08-31）。
 *
 * 🔴 **已注册的 namespace 要核作者**（05-lifecycle §1：「之后该 namespace 下的
 *    投稿，PR 作者必须匹配绑定身份，否则需 owner 在 PR 里明确同意」）。
 *    「明确同意」是人的动作，没有自动判据 —— 所以这里硬拒，
 *    并指出正路：owner 与新 owner 在同一张 PR 里签字改 `owners.json`（§7）。
 */
/**
 * 🔴 **skill 的 provenance 里那几个「PR 事实」必须与真实 PR 对得上。**
 *
 * 2026-09-01 发现：这里原本把 `manifest.provenance` **原样取用**，从不与
 * `review.pr` / `review.author` 核对 —— 而那两个值就在同一个作用域里。
 * 于是投稿者可以在自己的 `skill.json` 里写
 * `{"kind":"original","author_github_id":"<任何人>","submitted_by_pr":999}`，
 * 它会原样进快照、成为**权威出处记录**。provenance 正是整条信任链要建立的
 * 那件事，而它当时是投稿者随手可写的。
 *
 * ⚠️ 更能说明问题的是它与 `PROMOTION.json` **自相矛盾**：
 *    `promotion-file.mjs` 明确**拒绝**投稿者声明 `author_github_id` /
 *    `submitted_by_pr`（理由写在那里：投稿者只能声明只有他知道的事），
 *    而 `skill.json` 这条路径却要求投稿者自己写同样两个字段。
 *    同一个仓库里两套相反的判断，其中一套是错的。
 *
 * 🔴 **这里选择 fail-closed 而不是静默改写。** 直接用真实值覆盖也能堵住漏洞，
 *    但那样「投稿者写错了」和「投稿者试图伪造」都会无声通过，
 *    而这两件事需要有人看见。写错了就报错，让人改。
 *
 * ⚠️ `vendored` 的 `imported_at` **没有在这里核对** —— build-inputs 拿不到 PR 的
 *    创建时刻（`review` 里没有这个字段）。这不是「已缓解」，是一处**已知的缺口**：
 *    投稿者仍可把 `imported_at` 写成任意时间。要闭合它得把 createdAt 一路传进来。
 *
 * @param {object} a
 * @param {object} a.provenance
 * @param {object} a.review   `{pr, author, headSha, approvedBy}`
 * @param {string} a.where    出错时指认是哪个制品
 * @returns {object} 原样返回（校验通过时）
 */
export function assertProvenanceMatchesPr({ provenance, review, where }) {
  const mustEqual = (field, got, want) => {
    if (got !== want) {
      bad(`${where} 的 provenance.${field} 是 ${JSON.stringify(got)}，`
        + `但这张 PR 的事实是 ${JSON.stringify(want)}。\n`
        + '  🔴 provenance 里的「PR 事实」不能由投稿者说了算 —— 它是整条信任链\n'
        + '     要建立的那件事本身。请改成真实值，或删掉让 promote 填。\n'
        + '  ⚠️ 这里刻意不静默改写：写错了和试图伪造，都需要有人看见。');
    }
  };
  if (provenance.kind === 'original') {
    mustEqual('author_github_id', provenance.author_github_id, review.author);
    mustEqual('submitted_by_pr', provenance.submitted_by_pr, review.pr);
  } else if (provenance.kind === 'vendored') {
    mustEqual('imported_by_pr', provenance.imported_by_pr, review.pr);
  }
  return provenance;
}

export function resolveOwner({ owners, namespace, claims = {}, authorId = null }) {
  const known = owners.namespaces[namespace];
  if (known !== undefined) {
    if (Object.hasOwn(claims, namespace)) {
      bad(`namespace ${namespace} 已经注册过了，不该再声明 claim_owner —— `
        + '换 owner 要走 05-lifecycle §7 的转让流程（双方在同一张 PR 里签字改 owners.json）。');
    }
    if (authorId !== null && known.id !== authorId && known.kind === 'user') {
      bad(
        `namespace ${namespace} 绑定的是 ${known.login}(id=${known.id})，`
        + `而本次投稿的作者是 id=${authorId}。\n`
        + '  🔴 05-lifecycle §1：之后该 namespace 下的投稿，PR 作者必须匹配绑定身份。\n'
        + '  要让别人往这个 namespace 投稿，走 §7 的转让 / 共有流程 ——\n'
        + '  那是一次改 owners.json 的受审 PR，不是 promote 能自己判的事。',
      );
    }
    return known;                                // 已注册：以表为准
  }
  const claimed = claims[namespace];
  if (claimed === undefined) {
    bad(
      `namespace ${namespace} 尚未注册，本次必须在 ${namespace} 下某个投稿的 `
      + 'PROMOTION.json 里给出 claim_owner'
      + '（首次注册；owner 不在 manifest 里 —— skill.json / pack.json 的键集是精确的、没有这个字段，'
      + '它是 PR 侧的事实）',
    );
  }
  return assertOwnerShape(claimed, `namespace ${namespace} 的 owner`);
}

// ── 组装 ───────────────────────────────────────────────────────────────────

function readManifest(artifactsRoot, a) {
  const dir = join(artifactsRoot, `${a.kind}s`, a.namespace, a.name, a.version);
  const file = a.kind === 'skill' ? 'skill.json' : 'pack.json';
  const p = join(dir, file);
  if (!existsSync(p)) bad(`${a.id} 缺少 ${file}（找的是 ${p}）`);
  return { manifest: parseStrict(readFileSync(p, 'utf8')), dir };
}

/**
 * 上一版 pack.json 的 `contract_paths` —— 用于 §3.1 的 D8 护栏。
 *
 * 🔴 第一版做的是近似（「只要声明了 contract_paths 就按变更处理」），
 *    Codex 指出那**正好留了一个绕过口**：上一版非空、本版清空时算出「未变更」，
 *    不升 Tier 2 —— 而「清空清单让门形同虚设」正是 D8 要防的那件事。
 *    现在按 `compatibility.previous` 去 artifacts 树里读上一版，用库里既有的
 *    `contractPathsChanged()` 做**精确**比对。
 */
function previousContractPaths(artifactsRoot, a, manifest) {
  const prev = manifest.compatibility?.previous;
  if (prev === null || prev === undefined) return null;      // 首版，没有上一版可比
  const p = join(artifactsRoot, 'packs', a.namespace, a.name, String(prev), 'pack.json');
  if (!existsSync(p)) {
    bad(`${a.id} 的 compatibility.previous = ${prev}，但 ${p} 不存在 —— 无法做 D8 的 contract_paths 比对`);
  }
  return parseStrict(readFileSync(p, 'utf8')).contract_paths ?? [];
}

/**
 * @param {object} a
 * @param {string} a.artifactsRoot
 * @param {string[]} a.newIds        🔴 **本次 PR 新增的 ArtifactId**（由 promote.yml 从 diff 得出）
 * @param {object|null} a.previousSnapshot  上一张快照（继承历史 record）
 * @param {object} a.owners
 * @param {{pr:number, headSha:string, approvedBy:string[], author:string|null}} a.review
 * @param {object} [a.claimOwner]    首次注册的 owner（PR 侧事实）
 * @param {object} [a.provenanceOf]  id → provenance（pack 用；skill 从 manifest 取）
 * @param {Array} [a.yanked]
 */
export function buildInputs({
  artifactsRoot, newIds, previousSnapshot = null, owners, review,
  claimOwner = undefined, provenanceOf = {}, yanked = [],
}) {
  if (!Number.isSafeInteger(review.pr) || review.pr <= 0) bad(`--pr 必须是正整数，得到 ${review.pr}`);
  if (typeof review.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(review.headSha)) {
    bad(`--head-sha 必须是 40 位小写 hex，得到 ${JSON.stringify(review.headSha)}`);
  }
  if (!Array.isArray(newIds)) bad('newIds 必须是数组（本次 PR 新增的 ArtifactId）');

  const artifacts = {};

  // ── ① 历史制品：从上一张快照**原样继承** ────────────────────────────────
  // 🔴 不重新生成它们的 review —— 那是它们当初被审时的事实，改掉就是篡改审计记录。
  //    `status` 同样继承（否则 deprecated 会被抹成 published）。
  const prevRecords = new Map();
  for (const r of previousSnapshot?.artifacts ?? []) {
    prevRecords.set(r.id, r);
    artifacts[r.id] = {
      status: r.status === 'yanked' || r.status === 'degraded' ? 'published' : r.status,
      // 🔴 yanked / degraded 是 build-snapshot **重算**的派生状态，不能当输入
      //    （它的 assertInputStatus 会拒）。yank 的权威是 yanked[]；
      //    degraded 每次 promotion 重算。这里把它们还原成底层的 published。
      owner: r.owner,
      review: r.review,
      provenance: r.provenance,
    };
  }

  // ── ② 本次新增：按 PR 的事实生成 ────────────────────────────────────────
  const newParsed = newIds.map((id) => parseArtifactId(id, '本次新增的 ArtifactId'));
  for (const a of newParsed) {
    if (prevRecords.has(a.id)) {
      bad(`${a.id} 已经在上一张快照里了 —— 制品不可变（01-artifacts.md §1），不能作为「新增」重发`);
    }
  }

  // capability 查表：已有的从上一张快照，新增的从 manifest。
  //
  // 🔴 **新增成员本身是 pack 时要递归。** `pack.json` 的键集里**没有** `capabilities`
  //    （PACK_MANIFEST_KEYS 是精确键集），读出来是 `undefined`，然后 `for…of undefined`
  //    直接抛 TypeError。上一版「pack 走 CLI 必崩」我只缩小了场景、没闭合 ——
  //    同一批里 pack A 的成员是新增的 pack B 时照样崩（Codex 2026-08-31）。
  //    pack 的 capability 按定义就是**成员并集**，所以往下递归即可。
  // 🔴 递归要**检测环**：pack 不可变，环意味着两个 pack 互相锁定对方的摘要，
  //    第一个都发布不出来 —— 是非法输入，不是要容忍的形状。不检测则栈溢出。
  const capsOf = (id, stack = []) => {
    const fromPrev = prevRecords.get(id);
    if (fromPrev !== undefined) return fromPrev.capabilities;
    const p = newParsed.find((x) => x.id === id);
    if (p === undefined) {
      bad(`成员 ${id} 既不在上一张快照里，也不在本次新增里 —— §6 的 pack lock 要求成员已 published`);
    }
    if (stack.includes(id)) bad(`pack 成员图有环：${[...stack, id].join(' → ')}`);
    const m = readManifest(artifactsRoot, p).manifest;
    if (p.kind === 'skill') return m.capabilities;
    const union = new Set();
    for (const mem of [...(m.members ?? []), ...(m.bundled ?? [])]) {
      for (const c of capsOf(mem.id, [...stack, id])) union.add(c);
    }
    if (union.size === 0) bad(`${id} 的成员并集为空 —— pack 至少要有一个成员`);
    return [...union];
  };

  for (const a of newParsed) {
    const { manifest } = readManifest(artifactsRoot, a);

    // §7：tier
    let tier;
    if (a.kind === 'skill') {
      tier = capabilityTier(manifest.capabilities);
    } else {
      // pack 的 Tier = 成员（含 bundled）capability 并集的最高档
      const union = new Set();
      for (const m of [...(manifest.members ?? []), ...(manifest.bundled ?? [])]) {
        for (const c of capsOf(m.id)) union.add(c);
      }
      tier = capabilityTier([...union]);
      // §3.1 / D8：contract_paths 变更 → 强制 Tier 2
      const prevPaths = previousContractPaths(artifactsRoot, a, manifest);
      if (prevPaths !== null && contractPathsChanged(manifest.contract_paths ?? [], prevPaths).changed) {
        tier = MAX_TIER;
      }
    }

    const approved = assertApprovalsSatisfyTier({
      tier, approvedBy: review.approvedBy, author: review.author, where: a.id,
    });
    const owner = resolveOwner({
      owners, namespace: a.namespace, claims: claimOwner ?? {}, authorId: review.author,
    });

    // provenance：skill 在 manifest 里；pack 的 manifest 键集里**没有**这个字段
    let provenance = a.kind === 'skill' ? manifest.provenance : provenanceOf[a.id];
    if (provenance === undefined) {
      bad(
        `${a.id} 没有 provenance。`
        + (a.kind === 'pack'
          ? 'pack.json 的键集里没有这个字段（03-packs.md §2），必须由 --provenance-of 提供。'
          : 'skill.json 必填它。'),
      );
    }
    provenance = assertProvenanceMatchesPr({ provenance, review, where: a.id });

    artifacts[a.id] = {
      status: 'published',
      owner,
      review: { pr: review.pr, approved_by: approved, head_sha: review.headSha, capability_tier: tier },
      provenance,
    };
  }

  // 🔴 **yank 名单必须从上一张快照继承。**
  //    上面把继承来的 `status: yanked` 还原成了 `published`（下游 assertInputStatus
  //    只收 published / deprecated，yank 的权威是 `yanked[]`）。可是如果这里不把
  //    `previousSnapshot.yanked` 带过来，那条制品就会被**重新发布**，
  //    连 reason 与 advisory 一起丢 —— 一个被 yank 的东西悄悄复活（Codex 2026-08-31）。
  // 🔴 合并规则：**继承的 ∪ 本次新增的，按 id 去重，继承的优先**。
  //    yank 是「只增」的：本次没提到某条不代表要解除它。
  //    真要解除 yank，那是一个需要单独设计的动作，不能靠「这次没传就没了」。
  const byId = new Map();
  for (const y of previousSnapshot?.yanked ?? []) byId.set(y.id, y);
  for (const y of yanked) {
    if (!byId.has(y.id)) byId.set(y.id, y);
  }
  const mergedYanked = [...byId.values()]
    .sort((x, y) => Buffer.compare(Buffer.from(x.id, 'utf8'), Buffer.from(y.id, 'utf8')));

  return { schema: INPUTS_SCHEMA, artifacts, yanked: mergedYanked };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad(`不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad(`${name} 需要一个值`);
    o[name.slice(2)] = val;
  }
  return o;
}

const readJson = (p) => parseStrict(readFileSync(p, 'utf8'));

export function main(argv) {
  const o = parseArgs(argv);
  for (const k of ['artifacts', 'new-ids', 'pr', 'head-sha', 'approved-by', 'out']) {
    if (o[k] === undefined) bad(`缺少 --${k}`);
  }
  const doc = buildInputs({
    artifactsRoot: o.artifacts,
    newIds: o['new-ids'].split(',').map((s) => s.trim()).filter(Boolean),
    previousSnapshot: o['previous-snapshot'] === undefined ? null : readJson(o['previous-snapshot']),
    owners: readOwners(o.owners ?? 'registry/owners.json'),
    review: {
      pr: Number(o.pr),
      headSha: o['head-sha'],
      approvedBy: o['approved-by'].split(',').map((s) => s.trim()).filter(Boolean),
      author: o.author ?? null,
    },
    // `--claim-owner` 现在是一份 `namespace → owner` 的表，不是单个 owner
    claimOwner: o['claim-owner'] === undefined ? undefined : readJson(o['claim-owner']),
    provenanceOf: o['provenance-of'] === undefined ? {} : readJson(o['provenance-of']),
    yanked: o.yanked === undefined ? [] : readJson(o.yanked),
  });
  writeFileSync(o.out, stringify(doc));
  process.stderr.write(
    `已写出 ${o.out}：${Object.keys(doc.artifacts).length} 个制品`
    + `（本次新增 ${o['new-ids'].split(',').filter(Boolean).length} 个，其余继承自上一张快照）\n`,
  );
  return 0;
}

export { PromoteError };

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
