// 快照 → 站点视图模型。
//
// 🔴 **本文件的唯一纪律：页面上的每一项都必须能指回一个来源。**
//    每一条派生数据都带 `source` 或 `note`，三种来源严格分开：
//      · `snapshot`  —— 快照 record 里真的有这个字段；
//      · `payload`   —— 快照里没有，来自工作树载荷，且已按 tree_digest 核对（payload.mjs）；
//      · `derived`   —— 本站点按公开规则算出来的（§7 的 capability→Tier 表、分布计数、
//                       §5 的 yank 闭包复算）。算的规则写在注释里，页面上标成「本站点算的」。
//
// 🔴 **没有的东西不造**。装机量 / 下载量 / 调用量 —— 埋点是纯本地的、没有内置上报端点
//    （docs/telemetry/00-spec.md §4），所以这类数字**根本不存在**，模型里连字段都不留。
//    留一个恒为 null 的字段，下一个人就会把它接上一个编出来的数。

import { compareSemver } from '../../src/snapshot.mjs';
import { computePackStatusClosure, derivePackClients, derivePackCapabilities } from '../../src/pack.mjs';
import { capabilityTier } from '../../scripts/promote/build-inputs.mjs';

/** §7 的分级表在 `scripts/promote/build-inputs.mjs` 里，这里只借它的判定，不抄一份。 */
function tierOfCapability(name) {
  try {
    return capabilityTier([name]);
  } catch {
    return null;
  }
}

/**
 * 一条 record 的**声明 Tier**：capabilities 按 §7 表算出来的最高档。
 *
 * 🔴 它与 `review.capability_tier` **不是一回事，页面上必须并列展示、不能混称**：
 *    · `review.capability_tier` 是**审那一次记录下来的**等级，写在签名快照里；
 *    · 这里算的是**本站点按当前 §7 表**对 capabilities 的解释。
 *    两者可以合法地不相等 —— 比如 pack 因 `contract_paths` 变更被强制按 Tier 2 审（D8），
 *    而它的 capabilities 并集只到 Tier 0。所以不相等**不等于**有问题，
 *    页面只把两个数摆出来并说明差异可能的来源，不下「谁错了」的结论。
 */
function declaredTier(capabilities) {
  if (capabilities.length === 0) return null;
  try {
    return capabilityTier(capabilities);
  } catch {
    return null;
  }
}

/** 路径段安全：ns/name 的 grammar 与 semver 都不含 `/`，但生成静态路由前再断言一次。 */
function assertSegment(v, where) {
  if (typeof v !== 'string' || v.length === 0 || v.includes('/') || v.includes('\\')
      || v === '.' || v === '..' || v.startsWith('.')) {
    throw new Error(`${where} 不能安全地做路由段：${JSON.stringify(v)}`);
  }
  return v;
}

function countBy(rows, pick) {
  const m = new Map();
  for (const r of rows) {
    // 🔴 **同一条 record 内先去重再计数**：`clients: ['claude','claude']` 不该让
    //    claude 的计数变成 2 —— 分布回答的是「有多少个制品支持它」。
    for (const v of new Set(pick(r))) m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .map(([value, count]) => ({ value, count }));
}

/**
 * pack 的 clients 交集 / capabilities 并集的**独立复算**（03-packs.md §2.1）。
 *
 * 🔴 复算不是为了取代 record 里的值 —— record 那两个是 promotion 算的、在签名覆盖范围内，
 *    页面展示的始终是它们。复算只回答一个问题：「拿现在这份载荷和这些成员 record，
 *    按同一条规则算，还能不能算出同一个答案」。
 * 🔴 **对不上时两个都摆出来，不静默择一**。静默择一等于替读者做了一个他看不见的判断，
 *    而这里恰恰是最该让人看见的地方。
 */
function derivedView({ record, members, bundled, recordsById }) {
  const memberRecs = [];
  const allRecs = [];
  for (const m of members) {
    const r = recordsById.get(m.id);
    if (r === undefined) return { available: false, reason: `成员 ${m.id} 不在快照里，无法复算` };
    memberRecs.push(r); allRecs.push(r);
  }
  for (const m of bundled) {
    const r = recordsById.get(m.id);
    if (r === undefined) return { available: false, reason: `bundled 成员 ${m.id} 不在快照里，无法复算` };
    allRecs.push(r);
  }
  try {
    const clients = derivePackClients(memberRecs);
    const capabilities = derivePackCapabilities(allRecs);
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    return {
      available: true,
      clients,
      capabilities,
      clients_match: same(clients, record.clients),
      capabilities_match: same(capabilities, record.capabilities),
    };
  } catch (err) {
    return { available: false, reason: `复算失败：${err.message}` };
  }
}

/**
 * 从 `rootId` 出发，找出成员图里**拿不到已核对 manifest 的 pack**。
 *
 * 🔴 **必须自己走图，不能只看闭包算出来的那些节点。**
 *    `computePackStatusClosure()` 遇到没有 manifest 的 pack 就把它当叶子，
 *    于是它**根本不会进入闭包的键集** —— 早先按「闭包键集里谁没有 manifest」来判，
 *    只能发现根的直接成员那一层：`根 → A(有 manifest) → B(没有)` 里的 B 会被漏掉，
 *    页面于是把一次不完整的归因宣布成完整的（Codex 2026-09-01 P1）。
 *    归因是否完整这件事，恰恰只能由「图上还有多少地方看不见」来回答。
 */
function opaquePacksUnder(rootId, manifests) {
  const opaque = new Set();
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;          // 环也在这里终止：环本身由闭包算法负责报错
    seen.add(id);
    const man = manifests.get(id);
    if (man === undefined) { opaque.add(id); return; }
    for (const m of [...man.members, ...man.bundled]) {
      if (m.id.startsWith('pack:')) visit(m.id);
    }
  };
  visit(rootId);
  opaque.delete(rootId);               // 根自己没有 manifest 时走不到这里（调用方已判）
  return [...opaque];
}

/**
 * pack 的成员视图 + `degraded` 归因。
 *
 * 🔴 **快照里没有 `degraded_by`**。`status: "degraded"` 只说「装不了」，不说被谁拖累。
 *    要点名就必须拿到载荷里的 `pack.json`，而且要把嵌套 pack 的图走完
 *    —— 拖累源可以是「必装成员被 yank」，也可以是「必装成员根本不在快照里」，
 *    还可以是「必装成员是另一个 degraded 的 pack」（03-packs.md §5、pack.mjs 的闭包）。
 *    所以只要图没走全，结论就只能叫**部分归因**，不能叫原因。
 */
function packView({ record, manifests, recordsById }) {
  const manifest = manifests.get(record.id);
  if (manifest === undefined) {
    return {
      members_available: false,
      note: '成员列表在载荷的 pack.json 里，快照 record 不携带它；本次构建拿不到已核对的载荷，'
        + '因此不展示成员，也无法说明 degraded 被谁拖累。',
      members: [], bundled: [], derived: null, blame: null,
    };
  }

  const viewMember = (m, role) => {
    const sub = recordsById.get(m.id);
    return {
      id: m.id,
      role: m.role,
      order: m.order ?? null,
      locked_tree_digest: m.tree_digest,        // pack.json 锁定的（载荷来源）
      in_snapshot: sub !== undefined,
      status: sub?.status ?? null,
      // 🔴 pack.json 锁的是**精确版本 + 精确树摘要**。两者对不上就是完整性事件，
      //    promotion 会直接拒；这里如实标出来而不是悄悄按「找到了」处理。
      digest_matches: sub === undefined ? null : sub.tree_digest === m.tree_digest,
      required: role === 'members',
    };
  };
  const members = manifest.members.map((m) => viewMember(m, 'members'));
  const bundled = manifest.bundled.map((m) => viewMember(m, 'bundled'));

  // ── degraded 归因：用**与 promotion 同一个**闭包算法复算 ────────────────
  const opaque = opaquePacksUnder(record.id, manifests);
  let blame = null;
  try {
    const lookup = (id) => {
      const r = recordsById.get(id);
      if (r === undefined) return undefined;
      return { status: r.status, manifest: manifests.get(id) };
    };
    const closure = computePackStatusClosure({ rootId: record.id, lookup });
    const res = closure.get(record.id);
    blame = {
      recomputed_status: res?.status ?? null,
      // 🔴 快照的 status 是签名覆盖的权威值；复算只是**核对**。不一致时两个都摆出来，
      //    不替谁下结论 —— 复算的输入（载荷）本身就比快照弱一等。
      matches_snapshot: res === undefined ? null : res.status === record.status,
      degraded_by: res?.degradedBy ?? [],
      skipped_bundled: res?.skippedBundled ?? [],
      complete: opaque.length === 0,
      opaque_packs: opaque,
    };
  } catch (err) {
    blame = { error: err.message, complete: false, degraded_by: [], skipped_bundled: [], opaque_packs: opaque };
  }

  return {
    members_available: true,
    note: '成员来自载荷的 pack.json；该载荷重新打包出的 tree_digest 与快照 record 相等。'
      + '两者在本页均未验签。',
    members,
    bundled,
    // clients 交集 / capabilities 并集：record 里那两个是 promotion 算好、**签名覆盖**的，
    // 页面展示的就是它们。这里用**与 promotion 同一对函数**独立复算一遍做核对
    // （03-packs.md §2.1：clients 取 members 的交集，capabilities 取 members+bundled 的并集）。
    derived: derivedView({ record, members, bundled, recordsById }),
    blame,
  };
}

/**
 * @param {object} a
 * @param {object} a.snapshot parseSnapshot() 的结果
 * @param {Map<string, {state:string, note:string, manifest?:object}>} a.payloads id → 载荷核对结果
 */
export function buildModel({ snapshot, payloads }) {
  const recordsById = new Map(snapshot.artifacts.map((r) => [r.id, r]));
  const yankById = new Map(snapshot.yanked.map((y) => [y.id, y]));
  const manifests = new Map();
  for (const [id, p] of payloads) if (p.state === 'verified') manifests.set(id, p.manifest);

  const artifacts = snapshot.artifacts.map((r) => {
    assertSegment(r.kind, 'kind');
    assertSegment(r.namespace, 'namespace');
    assertSegment(r.name, 'name');
    assertSegment(r.version, 'version');
    const key = `${r.kind}:${r.namespace}/${r.name}`;
    const payload = payloads.get(r.id) ?? { state: 'absent', note: '未核对' };
    const manifest = manifests.get(r.id);

    return {
      // ── 快照 record 原样（每一项都在 RECORD_KEYS 里）──────────────────
      id: r.id,
      kind: r.kind,
      namespace: r.namespace,
      name: r.name,
      version: r.version,
      path: r.path,
      tree_digest: r.tree_digest,
      asset: { file: r.asset.file, sha256: r.asset.sha256, size: r.asset.size },
      clients: r.clients,
      capabilities: r.capabilities.map((c) => ({ name: c, tier: tierOfCapability(c) })),
      replaces: r.replaces,
      conflicts: r.conflicts,
      license: r.license,
      owner: r.owner,
      provenance: r.provenance,
      status: r.status,
      review: r.review,

      // ── 本站点算的 ────────────────────────────────────────────────────
      group_key: key,
      declared_tier: declaredTier(r.capabilities),
      is_prerelease: r._semver.prerelease !== null,
      is_latest: snapshot.latest[key] === r.version,
      yank: yankById.get(r.id) ?? null,
      install_command: `skills-hub install ${r.id}`,
      href: `/artifact/${r.kind}/${r.namespace}/${r.name}/${r.version}`,
      group_href: `/artifact/${r.kind}/${r.namespace}/${r.name}`,

      // ── 载荷来源（快照里没有的那些）────────────────────────────────────
      payload: { state: payload.state, note: payload.note },
      // 🔴 `description` **不在快照 record 里**（RECORD_KEYS 没有它，CLI 的 query
      //    也因此如实只搜 name/id）。只有载荷核对通过时才有值，且标成 payload 来源。
      description: manifest?.description ?? null,
      pack: r.kind === 'pack' ? packView({ record: r, manifests, recordsById }) : null,
    };
  });

  // ── 同名制品的版本历史 ───────────────────────────────────────────────────
  const groupMap = new Map();
  for (const a of artifacts) {
    if (!groupMap.has(a.group_key)) {
      groupMap.set(a.group_key, {
        key: a.group_key, kind: a.kind, namespace: a.namespace, name: a.name,
        href: a.group_href, versions: [],
        latest: snapshot.latest[a.group_key] ?? null,
      });
    }
    groupMap.get(a.group_key).versions.push(a);
  }
  const groups = [...groupMap.values()].sort((x, y) => (x.key < y.key ? -1 : 1));
  for (const g of groups) {
    // 版本从新到旧。比较用**读取端同一个** compareSemver（正式版 > 预发布那条规则在里面）。
    const semverOf = new Map(snapshot.artifacts.map((r) => [r.id, r._semver]));
    g.versions.sort((a, b) => compareSemver(semverOf.get(b.id), semverOf.get(a.id)));
    // 🔴 `latest` 缺席是有意义的信号，不是「数据缺失」：全部版本都被 yank 或 degraded 时
    //    该 key 根本不进 latest 投影（02-registry.md §2.3 / 03-packs.md §5）。
    g.latest_absent_reason = g.latest !== null ? null
      : '该制品当前没有可安装版本：全部版本都是 yanked / degraded / 预发布（latest 投影会排除这三类）';
  }

  return {
    snapshot: {
      schema: snapshot.schema,
      snapshot: snapshot.snapshot,
      previous: snapshot.previous,
      created_at: snapshot.created_at,
      repo: snapshot.repo,
      artifact_count: snapshot.artifacts.length,
      yanked_count: snapshot.yanked.length,
      latest_count: Object.keys(snapshot.latest).length,
    },
    latest: snapshot.latest,
    yanked: snapshot.yanked.map((y) => ({
      ...y,
      href: recordsById.has(y.id) ? artifacts.find((a) => a.id === y.id).href : null,
    })),
    artifacts,
    groups: groups.map((g) => ({
      key: g.key, kind: g.kind, namespace: g.namespace, name: g.name, href: g.href,
      latest: g.latest, latest_absent_reason: g.latest_absent_reason,
      versions: g.versions.map((v) => v.id),
    })),
    distributions: {
      kind: countBy(artifacts, (a) => [a.kind]),
      namespace: countBy(artifacts, (a) => [a.namespace]),
      status: countBy(artifacts, (a) => [a.status]),
      capability: countBy(artifacts, (a) => a.capabilities.map((c) => c.name)),
      client: countBy(artifacts, (a) => a.clients),
      // Tier 分布用**本站点按 §7 算的**声明 Tier，不是 review.capability_tier ——
      // 两者语义不同（见 declaredTier 的注释），混在一张图里就成了一个说不清的数。
      declared_tier: countBy(artifacts, (a) => (a.declared_tier === null ? [] : [`Tier ${a.declared_tier}`])),
    },
    payload_coverage: countBy(artifacts, (a) => [a.payload.state]),
  };
}
