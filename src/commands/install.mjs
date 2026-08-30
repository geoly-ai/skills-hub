// `install <spec>…` —— 04-install.md §5.2 的十步在命令面这一侧的接线。
//
// 十步的归属（🔴 内核明说了它**不做** 1–4，见 install.mjs 的 runTransaction 注释）：
//   1 取锁                → 本文件（locks.mjs，全序 metadata → repo → target）
//   2 残留事务分流         → 本文件调 recover(target, { mode: 'auto' })
//   3 预检                → 本文件调 precheckTarget + 🔴 assertPrecheckOk
//   4 下载 / 验资产 / 解包 → 本文件调 artifact.withVerifiedArtifact（🔴 作用域版）
//   5–10                  → install.runTransaction
//
// 🔴 三条不能忘的接线要求：
//   · `adapters.assertPlanOk(plan)` 必须调 —— 直接消费 `plan.selected` 会绕过来源校验；
//   · `target.assertPrecheckOk(result)` 必须调 —— 同上，绕过去就等于没预检；
//   · `planTargets()` 的 `warnings`（duplicate-catalog）要**展示**，不得吞掉。

import { existsSync, statfsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirChainFsync } from '../atomic-fs.mjs';
import { planTargets, assertPlanOk, getAdapter, STATE_DIR } from '../adapters/index.mjs';
import { precheckTarget, assertPrecheckOk, missingGitignorePatterns, gitignoreHint } from '../target.mjs';
import { withVerifiedArtifact } from '../artifact.mjs';
import { validatePackManifest, resolvePackInstall, addRequestedBy, conflictMatches } from '../pack.mjs';
import { withPackErrors } from './pack-errors.mjs';
import { layout, readLedger, bootstrapLedger, nextGeneration, ensureGenerationWatermark } from '../ledger.mjs';
import { derivePlan } from '../plan.mjs';
import { runTransaction, nowUtc } from '../install.mjs';
import { recover } from '../recover.mjs';
import { mountEntryFor, assertNoSymlinkInChain } from '../safe-fs.mjs';
import { withOrderedLocks } from './locks.mjs';
import { parseSpec, resolveSpec } from './resolve.mjs';
import { annotations, annotationSuffix } from './output.mjs';
import { UsageError, ConflictError, UnsupportedError, EXIT, classify } from '../exit-codes.mjs';
import { resolveSnapshotForCommand } from './snapshot-access.mjs';
import { makeLockfileHook } from './sync-lock.mjs';

/**
 * 🔴 **作用域版必须包住整个 `runTransaction`**，不能只包「解包」那一小段。
 *
 * `derivePlan` 把解包目录的路径记进 `plan.sources`，而 `stageTrees` 要从那里取树。
 * 回调一返回 `dispose()` 就把目录删了 —— 于是「先 withVerifiedArtifact 拿到 dir，
 * 再在外面 runTransaction」这种写法会在第 5 步找不到源目录。
 *
 * 多个制品要**嵌套**：任意一层抛错，它自己和外层的隔离目录都会被清掉。
 */
function withVerifiedArtifacts(items, parent, fn, acc = []) {
  if (items.length === 0) return fn(acc);
  const [head, ...tail] = items;
  return withVerifiedArtifact({ bytes: head.bytes, record: head.record, parent }, (art) =>
    withVerifiedArtifacts(tail, parent, fn, [...acc, { ...head, art }]));
}

/**
 * §5.2 第 3 步的「磁盘余量 ≥ 新制品解压后 × 2」。
 *
 * ⚠️ **诚实边界**：这是**一次**快照检查，不是「期间持续检查」。规格第 4 步写的是
 * 「期间持续检查空间」，而真正的持续检查要在解包循环内部做 —— 那在 `untar.mjs` 里，
 * 不在本块的文件边界内。这里能给的只有「动手之前先看一眼」，
 * 以及解包完成之后**再看一眼**（`stage` 之前）。这条写进交付汇报。
 */
export function assertDiskSpace(target, needBytes) {
  let s;
  try { s = statfsSync(target); } catch { return { checked: false, reason: 'statfs 不可用' }; }
  const free = Number(s.bavail) * Number(s.bsize);
  const want = needBytes * 2;
  if (free < want) {
    const e = new Error(
      `磁盘余量不足：${target} 只剩 ${free} 字节，本次至少需要 ${want}`
      + `（新制品解压后 ${needBytes} 字节 × 2，04-install.md §5.2 第 3 步）`,
    );
    e.name = 'DiskFull';
    e.exitCode = EXIT.UNSUPPORTED;
    throw e;
  }
  return { checked: true, free, want };
}

/** 递归量一棵树的字节数（只数普通文件；目录项本身不计）。 */
export function treeBytes(dir) {
  let total = 0;
  (function rec(d) {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) rec(p);
      else if (n.isFile()) total += statSync(p).size;
    }
  })(dir);
  return total;
}

function fstypeOf(p) {
  try { return mountEntryFor(p)?.type ?? 'unknown'; } catch { return 'unknown'; }
}

/**
 * §8.2 遮蔽（D4）：全局已存在同名 skill 时，项目级安装**默认拒绝**，需 `--shadow-global`。
 * 🔴 给了 flag 就是用户**明确接受歧义** —— 输出里必须逐条标 `shadowed`，不是装完就算。
 */
export function detectShadowed(names, { client, home, env }) {
  const globalTarget = getAdapter(client).root({ scope: 'global', home, env });
  const hit = [];
  for (const n of names) if (existsSync(join(globalTarget, n))) hit.push(n);
  return { globalTarget, shadowed: hit };
}

/** `skipped[].why` → 人类文案（与 commands/vendor.mjs 同一张表的语义）。 */
const SKIP_REASON = Object.freeze({
  __proto__: null,
  'no-bundled': '--no-bundled 跳过（role: tool）',
  'bundled-yanked': '🔴 bundled 成员已被 yank —— 按 03-packs.md §5 跳过，pack 仍是 published',
  'bundled-degraded': '🔴 bundled 成员是 degraded 的 pack —— 按 §5 的同一条跳过',
});

/**
 * 把「用户敲的 spec」摊成「真正会落盘的单元」+「账本里的 root」。
 *
 * - `direct:<artifact-id>` root ↔ 该 skill 本身一个单元；
 * - `pack:<ns>/<name>@<ver>` root ↔ 它 §4 解析出来的**每个成员**一个单元。
 *
 * 🔴 **同名必须合并成一个单元，不能变成两个计划项。** `derivePlan` 的 `claim()`
 *    对同一事务里重复的 `name` 直接抛错；而「同一个 skill 被一个 pack 和一条 direct
 *    同时请求」「两个 pack 共享一个成员」都是完全正常的现场。合并之后
 *    `requested_by` 带两个 root key —— 这正是 §4.1 refcount 想要的形状。
 *
 * 🔴 同名但**不同制品**（版本不同、或 namespace 不同）→ 拒绝，不猜。
 *    它们要落到同一个目录名上，谁覆盖谁没有正确答案。
 */
export function buildUnits(records, packInfos) {
  const byName = new Map();
  const rootSpecs = [];
  const add = (record, rootKey) => {
    const cur = byName.get(record.name);
    if (cur === undefined) {
      byName.set(record.name, { name: record.name, record, requestedBy: [rootKey] });
      return;
    }
    if (cur.record.id !== record.id) {
      throw new ConflictError(
        `目录名 ${record.name} 被两个不同的制品请求：${cur.record.id} 与 ${record.id}。\n`
        + '  它们要落到同一个目录上，谁覆盖谁没有正确答案 —— 请只保留一个，'
        + '或分别装到不同的 target。',
        { telemetryReason: 'version-conflict' },
      );
    }
    // 🔴 去重 + 字节序升序由 addRequestedBy 保证（ledger.validateEntry 就是这么校的）
    cur.requestedBy = addRequestedBy(cur.requestedBy, rootKey);
  };

  for (const r of records) {
    if (r.kind === 'pack') continue;      // pack 的单元来自它的成员，见下
    const key = `direct:${r.id}`;
    rootSpecs.push({ key, kind: 'direct', artifact: r.id, tree_digest: r.tree_digest });
    add(r, key);
  }
  for (const p of packInfos) {
    // 🔴 pack root 的 key **就是 ArtifactId 本身**（它已经以 `pack:` 开头），
    //    不再加 `direct:` 前缀 —— 见 pack.parseRootKey 的 grammar。
    const key = p.record.id;
    rootSpecs.push({ key, kind: 'pack', artifact: p.record.id, tree_digest: p.record.tree_digest });
    for (const m of p.plan.install) add(m.record, key);
  }
  return { units: [...byName.values()], rootSpecs };
}

/**
 * 单个单元的 `requested_by`，以及它牵连的**旧 root 去留**。
 *
 * 🔴 `buildLedgerImage()` 是拿 `req.requested_by` **整个覆盖**的，不做合并 ——
 *    所以合并只能在这里做，且必须做：不合并的话「先 direct 装了 x，
 *    再装一个也含 x 的 pack」会把 direct 那条边抹掉，M4 的 `remove` 就会
 *    在还有人要它的时候把目录删掉。
 *
 * 🔴 **制品变了（换版本）时不合并旧边** —— 旧 root 请求的是旧版本，这个目录
 *    已经不再满足它；留着那条边是说谎，还会让 `remove` 永远删不掉。
 *    但**丢掉边还不够**：Codex 2026-08-30 指出那样会留下「root 还在、没有任何
 *    entry 指向它」的**悬挂 root**，投影进 lockfile 就是一条假记录。
 *    所以本函数把失去引用的旧 root 一并交出来（`orphanedRoots`），
 *    由调用方放进**同一个** `ledger_image.post` 的 `removeRoots` 里。
 *
 * 🔴 **旧边里有 pack root 时直接拒绝换版本。** pack.json 锁的是成员的
 *    **精确版本 + tree_digest**（03-packs.md §2）；把它的成员目录换成别的版本，
 *    等于在用户看不见的地方把矩阵的锁弄断，而 pack 自己仍然显示 published。
 *    这条的正确出口是 §4.2 的 `update pack:`（M4），不是让 install 悄悄干掉它。
 *
 * @returns {{requested_by:string[], orphanedRoots:string[]}}
 */
export function planEntryRefs(ledger, record, incoming) {
  const old = ledger.entries?.[record.name];
  let list = [...incoming];
  if (!old) return { requested_by: list, orphanedRoots: [] };
  if (old.artifact === record.id) {
    for (const k of old.requested_by ?? []) list = addRequestedBy(list, k);
    return { requested_by: list, orphanedRoots: [] };
  }
  const dropped = (old.requested_by ?? []).filter((k) => !list.includes(k));
  const packRoots = dropped.filter((k) => k.startsWith('pack:'));
  if (packRoots.length) {
    throw new ConflictError(
      `${record.name} 现在是 ${old.artifact}，由 pack 锁定：${packRoots.join(', ')}。\n`
      + `  换成 ${record.id} 会**弄断那个 pack 的锁** —— pack.json 锁的是成员的精确版本\n`
      + '  与 tree_digest（03-packs.md §2），而 pack 自己仍然会显示 published。\n'
      + '  正确出口是 `update pack:<name>`（04-install.md §4.2，M4），不是让 install 悄悄改掉它。',
      { telemetryReason: 'version-conflict' },
    );
  }
  return { requested_by: list, orphanedRoots: dropped };
}

/**
 * 本次事务结束后，哪些 root 已经没有任何 entry 指向。
 *
 * 🔴 判据必须是**事务后的全景**，不是「这一条 entry 掉了哪些边」：
 *    一个 pack root 有 a、b 两个成员，只有 a 换了制品时它**没有**变成孤儿。
 */
export function orphanRootsAfter(ledger, installReqs, retireNames) {
  const after = new Map();
  for (const [name, e] of Object.entries(ledger.entries ?? {})) after.set(name, e.requested_by ?? []);
  for (const n of retireNames) after.delete(n);
  for (const r of installReqs) after.set(r.name, r.requested_by);
  const live = new Set();
  for (const list of after.values()) for (const k of list) live.add(k);
  return Object.keys(ledger.roots ?? {}).filter((k) => !live.has(k)).sort();
}

/**
 * §4 解析顺序第 4 步：`conflicts` 与**事务后的全景**比对。
 *
 * 🔴 判据不能只看账本现状（Codex 2026-08-30 P1）。「不能共存」说的是**最终状态**，
 *    而最终状态包含本次要装的东西：空 target 上 `install pack:A skill:ns/x`，
 *    A 的 conflicts 命中 x 时账本是空的、检查通过，最后两个一起落盘 ——
 *    这道门就白设了。所以候选集 = 账本已有 entry ∪ 本次单元 ∪ 本次的 pack 本体。
 *
 * 🔴 `--replace <name>` 是 §4 第 4 步给的唯一出路，但它**必须真的把那条 entry
 *    退掉**（Codex 同轮 P1）。早先只是「跳过冲突检查」——而 `--replace` 在本仓库
 *    的语义是「点名替换**未被账本认领**的同名目录」，对已认领 entry 什么都不做，
 *    于是冲突双方照旧共存。那是最坏的一种：门看起来在，实际没拦住。
 *    现在它产出一个 `retire` 计划项，与安装在**同一个事务**里。
 *
 * 🔴 **要退掉的 entry 由 pack 请求时拒绝**：那会把另一个 pack 的矩阵拆掉。
 * 🔴 **本次事务内部的冲突没有 `--replace` 出路**：两样都是这条命令要装的，
 *    退掉谁都不是用户表达过的意思 —— 让他自己改命令行。
 *
 * @returns {{retire:string[]}}
 */
export function planPackConflicts(packInfos, ledger, units, replace, target) {
  // 候选：name → artifact id。本次单元覆盖账本里的同名项（它就要被换掉了）
  const candidates = new Map();
  for (const [name, e] of Object.entries(ledger.entries ?? {})) candidates.set(name, e.artifact);
  const incoming = new Set(units.map((u) => u.name));
  for (const u of units) candidates.set(u.name, u.record.id);

  const retire = new Set();
  const blocked = [];
  const hit = (pack, pattern, name, artifact, inTx) => {
    if (inTx) {
      blocked.push({ pack, pattern, name, artifact, why: 'in-transaction' });
      return;
    }
    if (!replace.has(name)) {
      blocked.push({ pack, pattern, name, artifact, why: 'needs-replace' });
      return;
    }
    const byPack = (ledger.entries[name]?.requested_by ?? []).filter((k) => k.startsWith('pack:'));
    if (byPack.length) {
      blocked.push({ pack, pattern, name, artifact, why: 'held-by-pack', holders: byPack });
      return;
    }
    retire.add(name);
  };

  for (const p of packInfos) {
    for (const pat of p.manifest.conflicts) {
      // pack 本体之间的冲突（pack A 声明 conflicts: pack:ns/B）
      for (const q of packInfos) {
        if (q.record.id === p.record.id) continue;
        if (conflictMatches(pat, q.record.id)) {
          blocked.push({ pack: p.record.id, pattern: pat.raw, name: q.record.name, artifact: q.record.id, why: 'in-transaction' });
        }
      }
      for (const [name, artifact] of candidates) {
        // 🔴 pack 不与自己的成员冲突判定 —— 那是这个 pack 自相矛盾，另说；
        //    但它**确实**该被拦下，所以这里不做例外，如实命中。
        if (conflictMatches(pat, artifact)) hit(p.record.id, pat.raw, name, artifact, incoming.has(name));
      }
    }
  }

  if (blocked.length) {
    const lines = blocked.map((b) => {
      const head = `  ${b.name}（${b.artifact}）命中 ${b.pack} 的 conflicts: ${b.pattern}`;
      if (b.why === 'in-transaction') return `${head}\n      —— 两样都是本次要装的，没有 --replace 出路：请改命令行`;
      if (b.why === 'held-by-pack') return `${head}\n      —— 它由 pack 请求（${b.holders.join(', ')}），退掉会拆散那个矩阵`;
      return `${head}\n      —— 出路：--replace ${b.name}（会在同一个事务里把它退掉）`;
    });
    throw new ConflictError(
      `${target}：与 pack 声明的 conflicts 冲突（03-packs.md §4 第 4 步）：\n${lines.join('\n')}\n`
      + '🔴 没有泛化的 --force。',
      { telemetryReason: 'version-conflict' },
    );
  }
  return { retire: [...retire].sort() };
}

export async function cmdInstall(ctx, argv, out) {
  const specs = [];
  for (const a of argv) {
    if (a === '--all') {
      throw new UsageError(
        '`install --all` 是 M2 的能力（09-cli.md §1 的阶段列）。'
        + '日常「一键装一组」的正确入口是 `install pack:<name>` —— 那也在 M2。',
      );
    }
    if (a.startsWith('-')) throw new UsageError(`install 不认得 flag ${a}`);
    specs.push(a);
  }
  if (specs.length === 0) throw new UsageError('用法：skills-hub install <spec>…（至少一条）');

  const queries = specs.map(parseSpec);

  // ── 目标解析（🔴 assertPlanOk 必须调） ──────────────────────────────────
  const tplan = planTargets({
    clients: ctx.clients,
    scope: ctx.scope,
    home: ctx.home,
    env: ctx.env,
    projectRoot: ctx.projectRoot,
    createMissing: ctx.createMissing === 'all'
      ? true
      : Array.isArray(ctx.createMissing) && ctx.createMissing.length > 0,
  });
  // 🔴 展示，不吞：同一个读者读了多个被选中的 root 时 catalog 会出现重复条目
  for (const w of tplan.warnings) out.warn(w);
  assertPlanOk(tplan);

  // `--create-missing <client>` 点名时，只对点到的那几个 client 生效
  const named = Array.isArray(ctx.createMissing) ? new Set(ctx.createMissing) : null;
  const selected = tplan.selected.filter((t) => !t.willCreate || ctx.createMissing === 'all' || named?.has(t.client));
  for (const t of tplan.selected) {
    if (t.willCreate && !selected.includes(t)) {
      out.warn(`${t.client}/${t.scope} 的目录不存在，且 --create-missing 没有点到它：跳过`);
    }
  }

  // §6 第 0 条：`skipped: 目录不存在` / `skipped: unsupported` **算成功**
  for (const s of tplan.skipped) out.note(`跳过 ${s.client}/${s.scope}：${s.reason} —— ${s.message}`);

  if (selected.length === 0) {
    out.line('没有可安装的 target（全部跳过）。');
    for (const s of tplan.skipped) out.line(`  skipped  ${s.client}/${s.scope}  ${s.reason}`);
    return out.emit('install', {
      targets: [],
      skipped: tplan.skipped.map((s) => ({ client: s.client, reason: s.reason, scope: s.scope })),
    }, EXIT.OK);
  }

  // ── 解析当前快照（metadata 锁在 trust 内核里起落，本层不碰它） ───────────
  const { snapshot: snap, stale, floor, pinned, verifier } = await resolveSnapshotForCommand(ctx);
  if (stale) out.warn('timestamp 已过期：本次输出全部按 stale 处理（--allow-stale 已给）');

  // 🔴 **按 ArtifactId 去重。** 两条 spec 可以解析到同一个 record（`x` 与
  //    `skill:geoly/x@0.1.0`），同一条也可以被写两遍。不去重的话它会被 fetch
  //    与验签两次 —— 第二次取字节失败就让整条命令失败，而第一次明明已经验过了
  //    （Codex 2026-08-30 P2）。埋点也会因此重复计数。
  const resolved = queries.map((q) => resolveSpec(snap, q, { pre: ctx.pre, allowYanked: ctx.allowYanked }));
  const records = [...new Map(resolved.map((r) => [r.id, r])).values()];
  for (const r of records) {
    if (r.status === 'yanked') out.warn(`🔴 ${r.id} 已被 yank，仍按 --allow-yanked 安装（会写进账本）`);
    if (r.status === 'deprecated') out.warn(`${r.id} 的状态是 deprecated`);
  }

  // ── pack：取本体 → 验签 → 读 pack.json → §4 的成员解析 ─────────────────
  // 🔴 **在进 target 循环之前做一次就够**：成员集合与 target 无关。
  //    唯一与 target 有关的是 §4 第 3 步的 client 门，而 pack record 的 `clients`
  //    本身就是「成员交集」（由 promotion 写进快照），所以它走下面那条**和 direct
  //    完全同一个**的兼容性检查 —— 一处判定、一种文案。
  //    因此这里 `client: null`：让 resolvePackInstall 只管成员，不重复判 client。
  const byId = new Map(snap.artifacts.map((r) => [r.id, r]));
  const packInfos = records.filter((r) => r.kind === 'pack').map((record) => {
    const bytes = ctx.registry.fetchAsset(record);
    const manifest = withPackErrors(() => withVerifiedArtifact(
      { bytes, record }, (art) => validatePackManifest(art.manifest),
    ));
    const plan = withPackErrors(() => resolvePackInstall({
      manifest,
      packRecord: record,
      lookup: (id) => byId.get(id),
      intent: { noBundled: ctx.noBundled, allowYanked: ctx.allowYanked },
      client: null,
    }));
    return { record, manifest, plan };
  });
  for (const p of packInfos) {
    for (const sk of p.plan.skipped) out.warn(`${p.record.id}：跳过成员 ${sk.id} —— ${SKIP_REASON[sk.why] ?? sk.why}`);
  }

  // 🔴 **pack 自己不落成 skills/ 下的目录。** pack 是引用不是容器（03-packs.md §1）：
  //    它的载荷只有 pack.json 与说明文档，账本里它是一条 **root**，不是 entry。
  //    要把 pack 的载荷摊成目录树是 `vendor` 干的事，不是 install。
  const { units, rootSpecs } = buildUnits(records, packInfos);

  // 客户端兼容性：record.clients 声明支持哪些 client
  for (const t of selected) {
    const bad = records.filter((r) => r.clients.length > 0 && !r.clients.includes(t.client));
    if (bad.length) {
      throw new ConflictError(
        `${bad.map((r) => r.id).join(', ')} 未声明支持 client=${t.client}`
        + `（声明的是 ${bad[0].clients.join(', ') || '(空)'}）`,
        { telemetryReason: 'unsupported-client' },
      );
    }
  }

  // ── §8.2 遮蔽：项目级安装 vs 全局同名 ───────────────────────────────────
  // 🔴 判据是**真正会落盘的目录名**（= 单元名），不是用户敲的 spec。
  //    装 pack 时落盘的是它的成员，`records.map(r => r.name)` 会拿到 pack 自己的名字
  //    —— 那个名字根本不会出现在 skills/ 下，于是遮蔽检测**一个都查不到**。
  const names = units.map((u) => u.name);
  const shadowInfo = new Map();
  if (ctx.scope === 'project') {
    for (const t of selected) {
      const d = detectShadowed(names, { client: t.client, home: ctx.home, env: ctx.env });
      shadowInfo.set(t.client, d);
      if (d.shadowed.length && !ctx.shadowGlobal) {
        throw new ConflictError(
          `全局已存在同名 skill：${d.shadowed.join(', ')}（在 ${d.globalTarget}）。\n`
          + '  项目级安装**默认拒绝**（04-install.md §8.2 / D4）：四端的项目级 / 全局优先级未知，\n'
          + '  装下去会产生一个我们无法承诺结果的歧义。\n'
          + '  明确接受这个歧义请给 --shadow-global；此后每一次相关输出都会标 [shadowed]。',
          { telemetryReason: 'version-conflict' },
        );
      }
    }
    // §3.3：项目级安装必须让 git 忽略 adapter 派生的实际路径
    const missing = missingGitignorePatterns(ctx.projectRoot, selected.map((t) => t.client));
    if (missing.length) out.warn(gitignoreHint(ctx.projectRoot, selected.map((t) => t.client)));
  }

  // ── 建 target 目录：本次运行的第一个磁盘写入 ─────────────────────────────
  // 🔴 `willCreate` 说的是**客户端目录**（`.claude`）在不在，那一层由 `--create-missing`
  //    把关（§2.3：目录不存在不是失败，只有点名了才创建）。
  //    但 target 是它下面的 `skills/` —— 客户端目录已经在、`skills/` 还没有，
  //    是完全正常的现场，那一层是**我们的**目录，本来就该由我们建。
  //    早先只在 `willCreate` 时建，于是这种现场会在取锁时 stat 出 ENOENT。
  // 🔴 **不得声称「失败则磁盘未变」**（11-wire-contract.md §5 的统一口径）：
  //    这一步建出来的目录，后面任一步失败它都会留着。
  //    这是**幂等初始化**，不是半截事务 —— 下一次运行照常用它。
  for (const t of selected) {
    // 🔴 建目录**之前**先查从可信 base 到 target 的整条路径链。
    //    这一步早于取锁、也早于第 3 步的预检 —— 父级被换成软链时，
    //    一个 mkdir 就能在仓外/家目录外造出目录（Codex 第三轮 P0-3）。
    if (t.base) {
      const rel = t.target.startsWith(`${t.base}/`) ? t.target.slice(t.base.length + 1) : null;
      if (rel === null) {
        throw new UnsupportedError(`target 不在 adapter 的可信 base 之下：${t.target} 不在 ${t.base} 里`);
      }
      try { assertNoSymlinkInChain(t.base, rel); } catch (e) {
        throw new UnsupportedError(`建 target 目录前的路径链检查不通过：${e.message}`);
      }
    }
    mkdirChainFsync(t.target);
  }

  // ── 取锁：repo → target（全序；metadata 已在解析阶段起落完毕）───────────
  const results = [];
  const t0 = Date.now();
  withOrderedLocks(
    {
      baseFor: (p) => selected.find((t) => t.target === p)?.base ?? null,
      projectRoot: ctx.scope === 'project' ? ctx.projectRoot : null,
      targets: selected.map((t) => t.target),
    },
    ({ targets: ordered }) => {
      const byPath = new Map(selected.map((t) => [t.target, t]));
      for (const o of ordered) {
        const t = byPath.get(o.path);
        const started = Date.now();
        try {
          const r = installOneTarget(ctx, t, { units, rootSpecs, packInfos }, { snap, floor, pinned, out, verifier });
          results.push({
            ...r, client: t.client, scope: t.scope, target: t.target, ok: true, ms: Date.now() - started,
          });
        } catch (err) {
          const cls = classify(err);
          results.push({
            client: t.client, scope: t.scope, target: t.target, ok: false,
            ms: Date.now() - started, error: err.message, exit_code: cls.code, reason: cls.reason, _err: err,
          });
        }
      }
    },
  );

  // ── 埋点（🔴 事务之外、收尾处；record 不抛，也不放进关键路径）───────────
  emitTelemetry(ctx, results, records, snap);

  // ── §7：逐 target 结果表，即使全部成功。**不允许只打一句 done。** ────────
  const okCount = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  out.line(`install 结果（快照 ${snap.snapshot}${pinned ? '，--snapshot 钉住' : ''}，共 ${results.length} 个 target）：`);
  for (const r of results) {
    const a = annotations({
      stale, offline: ctx.offline,
      yanked: records.some((x) => x.status === 'yanked'),
      degraded: records.some((x) => x.status === 'degraded'),
      shadowed: (shadowInfo.get(r.client)?.shadowed.length ?? 0) > 0,
    });
    out.line(`  ${r.ok ? 'ok      ' : 'failed  '}${r.client}/${r.scope}  ${r.target}${annotationSuffix(a)}`);
    if (!r.ok) out.line(`          ${r.error.split('\n')[0]}`);
    else out.line(`          第 ${r.generation} 代，装了 ${r.installed.join(', ') || '(无变化)'}`);
    r.annotations = a;
  }
  for (const t of selected) out.line(`提示（${t.client}）：${t.adapter.postInstallHint()}`);

  let exit = EXIT.OK;
  if (failed.length === results.length && failed.length > 0) exit = classify(failed[0]._err).code;
  else if (failed.length > 0) exit = EXIT.PARTIAL;

  const body = {
    duration_ms: Date.now() - t0,
    installed: records.map((r) => ({ artifact: r.id, name: r.name, status: r.status, version: r.version })),
    pinned_snapshot: pinned ? snap.snapshot : undefined,
    skipped: tplan.skipped.map((s) => ({ client: s.client, reason: s.reason, scope: s.scope })),
    snapshot: snap.snapshot,
    targets: results.map((r) => ({
      annotations: r.annotations,
      client: r.client,
      error: r.ok ? undefined : r.error,
      exit_code: r.ok ? 0 : r.exit_code,
      generation: r.ok ? r.generation : undefined,
      installed: r.ok ? r.installed : undefined,
      ok: r.ok,
      scope: r.scope,
      target: r.target,
    })),
  };
  if (exit !== EXIT.OK && exit !== EXIT.PARTIAL) {
    // 全部失败：照最严重的那条单项错误报，并且**仍然**给出完整的逐 target 表
    return out.emitError('install', classify(failed[0]._err), failed[0]._err, body);
  }
  return out.emit('install', body, exit);
}

/** 单个 target 的第 2–10 步。 */
function installOneTarget(ctx, t, { units, rootSpecs, packInfos }, { snap, floor, out, verifier }) {
  const target = t.target;
  const P0 = layout(target);
  const onLedgerChanged = makeLockfileHook(ctx, { snap, verifier });

  // ── 第 2 步：残留事务分流（2a → 2b-1 → 2b-2 → 2c，内核已按顺序编排）────
  const rec = recover(target, { mode: 'auto', onLedgerChanged, keepGenerations: ctx.keepGenerations });
  if (rec.outcome !== 'nothing') out.note(`${t.client}：入口分流 —— ${rec.outcome}`);

  // ── 第 3 步：预检（🔴 assertPrecheckOk 必须调）─────────────────────────
  const pre = precheckTarget(target, { base: t.base, targetSet: [target] });
  assertPrecheckOk(pre);

  // ── 第 4 步：取字节 → 验签/验资产/解包/manifest 绑定 ────────────────────
  // 🔴 取的是**单元**（真正会落盘的那些），不是用户敲的 spec ——
  //    pack 本体不落盘，它的字节在 cmdInstall 里读 pack.json 时已经验过一遍。
  const items = units.map((u) => ({ unit: u, record: u.record, bytes: ctx.registry.fetchAsset(u.record) }));

  // 🔴 作用域版包住**整个**事务：plan.sources 指向解包目录，回调一返回它就没了
  return withVerifiedArtifacts(items, join(target, STATE_DIR), (verified) => {
    const need = verified.reduce((n, v) => n + treeBytes(v.art.dir), 0);
    assertDiskSpace(target, need);

    // 🔴 §4.1 的降级语义：水位缺失时**不静默扫描猜一个**。
    //    必须在 bootstrap 账本**之前**调 —— 账本一旦写出，`hasHubContent()` 就为真，
    //    于是「首次安装」会被误判成「本地历史被重置」而拒绝。
    ensureGenerationWatermark(P0);
    const ledgerExisted = existsSync(P0.ledger);
    const targetMeta = {
      client: t.client,
      scope: t.scope,
      path: target,
      realpath: realpathSync(target),
      fstype: fstypeOf(target),
    };
    const L = ledgerExisted ? readLedger(P0.ledger) : bootstrapLedger(P0, targetMeta);
    const generation = nextGeneration(P0);
    const at = nowUtc(ctx.now());

    // 🔴 未被账本认领的同名目录：`derivePlan` 会抛 `Corrupt`（→ 退出码 5），
    //    但这在语义上是**冲突未解决**（§6 第 3 条）。在这里先判、抛 ConflictError，
    //    让退出码落对格 —— 不靠对内核的错误文案做正则。
    const replace = new Set(ctx.replace);
    for (const r of units) {
      const dir = join(target, r.name);
      if (!existsSync(dir)) continue;
      if (Object.hasOwn(L.entries, r.name)) continue;
      if (replace.has(r.name)) continue;
      throw new ConflictError(
        `${target}/${r.name} 是一个**未被账本认领**的同名目录：默认阻断（04-install.md §4.2）。\n`
        + `  出路只有 --replace ${r.name}，或自行把它移走。🔴 没有泛化的 --force。`,
        { telemetryReason: 'version-conflict' },
      );
    }

    // ── §4 第 4 步：conflicts 与**事务后的全景**比对（含本次要装的东西）────
    const { retire } = planPackConflicts(packInfos, L, units, replace, target);
    for (const n of retire) out.warn(`--replace ${n}：它命中了 pack 的 conflicts，本次事务会把它退掉`);

    // 🔴 §4.1 refcount：roots 与 requested_by 只在这里（→ `ledger_image.post`）成形，
    //    绝不在下载 / stage / 「某个成员装成功了」的时刻改（pack.mjs 那一节写死了）。
    const intent = { no_bundled: ctx.noBundled, pre: ctx.pre };
    if (ctx.allowYanked) intent.allow_yanked = true;      // 账本如实记录本机历史
    const roots = {};
    for (const rs of rootSpecs) {
      roots[rs.key] = {
        artifact: rs.artifact,
        intent,
        kind: rs.kind,
        requested_at: at,
        snapshot: snap.snapshot,
        tree_digest: rs.tree_digest,
      };
    }

    const installReqs = [];
    for (const v of verified) {
      const r = v.record;
      installReqs.push({
        artifact: r.id,
        installed_at: at,
        name: r.name,
        // 🔴 与账本里**已有**的 requested_by 合并 —— 但**只在制品没变**时。
        //    buildLedgerImage 是拿 `req.requested_by` 整个覆盖的，不合并；
        //    不带上旧的，「先 direct 装了 x，再装一个含 x 的 pack」就会把 direct
        //    那条边悄悄抹掉，M4 的 `remove` 于是会把还有人要的目录删掉。
        //    ⚠️ 制品**变了**（换版本）时不合并：旧 root 要的是旧版本，这个目录
        //    已经不再满足它了。留着那条边是说谎，而 `remove` 会因此永远删不掉。
        //    （换版本的正确语义是 §4.2 的 update，那是 M4。）
        requested_by: planEntryRefs(L, r, v.unit.requestedBy).requested_by,
        snapshot: snap.snapshot,
        srcDir: v.art.dir,
        tree_digest: r.tree_digest,
      });
    }

    // 🔴 事务后没有任何 entry 指向的 root 一并删掉 —— 与安装在**同一个**
    //    `ledger_image.post` 里（04-install.md §5.2 第 9 步）。
    //    不删就会留下「root 还在、没人指向它」的悬挂记录，投影进 lockfile 即是假记录。
    //    ⚠️ 判据是**事务后的全景**：一个 pack root 只要还有别的成员指着它就不算孤儿。
    const removeRoots = orphanRootsAfter(L, installReqs, retire)
      .filter((k) => !Object.hasOwn(roots, k));      // 本次要写入的 root 不在此列

    const plan = derivePlan({
      generation,
      install: installReqs,
      ledger: L,
      ledgerExisted,
      removeRoots,
      replace,
      retire,
      roots,
      target,
    });

    // 🔴 R-9：提交点之前的最后一刻复验 trust floor。`floor` **必须显式给**；
    //    没有 registry 出处时显式写 null（这里永远有出处，但 floor 可能尚未 bootstrap）。
    runTransaction(target, plan, {
      floor: floor === null ? null : { expected: floor, stateDir: ctx.stateDir },
      keepGenerations: ctx.keepGenerations,
      now: at,
      onLedgerChanged,
    });

    return { generation, installed: installReqs.map((r) => r.name), retired: retire };
  });
}

function emitTelemetry(ctx, results, records, snap) {
  const rec = ctx.record;
  if (!rec) return;
  for (const r of results) {
    for (const a of records) {
      // 🔴 `reason` 只能来自 REASONS 有限代码表；`record()` 自己不抛，但传错值会被它内部
      //    的 assertValidEvent 拒掉并静默丢事件 —— 所以 reason 由 classify() 产出。
      rec({
        artifact: a.id,
        client: r.client,
        kind: 'install',
        ms: r.ms,
        reason: r.ok ? undefined : r.reason,
        result: r.ok ? 'ok' : 'failed',
        scope: r.scope,
        version: a.version,
      });
    }
  }
}
