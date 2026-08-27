// `check` —— 09-cli.md §4「两阶段」。
//
// | 问题 | 依据 |
// |---|---|
// | 磁盘上的字节对不对 | 账本记录的**安装时快照**（按 02-registry.md §6.1 的历史读取路径取回并验签），重算树摘要比对 |
// | 这东西现在还该不该用 | **当前 timestamp 指向的快照**里的 `status` / `yanked` / advisory |
//
// 🔴 `--offline` 时第二问**答不了** → 输出标注
//    `状态未知（离线，最后验证于 <时间>）`，**不得默认为「正常」**。
//    这不是「降级成乐观」，是「明说没查」。两者在自动化里差别巨大：
//    前者会让 CI 绿灯放行一个已经被 yank 的制品。
//
// 🔴 还必须如实报告项目级/全局并存，**不声称哪份生效**（04-install.md §8.2）。
//
// 🔴 check **只读**：不取 repo 锁、不取 target 锁（§5.1 的取锁表）。
//    因此它看到的是一个**可能正在被别人改**的现场 —— 报告里如实带上这一点。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { treeDigest } from '../tree-digest.mjs';
import { layout } from '../ledger.mjs';
import { listJournalGenerations, readJournal } from '../journal.mjs';
import { readLockfile, projectLockfile } from '../lockfile.mjs';
import { stringify } from '../canonical-json.mjs';
import { REPO } from '../trust.mjs';
import { UsageError, EXIT } from '../exit-codes.mjs';
import { getVerifier, historicalReader, resolveSnapshotForCommand, isDegradable } from './snapshot-access.mjs';
import { annotations, annotationSuffix } from './output.mjs';
import { targetsFor, ledgerOf, shadowMap } from './query.mjs';
import { LOCKFILE_NAME } from './sync-lock.mjs';

/** 第二问答不上来时的**固定**措辞。测试直接断言这个串。 */
export const UNKNOWN_STATUS = (lastVerifiedAt) =>
  `状态未知（离线，最后验证于 ${lastVerifiedAt ?? '从未验证'}）`;

/**
 * 第一问：磁盘字节 vs 账本记录的**安装时快照**。
 *
 * 🔴 「重算树摘要比对」不是「和账本里的 tree_digest 比」就完了 ——
 *    账本是本机文件，能改账本的人也能改目录。判据必须回到**已验签的历史快照**：
 *      磁盘实测摘要 == 历史快照 record 的 tree_digest，
 *    并且账本记的那一份也要等于它（三方一致），否则就是账本被改过。
 */
export function checkBytes(target, name, entry, readHistorical) {
  const dir = join(target, name);
  if (!existsSync(dir)) {
    return { ok: false, name, why: 'missing', message: `${dir} 不存在，但账本记着它` };
  }
  let actual;
  try { actual = treeDigest(dir); } catch (e) {
    return { ok: false, name, why: 'unreadable', message: `${dir} 算不出树摘要：${e.message}` };
  }
  let expected = null;
  let source = 'ledger';
  try {
    const snap = readHistorical(entry.snapshot);
    const rec = snap.artifacts.find((r) => r.id === entry.artifact);
    if (rec) { expected = rec.tree_digest; source = `snapshot:${entry.snapshot}`; }
  } catch (e) {
    // 取不回安装时快照 → **不能**退回去只信账本然后报「一切正常」。
    // 如实报「未证明」，并且不算通过。
    return {
      actual,
      ok: false,
      name,
      why: 'unproven',
      message: `取不回安装时快照 ${entry.snapshot}（${e.message.split('\n')[0]}）——`
        + '字节对不对**无法证明**，不按通过处理',
    };
  }
  if (expected === null) {
    return {
      actual,
      ok: false,
      name,
      why: 'unproven',
      message: `安装时快照 ${entry.snapshot} 里没有 ${entry.artifact} 的 record —— 无法证明`,
    };
  }
  if (entry.tree_digest !== expected) {
    return {
      actual, expected, ok: false, name, why: 'ledger-mismatch',
      message: `账本记的 tree_digest 与已验签快照里的不符（账本 ${entry.tree_digest} != 快照 ${expected}）`,
    };
  }
  if (actual !== expected) {
    return {
      actual, expected, ok: false, name, why: 'digest-mismatch',
      message: `磁盘实测 ${actual} != 已验签快照记录的 ${expected}`,
    };
  }
  return { actual, expected, ok: true, name, source, why: null };
}

/** 第二问：当前快照里的 `status` / `yanked` / advisory。 */
export function checkStatus(entry, current) {
  if (current === null) return { answered: false, status: null, advisory: null };
  const rec = current.artifacts.find((r) => r.id === entry.artifact);
  if (!rec) {
    return {
      answered: true,
      status: 'absent',
      advisory: null,
      message: `${entry.artifact} 不在当前快照里（可能已被移除）`,
    };
  }
  const y = current.yanked.find((x) => x.id === rec.id);
  return {
    advisory: y?.advisory ?? null,
    answered: true,
    message: y ? `已被 yank：${y.reason}` : null,
    status: rec.status,
    superseded_by: y?.superseded_by ?? null,
  };
}

export async function cmdCheck(ctx, argv, out) {
  for (const a of argv) throw new UsageError(`check 不认得参数 ${a}`);
  const tplan = targetsFor(ctx, out);
  const shadowed = shadowMap(ctx, tplan);
  const verifier = await getVerifier(ctx);
  const readHistorical = historicalReader(ctx, verifier);

  // 当前快照 —— 第二问的**唯一**依据。取不到就答不了，绝不用历史快照冒充。
  let current = null;
  let stale = false;
  let lastVerifiedAt = null;
  let currentError = null;
  try {
    const r = await resolveSnapshotForCommand(ctx);
    current = r.snapshot;
    stale = r.stale;
    lastVerifiedAt = r.floor?.last_verified_at ?? null;
  } catch (e) {
    // 🔴 同 list：只有「取不到」可以降级成「第二问答不了」。
    //    stale / 完整性 / min-cli 各有自己的退出码，吞掉它们就等于伪造了一次通过。
    if (!isDegradable(e)) throw e;
    currentError = e;
    try {
      const { readTrustFloor } = await import('../trust.mjs');
      lastVerifiedAt = readTrustFloor(ctx.stateDir)?.last_verified_at ?? null;
    } catch { lastVerifiedAt = null; }
    out.warn(`第二问答不了：${e.message.split('\n')[0]}`);
  }
  if (stale) out.warn('timestamp 已过期：以下每一行都按 stale 处理');

  const rows = [];
  const targetsOut = [];
  for (const t of tplan.selected) {
    const L = ledgerOf(t.target);
    // 未恢复事务：check 要报出来（它会让第一问的比对结果没有意义）
    const P = layout(t.target);
    const unfinished = [];
    if (existsSync(P.state)) {
      for (const g of listJournalGenerations(P.journalDir)) {
        const J = readJournal(layout(t.target, g).journal);
        if (J.phase !== 'completed') unfinished.push({ generation: g, phase: J.phase });
      }
      if (existsSync(P.repairIntent)) unfinished.push({ generation: null, phase: 'repair-intent' });
    }
    targetsOut.push({
      // 🔴 §7：标注挂在**每一个** target / entry 对象上，不是只挂 entry 那一层
      annotations: annotations({ offline: ctx.offline, stale }),
      client: t.client,
      entries: L ? Object.keys(L.entries).length : 0,
      has_ledger: L !== null,
      scope: t.scope,
      target: t.target,
      unfinished_transactions: unfinished,
    });
    if (!L) continue;
    for (const [name, e] of Object.entries(L.entries)) {
      const bytes = checkBytes(t.target, name, e, readHistorical);
      const status = checkStatus(e, current);
      rows.push({
        annotations: annotations({
          stale,
          offline: ctx.offline || currentError !== null,
          yanked: status.status === 'yanked',
          degraded: status.status === 'degraded',
          shadowed: shadowed.has(name),
        }),
        artifact: e.artifact,
        bytes,
        client: t.client,
        name,
        scope: t.scope,
        // 🔴 答不了就是答不了 —— **不得默认为「正常」**
        status: status.answered ? status.status : null,
        status_advisory: status.advisory ?? undefined,
        status_message: status.answered
          ? (status.message ?? undefined)
          : UNKNOWN_STATUS(lastVerifiedAt),
        status_known: status.answered,
        target: t.target,
      });
    }
  }

  // lockfile 过时（§8.1：`check` 发现不符则报「lockfile 过时」，提示 sync-lock）
  let lockfileState = null;
  if (ctx.scope === 'project') lockfileState = checkLockfile(ctx, tplan, readHistorical, out);

  // ── 输出 ────────────────────────────────────────────────────────────────
  out.line(`check（${rows.length} 条 entry）：`);
  for (const r of rows) {
    const first = r.bytes.ok ? 'bytes-ok  ' : `bytes-BAD `;
    const second = r.status_known ? `status=${r.status}` : r.status_message;
    out.line(`  ${first}${r.client}/${r.scope}  ${r.name}  ${second}${annotationSuffix(r.annotations)}`);
    if (!r.bytes.ok) out.line(`            ${r.bytes.message}`);
    if (r.status_advisory) out.line(`            advisory: ${r.status_advisory}`);
  }
  for (const t of targetsOut) {
    for (const u of t.unfinished_transactions) {
      out.line(`  [!] ${t.client}/${t.scope} 有未完成事务（${u.phase}）——`
        + '请先 `skills-hub recover`；在那之前上面的比对结果只反映一个中间态');
    }
  }
  for (const [name, hits] of shadowed) {
    out.line(`  [!] ${name} 项目级与全局并存（全局在 ${hits[0].globalTarget}）——`
      + '生效者取决于客户端，本工具不做判断（04-install.md §8.2）');
  }
  if (lockfileState && !lockfileState.ok) {
    out.line(`  [!] ${lockfileState.message}`);
  }

  const badBytes = rows.filter((r) => !r.bytes.ok);
  const unfinishedAny = targetsOut.some((t) => t.unfinished_transactions.length > 0);
  let exit = EXIT.OK;
  // 🔴 优先级：有未完成事务 → 5（先去 recover，其它结论都只反映中间态）；
  //    否则字节不符 → 2（完整性失败）。
  if (unfinishedAny) exit = EXIT.NEEDS_RECOVER;
  else if (badBytes.length) exit = EXIT.INTEGRITY;

  if (ctx.record) {
    ctx.record({
      kind: 'check',
      reason: exit === EXIT.OK ? undefined : (exit === EXIT.INTEGRITY ? 'digest-mismatch' : 'journal-corrupt'),
      result: exit === EXIT.OK ? 'ok' : 'failed',
      scope: ctx.scope,
    });
  }

  return out.emit('check', {
    entries: rows,
    lockfile: lockfileState ?? undefined,
    second_question_answered: current !== null,
    second_question_unknown_reason: current === null ? UNKNOWN_STATUS(lastVerifiedAt) : undefined,
    shadowed: [...shadowed.keys()].sort(),
    snapshot: current ? current.snapshot : undefined,
    targets: targetsOut,
  }, exit);
}

/** §8.1：lockfile 与账本投影不符 → 报「过时」，提示 `sync-lock`。**只报不写**。 */
function checkLockfile(ctx, tplan, readHistorical, out) {
  const path = join(ctx.projectRoot, LOCKFILE_NAME);
  if (!existsSync(path)) {
    return { message: `${path} 不存在（项目级安装应当维护它）—— 跑 \`skills-hub sync-lock\` 生成`, ok: false, path };
  }
  let onDisk;
  try { onDisk = readLockfile(path); } catch (e) {
    return { message: `${path} 解析失败：${e.message}`, ok: false, path };
  }
  // 重算一份**在内存里**的投影去比 —— 🔴 check 不写盘
  const targets = [];
  for (const t of tplan.selected) {
    const L = ledgerOf(t.target);
    if (!L) continue;
    if (Object.keys(L.entries).length === 0 && Object.keys(L.roots).length === 0) continue;
    const assetSha256 = {};
    let missing = false;
    for (const [name, e] of Object.entries(L.entries)) {
      try {
        const snap = readHistorical(e.snapshot);
        const rec = snap.artifacts.find((r) => r.id === e.artifact);
        if (!rec) { missing = true; break; }
        assetSha256[name] = rec.asset.sha256;
      } catch { missing = true; break; }
    }
    if (missing) {
      out.warn('取不回某些安装时快照，lockfile 的「是否过时」无法证明 —— 如实报未证明，不报「一致」');
      return { message: 'lockfile 是否过时**未证明**（取不回安装时快照里的 asset_sha256）', ok: false, path, unproven: true };
    }
    targets.push({ assetSha256, client: t.client, ledger: L, path: `${t.adapter.dirName}/skills`, scope: 'project' });
  }
  let want;
  try { want = projectLockfile({ registry: REPO, targets }); } catch (e) {
    return { message: `账本投影算不出来：${e.message}`, ok: false, path };
  }
  if (stringify(want) !== stringify(onDisk)) {
    return { message: `${path} **已过时**（与账本投影不符）—— 跑 \`skills-hub sync-lock\``, ok: false, path };
  }
  return { ok: true, path };
}
