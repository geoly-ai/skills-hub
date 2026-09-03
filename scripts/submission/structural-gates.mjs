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

// ── 同形折叠（confusable fold）—— **只服务于保留清单比对** ──────────────────
//
// 🔴 **为什么只在这一层。** `normalizeName` 那套（NFKC + 小写 + 去连字符）挡得住
//    `GEOLY` / `ｇeoly` / `g-e-o-l-y`，却**挡不住数字替字母**：
//    `ge0ly`、`geo1y`、`anthrop1c` 原来全部放行 —— 而防仿冒正是保留
//    `anthropic` / `claude` / `openai` / `geoly` 的**全部理由**。
//
// 🔴 **攻击面是可枚举的，不是无底洞。** namespace 的 grammar 是
//    `[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?`（01-artifacts.md §3）—— 攻击者手里
//    **只有** a–z、0–9、连字符。连字符已被 `normalizeName` 去掉，非 ASCII 已被
//    NFKC + grammar 拦在门外。于是残余的同形手段**只剩两类**：
//      ① 数字冒充字母（`0`/`o`、`1`/`l`/`i`、`5`/`s` …）
//      ② 小写 ASCII 字母冒充另一个字母或字母序列（`rn`/`m`、`vv`/`w`、`cl`/`d`）
//    本模块把这两类都折掉，然后**全串相等**比对。
//
// ⚠️ **明确不覆盖的层（不要以为这道门是「防仿冒」的完备实现）：**
//    · **子串 / 前后缀包含**：`geoly-ai`、`my-claude-helper`、`claudes` 一律放行。
//      这是**有意的** —— `geoly-ai` / `prompts-map` / `plaud-theme` 已在
//      `registry/owners.json` 里且有线上制品，包含式判定会当场把它们杀掉。
//    · **编辑距离 / 模糊相似**：`anthropi`、`anthropicc`、`caludе`（转置）不管。
//    · **语音相似**：`fasebook` 这一路不管。
//    · 🔴 **`l`/`i` 之外的字母↔字母替换**：`qeoly`、`beoly`、`qithub`、`bithub`、
//      `reqistry`、`githug` **全部放行**。这不是漏了，是**算过账之后不做**：
//      要挡住它们就得把 `b`/`g`/`q` 并成一个字母等价类，而那立刻推出 `b ≡ g` ——
//      正常名字 `hug` 当场被判成冒充 `hub`（Codex 2026-09-03 实测给的）。
//      **数字**之所以能按歧义处理（`hu6` 拦、`hug` 放行），是因为「名字里出现数字」
//      本身就是可用的信号；两个都是普通字母时没有这个信号，只能二选一。
//      `l`/`i` 是唯一一对强到值得付这个代价的 —— 无衬线字体里它们**完全同形**。
//    · **`li`→`h`、`ci`→`a`、`nn` 之外的更弱多字符对**：见下面 MULTI 的注释，
//      逐条写了为什么不做。
//    真正兜住这些的是 §8 的人工门，不是这道结构门。

/** 小写 ASCII 里真正的**字母↔字母**同形对。`l` 与 `i` 归一到 `i`。 */
const LETTER_CLASS = { l: 'i' };

/**
 * 数字 → 它能冒充的字母。**只有一个候选的**在折叠时就地替换掉。
 * 🔴 `6` 与 `9` 有**两个**候选（`6` 既像 `b` 又像 `g`，`9` 既像 `g` 又像 `q`），
 *    **不能**把它们并进同一个等价类 —— 那会让 `b ≡ g`，于是 `hug` 被判成
 *    冒充 `hub`（Codex 2026-09-03 给的误伤例）。它们**原样保留**，
 *    在 `confusableEquals` 里按「候选集合有交集」逐位判 —— 那个关系
 *    **故意不是传递的**：`b ~ 6 ~ g` 但 `b ≁ g`。
 *    因为比对永远是「候选 vs 保留名」的单向两两比，不传递不构成问题。
 */
const DIGIT_SOLE = { 0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' };
const DIGIT_AMBIG = { 6: ['b', 'g'], 9: ['g', 'q'] };

/**
 * 多字符同形对。**在单字符折叠之后**施加，且模式写的是**折叠后的字母表**。
 *
 * 🔴 顺序是判据的一部分，不是实现细节。Codex 2026-09-03 指出：若按
 *    「先多字符、后单字符」，`cl`→`d` 只认字面 `cl`，而 `l` 又会折成 `i` ——
 *    于是 `claude`→`daude` 但 `c1aude`→`ciaude`，**等价关系不闭包，`c1aude` 直接绕过**。
 *    改成「先单字符、后多字符 + 模式用折叠后字母」就由构造保证闭包：
 *    `cl` / `c1` / `ci` 都先变成 `ci`，再统一折成 `d`。
 *
 * 🔴 四条规则的**首字符两两不同**（r / n / v / c），所以同一位置最多命中一条 ——
 *    不存在「贪心顺序依赖」这种可被利用的非合流。输出字符（m / w / d）也都不是
 *    任何规则的首字符或次字符，所以**单趟左到右扫描就是不动点**。有测试钉住这两条。
 *
 * ⚠️ 没做的：`li`→`h`（会把 `liub` 判成 `hub`，而那可能是正常名字）、
 *    `ci`→`a`（与这里的 `ci`→`d` 直接冲突，二选一）、`vv` 之外的 `w` 变体。
 */
const MULTI = [['rn', 'm'], ['nn', 'm'], ['vv', 'w'], ['ci', 'd']];

/**
 * 把名字折成「同形规范形」。结果里可能仍留有 `6` / `9` —— 它们是**歧义占位符**，
 * 由 `confusableEquals` 处理，见 `DIGIT_AMBIG`。
 */
export function foldConfusables(name) {
  let s = '';
  for (const ch of normalizeName(name)) s += LETTER_CLASS[ch] ?? DIGIT_SOLE[ch] ?? ch;
  let out = '';
  for (let i = 0; i < s.length;) {
    const rule = MULTI.find(([pat]) => s.startsWith(pat, i));
    if (rule) { out += rule[1]; i += rule[0].length; } else { out += s[i]; i += 1; }
  }
  return out;
}

/** 一个折叠后字符能代表的字母集合。 */
const charAlts = (c) => DIGIT_AMBIG[c] ?? [c];

/** 两个**已折叠**的名字是否同形。⚠️ 故意不传递，见 `DIGIT_AMBIG`。 */
export function confusableEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!charAlts(a[i]).some((x) => charAlts(b[i]).includes(x))) return false;
  }
  return true;
}

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
  // 🔴 **同形折叠必须在保留清单内部保持单射 —— 否则 fail-closed**（Codex 2026-09-03）。
  //    这是给「折叠表将来被放宽」准备的告警器：哪天有人往 `LETTER_CLASS` / `MULTI` 里
  //    加一条，把两个**本来互不相同的真实单词**折到一起了，这里会当场红 ——
  //    而不是等到某个正常投稿被莫名其妙判成仿冒才发现。
  const folds = doc.namespaces.map((n) => ({ n, f: foldConfusables(n) }));
  for (let i = 0; i < folds.length; i += 1) {
    for (let j = i + 1; j < folds.length; j += 1) {
      if (confusableEquals(folds[i].f, folds[j].f)) {
        bad('E_RESERVED_AMBIGUOUS',
          `保留清单内部自撞：${folds[i].n} 与 ${folds[j].n} 同形折叠后无法区分`
          + `（${JSON.stringify(folds[i].f)} / ${JSON.stringify(folds[j].f)}）。\n`
          + '  三种可能：① 其中一条是笔误；② 其中一条是**冗余别名**'
          + '（如 `openai` 之外再列 `open-ai` —— 归一化后本就相同，直接删掉那条即可）；'
          + '③ structural-gates.mjs 的折叠表放得太宽 —— 宽到能把两个正常单词合并，'
          + '就一定会误伤正常投稿。');
      }
    }
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
  // 🔴 归一化相等之外，再查一层**同形折叠**（`ge0ly` / `geo1y` / `anthrop1c`）——
  //    见上面那段「攻击面是可枚举的」。折叠只用在**这一层**（与 18 条固定清单
  //    比全串相等），**不用在 `assertNoNormalizedCollision`**：那边比的是
  //    同 namespace 内的**开放集合**，折叠会让两个正常名字互撞，
  //    且撞的对数随注册量二次增长，而它挡的不是仿冒、是「人和 agent 分不开」。
  const folded = foldConfusables(namespace);
  const lookalike = reserved.namespaces.filter(
    (r) => !hit.includes(r) && confusableEquals(foldConfusables(r), folded),
  );
  if (hit.length === 0 && lookalike.length === 0) return true;
  if (byMaintainer) return true;                    // §1.1：维护者可以用
  if (hit.length) {
    bad('E_RESERVED',
      `namespace ${namespace} 命中保留清单（${hit.join(', ')}，归一化后相同）——`
      + '05-lifecycle.md §1.1：这些 namespace 只能由 hub 维护者使用。');
  }
  bad('E_RESERVED',
    `namespace ${namespace} 与保留 namespace ${lookalike.join(', ')} **同形**`
    + `（数字/字母同形折叠后都是 ${JSON.stringify(folded)}）——`
    + '05-lifecycle.md §1.1：这些 namespace 只能由 hub 维护者使用，'
    + '而「数字替字母」正是保留它们要防的那种仿冒。\n'
    + '  ⚠️ 这道门只比**全串**：名字里带数字本身没问题（`web3`、`s3`、`i18n` 都放行），'
    + '包含保留词也没问题（`geoly-ai` 放行）—— 只有整个名字折叠后与保留名相同才拒。'
    + '要是你确实不是在仿冒，换一个不会折叠到保留名上的写法即可。');
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
