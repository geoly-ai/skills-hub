// pack 模型 —— 规范：03-packs.md（权威）、01-artifacts.md §3/§5.2、
//                    04-install.md §4/§4.1/§8.1、05-lifecycle.md §5.1。
//
// 本模块是**纯函数**层：不碰磁盘、不碰网络、不碰账本文件。它回答四类问题：
//   §2   这份 pack.json 合法吗（成员锁定、role、conflicts 形态、contract_paths）
//   §3   声明 compatible 站得住吗（契约文件零差异门 + D8 的绕过面护栏）
//   §4   这个 pack 现在能装吗、装出哪些成员、refcount 怎么加减、升级差集是什么
//   §5   yank 闭包：它现在是 published 还是 degraded，被谁拖累
//
// 🔴 与 `artifact.mjs` 的分工：`assertManifestBinding()` 做的是 §5.3 的
// **ArtifactId 绑定**，顺带对 pack.json 做了一个**子集**校验（schema、键集、
// 成员 id 是精确版本、tree_digest 形状）。本模块做的是**全量语义**校验。
// 两处存在同一份文档的两个校验器 —— 这正是 R-11 反复出现的形状。
// 约束方向写死在 `test/pack.test.mjs` 的属性测试里：
// **凡 `validatePackManifest()` 接受的 doc，`assertManifestBinding()` 也必须接受。**
// （反向不成立，也不应成立：本模块严格更强。）
import { WireError, assertExactKeys, assertString, assertStringArray, assertUint, assertTreeDigest } from './trust.mjs';
import { parseSemver, compareSemver } from './snapshot.mjs';
import { PACK_MANIFEST_SCHEMA } from './artifact.mjs';

export { PACK_MANIFEST_SCHEMA };

const bad = (code, msg) => { throw new WireError(code, msg); };

// ── ArtifactId（01-artifacts.md §3） ───────────────────────────────────────
// ⚠️ 这两条 grammar 与 `snapshot.mjs` 里的 RE_NAMESPACE / RE_NAME 是同一份规格，
//    但那边没有导出。重复定义即是分叉风险，因此 test/pack.test.mjs 里有一条
//    交叉测试：同一批候选 ns/name，`parseArtifactId` 与 `parseSnapshot` 的判定必须一致。
const RE_NAMESPACE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const RE_NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
export const KINDS = Object.freeze(['skill', 'pack']);

/**
 * 解析 `<kind>:<namespace>/<name>@<version>`。
 * 🔴 **不接受 range**：`^1.2`、`~1.2`、`*`、空格一律拒 —— range 意味着
 *    「装的时候才知道装到什么」，那样 pack 的树摘要就不代表一次可复现的安装（§2）。
 */
export function parseArtifactId(id, where = 'artifact id') {
  assertString(id, where);
  const at = id.lastIndexOf('@');
  const colon = id.indexOf(':');
  if (colon === -1 || at === -1 || at < colon) bad('E_ARTIFACT_ID', `${where} 不是 <kind>:<ns>/<name>@<version>：${id}`);
  const kind = id.slice(0, colon);
  const rest = id.slice(colon + 1, at);
  const version = id.slice(at + 1);
  if (!KINDS.includes(kind)) bad('E_ARTIFACT_ID', `${where}.kind 只能是 skill / pack，得到 ${JSON.stringify(kind)}`);
  const slash = rest.indexOf('/');
  if (slash === -1 || rest.indexOf('/', slash + 1) !== -1) bad('E_ARTIFACT_ID', `${where} 的 <ns>/<name> 部分不合法：${id}`);
  const namespace = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (!RE_NAMESPACE.test(namespace)) bad('E_NAMESPACE', `${where}.namespace 不合 grammar：${JSON.stringify(namespace)}`);
  if (!RE_NAME.test(name)) bad('E_NAME', `${where}.name 不合 grammar：${JSON.stringify(name)}`);
  const semver = parseSemver(version, `${where}.version`);
  return { kind, namespace, name, version, semver, id };
}

export function formatArtifactId({ kind, namespace, name, version }) {
  return `${kind}:${namespace}/${name}@${version}`;
}

// ── root key grammar（04-install.md §8.1） ──────────────────────────────────

/**
 * ```
 * root-key := "pack:" <ns> "/" <name> "@" <version>
 *           | "direct:" <kind> ":" <ns> "/" <name> "@" <version>
 *           | "all@snapshot:" <N>
 * ```
 * 🔴 `<N>` 是**纯十进制、无前导零**：R-11 记着「lockfile 读侧接受 `all@snapshot:01`
 *    这类别名」。同一个 root 有两种写法，唯一性与排序就都不成立了。
 *
 * 🔴 R-11 的另一半：`validateRoot()` 不校验 root key 的 grammar，`../escape`
 *    能当 root key 被接受。本函数是那道缺失的门；接线由上层做（本模块不改 ledger.mjs）。
 */
export function parseRootKey(key, where = 'root key') {
  assertString(key, where);
  if (key.startsWith('all@snapshot:')) {
    const n = key.slice('all@snapshot:'.length);
    if (!/^(0|[1-9]\d*)$/.test(n)) bad('E_ROOT_KEY', `${where}：all@snapshot 的 N 必须是无前导零的十进制整数，得到 ${JSON.stringify(n)}`);
    if (!Number.isSafeInteger(Number(n))) bad('E_ROOT_KEY', `${where}：snapshot 号超出安全整数范围`);
    return { kind: 'all', snapshot: Number(n), key };
  }
  if (key.startsWith('direct:')) {
    const a = parseArtifactId(key.slice('direct:'.length), `${where}.artifact`);
    return { kind: 'direct', artifact: a, key };
  }
  if (key.startsWith('pack:')) {
    const a = parseArtifactId(key, `${where}.artifact`);
    if (a.kind !== 'pack') bad('E_ROOT_KEY', `${where}：pack root 的 artifact 必须是 pack:，得到 ${a.kind}`);
    return { kind: 'pack', artifact: a, key };
  }
  bad('E_ROOT_KEY', `${where} 不合 grammar（pack: / direct: / all@snapshot:）：${JSON.stringify(key)}`);
}

// ── conflicts 形态（§2.3） ──────────────────────────────────────────────────

/**
 * 只支持三种，**不支持正则**：
 *   ① 精确 ArtifactId    `skill:geoly/foo@1.0.0`
 *   ② `<kind>:<ns>/<name>`（任意版本）
 *   ③ `<kind>:<*>/<name>`（任意 namespace；`<*>` 处必须正好是一个星号）
 * 🔴 星号只能整段出现在 namespace 位。部分通配（`skill:ge*` 开头）、
 *    namespace 与 name 同时通配、只有 `skill:*` 而没有 name —— 一律拒。
 *    规范没写的组合不给「合理默认」。
 */
export function parseConflictPattern(p, where = 'conflicts[]') {
  assertString(p, where);
  const colon = p.indexOf(':');
  if (colon === -1) bad('E_CONFLICT_FORM', `${where} 缺少 <kind>: 前缀：${p}`);
  const kind = p.slice(0, colon);
  if (!KINDS.includes(kind)) bad('E_CONFLICT_FORM', `${where}.kind 只能是 skill / pack：${p}`);
  const rest = p.slice(colon + 1);
  if (rest.includes('@')) {
    const a = parseArtifactId(p, where);
    return { form: 'exact', kind, namespace: a.namespace, name: a.name, version: a.version, raw: p };
  }
  const slash = rest.indexOf('/');
  if (slash === -1 || rest.indexOf('/', slash + 1) !== -1) bad('E_CONFLICT_FORM', `${where} 必须形如 <kind>:<ns>/<name> 或 <kind>:*/<name>：${p}`);
  const ns = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (!RE_NAME.test(name)) bad('E_CONFLICT_FORM', `${where} 的 name 不合 grammar（不支持通配 / 正则）：${JSON.stringify(name)}`);
  if (ns === '*') return { form: 'any-namespace', kind, namespace: '*', name, raw: p };
  if (!RE_NAMESPACE.test(ns)) bad('E_CONFLICT_FORM', `${where} 的 namespace 只能是合法 namespace 或整段 *：${JSON.stringify(ns)}`);
  return { form: 'any-version', kind, namespace: ns, name, raw: p };
}

/** 某个已装/待装制品是否命中该 conflicts 项。`id` 必须是精确 ArtifactId。 */
export function conflictMatches(pattern, id) {
  const pat = typeof pattern === 'string' ? parseConflictPattern(pattern) : pattern;
  const a = typeof id === 'string' ? parseArtifactId(id) : id;
  if (pat.kind !== a.kind || pat.name !== a.name) return false;
  if (pat.form === 'any-namespace') return true;
  if (pat.namespace !== a.namespace) return false;
  return pat.form === 'any-version' ? true : pat.version === a.version;
}

// ── contract_paths（§2 + §3.1 的 D8 绕过面） ────────────────────────────────

const RE_CP_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * contract_paths 的受限 glob。
 *
 * 🔴 规范只给了两个例子（`a/b/c.md` 与 `*​/matrix-contract.md`），没有定义 glob 语法。
 *    按「规范没明确允许的组合一律拒绝」定为：**`*` 只能作为一整个 segment**，
 *    匹配恰好一层且不跨 `/`；**没有 `**`、没有部分通配（`foo*`）、没有字符类、没有正则**。
 *
 *    为什么要卡这么死：这是一道**安全门**的输入。部分通配与 `**` 会让「这条 pattern
 *    到底覆盖哪些文件」变成需要推理的问题，而 D8 说得很清楚，contract_paths 本身
 *    就是绕过面 —— 门的覆盖范围必须一眼看得出来，否则作者可以用一条看起来很宽的
 *    pattern 实际只覆盖到零个文件。
 */
export function validateContractPath(p, where = 'contract_paths[]') {
  assertString(p, where);
  if (p === '') bad('E_CONTRACT_PATH', `${where} 为空`);
  if (p.startsWith('/')) bad('E_CONTRACT_PATH', `${where} 必须是相对路径：${p}`);
  if (p.includes('\\')) bad('E_CONTRACT_PATH', `${where} 含反斜杠：${p}`);
  if (p.includes('\0')) bad('E_CONTRACT_PATH', `${where} 含 NUL`);
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '') bad('E_CONTRACT_PATH', `${where} 含空 segment：${p}`);
    if (s === '.' || s === '..') bad('E_CONTRACT_PATH', `${where} 含 ${s}：${p}`);
    if (s === '*') continue;
    if (s.includes('*')) bad('E_CONTRACT_PATH', `${where}：* 只能作为一整个 segment，不支持部分通配：${JSON.stringify(s)}`);
    if (!RE_CP_SEGMENT.test(s)) bad('E_CONTRACT_PATH', `${where} 的 segment 不是 ASCII-only [A-Za-z0-9._-]：${JSON.stringify(s)}`);
  }
  return segs;
}

/** pattern 是否命中某条制品内路径。段数必须相等（`*` 不跨层）。 */
export function matchContractPath(pattern, path) {
  const pat = validateContractPath(pattern);
  const segs = path.split('/');
  if (pat.length !== segs.length) return false;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '*') continue;
    if (pat[i] !== segs[i]) return false;
  }
  return true;
}

/**
 * 🔴 §3.1 护栏①：**实际生效的清单 = 本版声明 ∪ 上一版声明。只能加，不能减。**
 * v1 让作者自报清单，作者清空清单即可让门形同虚设。
 */
export function effectiveContractPaths(current, previous = []) {
  const set = new Set();
  for (const p of current) { validateContractPath(p, 'contract_paths[]（本版）'); set.add(p); }
  for (const p of previous) { validateContractPath(p, 'contract_paths[]（上一版）'); set.add(p); }
  return [...set].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}

/**
 * 🔴 §3.1 护栏②：`contract_paths` 本身发生变更（无论增减）→ 该 PR 自动升为 **Tier 2**。
 * @returns {{changed:boolean, added:string[], removed:string[], tier:number}}
 */
export function contractPathsChanged(current, previous = []) {
  const cur = new Set(current), prev = new Set(previous);
  const added = [...cur].filter(p => !prev.has(p)).sort();
  const removed = [...prev].filter(p => !cur.has(p)).sort();
  const changed = added.length > 0 || removed.length > 0;
  return { changed, added, removed, tier: changed ? 2 : 1 };
}

/**
 * 「除版本戳与日期外」的归一化。
 *
 * 🔴 **刻意做窄**：只替换①调用方明确给出的两个版本字符串（本版与 previous），
 * ②`YYYY-MM-DD` 形状的日期。不做通用 semver 正则 —— 那会把契约正文里任何
 * 形如 `1.2.3` 的内容（阈值、编号、示例）一并抹掉，等于给绕过开一扇门。
 *
 * ⚠️ 仍有残余绕过面：把实质变更藏进一个日期字面量里（`2026-01-01` → `1999-12-31`）
 * 本门看不见。规范原文就是这么写的，这条如实记在交付汇报里。
 */
function normalizeContractText(buf, { currentVersion, previousVersion }) {
  let s = buf.toString('utf8');
  for (const v of [currentVersion, previousVersion]) {
    if (typeof v === 'string' && v !== '') s = s.split(v).join(' VERSION ');
  }
  return s.replace(/\d{4}-\d{2}-\d{2}/g, ' DATE ');
}

/**
 * 🔴 `compatibility.previous` 必须是**同一 lineage 的直接前一版**。
 *
 * 不校验的话，作者可以把 `previous` 指向任意一个更早的版本，从而**跳过中间版本的
 * contract_paths 集合**（护栏①的并集只并到那一版为止），门就被绕开了。
 * 规范没有明写这一条 —— 它是 D8 那两条护栏能成立的前提，Codex 第一轮点出。
 *
 * @param {string} previous
 * @param {string[]} publishedVersions 该 `<ns>/<name>` 下已发布的全部版本
 */
export function assertPreviousIsDirectAncestor(previous, publishedVersions, where = 'compatibility.previous') {
  const installable = publishedVersions
    .map(v => parseSemver(v, where))
    .sort(compareSemver);
  if (installable.length === 0) bad('E_COMPAT_PREVIOUS', `${where}：该 pack 还没有任何已发布版本，不该有 previous`);
  const highest = installable[installable.length - 1];
  if (highest.raw !== previous) {
    bad('E_COMPAT_PREVIOUS',
      `${where} 是 ${previous}，但该 pack 已发布的最高版本是 ${highest.raw}。`
      + `previous 必须指向直接前一版 —— 跳版会漏掉中间版本的 contract_paths 集合（§3.1 护栏①）`);
  }
  return highest;
}

/**
 * §3 兼容性门：声明 `compatible` 时，比对本版与 `previous` 版在**生效** contract_paths
 * 命中的全部文件；除版本戳与日期外只要有差异 → 拒绝 `compatible`。
 *
 * 🔴 文件的**增加与删除**同样算差异 —— 只比「两边都有的」等于放行「把契约文件删掉」，
 *    也放行「改个名躲开 glob」。比较集合是**两版命中路径的并集**。
 *
 * 🔴 **同时返回两套差异**（Codex 第一轮：全文件正则归一化本身就是绕过面）：
 *    · `differences`      —— 归一化之后仍存在的差异，这是规范定义的门；
 *    · `strictDifferences` —— **逐字节**差异，不做任何归一化。
 *    只在 `strictDifferences` 里出现、而不在 `differences` 里的文件，意思是
 *    「它只在版本戳/日期上变了」。🔴 **CI 必须把这批文件打印出来交人看**，
 *    不能因为门开了就当它们没变过 —— 把实质变更伪装成日期字面量正是这条的绕过法。
 *
 * @returns {{ok, effective, matched, differences, strictDifferences, normalizedOnly, tier}}
 */
export function checkPackCompat({
  kind, contractPaths, previousContractPaths = [],
  currentFiles, previousFiles, currentVersion, previousVersion,
}) {
  if (kind !== 'compatible' && kind !== 'breaking') {
    bad('E_COMPAT_KIND', `compatibility.kind 只能是 compatible / breaking，得到 ${JSON.stringify(kind)}`);
  }
  const effective = effectiveContractPaths(contractPaths, previousContractPaths);
  const all = new Set([...currentFiles.keys(), ...previousFiles.keys()]);
  const matched = [...all].filter(p => effective.some(pat => matchContractPath(pat, p))).sort();
  const differences = [];
  const strictDifferences = [];
  for (const p of matched) {
    const a = currentFiles.get(p), b = previousFiles.get(p);
    if (a === undefined) { differences.push({ path: p, why: 'removed' }); strictDifferences.push({ path: p, why: 'removed' }); continue; }
    if (b === undefined) { differences.push({ path: p, why: 'added' }); strictDifferences.push({ path: p, why: 'added' }); continue; }
    if (!a.equals(b)) strictDifferences.push({ path: p, why: 'changed' });
    const na = normalizeContractText(a, { currentVersion, previousVersion });
    const nb = normalizeContractText(b, { currentVersion, previousVersion });
    if (na !== nb) differences.push({ path: p, why: 'changed' });
  }
  const soft = new Set(differences.map(d => d.path));
  const normalizedOnly = strictDifferences.map(d => d.path).filter(p => !soft.has(p));
  // breaking 不需要过这道门（它就是在承认有差异）
  const ok = kind === 'breaking' || differences.length === 0;
  return {
    ok, effective, matched, differences, strictDifferences, normalizedOnly,
    tier: contractPathsChanged(contractPaths, previousContractPaths).tier,
  };
}

// ── pack.json 全量校验（§2） ────────────────────────────────────────────────

const PACK_KEYS = {
  required: ['schema', 'kind', 'namespace', 'name', 'version', 'description', 'license',
    'members', 'bundled', 'conflicts', 'contract_paths', 'compatibility'],
};
const MEMBER_KEYS = { required: ['id', 'tree_digest', 'role'], optional: ['order'] };
const COMPAT_KEYS = { required: ['previous', 'kind', 'breaking_reasons'] };

/** `members` 里只允许 role=matrix，`bundled` 里只允许 role=tool（见下面的说明）。 */
const ROLE_OF_LIST = Object.freeze({ members: 'matrix', bundled: 'tool' });

/**
 * §2 全量校验。返回归一化后的 pack 模型。
 *
 * 🔴 **`role` 必须与它所在的列表一致**（`members`→`matrix`，`bundled`→`tool`）。
 * 规范用一张表把 role 映到安装行为，又用两个列表区分必装/可跳过 —— 这是**两个
 * 真值来源**。不强制一致的话，`members` 里放一条 `role: tool` 就能让一个必装成员
 * 变成 `--no-bundled` 可跳过的，而 §5 的 degraded 判定却仍按「它在 members 里」算。
 * 那正好是一个绕过面：yank 了它，pack 却不 degraded，装出来还缺东西。
 */
export function validatePackManifest(doc, where = 'pack.json') {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) bad('E_WIRE_TYPE', `${where} 必须是对象`);
  assertExactKeys(doc, PACK_KEYS, where);
  if (doc.schema !== PACK_MANIFEST_SCHEMA) {
    bad('E_SCHEMA', `${where}.schema 必须是 ${PACK_MANIFEST_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
  }
  if (doc.kind !== 'pack') bad('E_KIND', `${where}.kind 必须是 pack，得到 ${JSON.stringify(doc.kind)}`);
  if (!RE_NAMESPACE.test(assertString(doc.namespace, `${where}.namespace`))) {
    bad('E_NAMESPACE', `${where}.namespace 不合 grammar：${doc.namespace}`);
  }
  if (!RE_NAME.test(assertString(doc.name, `${where}.name`))) {
    bad('E_NAME', `${where}.name 不合 grammar：${doc.name}`);
  }
  const selfSemver = parseSemver(doc.version, `${where}.version`);
  assertString(doc.description, `${where}.description`);
  assertString(doc.license, `${where}.license`);

  // conflicts（§2.3）
  assertStringArray(doc.conflicts, `${where}.conflicts`);
  const conflicts = doc.conflicts.map((c, i) => parseConflictPattern(c, `${where}.conflicts[${i}]`));

  // contract_paths（§2 + §3.1）
  assertStringArray(doc.contract_paths, `${where}.contract_paths`);
  doc.contract_paths.forEach((p, i) => validateContractPath(p, `${where}.contract_paths[${i}]`));
  if (new Set(doc.contract_paths).size !== doc.contract_paths.length) {
    bad('E_CONTRACT_PATH', `${where}.contract_paths 有重复项`);
  }

  // compatibility（§3）
  assertExactKeys(doc.compatibility, COMPAT_KEYS, `${where}.compatibility`);
  const compat = doc.compatibility;
  if (compat.kind !== 'compatible' && compat.kind !== 'breaking') {
    bad('E_COMPAT_KIND', `${where}.compatibility.kind 只能是 compatible / breaking，得到 ${JSON.stringify(compat.kind)}`);
  }
  assertStringArray(compat.breaking_reasons, `${where}.compatibility.breaking_reasons`);
  if (compat.previous !== null) {
    const prev = parseSemver(compat.previous, `${where}.compatibility.previous`);
    if (compareSemver(prev, selfSemver) >= 0) {
      bad('E_COMPAT_PREVIOUS', `${where}.compatibility.previous (${compat.previous}) 必须严格小于本版 (${doc.version})`);
    }
  } else if (compat.kind === 'compatible') {
    // 首版没有 previous 可比 → 契约零差异门无从执行。声明 compatible 是**无意义的**，
    // 而无意义的声明会被当成「过了门」。fail-closed。
    bad('E_COMPAT_PREVIOUS', `${where}.compatibility.previous 为 null（首版）时不得声明 compatible —— 没有可比对象，§3 的零差异门无从执行`);
  }
  if (compat.kind === 'compatible' && compat.breaking_reasons.length > 0) {
    bad('E_COMPAT_KIND', `${where}.compatibility 声明 compatible 却列了 breaking_reasons`);
  }

  // members / bundled（§2 成员锁定 + §2.2 role）
  const seen = new Map();
  const lists = {};
  for (const listName of ['members', 'bundled']) {
    const list = doc[listName];
    if (!Array.isArray(list)) bad('E_WIRE_TYPE', `${where}.${listName} 必须是数组`);
    lists[listName] = list.map((m, i) => {
      const w = `${where}.${listName}[${i}]`;
      if (m === null || typeof m !== 'object' || Array.isArray(m)) bad('E_WIRE_TYPE', `${w} 必须是对象`);
      assertExactKeys(m, MEMBER_KEYS, w);
      const a = parseArtifactId(m.id, `${w}.id`);
      assertTreeDigest(m.tree_digest, `${w}.tree_digest`);
      assertString(m.role, `${w}.role`);
      if (m.role !== ROLE_OF_LIST[listName]) {
        bad('E_PACK_ROLE', `${w}.role 是 ${JSON.stringify(m.role)}，但它在 ${listName} 里 —— ${listName} 只允许 role=${ROLE_OF_LIST[listName]}（§2.2）`);
      }
      if (Object.hasOwn(m, 'order')) assertUint(m.order, `${w}.order`);
      // 🔴 同一个成员不得在两个列表里出现，也不得重复：否则「必装还是可跳过」有两个答案，
      //    §5 的 degraded 判定与 --no-bundled 会给出互相矛盾的结果。
      if (seen.has(m.id)) bad('E_PACK_MEMBER_DUP', `${w}.id 重复出现：${m.id}（先前在 ${seen.get(m.id)}）`);
      seen.set(m.id, listName);
      // pack 不得把自己列为成员（自引用闭包不收敛）
      if (a.kind === 'pack' && a.namespace === doc.namespace && a.name === doc.name) {
        bad('E_PACK_SELF_MEMBER', `${w}.id 引用了 pack 自己：${m.id}`);
      }
      return { ...m, parsed: a, list: listName };
    });
  }
  if (lists.members.length === 0) {
    bad('E_PACK_NO_MEMBERS', `${where}.members 为空 —— 缺一个成员的矩阵不是矩阵（§2.2），空矩阵更不是`);
  }

  return {
    ...doc,
    members: lists.members,
    bundled: lists.bundled,
    conflicts,
    _semver: selfSemver,
    id: formatArtifactId({ kind: 'pack', namespace: doc.namespace, name: doc.name, version: doc.version }),
  };
}

// ── §2.1 clients / capabilities 的推导 ─────────────────────────────────────

/**
 * 🔴 pack **不声明** `clients` / `capabilities`；registry 对 pack 记录的这两个字段
 * 由 promotion **计算**并写入快照。
 *
 * `clients` = 全体 `members` 的 clients **交集**（`bundled` 不参与 —— 它可被
 * `--no-bundled` 跳过，让它参与交集会让一个可跳过的成员否掉整个 pack 的可装性）。
 * 交集为空 → 该 pack 不可安装，promotion 阶段直接拒绝。
 */
export function derivePackClients(memberRecords) {
  if (!Array.isArray(memberRecords) || memberRecords.length === 0) {
    bad('E_PACK_NO_MEMBERS', 'derivePackClients：members 不能为空');
  }
  let acc = null;
  for (const r of memberRecords) {
    const s = new Set(r.clients);
    acc = acc === null ? s : new Set([...acc].filter(c => s.has(c)));
  }
  return [...acc].sort();
}

/** `capabilities` = 全体 `members` + `bundled` 的**并集**；pack 自身审查 Tier 取最高。 */
export function derivePackCapabilities(allRecords) {
  const s = new Set();
  for (const r of allRecords) for (const c of r.capabilities) s.add(c);
  return [...s].sort();
}

// ── §5 yank 闭包 ───────────────────────────────────────────────────────────

const INSTALLABLE_MEMBER_STATUS = new Set(['published', 'deprecated']);

/**
 * 🔴 §5：**yank 一个 skill 不会自动 yank 引用它的 pack** —— pack 不可变，改不了
 * 它锁定的成员。受影响的 pack 在**下一张快照**里被重算为 `degraded`。
 *
 * | 情形 | status | 能否新装 |
 * |---|---|---|
 * | 全部成员 published / deprecated | published | 能 |
 * | 任一 members（必装）被 yank | **degraded** | 否，报错点名成员与 advisory |
 * | 只有 bundled 成员被 yank | published | 能，但那项被跳过并告警 |
 * | pack 自身被 yank | yanked | 否 |
 *
 * 🔴 **`degraded` 是派生状态，必须由 promotion 每次重算并写进快照** —— 快照是签名
 * 对象，状态必须在签名覆盖范围内。**不得在运行时算出来当真值用。** 本函数就是
 * promotion 侧的那一次计算；安装侧只读快照里的 `status`。
 *
 * 🔴 **成员缺失（不在快照里）按 degraded 记**，且比被 yank 更糟：yank 至少留着文件
 * 可取证，缺失连取证对象都没有。规范只列了 yank，但两者对「能不能装」的答案相同，
 * 而 fail-open 会让一个引用了不存在成员的 pack 显示成 published。
 *
 * 🔴 **成员本身是 pack 且为 degraded → 传递上来**（§4 解析顺序第 2 步：
 * 「所属 pack 为 degraded → 整个安装终止」）。不传递的话嵌套 pack 就是一个绕过面。
 *
 * @param {object} a
 * @param {'published'|'deprecated'|'yanked'} a.selfStatus  pack 自身在快照里的 status
 * @param {object} a.manifest  validatePackManifest() 的结果
 * @param {(id:string)=>({status:string, advisory?:string}|undefined)} a.statusOf
 * @returns {{status:string, degradedBy:Array, skippedBundled:Array}}
 */
export function computePackStatus({ selfStatus, manifest, statusOf }) {
  if (selfStatus === 'yanked') return { status: 'yanked', degradedBy: [], skippedBundled: [] };
  if (selfStatus === 'degraded') {
    // 传进来的就是派生值，不能拿它当输入再算一遍（会把上一次的结论当事实）
    bad('E_PACK_STATUS_INPUT', 'computePackStatus 的 selfStatus 不接受 degraded —— 它是本函数的输出，不是输入');
  }
  const degradedBy = [];
  const skippedBundled = [];
  const look = (m) => {
    const r = statusOf(m.id);
    if (r === undefined) return { reason: 'missing', status: null, advisory: undefined };
    if (INSTALLABLE_MEMBER_STATUS.has(r.status)) return null;
    return { reason: r.status, status: r.status, advisory: r.advisory };
  };
  for (const m of manifest.members) {
    const problem = look(m);
    if (problem) degradedBy.push({ id: m.id, role: m.role, ...problem });
  }
  for (const m of manifest.bundled) {
    const problem = look(m);
    if (problem) skippedBundled.push({ id: m.id, role: m.role, ...problem });
  }
  return {
    status: degradedBy.length > 0 ? 'degraded' : (selfStatus === 'deprecated' ? 'deprecated' : 'published'),
    degradedBy,
    skippedBundled,
  };
}

/**
 * 🔴 **嵌套 pack 的传递闭包**（Codex 第一轮 #2）。
 *
 * `computePackStatus()` 只看直接成员的 `status`。当成员本身是 pack 时，那个
 * status 也是派生的 —— 如果 promotion 没有按**拓扑序**重算，外层看到的就是上一张
 * 快照的陈旧值。本函数自己把闭包算完，并且：
 *
 * 🔴 **检测环**。`A → B → A` 在朴素递归下要么不终止、要么按访问顺序得到不确定的结果。
 *    环本身就是非法的（pack 不可变，环意味着两个 pack 互相锁定对方的摘要，
 *    第一个都发布不出来），所以判为**错误而不是 degraded**。
 *
 * 🔴 **按边的 role 算，不是按节点状态算**：同一个 nested pack 可以在 X 处是必装、
 *    在 Y 处是 bundled。它 degraded 只应该拖垮把它列为必装的那一个。
 *
 * @param {object} a
 * @param {string} a.rootId
 * @param {(id:string)=>({status:string, advisory?:string, manifest?:object}|undefined)} a.lookup
 *        对 pack 成员必须返回 `manifest`（validatePackManifest 的结果），否则无法下探。
 * @returns {Map<string, {status, degradedBy, skippedBundled}>} 闭包内每个 pack 的结论
 */
export function computePackStatusClosure({ rootId, lookup }) {
  const out = new Map();
  const state = new Map(); // id -> 'visiting' | 'done'

  const visit = (id, stack) => {
    if (state.get(id) === 'done') return out.get(id);
    if (state.get(id) === 'visiting') {
      bad('E_PACK_CYCLE', `pack 成员图有环：${[...stack, id].join(' → ')}`);
    }
    const rec = lookup(id);
    if (rec === undefined) return undefined;              // 缺失由调用方按 missing 处理
    if (rec.manifest === undefined) return { status: rec.status, degradedBy: [], skippedBundled: [] };
    state.set(id, 'visiting');
    const next = [...stack, id];

    // 🔴 **先无条件走一遍成员图，再谈状态。**
    //    早先的写法把 `selfStatus === 'yanked'` 的短路放在遍历之前，于是
    //    「一个 yanked 的 pack 参与的环」根本走不到检测点（Codex 第二轮 #2 的反例：
    //    A(yanked) → B(published) → A，从 A 出发不报环，只返回 A=yanked）。
    //    环是**图的性质**，与节点当下是什么状态无关；用状态去短路图的遍历，
    //    等于让攻击者靠 yank 一个节点把环藏起来。
    for (const m of [...rec.manifest.members, ...rec.manifest.bundled]) {
      if (parseArtifactId(m.id, 'member id').kind === 'pack') visit(m.id, next);
    }

    let res;
    if (rec.status === 'yanked') {
      res = { status: 'yanked', degradedBy: [], skippedBundled: [] };
    } else {
      const statusOf = (mid) => {
        const r = lookup(mid);
        if (r === undefined) return undefined;
        const parsed = parseArtifactId(mid, 'member id');
        if (parsed.kind !== 'pack') return { status: r.status, advisory: r.advisory };
        const sub = out.get(mid);
        if (sub === undefined) return { status: r.status, advisory: r.advisory };
        return { status: sub.status, advisory: r.advisory };
      };
      res = computePackStatus({
        selfStatus: rec.status === 'degraded' ? 'published' : rec.status,
        manifest: rec.manifest,
        statusOf,
      });
    }
    state.set(id, 'done');
    out.set(id, res);
    return res;
  };

  // 🔴 root 查不到不是「空结果」，是拒绝。返回空 Map 会让调用方以为
  //    「这个 pack 没问题，只是没有子图」（Codex 第二轮 #2）。
  if (lookup(rootId) === undefined) bad('E_PACK_MISSING', `${rootId} 不在快照里`);
  visit(rootId, []);
  return out;
}

// ── §5 latest 排除 degraded / 02-registry.md §2.3 ──────────────────────────

/**
 * 🔴 `latest` 排除 `degraded`（与 yanked、prerelease 一样）。
 * 否则 `install pack:x`（不带版本）会选中最高版、而它恰好 degraded，**安装必然失败**。
 *
 * 全部版本都 degraded → 返回 `null`，并由 `explainNoInstallableVersion()` 列出
 * 每个版本被哪个成员拖累（§5 末段明确要求「列出各版本被哪个成员拖累」）。
 *
 * @param {Array<{version:string,status:string}>} candidates
 * @param {{pre?:boolean}} [opts] `--pre` 时才考虑预发布
 */
export function selectInstallableVersion(candidates, { pre = false } = {}) {
  let best = null;
  for (const c of candidates) {
    if (c.status === 'yanked' || c.status === 'degraded') continue;
    const sv = parseSemver(c.version, 'version');
    if (sv.prerelease !== null && !pre) continue;
    if (best === null || compareSemver(sv, best.semver) > 0) best = { ...c, semver: sv };
  }
  return best;
}

export function explainNoInstallableVersion(candidates, degradedByVersion = new Map()) {
  return candidates
    .map(c => ({
      version: c.version,
      status: c.status,
      degraded_by: (degradedByVersion.get(c.version) ?? []).map(d => d.id),
    }))
    .sort((a, b) => compareSemver(parseSemver(a.version, 'v'), parseSemver(b.version, 'v')));
}

// ── §4 安装解析 ────────────────────────────────────────────────────────────

/**
 * §4 的解析顺序 1–5（本函数覆盖 2–4；第 1 步验签验摘要由 artifact.mjs 做，
 * 第 5 步的暂存/交换由 install.mjs 做）。
 *
 * 🔴 **任何一个成员不存在 / 摘要不符 / 是 degraded 的 pack → 整个安装终止。**
 * 不做「跳过坏的装剩下的」—— 缺一个成员的矩阵不是矩阵（§2.2）。
 *
 * 🔴 **`--allow-yanked` 不放行 `degraded`**（§5）：所以本函数没有任何参数
 * 能让 degraded 通过。这是刻意的 —— 有那个参数就一定会有人传。
 *
 * @param {object} a
 * @param {object} a.manifest        validatePackManifest() 的结果
 * @param {object} a.packRecord      快照里 pack 自己的 record（含 status / clients）
 * @param {(id:string)=>object|undefined} a.lookup  快照查询：id → record
 * @param {{noBundled?:boolean, allowYanked?:boolean}} [a.intent]
 * @param {string} [a.client]        目标 target 的 client（§4 第 3 步）
 * @returns {{install:Array, skipped:Array, conflicts:Array, clients:string[]}}
 */
export function resolvePackInstall({ manifest, packRecord, lookup, intent = {}, client = null }) {
  const { noBundled = false, allowYanked = false } = intent;

  // 第 1 步的收尾：pack 自身的状态门
  if (packRecord.status === 'degraded') {
    bad('E_PACK_DEGRADED',
      `${manifest.id} 在快照里是 degraded，不可新装。`
      + `--allow-yanked 不放行 degraded（03-packs.md §5 / 04-install.md §8.1.1）`);
  }
  if (packRecord.status === 'yanked' && !allowYanked) {
    bad('E_PACK_YANKED', `${manifest.id} 已被 yank，不可新装`);
  }

  // 🔴 pack.json 里冗余记的 tree_digest 必须与快照里那份一致；不一致 → **终止**
  //    并报告为完整性事件（§2）。
  const install = [];
  const skipped = [];
  const wanted = [
    ...manifest.members.map(m => ({ m, required: true })),
    ...manifest.bundled.map(m => ({ m, required: false })),
  ];
  for (const { m, required } of wanted) {
    if (!required && noBundled) { skipped.push({ id: m.id, why: 'no-bundled' }); continue; }
    const rec = lookup(m.id);
    if (rec === undefined) {
      bad('E_PACK_MEMBER_MISSING', `成员 ${m.id} 不在快照里，整个安装终止（§4 第 2 步）`);
    }
    if (rec.tree_digest !== m.tree_digest) {
      bad('E_PACK_MEMBER_DIGEST',
        `完整性事件：成员 ${m.id} 在 pack.json 里锁的是 ${m.tree_digest}，`
        + `快照里是 ${rec.tree_digest}（§2：两处不一致 → 终止并报告）`);
    }
    if (rec.status === 'degraded') {
      // 🔴 **规范缺口，按「与 §5 的 bundled 行一致」决议**（Codex 两轮都点到）。
      //
      //    §4 第 2 步说「所属 pack 为 degraded → 整个安装终止」，没区分必装与 bundled；
      //    §5 的表只为 **yanked** 的 bundled 开了「跳过并告警」的口子，没提 degraded。
      //
      //    我第一版选了 fail-closed（bundled degraded 也终止）。Codex 第二轮指出那会
      //    造成一处**语义不一致**：`computePackStatus()` 按 §5 把 bundled 的问题只记进
      //    `skippedBundled`、pack 自身仍算 `published`，于是**快照写着 published、
      //    普通安装却必然失败**。用户看到的是「它说能装，装不上」——
      //    两个真值来源，正是本仓库反复在消灭的形状。
      //
      //    统一到哪一边？统一到 §5：**bundled 成员按定义就是可跳过的**，
      //    它 degraded 与它被 yank 对「这个 pack 还能不能装」的答案应该相同。
      //    拒绝安装并不更安全 —— 用户加个 `--no-bundled` 就过了，只是多绕一圈；
      //    而不一致是会误导人的。跳过时**必须告警**（调用方读 `skipped` 的 why）。
      //
      //    ⚠️ 这条是取舍不是定论。要反过来选 fail-closed 也行，但**两处必须同时改**：
      //    这里 + `computePackStatus()` 对 bundled 的处理。已写进交付汇报待拍板。
      if (required) {
        bad('E_PACK_MEMBER_DEGRADED', `必装成员 ${m.id} 是 degraded 的 pack，整个安装终止（§4 第 2 步）`);
      }
      skipped.push({ id: m.id, why: 'bundled-degraded' });
      continue;
    }
    if (rec.status === 'yanked') {
      if (required) {
        bad('E_PACK_MEMBER_YANKED',
          `必装成员 ${m.id} 已被 yank，本 pack 应当是 degraded 状态；拒绝安装`);
      }
      // bundled 被 yank：§5 —— 跳过并告警，pack 仍是 published
      skipped.push({ id: m.id, why: 'bundled-yanked' });
      continue;
    }
    install.push({ id: m.id, role: m.role, required, record: rec, tree_digest: m.tree_digest });
  }

  // 第 3 步：客户端兼容性。pack 的 clients 是成员交集，由 promotion 写进快照。
  if (client !== null && !packRecord.clients.includes(client)) {
    bad('E_CLIENT_UNSUPPORTED',
      `${manifest.id} 的 clients（成员交集）不含 ${client}（§4 第 3 步）`);
  }

  // 第 4 步：冲突清单（由调用方与 target 现状比对后决定是否需要 --replace <name>）
  const conflicts = manifest.conflicts.map(c => c.raw);

  return { install, skipped, conflicts, clients: packRecord.clients };
}

// ── §4.1 refcount ──────────────────────────────────────────────────────────

const byteAsc = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// 🔴🔴 **这一节全是纯函数，它们不定义「什么时候生效」——上层必须把它们用在
//        `ledger_image.post` 里，且只在 04-install.md §5.2 的第 9 步。**
//
// Codex 第一轮 #3 的结论，逐条抄在这里免得接线时走偏：
//   · 不得在 `commitPoint`、下载、stage、或「某个成员装成功了」的时刻改 roots/refcount；
//     部分成员失败会留下 pack root 与悬挂的 `requested_by`。
//   · 顺序是：① 全部物理交换完成 → ② 目标树摘要复验通过 → ③ assertions 复验通过
//     → ④ 才把 roots / requested_by 写进 ledger post，一次原子写。
//   · 升级时「删旧 root + 加新 root + 成员差集的引用变化」必须在**同一个 post image** 里。
//   · `requested_by` 变空之后的**物理删除属于同一个事务**，不是本模块 API 的即时副作用。
//     所以 `removeRequestedBy()` 只回一个 `removeDirectory` 标志，它自己不删任何东西。

/**
 * 每个成员在账本里的 `requested_by` 追加一个 **root key 字符串**。
 * 🔴 去重 + 字节序严格升序 —— `ledger.validateEntry()` 就是这么校的，写入端必须
 *    先满足读回端（R-11 的判据：写入端接受的每一个输入，读取端都必须接受）。
 * 🔴 root key 过 grammar：R-11 记着「`../escape` 能当 root key 被接受」。
 */
export function addRequestedBy(list, rootKey) {
  parseRootKey(rootKey);
  const s = new Set(list);
  s.add(rootKey);
  return [...s].sort(byteAsc);
}

/**
 * `remove <skill>` 只在移除请求方后 `requested_by` 为空时才真正删目录（§4.1）。
 * @returns {{requested_by:string[], removeDirectory:boolean}}
 */
export function removeRequestedBy(list, rootKey) {
  parseRootKey(rootKey);
  const next = list.filter(k => k !== rootKey).sort(byteAsc);
  return { requested_by: next, removeDirectory: next.length === 0 };
}

/**
 * 校验一份账本的 root ↔ requested_by 图是闭合的。
 * 🔴 R-11 的第二条：`validateEntry()` 不确认 `requested_by` 指向同一 ledger 的 root，
 *    悬挂键要到投影 lockfile 时才被拒。本函数是那道缺失的门（上层接线）。
 */
export function assertRefGraphClosed(ledger, where = 'ledger') {
  const roots = new Set(Object.keys(ledger.roots ?? {}));
  for (const k of roots) parseRootKey(k, `${where}.roots[${k}]`);
  for (const [name, e] of Object.entries(ledger.entries ?? {})) {
    for (const k of e.requested_by ?? []) {
      if (!roots.has(k)) {
        bad('E_REF_DANGLING', `${where}.entries[${name}].requested_by 里的 ${JSON.stringify(k)} 不在 roots 里（悬挂引用）`);
      }
    }
  }
  return true;
}

// ── §4.2 升级 ──────────────────────────────────────────────────────────────

/**
 * `update pack:<name>`：解析新 pack → 成员差集。
 * 版本变化则同事务替换；新增则安装；移除则减引用，空了才删。
 *
 * 🔴 **绝不因「成员集合变了」就整体拒绝更新**（那是先例 `update.py` 为矩阵一致性
 * 做的规则，§4.2 明令不要）。
 *
 * 比对键是 `<kind>:<ns>/<name>`（不含版本）—— 同一个 skill 换了版本是 `changed`，
 * 不是「删一个加一个」。
 */
export function diffPackMembers(oldManifest, newManifest) {
  const key = (m) => `${m.parsed.kind}:${m.parsed.namespace}/${m.parsed.name}`;
  const idx = (man) => new Map([...man.members, ...man.bundled].map(m => [key(m), m]));
  const a = idx(oldManifest), b = idx(newManifest);
  const added = [], removed = [], changed = [], unchanged = [];
  for (const [k, m] of b) {
    const old = a.get(k);
    if (old === undefined) { added.push({ key: k, to: m }); continue; }
    if (old.id !== m.id || old.tree_digest !== m.tree_digest || old.list !== m.list) {
      changed.push({ key: k, from: old, to: m });
    } else unchanged.push({ key: k, member: m });
  }
  for (const [k, m] of a) if (!b.has(k)) removed.push({ key: k, from: m });
  const byKey = (x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  return { added: added.sort(byKey), removed: removed.sort(byKey), changed: changed.sort(byKey), unchanged: unchanged.sort(byKey) };
}

export { WireError };
