// registry 读取层 —— 02-registry.md §6 的**取字节**那一半。
//
// 🔴 **本模块一个字节都不出网** —— 这是设计，不是缺口（0.3.0 起已有网络层）。
//
//   `snapshot.resolveCurrent()` 是**同步**函数，它要求 `fetchTimestamp()` /
//   `fetchSnapshot(N)` 同步返回 `{ bytes, bundle }`。内建 `fetch` 返回 Promise，
//   接不进去。所以出网被整个挪到了它**之前**：`src/preheat.mjs` 下载到 staging，
//   验签通过后原子提升进缓存，然后这一层照旧只读缓存。
//
//   于是 `--offline` 与否走的是**同一条码** —— 不存在「另一条不出网的实现」，
//   也就不会有「离线路径其实偷偷出网了」这种事。
//
// 📌 2026-09-03 之前这里确实没有网络层，那时的文案说的是「M1 没有网络客户端」。
//    现在有了；缓存未命中意味着 preheat 没取回来（通常是被降级成了「用缓存继续」）。
//
// 缓存布局（内容寻址，摘要即身份）：
//   <cacheDir>/timestamp.json            ← **单资产信封**（正文 + bundle 合一）
//   <cacheDir>/snapshots/<N>.json        + <N>.sigstore.json
//   <cacheDir>/assets/<sha256 的 hex>    ← 🔴 按摘要命名：查得到就说明摘要对得上
//
// 🔴 命中缓存**也必须**走完同样的验签（02-registry.md §9.2）：
//    本模块只负责**取字节**，一次校验都不做 —— 校验全在 `snapshot.resolveCurrent()`
//    与 `artifact.withVerifiedArtifact()` 里。把校验放进取字节层会诱使人写
//    「缓存命中就跳过」。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NetworkError, UsageError } from '../exit-codes.mjs';
import { parseStrict } from '../canonical-json.mjs';
import { unwrapTimestamp } from '../timestamp-envelope.mjs';

/** 11-wire-contract.md §2：单个 JSON 文档 ≤ 8 MiB，**解析前先查文件大小**。 */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

function readCapped(path, what) {
  const st = statSync(path);
  if (st.size > MAX_JSON_BYTES) {
    // 🔴 这**不是** NetworkError：文件明明在，只是超了 §2 的 8 MiB 上限。
    //    报成 6 的后果很具体 —— `list` / `check` 的降级判据是「退出码 6 才可降级」，
    //    于是一份超限（很可能被做过手脚）的本地缓存会被当成「网络取不到」而**静默放行**
    //    （Codex 第三轮 P0-4）。它属于 §6 第 1 条的「解析失败」。
    throw new UsageError(
      `${what} 超过 8 MiB（${st.size} 字节），拒绝解析（11-wire-contract.md §2：解析前先查文件大小）`,
      { telemetryReason: 'unknown' },
    );
  }
  return readFileSync(path);
}

function miss(what, path, offline) {
  throw new NetworkError(
    offline
      ? `${what} 未命中缓存（--offline）：${path}\n`
        + '  离线模式只用缓存；先在联网状态下取一次，或去掉 --offline。'
      : `${what} 未命中缓存：${path}\n`
        + '  ⚠️ 出网发生在 preheat（install 之前），本层只读缓存。走到这里说明\n'
        + '  preheat 没有把它取回来 —— 通常是上游报错被降级成了「用本地缓存继续」。',
    { telemetryReason: offline ? 'offline' : 'not-found' },
  );
}

/**
 * @param {object} o
 * @param {string} o.cacheDir
 * @param {boolean} o.offline
 * @returns registry 读取器。所有方法**同步**，以便直接喂给 `resolveCurrent()`。
 */
export function createCacheRegistry({ cacheDir, offline = false }) {
  // 🔴 timestamp 是**一个**资产：正文与 bundle 封在同一个文件里（决策 ③）。
  //    两个文件时 `gh release upload --clobber` 逐文件替换，中间必然有一段
  //    新旧混搭 —— 而那种中间态**验不过**，客户端看到的是「验签失败」，
  //    一个看起来像被攻击的错误。合成一个之后那个窗口在构造上就没有了。
  const tsPath = join(cacheDir, 'timestamp.json');
  const snapPath = (n) => join(cacheDir, 'snapshots', `${n}.json`);
  const snapBundlePath = (n) => join(cacheDir, 'snapshots', `${n}.sigstore.json`);
  const assetPath = (hex) => join(cacheDir, 'assets', hex);

  return Object.freeze({
    cacheDir,
    offline,

    /** §6 第 1 步的输入。🔴 同步。 */
    fetchTimestamp() {
      if (!existsSync(tsPath)) miss('timestamp.json', tsPath, offline);
      // 🔴 `unwrapTimestamp` 只拆形状、**一个字节都不动**正文 ——
      //    拆出来的要原样拿去验签。这里仍然一次校验都不做（见文件头）。
      return unwrapTimestamp(readCapped(tsPath, 'timestamp.json'));
    },

    /** §6 第 4 步的输入，也是 §6.1 历史读取路径的输入。🔴 同步。 */
    fetchSnapshot(n) {
      const p = snapPath(n);
      if (!existsSync(p)) miss(`快照 ${n}`, p, offline);
      const bp = snapBundlePath(n);
      if (!existsSync(bp)) miss(`快照 ${n} 的 sigstore bundle`, bp, offline);
      return {
        bytes: readCapped(p, `snapshot ${n}`),
        bundle: parseStrict(readCapped(bp, `snapshot ${n} bundle`).toString('utf8')),
      };
    },

    /** 有没有这一份 —— 只用来**报告**，不得用来跳过校验。 */
    hasSnapshot(n) { return existsSync(snapPath(n)) && existsSync(snapBundlePath(n)); },

    /**
     * 取资产字节。🔴 按 `record.asset.sha256` 的 hex 寻址 ——
     * 取回来之后仍然要过 `artifact.assertAssetBytes()`：
     * 内容寻址证明的是「我们按这个名字存过」，不是「字节现在还对」。
     */
    fetchAsset(record) {
      const hex = record.asset.sha256.replace(/^sha256:/, '');
      const p = assetPath(hex);
      if (!existsSync(p)) miss(`资产 ${record.id}（${record.asset.file}）`, p, offline);
      const st = statSync(p);
      if (st.size !== record.asset.size) {
        // 大小不符是**完整性**问题，不是「取不到」—— 让它按 2 报，别混进 6
        const e = new Error(
          `资产 ${record.id} 的字节数是 ${st.size}，快照记录说应为 ${record.asset.size}`,
        );
        e.name = 'IntegrityError';
        throw e;
      }
      return readFileSync(p);
    },
  });
}
