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
  for (const q of queries) {
    if (q.kind === 'pack') {
      throw new UsageError(`pack 安装是 M2 的能力（09-cli.md §1 的阶段列）：${q.raw}`);
    }
  }

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

  const records = queries.map((q) => resolveSpec(snap, q, { pre: ctx.pre, allowYanked: ctx.allowYanked }));
  for (const r of records) {
    if (r.status === 'yanked') out.warn(`🔴 ${r.id} 已被 yank，仍按 --allow-yanked 安装（会写进账本）`);
    if (r.status === 'deprecated') out.warn(`${r.id} 的状态是 deprecated`);
  }

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
  const names = records.map((r) => r.name);
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
          const r = installOneTarget(ctx, t, records, { snap, floor, pinned, out, verifier });
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
function installOneTarget(ctx, t, records, { snap, floor, out, verifier }) {
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
  const items = records.map((r) => ({ record: r, bytes: ctx.registry.fetchAsset(r) }));

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
    for (const r of records) {
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

    const roots = {};
    const installReqs = [];
    for (const v of verified) {
      const r = v.record;
      const rootKey = `direct:${r.id}`;
      const intent = { no_bundled: ctx.noBundled, pre: ctx.pre };
      if (ctx.allowYanked) intent.allow_yanked = true;    // 账本如实记录本机历史
      roots[rootKey] = {
        artifact: r.id,
        intent,
        kind: 'direct',
        requested_at: at,
        snapshot: snap.snapshot,
        tree_digest: r.tree_digest,
      };
      installReqs.push({
        artifact: r.id,
        installed_at: at,
        name: r.name,
        requested_by: [rootKey],
        snapshot: snap.snapshot,
        srcDir: v.art.dir,
        tree_digest: r.tree_digest,
      });
    }

    const plan = derivePlan({
      generation,
      install: installReqs,
      ledger: L,
      ledgerExisted,
      replace,
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

    return { generation, installed: installReqs.map((r) => r.name) };
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
