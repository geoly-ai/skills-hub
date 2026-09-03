// preheat 的**编排** —— 把「出网取字节」与「同步验签」缝在一起。
//
// 🔴 顺序是这个模块存在的全部理由：
//
//   ① preheatMetadata   出网，只往 staging 写         （async）
//   ② resolveCurrent    验签/新鲜度/floor，读 staging  （**同步、原样未改**）
//   ③ promoteMetadata   持 metadata 锁，原子提升        （同步）
//
// ②**不能**接受 Promise —— 内核就是同步的，这也是 preheat 必须存在的原因。
// 所以 ① 与 ③ 之间那一段里，「已下载但还没验」的字节**只在 staging**。
//
// ⚠️ ② 内部会取 metadata 锁（`advanceTrustFloor` 自己 acquire/release），
//    而 ③ 也要取同一把。`src/lock.mjs` **禁止重入**，所以 ③ 必须在 ② **返回之后**
//    调用，不能把 ② 包进 ③ 的临界区里。

import { existsSync } from 'node:fs';
import { resolveCurrent } from '../snapshot.mjs';
import { readTrustFloor, resolveStateDir } from '../trust.mjs';
import { mkdirChainFsync } from '../atomic-fs.mjs';
import { preheatAssets, preheatMetadata, promoteMetadata, discard, newBudget } from '../preheat.mjs';
import { createCacheRegistry } from './registry.mjs';
import { getVerifier } from './snapshot-access.mjs';

/**
 * 联网刷新一次 metadata（timestamp + 当前快照）到本地缓存。
 *
 * @returns {{refreshed:boolean, n:number|null, reason:string}}
 */
export async function preheatOnce({
  cacheDir, stateDir, verifier, cliVersion, now, fetchImpl, timeoutMs,
  budget = newBudget(),
}) {
  // 🔴 preheat 现在是**第一个**碰这两个目录的人。
  //    在它之前，建目录那一步藏在 `resolveSnapshotForCommand()` 里面 ——
  //    而 preheat 排在它前面，于是干净 home 上第一次安装直接 ENOENT。
  //    2026-09-03 端到端撞到：`lstat '<home>/.local'`。
  //    ⚠️ 顺序要紧：`resolveStateDir()` 内部是 `realpathSync`，**要求目录已存在**。
  //    我第一版写成 `mkdirChainFsync(resolveStateDir(stateDir))` —— 先解析后创建，
  //    在干净 home 上必然 ENOENT，而且报的是 `lstat '<home>/.local'`，
  //    看起来完全不像「目录还没建」。
  mkdirChainFsync(cacheDir);
  mkdirChainFsync(stateDir);
  const { stagingDir, n } = await preheatMetadata({ cacheDir, fetchImpl, timeoutMs, budget });
  try {
    // 🔴 registry 指向 **staging**，不是 cache —— 验的必须是刚下回来的那份。
    //    指向 cache 的话，验的是上一轮的旧字节，而新字节从没被验过就被提升了。
    const staged = createCacheRegistry({ cacheDir: stagingDir, offline: false });
    resolveCurrent({
      stateDir,
      fetchTimestamp: staged.fetchTimestamp,
      fetchSnapshot: staged.fetchSnapshot,
      verifier, cliVersion, now,
      offline: false,
    });
    // 到这里 floor 已经被 ② 推进过了；③ 在锁内重读并比对它。
    const floor = readTrustFloor(resolveStateDir(stateDir));
    promoteMetadata({ cacheDir, stateDir, stagingDir, n, expectedFloor: floor });
    return { refreshed: true, n, reason: 'ok' };
  } catch (e) {
    // 🔴 验不过就整个丢掉 staging —— 缓存里那份**旧的、验过的**原样保留。
    //    这正是「未验证字节不进缓存」那条的落点：攻击者投毒一次，
    //    也只是让这一次刷新失败，而不是把本地永久毒成验不过。
    discard(stagingDir);
    throw e;
  }
}

/**
 * install 之前的刷新。**失败要不要致命，取决于本地有没有可用的缓存。**
 *
 * 🔴 有缓存时网络失败**不该**中断安装：离线可用是这个 CLI 的核心属性之一。
 *    但**验签失败**永远致命 —— 那不是「网络不好」，那是有人在改字节。
 *    两者报的错必须分得开，否则「网络抖了一下」会被写进 issue 说成「你们被入侵了」，
 *    反过来更糟：真被投毒时被当成网络问题重试掉。
 */
export async function preheatForInstall(ctx, out) {
  if (ctx.offline) return { refreshed: false, reason: 'offline' };
  // 🔴 注入了自定义 registry 时不 preheat：那种情况下字节**根本不从缓存来**，
  //    下载只是在给一个没人会读的目录塞东西。
  //    ⚠️ 这不是「测试专用后门」—— 判据是「字节的来源是不是本地缓存」，
  //    生产入口 `bin/skills-hub.mjs` 一个 dep 都不传，永远走不到这条。
  if (ctx.registryFactory) return { refreshed: false, reason: 'custom-registry' };
  const haveCache = existsSync(`${ctx.cacheDir}/timestamp.json`);
  try {
    // 🔴 `ctx.verifier` 的缺省值是 **null**（不是 undefined）——
    //    直接传会得到 `E_VERIFIER_MISSING`。命令面统一走 `getVerifier()`，
    //    它在没注入时落到**真验签器**（内置信任根）。
    //    ⚠️ 与 fetchImpl 是**同一个形状**：注入点缺省为 null，而下游按
    //    「没给就用默认」写。一处栽了就该全仓找同形状的——这是第二处。
    const r = await preheatOnce({
      cacheDir: ctx.cacheDir, stateDir: ctx.stateDir,
      verifier: await getVerifier(ctx),
      cliVersion: ctx.cliVersion,
      // 🔴 `ctx.now` 是**函数**（`() => new Date()`），而 `resolveCurrent` 要的是
      //    **毫秒数**。直接传函数会一路走到 `makeFloor` 里 `new Date(fn).toISOString()`
      //    → `RangeError: Invalid time value`，报出来的话完全看不出是这儿。
      //    命令面原本就写着 `now: ctx.now().getTime()`（snapshot-access.mjs:54）——
      //    ⚠️ 这是我今天**第三次**把 ctx 字段原样传下去而没看形状
      //    （前两次：fetchImpl 与 verifier 的缺省是 null）。
      now: ctx.now().getTime(),
      fetchImpl: ctx.fetchImpl ?? undefined,
    });
    if (r.refreshed) out?.note?.(`已刷新到快照 ${r.n}`);
    return r;
  } catch (e) {
    // 完整性/验签问题一律上抛 —— 它们**不是**「网络不好」。
    if (e.name === 'IntegrityError' || e.name === 'WireError' || e.code?.startsWith?.('E_')) throw e;
    if (!haveCache) throw e;      // 没缓存又取不到 = 真的装不了
    out?.note?.(`联网刷新失败（${e.message}）—— 改用本地缓存继续`);
    return { refreshed: false, reason: 'network-failed-cache-used' };
  }
}

/**
 * 下载一批记录的资产。`--offline` 时直接跳过 —— 缓存未命中会在
 * `registry.fetchAsset()` 那里报「离线未命中」，那是**它**该报的错。
 *
 * 🔴 `records` 必须来自**已验签的快照**。调用方传进来的对象里
 *    `asset.sha256` / `size` / `file` 决定了下载什么、校验什么 ——
 *    如果它们不是从验过的快照里来的，「校验通过」就只是在和自己对暗号。
 */
export async function preheatAssetsFor(ctx, records, snap) {
  if (ctx.offline || ctx.registryFactory || records.length === 0) return;
  await preheatAssets({
    cacheDir: ctx.cacheDir,
    n: snap.snapshot,
    records,
    fetchImpl: ctx.fetchImpl ?? undefined,
  });
}
