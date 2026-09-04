// 项目级 lockfile 的**预热 + 钩子** —— M4（`update` / `remove`）专用的接线。
//
// 背景（R-11 第四条，sync-lock.mjs 里已经如实写着）：`onLedgerChanged` 钩子是在
// `runCleanup()` 的**最后**才调的 —— 那时 tx 与 journal 都清掉了，账本已经提交。
// 钩子这时抛错的话，事务已经生效、项目 lockfile 却还是旧的，而 `recover` 已经
// 没有 journal 可重试。🔴 **这是已知缺口，不是被闭合了。**
//
// 钩子最容易抛的那一格是**可以提前挡掉的**：重算需要每个 entry 的 `asset_sha256`，
// 而账本里没有这个字段，只能回**历史快照**取（sync-lock.mjs 的 `assetSha256For`）。
// 缓存里少一张快照 → 取不到 → 抛。这一格与「事务本身」毫无关系，
// 完全可以在**还没动手**的时候就发现。
//
// 所以本模块做两件事：
//   ① `prewarmLockfileInputs()`：在取锁与提交**之前**，把 post-state 会用到的
//      每一张历史快照都取回来、**逐份独立验签**、并确认目标 record 真的在里面；
//   ② 返回一个共用**同一份 memo** 的 `onLedgerChanged` 钩子，于是收尾那一刻
//      不再需要任何新的 I/O 决策。
//
// ⚠️ **诚实边界**：这把「缓存里根本没有那张快照」搬到了免费的时刻，
//    但**不是**原子性修复。磁盘在两者之间坏掉、别的进程清了缓存，仍然会落回
//    那个已知缺口（兜底仍是 `check` 报「lockfile 过时」+ 用户跑 `sync-lock`）。

import { existsSync } from 'node:fs';
import { planTargets, assertPlanOk } from '../adapters/index.mjs';
import { layout, readLedger } from '../ledger.mjs';
import { historicalReader, isDegradable } from './snapshot-access.mjs';
import { recalcLockfile, assertNoUnrecoveredTx } from './sync-lock.mjs';
import { assertLedgerGraphUsable } from './refgraph.mjs';
import { NetworkError } from '../exit-codes.mjs';

/**
 * @param {object} o
 * @param {Function} o.verifier
 * @param {object|null} [o.current]   当前快照（有就先在它里面找，省一次历史读取）
 * @param {Array<{artifact:string, snapshot:number}>} [o.needs]
 *        本次事务**写入之后**会存在的 entry。与「账本里现有的」取并集。
 * @param {string[]} [o.ours]
 *        本次命令**会自己处理（含 `recover(auto)` 续做）**的 target。
 *        它们的未完成事务不在这里查 —— 那会把一次正常运行拒掉。
 * @returns {Function|undefined}  `onLedgerChanged` 钩子；非项目级时 `undefined`
 */
export async function prewarmLockfileInputs(
  ctx, { verifier, current = null, needs = [], ours = [], out } = {},
) {
  if (ctx.scope !== 'project') return undefined;
  const readHistorical = historicalReader(ctx, verifier);

  // ① 并集：本次要写入的 + **全部**项目级 target 账本里现有的。
  //    🔴 后者不能省：`recalcLockfile()` 投影的是所有项目级 target，
  //    不是只有我们这次动过的那几个 —— 只预热自己那份，别人那份照样会在收尾时炸。
  const pairs = new Map();
  for (const n of needs) pairs.set(`${n.artifact}\u0000${n.snapshot}`, n);
  const tplan = planTargets({
    clients: ctx.clients, scope: 'project', home: ctx.home, env: ctx.env, projectRoot: ctx.projectRoot,
  });
  assertPlanOk(tplan);
  for (const t of tplan.selected) {
    const P = layout(t.target);
    if (!existsSync(P.ledger)) continue;
    // 🔴 **本次不会去恢复的那些 target，未完成事务也要现在就查**
    //    （Codex 2026-09-04 复评 P1-1）。`recalcLockfile()` 对它们会调
    //    `assertNoUnrecoveredTx()`；而那发生在收尾钩子里 —— 那时**我们自己**这个
    //    target 已经提交、journal 已经清掉，lockfile 却停在旧版本。
    //    ⚠️ 只查「不是我们要处理的」那些：我们自己的 target 上，
    //    `cleanup_pending` 这类残留会被入口的 `recover(auto)` 正常续做完，
    //    在这里查会把一次完全正常的运行拒掉。
    if (!ours.includes(t.target)) assertNoUnrecoveredTx(t.target);
    const other = readLedger(P.ledger);
    // 🔴 **别的项目 target 的账本也要过闭合门**（Codex 2026-09-04 P1-2）：
    //    `recalcLockfile()` 投影的是**全部**项目级 target。别人那份有一条悬挂
    //    `requested_by` 时，本次事务会照常提交、journal 照常清掉，然后收尾的
    //    钩子才失败 —— lockfile 停在旧版本且没有 journal 可重试。
    //    ⚠️ **诚实边界**：这仍不是完整的 dry-run（没有真的构造一次 post-state
    //    的 `projectLockfile()`），只覆盖「图不闭合」与「历史快照取不到」两格。
    assertLedgerGraphUsable(other, `${t.target}/.geoly/ledger.json`);
    for (const e of Object.values(other.entries ?? {})) {
      pairs.set(`${e.artifact}\u0000${e.snapshot}`, { artifact: e.artifact, snapshot: e.snapshot });
    }
  }

  // ② 逐条证明「那张快照取得回来、验得过签、里面确实有这个 record」。
  //    🔴 **不 try/catch 吞掉**：取不到就是现在失败，而不是提交之后失败。
  const missing = [];
  for (const { artifact, snapshot } of pairs.values()) {
    if (current?.artifacts.some((r) => r.id === artifact)) continue;
    let snap;
    try { snap = readHistorical(snapshot); } catch (e) {
      // 🔴 **只有「取不到」（退出码 6）才算 missing**（Codex 2026-09-04 P1-3）。
      //    一律 catch 成 `NetworkError` 会把**验签失败 / 摘要不符 / 快照解析失败**
      //    从 2（完整性）降成 6（网络）—— 那正是 `snapshot-access.isDegradable`
      //    那条注释在防的事：把三类不同的失败吞成同一句「网络不好」。
      if (!isDegradable(e)) throw e;
      missing.push(`${artifact}（快照 ${snapshot} 取不回来：${e.message.split('\n')[0]}）`);
      continue;
    }
    if (!snap.artifacts.some((r) => r.id === artifact)) {
      missing.push(`${artifact}（快照 ${snapshot} 里没有这条 record）`);
    }
  }
  if (missing.length) {
    throw new NetworkError(
      '项目级 lockfile 重算需要每个 entry 的 asset_sha256（账本里没有这个字段，只能回历史快照取），'
      + '下面这些取不到：\n' + missing.map((m) => `  ${m}`).join('\n') + '\n'
      + '  🔴 现在拒绝，是为了不在**事务已经提交之后**才发现 —— 那时 lockfile 会停在旧版本，'
      + '而 recover 已经没有 journal 可重试。\n'
      + `  出路：联网跑一次（去掉 --offline）把快照热进缓存，或先 \`skills-hub sync-lock\`。`,
      { telemetryReason: 'not-found' },
    );
  }
  out?.note?.(`项目级 lockfile：已预热 ${pairs.size} 条 entry 需要的历史快照`);

  // ③ 钩子与预热**共用同一份 memo**：收尾那一刻不再有任何新的 I/O 决策。
  return function onLedgerChanged(inFlightTarget = null) {
    recalcLockfile(ctx, { current, inFlightTarget, readHistorical });
  };
}
