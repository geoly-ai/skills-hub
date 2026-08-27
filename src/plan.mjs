// plan —— 计划编译、`ledger_image` 构造、每代 attic manifest、`--from-generation` 的
// `postimage` 三方比对与 `--only` 闭包。
//
// 规格：04-install.md §4.2（未认领同名目录、adopt / unadopt）、§5.2 第 6 步、
// §5.3（三种 op）、§5.4.1（结构门：禁止 swap 的 old==new）、§5.4.2（ledger_image）、
// §5.8（每代 manifest 与 reverse_op）、§5.8.1（postimage 的形式化定义与比对）。
//
// 🔴 本模块是**纯编译**：不写盘、不调度、不 import install / recover。

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from './canonical-json.mjs';
import { treeDigest } from './tree-digest.mjs';
import { parseSafeRelPath } from './safe-fs.mjs';
import { Corrupt, bad, isTreeDigest, isUint, assertKeys, assertSafeName } from './journal.mjs';
import { ATTIC_MANIFEST_SCHEMA } from './ledger.mjs';

export { Corrupt };

// ── 结构与元数据的严格验明（§4.2「严格验明」的含义）─────────────────────────

/**
 * 🔴 **不只是** `geoly-tree-v1` 摘要相等 —— 该摘要**不覆盖空目录与部分元数据**
 * （01-artifacts.md §6.2.1）。还必须过最终落位的结构与元数据约束：
 * 目录、空目录、类型、mode、普通文件 `nlink == 1`。
 *
 * ⚠️ **诚实边界**：xattr / ACL 在纯 Node 里读不到（无 `listxattr` 绑定），
 *    因此这一条**本实现证明不了**，只能靠 §7 的解包策略层在**入口**处拒绝。
 *    见交付汇报的「还没被证明的性质」。
 */
export function strictPayloadCheck(dir, { allowEmptyDirs = false } = {}) {
  const problems = [];
  (function rec(d, rel) {
    let names;
    try { names = readdirSync(d); } catch (e) { problems.push(`${rel || '.'} 不可读：${e.code}`); return; }
    if (names.length === 0 && !allowEmptyDirs && rel !== '') {
      problems.push(`空目录 ${rel}（制品禁止空目录）`);
    }
    for (const name of names.sort()) {
      const abs = join(d, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) { problems.push(`symlink ${r}`); continue; }
      if (st.isDirectory()) {
        if ((st.mode & 0o777) !== 0o755) problems.push(`目录 mode 必须是 0755：${r}`);
        rec(abs, r);
        continue;
      }
      if (!st.isFile()) { problems.push(`非普通文件 ${r}`); continue; }
      if (st.nlink !== 1) problems.push(`hardlink（nlink=${st.nlink}）${r}`);
      const mode = st.mode & 0o777;
      if (mode !== 0o644 && mode !== 0o755) problems.push(`文件 mode 只允许 0644/0755：${r}`);
      try { parseSafeRelPath(r); } catch (e) { problems.push(`路径不合法 ${r}：${e.message}`); }
    }
  })(dir, '');
  return problems;
}

/** §4.2：严格验明「那个未认领目录 == 目标制品」——摘要 + 结构与元数据，两者缺一不可 */
export function strictlyMatches(dir, expectDigest) {
  if (!existsSync(dir)) return { ok: false, why: '目录不存在' };
  let d;
  try { d = treeDigest(dir); } catch (e) { return { ok: false, why: `摘要算不出来：${e.message}` }; }
  if (d !== expectDigest) return { ok: false, why: `摘要 ${d} != 期望 ${expectDigest}` };
  const problems = strictPayloadCheck(dir);
  if (problems.length) return { ok: false, why: `结构/元数据不符：${problems.join('; ')}` };
  return { ok: true, digest: d };
}

// ── 计划编译 ─────────────────────────────────────────────────────────────────

/**
 * 把「要装什么 / 要退役什么」编译成一份可写进 journal 的计划。
 *
 * @param {object} o
 * @param {string} o.target                 物理 target 目录
 * @param {object} o.ledger                 当前账本
 * @param {number} o.generation             本次取到的 generation（水位已推进）
 * @param {Array}  [o.install]              [{name, artifact, tree_digest, srcDir, snapshot, requested_by, installed_at}]
 * @param {Array}  [o.retire]               [name]
 * @param {object} [o.roots]                本次要写入的 root 记录 {key: record}
 * @param {Array}  [o.removeRoots]          本次要删除的 root key
 * @param {Set}    [o.replace]              `--replace` 点名的未认领目录
 * @param {Array}  [o.unadopt]              [{name, artifact, tree_digest}]
 * @param {object|null} [o.frozenAttic]     整张 map（不传 = 不改）
 * @param {Array}  [o.auditAppend]          本次要追加的 audit 事件
 */
export function derivePlan(o) {
  const {
    target, ledger, generation,
    install = [], retire = [], roots = {}, removeRoots = [],
    replace = new Set(), unadopt = [], frozenAttic, auditAppend = [], ledgerExisted,
  } = o;
  if (!isUint(generation)) bad('derivePlan：generation 必须是非负整数');
  // 🔴 §5.4.2：`ledger_existed` 表示的是「**本次事务开始之前**」账本存不存在，
  //    不因本次写出的 bootstrap 骨架而改变。默认成 true 会让首次安装的 rollback
  //    把一个本该删掉的空骨架当成「原本就有的账本」保留下来。
  //    所以它**必须显式给**（Codex 第二轮 #17）。
  if (typeof ledgerExisted !== 'boolean') {
    bad('derivePlan：ledgerExisted 必须显式给出（事务开始**之前**账本是否存在）');
  }

  const items = {};
  const adopt = {};
  const unad = {};
  const seen = new Set();
  const claim = (name) => {
    // §5.4 通用规则：**同一事务内计划项的 `name` 必须唯一**（结构门 + 运行时都查）
    if (seen.has(name)) bad(`计划里 name 重复：${name}`);
    parseSafeRelPath(name);            // 目录名必须过路径 grammar
    seen.add(name);
  };

  for (const req of install) {
    claim(req.name);
    const T = join(target, req.name);
    if (!isTreeDigest(req.tree_digest)) bad(`install[${req.name}].tree_digest 形式非法`);
    if (!existsSync(T)) {
      items[req.name] = {
        op: 'install-new', had_old: false, state: 'planned', new_digest: req.tree_digest,
      };
      continue;
    }
    const claimed = Object.hasOwn(ledger.entries, req.name);
    if (!claimed && !replace.has(req.name)) {
      // §4.2：默认阻断。出路只有 `--replace <name>` 或用户自己移走。🔴 不提供泛化 --force。
      bad(`${req.name} 是未被账本认领的同名目录：默认阻断。出路只有 --replace ${req.name} 或自行移走`);
    }
    if (!claimed) {
      // 🔴 §4.2 的「逐字节相同」分支：严格验明相等 → 不构造物理 swap（那会撞上
      //    「禁止 old_digest == new_digest」而被拒），改为 ledger-only 的受管化。
      const m = strictlyMatches(T, req.tree_digest);
      if (m.ok) {
        adopt[req.name] = { artifact: req.artifact, state: 'ok', tree_digest: req.tree_digest };
        continue;
      }
      // §5.6 前提 4：未认领旧目录不满足载荷规则 → **预检直接拒绝 --replace**
      const problems = strictPayloadCheck(T);
      if (problems.length) {
        bad(`--replace ${req.name} 被拒：旧树不满足 §01 的载荷规则 —— ${problems.join('; ')}。`
          + '不为它定义第二套 retired-tree 格式，请自行移走');
      }
    }
    // §5.6：`old_digest` 的来源必须是「首次 rename 之前的实测值」
    const oldDigest = treeDigest(T);
    if (oldDigest === req.tree_digest) {
      // 已认领且逐字节相同：同样不构造物理 swap，走受管化断言（幂等，账本对齐即可）
      adopt[req.name] = { artifact: req.artifact, state: 'ok', tree_digest: req.tree_digest };
      continue;
    }
    items[req.name] = {
      op: 'swap', had_old: true, state: 'planned',
      old_digest: oldDigest, new_digest: req.tree_digest,
    };
  }

  for (const name of retire) {
    claim(name);
    const T = join(target, name);
    if (!existsSync(T)) bad(`retire-only ${name}：target 上没有这个目录`);
    items[name] = { op: 'retire-only', had_old: true, state: 'planned', old_digest: treeDigest(T) };
  }

  for (const u of unadopt) {
    claim(u.name);
    if (!isTreeDigest(u.tree_digest)) bad(`unadopt[${u.name}].tree_digest 形式非法`);
    unad[u.name] = { artifact: u.artifact, state: 'ok', tree_digest: u.tree_digest };
  }

  const ledgerImage = buildLedgerImage({
    ledger, generation, items, adopt, unadopt: unad,
    install, retire, roots, removeRoots, frozenAttic, auditAppend, ledgerExisted,
  });

  const plan = {
    generation,
    tx_dir: `tx-${generation}`,
    items,
    ledger_image: ledgerImage,
    // srcDir 不进 journal（它是本次运行的输入，不是持久状态）
    sources: Object.fromEntries(install.map((r) => [r.name, r.srcDir])),
  };
  // 🔴 §11：没有对应逻辑项时**整个字段缺席**（不写 {}，也不写 null）
  if (Object.keys(adopt).length) plan.adopt_assertions = adopt;
  if (Object.keys(unad).length) plan.unadopt_assertions = unad;
  return plan;
}

/**
 * §5.4.2 `ledger_image`：`{pre, post}` 两份**只含本次会增/改/删的键**的镜像
 * + `ledger_existed` 哨兵。「原本不存在」或「本次删除」用 `null` 哨兵。
 *
 * 🔴 覆盖面必须含**新增 entry、其对应 root、`requested_by` 边、generation** 等
 *    全部实际变化 —— 只写 entry 会留下未定义或悬挂的 root 关系。
 */
export function buildLedgerImage(o) {
  const {
    ledger, generation, items, adopt, unadopt,
    install, retire, roots, removeRoots, frozenAttic, auditAppend, ledgerExisted,
  } = o;
  const touchedEntries = new Set([
    ...Object.keys(items), ...Object.keys(adopt), ...Object.keys(unadopt),
  ]);
  const touchedRoots = new Set([...Object.keys(roots), ...removeRoots]);

  const byName = new Map(install.map((r) => [r.name, r]));
  const retiring = new Set(retire);

  // 新的 entry 值
  const nextEntries = {};
  for (const name of touchedEntries) {
    if (retiring.has(name) || Object.hasOwn(unadopt, name)) { nextEntries[name] = null; continue; }
    const req = byName.get(name);
    if (!req) {
      // 只在 items 里而没有 install 记录 —— 那只能是 retire-only，已在上面处理
      nextEntries[name] = null;
      continue;
    }
    const requestedBy = [...new Set(req.requested_by ?? [])]
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    nextEntries[name] = {
      artifact: req.artifact,
      generation,
      installed_at: req.installed_at,
      requested_by: requestedBy,
      snapshot: req.snapshot,
      state: 'ok',
      tree_digest: req.tree_digest,
    };
    for (const rk of requestedBy) touchedRoots.add(rk);
  }

  // 🔴 requested_by 边的另一半：被删掉的 entry 曾指向的 root 也算「本次变化」
  for (const name of touchedEntries) {
    const old = ledger.entries[name];
    if (old) for (const rk of old.requested_by) touchedRoots.add(rk);
  }

  const pre = { entries: {}, roots: {}, last_applied_generation: ledger.last_applied_generation };
  const post = { entries: {}, roots: {}, last_applied_generation: generation };
  for (const name of touchedEntries) {
    pre.entries[name] = ledger.entries[name] ?? null;
    post.entries[name] = nextEntries[name] ?? null;
  }
  const removing = new Set(removeRoots);
  for (const key of touchedRoots) {
    pre.roots[key] = ledger.roots[key] ?? null;
    if (removing.has(key)) post.roots[key] = null;
    else if (Object.hasOwn(roots, key)) post.roots[key] = roots[key];
    else post.roots[key] = ledger.roots[key] ?? null;
  }
  if (frozenAttic !== undefined) {
    // 🔴 `frozen_attic` 在镜像覆盖范围内，且**按整张 map 存取**（不是逐 label patch）
    pre.frozen_attic = ledger.frozen_attic ?? null;
    post.frozen_attic = frozenAttic;
  }
  if (auditAppend && auditAppend.length) post.audit_append = auditAppend;

  if (typeof ledgerExisted !== 'boolean') bad('buildLedgerImage：ledgerExisted 必须显式给出');
  return { ledger_existed: ledgerExisted, pre, post };
}

// ── 每代 manifest（§5.8）─────────────────────────────────────────────────────

/** 🔴 复位时该项要执行的**正向 op**，不是「一律按 swap」 */
export const REVERSE_OP = {
  swap: 'swap',
  'retire-only': 'install-new',
  'install-new': 'retire-only',
  adopt: 'unadopt',
  unadopt: 'adopt',
};

/**
 * 构造 `attic/<N>/manifest.json`。
 *
 * @param {object} J             本代 journal（已到 cleanup_pending）
 * @param {object} ledgerAfter   本代收尾时的账本（用于算 postimage 基线）
 * @param {string} target        物理 target（digests 要实测）
 */
export function buildManifest(J, ledgerAfter, target, { createdAt }) {
  const items = {};
  for (const [name, it] of Object.entries(J.items)) {
    items[name] = {
      old_digest: it.op === 'install-new' ? null : it.old_digest,
      op: it.op,
      reverse_op: REVERSE_OP[it.op],
      tar: it.op === 'install-new' ? null : `${name}.tar`,
    };
  }
  // 🔴 adopt / unadopt 不参与 A / C 阶段，但**只在 B 阶段进 manifest**
  for (const name of Object.keys(J.adopt_assertions ?? {})) {
    items[name] = { old_digest: null, op: 'adopt', reverse_op: 'unadopt', tar: null };
  }
  for (const name of Object.keys(J.unadopt_assertions ?? {})) {
    items[name] = { old_digest: null, op: 'unadopt', reverse_op: 'adopt', tar: null };
  }

  const delta = ledgerDeltaFromImage(J.ledger_image);
  const postimage = buildPostimage(J, ledgerAfter, target, delta);

  return {
    schema: ATTIC_MANIFEST_SCHEMA,
    created_at: createdAt,
    generation: J.generation,
    items,
    ledger_delta: delta,
    postimage,
  };
}

/**
 * 🔴 `ledger_delta` 是**增量**不是全量：只记本代动过的键（`null` = 复位后应不存在）。
 *    它就是 `ledger_image.pre` —— 「复位后应有的值」。
 */
export function ledgerDeltaFromImage(image) {
  const d = {
    entries: { ...image.pre.entries },
    roots: { ...image.pre.roots },
  };
  // 🔴 frozen_attic 纳入 delta（v11 漏了）；🔴 manifest 一律不含 audit 相关字段
  if ('frozen_attic' in image.pre) d.frozen_attic = image.pre.frozen_attic;
  return d;
}

/**
 * §5.8.1 的形式化定义。基线**固定在「第 N 代收尾那一刻」**。
 *
 * ```
 * E_N = names(本代 items) ∪ keys(本代 ledger_delta.entries)
 * R_N = keys(本代 ledger_delta.roots) ∪ **当时**指向 E_N 的全部 root
 * ```
 */
export function buildPostimage(J, ledgerAfter, target, delta) {
  const E = new Set([
    ...Object.keys(J.items),
    ...Object.keys(J.adopt_assertions ?? {}),
    ...Object.keys(J.unadopt_assertions ?? {}),
    ...Object.keys(delta.entries),
  ]);
  const R = new Set(Object.keys(delta.roots));
  for (const name of E) {
    const e = ledgerAfter.entries[name];
    if (e) for (const rk of e.requested_by) R.add(rk);
  }

  const entries = {}, roots = {}, inEdges = {}, outEdges = {}, digests = {};
  for (const name of [...E].sort()) {
    const e = ledgerAfter.entries[name] ?? null;
    entries[name] = e;
    // 🔴 该 entry **当时的完整入边集**
    inEdges[name] = e ? [...e.requested_by] : [];
    const dir = join(target, name);
    digests[name] = existsSync(dir)
      ? { digest: treeDigest(dir), present: true }
      : { present: false };
  }
  for (const key of [...R].sort()) {
    roots[key] = ledgerAfter.roots[key] ?? null;
    outEdges[key] = Object.entries(ledgerAfter.entries)
      .filter(([, e]) => e.requested_by.includes(key))
      .map(([n]) => n)
      .sort();
  }
  const pi = {
    digests, entries, in_edges: inEdges, out_edges: outEdges, roots,
  };
  // 🔴 整张 map 的全量值（不是「相关 label」）
  if ('frozen_attic' in delta) pi.frozen_attic = ledgerAfter.frozen_attic ?? null;
  return pi;
}

export function validateManifest(M) {
  assertKeys(M, ['schema', 'created_at', 'generation', 'items', 'ledger_delta', 'postimage'], [], 'attic-manifest');
  if (M.schema !== ATTIC_MANIFEST_SCHEMA) bad(`attic-manifest.schema 必须是 ${ATTIC_MANIFEST_SCHEMA}`);
  if (!isUint(M.generation)) bad('attic-manifest.generation 必须是非负整数');
  const OPS = ['swap', 'install-new', 'retire-only', 'adopt', 'unadopt'];
  for (const [name, it] of Object.entries(M.items)) {
    const where = `attic-manifest.items[${name}]`;
    assertSafeName(name, 'attic-manifest.items 的键');
    assertKeys(it, ['op', 'tar', 'old_digest', 'reverse_op'], [], where);
    // 🔴 §11：`op` 与 `reverse_op` **枚举相同**（v42 两侧不一致会让规范自噬）
    if (!OPS.includes(it.op)) bad(`${where}.op 未知取值 ${it.op}`);
    if (!OPS.includes(it.reverse_op)) bad(`${where}.reverse_op 未知取值 ${it.reverse_op}`);
    if (it.reverse_op !== REVERSE_OP[it.op]) bad(`${where}.reverse_op 与 op 不互逆`);
    const nullable = ['install-new', 'adopt', 'unadopt'].includes(it.op);
    if (nullable) {
      if (it.tar !== null || it.old_digest !== null) bad(`${where}：op=${it.op} 时 tar 与 old_digest 必须是 null`);
    } else {
      if (it.tar !== `${name}.tar`) bad(`${where}.tar 必须是 ${name}.tar`);
      if (!isTreeDigest(it.old_digest)) bad(`${where}.old_digest 必须是树摘要`);
    }
  }
  assertKeys(M.ledger_delta, ['entries', 'roots'], ['frozen_attic'], 'attic-manifest.ledger_delta');
  assertKeys(M.postimage, ['digests', 'entries', 'in_edges', 'out_edges', 'roots'], ['frozen_attic'],
    'attic-manifest.postimage');
  for (const [n, d] of Object.entries(M.postimage.digests)) {
    const where = `attic-manifest.postimage.digests[${n}]`;
    assertSafeName(n, 'attic-manifest.postimage.digests 的键');
    // 🔴 显式 tagged 形式，不用裸 null ——「目标应缺席」是一个**正面断言**
    if (d.present === true) assertKeys(d, ['present', 'digest'], [], where);
    else if (d.present === false) assertKeys(d, ['present'], [], where);
    else bad(`${where}.present 必须是布尔`);
    if (d.present && !isTreeDigest(d.digest)) bad(`${where}.digest 必须是树摘要`);
  }
  return M;
}

// ── `--from-generation` 的三方比对与 `--only` 闭包（§5.8 / §5.8.1）───────────

/**
 * 🔴 **绝不把 delta 盲 patch 到当前账本上。** 先把**当前**账本按同样的键集算一遍，
 *    逐项相等才放行。后来新增的 `P → a` 会以「`a` 的当前入边集比 `in_edges[a]`
 *    多了一条 `P`」的形式被抓住。
 *
 * @returns {{conflicts: string[]}}
 */
export function comparePostimage(M, currentLedger, target, { only } = {}) {
  const conflicts = [];
  const sel = selectClosure(M, { only });
  const eq = (a, b) => stringify(a ?? null) === stringify(b ?? null);

  for (const name of sel.entries) {
    if (!eq(currentLedger.entries[name] ?? null, M.postimage.entries[name] ?? null)) {
      conflicts.push(`entries[${name}] 与第 ${M.generation} 代收尾时不同`);
    }
    const want = M.postimage.in_edges[name] ?? [];
    const got = currentLedger.entries[name]?.requested_by ?? [];
    if (!eq([...want].sort(), [...got].sort())) {
      conflicts.push(`in_edges[${name}] 不同：当时 ${JSON.stringify(want)}，现在 ${JSON.stringify(got)}`);
    }
    const d = M.postimage.digests[name];
    const dir = join(target, name);
    if (d.present) {
      if (!existsSync(dir)) conflicts.push(`目标树 ${name} 当时存在，现在缺席`);
      else if (treeDigest(dir) !== d.digest) conflicts.push(`目标树 ${name} 摘要与当时不同`);
    } else if (existsSync(dir)) {
      conflicts.push(`目标树 ${name} 当时应缺席，现在存在`);
    }
  }
  for (const key of sel.roots) {
    if (!eq(currentLedger.roots[key] ?? null, M.postimage.roots[key] ?? null)) {
      conflicts.push(`roots[${key}] 与第 ${M.generation} 代收尾时不同`);
    }
    const want = M.postimage.out_edges[key] ?? [];
    const got = Object.entries(currentLedger.entries)
      .filter(([, e]) => e.requested_by.includes(key)).map(([n]) => n).sort();
    if (!eq([...want].sort(), got)) {
      conflicts.push(`out_edges[${key}] 不同：当时 ${JSON.stringify(want)}，现在 ${JSON.stringify(got)}`);
    }
  }
  if ('frozen_attic' in M.postimage) {
    if (!eq(currentLedger.frozen_attic ?? null, M.postimage.frozen_attic ?? null)) {
      conflicts.push('frozen_attic 与当时不同');
    }
  }
  return { conflicts, selection: sel };
}

/**
 * §5.8.1 的 `--only` 闭包。定义在**第 N 代收尾时的 `E_N` / `R_N` 二部图**上。
 * 🔴 CLI **不自动扩张**到整个连通分量，而是**拒绝并把完整分量列出来**。
 */
export function selectClosure(M, { only } = {}) {
  const E = new Set(Object.keys(M.postimage.entries));
  const R = new Set(Object.keys(M.postimage.roots));
  if (!only || only.length === 0) {
    return {
      entries: [...E].sort(),
      roots: [...R].sort(),
      items: Object.keys(M.items).sort(),
      delta: M.ledger_delta,
      whole: true,
    };
  }
  const seeds = [...new Set(only)];
  for (const s of seeds) if (!E.has(s)) bad(`--only ${s} 不在第 ${M.generation} 代的 E_N 里`);
  // 🔴 只要本代 ledger_delta.frozen_attic 有变化，就禁止部分复位（target 级、切不开）
  if ('frozen_attic' in M.ledger_delta) {
    bad(`第 ${M.generation} 代改动了 frozen_attic（target 级、切不开）：禁止部分复位，请选择整代`);
  }

  const inE = new Set(seeds);
  const inR = new Set();
  for (;;) {
    let grew = false;
    for (const n of [...inE]) {
      for (const rk of M.postimage.in_edges[n] ?? []) if (!inR.has(rk)) { inR.add(rk); grew = true; }
    }
    for (const rk of [...inR]) {
      for (const n of M.postimage.out_edges[rk] ?? []) if (!inE.has(n)) { inE.add(n); grew = true; }
    }
    if (!grew) break;
  }
  // 🔴 闭包不完整（某个 root 的 out_edges 有成员落在 E_N 之外）→ 拒绝
  for (const rk of inR) {
    for (const n of M.postimage.out_edges[rk] ?? []) {
      if (!E.has(n)) bad(`root ${rk} 的成员 ${n} 落在第 ${M.generation} 代的 E_N 之外，闭包无法闭合`);
    }
  }
  const selected = [...inE].sort();
  const missing = selected.filter((n) => !seeds.includes(n));
  if (missing.length) {
    bad(`--only 的闭包不完整：还要一起选 ${missing.join(', ')}`
      + `（完整分量：${selected.join(', ')}）`);
  }
  const selRoots = [...inR].sort();
  // 🔴 `--only` 必须**同时过滤 delta**
  const delta = { entries: {}, roots: {} };
  for (const k of selected) if (k in M.ledger_delta.entries) delta.entries[k] = M.ledger_delta.entries[k];
  for (const k of selRoots) if (k in M.ledger_delta.roots) delta.roots[k] = M.ledger_delta.roots[k];
  return {
    entries: selected,
    roots: selRoots,
    items: Object.keys(M.items).filter((n) => inE.has(n)).sort(),
    delta,
    whole: false,
  };
}
