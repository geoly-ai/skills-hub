// `vendor <pack-spec> --out <dir> [--layout flat]` —— 03-packs.md §6 的物化器
// 在命令面这一侧的接线。09-cli.md §1 把它列在 **M2**。
//
// pack 是引用不是容器（§1），单独取 pack 得不到完整的目录树。本命令把 pack 与它
// 锁定的成员一起取回、逐个验签验摘要，再按 `flat` 布局摊成一棵目录树，整目录替换。
//
// 🔴 **vendor 不走安装账本**（§6 末段）：它写的是**用户仓库里的目录**，不是 client
//    的 skills 目录。所以本命令：
//      · 不做 `planTargets()` / adapter 派生 —— 没有 target 这个概念；
//      · 不取 target 锁、不取 repo 锁 —— 没有账本要保护；
//      · 不写 generation / attic / refcount / lockfile。
//    它唯一的事务纪律是 `materializeVendor()` 自带的那一份（staging → intent →
//    两次 rename），恢复入口是 `recoverVendor()`。
//
// 🔴 **本命令仍然要解析当前快照** —— 版本、成员摘要、`degraded` 都只有快照说了算，
//    而 `resolveCurrent()` 会推进 trust floor。这一点与只读命令不同：vendor 会
//    往磁盘上落一棵别人要跟着走的树，它没有资格用一张比本地 floor 还旧的快照。

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import { materializeVendor, recoverVendor, LAYOUTS } from '../vendor.mjs';
import { validatePackManifest, resolvePackInstall } from '../pack.mjs';
import { withVerifiedArtifact } from '../artifact.mjs';
import { UsageError, EXIT } from '../exit-codes.mjs';
import { annotations, annotationSuffix } from './output.mjs';
import { resolveSnapshotForCommand } from './snapshot-access.mjs';
import { parseSpec, resolveSpec } from './resolve.mjs';
import { withPackErrors } from './pack-errors.mjs';

/** `skipped[].why` → 人类文案。表驱动，免得两处各写一遍。 */
const SKIP_REASON = Object.freeze({
  __proto__: null,
  'no-bundled': '--no-bundled 跳过（role: tool）',
  'bundled-yanked': '🔴 bundled 成员已被 yank —— 按 03-packs.md §5 跳过，pack 仍是 published',
  'bundled-degraded': '🔴 bundled 成员是 degraded 的 pack —— 按 §5 的同一条跳过',
});

export function parseVendorArgs(argv) {
  let spec = null;
  let out = null;
  let layout = 'flat';
  let seenLayout = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 2 ? a.slice(0, eq) : a;
    let val = a.startsWith('--') && eq > 2 ? a.slice(eq + 1) : undefined;
    if (name === '--out' || name === '--layout') {
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined || val.startsWith('-')) throw new UsageError(`${name} 需要一个值`);
      }
      // 🔴 重复给同一个单值 flag **拒绝**，不做「后一个覆盖前一个」。
      //    `--out a --out b` 多半是脚本拼参数拼错了，而静默取 b 的后果是
      //    **整目录替换落在一个用户没打算动的目录上** —— 这条不该靠猜。
      if (name === '--out') {
        if (out !== null) throw new UsageError(`--out 给了不止一次：${out} 与 ${val}。不猜，请只给一个。`);
        out = val;
      } else {
        if (seenLayout) throw new UsageError(`--layout 给了不止一次：${layout} 与 ${val}。不猜，请只给一个。`);
        seenLayout = true;
        layout = val;
      }
      continue;
    }
    if (a.startsWith('-')) throw new UsageError(`vendor 不认得 flag ${a}`);
    // 🔴 多给一条 spec 不是「装两个」——`--out` 只有一个，第二条会静默覆盖第一条。
    if (spec !== null) throw new UsageError(`vendor 一次只物化一个 pack（--out 只有一个），多给了：${a}`);
    spec = a;
  }
  if (spec === null) throw new UsageError('用法：skills-hub vendor <pack-spec> --out <dir> [--layout flat]');
  if (out === null) throw new UsageError('vendor 需要 --out <dir>（03-packs.md §6）');
  if (out === '') throw new UsageError('--out 不能是空串');
  // 🔴 别的值不给「合理默认」，直接拒（同 vendor.mjs 的 LAYOUTS 那条）
  if (!LAYOUTS.includes(layout)) {
    throw new UsageError(`--layout 只支持 ${LAYOUTS.join(' / ')}，得到 ${JSON.stringify(layout)}`);
  }
  return { spec, out, layout };
}

export async function cmdVendor(ctx, argv, out) {
  const { spec, out: outArg, layout } = parseVendorArgs(argv);
  // 相对路径按 **cwd** 解析（不是 projectRoot）：`--out` 说的是用户此刻在哪敲的命令。
  const outDir = isAbsolute(outArg) ? outArg : resolvePath(ctx.cwd, outArg);
  const parent = dirname(outDir);

  // ── 残留分流：上一次 vendor 没收尾就先收敛 ───────────────────────────────
  // 🔴 与 `install` 第 2 步同源（那里是 `recover(target, { mode: 'auto' })`）：
  //    残留状态由入口自动收敛，不要求用户先手工跑一条别的命令。
  //    ⚠️ 收敛的结果**二选一**（前滚到新树 / 复原旧树），由 intent 里记的进度决定，
  //    不是本次命令的意图 —— 所以必须**大声报出来**，不能默默做掉。
  // 🔴 **收敛的不一定是「我们这个 out」。** intent 文件是
  //    `<parent>/.geoly-vendor-intent.json` —— **一个父目录一份**，不是一个 out 一份。
  //    同一父目录下有两个 vendored 目录时（`.github/codex/{a,b}`），a 崩掉留下的 intent
  //    会在 `vendor …/b` 时被收敛。**收敛本身是对的**：不收敛的话 `materializeVendor()`
  //    会以 E_VENDOR_INTENT_PENDING 拒绝，b 就被 a 的残留永久挡住。
  //    但**文案必须报 `r.out`，不能报我们自己的 outDir** —— 否则会指着 b 说
  //    「b 上一次没收尾」，而 b 可能从来没被 vendor 过。（Codex 2026-08-30 Q2 的存疑点，
  //    追下去确有其事。）
  let recovered = null;
  if (existsSync(parent)) {
    const r = withPackErrors(() => recoverVendor(parent));
    if (r.action !== 'none') {
      recovered = { action: r.action, out: r.out };
      const same = r.out === outDir;
      out.warn(
        `上一次 vendor 没收尾，已收敛为 ${r.action}：${r.out}`
        + (same ? '' : `\n  ⚠️ 那是**同一父目录下的另一个** vendored 目录，不是本次的 ${outDir}`)
        + '（03-packs.md §6 的恢复路径）',
      );
    }
  }

  // ── 解析快照 ─────────────────────────────────────────────────────────────
  const { snapshot: snap, stale, pinned } = await resolveSnapshotForCommand(ctx);
  if (stale) out.warn('timestamp 已过期：本次输出全部按 stale 处理（--allow-stale 已给）');

  const q = parseSpec(spec);
  // 🔴 `vendor` 的对象**必须是 pack**。不带前缀而快照里恰好只有同名 skill 时，
  //    `resolveSpec` 会照常返回那个 skill —— 在这里当场拒绝，不猜、也不代劳。
  if (q.kind === 'skill') throw new UsageError(`vendor 的对象必须是 pack，得到 ${spec}`);
  // ⚠️ `resolveSpec()` **不需要** `withPackErrors()` 包：它抛的是命令面自己的
  //    `ConflictError` / `UsageError` / `AmbiguousError`（都带整数 `exitCode`），
  //    不是库层的 `PackError` / `WireError`。degraded 走的正是这条 —— 它在
  //    `assertInstallable()` 里就被拦成 ConflictError（3），到不了 PACK_ERROR_EXIT。
  //    （Codex 2026-08-30 第 1 条按「若它抛 PackError」提的，前提不成立。记在这里免得
  //     下一个人「顺手补上」那层包装 —— 包了会把已经对的退出码再包一次。）
  const packRecord = resolveSpec(snap, q, { pre: ctx.pre, allowYanked: ctx.allowYanked });
  if (packRecord.kind !== 'pack') {
    throw new UsageError(
      `${packRecord.id} 是 ${packRecord.kind}，不是 pack —— vendor 只物化 pack（03-packs.md §6）。\n`
      + `  要点名 pack 请写 \`pack:${packRecord.namespace}/${packRecord.name}\`。`,
    );
  }
  if (packRecord.status === 'yanked') {
    out.warn(`🔴 ${packRecord.id} 已被 yank，仍按 --allow-yanked 物化 —— 这只该用于取证`);
  }
  if (packRecord.status === 'deprecated') out.warn(`${packRecord.id} 的状态是 deprecated`);

  // ── 取 pack 本体 → 验签验摘要 → 读 pack.json ────────────────────────────
  const packBytes = ctx.registry.fetchAsset(packRecord);
  const manifest = withPackErrors(() => withVerifiedArtifact(
    { bytes: packBytes, record: packRecord },
    // `art.manifest` 是 `assertManifestBinding()` 已经与 record 绑定过的那份 pack.json；
    // 这里再过一遍**全量语义**校验（pack.mjs 头部说明的分工）。
    (art) => validatePackManifest(art.manifest),
  ));

  // ── §4 解析顺序 2–4：成员存在性 / 摘要一致 / degraded / bundled 跳过 ────
  const byId = new Map(snap.artifacts.map((r) => [r.id, r]));
  const plan = withPackErrors(() => resolvePackInstall({
    manifest,
    packRecord,
    lookup: (id) => byId.get(id),
    intent: { noBundled: ctx.noBundled, allowYanked: ctx.allowYanked },
    // 🔴 `client: null` —— vendor 没有 target，成员交集那道门在这里**不适用**。
    //    传一个假的 client 只会造出一条与 §6 无关的拒绝。
    client: null,
  }));
  for (const s of plan.skipped) {
    out.warn(`跳过成员 ${s.id}：${SKIP_REASON[s.why] ?? s.why}`);
  }

  // ── 取全部成员的字节，交给物化器 ────────────────────────────────────────
  const members = plan.install.map((m) => ({
    bytes: ctx.registry.fetchAsset(m.record),
    record: m.record,
    role: m.role,
  }));

  const t0 = Date.now();
  const res = withPackErrors(() => materializeVendor({
    pack: { bytes: packBytes, record: packRecord },
    members,
    out: outDir,
    snapshot: snap.snapshot,
    layout,
    skipped: plan.skipped.map((s) => s.id),
  }));

  emitTelemetry(ctx, packRecord, Date.now() - t0);

  // ── §7 输出契约：逐成员列出来，**不允许只打一句 done** ──────────────────
  const ann = annotations({
    stale,
    offline: ctx.offline,
    yanked: packRecord.status === 'yanked',
    degraded: false,   // degraded 的 pack 根本走不到这里（resolveSpec 已拒）
    shadowed: false,   // vendor 不写 client 目录，没有遮蔽这回事
  });
  out.line(`vendor 结果（快照 ${snap.snapshot}${pinned ? '，--snapshot 钉住' : ''}）：`);
  out.line(`  pack     ${res.pack}${annotationSuffix(ann)}`);
  out.line(`  out      ${res.out}`);
  out.line(`  layout   ${layout}`);
  out.line(`  摘要     ${res.tree_digest}`);
  if (recovered !== null) out.line(`  恢复     ${recovered.out} 上一次未收尾的 vendor 已收敛为 ${recovered.action}`);
  out.line(`  成员（${res.members.length}）：`);
  for (const m of [...res.members].sort((a, b) => (a.dir < b.dir ? -1 : 1))) {
    out.line(`    ${m.dir.padEnd(28)}${m.role.padEnd(8)}${m.id}`);
  }
  if (plan.skipped.length) {
    out.line(`  跳过（${plan.skipped.length}）：`);
    for (const s of plan.skipped) out.line(`    ${s.id}  —— ${SKIP_REASON[s.why] ?? s.why}`);
  }
  out.line(`提示：把 ${res.out}/VENDORED.json 一起提交，CI 可据它复核与重取（03-packs.md §6）。`);

  return out.emit('vendor', {
    annotations: ann,
    duration_ms: Date.now() - t0,
    layout,
    members: res.members.map((m) => ({ dir: m.dir, id: m.id, role: m.role, tree_digest: m.tree_digest })),
    out: res.out,
    pack: res.pack,
    pinned_snapshot: pinned ? snap.snapshot : undefined,
    recovered: recovered ?? undefined,
    skipped: plan.skipped.map((s) => ({ id: s.id, why: s.why })),
    snapshot: snap.snapshot,
    tree_digest: res.tree_digest,
  }, EXIT.OK);
}

/**
 * 埋点。🔴 事务之外、收尾处，`record` 不抛也不进关键路径（同 install）。
 *
 * ⚠️ 只在**成功**路径上记一条：失败路径的 `kind: 'vendor'` 事件要带 `reason`，
 *    而 reason 只能来自 `classify()` —— 那发生在 `cli.mjs` 的顶层 catch 里，
 *    命令自己看不到。与 `install` 不同的是 install 自己收集了逐 target 的失败，
 *    vendor 没有「部分成功」这回事（整目录替换，要么换了要么没换）。
 *    这条缺口如实记在这里，不假装覆盖全了。
 */
function emitTelemetry(ctx, packRecord, ms) {
  if (!ctx.record) return;
  ctx.record({
    artifact: packRecord.id,
    kind: 'vendor',
    ms,
    result: 'ok',
    version: packRecord.version,
  });
}
