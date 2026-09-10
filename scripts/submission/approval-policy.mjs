// 审批人数的**单一策略来源** —— 两处判定共用，不许各写各的。
//
// 🔴 **为什么必须共用一份**：`scripts/submission/tier-gate.mjs`（合并前）与
//    `scripts/promote/verify-merged-pr.mjs`（promote 时）问的是同一个问题。
//    两边分叉的后果是「合并前过了、promote 时不过」—— 那是整条链上最难查的
//    一类失败：PR 已经进了 main，发布却卡住，而两处的日志各自都说自己是对的。
//    早先这段逻辑是各写一遍的，靠注释提醒"必须一致"。注释拦不住复制粘贴。

/**
 * 🔴 **投稿者本人的 approve 算不算数。**
 *
 * 2026-09-01 用户拍板：**算**（本文件把它从 `true` 改成 `false`）。
 *
 * ⚠️ 关掉它**并不等于**「一个人什么都能发」，别据此再放宽别的门：
 *   · Tier 0/1 需要 1 票 → 维护者投自己的稿，确实可以独自发布；
 *   · Tier 2 原本仍需 **2 个不同的人**。
 *     ⚠️ **2026-09-10 起这句不再普遍成立**：豁免名单里的人在 PR 上投出当前有效的
 *     approve 时，Tier 2 也放行到 1 票（见下面 `approvalsWaived` 的 `approver` 路径）。
 *     这里保留原文是为了让改动可读 —— 别把上面那句当成现状。
 *
 * 改回来只要把这个常量翻成 `true`，两处判定同时生效。
 *
 * 📌 背景：排除作者原本是为了「两双眼睛」。但维护者只有 2 人时，它把
 *    **维护者自己的 Tier 2 投稿**变成了一个永远解不开的死锁（排除作者后
 *    只剩 1 个可用票，而门要 2 票）。外部投稿不受影响 —— 投稿者不是维护者，
 *    两个维护者都算数。也就是说这条规则当时挡住的**只有我们自己**。
 */
export const EXCLUDE_AUTHOR = false;

/**
 * 从「所有维护者 approve」里算出有效票。
 *
 * @param {object} a
 * @param {string[]} a.all       `currentApprovers()` 的结果
 * @param {string|null} a.authorId
 * @returns {string[]}
 */
export function effectiveApprovers({ all, authorId = null }) {
  if (!EXCLUDE_AUTHOR || authorId === null) return all;
  return all.filter((x) => x !== authorId);
}

/** 报错信息里那句「已排除投稿者本人」—— 关掉时不该出现，否则是误导。 */
export function exclusionNote({ all, authorId }) {
  return EXCLUDE_AUTHOR && authorId !== null && all.includes(authorId)
    ? `\n  （已排除投稿者本人 id=${authorId}）` : '';
}

/**
 * 🔴 **这些人自己投的稿，免掉「要几个人 approve」这道门。**
 *
 * 2026-09-01 用户拍板：「只要是我自己发，不管什么规则都可以发。」
 *
 * ⚠️ **免掉的只有审批人数，不是别的门。** 别把这个常量读成「他的投稿不检查」：
 *    结构门（§6）、不可见字符 / bidi 扫描（§8.5）、路径白名单、版本号是否被
 *    占用过、promote 时的确定性复算与不可变门 —— **一条都照跑**。
 *    这里放行的是「需要几个人点头」，不是「内容对不对」。
 *
 * 🔴 **判据是不可变 node id，不是 login。** login 能改名、也能被别人重新认领；
 *    写 login 的话，改名之后攻击者认领旧 login 就直接拿到这条豁免。
 *
 * ⚠️ **残余风险，明写不粉饰**：名单上的账号被接管 = 对方可以在无人复核的情况下
 *    往 registry 里发任何东西（内容门仍在，但内容门管不了「这东西该不该发」）。
 *    这是用户在明知的前提下选择的形态，不是疏漏。
 *
 * 📌 放行时**必须在日志里大声说出来**（见下面两个调用点）—— 一次静默的豁免
 *    和一道坏掉的门，事后看起来是一模一样的。
 */
export const APPROVAL_BYPASS_IDS = Object.freeze([
  'U_kgDODu4RvA', // chovizzz
]);

/**
 * 这次投稿的审批人数门要不要放行，以及**因为哪条**放行。
 *
 * 两条路：
 *   · `author`   —— 名单上的人**自己投的稿**（2026-09-01 拍板）
 *   · `approver` —— 名单上的人**在这张 PR 上投了当前有效的 approve**（2026-09-10 拍板）
 *
 * 🔴 **第二条是一次实质扩大，不是第一条的自然延伸。** 第一条覆盖的是
 *    「我发我自己的东西」，那本来就在我控制之下；第二条覆盖的是
 *    **替别人放行** —— 一张外部 Tier 2 投稿（声明了 shell / 凭据 / 写仓库能力，
 *    装到每台机器上都能执行任意命令）原本要两双眼睛，现在名单上的人一票即可。
 *    ⚠️ **残余风险**：名单上的账号被接管 = 对方可以让**任意外部投稿**过审批门。
 *    这是用户 2026-09-10 在明知代价的前提下选的形态，不是疏漏。
 *
 * 🔴 传进来的 `approvers` **必须是当前有效票**（`currentApprovers()` 的结果：
 *    已按 PR head sha 过滤、已按维护者名单过滤）。传"历史上所有 approve"
 *    会让一张被 push 冲掉的旧票继续放行 —— 那正是 validate-pr.yml 里
 *    写着的那条「第二票被 dismiss 之后 §7 的两名就这么没了」。
 *
 * @param {object} a
 * @param {string|null} a.authorId
 * @param {string[]} [a.approvers]  当前有效的维护者 approve id 列表
 * @returns {'author'|'approver'|null}
 */
export function approvalsWaived({ authorId, approvers = [] }) {
  if (typeof authorId === 'string' && authorId !== '' && APPROVAL_BYPASS_IDS.includes(authorId)) {
    return 'author';
  }
  if (Array.isArray(approvers) && approvers.some((x) => APPROVAL_BYPASS_IDS.includes(x))) {
    return 'approver';
  }
  return null;
}

/**
 * 放行时打在 stderr 上的那句话 —— 两处共用，措辞不许各写各的。
 *
 * 📌 **必须说清是哪条路放行的**：两条路的风险面完全不同（自己发 vs 替别人放行），
 *    事后翻日志时「豁免了」这三个字不够用。
 */
export function waiverNotice({ where, authorId, need, reason = 'author' }) {
  const who = reason === 'approver'
    ? `豁免名单里的维护者在本 PR 上投了当前有效的 approve（作者 id=${authorId ?? '未知'}）`
    : `作者 id=${authorId} 在审批豁免名单里`;
  return `⚠️ 🔴 ${where}：${who}，`
    + `跳过「需要 ${need} 名维护者 approve」这道门（reason=${reason}）。\n`
    + '   ⚠️ 只跳过审批人数 —— 结构门、字符扫描、路径白名单、版本号占用、'
    + '确定性复算**都仍然跑过了**。\n';
}
