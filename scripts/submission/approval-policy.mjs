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
 *   · Tier 2 仍需 **2 个不同的人**，作者只能算其中 1 个 —— 带可执行迹象的
 *     投稿照旧需要第二双眼睛。这条**没有**被这次改动削弱。
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
