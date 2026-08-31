#!/usr/bin/env node
// 投稿的结构门（§6 那张表里**尚无实现**的那几条）—— 06-submission.md §6。
//
// 🔴 **只写还不存在的那几条。** §6 的表里大半已经有实现了，本模块不重写它们：
//   · 载荷规则（文件类型 / mode / 上限 / 无 PAX 扩展头）→ `packer.collectTree` + `packEntries`
//   · 六（七）项绑定                                    → `artifact.assertManifestBinding`
//   · 路径 grammar                                      → `untar` / `safe-fs` 的 parseSafeRelPath
//   · pack lock / pack 兼容性                            → `pack.resolvePackInstall` / `checkPackCompat`
//   · namespace 所有权                                   → `promote/build-inputs.resolveOwner`
//   同一个不变量有两个校验器，就是 R-11 反复出现的形状。
//
// 本模块新写四条：
//   ① 保留 **namespace**（`registry/reserved.json`；05-lifecycle.md §1.1）
//   ② 归一化重名（NFKC + 小写 + 去连字符，**同 namespace 内**）
//   ③ 版本未占用（**含已 yank** —— 制品不可变，yank 不释放版本号）
//   ④ capability 一致性（声明 `none` 却含 `0755` / 脚本 → 拒；外部 URL → **只告警**）

import { readFileSync, existsSync } from 'node:fs';

import { parseStrict } from '../../src/canonical-json.mjs';

export const RESERVED_SCHEMA = 'geoly.skills.reserved/1';

class GateError extends Error {
  constructor(code, msg) { super(msg); this.name = 'GateError'; this.code = code; }
}
const bad = (code, msg) => { throw new GateError(code, msg); };

// ── ② 归一化重名 ───────────────────────────────────────────────────────────

/**
 * §6：「NFKC + 小写 + 去连字符后不与**同 namespace 内**已有 name 撞」。
 *
 * ⚠️ **诚实边界：今天只有「去连字符」这一步真的会触发。**
 *    name 的 grammar 是 `[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?`（01-artifacts.md §3）
 *    —— 全小写 ASCII。于是对任何**已经过 grammar 门**的名字：
 *      · NFKC 是恒等变换（没有可归一化的兼容字符）；
 *      · `toLowerCase()` 也是恒等变换。
 *    三步照写是为了**grammar 将来放宽时这道门仍然正确**，不是因为它们现在有用。
 *    `test/submission-gates.test.mjs` 里有一条断言钉住这个事实 ——
 *    哪天 grammar 放宽了，那条断言会变，改的人就会看到这段说明。
 */
export function normalizeName(name) {
  return name.normalize('NFKC').toLowerCase().split('-').join('');
}

/**
 * @param {object} a
 * @param {string} a.name        本次投稿的 name
 * @param {string[]} a.existing  **同 namespace 内**已有的 name（含已 yank 的）
 */
export function assertNoNormalizedCollision({ name, existing }) {
  const target = normalizeName(name);
  const hit = existing.filter((e) => e !== name && normalizeName(e) === target);
  if (hit.length) {
    bad('E_NAME_COLLIDE',
      `${name} 归一化后是 ${JSON.stringify(target)}，与同 namespace 内已有的 ${hit.join(', ')} 相撞。\n`
      + '  §6：归一化重名一律拒绝 —— 两个只差连字符的名字，agent 的路由判定分不开，'
      + '而人也看不出来。');
  }
  return true;
}

// ── ① 保留 namespace ───────────────────────────────────────────────────────

/**
 * 🔴 **保留清单管的是 `namespace`，不是制品 `name`。**
 *    05-lifecycle.md §1.1：「以下 **namespace** 只能由 hub 维护者使用：
 *    `geoly`、`hub`、`official`、`skills`、`registry`、`anthropic`、`claude`、
 *    `cursor`、`codex`、`openai`、`github`、`npm`、`system`、`admin`、`security`、
 *    `test`、`example`、`local`」。
 *
 *    ⚠️ 第一版我按 `name` 查（Codex 2026-08-31 指出）—— 那道门等于没设：
 *    一个 `namespace: geoly` 的投稿会**直接放行**，而那正是它要拦的东西。
 *
 * 🔴 而且它**不是**一刀切禁用：维护者可以用。所以判据是
 *    「保留 namespace **且** 投稿者不是维护者」。「是不是维护者」是 PR 侧的事实，
 *    由调用方传进来 —— 同 `promote/build-inputs.mjs` 的分工。
 */
export function readReserved(path) {
  if (!existsSync(path)) return { schema: RESERVED_SCHEMA, namespaces: [] };
  // 🔴 用 `parseStrict` 不用 `JSON.parse`：11-wire-contract.md §1 把
  //    `registry/reserved.json` 列进了适用对象，而 §2 的解析规则要求**拒绝重复 key**。
  //    `JSON.parse` 对重复 key 静默取最后一个 —— `{"namespaces":[…],"namespaces":[]}`
  //    就能把整张保留清单清空，而文件看起来完全正常（Codex 2026-08-31）。
  const doc = parseStrict(readFileSync(path, 'utf8'));
  if (doc.schema !== RESERVED_SCHEMA) {
    bad('E_RESERVED_SCHEMA', `reserved.json 的 schema 应为 ${RESERVED_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
  }
  if (!Array.isArray(doc.namespaces) || doc.namespaces.some((n) => typeof n !== 'string')) {
    bad('E_RESERVED_SCHEMA', 'reserved.json.namespaces 必须是字符串数组');
  }
  return doc;
}

/**
 * @param {object} a
 * @param {string} a.namespace
 * @param {object} a.reserved
 * @param {boolean} a.byMaintainer  投稿者是不是 hub 维护者（PR 侧的事实）
 */
export function assertReservedNamespaceAllowed({ namespace, reserved, byMaintainer = false }) {
  const target = normalizeName(namespace);
  const hit = reserved.namespaces.filter((r) => normalizeName(r) === target);
  if (hit.length === 0) return true;
  if (byMaintainer) return true;                    // §1.1：维护者可以用
  bad('E_RESERVED',
    `namespace ${namespace} 命中保留清单（${hit.join(', ')}，归一化后相同）——`
    + '05-lifecycle.md §1.1：这些 namespace 只能由 hub 维护者使用。');
}

// ── ③ 版本未占用 ───────────────────────────────────────────────────────────

/**
 * §6：「semver 合法、**未占用**、无 `+build`」。§3 又特别写明「版本号在该
 * `<ns>/<name>` 下**从未被使用过（含已 yank）**」。
 *
 * 🔴 **yank 不释放版本号。** 制品不可变（01-artifacts.md §1）：yank 只是标记
 *    「别再用了」，文件仍在。放行重用等于让同一个 ArtifactId 指向两份不同的字节 ——
 *    而 ArtifactId 是整个信任链的主键。
 *
 * @param {string} a.id            本次投稿的 ArtifactId
 * @param {string[]} a.existingIds 已有的全部 ArtifactId（**含已 yank**）
 */
export function assertVersionUnused({ id, existingIds }) {
  if (existingIds.includes(id)) {
    bad('E_VERSION_TAKEN',
      `${id} 已经存在 —— 版本号不可重用，**yank 也不释放它**（06-submission.md §3、01-artifacts.md §1）。\n`
      + '  要改内容就发新版本。');
  }
  return true;
}

// ── ④ capability 一致性 ────────────────────────────────────────────────────

/** 看起来像脚本的扩展名。**不是白名单，是启发式** —— 见下面的诚实边界。 */
export const SCRIPT_EXT = /\.(sh|bash|zsh|py|rb|pl|js|mjs|cjs|ts|ps1)$/i;

/**
 * 载荷里**看得见的**可执行迹象：可执行位、脚本扩展名、shebang。
 * 🔴 单独导出，因为 `tier-gate.mjs` 也要用它 —— 那里判的是
 *    「审查等级能不能只信投稿者自己填的 capabilities」。
 *    两处用同一条判据，不会分叉。
 */
export function executableEvidence(entries) {
  const out = [];
  for (const e of entries) {
    if ((e.mode & 0o111) !== 0) { out.push(`${e.path}：mode 0${e.mode.toString(8)} 带可执行位`); continue; }
    if (SCRIPT_EXT.test(e.path)) { out.push(`${e.path}：看起来是脚本（按扩展名）`); continue; }
    if (e.data.toString('utf8').startsWith('#!')) out.push(`${e.path}：以 shebang 开头`);
  }
  return out;
}
/** `http://` / `https://`；不含 `https://` 出现在纯文本说明里的情况 —— 分不开，见下。 */
const RE_EXTERNAL_URL = /\bhttps?:\/\/[^\s)"'<>]+/i;

/**
 * §6：「声明 `none` 却含 `0755` / 外部 URL / 脚本 → 拒绝」。
 *
 * ⚠️ **这条门天生是启发式的，不要把它当成安全保证。**
 *    · `0755` 是**确定**信号：可执行位就是可执行位；
 *    · 「脚本」按扩展名 + shebang 判 —— 一个没扩展名、没 shebang 的脚本躲得过去；
 *    · 「外部 URL」最粗：一条指向文档的链接与一条「去这里取指令」在字节上没有区别。
 *      §8 的人工门第 6 条（间接指令）才是真正处理它的地方，本门只能拦住最直白的。
 *    🔴 **外部 URL 这一项只告警、不拒绝**，理由见下面 `warnings` 那段 ——
 *    它是本模块唯一一处**偏离 §6 字面表述**的地方，已记进交付汇报。
 *    漏报的代价由 §8 的人来兜。
 *
 * @param {string[]} a.capabilities
 * @param {Array<{path:string, mode:number, data:Buffer}>} a.entries  packer.collectTree 的产物
 */
export function assertCapabilityConsistency({ capabilities, entries }) {
  // 🔴 **先去重再比。** 早先写的是 `length === 1 && [0] === 'none'`，于是
  //    `['none','none']` 会让 `declaredNone` 为假、整道门被跳过 —— 一个纯粹靠
  //    写两遍就能绕过的门（Codex 2026-08-31）。schema 那边没有 uniqueItems。
  const uniqCaps = Array.isArray(capabilities) ? [...new Set(capabilities)] : null;
  const declaredNone = uniqCaps !== null && uniqCaps.length === 1 && uniqCaps[0] === 'none';
  if (!declaredNone) return { checked: false, reason: '未声明 none，本门不适用' };

  const problems = executableEvidence(entries);
  const warnings = [];
  for (const e of entries) {
    const m = RE_EXTERNAL_URL.exec(e.data.toString('utf8'));
    if (m) warnings.push(`${e.path}：含外部 URL ${m[0].slice(0, 60)}`);
  }
  if (warnings.length) {
    // 🔴 **外部 URL 只告警，不拒绝** —— 这一条**偏离** §6 的字面表述，理由写在这里。
    //    §6 把「外部 URL」与「0755 / 脚本」并列成拒绝条件，但两者性质不同：
    //    `SKILL.md` 里放一条参考文档的链接**极其常见**，而「引用外部资料」
    //    不等于「运行时访问外部网络」。按字面实现的话，几乎每个声明 `none` 的
    //    正常 skill 都会被拒 —— 而逼人去掉链接、或改声明 `network`（那会错误地
    //    抬高审查 Tier 与安装确认要求），两条出路都是错的（Codex 2026-08-31）。
    //    ⚠️ 一道几乎总在报红的门，两周之内就会被关掉 —— 那时它一条都拦不住了。
    //    真正处理它的是 §8 人工门第 6 条（间接指令：「引用外部文档，按那里说的做」）。
    //    这条偏离已记进交付汇报，等规格侧确认。
    for (const w of warnings) process.stderr.write(`⚠️ capability 一致性（仅告警）：${w}\n`);
  }
  if (problems.length) {
    bad('E_CAPABILITY_INCONSISTENT',
      `声明了 capabilities: ["none"]，但载荷里有：\n`
      + problems.map((p) => `  · ${p}`).join('\n')
      + '\n  §6：声明不实视为恶意投稿（§7 末段）。要么去掉，要么如实声明对应的 capability。');
  }
  return { checked: true, problems: [], warnings };
}

export { GateError };
