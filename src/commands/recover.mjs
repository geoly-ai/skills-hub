// `recover [--continue | --rollback | --reinstall] …` —— 09-cli.md §1.1 的分流矩阵。
//
// ── 分流矩阵（09-cli.md §1.1 逐格）─────────────────────────────────────────
//
// | 现场                                   | --continue | --rollback | --reinstall |
// |----------------------------------------|-----------|-----------|-------------|
// | 物理 `items[*].state = corrupt`         | 拒绝      | 拒绝      | **唯一出路** |
// | `adopt` 的 assertion-corrupt            | 拒绝      | **允许**  | 不自动执行  |
// | `unadopt` 的 assertion-corrupt          | **唯一自动出路** | 拒绝 | 不自动执行  |
// | 无异常，`phase = prepared`              | 续做      | 反向段回滚 | 🔴 拒绝（无物理 corrupt） |
// | `phase = cleanup_pending`               | 续做清理  | 反向段回滚 | 🔴 拒绝（无物理 corrupt） |
// | 已持久化 `direction = rollback`         | 🔴 只能续回滚（三个 flag 都是） |||
// | 存在 `repair-intent.json`               | 停机提示 --reinstall | 同左 | 续做状态机 |
// | 有 tx 无 journal（pre-commit）          | 直接删（三个 flag 都是，也含无 flag） |||
// | `phase = completed` 的 journal 残留     | 清残留（同上） |||
//
// 🔴 **内核在 `cleanup_pending` 这一列与规格不符，本文件把它挡在前面。**
//
//    `src/recover.mjs` 的 `driveLive()` 里那句
//      `if (J.phase === 'cleanup_pending' && mode !== 'rollback') { runCleanup(...); return; }`
//    排在**读 `items[*].state === 'corrupt'` 之前**，于是产生两个与 §1.1 不符的格子：
//
//      ① `cleanup_pending` + **无**物理 corrupt + `--reinstall`
//         → 规格：拒绝（「仅物理 corrupt 可用」）。内核：静默做了一次清理续做。
//      ② `cleanup_pending` + **有**物理 corrupt + 任意 flag
//         → 规格：拒绝 / 拒绝 / 唯一出路。内核：三条都变成清理续做，
//           连「--continue 遇物理 corrupt 要拒绝」都被绕过去了。
//
//    修内核不在本块的文件边界内，所以 `assertModeAllowed()` 在**调用之前**用
//    `inspect()` 判并拒绝这两格：① 报「仅物理 corrupt 可用」，② 整格转人工。
//    两条都写进了交付汇报（内核缺口：那个条件要把 `mode` 与 `items[*].state` 一起纳入）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { layout } from '../ledger.mjs';
import { readJournal, listJournalGenerations } from '../journal.mjs';
import { readHistoricalSnapshot } from '../snapshot.mjs';
import { withVerifiedArtifact } from '../artifact.mjs';
import { STATE_DIR } from '../adapters/index.mjs';
import { recover as kernelRecover, inspect, planFromGeneration } from '../recover.mjs';
import { resetGeneration } from '../ledger.mjs';
import { planTargets, assertPlanOk } from '../adapters/index.mjs';
import { withOrderedLocks } from './locks.mjs';
import { makeLockfileHook } from './sync-lock.mjs';
import { UsageError, EXIT, classify } from '../exit-codes.mjs';
import { getVerifier } from './snapshot-access.mjs';
import { uintArg } from './context.mjs';
import { annotations } from './output.mjs';

const MODE_FLAGS = ['--continue', '--rollback', '--reinstall'];

export function parseRecoverArgs(argv) {
  const o = {
    mode: null, fromGeneration: null, only: [], resetGeneration: null,
    releaseFrozen: null, resumeCleanup: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > 2 ? a.slice(0, eq) : a;
    let val = eq > 2 ? a.slice(eq + 1) : undefined;
    const need = () => {
      if (val === undefined) val = argv[++i];
      if (val === undefined || val.startsWith('-')) throw new UsageError(`${name} 需要一个值`);
      return val;
    };
    switch (name) {
      case '--continue': case '--rollback': case '--reinstall':
        if (o.mode !== null) {
          throw new UsageError(
            `${MODE_FLAGS.join(' / ')} 三者**互斥**，只能给一个（得到 ${o.mode} 与 ${name}）。`
            + '它们是三条不同的出路，不是可以叠加的选项。',
          );
        }
        o.mode = name;
        break;
      case '--from-generation': o.fromGeneration = uintArg(name, need()); break;
      // 🔴 `--only` **可重复**；重复给同一个 name 视为一次（去重）
      case '--only': o.only.push(need()); break;
      case '--reset-generation': o.resetGeneration = uintArg(name, need()); break;
      case '--release-frozen': o.releaseFrozen = need(); break;
      case '--resume-cleanup': o.resumeCleanup = true; break;
      default: throw new UsageError(`recover 不认得 ${a}`);
    }
  }
  o.only = [...new Set(o.only)];
  if (o.only.length && o.fromGeneration === null) {
    throw new UsageError('--only 只能配 --from-generation 使用（04-install.md §5.8.1）。');
  }
  // 🔴 互斥关系必须在这里拒绝，不能让两条语义在内核里撞车
  // 🔴 `--rollback --from-generation <N>` 是 04-install.md §5.8 **写明的**组合
  //    （「事务已 completed 之后的复位」的正式拼法），不算冲突。
  //    其余任意两项相加都没有定义好的语义。
  const rollbackFromGen = o.mode === '--rollback' && o.fromGeneration !== null;
  const exclusive = [
    o.mode !== null && !rollbackFromGen && `${o.mode}`,
    o.fromGeneration !== null && !rollbackFromGen && '--from-generation',
    rollbackFromGen && '--rollback --from-generation',
    o.resetGeneration !== null && '--reset-generation',
    o.releaseFrozen !== null && '--release-frozen',
    o.resumeCleanup && '--resume-cleanup',
  ].filter(Boolean);
  if (exclusive.length > 1) {
    throw new UsageError(
      `recover 的这几个开关互斥，一次只能给一个：${exclusive.join(' 与 ')}。`
      + '它们各自是一条独立的出路，叠加起来没有定义好的语义（09-cli.md §1.1）。',
    );
  }
  return o;
}

/** 现场画像 —— 只读，供分流判断与报告用。 */
export function survey(target) {
  const P0 = layout(target);
  if (!existsSync(P0.state)) return { present: false, generations: [], repairIntent: false, auditIntent: false };
  const i = inspect(target);
  const live = i.generations.filter((g) => g.phase !== 'completed');
  const physCorrupt = [];
  const adoptBad = [];
  const unadoptBad = [];
  let rollbackDirection = false;
  for (const g of live) {
    if (g.direction === 'rollback') rollbackDirection = true;
    for (const [n, it] of Object.entries(g.items)) if (it.state === 'corrupt') physCorrupt.push(n);
    for (const [n, s] of Object.entries(g.adopt)) if (s === 'assertion-corrupt') adoptBad.push(n);
    for (const [n, s] of Object.entries(g.unadopt)) if (s === 'assertion-corrupt') unadoptBad.push(n);
  }
  return {
    present: true, ...i, live, physCorrupt, adoptBad, unadoptBad, rollbackDirection,
  };
}

/**
 * 🔴 CLI 侧的分流守卫。**只做「规格说要拒绝、而内核不会拒绝」的那几格**；
 *    内核已经拒绝的格子不在这里重复实现（重复一遍就有了第二份真相）。
 *
 * 目前只有一格：`--reinstall` 遇到 `cleanup_pending` 且无物理 corrupt。
 */
export function assertModeAllowed(mode, s) {
  if (!s.present) return;

  // 🔴 内核 `driveLive()` 把 `phase === 'cleanup_pending' && mode !== 'rollback'`
  //    这一支排在**读 `items[*].state === 'corrupt'` 之前**，因此
  //    「cleanup_pending 且存在物理 corrupt」这个现场会被直接 `runCleanup()` 吃掉：
  //    `--continue` 绕过了「拒绝物理 corrupt」，`--reinstall` 更是做了一次清理
  //    而不是重装。09-cli.md §1.1 对这三条 flag 在物理 corrupt 下的规定分别是
  //    拒绝 / 拒绝 / 唯一出路 —— 一个都没兑现。
  //    修内核不在本块的文件边界内，所以这里整格拦下并转人工。
  if (s.physCorrupt.length > 0 && s.live.some((g) => g.phase === 'cleanup_pending')) {
    const e = new UsageError(
      `现场是「\`phase = cleanup_pending\` 且存在物理 corrupt（${s.physCorrupt.join(',')}）」——`
      + '本命令拒绝自动处置，转人工。\n'
      + '  原因：内核 src/recover.mjs 的 driveLive() 会在读 items[*].state 之前先对 '
      + 'cleanup_pending 做清理续做，于是 09-cli.md §1.1 为这一格规定的'
      + '「--continue 拒绝 / --rollback 拒绝 / --reinstall 唯一出路」一条都不会生效。\n'
      + '  这是**已知的内核缺口**，已写进交付汇报。',
    );
    // 🔴 落 5（「残留事务需 recover / 需人工」），不落 1 —— 这不是用法错误，
    //    用户的命令写得没毛病，是现场处置不了。
    e.exitCode = EXIT.NEEDS_RECOVER;
    e.telemetryReason = 'journal-corrupt';
    throw e;
  }

  if (mode !== 'reinstall') return;
  if (s.repairIntent) return;                    // repair intent 走 2b-1，本来就该 --reinstall
  if (s.physCorrupt.length > 0) return;          // 有物理 corrupt —— 正是它的用武之地
  if (s.live.length === 0) return;               // 没有未完成事务：内核会自己报「没有物理 corrupt」
  const phases = [...new Set(s.live.map((g) => g.phase))].join(', ');
  const e = new UsageError(
    `--reinstall **仅物理 corrupt 可用**（09-cli.md §1.1），当前没有任何 `
    + `items[*].state = corrupt 的项（未完成事务的 phase：${phases}）。\n`
    + '  想续做请用 `--continue`，想回滚请用 `--rollback`。',
  );
  e.telemetryReason = 'unknown';
  throw e;
}

export async function cmdRecover(ctx, argv, out) {
  const o = parseRecoverArgs(argv);

  if (o.releaseFrozen !== null) {
    // 🔴 内核缺口，如实拒绝而不是假装做了。`src/ledger.mjs` 只有 `isGenerationFrozen()`，
    //    没有「按 label 解冻」的导出，而 `frozen_attic` 的写入只能经由
    //    `derivePlan({ frozenAttic })` 的**整张 map** 语义 —— 那要一个完整事务。
    //    在内核补上这个 API 之前，本命令不提供一个看起来成功、实际什么都没改的路径。
    throw new UsageError(
      '`--release-frozen` 还不可用：内核没有「按 label 解冻 attic」的导出'
      + '（src/ledger.mjs 只有 isGenerationFrozen，frozen_attic 的写入是整张 map 语义，需要一个事务）。\n'
      + '  这是**已知的内核 API 缺口**，已写进交付汇报。不提供一个假装成功的路径。',
    );
  }

  const tplan = planTargets({
    clients: ctx.clients,
    scope: ctx.scope,
    home: ctx.home,
    env: ctx.env,
    projectRoot: ctx.projectRoot,
  });
  for (const w of tplan.warnings) out.warn(w);
  assertPlanOk(tplan);
  // recover 只对**已经有 .geoly 状态**的 target 有意义
  const selected = tplan.selected.filter((t) => existsSync(layout(t.target).state));
  const targets = selected.map((t) => t.target);
  for (const s of tplan.skipped) out.note(`跳过 ${s.client}/${s.scope}：${s.reason}`);
  if (targets.length === 0) {
    out.line('没有任何 target 有 .geoly 状态目录 —— 无残留事务可处理。');
    return out.emit('recover', { targets: [] }, EXIT.OK);
  }

  // 🔴 §5.9：`--reset-generation` 的**作用域是单个 target**。
  //    不同 target 的水位互不相干，一个 <N> 套不上所有 —— 多目标时必须点名。
  // 🔴 判据是**本次命令选中的 target 总数**，不是「其中还剩几个有 .geoly 状态」。
  //    按后者算的话，`--clients a,b` 里恰好只有一个建过状态目录时就会被放行 ——
  //    而 §5.9 要的是「多目标时必须点名」，不是「碰巧只有一个有状态」。
  if (o.resetGeneration !== null && tplan.selected.length !== 1) {
    throw new UsageError(
      `--reset-generation 的作用域是**单个 target**（04-install.md §5.9），`
      + `本次命令选中了 ${tplan.selected.length} 个：\n`
      + `${tplan.selected.map((t) => `  ${t.client}/${t.scope}  ${t.target}`).join('\n')}\n`
      + '  请用 --clients <单个> 收窄，或在 --project 下指向单一 target。'
      + '不同 target 的水位互不相干，同一个 <N> 套不上所有。',
    );
  }

  const mode = o.mode ? o.mode.slice(2) : 'auto';
  // 🔴 项目级 recover 收尾要重算 lockfile，而那需要回**已验签的历史快照**取
  //    `asset_sha256`。早先只有 `--reinstall` 拿 verifier，于是项目级的
  //    continue / rollback 一到收尾就必然抛 NetworkError（Codex 第二轮 P0-2）。
  const needVerifier = o.mode === '--reinstall' || ctx.scope === 'project';
  const verifier = needVerifier ? await getVerifier(ctx) : null;
  const results = [];

  withOrderedLocks(
    {
      baseFor: (p) => selected.find((t) => t.target === p)?.base ?? null,
      projectRoot: ctx.scope === 'project' ? ctx.projectRoot : null,
      targets,
    },
    ({ targets: ordered }) => {
      for (const t of ordered) {
        const started = Date.now();
        const before = survey(t.path);
        try {
          const r = runOne(ctx, t.path, { mode, o, before, verifier });
          results.push({ target: t.path, ok: true, ms: Date.now() - started, ...r });
        } catch (err) {
          const cls = classify(err);
          results.push({
            target: t.path, ok: false, ms: Date.now() - started,
            error: err.message, exit_code: cls.code, reason: cls.reason, _err: err,
            // 🔴 §5.5：**逐项报告，不自动选、不猜** —— 失败路径尤其需要它。
            //    只给一句「拒绝」而不给现场，用户根本无从判断该选哪条出路。
            report: safeInspect(t.path),
          });
        }
      }
    },
  );

  if (ctx.record) {
    for (const r of results) {
      ctx.record({
        kind: mode === 'rollback' ? 'rollback' : 'recover',
        ms: r.ms,
        reason: r.ok ? undefined : r.reason,
        result: r.ok ? 'ok' : 'failed',
        scope: ctx.scope,
      });
    }
  }

  // §5.5：逐项报告，**不自动选、不猜**
  out.line(`recover 结果（mode=${mode}，共 ${results.length} 个 target）：`);
  for (const r of results) {
    out.line(`  ${r.ok ? 'ok      ' : 'failed  '}${r.target}`);
    if (r.ok) out.line(`          ${r.outcome}${r.generation !== undefined ? `（第 ${r.generation} 代）` : ''}`);
    else out.line(`          ${r.error.split('\n').join('\n          ')}`);
    if (r.report) {
      for (const g of r.report.generations) {
        out.line(`          第 ${g.generation} 代 phase=${g.phase} direction=${g.direction ?? '-'}`);
        for (const [n, it] of Object.entries(g.items)) {
          out.line(`            item ${n}: op=${it.op} state=${it.state} cleanup=${it.cleanup ?? '-'}`);
        }
        for (const [n, s] of Object.entries(g.adopt)) out.line(`            adopt ${n}: ${s}`);
        for (const [n, s] of Object.entries(g.unadopt)) out.line(`            unadopt ${n}: ${s}`);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  let exit = EXIT.OK;
  if (failed.length === results.length && failed.length > 0) exit = classify(failed[0]._err).code;
  else if (failed.length > 0) exit = EXIT.PARTIAL;

  const body = {
    mode,
    targets: results.map((r) => ({
      // 🔴 标注挂在**每一个** target 对象上（§7：每一次相关输出都要重复标注）
      annotations: annotations({ offline: ctx.offline }),
      error: r.ok ? undefined : r.error,
      exit_code: r.ok ? 0 : r.exit_code,
      generation: r.generation,
      ok: r.ok,
      outcome: r.ok ? r.outcome : undefined,
      report: r.report ?? undefined,
      target: r.target,
    })),
  };
  if (exit !== EXIT.OK && exit !== EXIT.PARTIAL) {
    return out.emitError('recover', classify(failed[0]._err), failed[0]._err, body);
  }
  return out.emit('recover', body, exit);
}

/** inspect 自己也可能因为现场损坏而抛；报告拿不到不该把原错误盖掉。 */
function safeInspect(target) {
  try { return inspect(target); } catch { return null; }
}

function runOne(ctx, target, { mode, o, before, verifier }) {
  const onLedgerChanged = makeLockfileHook(ctx, { verifier });
  const common = { onLedgerChanged, keepGenerations: ctx.keepGenerations };

  if (o.resetGeneration !== null) {
    // §5.9：**作用域是单个 target** —— 多目标时必须配单个 --clients
    resetGeneration(layout(target), o.resetGeneration);
    return { outcome: 'generation-reset', generation: o.resetGeneration, report: inspect(target) };
  }

  if (o.fromGeneration !== null) {
    // §5.8：事务**早已 completed** 之后，按该代的 attic manifest 复位。
    // 🔴 内核给的是**计划**（planFromGeneration），把它变成一个新的正向事务需要
    //    逐项按 reverse_op 编排 —— 那一段（`runReverseTransaction`）内核没有导出。
    //    先把计划算出来并如实报告，不假装已经复位。
    const p = planFromGeneration(target, o.fromGeneration, { only: o.only.length ? o.only : undefined });
    const e = new UsageError(
      `第 ${o.fromGeneration} 代的复位**计划**已算出并通过 §5.8.1 三方比对，`
      + `选中 ${p.selection.items.length} 项：${p.selection.items.join(', ')}。\n`
      + '  但把该计划执行成一个新的正向事务需要内核导出一个「按 reverse_op 编排」的入口，'
      + '目前 src/recover.mjs 只导出到 planFromGeneration 为止。\n'
      + '  这是**已知的内核 API 缺口**，已写进交付汇报。不提供一个只做了一半的复位。',
    );
    e.exitCode = EXIT.USAGE;
    throw e;
  }

  if (o.resumeCleanup) {
    // §5.6：正常情况下下一次运行会自动续做；这里是**显式**续做。
    // 内核的 auto 分流本身就会把 cleanup_pending 推到 completed。
    const r = kernelRecover(target, { mode: 'auto', ...common });
    return { ...r, report: inspect(target) };
  }

  // 🔴 CLI 侧守卫：规格说要拒绝而内核不会拒绝的那一格
  assertModeAllowed(mode, before);

  if (mode === 'reinstall') return runReinstall(ctx, target, { common, before, verifier });

  const r = kernelRecover(target, { ...common, mode });
  return { ...r, report: inspect(target) };
}

/**
 * §5.10 `--reinstall`。两个注入点缺任一个，内核都会**如实拒绝**自动 repair ——
 * 不注入不等于放行，所以两个都要接上。
 *
 *   · `assertSnapshotRetrievable(N)`：该快照必须能按 §02-6.1 的历史读取路径**取回并验签**；
 *   · `resolver(name) -> { artifact, dir }`：`--reinstall`「重新解析安装」的**主路径**。
 *     `dir` 必须是**已过完整验证链**的树 —— 内核只会再核一次摘要，不会替我们验签。
 *
 * 🔴 用 `withVerifiedArtifact()` 的**作用域版**：解包目录在 `kernelRecover` 返回后
 *    （无论成功还是抛错）自动清掉。裸 `verifyArtifact` + 「记得 dispose」在这条
 *    有五个提前 return 的路径上必漏。
 */
function runReinstall(ctx, target, { common, before, verifier }) {
  // 从**未完成事务的 journal** 里取「哪个 name 对应哪个 artifact、解析于哪张快照」。
  // 🔴 取 `ledger_image.post`：`pre` 记的是上一次安装时的快照（同内核 bindSnapshot 的理由）。
  const wanted = [];
  const P0 = layout(target);
  for (const g of listJournalGenerations(P0.journalDir)) {
    const J = readJournal(layout(target, g).journal);
    if (J.phase === 'completed') continue;
    for (const [name, e] of Object.entries(J.ledger_image.post.entries)) {
      if (e) wanted.push({ name, artifact: e.artifact, snapshot: e.snapshot });
    }
  }

  // 能从缓存取到并验通过的，预先物化成已验证的树；取不到的**跳过**——
  // quarantine / quarantine-tx / attic 三种介质可能本来就够用（§5.10 的 ①②③）。
  const fetched = [];
  for (const w of wanted) {
    let snap;
    try { snap = readSnap(ctx, verifier, w.snapshot); } catch { continue; }
    const rec = snap.artifacts.find((r) => r.id === w.artifact);
    if (!rec) continue;
    let bytes;
    try { bytes = ctx.registry.fetchAsset(rec); } catch { continue; }
    fetched.push({ ...w, record: rec, bytes });
  }

  const parent = join(target, STATE_DIR);
  const run = (resolved) => {
    const byName = new Map(resolved.map((x) => [x.name, x]));
    return kernelRecover(target, {
      ...common,
      mode: 'reinstall',
      assertSnapshotRetrievable: (n) => { readSnap(ctx, verifier, n); },
      artifactFor: (name) => byName.get(name)?.artifact,
      resolver: (name) => {
        const hit = byName.get(name);
        if (!hit) {
          throw new Error(
            `repair：${name} 在 registry 里也取不到（缓存未命中，或它不在被绑定的那张快照里）——`
            + '枚举不出完整计划即拒绝自动执行，转人工',
          );
        }
        return { artifact: hit.artifact, dir: hit.dir };
      },
    });
  };

  const nest = (rest, acc) => {
    if (rest.length === 0) return run(acc);
    const [h, ...t] = rest;
    return withVerifiedArtifact({ bytes: h.bytes, record: h.record, parent }, (art) =>
      nest(t, [...acc, { artifact: h.artifact, name: h.name, dir: art.dir }]));
  };

  const r = nest(fetched, []);
  return { ...r, report: inspect(target) };
}

function readSnap(ctx, verifier, n) {
  const { bytes, bundle } = ctx.registry.fetchSnapshot(n);
  return readHistoricalSnapshot({ bytes, bundle, verifier, expectSnapshot: n }).snapshot;
}
