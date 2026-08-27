// 快照取用 —— 02-registry.md §6（解析当前）与 §6.1（历史读取路径）在命令面的入口。
//
// 🔴 **这是两条不同的路径，不能混用**：
//   · `resolveCurrent()`：回答「现在最新的是哪张快照」，会**推进 trust floor**，
//     并且「N 小于本地 floor 即拒绝」。metadata 锁在 `advanceTrustFloor()` 内部起落 ——
//     🔴 命令面**不得**再包一层 metadata 锁（`src/lock.mjs` 禁止重入，会当场抛）。
//   · `readHistoricalSnapshot()`：**只读**。可用于 `--snapshot <N>` 复现、
//     `check` 的第一问、lockfile 闭包重解析。
//     ❌ 不得用它回答「现在还能不能用」—— 那必须查当前快照。

import { existsSync } from 'node:fs';
import { mkdirChainFsync } from '../atomic-fs.mjs';
import { resolveCurrent, readHistoricalSnapshot } from '../snapshot.mjs';
import { readTrustFloor } from '../trust.mjs';
import { realVerifier } from './context.mjs';
import { EXIT, classify } from '../exit-codes.mjs';

export async function getVerifier(ctx) {
  // 🔴 验签没有逃生口。`ctx.verifier` 只有 `main(argv, deps)` 的调用方给得了；
  //    生产入口一个 dep 都不传，因此这里落到真验签器（内置信任根）。
  return ctx.verifier ?? realVerifier();
}

/**
 * @returns {{snapshot:object, stale:boolean, floor:object|null, pinned:boolean, verifier:Function}}
 */
export async function resolveSnapshotForCommand(ctx) {
  const verifier = await getVerifier(ctx);

  if (ctx.snapshot !== null) {
    // `--snapshot <N>`：钉快照复现。走 §6.1 的**只读**路径，**不推进 floor**。
    const { bytes, bundle } = ctx.registry.fetchSnapshot(ctx.snapshot);
    const { snapshot } = readHistoricalSnapshot({
      bytes, bundle, verifier, expectSnapshot: ctx.snapshot,
    });
    // 🔴 R-9 的 floor 复验仍然要做：钉快照不代表可以放弃「安装期间 floor 没被推进」
    //    这条检查。取磁盘上当前的 floor 当期望值；还没 bootstrap 就显式 null
    //    （`assertFloorBarrier` 要求**显式**给出，忘了传是拒绝、不是跳过）。
    // 🔴 **这条路径只读，不建目录**：`--snapshot` / `check` 的第一问都走它，
    //    让一次只读查询顺手建出全局状态目录，与「历史读取路径只读」自相矛盾。
    let floor = null;
    if (existsSync(ctx.stateDir)) floor = readTrustFloor(ctx.stateDir);
    return { snapshot, stale: false, floor, pinned: true, verifier };
  }

  // 只有「解析当前」这条路径会**推进 floor**，也只有它需要状态目录存在
  mkdirChainFsync(ctx.stateDir);      // resolveStateDir 要 realpath 它
  const r = resolveCurrent({
    stateDir: ctx.stateDir,
    fetchTimestamp: () => ctx.registry.fetchTimestamp(),
    fetchSnapshot: (n) => ctx.registry.fetchSnapshot(n),
    verifier,
    cliVersion: ctx.cliVersion,
    now: ctx.now().getTime(),
    offline: ctx.offline,
    allowStale: ctx.allowStale,
  });
  return { snapshot: r.snapshot, stale: r.stale === true, floor: r.floor, pinned: false, verifier };
}

/**
 * 历史快照的 memo 读取器（`check` / `sync-lock` / lockfile 闭包共用）。
 * 🔴 每一份都**独立验签**（identity = release.yml）——命中缓存只省网络，不省校验。
 */
/**
 * 🔴 只读命令（`list` / `check`）在取不到当前快照时可以**降级并如实标注**，
 *    但**只有「取不到」这一种**可以降级。
 *
 * 早先 `list` / `check` 是 `try { … } catch { 标 offline 继续 }` ——
 * 那会把这三类一起吞掉，而它们各自在 §6 里有自己的格子：
 *   · `StaleError`（8）：timestamp 过期且未给 `--allow-stale`。吞掉它 = CI 拿着
 *     一张过期的信任根照常绿灯，正是 `--allow-stale` 存在的理由被绕过；
 *   · `IntegrityError` / `TarViolation`（2）：验签失败、摘要不符、抗回滚命中；
 *   · `MinCliVersionError`（11）。
 *
 * 判据是**退出码分类**，不是错误文案：只有落在 `NETWORK`（6）那一格的才可降级。
 */
export function isDegradable(err) {
  return classify(err).code === EXIT.NETWORK;
}

export function historicalReader(ctx, verifier) {
  const memo = new Map();
  return function read(n) {
    if (memo.has(n)) return memo.get(n);
    const { bytes, bundle } = ctx.registry.fetchSnapshot(n);
    const { snapshot } = readHistoricalSnapshot({ bytes, bundle, verifier, expectSnapshot: n });
    memo.set(n, snapshot);
    return snapshot;
  };
}
