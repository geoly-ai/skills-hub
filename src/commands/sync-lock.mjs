// `sync-lock` —— 在 repo 锁下**幂等重算**并原子写 `geoly-skills.lock.json`（04-install.md §8.1）。
//
// 🔴 也是 `install` / `recover` 收尾时那个 `onLedgerChanged` 钩子的实现：
//    §5.1 末尾要求 install / update / remove / **recover** 成功之后都要在 repo 锁下重算。
//    钩子被调用时 repo 锁**已经由命令层持着** —— 所以本模块**不自己取 repo 锁**
//    （`src/lock.mjs` 禁止重入，取第二次会当场抛）。取锁是调用方的事。
//
// 🔴 「任一项目级 target 处于未恢复事务中 → **拒绝重算**并要求先 recover」（§8.1）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { planTargets, assertPlanOk } from '../adapters/index.mjs';
import { layout, readLedger } from '../ledger.mjs';
import { listJournalGenerations, readJournal } from '../journal.mjs';
import { projectLockfile, writeLockfile } from '../lockfile.mjs';
import { REPO } from '../trust.mjs';
import { withOrderedLocks } from './locks.mjs';
import { getVerifier, historicalReader, resolveSnapshotForCommand } from './snapshot-access.mjs';
import { UsageError, EXIT, NetworkError } from '../exit-codes.mjs';
import { annotations } from './output.mjs';

export const LOCKFILE_NAME = 'geoly-skills.lock.json';

/** §8.1：有未恢复事务就拒绝重算。 */
export function assertNoUnrecoveredTx(target) {
  const P = layout(target);
  if (!existsSync(P.state)) return;
  if (existsSync(P.repairIntent)) {
    throw new UsageError(
      `${target} 存在未完成的 repair intent：请先跑 \`skills-hub recover --reinstall\`，再重算 lockfile。`,
      { exitCode: EXIT.NEEDS_RECOVER },
    );
  }
  for (const g of listJournalGenerations(P.journalDir)) {
    const J = readJournal(layout(target, g).journal);
    if (J.phase !== 'completed') {
      const e = new UsageError(
        `${target} 的第 ${g} 代事务停在 ${J.phase}：lockfile **拒绝重算**（04-install.md §8.1）。\n`
        + '  请先 `skills-hub recover --continue` 或 `--rollback`。',
      );
      e.exitCode = EXIT.NEEDS_RECOVER;
      throw e;
    }
  }
}

/**
 * 从**已验签的**快照里取 entry 的 `asset_sha256`。
 *
 * 🔴 账本里没有这个字段（它是本机运行历史之外的东西），只能回快照取。
 *    取不到就**失败**，绝不填一个占位值 —— lockfile 是别的机器的权威输入。
 */
function assetSha256For(artifactId, entrySnapshot, { current, readHistorical }) {
  const fromCurrent = current?.artifacts.find((r) => r.id === artifactId);
  if (fromCurrent) return fromCurrent.asset.sha256;
  const snap = readHistorical(entrySnapshot);
  const rec = snap.artifacts.find((r) => r.id === artifactId);
  if (!rec) {
    throw new NetworkError(
      `快照 ${entrySnapshot} 里找不到 ${artifactId}，无法取它的 asset_sha256 —— lockfile 拒绝重算。`,
      { telemetryReason: 'not-found' },
    );
  }
  return rec.asset.sha256;
}

/**
 * 重算（不取锁）。返回 `{ path, lockfile, targets }`；没有任何项目级 target 时返回 `null`。
 *
 * @param {object} o.current        当前快照（可为 null；那时逐个回历史快照取）
 * @param {(n:number)=>object} o.readHistorical
 */
export function recalcLockfile(ctx, { current = null, readHistorical, inFlightTarget = null }) {
  if (ctx.scope !== 'project') return null;
  const tplan = planTargets({
    clients: ctx.clients,
    scope: 'project',
    home: ctx.home,
    env: ctx.env,
    projectRoot: ctx.projectRoot,
  });
  assertPlanOk(tplan);

  const targets = [];
  for (const t of tplan.selected) {
    const P = layout(t.target);
    if (!existsSync(P.ledger)) continue;
    // 🔴 口子只对**正在收尾的那一个 target** 开，不是对整次重算开。
    //    §8.1 那条「有未恢复事务就拒绝重算」防的是**旁观者**拿中间态去投影；
    //    而钩子是由事务本身在账本已经写定之后调的（rollback 的 `finalizeRollback()`
    //    第 ③ 步就在第 ⑤ 步把 phase 置成 completed 之前）——
    //    它对**自己**的 journal 有权威，对**别的** target 没有。
    //    早先这里是一个整次生效的 `allowInFlight`，多 target recover 时会把
    //    另一个 target 的中间态一起投影进 lockfile（Codex 第三轮 P0-2）。
    if (t.target !== inFlightTarget) assertNoUnrecoveredTx(t.target);
    const L = readLedger(P.ledger);
    if (Object.keys(L.entries).length === 0 && Object.keys(L.roots).length === 0) continue;
    const assetSha256 = {};
    for (const [name, e] of Object.entries(L.entries)) {
      assetSha256[name] = assetSha256For(e.artifact, e.snapshot, { current, readHistorical });
    }
    targets.push({
      client: t.client,
      scope: 'project',
      // 🔴 `path` **只能由 adapter 推导**（§8.1 的闭合验证要求），仓库内相对路径
      path: `${t.adapter.dirName}/skills`,
      ledger: L,
      assetSha256,
    });
  }
  const lf = projectLockfile({ registry: REPO, targets });
  const path = join(ctx.projectRoot, LOCKFILE_NAME);
  writeLockfile(path, lf);
  return { path, lockfile: lf, targets: targets.map((t) => t.path) };
}

/**
 * 造 `onLedgerChanged` 钩子。
 *
 * 🔴 **入口就查**：`install.assertLockfileHook()` 在 `runTransaction` 的**第一行**
 *    就要求项目级 target 必须注入它 —— 缺了要在「放弃还免费」的时候报，
 *    而不是等事务提交完、journal 都删了才炸。
 *
 * ⚠️ **已知非原子路径（R-11 第四条）**：`runCleanup()` 先清 tx 与 journal，
 *    **最后**才调本钩子。钩子抛错时 ledger 已提交、project lockfile 可能陈旧，
 *    而 recover 已经没有 journal 可重试。兜底是：`check` 会报「lockfile 过时」，
 *    用户跑 `sync-lock` 补。**这是已知缺口，不是被闭合了。**
 */
export function makeLockfileHook(ctx, { snap = null, verifier = null } = {}) {
  if (ctx.scope !== 'project') return undefined;
  // 🔴 `runLockfileRecalc(target, P, opts)` 会把**当前 target** 传进来 ——
  //    口子就窄化在这个参数上。
  return function onLedgerChanged(inFlightTarget = null) {
    // 🔴 历史快照读取器**每次现造**：memo 缓在钩子外面会让一次长跑里的
    //    「快照被换掉」看不见。它只省重复解析，不省任何一次验签。
    const readHistorical = verifier === null
      ? (n) => {
        throw new NetworkError(
          `重算 lockfile 需要快照 ${n} 里的 asset_sha256，但本次运行没有可用的验签器。`
          + '请跑 `skills-hub sync-lock` 补齐。',
          { telemetryReason: 'not-found' },
        );
      }
      : historicalReader(ctx, verifier);
    recalcLockfile(ctx, { current: snap, inFlightTarget, readHistorical });
  };
}

export async function cmdSyncLock(ctx, argv, out) {
  for (const a of argv) throw new UsageError(`sync-lock 不认得参数 ${a}`);
  if (ctx.scope !== 'project') {
    throw new UsageError('sync-lock 只对项目级安装有意义：请加 `--project [path]`（04-install.md §8）。');
  }
  const verifier = await getVerifier(ctx);
  const readHistorical = historicalReader(ctx, verifier);
  // 当前快照能拿到就拿（省去逐条回历史快照）；拿不到不是错 —— 历史路径仍然可用
  let current = null;
  try { current = (await resolveSnapshotForCommand(ctx)).snapshot; } catch { current = null; }

  let result = null;
  withOrderedLocks({ projectRoot: ctx.projectRoot, targets: [] }, () => {
    result = recalcLockfile(ctx, { current, readHistorical });
  });

  // 🔴 埋点在**收尾处**，不在事务关键路径上；`record()` 自己不抛。
  //    `kind` 取 KINDS 里现成的 `sync-lock`。
  if (ctx.record) ctx.record({ kind: 'sync-lock', result: 'ok', scope: 'project' });

  if (result === null) {
    out.line('没有可投影的项目级 target（没有账本）。');
    return out.emit('sync-lock', { lockfile: null, targets: [] }, EXIT.OK);
  }
  out.line(`已重算 ${result.path}`);
  for (const t of result.lockfile.targets) {
    out.line(`  ${t.client}/${t.scope}  ${t.path}  roots=${t.roots.length}  entries=${t.entries.length}`);
  }
  return out.emit('sync-lock', {
    lockfile: result.path,
    targets: result.lockfile.targets.map((t) => ({
      // 🔴 标注挂在每一个 target 对象上（§7）
      annotations: annotations({ offline: ctx.offline }),
      client: t.client,
      entries: t.entries.length,
      path: t.path,
      roots: t.roots.length,
      scope: t.scope,
    })),
  }, EXIT.OK);
}
