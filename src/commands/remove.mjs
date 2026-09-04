// `remove <name>` —— 09-cli.md §1：「**减引用；为空才删目录**」。
//
// 这条命令的全部难点在那六个字上：一个目录可能被好几个 root 请求
// （用户直接装的 + 一个 pack 带进来的），`why <name>` 回答的正是这个。
// 🔴 **只有引用归零才删目录。**
//
// 取锁（04-install.md §5.1 的取锁表）：
//   `remove` = repo 锁（仅项目级）+ 全部 target 锁，**不取 metadata 锁**。
//   因此本命令**完全不解析当前快照、不出网** —— 减一条引用不需要知道
//   「现在最新是哪一版」。项目级 lockfile 重算要的 `asset_sha256` 从
//   **缓存里的历史快照**取（与 `sync-lock` 同一条路径，逐份独立验签）。
//
// 🔴 **`<name>` 只接受 entry 目录名**（规范写的就是 `remove <name>`）。
//    删掉一整条 pack / `all@snapshot` root 是另一种影响面大得多的操作，
//    规范里没有它的语法 —— 不在这里偷塞一个进去。
//    后果如实记在交付汇报里：**pack 成员目前删不掉**（它的引用永远不归零）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { planTargets, assertPlanOk } from '../adapters/index.mjs';
import { precheckTarget, assertPrecheckOk } from '../target.mjs';
import { layout, readLedger, nextGeneration, ensureGenerationWatermark } from '../ledger.mjs';
import { derivePlan } from '../plan.mjs';
import { runTransaction, nowUtc } from '../install.mjs';
import { recover } from '../recover.mjs';
import { parseSafeRelPath } from '../safe-fs.mjs';
import { withOrderedLocks } from './locks.mjs';
import { annotations, annotationSuffix } from './output.mjs';
import { UsageError, EXIT, classify } from '../exit-codes.mjs';
import { getVerifier } from './snapshot-access.mjs';
import { prewarmLockfileInputs } from './project-lockfile.mjs';
import {
  assertEntryTreeIntact, assertLedgerGraphUsable, confirmYes, directRootKeyFor,
  graphFingerprint, orphanRootsOf, readTargetLedger,
} from './refgraph.mjs';

/**
 * 一个 target 上「减掉 `name` 的 direct 引用」之后的图。
 *
 * @returns {null | {name, entry, dropRoot, keep:boolean, postEdges:Map, retire:string[],
 *                   removeRoots:string[], artifacts:Map}}
 *          `null` = 这个 target 上没有这条 entry（skipped，算成功）
 */
export function planRemoval(L, name, target) {
  const entry = L.entries?.[name];
  if (!entry) return null;

  // 🔴 判据是「root key == `direct:` + entry 的 artifact」，不是「root 的 name 等于目录名」。
  //    只比名字的话，一张已经错了的账本（entry 记 x@1、却挂着请求 x@2 的 direct root）
  //    会在这里被静默「修正」—— 那是替坏账本圆谎。
  const dropRoot = directRootKeyFor(entry);
  const has = (entry.requested_by ?? []).includes(dropRoot);
  if (!has) {
    throw new UsageError(
      `${target}：${name} 上没有可减的**直接**引用 —— 它由下面这些 root 请求：\n`
      + (entry.requested_by ?? []).map((k) => `    ${k}`).join('\n') + '\n'
      + '  「减引用」减的是**你自己那一条**（`direct:<artifact>`）；'
      + 'pack / `all@snapshot` 带进来的成员不由它决定去留。\n'
      + '  🔴 规范只给了 `remove <name>` 这一种语法（09-cli.md §1），'
      + '没有「删掉整条 pack root」的入口 —— 本 CLI 不自己发明一个。\n'
      + `  想看清楚谁在要它：\`skills-hub why ${name}\`。`,
      { telemetryReason: 'version-conflict' },
    );
  }

  // 🔴 direct root 按构造只指向它自己那一个 entry。真有别的 entry 也指着它 ——
  //    那是一张我们不认识的图，删掉这条 root 会造出悬挂边。如实拒绝，不「顺手修」。
  const alsoWanted = Object.entries(L.entries)
    .filter(([n, e]) => n !== name && (e.requested_by ?? []).includes(dropRoot))
    .map(([n]) => n);
  if (alsoWanted.length) {
    const e = new UsageError(
      `${target}：root ${dropRoot} 同时被 ${alsoWanted.join(', ')} 引用 —— `
      + 'direct root 按构造只指向它自己那一个 entry，这张图不自洽。拒绝改它。',
      { telemetryReason: 'ledger-corrupt' },
    );
    e.exitCode = EXIT.INTEGRITY;
    throw e;
  }

  const remaining = (entry.requested_by ?? []).filter((k) => k !== dropRoot);
  const keep = remaining.length > 0;

  // 事务后的完整边集（只有这一条 entry 变了）
  const postEdges = new Map();
  const artifacts = new Map();
  for (const [n, e] of Object.entries(L.entries)) {
    if (n === name) continue;
    postEdges.set(n, [...(e.requested_by ?? [])]);
    artifacts.set(n, e.artifact);
  }
  if (keep) { postEdges.set(name, remaining); artifacts.set(name, entry.artifact); }

  const retire = keep ? [] : [name];
  // 🔴 要删的目录必须**逐字节**还是账本声称的那棵树 —— 只查「在不在」的话，
  //    `derivePlan` 会对当前磁盘内容重算 `old_digest`，于是一棵被外部改过的目录
  //    照样被归档删除、命令还返回 0（Codex 2026-09-04 P0）。
  if (!keep) assertEntryTreeIntact(target, name, entry.tree_digest, target);
  const removeRoots = orphanRootsOf(L, postEdges);
  return { artifacts, dropRoot, entry, keep, name, postEdges, removeRoots, retire };
}

export async function cmdRemove(ctx, argv, out) {
  const names = [];
  for (const a of argv) {
    if (a.startsWith('-')) throw new UsageError(`remove 不认得 flag ${a}`);
    names.push(a);
  }
  if (names.length !== 1) {
    throw new UsageError('用法：skills-hub remove <name>（恰好一个目录名）。\n'
      + '  🔴 `<name>` 是**磁盘上的目录名**（= 制品的 name），不是 spec、也不是 root key。');
  }
  const name = names[0];
  // 目录名必须过路径 grammar —— 与 derivePlan 的 `claim()` 同一道门，早一步报
  try { parseSafeRelPath(name); } catch (e) { throw new UsageError(`remove 的 <name> 不合法：${e.message}`); }

  // ── 目标解析。🔴 **不传 createMissing**：remove 没有理由建出任何目录 ─────────
  const tplan = planTargets({
    clients: ctx.clients, scope: ctx.scope, home: ctx.home, env: ctx.env, projectRoot: ctx.projectRoot,
  });
  for (const w of tplan.warnings) out.warn(w);
  assertPlanOk(tplan);
  if (ctx.createMissing) {
    out.warn('--create-missing 在 remove 上不生效（没有账本的 target 只会被跳过，不会被创建）。');
  }
  for (const s of tplan.skipped) out.note(`跳过 ${s.client}/${s.scope}：${s.reason} —— ${s.message}`);
  const skippedRows = [...tplan.skipped];

  // ── 预览（锁外，只读）─────────────────────────────────────────────────────
  const previews = [];
  for (const t of tplan.selected) {
    if (!existsSync(t.target)) {
      skippedRows.push({ client: t.client, scope: t.scope, reason: 'no-target', message: `${t.target} 不存在` });
      continue;
    }
    const L = readTargetLedger(t.target);
    if (L === null) {
      skippedRows.push({ client: t.client, scope: t.scope, reason: 'no-ledger', message: `${t.target} 没有账本` });
      continue;
    }
    assertLedgerGraphUsable(L, `${t.target}/.geoly/ledger.json`);
    const p = planRemoval(L, name, t.target);
    if (p === null) {
      skippedRows.push({ client: t.client, scope: t.scope, reason: 'not-installed', message: `${name} 不在 ${t.target} 的账本里` });
      out.note(`跳过 ${t.client}/${t.scope}：${name} 不在它的账本里`);
      continue;
    }
    previews.push({ t, L, p, fingerprint: fingerprintOf(p) });
  }

  if (previews.length === 0) {
    out.line(`remove ${name}：没有任何被检查的 target 装着它。`);
    return out.emit('remove', {
      name,
      removed: [],
      skipped: skippedRows.map((s) => ({ client: s.client, reason: s.reason, scope: s.scope })),
      targets: [],
    }, EXIT.OK);
  }

  // ── 确认：🔴 只有**真的会删目录**时才问；只减一条边不问 ────────────────────
  const willDelete = previews.filter((x) => !x.p.keep);
  const lines = [`remove ${name}：`];
  for (const { t, p } of previews) {
    lines.push(p.keep
      ? `  ${t.client}/${t.scope}  ${t.target}\n      只减引用 —— 减掉 ${p.dropRoot} 之后还剩：${p.postEdges.get(name).join(', ')}，**目录保留**`
      : `  ${t.client}/${t.scope}  ${t.target}\n      引用归零 —— 🔴 **会删掉目录** ${join(t.target, name)}（旧树先进 attic，可 recover --from-generation 复位）`);
  }
  if (willDelete.length > 0) {
    await confirmYes(ctx, out, { lines, question: `确认删除 ${willDelete.length} 个目录？` });
  } else {
    for (const l of lines) out.line(l);
    out.line('  （本次不会删除任何目录，只改账本的引用边）');
  }

  // ── 项目级 lockfile：🔴 **在提交之前**先把要用到的历史快照读回来并验签 ─────
  //    钩子是在 `runCleanup()` 末尾调的，那时 journal 都清了、recover 无事可做
  //    （sync-lock.mjs 里明写着这是 R-11 的已知非原子缺口）。
  //    缓存缺一张历史快照就会在那一刻炸 —— 事务已提交、lockfile 却是旧的。
  //    预热挡不住所有情况（磁盘中途坏掉仍然会），但**能把最常见的一格
  //    「缓存里根本没有那张快照」搬到还没动手的时候**。
  let hook;
  if (ctx.scope === 'project') {
    const verifier = await getVerifier(ctx);
    // remove 只减引用，不引入任何新的 (artifact, snapshot) 组合 —— 预热的并集
    // 全部来自各 target 账本里现有的 entry（prewarm 自己会去收）。
    hook = await prewarmLockfileInputs(ctx, {
      needs: [], ours: previews.map((x) => x.t.target), out, verifier,
    });
  }

  // ── 取锁：repo → target（全序）──────────────────────────────────────────
  const results = [];
  const t0 = Date.now();
  withOrderedLocks(
    {
      baseFor: (path) => tplan.selected.find((t) => t.target === path)?.base ?? null,
      projectRoot: ctx.scope === 'project' ? ctx.projectRoot : null,
      targets: previews.map((x) => x.t.target),
    },
    ({ targets: ordered }) => {
      const byPath = new Map(previews.map((x) => [x.t.target, x]));
      for (const o of ordered) {
        const pv = byPath.get(o.path);
        const started = Date.now();
        try {
          const r = removeOneTarget(ctx, pv, { name, hook, out });
          results.push({ ...r, client: pv.t.client, ok: true, ms: Date.now() - started, scope: pv.t.scope, target: pv.t.target });
        } catch (err) {
          const cls = classify(err);
          results.push({
            client: pv.t.client, error: err.message, exit_code: cls.code, ms: Date.now() - started,
            ok: false, reason: cls.reason, scope: pv.t.scope, target: pv.t.target, _err: err,
          });
        }
      }
    },
  );

  emitTelemetry(ctx, results, previews);

  // ── §7：逐 target 结果表 ─────────────────────────────────────────────────
  out.line(`remove 结果（${name}，共 ${results.length} 个 target）：`);
  for (const r of results) {
    const a = annotations({ offline: ctx.offline });
    r.annotations = a;
    out.line(`  ${r.ok ? 'ok      ' : 'failed  '}${r.client}/${r.scope}  ${r.target}${annotationSuffix(a)}`);
    if (!r.ok) out.line(`          ${r.error.split('\n')[0]}`);
    else if (r.deleted) out.line(`          第 ${r.generation} 代，已删除目录 ${name}（旧树在 attic/${r.generation}/）`);
    else out.line(`          第 ${r.generation} 代，只减引用；${name} 仍被 ${r.remaining.join(', ')} 请求，目录保留`);
  }

  const failed = results.filter((r) => !r.ok);
  let exit = EXIT.OK;
  if (failed.length === results.length && failed.length > 0) exit = classify(failed[0]._err).code;
  else if (failed.length > 0) exit = EXIT.PARTIAL;

  const body = {
    duration_ms: Date.now() - t0,
    name,
    skipped: skippedRows.map((s) => ({ client: s.client, reason: s.reason, scope: s.scope })),
    targets: results.map((r) => ({
      annotations: r.annotations,
      client: r.client,
      deleted: r.ok ? r.deleted : undefined,
      error: r.ok ? undefined : r.error,
      exit_code: r.ok ? 0 : r.exit_code,
      generation: r.ok ? r.generation : undefined,
      ok: r.ok,
      remaining: r.ok ? r.remaining : undefined,
      removed_roots: r.ok ? r.removedRoots : undefined,
      scope: r.scope,
      target: r.target,
    })),
  };
  if (exit !== EXIT.OK && exit !== EXIT.PARTIAL) {
    return out.emitError('remove', classify(failed[0]._err), failed[0]._err, body);
  }
  return out.emit('remove', body, exit);
}

function fingerprintOf(p) {
  return graphFingerprint({
    artifacts: p.artifacts,
    postEdges: p.postEdges,
    removeRoots: p.removeRoots,
    retire: p.retire,
    writeRoots: {},
  });
}

/** 单个 target 的第 2–10 步。🔴 全同步 —— 它在锁与事务里面，不能 await。 */
function removeOneTarget(ctx, pv, { name, hook, out }) {
  const target = pv.t.target;
  const P0 = layout(target);

  // ── 第 2 步：残留事务分流 ────────────────────────────────────────────────
  const rec = recover(target, { mode: 'auto', onLedgerChanged: hook, keepGenerations: ctx.keepGenerations });
  if (rec.outcome !== 'nothing') out.note(`${pv.t.client}：入口分流 —— ${rec.outcome}`);

  // ── 第 3 步：预检 ───────────────────────────────────────────────────────
  const pre = precheckTarget(target, { base: pv.t.base, targetSet: [target] });
  assertPrecheckOk(pre);

  // 🔴 **锁内重读并重算**：预览是在没有任何锁的情况下读的，从那时到现在
  //    另一个进程完全可以改掉这张图（`recover` 自己也会）。
  //    比的是**语义指纹**，不是整份 plan —— generation / 时间戳本来就会变。
  const L = readLedger(P0.ledger);
  assertLedgerGraphUsable(L, `${target}/.geoly/ledger.json`);
  const p = planRemoval(L, name, target);
  if (p === null) {
    // 预览时还在、现在没了 —— 别人已经把它删了。这不是错，但也不许假装是我们干的。
    return { deleted: false, generation: L.last_applied_generation, remaining: [], removedRoots: [], noop: true };
  }
  if (fingerprintOf(p) !== pv.fingerprint) {
    throw new UsageError(
      `${target}：账本在确认之后被改动了（引用图与你看到的那份不一致）。什么都没做 —— 请重跑 remove。`,
      { telemetryReason: 'version-conflict' },
    );
  }

  ensureGenerationWatermark(P0);
  const generation = nextGeneration(P0);
  const at = nowUtc(ctx.now());

  // 🔴 保留下来的 entry 走 `install` 数组：磁盘树没变 ⇒ `derivePlan` 算出
  //    `treeDigest(T) === tree_digest` ⇒ 落到 **`adopt_assertions`（ledger-only）**，
  //    不构造物理 swap（那会撞「禁止 old_digest == new_digest」），也不需要任何字节。
  //    它在写 ledger post 之前会走 `reverifyAssertions` 严格复验 —— 改账本之前
  //    先证明那棵树还是账本声称的那棵。
  const install = p.keep ? [{
    artifact: p.entry.artifact,
    installed_at: p.entry.installed_at,
    name,
    requested_by: p.postEdges.get(name),
    snapshot: p.entry.snapshot,
    srcDir: undefined,                 // adopt 分支不需要源目录
    tree_digest: p.entry.tree_digest,
  }] : [];

  const plan = derivePlan({
    generation,
    install,
    ledger: L,
    ledgerExisted: true,
    removeRoots: p.removeRoots,
    replace: new Set(),
    retire: p.retire,
    roots: {},
    target,
  });

  // 🔴 保留分支必须真的落成逻辑项。如果它变成了物理 `swap`，说明磁盘树与账本
  //    不符（`derivePlan` 会去 stage 一个我们根本没有的源目录），要在动手之前就炸。
  if (p.keep && !plan.adopt_assertions?.[name]) {
    const e = new UsageError(
      `${target}/${name} 与账本记录的树不符：remove 只改引用、不换字节，无法继续。\n`
      + '  账本与磁盘不符 —— `check` 能把不符之处报全（它只诊断、不修复）。',
      { telemetryReason: 'digest-mismatch' },
    );
    e.exitCode = EXIT.INTEGRITY;
    throw e;
  }

  // 🔴 `floor: null` 是**显式决定**，不是忘了传：remove 不解析快照、
  //    没有任何 registry 出处，拿「现在的 floor」去卡一次纯本地的减引用讲不通。
  runTransaction(target, plan, {
    floor: null,
    keepGenerations: ctx.keepGenerations,
    now: at,
    onLedgerChanged: hook,
  });

  return {
    deleted: !p.keep,
    generation,
    remaining: p.keep ? p.postEdges.get(name) : [],
    removedRoots: p.removeRoots,
  };
}

function emitTelemetry(ctx, results, previews) {
  const rec = ctx.record;
  if (!rec) return;
  const byTarget = new Map(previews.map((x) => [x.t.target, x]));
  for (const r of results) {
    const pv = byTarget.get(r.target);
    rec({
      artifact: pv?.p.entry.artifact,
      client: r.client,
      kind: 'remove',
      ms: r.ms,
      reason: r.ok ? undefined : r.reason,
      result: r.ok ? 'ok' : 'failed',
      scope: r.scope,
    });
  }
}
