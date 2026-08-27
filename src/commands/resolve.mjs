// 制品 spec 的解析 —— 09-cli.md §5「解析规则」。
//
//   1. 含 `@` → 精确版本；否则取 `latest`（非 yank、非 prerelease、**非 degraded**）。
//   2. 含 `/` → namespace 已定；否则 ①先在 `geoly` 里找 ②全快照找唯一匹配
//      ③多 namespace 同名 → **报错列候选**，不猜。
//   3. `pack:` 前缀强制 kind；无前缀且同名同时存在 skill 与 pack → 报错列候选。
//   4. 目标 pack 的全部版本都 `degraded` → 报「无可安装版本」并列出各版本被哪个成员拖累。
//
// 🔴 「不猜」是这条规则的全部意义。任何一处 fallback 都会让同一条命令在不同快照下
//    装出不同东西，而用户完全看不出来。

import { UsageError, AmbiguousError, ConflictError } from '../exit-codes.mjs';
import { compareSemver, parseSemver } from '../snapshot.mjs';

export const DEFAULT_NAMESPACE = 'geoly';

const RE_SPEC = /^(?:(skill|pack):)?(?:([a-z0-9][a-z0-9-]*)\/)?([a-z0-9][a-z0-9-]*)(?:@(.+))?$/;

/** 把一条 spec 拆成 `{ kind, namespace, name, version }`，缺席的为 `null`。 */
export function parseSpec(spec) {
  if (typeof spec !== 'string' || spec === '') throw new UsageError('制品 spec 不能为空');
  const m = RE_SPEC.exec(spec);
  if (!m) {
    throw new UsageError(
      `制品 spec 不合 grammar：${spec}\n`
      + '  形如 `[skill:|pack:][<namespace>/]<name>[@<version>]`，'
      + 'namespace 与 name 只允许小写字母、数字与连字符。',
    );
  }
  const [, kind, namespace, name, version] = m;
  if (version !== undefined) parseSemver(version, `spec ${spec} 的版本`);   // 形式非法即拒
  return { raw: spec, kind: kind ?? null, namespace: namespace ?? null, name, version: version ?? null };
}

/**
 * 在快照里解析一条 spec，返回**唯一**的 record。
 *
 * @param {object} snap    `parseSnapshot()` 的产物
 * @param {object} q       `parseSpec()` 的产物
 * @param {object} o
 * @param {boolean} o.pre         允许预发布版本
 * @param {boolean} o.allowYanked 允许装 yanked（🔴 只放行 `yanked`，**绝不放行 `degraded`**，§8.1.1）
 */
export function resolveSpec(snap, q, { pre = false, allowYanked = false } = {}) {
  // ── 规则 2/3：先把候选收窄到「同名」的全部 record ────────────────────────
  let pool = snap.artifacts.filter((r) => r.name === q.name);
  if (q.kind) pool = pool.filter((r) => r.kind === q.kind);
  if (q.namespace) pool = pool.filter((r) => r.namespace === q.namespace);
  if (pool.length === 0) {
    throw new UsageError(
      `快照 ${snap.snapshot} 里找不到 ${q.raw}。`
      + (q.namespace ? '' : `（未指定 namespace 时先找 ${DEFAULT_NAMESPACE}，再找全快照的唯一匹配）`),
      { telemetryReason: 'not-found' },
    );
  }

  // 规则 3：无 kind 前缀而 skill 与 pack 同名 → 报错列候选
  if (!q.kind) {
    const kinds = [...new Set(pool.map((r) => r.kind))].sort();
    if (kinds.length > 1) {
      throw new AmbiguousError(
        `${q.name} 在快照 ${snap.snapshot} 里同时存在 skill 与 pack —— 请加前缀点名：\n`
        + kinds.map((k) => `  ${k}:${q.name}`).join('\n'),
        kinds.map((k) => `${k}:${q.name}`),
      );
    }
  }

  // 规则 2：namespace 没定 → ① geoly ② 全快照唯一匹配 ③ 多 namespace 同名报错
  if (!q.namespace) {
    const inDefault = pool.filter((r) => r.namespace === DEFAULT_NAMESPACE);
    if (inDefault.length > 0) pool = inDefault;
    else {
      const nss = [...new Set(pool.map((r) => r.namespace))].sort();
      if (nss.length > 1) {
        throw new AmbiguousError(
          `${q.name} 在多个 namespace 下都存在，不猜 —— 请点名其中一个：\n`
          + nss.map((ns) => `  ${ns}/${q.name}`).join('\n'),
          nss.map((ns) => `${ns}/${q.name}`),
        );
      }
    }
  }

  const kind = pool[0].kind;
  const ns = pool[0].namespace;

  // ── 规则 1：精确版本 ─────────────────────────────────────────────────────
  if (q.version !== null) {
    const rec = pool.find((r) => r.version === q.version);
    if (!rec) {
      throw new UsageError(
        `${kind}:${ns}/${q.name}@${q.version} 不在快照 ${snap.snapshot} 里。已有版本：`
        + pool.map((r) => r.version).sort().join(', '),
        { telemetryReason: 'not-found' },
      );
    }
    assertInstallable(rec, snap, { allowYanked });
    return rec;
  }

  // ── 规则 1：latest ───────────────────────────────────────────────────────
  // 🔴 snapshot.latest 已经由 `parseSnapshot()` 校验过自洽（非 yank、非 prerelease、
  //    **非 degraded** 的最高版本）。默认路径直接用它，不自己再算一遍 ——
  //    自己算就会和快照的 latest 投影分叉。
  if (!pre) {
    const key = `${kind}:${ns}/${q.name}`;
    const v = snap.latest[key];
    if (v === undefined) {
      // 规则 4：一个可装版本都没有 —— 说清是被什么挡住的
      throw noInstallableVersion(kind, ns, q.name, pool, snap);
    }
    const rec = pool.find((r) => r.version === v);
    assertInstallable(rec, snap, { allowYanked });
    return rec;
  }

  // `--pre`：把预发布也纳入，仍然排除 yanked 与 degraded
  const cands = pool.filter((r) => r.status !== 'yanked' && r.status !== 'degraded');
  if (cands.length === 0) throw noInstallableVersion(kind, ns, q.name, pool, snap);
  cands.sort((a, b) => compareSemver(a._semver, b._semver));
  const rec = cands[cands.length - 1];
  assertInstallable(rec, snap, { allowYanked });
  return rec;
}

function noInstallableVersion(kind, ns, name, pool, snap) {
  const lines = pool
    .slice()
    .sort((a, b) => (a.version < b.version ? -1 : 1))
    .map((r) => {
      if (r.status !== 'degraded') return `  ${r.version} —— status=${r.status}`;
      // 规则 4：列出**各版本被哪个成员拖累**。degraded 是 pack 的状态，
      // 成员信息在 pack 的载荷里而不在快照 record 里 —— 快照能给的只有
      // 「该 pack 版本被标记为 degraded」。🔴 如实说清楚这一点，不要假装知道成员名。
      return `  ${r.version} —— degraded（被某个已 yank 的成员拖累；成员清单在 pack 载荷里，`
        + `快照 record 不携带，需取回该 pack 后才能列出）`;
    });
  return new ConflictError(
    `${kind}:${ns}/${name} 在快照 ${snap.snapshot} 里没有可安装版本：\n${lines.join('\n')}\n`
    + '🔴 --allow-yanked 只放行 yanked，**绝不放行 degraded**（04-install.md §8.1.1）。'
    + '要装就自己按成员逐个装。',
    { telemetryReason: 'version-conflict' },
  );
}

/** 状态门。🔴 `--allow-yanked` 只放行 `yanked` 一种（§8.1.1）。 */
export function assertInstallable(rec, snap, { allowYanked = false } = {}) {
  if (rec.status === 'degraded') {
    throw new ConflictError(
      `${rec.id} 的状态是 degraded（某个成员被 yank）。`
      + '🔴 --allow-yanked **不放行 degraded**（04-install.md §8.1.1）——'
      + '它是针对具体制品的知情豁免，而 degraded 会连带装一个你没有豁免过的成员。'
      + '要装请按成员逐个装。',
      { telemetryReason: 'version-conflict' },
    );
  }
  if (rec.status === 'yanked') {
    if (!allowYanked) {
      const y = snap.yanked.find((x) => x.id === rec.id);
      throw new ConflictError(
        `${rec.id} 已被 yank：${y?.reason ?? '（快照未给原因）'}`
        + (y?.advisory ? `\n  advisory：${y.advisory}` : '')
        + (y?.superseded_by ? `\n  已被 ${y.superseded_by} 取代` : '')
        + '\n  要取证安装请显式给 --allow-yanked（会大声告警并写进账本）。',
        { telemetryReason: 'yanked' },
      );
    }
  }
  return rec;
}
