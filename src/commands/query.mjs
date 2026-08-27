// `list` / `search` / `why` —— 09-cli.md §1。
//
// 取锁表（§5.1）：这三个命令 **只取 metadata 锁，且仅在需要验签时** ——
// 而 metadata 锁在 `trust.advanceTrustFloor()` 内部起落，命令面不碰。
// **不取 repo 锁、不取 target 锁**：它们只读。
//
// 🔴 只读也要如实标注：stale / offline / yanked / degraded / shadowed
//    在**每一次**相关输出里重复出现（§7），因此挂在每一行上，不是只挂顶层。

import { existsSync } from 'node:fs';
import { layout, readLedger } from '../ledger.mjs';
import { planTargets, assertPlanOk, getAdapter } from '../adapters/index.mjs';
import { UsageError, EXIT } from '../exit-codes.mjs';
import { resolveSnapshotForCommand, isDegradable } from './snapshot-access.mjs';
import { annotations, annotationSuffix } from './output.mjs';

/** 枚举本次命令覆盖到的 target（不要求存在 .geoly）。 */
export function targetsFor(ctx, out) {
  const tplan = planTargets({
    clients: ctx.clients,
    scope: ctx.scope,
    home: ctx.home,
    env: ctx.env,
    projectRoot: ctx.projectRoot,
  });
  for (const w of tplan.warnings) out.warn(w);
  assertPlanOk(tplan);
  return tplan;
}

/** 读一个 target 的账本；没有就返回 null（不是错）。 */
export function ledgerOf(target) {
  const P = layout(target);
  if (!existsSync(P.ledger)) return null;
  return readLedger(P.ledger);
}

/** 已装清单：`[{ client, scope, target, name, entry }]` */
export function installedEntries(tplan) {
  const rows = [];
  for (const t of tplan.selected) {
    const L = ledgerOf(t.target);
    if (!L) continue;
    for (const [name, e] of Object.entries(L.entries)) {
      rows.push({ client: t.client, scope: t.scope, target: t.target, name, entry: e });
    }
  }
  return rows;
}

/** §8.2：项目级/全局并存 —— 如实报告，🔴 **不声称哪份生效**。 */
export function shadowMap(ctx, tplan) {
  const m = new Map();
  if (ctx.scope !== 'project') return m;
  for (const t of tplan.selected) {
    const g = getAdapter(t.client).root({ scope: 'global', home: ctx.home, env: ctx.env });
    const L = ledgerOf(g);
    if (!L) continue;
    for (const name of Object.keys(L.entries)) {
      if (!m.has(name)) m.set(name, []);
      m.get(name).push({ client: t.client, globalTarget: g, artifact: L.entries[name].artifact });
    }
  }
  return m;
}

export async function cmdList(ctx, argv, out) {
  const o = { packs: false, installed: false, outdated: false };
  for (const a of argv) {
    if (a === '--packs') o.packs = true;
    else if (a === '--installed') o.installed = true;
    else if (a === '--outdated') o.outdated = true;
    else throw new UsageError(`list 不认得 ${a}`);
  }
  const tplan = targetsFor(ctx, out);
  const installed = installedEntries(tplan);
  const shadowed = shadowMap(ctx, tplan);

  // 🔴 `--installed` 是纯本地的：**不解析快照**，因此离线也一定能跑。
  //    `--outdated` 与默认列表要拿当前快照对照。
  let snap = null;
  let stale = false;
  let snapError = null;
  if (!o.installed || o.outdated) {
    try {
      const r = await resolveSnapshotForCommand(ctx);
      snap = r.snapshot;
      stale = r.stale;
    } catch (e) {
      // 🔴 只有「取不到」（退出码 6）可以降级。stale（8）、完整性（2）、
      //    min-cli（11）必须原样抛出去 —— 吞掉它们等于让 `list` 在一张过期或
      //    被篡改的信任根上照常绿灯。
      if (!isDegradable(e)) throw e;
      // 离线 / 缓存未命中不该让 `list` 整个失败，但**绝不能**默默当成
      // 「没有更新」。如实降级：只列本地，并把每一行标成 offline。
      snapError = e;
      out.warn(`取不到当前快照（${e.message.split('\n')[0]}）：只列本地已装，远端信息标为未知`);
    }
  }
  if (stale) out.warn('timestamp 已过期：以下每一行都按 stale 处理');

  const rows = [];
  if (o.installed || snap === null) {
    for (const r of installed) {
      rows.push({
        annotations: annotations({
          stale,
          offline: ctx.offline || snapError !== null,
          shadowed: shadowed.has(r.name),
        }),
        artifact: r.entry.artifact,
        client: r.client,
        installed: true,
        latest: null,
        name: r.name,
        scope: r.scope,
        snapshot: r.entry.snapshot,
        target: r.target,
      });
    }
  } else {
    const kind = o.packs ? 'pack' : 'skill';
    const byName = new Map(installed.map((r) => [`${r.client} ${r.name}`, r]));
    for (const rec of snap.artifacts) {
      if (rec.kind !== kind) continue;
      // 每个 name 只列它的 latest 那一行（latest 投影已由 parseSnapshot 校验自洽）
      if (snap.latest[`${rec.kind}:${rec.namespace}/${rec.name}`] !== rec.version) continue;
      for (const t of tplan.selected) {
        const hit = byName.get(`${t.client} ${rec.name}`);
        const isOutdated = hit ? hit.entry.artifact !== rec.id : false;
        if (o.outdated && !isOutdated) continue;
        rows.push({
          annotations: annotations({
            stale,
            offline: ctx.offline,
            yanked: rec.status === 'yanked',
            degraded: rec.status === 'degraded',
            shadowed: shadowed.has(rec.name),
          }),
          artifact: hit ? hit.entry.artifact : null,
          client: t.client,
          installed: Boolean(hit),
          latest: rec.id,
          name: rec.name,
          scope: t.scope,
          snapshot: hit ? hit.entry.snapshot : null,
          target: t.target,
        });
      }
    }
  }

  out.line(`list（${rows.length} 行${snap ? `，快照 ${snap.snapshot}` : '，仅本地'}）：`);
  for (const r of rows) {
    const state = r.installed
      ? (r.latest && r.latest !== r.artifact ? 'outdated' : 'installed')
      : 'available';
    out.line(`  ${state.padEnd(10)}${r.client}/${r.scope}  ${r.name}  `
      + `${r.artifact ?? r.latest}${annotationSuffix(r.annotations)}`);
  }
  // §8.2：如实并列，**不声称哪份生效**
  for (const [name, hits] of shadowed) {
    out.line(`  [!] ${name} 项目级与全局并存（全局在 ${hits[0].globalTarget}）——`
      + '生效者取决于客户端，本工具不做判断（04-install.md §8.2）');
  }
  return out.emit('list', {
    rows,
    shadowed: [...shadowed.keys()].sort(),
    snapshot: snap ? snap.snapshot : undefined,
    snapshot_unavailable: snapError ? snapError.message : undefined,
  }, EXIT.OK);
}

export async function cmdSearch(ctx, argv, out) {
  for (const a of argv) if (a.startsWith('-')) throw new UsageError(`search 不认得 ${a}`);
  const kws = argv.filter((a) => !a.startsWith('-'));
  if (kws.length === 0) throw new UsageError('用法：skills-hub search <kw>');
  const { snapshot: snap, stale } = await resolveSnapshotForCommand(ctx);
  if (stale) out.warn('timestamp 已过期：以下每一行都按 stale 处理');

  // 🔴 规格说搜 name / description，但 `description` 在**载荷 manifest** 里，
  //    快照 record 一个字段都没有它（见 snapshot.mjs 的 RECORD_KEYS）。
  //    因此这里只搜 name 与 id，并**如实说明**，不假装搜过 description。
  const needle = kws.map((k) => k.toLowerCase());
  const hits = snap.artifacts.filter(
    (r) => needle.every((k) => r.name.includes(k) || r.id.toLowerCase().includes(k)),
  );
  out.warn('只搜了 name/id：description 在制品的载荷 manifest 里，快照 record 不携带它。');
  out.line(`search（${hits.length} 命中，快照 ${snap.snapshot}）：`);
  const mk = (r) => annotations({
    stale,
    offline: ctx.offline,
    yanked: r.status === 'yanked',
    degraded: r.status === 'degraded',
  });
  for (const r of hits) {
    out.line(`  ${r.id}  status=${r.status}  `
      + `clients=${r.clients.join(',') || '(未声明)'}${annotationSuffix(mk(r))}`);
  }
  return out.emit('search', {
    hits: hits.map((r) => ({
      annotations: mk(r),
      artifact: r.id,
      clients: r.clients,
      name: r.name,
      status: r.status,
    })),
    searched_fields: ['id', 'name'],
    snapshot: snap.snapshot,
  }, EXIT.OK);
}

/** `why <name>` —— 谁请求装的（读账本 `roots` + `requested_by`）。纯本地，不取快照。 */
export async function cmdWhy(ctx, argv, out) {
  for (const a of argv) if (a.startsWith('-')) throw new UsageError(`why 不认得 ${a}`);
  const names = argv.filter((a) => !a.startsWith('-'));
  if (names.length !== 1) throw new UsageError('用法：skills-hub why <name>（恰好一个）');
  const name = names[0];
  const tplan = targetsFor(ctx, out);
  const shadowed = shadowMap(ctx, tplan);

  const found = [];
  for (const t of tplan.selected) {
    const L = ledgerOf(t.target);
    if (!L) continue;
    const e = L.entries[name];
    if (!e) continue;
    found.push({
      annotations: annotations({ offline: ctx.offline, shadowed: shadowed.has(name) }),
      artifact: e.artifact,
      client: t.client,
      generation: e.generation,
      installed_at: e.installed_at,
      requested_by: e.requested_by.map((rk) => ({
        // root 可能已经被删（refcount 归零前后的中间态），如实报告成悬挂边
        record: L.roots[rk] ?? null,
        root: rk,
      })),
      scope: t.scope,
      snapshot: e.snapshot,
      state: e.state,
      target: t.target,
    });
  }

  if (found.length === 0) {
    out.line(`${name} 不在任何被检查的 target 的账本里。`);
    return out.emit('why', { entries: [], name }, EXIT.OK);
  }
  out.line(`why ${name}：`);
  for (const f of found) {
    out.line(`  ${f.client}/${f.scope}  ${f.target}${annotationSuffix(f.annotations)}`);
    out.line(`    artifact=${f.artifact}  snapshot=${f.snapshot}  `
      + `第 ${f.generation} 代  state=${f.state}  installed_at=${f.installed_at}`);
    for (const r of f.requested_by) {
      out.line(`    <- ${r.root}${r.record ? '' : '（该 root 已不在账本里 —— 悬挂边）'}`);
      if (r.record) {
        out.line(`        kind=${r.record.kind} snapshot=${r.record.snapshot} `
          + `intent={no_bundled:${r.record.intent.no_bundled}, pre:${r.record.intent.pre}`
          + `${r.record.intent.allow_yanked ? ', allow_yanked:true' : ''}} `
          + `requested_at=${r.record.requested_at}`);
      }
    }
  }
  return out.emit('why', { entries: found, name }, EXIT.OK);
}
