#!/usr/bin/env node
// 不可见字符 / bidi / 同形字扫描 —— 06-submission.md §8 第 5 条。
//
// §8 的原话：「有没有 Unicode 混淆、零宽字符、双向控制符、同形字？
// （**审查视图必须高亮不可见字符与 bidi，不能靠肉眼**）」。
//
// 🔴 **这一条不能只写进人工清单。** 它点名说了「不能靠肉眼」——
//    一条要求人去发现零宽字符的清单，等于没有这条。所以做成工具：
//    能确定是恶意形状的**直接拒**，判不准的**报出来给人看**。
//
// ── 拒 vs 报，判据是什么 ────────────────────────────────────────────────
// **拒**：在 skill 载荷里**没有任何正当用途**、而攻击价值明确的：
//   · bidi 覆盖 / 嵌入 / 隔离控制符（U+202A–202E、U+2066–2069）——
//     Trojan Source（CVE-2021-42574）那一类：**渲染出来的顺序与字节顺序不同**，
//     人读到的和 agent 读到的可以是两段不同的指令。
//   · 零宽字符（U+200B/200C/200D/2060/FEFF）—— 用来切碎关键词躲过人眼与
//     字符串匹配，也用来在 `description` 里藏东西。
//   ⚠️ U+200C/200D 在波斯语、印地语等文字里**有正当排版用途**。
//      这里仍然拒，因为 01-artifacts §4.1 已经把路径限成 ASCII，
//      而正文用到这两个字符的投稿可以走人工豁免 —— 拒错的代价是一次沟通，
//      放过的代价是一条看不见的指令。
//
// **报**：有正当用途、但值得人看一眼的：
//   · 同一个词里混用拉丁 + 西里尔/希腊字母（`раypal` 那一类同形字）；
//   · 其余 Cf 类（格式控制）字符。
//
// 🔴 **不执行载荷**（§5）：这里只 `readFileSync` + 遍历码点。

import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

class ScanError extends Error {
  constructor(code, msg) { super(msg); this.name = 'ScanError'; this.code = code; }
}
const bad = (code, msg) => { throw new ScanError(code, msg); };

/** 直接拒的码点 → 说明。 */
const FORBIDDEN = new Map([
  [0x202a, 'LRE 从左至右嵌入'], [0x202b, 'RLE 从右至左嵌入'],
  [0x202c, 'PDF 弹出方向格式'], [0x202d, 'LRO 从左至右覆盖'],
  [0x202e, 'RLO 从右至左覆盖'],
  [0x2066, 'LRI 从左至右隔离'], [0x2067, 'RLI 从右至左隔离'],
  [0x2068, 'FSI 首字符强定向隔离'], [0x2069, 'PDI 弹出方向隔离'],
  [0x200b, 'ZWSP 零宽空格'], [0x200c, 'ZWNJ 零宽不连字'],
  [0x200d, 'ZWJ 零宽连字'], [0x2060, 'WJ word joiner'],
  [0xfeff, 'BOM / 零宽不换行空格'],
  // 🔴 NUL 单列。它让 `file(1)` 判整个文件为二进制、`grep -I` 整文件跳过 ——
  //    「这个文件里没有那段话」于是变成一句静默的谎。本仓库两次踩过
  //    （src/pack.mjs、test/scan-text.test.mjs 自己）。
  [0x0000, 'NUL —— 会让整个文件被当成二进制而被跳过'],
]);

/**
 * 只报告的码点：**按 Unicode 属性判**，不是手写一张表。
 *
 * 🔴 手写表必漏（Codex 2026-08-31 点名了一串：标签字符 U+E0020–E007F、
 *    U+2061–2064、U+206A–206F、U+180E、U+FFF9–FFFB、变体选择符
 *    U+FE00–FE0F 与 U+E0100–E01EF、U+034F CGJ……）。这些都能隐形携带内容、
 *    改变字形或破坏字符串匹配。**枚举打不过属性。**
 *
 * `Default_Ignorable_Code_Point` 正好就是「不该被渲染出来」那一类；
 * `Cf`（格式控制）覆盖其余。两者取并集，减去已经在 FORBIDDEN 里的。
 */
const RE_INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/u;
// 组合字符：能堆叠、能零宽地插在词中间（U+034F 是典型）
const RE_MARK = /\p{M}/u;

const NAMED = new Map([
  [0x200e, 'LRM 从左至右标记'], [0x200f, 'RLM 从右至左标记'],
  [0x061c, 'ALM 阿拉伯字母标记'], [0x00ad, 'SHY 软连字符'],
  [0x034f, 'CGJ 组合字位连接符'], [0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
  [0xe0001, 'LANGUAGE TAG'],
]);
const describe = (cp) => {
  const n = NAMED.get(cp);
  if (n !== undefined) return n;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return '变体选择符 VS1–VS16';
  if (cp >= 0xe0100 && cp <= 0xe01ef) return '变体选择符补充区';
  if (cp >= 0xe0020 && cp <= 0xe007f) return '标签字符（能隐形携带整段文本）';
  return '不可见 / 格式控制字符';
};

// 同形字：只判「拉丁 × 西里尔/希腊」。
// 🔴 **不判「汉字 × 拉丁」** —— 中文文档里 `SKILL.md 的写法` 到处都是，
//    把它算成可疑等于让这个工具的输出没人看。
const SCRIPTS = [
  ['latin', /[A-Za-zÀ-ɏ]/],
  ['cyrillic', /[Ѐ-ӿԀ-ԯ]/],
  ['greek', /[Ͱ-Ͽἀ-῿]/],
];

/**
 * 扫一段文本。
 * @returns {{forbidden:Array, suspicious:Array, mixedScript:Array}}
 */
export function scanText(text, where = '<text>') {
  const forbidden = [];
  const suspicious = [];
  let line = 1;
  let col = 1;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (ch === '\n') { line++; col = 1; continue; }
    const f = FORBIDDEN.get(cp);
    if (f !== undefined) {
      forbidden.push({ where, line, col, cp, name: f });
    } else if (RE_INVISIBLE.test(ch) || RE_MARK.test(ch)) {
      // 组合字符本身合法（重音、声调），但**零宽**地插在词里能拆开匹配 ——
      // 报出来让人看一眼，不拦。
      if (RE_INVISIBLE.test(ch) || cp === 0x034f) {
        suspicious.push({ where, line, col, cp, name: describe(cp) });
      }
    }
    col++;
  }
  return {
    forbidden, suspicious,
    mixedScript: findMixedScript(text, where),
    compatibility: findCompatibilityForms(text, where),
  };
}

/**
 * 同一个「词」里混用拉丁与西里尔/希腊。
 *
 * 🔴 **词里要允许组合字符**（Codex 2026-08-31）：用 `\p{L}+` 的话，
 *    `p\u034Fа\u034Fypal` 渲染出来是一个词，却被 CGJ 拆成三个**纯脚本**的词，
 *    一处都不报。判据必须和**渲染成一个词**对齐，所以是 `[\p{L}\p{M}]+`。
 *
 * 🔴 **列按码点数**，与 `scanText` 一致。`m.index` 是 UTF-16 码元偏移 ——
 *    前面有 emoji 时两者会报出不同的列，读的人对不上。
 */
export function findMixedScript(text, where = '<text>') {
  const out = [];
  let line = 1;
  for (const raw of text.split('\n')) {
    for (const m of raw.matchAll(/[\p{L}\p{M}]+/gu)) {
      const word = m[0];
      const kinds = SCRIPTS.filter(([, re]) => re.test(word)).map(([k]) => k);
      if (kinds.length > 1) {
        out.push({ where, line, col: [...raw.slice(0, m.index)].length + 1, word, scripts: kinds });
      }
    }
    line++;
  }
  return out;
}

/**
 * 兼容等价形式：原文与 NFKC / 大小写折叠之后**不一样**的词。
 *
 * 🔴 同形字不止「换一个脚本的字母」这一种形状（Codex 2026-08-31）：
 *    `K`（U+212A KELVIN SIGN）折叠后是 `k`、全角 `ｓｈｅｌｌ` NFKC 后是 `shell`、
 *    `ﬁ` 展开成 `fi`。这些在 `capability` 之类的关键词上尤其要紧 ——
 *    人眼读到的是 `shell`，字符串匹配读到的不是。
 *
 * ⚠️ 只**报告**：中日韩正文里 NFKC 会动到的字很多，拒会误伤一大片。
 */
export function findCompatibilityForms(text, where = '<text>') {
  const out = [];
  let line = 1;
  for (const raw of text.split('\n')) {
    // 🔴 词里要带上 `\p{So}` / `\p{Sk}`：`ⓢⓗⓔⓛⓛ` 属于 So，
    //    用 `[\p{L}\p{M}\p{N}]+` 的话它整个不成词，一处都不报（Codex 2026-08-31）。
    for (const m of raw.matchAll(/[\p{L}\p{M}\p{N}\p{So}\p{Sk}]+/gu)) {
      const word = m[0];
      const nfkc = word.normalize('NFKC');
      // 🔴 **NFKC 的差异要在小写化之前判。** 先 toLowerCase 的话，
      //    `K`（U+212A KELVIN）与 `k` 会先变成同一个，差异就没了。
      const folded = nfkc.toLowerCase();
      if (nfkc !== word && /^[\x21-\x7e]+$/.test(folded)) {
        out.push({ where, line, col: [...raw.slice(0, m.index)].length + 1, word, folded });
      }
    }
    line++;
  }
  return out;
}

// ── 扫一棵树 ───────────────────────────────────────────────────────────────

/**
 * 🔴🔴 **扫所有文件，不按扩展名白名单，也不按 NUL 跳过。**
 *
 * 第一版两条都错，而且**两条各自就是一个绕过**（Codex 2026-08-31）：
 *   · 白名单只收 `.md/.txt/...` —— 载荷里的 `.sh` / `.py` / `.js` 一个都不扫，
 *     未知扩展名同理。而人要读的恰恰包括那些脚本。
 *   · 「含 NUL 当二进制跳过」—— 于是 **`NUL` + `U+202E` 放进一个 `.md`，
 *     整道门直接失效**。用一个「像二进制」的信号去决定要不要检查，
 *     等于把开关交给被检的一方。
 *
 * 现在的判据是**能不能按 UTF-8 严格解码**：
 *   · 能 → 它就是给人读的文本，扫（NUL 本身已在 FORBIDDEN 里，会被报出来）；
 *   · 不能 → 真二进制（图片之类），跳过。
 * 一个刻意构造成合法 UTF-8 的「二进制」文件会被扫，那没有坏处。
 */
// 名字看着就是给人读的 —— 这些**必须**是合法 UTF-8，否则按绕过处理。
const TEXTY = /\.(md|markdown|txt|json|ya?ml|toml|csv|sh|bash|zsh|py|rb|pl|js|mjs|cjs|ts|ps1)$/i;

export function scanTree(root) {
  if (!existsSync(root)) bad('E_SCAN_INPUT', `${root} 不存在`);
  // 🔴 `ignoreBOM: true` —— 默认的 TextDecoder 会**吃掉**文件开头的 BOM，
  //    于是 U+FEFF 永远进不了 FORBIDDEN，那一格形同虚设（Codex 2026-08-31）。
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const all = {
    files: 0, skippedBinary: 0, forbidden: [], suspicious: [], mixedScript: [], compatibility: [],
  };
  const walk = (dir) => {
    // 🔴 `lstat`，不是 `stat` —— `stat` 跟随符号链接，独立调用时能扫出根目录之外
    //    （而载荷里本来就不许有 symlink，见 01-artifacts §5）。
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) {
        all.forbidden.push({
          where: relative(root, full), line: 1, col: 1, cp: -1,
          name: '符号链接 —— 载荷里不允许（01-artifacts §5），且会让扫描越出根目录',
        });
        continue;
      }
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      const rel = relative(root, full);
      let text;
      try {
        text = decoder.decode(readFileSync(full));
      } catch {
        // 🔴🔴 **「不是合法 UTF-8 就跳过」本身又是一个绕过**（Codex 2026-08-31）：
        //    在一个塞了 RLO 的 .md 里多放一个非法字节，整文件就不扫了。
        //    所以按文件名分两路：
        //    · 名字就是给人读的（.md / .sh / .json…）→ **直接拒**。
        //      一个不是合法 UTF-8 的 SKILL.md 不是「二进制资源」，是规避。
        //    · 其余（图片之类）→ 跳过，但**计数并报出来**，不静默。
        if (TEXTY.test(e.name)) {
          all.forbidden.push({
            where: rel, line: 1, col: 1, cp: -1,
            name: '不是合法 UTF-8 —— 文本文件必须能解码，'
              + '否则「跳过不扫」就成了藏 bidi / 零宽字符的地方',
          });
        } else {
          all.skippedBinary++;
          all.suspicious.push({
            where: rel, line: 1, col: 1, cp: -1,
            name: '非 UTF-8 的二进制文件，**没有**逐字符扫过 —— 请人确认它确实是资源文件',
          });
        }
        continue;
      }
      const r = scanText(text, rel);
      all.files++;
      all.forbidden.push(...r.forbidden);
      all.suspicious.push(...r.suspicious);
      all.mixedScript.push(...r.mixedScript);
      all.compatibility.push(...r.compatibility);
    }
  };
  walk(root);
  return all;
}

/**
 * 排版。
 *
 * 🔴 **注解格式是 `::error file=…,line=…,col=…::消息`**，不是
 *    `::error::file:line:col 消息`（Codex 2026-08-31）。后者 GitHub 认，
 *    但只当成一条**没有位置**的普通注解 —— 它不会挂到文件的那一行上，
 *    而「挂到那一行」正是 §8 第 5 条要的「高亮」。
 *    ⚠️ 消息里的 `,` 与 `:` 不需要转义，但**换行要**（`%0A`）。
 */
export function format(r, { annotate = false } = {}) {
  const lines = [];
  const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const tag = (kind, { where, line, col }, msg) => (annotate
    ? `::${kind} file=${where},line=${line},col=${col}::${esc(msg)}`
    : `${kind === 'error' ? '🔴' : '⚠️'} ${where}:${line}:${col} ${msg}`);
  const u = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

  for (const f of r.forbidden) {
    lines.push(tag('error', f, f.cp === -1
      ? f.name
      : `有 ${u(f.cp)}（${f.name}）—— 载荷里不允许出现，`
        + '它能让人读到的与 agent 读到的不是同一段文字'));
  }
  for (const s of r.suspicious) {
    lines.push(tag('warning', s, `有 ${u(s.cp)}（${s.name}）—— 请人确认`));
  }
  for (const m of r.mixedScript) {
    lines.push(tag('warning', m,
      `「${m.word}」同一个词里混用了 ${m.scripts.join(' + ')} —— 同形字的典型形状`));
  }
  for (const c of r.compatibility ?? []) {
    lines.push(tag('warning', c,
      `「${c.word}」在 NFKC + 大小写折叠之后是「${c.folded}」—— `
      + '人眼读到的与字符串匹配读到的不是一个东西'));
  }
  return lines;
}

// ── CLI ────────────────────────────────────────────────────────────────────

const KNOWN = ['submissions', 'annotate'];

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad('E_SCAN_INPUT', `不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const key = name.slice(2);
    if (!KNOWN.includes(key)) bad('E_SCAN_INPUT', `不认识的选项 ${name}`);
    if (key in o) bad('E_SCAN_INPUT', `${name} 给了不止一次`);
    if (key === 'annotate') { o[key] = 'true'; continue; }
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad('E_SCAN_INPUT', `${name} 需要一个值`);
    o[key] = val;
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  const root = o.submissions ?? 'submissions';
  if (!existsSync(root)) {
    process.stderr.write(`没有待扫的投稿（${root} 不存在）。\n`);
    return 0;
  }
  const r = scanTree(root);
  const annotate = o.annotate === 'true';
  for (const l of format(r, { annotate })) process.stderr.write(`${l}\n`);

  if (r.forbidden.length) {
    process.stderr.write(
      `\n🔴 ${r.files} 个文本文件里有 ${r.forbidden.length} 处不允许出现的不可见 / bidi 字符。\n`
      + '   §8 第 5 条要求「审查视图必须高亮不可见字符与 bidi，不能靠肉眼」——\n'
      + '   一条要求人去发现零宽字符的清单等于没有这条，所以这里直接拒。\n'
      + '   ⚠️ 正文确有排版需要（ZWNJ 之类）的，走人工豁免，不要放宽这道门。\n');
    return 1;
  }
  const warn = r.suspicious.length + r.mixedScript.length + r.compatibility.length;
  process.stderr.write(
    `✔ ${r.files} 个文本文件没有 bidi / 零宽字符`
    + `${r.skippedBinary ? `（另跳过 ${r.skippedBinary} 个非 UTF-8 的二进制文件）` : ''}`
    + `${warn ? `，另有 ${warn} 处待人确认（见上）` : ''}。\n`);
  return 0;
}

export { ScanError };

// 入口守卫比 realpath —— 见 scripts/release/build-timestamp.mjs 里的说明。
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return true; }
}

if (invokedDirectly()) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) {
    process.stderr.write(`${e.code ? `[${e.code}] ` : ''}${e.message}\n`);
    process.exit(1);
  }
}
