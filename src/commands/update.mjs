// `update [<spec>…] | --all` —— 09-cli.md §1：「**受控地改 lockfile 并应用**」，
// 04-install.md §8：「`update` 是受控地改 lockfile：**展示 diff、要求确认**」。
//
// 🔴 这条命令改的是**账本里的 root**，不是「命令行说了什么」。
//    `install` 的语义是「往图里**加**一条边」（planEntryRefs 刻意保留旧边）；
//    `update` 的语义是「把某几条 root **换掉**」——
//    ⚠️ 直接复用 `planEntryRefs()` 会把 `pack:P@0.3` 更新到 `pack:P@0.4` 之后
//    留下 `[P@0.3, P@0.4]` 两条边（成员没变时「制品相同 ⇒ 合并旧边」那一支），
//    于是旧 root 永远删不掉、lockfile 里多出一条假记录（Codex 2026-09-04 P0-1）。
//    所以本模块自己算完整的二部图：**先把选中 root 的全部边摘掉，再叠加新解析结果。**
//
// 时序（`installOneTarget` 是同步的、在锁里；出网只能发生在取锁之前）：
//   ① 锁外：解析快照 → 读各 target 账本 → 重解析选中 root → 算 diff → 展示 → 确认
//           → 预热要用到的资产与历史快照；
//   ② 锁内：`recover(auto)` → 预检 → **重读账本重算** → 比**语义指纹**
//           → 验签解包 → `derivePlan` → `runTransaction`。
//   指纹比的是「用户看到并同意的那件事」（图、退役集、root 写/删），
//   不是整份 plan —— generation / 时间戳 / stage 路径本来就会变。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { planTargets, assertPlanOk, STATE_DIR } from '../adapters/index.mjs';
import { precheckTarget, assertPrecheckOk } from '../target.mjs';
import { withVerifiedArtifact } from '../artifact.mjs';
import { validatePackManifest, resolvePackInstall, addRequestedBy, conflictMatches, parseRootKey } from '../pack.mjs';
import { withPackErrors } from './pack-errors.mjs';
import { layout, readLedger, nextGeneration, ensureGenerationWatermark } from '../ledger.mjs';
import { derivePlan } from '../plan.mjs';
import { runTransaction, nowUtc } from '../install.mjs';
import { recover } from '../recover.mjs';
import { withOrderedLocks } from './locks.mjs';
import { parseSpec, resolveSpec } from './resolve.mjs';
import { annotations, annotationSuffix } from './output.mjs';
import { stringify } from '../canonical-json.mjs';
import { UsageError, ConflictError, EXIT, classify } from '../exit-codes.mjs';
import { resolveSnapshotForCommand } from './snapshot-access.mjs';
import { preheatForInstall, preheatAssetsFor } from './preheat-run.mjs';
import { prewarmLockfileInputs } from './project-lockfile.mjs';
import {
  allInstallable, assertDiskSpace, confirmAll, detectShadowed, treeBytes, withVerifiedArtifacts,
} from './install.mjs';
import {
  assertEntryTreeIntact, assertLedgerGraphUsable, confirmYes, entryStillMatches,
  graphFingerprint, orphanRootsOf, readTargetLedger,
} from './refgraph.mjs';

const ALL_PREFIX = 'all@snapshot:';

// ════════════════════════════════════════════════════════════════════════════
// 选 root
// ════════════════════════════════════════════════════════════════════════════

/**
 * 把一条 spec 编译成「匹配 root」的谓词。
 *
 * · `[skill:|pack:][<ns>/]<name>[@<ver>]` —— 匹配 `direct:` 与 `pack:` root；
 *   `@<ver>` 是**目标版本**（可用来降级），不是筛选条件。
 * · `all@snapshot:<N>` 原文 —— 只匹配那一条 all root。
 *   🔴 不接受裸 `all`：`all` 是一个合法的 skill name，两种读法都说得通就不猜。
 */
export function compileSelector(spec) {
  if (spec.startsWith(ALL_PREFIX)) {
    parseRootKey(spec, `update 的 spec ${spec}`);          // grammar 由 parseRootKey 把关
    return { kind: 'all-root', key: spec, raw: spec, match: (key) => key === spec, version: null };
  }
  const q = parseSpec(spec);
  return {
    kind: 'artifact',
    match: (key, rec) => {
      if (rec.kind === 'all') return false;
      const a = parseRootKey(key).artifact;
      if (q.kind !== null && a.kind !== q.kind) return false;
      if (q.namespace !== null && a.namespace !== q.namespace) return false;
      return a.name === q.name;
    },
    query: q,
    raw: spec,
    version: q.version,
  };
}

/** 选中的 root：`{key, record, targetVersion}`。🔴 一条 spec 命中多个 root 是错误，不猜。 */
export function selectRoots(L, selectors, { all }) {
  const keys = Object.keys(L.roots ?? {}).sort();
  if (all) return keys.map((key) => ({ key, record: L.roots[key], targetVersion: null }));
  const out = new Map();
  for (const s of selectors) {
    const hit = keys.filter((k) => s.match(k, L.roots[k]));
    if (hit.length > 1) {
      throw new UsageError(
        `spec ${s.raw} 在这个 target 的账本里命中了多条 root：\n${hit.map((k) => `    ${k}`).join('\n')}\n`
        + '  不猜 —— 请用更完整的写法（带 namespace / kind 前缀）点名其中一条。',
      );
    }
    for (const k of hit) out.set(k, { key: k, record: L.roots[k], targetVersion: s.version });
  }
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * 账本里记的 `intent`（snake）→ `resolvePackInstall` 要的（camel）。
 *
 * 🔴 两件事都要做对：
 *   ① **字段名要转**（Codex 2026-09-04）——直接把 `no_bundled` 传下去，
 *      `resolvePackInstall` 读到的是 `undefined`，于是 `--no-bundled` 那次安装的
 *      意图在 update 时**静默失效**，bundled 成员会被重新拉回来；
 *   ② **与本次运行的 flag 取并**，并把并集写回新 root 的 intent ——
 *      账本记的是本机历史，历史必须是真的。
 */
export function effectiveIntent(stored, ctx) {
  const noBundled = Boolean(stored?.no_bundled) || Boolean(ctx.noBundled);
  const pre = Boolean(stored?.pre) || Boolean(ctx.pre);
  const allowYanked = Boolean(stored?.allow_yanked) || Boolean(ctx.allowYanked);
  const snake = { no_bundled: noBundled, pre };
  if (allowYanked) snake.allow_yanked = true;
  return { camel: { allowYanked, noBundled, pre }, snake };
}

// ════════════════════════════════════════════════════════════════════════════
// 重解析 + 建图
// ════════════════════════════════════════════════════════════════════════════

/**
 * 一个 target 的事务后二部图。
 *
 * @returns {{postEdges:Map, artifacts:Map, records:Map, retire:string[],
 *            writeRoots:object, removeRoots:string[], changed:string[], rootDiff:Array}}
 */
export function buildPostGraph({ L, selected, resolutions }) {
  const selectedOld = new Set(selected.map((s) => s.key));

  // ① 先把选中 root 的**全部**边摘掉（这正是 update 与 install 的分水岭）
  const postEdges = new Map();
  const artifacts = new Map();
  for (const [n, e] of Object.entries(L.entries ?? {})) {
    const rest = (e.requested_by ?? []).filter((k) => !selectedOld.has(k));
    if (rest.length === 0) continue;                     // 这条 entry 只由选中 root 撑着
    postEdges.set(n, rest);
    artifacts.set(n, e.artifact);
  }

  // ② 叠加新解析结果
  const records = new Map();
  const writeRoots = {};
  const rootDiff = [];
  for (const r of resolutions) {
    writeRoots[r.newKey] = r.rootRecord;
    // 🔴 「有没有变」不能只看 key（Codex 2026-09-04 P1-1）：同一条 root、同一个制品、
    //    同一份成员图，只有 `intent`（no_bundled / pre / allow_yanked）变了时
    //    `changed` 与 `rootDiff` 都是空的 —— diff 会显示「无变化」并提前返回，
    //    于是 `effectiveIntent` 算出来的新意图**永远写不进账本**。
    const before = L.roots?.[r.oldKey] ?? null;
    const intentChanged = r.oldKey === r.newKey
      && before !== null
      && stringify(before.intent ?? null) !== stringify(r.rootRecord.intent ?? null);
    rootDiff.push({
      from: r.oldKey,
      intent_changed: intentChanged,
      kind: r.rootRecord.kind,
      to: r.newKey,
    });
    for (const unit of r.units) {
      const name = unit.record.name;
      const already = artifacts.get(name);
      if (already !== undefined && already !== unit.record.id) {
        // 🔴 判据是「**任意**还留着的 root」，不是「只有 pack root 才算」
        //    （Codex 2026-09-04 P0-2）。一条未被选中的 direct / all root 同样在
        //    要求那个旧制品；把目录换掉要么等于悄悄删掉那条 root，要么让账本说谎。
        const holders = (postEdges.get(name) ?? []).join(', ');
        throw new ConflictError(
          `${name} 换不动：${r.newKey} 现在要 ${unit.record.id}，`
          + `但账本里**没有被本次选中**的 root 仍然锁着 ${already}（${holders}）。\n`
          + '  同一个目录名不能同时是两个制品 —— 出路是把那些 root 一起 update（加进 spec 或用 --all），\n'
          + '  或者先把它们处理掉。🔴 没有泛化的 --force。',
          { telemetryReason: 'version-conflict' },
        );
      }
      const prevRec = records.get(name);
      if (prevRec !== undefined && prevRec.id !== unit.record.id) {
        throw new ConflictError(
          `目录名 ${name} 被本次两条 root 请求成不同的制品：${prevRec.id} 与 ${unit.record.id}。\n`
          + '  它们要落到同一个目录上，谁覆盖谁没有正确答案。',
          { telemetryReason: 'version-conflict' },
        );
      }
      records.set(name, unit.record);
      artifacts.set(name, unit.record.id);
      postEdges.set(name, addRequestedBy(postEdges.get(name) ?? [], r.newKey));
    }
  }

  // ③ 退役：账本里有、事务后一条边都没有
  const retire = Object.keys(L.entries ?? {}).filter((n) => !postEdges.has(n)).sort();

  // ④ 要重写的 entry：制品变了、边变了、或者是新的
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const changed = [...postEdges.keys()].filter((n) => {
    const old = L.entries?.[n];
    if (!old) return true;
    if (old.artifact !== artifacts.get(n)) return true;
    return !same(old.requested_by ?? [], postEdges.get(n));
  }).sort();

  const removeRoots = orphanRootsOf(L, postEdges, Object.keys(writeRoots))
    .filter((k) => !Object.hasOwn(writeRoots, k));
  return { artifacts, changed, postEdges, records, removeRoots, retire, rootDiff, writeRoots };
}

/**
 * §4 第 4 步的 `conflicts`，判据是**事务后的全景**。
 *
 * 🔴 参与判定的 pack **不只是本次换掉的那些**：一条没被选中的 pack root 照样声明着
 *    conflicts，而 update 可能给图里加进它不许共存的东西（Codex 2026-09-04 P1）。
 *    所以调用方必须把 post-state 里**全部** pack root 的 manifest 都交进来。
 *
 * 🔴 update **没有 `--replace` 出路**：要退掉的那一条是用户先前明确装过的，
 *    在一次「升级」里顺手删掉它不是用户表达过的意思。
 */
export function assertNoConflicts(packInfos, artifacts, target) {
  const blocked = [];
  for (const p of packInfos) {
    for (const pat of p.manifest.conflicts) {
      for (const q of packInfos) {
        if (q.record.id === p.record.id) continue;
        if (conflictMatches(pat, q.record.id)) {
          blocked.push({ artifact: q.record.id, name: q.record.name, pack: p.record.id, pattern: pat.raw });
        }
      }
      for (const [name, artifact] of artifacts) {
        if (conflictMatches(pat, artifact)) blocked.push({ artifact, name, pack: p.record.id, pattern: pat.raw });
      }
    }
  }
  if (blocked.length === 0) return;
  throw new ConflictError(
    `${target}：更新之后的状态会违反 pack 声明的 conflicts（03-packs.md §4 第 4 步）：\n`
    + blocked.map((b) => `  ${b.name}（${b.artifact}）命中 ${b.pack} 的 conflicts: ${b.pattern}`).join('\n')
    + '\n  🔴 update 不提供 --replace 出路（在一次升级里顺手删掉你先前装过的东西，'
    + '不是你表达过的意思）——\n     请先 `remove` 掉其中一边，或换一个不冲突的版本。',
    { telemetryReason: 'version-conflict' },
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 命令
// ════════════════════════════════════════════════════════════════════════════

export async function cmdUpdate(ctx, argv, out) {
  const specs = [];
  let isAll = false;
  for (const a of argv) {
    if (a === '--all') { isAll = true; continue; }
    if (a.startsWith('-')) throw new UsageError(`update 不认得 flag ${a}`);
    specs.push(a);
  }
  if (isAll && specs.length) {
    throw new UsageError(`--all 不与显式 spec 混用（多给了：${specs.join(' ')}）。--all 已经含账本里全部 root。`);
  }
  // 09-cli.md §1 写的是 `update [<spec>] | --all` —— 方括号允许省略，所以
  // 「不给 spec」= 更新账本里全部 root。它照样要过 diff 与确认，不是无声全改。
  const all = isAll || specs.length === 0;
  const selectors = specs.map(compileSelector);

  // 🔴 `--snapshot` 在 update 上**拒绝**，不给「合理默认」。
  //    钉一张历史快照能决定「解析到哪个版本」，但决定不了 §4「现在还该不该用」——
  //    那必须查**当前** timestamp 指向的快照（05-lifecycle §4：yanked 阻断更新）。
  //    两者怎么组合规范没写；在这里假装它有意义，会让一条命令看起来过了状态门而其实没过。
  if (ctx.snapshot !== null) {
    throw new UsageError(
      'update 不接受 --snapshot：钉快照决定的是「解析到哪个版本」，'
      + '而 update 还必须过**当前**快照的状态门（yanked 阻断更新，05-lifecycle.md §4）。\n'
      + '  两者怎么组合规范没写 —— 不给「合理默认」。\n'
      + '  要复现某一版请用 `install <name>@<version>`；要回退请用 `recover --from-generation <N>`。',
    );
  }

  // ── 目标解析。🔴 **不传 createMissing**：update 不为没有账本的 target 建目录 ──
  const tplan = planTargets({
    clients: ctx.clients, scope: ctx.scope, home: ctx.home, env: ctx.env, projectRoot: ctx.projectRoot,
  });
  for (const w of tplan.warnings) out.warn(w);
  assertPlanOk(tplan);
  if (ctx.createMissing) out.warn('--create-missing 在 update 上不生效（没有账本的 target 只会被跳过）。');
  if (ctx.replace.length) out.warn('--replace 在 update 上不生效：update 的冲突没有「点名替换」出路（见冲突报错里的说明）。');
  for (const s of tplan.skipped) out.note(`跳过 ${s.client}/${s.scope}：${s.reason} —— ${s.message}`);
  const skippedRows = [...tplan.skipped];

  // ── 联网刷新 + 解析当前快照（🔴 出网只发生在这一段）─────────────────────
  await preheatForInstall(ctx, out);
  const { snapshot: snap, stale, floor, verifier } = await resolveSnapshotForCommand(ctx);
  if (stale) out.warn('timestamp 已过期：本次输出全部按 stale 处理（--allow-stale 已给）');

  // ── 逐 target 读账本、选 root ────────────────────────────────────────────
  const work = [];
  for (const t of tplan.selected) {
    if (!existsSync(t.target)) {
      skippedRows.push({ client: t.client, message: `${t.target} 不存在`, reason: 'no-target', scope: t.scope });
      continue;
    }
    const L = readTargetLedger(t.target);
    if (L === null || Object.keys(L.roots ?? {}).length === 0) {
      skippedRows.push({ client: t.client, message: `${t.target} 没有可更新的 root`, reason: 'no-ledger', scope: t.scope });
      continue;
    }
    assertLedgerGraphUsable(L, `${t.target}/.geoly/ledger.json`);
    const selected = selectRoots(L, selectors, { all });
    if (selected.length === 0) {
      skippedRows.push({ client: t.client, message: `没有 root 匹配 ${specs.join(' ')}`, reason: 'no-match', scope: t.scope });
      out.note(`跳过 ${t.client}/${t.scope}：没有 root 匹配 ${specs.join(' ')}`);
      continue;
    }
    work.push({ L, selected, t });
  }
  if (specs.length && work.length === 0) {
    throw new UsageError(
      `没有任何 target 的账本里有匹配 ${specs.join(' ')} 的 root。\n`
      + '  `skills-hub list --installed` 能看到装了什么；`why <name>` 能看到 root 是哪些。',
      { telemetryReason: 'not-found' },
    );
  }
  if (work.length === 0) {
    out.line('update：没有可更新的 target。');
    return out.emit('update', {
      skipped: skippedRows.map((s) => ({ client: s.client, reason: s.reason, scope: s.scope })),
      snapshot: snap.snapshot, targets: [],
    }, EXIT.OK);
  }

  // ── 第一波：pack 本体的字节（🔴 必须在算图之前 —— 成员集合在它的载荷里）──
  //    收的是 **post-state 里全部 pack root**：选中的（新版本）+ 未选中的（现版本）。
  //    未选中的那批只用于 conflicts 门 —— 少收它们，那道门就只对本次换掉的 pack 生效。
  const byId = new Map(snap.artifacts.map((r) => [r.id, r]));
  const packWanted = new Map();      // id → record
  const newPackFor = new Map();      // `${target}\0${oldKey}` → record
  for (const { L, selected, t } of work) {
    for (const s of selected) {
      const rk = parseRootKey(s.key);
      if (rk.kind !== 'pack') continue;
      const { camel } = effectiveIntent(s.record.intent, ctx);
      const rec = resolveSpec(snap, {
        kind: 'pack', name: rk.artifact.name, namespace: rk.artifact.namespace,
        raw: s.key, version: s.targetVersion,
      }, { allowYanked: camel.allowYanked, pre: camel.pre });
      packWanted.set(rec.id, rec);
      newPackFor.set(`${t.target}\u0000${s.key}`, rec);
    }
    // 未选中的 pack root：拿它**当前**那一版的 record（conflicts 门要它的 manifest）
    for (const key of Object.keys(L.roots)) {
      if (selected.some((s) => s.key === key)) continue;
      if (parseRootKey(key).kind !== 'pack') continue;
      const rec = byId.get(L.roots[key].artifact);
      if (rec === undefined) {
        throw new ConflictError(
          `${t.target}：账本里的 pack root ${key} 不在当前快照 ${snap.snapshot} 里，`
          + '因此拿不到它的 conflicts 声明 —— 无法证明更新之后的状态不违反它。\n'
          + '  🔴 拒绝，不做「尽力而为」。出路：把它也一起 update（`--all`），或先 remove 掉。',
          { telemetryReason: 'not-found' },
        );
      }
      packWanted.set(rec.id, rec);
    }
  }
  await preheatAssetsFor(ctx, [...packWanted.values()], snap);
  const packManifests = new Map();
  for (const rec of packWanted.values()) {
    const bytes = ctx.registry.fetchAsset(rec);
    packManifests.set(rec.id, withPackErrors(() => withVerifiedArtifact(
      { bytes, record: rec }, (art) => validatePackManifest(art.manifest),
    )));
  }

  // ── 建图（逐 target）─────────────────────────────────────────────────────
  const at = nowUtc(ctx.now());
  const previews = [];
  for (const w of work) {
    const { L, selected, t } = w;
    const resolutions = [];
    for (const s of selected) {
      const rk = parseRootKey(s.key);
      const { camel, snake } = effectiveIntent(s.record.intent, ctx);
      if (rk.kind === 'all') {
        const recs = allInstallable(snap, t.client);
        const newKey = `${ALL_PREFIX}${snap.snapshot}`;
        resolutions.push({
          isAllRoot: true,
          newKey,
          oldKey: s.key,
          // 🔴 `all` root 不带 artifact / tree_digest（04-install.md §4 的 root-key grammar），
          //    且它的 intent 里那两个 flag 在 `--all` 上本就不生效，一律写 false。
          rootRecord: {
            intent: { no_bundled: false, pre: false }, kind: 'all',
            requested_at: newKey === s.key ? s.record.requested_at : at, snapshot: snap.snapshot,
          },
          units: recs.map((record) => ({ record })),
        });
        continue;
      }
      // （`direct:` root 只能指向 skill 这一条，已由 `assertLedgerGraphUsable`
      //   的顶点标签闭合门在**消费之前**挡掉，并落在正确的 2 上 —— 这里不再重复判，
      //   免得同一条规则有两处实现、两处可以分叉。）
      const rec = rk.kind === 'pack'
        ? newPackFor.get(`${t.target}\u0000${s.key}`)
        : resolveSpec(snap, {
          kind: rk.artifact.kind, name: rk.artifact.name, namespace: rk.artifact.namespace,
          raw: s.key, version: s.targetVersion,
        }, { allowYanked: camel.allowYanked, pre: camel.pre });
      if (rec.status === 'yanked') out.warn(`🔴 ${rec.id} 已被 yank，仍按 --allow-yanked 更新（会写进账本）`);
      if (rec.status === 'deprecated') out.warn(`${rec.id} 的状态是 deprecated`);
      // §4 第 3 步的 client 门：点名的东西装不上是**硬错误**
      if (rec.clients.length > 0 && !rec.clients.includes(t.client)) {
        throw new ConflictError(
          `${rec.id} 未声明支持 client=${t.client}（声明的是 ${rec.clients.join(', ') || '(空)'}）`,
          { telemetryReason: 'unsupported-client' },
        );
      }
      const newKey = rk.kind === 'pack' ? rec.id : `direct:${rec.id}`;
      const units = rk.kind === 'pack'
        ? withPackErrors(() => resolvePackInstall({
          client: null, intent: camel, lookup: (id) => byId.get(id),
          manifest: packManifests.get(rec.id), packRecord: rec,
        })).install.map((m) => ({ record: m.record }))
        : [{ record: rec }];
      resolutions.push({
        newKey,
        oldKey: s.key,
        rootRecord: {
          artifact: rec.id, intent: snake, kind: rk.kind,
          requested_at: newKey === s.key ? s.record.requested_at : at,
          snapshot: snap.snapshot, tree_digest: rec.tree_digest,
        },
        units,
      });
    }

    const g = buildPostGraph({ L, resolutions, selected });

    // conflicts：post-state 里全部 pack root 的 manifest 一起判
    const postPackIds = new Set(Object.entries(g.writeRoots)
      .filter(([k]) => parseRootKey(k).kind === 'pack').map(([, r]) => r.artifact));
    for (const [key, r] of Object.entries(L.roots)) {
      if (g.removeRoots.includes(key) || Object.hasOwn(g.writeRoots, key)) continue;
      if (parseRootKey(key).kind === 'pack') postPackIds.add(r.artifact);
    }
    assertNoConflicts(
      [...postPackIds].sort().map((id) => ({ manifest: packManifests.get(id), record: packWanted.get(id) })),
      g.artifacts, t.target,
    );

    // 🔴 要退役（= 会被删掉）的目录必须**逐字节**还是账本声称的那棵树。
    //    只查「在不在」的话，`derivePlan` 的 retire-only 会对当前磁盘内容重算
    //    `old_digest`，于是被外部改过的目录照样归档删除、命令还返回 0
    //    （Codex 2026-09-04 P0）。顺带把「目录缺席」落成 2 而不是内核的 5。
    for (const n of g.retire) assertEntryTreeIntact(t.target, n, L.entries[n].tree_digest, t.target);

    previews.push({ ...w, fingerprint: fingerprintOf(g), g, resolutions });
  }

  // ── §8.2 遮蔽：项目级下**新增**的名字才查（既有的在装它的时候查过了）──────
  const shadowInfo = new Map();
  if (ctx.scope === 'project') {
    for (const { g, L, t } of previews) {
      const fresh = g.changed.filter((n) => !Object.hasOwn(L.entries, n));
      const d = detectShadowed(fresh, { client: t.client, env: ctx.env, home: ctx.home });
      shadowInfo.set(t.client, d);
      if (d.shadowed.length && !ctx.shadowGlobal) {
        throw new ConflictError(
          `全局已存在同名 skill：${d.shadowed.join(', ')}（在 ${d.globalTarget}）。\n`
          + '  本次 update 会在项目级**新增**它们，而项目级/全局的优先级未知（04-install.md §8.2 / D4）。\n'
          + '  明确接受这个歧义请给 --shadow-global。',
          { telemetryReason: 'version-conflict' },
        );
      }
    }
  }

  // ── diff + 确认 ─────────────────────────────────────────────────────────
  const diffs = previews.map(({ g, L, t }) => ({ diff: describeDiff(g, L), g, t }));
  const lines = [`update（快照 ${snap.snapshot}）：`];
  for (const { diff, t } of diffs) {
    lines.push(`  ${t.client}/${t.scope}  ${t.target}`);
    if (diff.rows.length === 0) lines.push('      （无变化）');
    for (const r of diff.rows) lines.push(`      ${r}`);
  }
  const touched = diffs.filter((d) => d.diff.rows.length > 0);
  if (touched.length === 0) {
    for (const l of lines) out.line(l);
    out.line('update：全部 root 都已经是当前快照解析出来的结果，什么都不用做。');
    return out.emit('update', {
      skipped: skippedRows.map((s) => ({ client: s.client, reason: s.reason, scope: s.scope })),
      snapshot: snap.snapshot,
      targets: diffs.map(({ diff, t }) => ({
        annotations: annotations({ offline: ctx.offline, stale }),
        changed: false, client: t.client, diff, ok: true, scope: t.scope, target: t.target,
      })),
    }, EXIT.OK);
  }

  // 🔴 `all@snapshot` root 推到当前快照 = **当前全量集合**，必须过 09-cli.md §3
  //    的强确认（非交互下 `--yes-i-really-want-everything`，`--yes` 不够）。
  //    旧 root 绑的是**那张旧快照**里的名单，不是「对未来新增的任意 skill 的永久授权」
  //    （Codex 2026-09-04 P1）。
  // 🔴 判据是「这条 all root **真的动了**」，不是「这个 target 上有 all root」
  //    （Codex 2026-09-04 P2-2）。快照没变时它解析出来的名单逐字节相同、
  //    不可能扩张 —— 那时再要一次全量确认只是白让人多敲一遍。
  const allRootTargets = previews.filter(
    (p) => p.resolutions.some((r) => r.isAllRoot && r.newKey !== r.oldKey));
  if (allRootTargets.length) {
    const union = new Map();
    for (const p of allRootTargets) {
      for (const r of p.resolutions) if (r.isAllRoot) for (const u of r.units) union.set(u.record.id, u.record);
    }
    const list = [...union.values()].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
    out.warn(`本次会把 ${allRootTargets.map((p) => p.t.client).join(', ')} 的 \`all@snapshot\` root `
      + `推到快照 ${snap.snapshot} 的**当前全量集合** —— 走 09-cli.md §3 的全量确认。`);
    await confirmAll(ctx, out, list);
  }
  await confirmYes(ctx, out, { lines, question: `确认应用以上更新（${touched.length} 个 target）？` });

  // ── 第二波：真正会落盘的字节。🔴 也必须在取锁之前 ────────────────────────
  //    「需要字节」= 目录缺席，或磁盘上那棵树已经不是目标 `tree_digest`。
  //    完全相同的那些走 `adopt_assertions`（ledger-only），一个字节都不用取。
  for (const p of previews) p.needBytes = namesNeedingBytes(p.t.target, p.g);
  const unitRecords = new Map();
  for (const p of previews) for (const n of p.needBytes) unitRecords.set(p.g.records.get(n).id, p.g.records.get(n));
  await preheatAssetsFor(ctx, [...unitRecords.values()], snap);

  // ── 项目级 lockfile：提交之前先把要用到的历史快照读回来并验签 ─────────────
  let hook;
  if (ctx.scope === 'project') {
    const needs = [];
    for (const p of previews) {
      for (const n of p.g.changed) {
        needs.push({ artifact: p.g.artifacts.get(n), snapshot: p.g.records.has(n) ? snap.snapshot : p.L.entries[n].snapshot });
      }
    }
    hook = await prewarmLockfileInputs(ctx, {
      current: snap, needs, ours: previews.map((p2) => p2.t.target), out, verifier,
    });
  }

  // ── 取锁：repo → target（全序）──────────────────────────────────────────
  const results = [];
  const t0 = Date.now();
  withOrderedLocks(
    {
      baseFor: (path) => tplan.selected.find((t) => t.target === path)?.base ?? null,
      projectRoot: ctx.scope === 'project' ? ctx.projectRoot : null,
      targets: previews.map((p) => p.t.target),
    },
    ({ targets: ordered }) => {
      const byPath = new Map(previews.map((p) => [p.t.target, p]));
      for (const o of ordered) {
        const p = byPath.get(o.path);
        const started = Date.now();
        try {
          // 🔴 §3.5 识别范围 ① 要「本次命令的**全部** target」，不是「自己」（见 install.mjs 同处）
          const r = updateOneTarget(ctx, p, {
            at, floor, hook, out, snap, targetSet: previews.map((q) => q.t.target),
          });
          results.push({ ...r, client: p.t.client, ms: Date.now() - started, ok: true, scope: p.t.scope, target: p.t.target });
        } catch (err) {
          const cls = classify(err);
          results.push({
            _err: err, client: p.t.client, error: err.message, exit_code: cls.code,
            ms: Date.now() - started, ok: false, reason: cls.reason, scope: p.t.scope, target: p.t.target,
          });
        }
      }
    },
  );

  emitTelemetry(ctx, results, previews);

  // ── §7：逐 target 结果表 ─────────────────────────────────────────────────
  out.line(`update 结果（快照 ${snap.snapshot}，共 ${results.length} 个 target）：`);
  for (const r of results) {
    const p = previews.find((x) => x.t.target === r.target);
    // 🔴 `degraded` **要真的算**，不能写死 false（§7：stale / offline / yanked /
    //    degraded / shadowed 必须在每一次相关输出里重复标注）。写死等于「这道标注
    //    看起来在，实际上永远不亮」。
    //    覆盖面是 post-state 的**两类**：物化下来的 entry（记录在 g.records），
    //    以及 root artifact —— 🔴 `degraded` 是 **pack** 的状态，而 pack 根本不
    //    作为目录物化，只看 entry 的话恰好把它漏光（04-install.md §8.1「当前状态门」
    //    的覆盖面是同一条道理）。
    const a = annotations({
      degraded: p ? statusHit(p, byId, 'degraded') : false,
      offline: ctx.offline,
      shadowed: (shadowInfo.get(r.client)?.shadowed.length ?? 0) > 0,
      stale,
      yanked: p ? statusHit(p, byId, 'yanked') : false,
    });
    r.annotations = a;
    out.line(`  ${r.ok ? 'ok      ' : 'failed  '}${r.client}/${r.scope}  ${r.target}${annotationSuffix(a)}`);
    if (!r.ok) out.line(`          ${r.error.split('\n')[0]}`);
    else out.line(`          第 ${r.generation} 代，改了 ${r.changed.join(', ') || '(无)'}；退役 ${r.retired.join(', ') || '(无)'}`);
  }

  const failed = results.filter((r) => !r.ok);
  let exit = EXIT.OK;
  if (failed.length === results.length && failed.length > 0) exit = classify(failed[0]._err).code;
  else if (failed.length > 0) exit = EXIT.PARTIAL;

  const body = {
    duration_ms: Date.now() - t0,
    skipped: skippedRows.map((s) => ({ client: s.client, reason: s.reason, scope: s.scope })),
    snapshot: snap.snapshot,
    targets: results.map((r) => {
      const p = previews.find((x) => x.t.target === r.target);
      return {
        annotations: r.annotations,
        changed: r.ok ? r.changed : undefined,
        client: r.client,
        diff: p ? describeDiff(p.g, p.L) : undefined,
        error: r.ok ? undefined : r.error,
        exit_code: r.ok ? 0 : r.exit_code,
        generation: r.ok ? r.generation : undefined,
        ok: r.ok,
        retired: r.ok ? r.retired : undefined,
        scope: r.scope,
        target: r.target,
      };
    }),
  };
  if (exit !== EXIT.OK && exit !== EXIT.PARTIAL) {
    return out.emitError('update', classify(failed[0]._err), failed[0]._err, body);
  }
  return out.emit('update', body, exit);
}

// ════════════════════════════════════════════════════════════════════════════
// 单 target
// ════════════════════════════════════════════════════════════════════════════

function fingerprintOf(g) {
  return graphFingerprint({
    artifacts: g.artifacts, postEdges: g.postEdges, removeRoots: g.removeRoots,
    retire: g.retire, writeRoots: g.writeRoots,
  });
}

/** 哪些名字**真的**需要新字节：目录缺席，或磁盘上那棵树已经不是目标 `tree_digest`。 */
export function namesNeedingBytes(target, g) {
  return g.changed.filter((n) => {
    const rec = g.records.get(n);
    if (rec === undefined) return false;                   // 只改了边，没换制品
    return !entryStillMatches(target, n, rec.tree_digest).ok;
  }).sort();
}

/** 单个 target 的第 2–10 步。🔴 全同步 —— 它在锁与事务里面，不能 await。 */
function updateOneTarget(ctx, p, { at, floor, hook, out, snap, targetSet }) {
  const target = p.t.target;
  const P0 = layout(target);

  // ── 第 2 步：残留事务分流 ────────────────────────────────────────────────
  const rec = recover(target, { keepGenerations: ctx.keepGenerations, mode: 'auto', onLedgerChanged: hook });
  if (rec.outcome !== 'nothing') out.note(`${p.t.client}：入口分流 —— ${rec.outcome}`);

  // ── 第 3 步：预检 ───────────────────────────────────────────────────────
  assertPrecheckOk(
    precheckTarget(target, { base: p.t.base, targetSet: targetSet ?? [target], scan: ctx.scan }),
  );

  // 🔴 **锁内重读重算，比语义指纹**。预览是在没有任何锁的时候读的；
  //    从那时到现在，另一个进程（乃至上面那次 recover）完全可以改掉这张图。
  const L = readLedger(P0.ledger);
  assertLedgerGraphUsable(L, `${target}/.geoly/ledger.json`);
  // 🔴 **不能把「已经不在账本里的 root」过滤掉再继续**（自查时抓到的缝）：
  //    那样 `selectedOld` 变小 → 它的边本来就已经没了 → postEdges 不变，
  //    而 `resolutions` 仍然带着那条 root 的解析结果 → `writeRoots` 把它**重新建回来**，
  //    指纹却**恰好相等**。净效果是：别人刚 remove 掉的东西被这次 update 悄悄装回去。
  //    判据必须是「本次选中的每一条 root 现在都还在」，缺一条就中止。
  const gone = p.selected.filter((s) => !Object.hasOwn(L.roots, s.key)).map((s) => s.key);
  if (gone.length) {
    throw new UsageError(
      `${target}：本次要更新的 root 在确认之后已经不在账本里了（${gone.join(', ')}）。`
      + '什么都没做 —— 请重跑 update。',
      { telemetryReason: 'version-conflict' },
    );
  }
  const g = buildPostGraph({ L, resolutions: p.resolutions, selected: p.selected });
  if (fingerprintOf(g) !== p.fingerprint) {
    throw new UsageError(
      `${target}：账本在确认之后被改动了（引用图与你看到的那份不一致）。什么都没做 —— 请重跑 update。`,
      { telemetryReason: 'version-conflict' },
    );
  }

  // 🔴 没准备字节的那些，必须**现在**仍然与目标摘要严格相符。
  //    不查的话，磁盘在确认期间被改过时 `derivePlan` 会构造一个物理 swap，
  //    然后 `stageTrees` 报「没有可 stage 的源目录」—— 一条看不出所以然的内核错。
  const need = new Set(p.needBytes);
  for (const n of g.changed) {
    if (need.has(n)) continue;
    const digest = g.records.has(n) ? g.records.get(n).tree_digest : L.entries[n].tree_digest;
    const m = entryStillMatches(target, n, digest);
    if (!m.ok) {
      throw new UsageError(
        `${target}/${n} 在确认之后变了（${m.why}）：本次没有为它准备字节，无法继续。请重跑 update。`,
        { telemetryReason: 'digest-mismatch' },
      );
    }
  }
  for (const n of g.retire) assertEntryTreeIntact(target, n, L.entries[n].tree_digest, target);

  // 🔴 §4.2：新增的名字撞上一个**未被账本认领**的同名目录。
  //    不先判的话 `derivePlan` 会 `bad()` → `Corrupt` → 落**退出码 5（需要 recover）**，
  //    而这在语义上是**冲突未解决（3）**：没有任何残留事务，recover 无事可做。
  //    `commands/install.mjs` 在同一格做的是同一件事（也是同一条理由）。
  //    ⚠️ update **不接** `--replace`：那条 flag 的语义是「点名替换未认领目录」，
  //    而一次升级里冒出来的新成员并不是用户点名过的东西。
  for (const n of g.changed) {
    if (Object.hasOwn(L.entries, n)) continue;                 // 已认领的不在这一格
    if (!existsSync(join(target, n))) continue;
    throw new ConflictError(
      `${join(target, n)} 是一个**未被账本认领**的同名目录，而本次 update 要往那里装 `
      + `${g.artifacts.get(n)}：默认阻断（04-install.md §4.2）。\n`
      + '  🔴 update 不提供 --replace 出路（那条 flag 是「点名替换」，'
      + '而这个目录是升级过程中冒出来的新成员撞上的，你并没有点过它的名）。\n'
      + '  请自行把它移走，或先 `install` 那个制品并用 `--replace` 明确点名。',
      { telemetryReason: 'version-conflict' },
    );
  }

  // ── 第 4 步：取字节 → 验签/验资产/解包/manifest 绑定 ────────────────────
  const items = p.needBytes.map((n) => ({ name: n, record: g.records.get(n) }))
    .map((x) => ({ ...x, bytes: ctx.registry.fetchAsset(x.record) }));

  return withVerifiedArtifacts(items, join(target, STATE_DIR), (verified) => {
    assertDiskSpace(target, verified.reduce((n, v) => n + treeBytes(v.art.dir), 0));
    const srcOf = new Map(verified.map((v) => [v.name, v.art.dir]));

    ensureGenerationWatermark(P0);
    const generation = nextGeneration(P0);

    const install = g.changed.map((n) => {
      const record = g.records.get(n);
      const old = L.entries[n];
      return {
        artifact: g.artifacts.get(n),
        installed_at: at,
        name: n,
        requested_by: g.postEdges.get(n),
        // 制品换了 ⇒ 它是从**当前**快照解析出来的；只改了边 ⇒ 沿用原来的解析出处
        snapshot: record ? snap.snapshot : old.snapshot,
        srcDir: srcOf.get(n),
        tree_digest: record ? record.tree_digest : old.tree_digest,
      };
    });

    const plan = derivePlan({
      generation,
      install,
      ledger: L,
      ledgerExisted: true,
      removeRoots: g.removeRoots,
      replace: new Set(),
      retire: g.retire,
      roots: g.writeRoots,
      target,
    });

    // 🔴 R-9：提交点之前的最后一刻复验 trust floor。`floor` 必须**显式**给。
    runTransaction(target, plan, {
      floor: floor === null ? null : { expected: floor, stateDir: ctx.stateDir },
      keepGenerations: ctx.keepGenerations,
      now: at,
      onLedgerChanged: hook,
    });
    return { changed: g.changed, generation, retired: g.retire, rootDiff: g.rootDiff };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// diff 的人类/机器表示
// ════════════════════════════════════════════════════════════════════════════

/**
 * post-state 里有没有落在某个状态上的制品。
 *
 * 🔴 两类都要看：**entry**（会物化成目录）与 **root artifact**（pack 不物化，
 *    而 `degraded` 恰恰只属于 pack）。只看其中一类，那道标注就永远不亮。
 */
export function statusHit(p, byId, status) {
  for (const rec of p.g.records.values()) if (rec.status === status) return true;
  for (const r of Object.values(p.g.writeRoots)) {
    if (r.artifact && byId.get(r.artifact)?.status === status) return true;
  }
  for (const [key, r] of Object.entries(p.L.roots ?? {})) {
    if (p.g.removeRoots.includes(key) || Object.hasOwn(p.g.writeRoots, key)) continue;
    if (r.artifact && byId.get(r.artifact)?.status === status) return true;
  }
  return false;
}

export function describeDiff(g, L) {
  const added = [], changed = [], edges = [], removed = [];
  for (const n of g.changed) {
    const old = L.entries?.[n];
    if (!old) { added.push({ artifact: g.artifacts.get(n), name: n }); continue; }
    if (old.artifact !== g.artifacts.get(n)) {
      changed.push({ from: old.artifact, name: n, to: g.artifacts.get(n) });
      continue;
    }
    edges.push({ from: old.requested_by, name: n, to: g.postEdges.get(n) });
  }
  for (const n of g.retire) removed.push({ artifact: L.entries[n].artifact, name: n });

  const rows = [];
  for (const r of g.rootDiff) {
    if (r.from !== r.to) rows.push(`root      ${r.from}  →  ${r.to}`);
    else if (r.intent_changed) rows.push(`intent    ${r.from}（root 不变，安装意图变了）`);
  }
  for (const x of changed) rows.push(`changed   ${x.name.padEnd(28)}${x.from}  →  ${x.to}`);
  for (const x of added) rows.push(`added     ${x.name.padEnd(28)}${x.artifact}`);
  for (const x of removed) rows.push(`removed   ${x.name.padEnd(28)}${x.artifact}（目录会被退役，旧树进 attic）`);
  for (const x of edges) rows.push(`edges     ${x.name.padEnd(28)}${x.from.join(',')}  →  ${x.to.join(',')}`);
  for (const k of g.removeRoots) rows.push(`root-gone ${k}（事务后没有任何 entry 指向它）`);
  return { added, changed, edges, removed, root_changes: g.rootDiff, rows };
}

function emitTelemetry(ctx, results, previews) {
  const rec = ctx.record;
  if (!rec) return;
  for (const r of results) {
    const p = previews.find((x) => x.t.target === r.target);
    const recs = [...(p?.g.records.values() ?? [])];
    if (recs.length === 0) {
      rec({ client: r.client, kind: 'update', ms: r.ms, reason: r.ok ? undefined : r.reason, result: r.ok ? 'ok' : 'failed', scope: r.scope });
      continue;
    }
    for (const a of recs) {
      rec({
        artifact: a.id, client: r.client, kind: 'update', ms: r.ms,
        reason: r.ok ? undefined : r.reason, result: r.ok ? 'ok' : 'failed',
        scope: r.scope, version: a.version,
      });
    }
  }
}
