// 载荷（`artifacts/<path>/`）里的 manifest —— 快照 record **不携带**的那部分事实。
//
// 🔴 为什么非碰载荷不可：快照 record 的键集（snapshot.mjs 的 `RECORD_KEYS`）里
//    **没有 `description`，也没有 pack 的 `members` / `bundled`**。前者 CLI 的
//    `query` 已经如实承认过（只搜 name/id）；后者意味着「pack 有哪些成员」
//    这个问题，光看快照是答不出来的。
//
// 🔴 那就得说清这份数据的**担保等级**：
//    · 快照是被签名分发的对象（但**本站点不验签**，理由见 build.mjs 的 TRUST_STATEMENT）；
//    · 载荷是工作树里的目录，谁都能改。
//    所以载荷数据**只有在重新打包出来的 `tree_digest` 与 record 里那个相等时**
//    才展示，并且页面上始终标成「来自工作树载荷」。不相等就什么都不展示 ——
//    显示一份对不上号的 description，比不显示更糟。
//
// ⚠️ 相等只证明「工作树里这棵树，和 record 描述的是同一棵树」。它**不证明**
//    这张快照本身是真的（那要验签），也不证明这张快照是当前的（那要 timestamp）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { packArtifact } from '../../src/packer.mjs';
import { parseStrict } from '../../src/canonical-json.mjs';
import { validatePackManifest } from '../../src/pack.mjs';

/** 载荷根里的 manifest 文件名（01-artifacts.md §5.1 / §5.2）。 */
const MANIFEST_FILE = { skill: 'skill.json', pack: 'pack.json' };

/**
 * 取一条 record 对应的载荷 manifest。
 *
 * @param {object} record 快照 record
 * @param {string} artifactsRoot 仓库里的 `artifacts/`（可以不存在）
 * @returns {{state:'absent'|'mismatch'|'error'|'verified', note:string, manifest?:object}}
 */
export function readVerifiedManifest(record, artifactsRoot) {
  // record.path 形如 `artifacts/skills/<ns>/<name>/<version>`，第一段就是 artifacts 目录本身。
  // parseSnapshot 已经断言过 path 与 kind/ns/name/version 完全一致，所以这里可以直接切。
  const rel = record.path.replace(/^artifacts\//, '');
  const dir = join(artifactsRoot, rel);
  if (!existsSync(dir)) {
    return { state: 'absent', note: '本次构建的工作树里没有这个制品的载荷目录' };
  }

  let packed;
  try {
    // 🔴 **带上 `record`**：这样 `packArtifact` 会跑 `assertManifestBinding()` ——
    //    与安装端同一份校验器（01-artifacts.md §5.3 的六/七项全等）。不给 record 的话
    //    只证明「这是个能打包的目录」，证不了「它就是这条 record 说的那个制品」。
    packed = packArtifact({ root: dir, kind: record.kind, record });
  } catch (err) {
    return { state: 'error', note: `载荷打包/绑定校验失败：${err.message}` };
  }

  if (packed.tree_digest !== record.tree_digest) {
    return {
      state: 'mismatch',
      note: `工作树载荷的 tree_digest 是 ${packed.tree_digest}，快照 record 写的是 ${record.tree_digest}`,
    };
  }

  // 🔴 从**这一次打包捕获的 entries** 里取 manifest 字节，不回头再读一次磁盘。
  //    再读一次就有 TOCTOU：校验的是当时那棵树，展示的却可能是之后被换掉的内容。
  const want = MANIFEST_FILE[record.kind];
  const entry = packed.entries.find((e) => e.path === want);
  if (entry === undefined) {
    // packArtifact 已经保证根上有它，走到这里说明上游改了约定 —— 不猜，报出来。
    return { state: 'error', note: `载荷里找不到 ${want}（打包器本应已经拒绝）` };
  }

  let manifest;
  try {
    manifest = parseStrict(entry.data.toString('utf8'));
    if (record.kind === 'pack') manifest = validatePackManifest(manifest);
  } catch (err) {
    return { state: 'error', note: `${want} 解析失败：${err.message}` };
  }

  return {
    state: 'verified',
    note: `工作树载荷重新打包出的 tree_digest 与快照 record 相等（${packed.tree_digest}）`,
    manifest,
  };
}
