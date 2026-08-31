#!/usr/bin/env node
// promotion PR 的**确定性复算** —— 06-submission.md §4，02-registry.md §2.2。
//
// §4 要求 `validate-promotion` 做的第一件事：
//   「用 PR 里记录的 `--created-at` 重跑 `build-snapshot.mjs`，断言字节一致」。
//
// 做法：从**已提交的那张快照自己**回推 inputs（`owner` / `review` / `provenance`
// 就在每条 record 里），用同一个 `buildSnapshot()` 重算一遍，比逐字节。
//
// ── 🔴 这样验的是**哪一半**，说清楚 ──────────────────────────────────────
// ✅ **派生的一半全在覆盖范围内**：制品打包（canonical tar.gz）、`asset.sha256`
//    与 `size`、`tree_digest`、pack 的 `clients` 交集与 `capabilities` 并集、
//    `degraded` 重算、`latest` 投影、`artifacts` 排序、canonical 字节。
//    手改其中**任何一处**，重算出来的字节都对不上 —— 这正是这道门的价值。
//
// ❌ **元数据那一半不在覆盖范围内**：`owner` / `review` / `created_at` 是从被验的
//    那份快照里读出来再喂回去的，所以「有人把 review.approved_by 改了」这件事
//    本门**看不出来**。它由另外两道守：
//      · promote 时的重新验证（`verify-merged-pr.mjs`，§3 第 1 项）；
//      · §2.2 要求 `created_at` 写进 promotion PR 的描述，由**人**比对。
//    ⚠️ 不要把本门说成「快照没被动过」—— 它说的是「快照与它声称的那棵
//    `artifacts/` 树自洽 **且** 历史记录与上一张快照逐字一致」。
//
// ❗ **明确列出的盲区**（Codex 2026-08-31 逐条点名，不要再靠读代码去推断）：
//    · **新增**制品的 `owner` / `review` / `provenance` / `created_at` —— 自举，
//      由 `verify-merged-pr.mjs` 与 §2.2 的人工比对守；
//    · **新增** yank 条目的 `at` / `reason` / `advisory` —— 自举（历史条目已冻结）；
//    · `repo` —— 自举，但读取端把它对着内置常量判，实际拦得住。
//    历史制品的这些字段则**在**覆盖范围内：不可变门逐字比上一张快照。

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { stringify } from '../../src/canonical-json.mjs';
import { parseSnapshot } from '../../src/snapshot.mjs';
import { buildSnapshot } from '../build-snapshot.mjs';

class PromotionVerifyError extends Error {
  constructor(code, msg) { super(msg); this.name = 'PromotionVerifyError'; this.code = code; }
}
const bad = (code, msg) => { throw new PromotionVerifyError(code, msg); };

/**
 * 从一张已提交的快照回推 `build-snapshot.mjs` 的 `--inputs`。
 *
 * 🔴 `status` 要还原成 `published` / `deprecated`：`yanked` 与 `degraded` 是
 *    **派生**状态，`buildSnapshot` 的 `assertInputStatus` 明令不收它们
 *    —— yank 的权威是 `yanked[]`，degraded 每次重算。
 *    把它们当输入喂回去，等于让上一轮的结论参与这一轮的计算。
 */
export function inputsFromSnapshot(snap) {
  const artifacts = {};
  for (const r of snap.artifacts) {
    artifacts[r.id] = {
      status: r.status === 'yanked' || r.status === 'degraded' ? 'published' : r.status,
      owner: r.owner,
      review: r.review,
      provenance: r.provenance,
    };
  }
  return { schema: 'geoly.skills.promotion-inputs/1', artifacts, yanked: snap.yanked };
}

/**
 * 制品**不可变**（02-registry §2.1）：上一张快照里已经有的 ArtifactId，
 * 这一张里除了 `status` 之外必须一字不差。
 *
 * 🔴 **这一条复算门本身查不出来，必须单列。** 复算是拿「快照」跟「artifacts/ 树」
 *    对，两边同时被改就自洽了：把 `artifacts/skills/geoly/a/1.0.0/` 的内容换掉、
 *    再让新快照记录换过之后的 `tree_digest` 与 `asset`，复算完全通过 ——
 *    而这正是「已发布版本被掉包」这一类攻击的形状（一个已装好的用户下次校验会炸）。
 *    判据只能来自**上一张快照**，因为那才是历史事实的载体。
 *
 * ⚠️ 唯一允许变的是 `status`，且**只许往一个方向走**：
 *    `degraded` 每张快照重算、`published → deprecated` 是正常动作，
 *    但 **`deprecated → published`（撤销弃用）不行** —— 那是一次状态**回退**，
 *    需要它自己的授权流程，不能夹在 promotion 里悄悄发生。
 *    其余字段（含 `owner` / `review` / `provenance`）都不许改 ——
 *    改 owner 就是**转让**，同理。
 *
 * 🔴 `yanked[]` **只增不减，已有条目一字不改**（Codex 2026-08-31）。
 *    它是自举的：`inputsFromSnapshot` 把候选快照自己的 `yanked[]` 喂回去，
 *    而 `buildSnapshot` 正是靠它把记录标成 yanked ——
 *    于是「删掉一条 yank 记录 + 把 status 改回 published + 更新 latest」
 *    是一组**完全自洽**的改动，复算一个字节都察觉不到。
 *    un-yank 意味着一个因安全问题下架的版本重新出现在 `latest` 里。
 */
export function assertArtifactsImmutable({ previousSnapshot, snapshot }) {
  if (previousSnapshot === null || previousSnapshot === undefined) return 0;

  // ① yank 只增不减
  const nowYank = new Map(snapshot.yanked.map((y) => [y.id, stringify(y)]));
  for (const y of previousSnapshot.yanked) {
    const after = nowYank.get(y.id);
    if (after === undefined) {
      bad('E_UNYANK', `${y.id} 在上一张快照里是 yanked，这一张里没了 —— yank 不可撤销。\n`
        + '  🔴 撤销 yank 等于让一个因安全问题下架的版本重新回到 latest。');
    }
    if (after !== stringify(y)) {
      bad('E_YANK_MUTATED', `${y.id} 的 yank 记录被改过了（at / reason / advisory）—— 它是历史事实。`);
    }
  }

  const now = new Map(snapshot.artifacts.map((r) => [r.id, r]));
  let checked = 0;
  for (const before of previousSnapshot.artifacts) {
    const after = now.get(before.id);
    if (after === undefined) {
      bad('E_ARTIFACT_REMOVED',
        `${before.id} 在上一张快照里有，这一张里没了 —— 制品只能 yank，不能删（§2.1）。`);
    }
    // ② 状态回退：deprecated → published 不允许
    if (before.status === 'deprecated' && after.status === 'published') {
      bad('E_STATUS_REVERTED',
        `${before.id} 从 deprecated 变回 published —— 撤销弃用是一次状态回退，\n`
        + '  需要它自己的授权流程，不能夹在 promotion 里发生。');
    }
    // ③ 除 status 外一字不差
    const strip = (r) => stringify({ ...r, status: 'published' });
    const a = strip(before);
    const b = strip(after);
    if (a !== b) {
      bad('E_ARTIFACT_MUTATED',
        `${before.id} 的记录被改过了 —— 已发布的制品不可变（§2.1）。\n`
        + `${firstDifference(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))}\n`
        + '  🔴 复算门查不出这一类：把 artifacts/ 与快照**一起**改掉就自洽了。\n'
        + '     判据只能来自上一张快照。status 之外的任何字段都不许动。');
    }
    checked++;
  }
  return checked;
}

/**
 * @param {object} a
 * @param {string} a.artifactsRoot     promotion PR 里的 `artifacts/`
 * @param {Buffer} a.committedBytes    promotion PR 里的 `registry/snapshots/hub-<N>.json`
 * @param {Buffer|null} a.previousBytes  **base 上**的 `hub-<N-1>.json`（不可变判据）
 * @returns {{snapshot:number, artifacts:number, immutable:number}}
 */
export function verifyPromotionSnapshot({ artifactsRoot, committedBytes, previousBytes = null }) {
  // 🔴 先过**读取端**：一张读不回来的快照根本谈不上复算。
  const snap = parseSnapshot(committedBytes);

  // 🔴 `previousBytes` **只在创世快照 0 上可以缺**（`previous` 是 uint，不是 null；
  //    快照 0 是唯一允许 `previous >= snapshot` 的一张，见 snapshot.mjs 的 E_SNAPSHOT_PREV）。
  //    其余情况缺了就拒 ——「忘了传」和「真没有」长得一样，
  //    静默跳过等于把不可变门整个关掉。
  if (previousBytes === null && snap.snapshot !== 0) {
    bad('E_VERIFY_INPUT',
      `快照 ${snap.snapshot} 必须给出上一张（base 上的 hub-${snap.previous}.json）—— `
      + '不可变门的判据只能来自上一张快照，缺了它这道门就是空的。');
  }

  const { doc } = buildSnapshot({
    artifactsRoot,
    inputs: inputsFromSnapshot(snap),
    snapshot: snap.snapshot,
    previous: snap.previous,
    createdAt: snap.created_at,
    repo: snap.repo,
  });
  const rebuilt = Buffer.from(stringify(doc), 'utf8');

  if (!rebuilt.equals(committedBytes)) {
    bad('E_NOT_REPRODUCIBLE',
      `复算出来的快照与提交的那份**字节不一致**（§4 的确定性复算门）。\n`
      + `  提交的 ${committedBytes.length} 字节，复算的 ${rebuilt.length} 字节。\n`
      + `${firstDifference(committedBytes, rebuilt)}\n`
      + '  🔴 这说明快照里有**手改过**的派生字段（摘要、asset、pack 的 clients/\n'
      + '     capabilities/degraded、latest、排序……），或者 artifacts/ 与它对不上。');
  }
  // 🔴 复算之后再判不可变 —— 两道门查的是**不同**的东西，缺一不可。
  let immutable = 0;
  if (previousBytes !== null) {
    const prev = parseSnapshot(previousBytes);
    if (prev.snapshot !== snap.previous) {
      bad('E_PREVIOUS_MISMATCH',
        `给的上一张是 ${prev.snapshot}，但被验快照声称 previous=${snap.previous}。`);
    }
    // 🔴 **编号必须**连续**递增 1。** 读取端只要求 `previous < snapshot`，
    //    于是 `hub-9007199254740991.json` 也能过 —— 一旦合并，后续快照再也
    //    没有可用编号，是一次长期 DoS（Codex 2026-08-31）。
    if (snap.snapshot !== prev.snapshot + 1) {
      bad('E_SNAPSHOT_JUMP',
        `快照编号必须连续：上一张 ${prev.snapshot}，这一张应为 ${prev.snapshot + 1}，实际 ${snap.snapshot}。\n`
        + '  🔴 跳号会把编号空间用光 —— 读取端只判 previous < snapshot，拦不住。');
    }
    immutable = assertArtifactsImmutable({ previousSnapshot: prev, snapshot: snap });
  }
  return { snapshot: snap.snapshot, artifacts: snap.artifacts.length, immutable };
}

/**
 * 差异定位。
 * 🔴 **要给出第一处不同在哪**，不是只说「不一致」——
 *    一个只说「不一致」的门，人只会去猜，而快照有几万字节。
 */
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const line = a.subarray(0, i).toString('utf8').split('\n').length;
  const ctx = (buf) => JSON.stringify(buf.subarray(Math.max(0, i - 40), i + 40).toString('utf8'));
  if (i === n && a.length === b.length) return '  （长度与内容都相同 —— 走到这里说明比较逻辑本身有问题）';
  return `  第一处不同在第 ${line} 行附近（字节偏移 ${i}）：\n`
    + `    提交的：${ctx(a)}\n`
    + `    复算的：${ctx(b)}`;
}

// ── CLI ────────────────────────────────────────────────────────────────────

// 🔴 **白名单 + 拒重复。** 只拒非 `--` 开头的话，`--previuos x`（拼错）会被静默
//    忽略，于是不可变门在**没人察觉**的情况下变成空门（Codex 2026-08-31）。
const KNOWN = ['artifacts', 'snapshot', 'previous'];

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad('E_VERIFY_INPUT', `不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const key = name.slice(2);
    if (!KNOWN.includes(key)) bad('E_VERIFY_INPUT', `不认识的选项 ${name}（只接受 ${KNOWN.map((k) => `--${k}`).join(' ')}）`);
    if (key in o) bad('E_VERIFY_INPUT', `${name} 给了不止一次`);
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad('E_VERIFY_INPUT', `${name} 需要一个值`);
    o[key] = val;
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  for (const k of ['artifacts', 'snapshot']) if (o[k] === undefined) bad('E_VERIFY_INPUT', `缺少 --${k}`);
  // `--previous` 的必需性由 verifyPromotionSnapshot 判（快照 1 之外一律要）。
  const r = verifyPromotionSnapshot({
    artifactsRoot: o.artifacts,
    committedBytes: readFileSync(o.snapshot),
    previousBytes: o.previous === undefined ? null : readFileSync(o.previous),
  });

  process.stderr.write(
    `✔ 快照 ${r.snapshot} 复算逐字节一致（${r.artifacts} 个制品），`
    + `${r.immutable} 个历史制品记录未被改动。\n`
    + '⚠️ 覆盖的是**派生**那一半；owner / review / created_at 是从这份快照读出来再喂回去的，\n'
    + '   它们由 promote 的重新验证与人工比对来守（见本文件头部）。\n',
  );
  return 0;
}

export { PromotionVerifyError };

// 入口守卫比 realpath —— 见 scripts/release/build-timestamp.mjs 里的说明。
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return true; }
}

if (invokedDirectly()) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) {
    // 🔴 错误码要打出来 —— workflow 的日志里只有 stderr。
    process.stderr.write(`${e.code ? `[${e.code}] ` : ''}${e.message}\n`);
    process.exit(1);
  }
}
