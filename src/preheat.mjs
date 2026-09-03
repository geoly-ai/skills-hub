// preheat —— 把「取字节」这件事**整个挪到 resolveCurrent() 之前**。
//
// 为什么必须是这个形状：`snapshot.resolveCurrent()` 是**同步**函数，它要求
// `fetchTimestamp()` / `fetchSnapshot(n)` 同步返回。内建 fetch 返回 Promise，
// 接不进去；把内核改成 async 是内核 API 变更。于是：
//
//   preheat（async，出网，只往 staging 写）
//     → resolveCurrent（同步，原样未改，只读缓存/staging）
//     → 提升（持 metadata 锁，原子 rename）
//
// 🔴 **缓存里只放验过的字节。** timestamp.json 与 snapshots/<N> **不是内容寻址**
//    （文件名不含摘要），未验证就写进去的话，攻击者投毒一次就能让之后每一次
//    `--offline` 都验签失败 —— 那是**持久 DoS**，而且看起来像「我们的签名坏了」。
//    staging 让这件事在构造上不可能。
//
// ⚠️ **可证明的承诺只有这两条**（Codex 2026-09-03 纠正了我原来的说法）：
//    · 提升**之前**失败：旧的可达缓存不变。
//    · 提升**过程中**失败：只可能留下**已验证、且不被新 timestamp 引用**的孤儿文件；
//      **不会留下坏指针**。
//    我原本写的是「任何失败 cache 一个字节都没被碰过」—— 那是**假的**：
//    提升是多次 rename，第一次成、第二次挂，缓存就已经变了。多文件 rename
//    不是事务，说它是事务只会让后来的人依赖一个不存在的保证。

import { existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { download } from './download.mjs';
import { unwrapTimestamp } from './timestamp-envelope.mjs';
import { acquire } from './lock.mjs';
import { NetworkError } from './exit-codes.mjs';
import {
  IntegrityError, METADATA_LOCK, assertFloorUnchanged, resolveStateDir, sha256Of,
} from './trust.mjs';
import { fsyncDir, fsyncParentAfter, mkdirChainFsync, writeAtomic } from './atomic-fs.mjs';

/** 内建 host。🔴 只能来自这里 —— 不接受 timestamp/snapshot/用户输入里的地址。 */
export const REGISTRY_HOST = 'github.com';
export const REGISTRY_BASE = `https://${REGISTRY_HOST}/geoly-ai/skills-hub`;

/** 单份 JSON 的上限，与 11-wire-contract.md §2 一致。 */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

/**
 * 一次 preheat 的总量闸。
 *
 * 🔴 单文件上限拦不住「很多个小文件」：`install --all` 的记录集来自快照，
 *    而快照是验过签的 —— 但**先下载后验签**的顺序意味着，在验签之前
 *    我们已经按它说的条数发了那么多请求。总量闸是这一段的兜底。
 */
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_REQUESTS = 512;

/** 整个 preheat 的总 deadline（单次下载另有自己的超时）。 */
export const MAX_TOTAL_MS = 10 * 60 * 1000;

// ── locator（02-registry.md §4.0）────────────────────────────────────────────
//
// 🔴 推导链上不出现任何未验签的输入：`<N>` 来自**已验签**的 timestamp，
//    `<file>` 由**已验签**快照里那条记录的字段重算，`<host>` 是内建常量。

export const timestampUrl = () => `${REGISTRY_BASE}/releases/download/timestamp/timestamp.json`;
export const snapshotUrl = (n) => `${REGISTRY_BASE}/releases/download/hub-v${n}/hub-${n}.json`;
export const snapshotBundleUrl = (n) => `${REGISTRY_BASE}/releases/download/hub-v${n}/hub-${n}.json.sigstore.json`;
export const assetUrl = (n, file) => `${REGISTRY_BASE}/releases/download/hub-v${n}/${file}`;

/**
 * 快照号必须是**非负安全整数**，且原样可往回写成同一个字符串。
 *
 * 🔴 拒绝浮点、指数、前导零、负数、超过 2^53-1。
 *    理由不是「不好看」：这个值要拼进 URL，也要拼进本地文件名。
 *    `Number('1e3')` 是 1000、`Number('007')` 是 7 —— 两个不同的字符串
 *    映到同一个 N，等于给缓存投毒开了一扇门（同一个文件名两种来源）。
 */
export function assertSnapshotNumber(v, where = 'latest_snapshot') {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new IntegrityError('E_SNAPSHOT_N', `${where} 必须是非负安全整数，得到 ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * 资产文件名的安全校验 —— **不是黑名单，是重算后逐字节比**。
 *
 * 🔴 黑名单（拒 `/` `\` `..` query fragment 百分号编码…）永远漏得掉一种写法。
 *    而发布端的命名是**确定性**的（`scripts/build-snapshot.mjs` 的
 *    `assetFileName()`：`<kind>_<ns>_<name>_<version>.tar.gz`），
 *    所以客户端可以用记录**自己的字段**重算一遍再比 —— 对不上就拒。
 *    这样「什么字符算安全」这个问题根本不需要回答。
 *
 * ⚠️ 这也堵住了一类更隐蔽的：`asset.file` 指向**另一条记录**的资产。
 *    黑名单查不出这种（它完全是个合法文件名）。
 */
export function assertAssetFile(rec) {
  const expect = `${rec.kind}_${rec.namespace}_${rec.name}_${rec.version}.tar.gz`;
  if (rec.asset?.file !== expect) {
    throw new IntegrityError(
      'E_ASSET_FILE',
      `记录 ${rec.id} 的 asset.file 是 ${JSON.stringify(rec.asset?.file)}，`
      + `但按它自己的字段应为 ${JSON.stringify(expect)}`,
    );
  }
  return expect;
}

// ── staging ────────────────────────────────────────────────────────────────

function makeStaging(cacheDir) {
  // 🔴 必须在 cacheDir **内部**：跨设备的 rename 不是原子的，
  //    而 /tmp 与用户 home 经常不在一个设备上。
  const dir = join(cacheDir, '.staging', randomBytes(8).toString('hex'));
  mkdirChainFsync(dir);
  mkdirChainFsync(join(dir, 'snapshots'));
  return dir;
}

/**
 * 落一个文件到 staging。
 *
 * 🔴 走 `writeAtomic` 而不是裸 `writeFileSync` —— 后者**不 fsync 文件本身**，
 *    断电后可能留下一个「存在但内容是零」的文件。对内容寻址的资产尤其要命：
 *    文件名是摘要，看起来就像验过了（Codex 2026-09-03 P1）。
 *    `writeAtomic` 还接着项目的掉电影子模型，绕过它等于这条路径不受故障注入覆盖。
 *
 * 这里仍然**一个校验都不做** —— 只保证「字节确实持久到盘上了」。
 */
function stage(dir, rel, bytes) {
  const p = join(dir, rel);
  writeAtomic(p, bytes);
  return p;
}

/**
 * 提升一个文件。
 *
 * 🔴 **滚动的东西不能用 no-replace。**
 *    `timestamp.json` 每次都是新的：no-replace 会让第二次 preheat 必然
 *    抛 E_CACHE_CONFLICT，而 floor 此前**已经推进** —— 缓存就永久卡在
 *    旧 timestamp，之后每一次 install 都失败。
 *    ⚠️ 这个 bug 我自己没看出来，是 Codex 2026-09-03 指出的；
 *    更糟的是我那条「幂等」测试只覆盖了**同内容**的情形，
 *    等于把错的契约钉死了 —— 断言了错误的契约，所以永远绿。
 *
 *    判据：**内容寻址或不可变的用 no-replace，滚动的用替换。**
 *    · snapshots/<N>.json / .sigstore.json —— N 定了内容就定了，不可变
 *    · assets/<hex>                        —— 名字就是摘要，不可变
 *    · timestamp.json                      —— 滚动
 */
function promote(from, to, { what, rolling = false }) {
  const srcDir = dirname(from);
  if (rolling) {
    renameSync(from, to);
    fsyncParentAfter(to);
    fsyncDir(srcDir);
    return true;
  }
  // 🔴 no-replace 用 `link()` 的 EEXIST，**不是** `existsSync()` + `rename()`。
  //    后者中间有一条缝：查的时候不在，rename 的时候已经被别人放进去了 ——
  //    于是我们悄悄覆盖了别人刚写好的字节（TOCTOU，Codex 指出）。
  //    `link` 在内核里是原子的：要么建成，要么 EEXIST。
  try {
    linkSync(from, to);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const a = readFileSync(to);
    const b = readFileSync(from);
    if (!a.equals(b)) {
      throw new IntegrityError(
        'E_CACHE_CONFLICT',
        `${what} 在缓存里已存在，且内容与刚下载的不一致 —— 拒绝覆盖。`
        + `\n  这两份字节都自称是同一个名字，其中至少一份是错的。`,
      );
    }
    unlinkSync(from);
    return false;
  }
  fsyncParentAfter(to);
  unlinkSync(from);
  fsyncDir(srcDir);
  return true;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

/**
 * 取回 metadata（timestamp + 当前快照），放进 staging。
 *
 * 返回 `{ stagingDir, n }`。**一次校验都不做** —— 调用方拿它喂给
 * `resolveCurrent()`，由后者验签、验新鲜度、推进 floor。
 *
 * 🔴 第 2 步的「未验签窥探 N」只决定**下载哪个文件**。若 N 是伪造的，
 *    第 3 方（resolveCurrent）验不过，staging 整个丢掉，缓存没被碰过。
 */
export async function preheatMetadata({
  cacheDir, fetchImpl, timeoutMs, budget = newBudget(),
}) {
  const stagingDir = makeStaging(cacheDir);
  try {
    const tsBytes = await spend(budget, (left) => download(timestampUrl(), {
      host: REGISTRY_HOST, cap: MAX_JSON_BYTES, fetchImpl,
      timeoutMs: Math.min(timeoutMs ?? Infinity, left), what: 'timestamp.json',
    }));
    stage(stagingDir, 'timestamp.json', tsBytes);

    // 🔴 窥探：**只**为了知道下载哪个 N。用严格解析 + 严格整数校验，
    //    且**只把数值** N 拼进 URL，不把原始 JSON 字符串拼进去。
    const n = peekLatestSnapshot(tsBytes);

    const [snapBytes, bundleBytes] = [
      await spend(budget, (left) => download(snapshotUrl(n), {
        host: REGISTRY_HOST, cap: MAX_JSON_BYTES, fetchImpl,
        timeoutMs: Math.min(timeoutMs ?? Infinity, left), what: `快照 ${n}`,
      })),
      await spend(budget, (left) => download(snapshotBundleUrl(n), {
        host: REGISTRY_HOST, cap: MAX_JSON_BYTES, fetchImpl,
        timeoutMs: Math.min(timeoutMs ?? Infinity, left), what: `快照 ${n} 的 bundle`,
      })),
    ];
    stage(stagingDir, join('snapshots', `${n}.json`), snapBytes);
    stage(stagingDir, join('snapshots', `${n}.sigstore.json`), bundleBytes);
    return { stagingDir, n };
  } catch (e) {
    discard(stagingDir);
    throw e;
  }
}

/**
 * 从**未验签**的 timestamp 字节里取出 latest_snapshot。
 *
 * ⚠️ 名字里的 `peek` 是认真的：这一步的输出**只能**用来决定下载哪个文件。
 *    任何拿它做判断（「比本地新就…」）的用法都是在信未验签的数据。
 */
export function peekLatestSnapshot(tsBytes) {
  // 🔴 用**同一个** `unwrapTimestamp()` 拆信封，不另写一个解析器。
  //    我第一版自己写了一份（判断 payload 是字符串就 base64 解）——
  //    虽然结论碰巧一样，但**两个解析器对同一份字节给出不同答案**本身就是一类洞：
  //    窥探这一步认了 A，验签那一步认了 B，中间就有一条缝。
  //    `unwrapTimestamp` 明说它只做形状检查、不做信任判断，正是这里该用的。
  let inner;
  try {
    inner = JSON.parse(unwrapTimestamp(tsBytes).bytes.toString('utf8'));
  } catch (e) {
    // 取到一页 HTML（登录墙、错误页、404 页）是**网络/端点**问题。
    // 报成完整性问题会让人去查签名 —— 方向全错。
    throw new NetworkError(
      `timestamp.json 解析不了，取到的字节不像 registry 的响应：${e.message}`,
    );
  }
  return assertSnapshotNumber(inner?.latest_snapshot);
}

/**
 * 下载并校验一批资产，落进 `assets/<sha256hex>`。
 *
 * 🔴 `records` **必须来自已验签的快照**，不能是调用方随手拼的对象 ——
 *    否则 `asset.sha256` / `size` / `file` 全是攻击者说了算，
 *    「校验通过」就只是在和自己对暗号。
 *
 * ⚠️ 这里**允许留下孤儿**：单个资产验过就落盘（按摘要命名）。
 *    整套矩阵下到一半断网时，已经下好的那些下次直接命中 ——
 *    「全部下完再统一提升」会让每次断网都从头再来。
 *    孤儿是安全的：文件名就是摘要，读回来还要再验一次。
 */
export async function preheatAssets({
  cacheDir, n, records, fetchImpl, timeoutMs, budget = newBudget(),
}) {
  // 🔴 每个把 n 拼进路径或 URL 的入口都要自己校验一次。
  //    只在 peekLatestSnapshot 里校验是不够的 —— 调用方可以直接调这个函数，
  //    而一个字符串 n（比如 "../x"）会把路径带出 snapshots/。
  assertSnapshotNumber(n, 'preheatAssets 的 n');
  const assetsDir = join(cacheDir, 'assets');
  mkdirChainFsync(assetsDir);
  const staging = makeStaging(cacheDir);
  const got = [];
  try {
    for (const rec of records) {
      // 🔴 **校验在缓存命中之前。** 我原本把 assertAssetFile 放在 existsSync 之后 ——
      //    于是「已经有同摘要文件」时，一条 asset.file 写错的记录会被**静默放行**
      //    （Codex 2026-09-03）。闸放在快路径后面 = 快路径上没有闸。
      assertAssetFile(rec);
      const hex = String(rec.asset.sha256).replace(/^sha256:/, '');
      const dest = join(assetsDir, hex);
      // 🔴 去重**就是**这一句缓存命中，不需要另设一个 seen 集合。
      //    我原本两样都写了，变异测试当场指出「去掉 seen 没有任何测试变红」——
      //    因为第一条记录落盘之后，第二条本来就会命中这里。
      //    而且 seen 那版更差：它 `continue` 时不往 got 里推，报告会少一条记录。
      if (existsSync(dest)) {
        // 🔴 缓存命中**不等于**那份字节还是对的。名字是摘要，所以一个
        //    崩溃留下的截断文件**看起来就像验过了**（Codex 2026-09-03）。
        //    这里只查大小 —— 完整的摘要复验在 `artifact.assertAssetBytes()`
        //    里每次安装都会做，在这儿再算一遍大资产的 sha256 是白花钱。
        //    大小对不上就删掉重下，而不是报错：**这是我们自己的缓存坏了，
        //    不是分发被投毒** —— 让用户去查签名是把人引向错误的方向。
        if (statSync(dest).size === rec.asset.size) {
          got.push({ id: rec.id, cached: true });
          continue;
        }
        unlinkSync(dest);
      }

      const file = rec.asset.file;
      // 资产上限按**这一条记录自己声明的 size**，不是一个固定的 8 MiB ——
      // 固定值会拒掉规格允许的合法资产（Codex 指出）。
      const bytes = await spend(budget, (left) => download(assetUrl(n, file), {
        host: REGISTRY_HOST, cap: rec.asset.size, fetchImpl,
        timeoutMs: Math.min(timeoutMs ?? Infinity, left),
        what: `资产 ${rec.id}（${file}）`,
      }), rec.asset.size);

      // ⚠️ 字节数不同 → 摘要必然不同，所以这一条**抓不到摘要抓不到的东西**。
      //    留着是为了**错误信息**：说「少了 3 个字节」比说「摘要对不上」
      //    更快指向真正的原因（截断的下载 / 代理插了一段）。
      //    顺序必须在摘要之前，否则这条永远轮不到。
      if (bytes.length !== rec.asset.size) {
        throw new IntegrityError('E_ASSET_SIZE',
          `资产 ${rec.id} 下回来是 ${bytes.length} 字节，快照说应为 ${rec.asset.size}`);
      }
      const actual = sha256Of(bytes);
      if (actual !== `sha256:${hex}`) {
        throw new IntegrityError('E_ASSET_DIGEST',
          `资产 ${rec.id} 的摘要是 ${actual}，快照说应为 sha256:${hex}`);
      }
      const tmp = stage(staging, hex, bytes);
      promote(tmp, dest, { what: `资产 ${rec.id}` });
      got.push({ id: rec.id, cached: false });
    }
    return got;
  } finally {
    discard(staging);
  }
}

/**
 * 把 staging 里的 metadata 提升进缓存。
 *
 * 🔴 必须在**自己持有 metadata 锁**的临界区内做，并在同一段临界区里
 *    重读 floor 比对（`assertFloorUnchanged` 的文档明说它自己不是屏障）。
 *
 *    不这么做会出这个竞态（Codex 2026-09-03）：
 *      ① preheat A 验过 v2、推进 floor 到 v2
 *      ② preheat B 推进到 v3 并落盘
 *      ③ A 这时才把自己的 v2 提升进 cache
 *    结果 `cache/timestamp.json = v2` 而 floor 已是 v3 ——
 *    **之后每一次 install 都必然失败**，且看不出为什么。
 *
 * 🔴 提升顺序：snapshots/<N>.json → .sigstore.json → timestamp.json **最后**。
 *    断电时最多留下「没人引用的孤儿快照」，而不是「timestamp 指向一个
 *    不存在的 N」—— 后者会让客户端每次都取不到那份快照，
 *    而它手上的 timestamp 是验过签的，于是像是分发被投毒了。
 */
export function promoteMetadata({ cacheDir, stateDir, stagingDir, n, expectedFloor }) {
  assertSnapshotNumber(n, 'promoteMetadata 的 n');
  const dir = resolveStateDir(stateDir);
  const release = acquire(join(dir, METADATA_LOCK), { cli: 'skills-hub preheat' });
  try {
    assertFloorUnchanged(dir, expectedFloor);
    mkdirChainFsync(join(cacheDir, 'snapshots'));
    promote(join(stagingDir, 'snapshots', `${n}.json`),
      join(cacheDir, 'snapshots', `${n}.json`), { what: `快照 ${n}` });
    promote(join(stagingDir, 'snapshots', `${n}.sigstore.json`),
      join(cacheDir, 'snapshots', `${n}.sigstore.json`), { what: `快照 ${n} 的 bundle` });
    // 🔴 最后这一个。它是**指针**，指向的东西必须先就位。
    //    而且它是**滚动**的 —— 用替换语义，不是 no-replace（见 promote 顶部）。
    promote(join(stagingDir, 'timestamp.json'),
      join(cacheDir, 'timestamp.json'), { what: 'timestamp.json', rolling: true });
  } finally {
    release();
    discard(stagingDir);
  }
}

// ── 预算 ───────────────────────────────────────────────────────────────────

export function newBudget({
  maxBytes = MAX_TOTAL_BYTES, maxRequests = MAX_REQUESTS, maxMs = MAX_TOTAL_MS, now = Date.now,
} = {}) {
  return { bytes: 0, requests: 0, maxBytes, maxRequests, maxMs, deadline: now() + maxMs, now };
}

/**
 * 跑一次下载并记账。
 *
 * 🔴 **字节要事前预留，不能事后记账**（Codex 2026-09-03 指出）。
 *    事后检查的话，最后一个资产可以任意大 —— 它已经下完了才发现超限，
 *    内存和磁盘早就被吃掉了。总量闸的意义正在于「不让它下下来」。
 *    资产的 size 在快照里写着，所以预留是做得到的。
 *
 * 🔴 单次超时也要取**剩余**总时限。否则最后一个请求可以整整越过总 deadline
 *    再跑满自己的 30 秒。
 *
 * @param {number} [reserve] 这次预计的字节数（已知时传，如资产的 asset.size）
 */
async function spend(b, fn, reserve = 0) {
  if (b.requests >= b.maxRequests) {
    throw new NetworkError(`本次 preheat 的请求数超过上限 ${b.maxRequests}`);
  }
  const left = b.deadline - b.now();
  if (left <= 0) throw new NetworkError(`本次 preheat 超过总时限 ${b.maxMs} ms`);
  if (b.bytes + reserve > b.maxBytes) {
    throw new NetworkError(
      `本次 preheat 的总字节数会超过上限 ${b.maxBytes}（已用 ${b.bytes}，这一份还要 ${reserve}）`,
    );
  }
  b.requests += 1;
  const out = await fn(left);
  b.bytes += out.length;
  // 事前预留之后这一条只可能在 reserve=0（未知大小）的路径上触发
  if (b.bytes > b.maxBytes) {
    throw new NetworkError(`本次 preheat 的总字节数超过上限 ${b.maxBytes}`);
  }
  return out;
}

export function discard(stagingDir) {
  try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}
