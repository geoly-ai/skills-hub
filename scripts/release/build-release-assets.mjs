#!/usr/bin/env node
// 重建制品资产并逐字节比对快照里记录的摘要 —— 06-submission.md §1 阶段 C。
//
// §1 对 `release.yml` 的原话：
//   「用同一脚本重建资产，**断言字节与 PR 里记录的 sha256 一致**」
//   「建 Release hub-v<N+1>，**挂全部资产** + bundle」
//
// ── 🔴 这一步和 validate-promotion 的复算**不是**一回事 ──────────────────
// `verify-promotion.mjs` 跑在 promotion PR 上，它重算的是**整张快照**，
// 判的是「快照与它声称的那棵 artifacts/ 树自洽」。
//
// 这一步跑在 **merge 之后**，快照已经定稿、即将被签名。它判的是另一件事：
// **「我这一刻从 artifacts/ 打出来的字节，与那张已定稿快照记录的摘要一致」**。
//
// 为什么两处都要判：中间隔着一次 merge。合并顺序、rebase、乃至一次
// 「顺手改一个 typo」的追加提交，都会让 main 上的 artifacts/ 与 promotion PR
// 上被验过的那棵树不同。而 Release 上挂出去的字节来自**这一刻**的 main ——
// 签名签的是快照，用户下载的是资产，两者对不上就是一次静默的分发事故。
//
// 🔴 **不重算快照。** 快照是输入，不是产物 —— 它已经过人工审、即将被签。
//    这里只重建资产、只做比对。

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { parseSnapshot } from '../../src/snapshot.mjs';
import { packArtifact } from '../../src/packer.mjs';

class AssetError extends Error {
  constructor(code, msg) { super(msg); this.name = 'AssetError'; this.code = code; }
}
const bad = (code, msg) => { throw new AssetError(code, msg); };

/**
 * 记录里的 `path` → 落在 `artifactsRoot` 下的实际目录。
 *
 * 🔴 **不要再从 `id` 里正则解析出四段。** 第一版是那么写的
 *    （`^(skill|pack):([^/]+)\/([^@]+)@(.+)$`），那是给自己造第二个真值源：
 *    `.+` 会把 `../../etc` 一并吃进 version，拼进 `join()` 就是一次目录穿越。
 *    现在这条路径走不通，**只因为** `parseSnapshot` 已经用
 *    `RE_NAMESPACE` / `RE_NAME` / `parseSemver` 把它们逐个验过、
 *    并断言 `id` 与 `path` 都等于由这些字段拼出来的值 —— 但那是**别处**的保证。
 *    直接用已验过的 `r.path` 就不依赖那份保证了。
 *
 * ⚠️ `r.path` 的形状由 `parseSnapshot` 的 `E_PATH_MISMATCH` 钉死：
 *    `artifacts/<kind>s/<ns>/<name>/<ver>`。这里把开头的 `artifacts/` 换成
 *    调用方给的根。
 */
export function resolveArtifactDir(artifactsRoot, recPath) {
  const prefix = 'artifacts/';
  if (!recPath.startsWith(prefix)) {
    bad('E_ASSET_INPUT', `record.path 应以 ${prefix} 开头，得到 ${JSON.stringify(recPath)}`);
  }
  const rel = recPath.slice(prefix.length);
  // 防御性：`parseSnapshot` 已经不会让 `..` 出现在这里，但这一步的代价是零
  if (rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    bad('E_ASSET_INPUT', `record.path 里有不合法的片段：${JSON.stringify(recPath)}`);
  }
  return join(artifactsRoot, rel);
}

/**
 * 重建全部资产并比对。
 *
 * @param {object} a
 * @param {string} a.artifactsRoot   合并后的 `artifacts/`
 * @param {Buffer} a.snapshotBytes   已定稿的 `hub-<N>.json`
 * @param {string|null} a.outDir     写出 `.tgz` 的目录（null = 只比对不写）
 * @returns {{snapshot:number, built:number, skipped:string[]}}
 */
export function buildReleaseAssets({ artifactsRoot, snapshotBytes, outDir = null }) {
  const snap = parseSnapshot(snapshotBytes);
  if (outDir !== null) {
    // 🔴 **必须是空的**。残留的 .tgz 会被 `dist/assets/*.tgz` 一并挂上去 ——
    //    那是一个「快照里根本没有的制品」出现在 Release 上的现成路径。
    if (existsSync(outDir) && readdirSync(outDir).length > 0) {
      bad('E_ASSET_INPUT',
        `${outDir} 不是空的 —— 残留文件会被一起挂上 Release，`
        + '而它们不在这张快照里。请先清空。');
    }
    mkdirSync(outDir, { recursive: true });
  }

  const problems = [];
  const skipped = [];
  const written = new Set();
  let built = 0;

  for (const rec of snap.artifacts) {
    // 🔴 **yank 掉的也要重建。** 它仍然在快照里、仍然要能被验证 ——
    //    一个用户装过它、`check` 会去比对摘要。不挂资产等于让他的校验失败。
    //    （`degraded` 同理：那是 pack 的派生状态，成员资产照旧存在。）
    const dir = resolveArtifactDir(artifactsRoot, rec.path);
    if (!existsSync(dir)) {
      problems.push(`${rec.id}：快照里有，但 ${dir} 不存在`);
      continue;
    }

    let packed;
    try {
      // 带上 record —— packArtifact 会跑 assertManifestBinding()，
      // 那是 manifest ↔ ArtifactId 六项（skill 七项）绑定门
      packed = packArtifact({ root: dir, kind: rec.kind, record: rec });
    } catch (e) {
      problems.push(`${rec.id}：打包失败 —— ${e.message.split('\n')[0]}`);
      continue;
    }

    if (packed.sha256 !== rec.asset.sha256 || packed.size !== rec.asset.size) {
      problems.push(
        `${rec.id}：重建出来的字节与快照记录**对不上**\n`
        + `      快照记的：${rec.asset.sha256} / ${rec.asset.size} 字节\n`
        + `      这次打的：${packed.sha256} / ${packed.size} 字节`);
      continue;
    }
    // ⚠️ packArtifact 返回的是 `tree_digest`（下划线），不是 `treeDigest` ——
    //    写错的话这里恒为 `undefined !== …`，**每个制品都会被判成不一致**。
    //    那是「大声失败」的方向，不是静默放过，但仍然会让 release 整个跑不动。
    if (packed.tree_digest !== rec.tree_digest) {
      problems.push(`${rec.id}：树摘要对不上（${rec.tree_digest} vs ${packed.tree_digest}）`);
      continue;
    }

    // 🔴 两条 record 写到同一个文件名 = 后一个把前一个覆盖掉，而 Release 上
    //    只会有一份。`assetFileName` 带了 kind/ns/name/version 且 id 唯一，
    //    所以理论上撞不了 —— 但「理论上撞不了」正是不该省这一行的理由。
    if (written.has(rec.asset.file)) {
      problems.push(`${rec.id}：asset.file 与前面某条重复（${rec.asset.file}）`);
      continue;
    }
    written.add(rec.asset.file);
    if (outDir !== null) writeFileSync(join(outDir, rec.asset.file), packed.bytes);
    built++;
  }

  if (problems.length) {
    bad('E_ASSET_MISMATCH',
      `${problems.length} 个制品重建不出快照记录的字节：\n`
      + problems.map((p) => `  · ${p}`).join('\n')
      + '\n  🔴 快照即将被签名，而用户下载的是资产 —— 两者对不上就是一次静默的\n'
      + '     分发事故：签名验得过，装出来的东西却不是被审过的那个。\n'
      + '  ⚠️ promotion PR 上验过一次，但那之后隔着一次 merge。合并顺序、rebase、\n'
      + '     一次「顺手改 typo」的追加提交，都会让 main 上的树与被验过的那棵不同。');
  }
  return { snapshot: snap.snapshot, built, skipped };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const KNOWN = ['artifacts', 'snapshot', 'out'];

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad('E_ASSET_INPUT', `不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const key = name.slice(2);
    if (!KNOWN.includes(key)) bad('E_ASSET_INPUT', `不认识的选项 ${name}`);
    if (key in o) bad('E_ASSET_INPUT', `${name} 给了不止一次`);
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad('E_ASSET_INPUT', `${name} 需要一个值`);
    o[key] = val;
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  for (const k of ['artifacts', 'snapshot']) if (o[k] === undefined) bad('E_ASSET_INPUT', `缺少 --${k}`);
  const r = buildReleaseAssets({
    artifactsRoot: o.artifacts,
    snapshotBytes: readFileSync(o.snapshot),
    outDir: o.out ?? null,
  });
  process.stderr.write(
    `✔ 快照 ${r.snapshot}：${r.built} 个制品重建出的字节与记录**逐字节一致**`
    + `${o.out === undefined ? '（只比对，未写出）' : `，已写到 ${o.out}`}。\n`);
  return 0;
}

export { AssetError };

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
