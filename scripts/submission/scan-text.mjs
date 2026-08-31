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

import { readFileSync, readdirSync, statSync, realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, extname } from 'node:path';

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
]);

/** 只报告的码点。 */
const SUSPICIOUS = new Map([
  [0x200e, 'LRM 从左至右标记'], [0x200f, 'RLM 从右至左标记'],
  [0x061c, 'ALM 阿拉伯字母标记'], [0x00ad, 'SHY 软连字符'],
]);

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
    } else {
      const s = SUSPICIOUS.get(cp);
      if (s !== undefined) suspicious.push({ where, line, col, cp, name: s });
    }
    col++;
  }
  return { forbidden, suspicious, mixedScript: findMixedScript(text, where) };
}

/**
 * 同一个「词」里混用拉丁与西里尔/希腊。
 * 词 = 连续的字母（含各脚本的字母），被空白与标点切开。
 */
export function findMixedScript(text, where = '<text>') {
  const out = [];
  let line = 1;
  for (const raw of text.split('\n')) {
    // \p{L} 需要 u 标志；这里的「词」不含数字与标点
    for (const m of raw.matchAll(/\p{L}+/gu)) {
      const word = m[0];
      const kinds = SCRIPTS.filter(([, re]) => re.test(word)).map(([k]) => k);
      if (kinds.length > 1) {
        out.push({ where, line, col: m.index + 1, word, scripts: kinds });
      }
    }
    line++;
  }
  return out;
}

// ── 扫一棵树 ───────────────────────────────────────────────────────────────

// 只扫文本文件：二进制里出现这些字节没有「渲染出来骗人」的含义。
// ⚠️ 没有扩展名的文件（LICENSE、README）也算文本 —— 它们照样会被人读。
const TEXT_EXT = new Set(['', '.md', '.markdown', '.txt', '.json', '.yml', '.yaml', '.toml', '.csv']);

/** @returns {{files:number, forbidden:Array, suspicious:Array, mixedScript:Array}} */
export function scanTree(root) {
  if (!existsSync(root)) bad('E_SCAN_INPUT', `${root} 不存在`);
  const all = { files: 0, forbidden: [], suspicious: [], mixedScript: [] };
  const walk = (dir) => {
    for (const e of readdirSync(dir).sort()) {
      const full = join(dir, e);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) continue;
      if (!TEXT_EXT.has(extname(e).toLowerCase())) continue;
      const buf = readFileSync(full);
      // 含 NUL 的当二进制跳过（扩展名骗人的情况）
      if (buf.includes(0)) continue;
      const r = scanText(buf.toString('utf8'), relative(root, full));
      all.files++;
      all.forbidden.push(...r.forbidden);
      all.suspicious.push(...r.suspicious);
      all.mixedScript.push(...r.mixedScript);
    }
  };
  walk(root);
  return all;
}

/** 把结果排版成人能读的样子。`::warning::` / `::error::` 让它在 PR 上出注解。 */
export function format(r, { annotate = false } = {}) {
  const lines = [];
  const tag = (kind, s) => (annotate ? `::${kind}::${s}` : `${kind === 'error' ? '🔴' : '⚠️'} ${s}`);
  for (const f of r.forbidden) {
    lines.push(tag('error',
      `${f.where}:${f.line}:${f.col} 有 U+${f.cp.toString(16).toUpperCase().padStart(4, '0')}（${f.name}）`
      + ' —— 载荷里不允许出现，它能让人读到的与 agent 读到的不是同一段文字'));
  }
  for (const s of r.suspicious) {
    lines.push(tag('warning',
      `${s.where}:${s.line}:${s.col} 有 U+${s.cp.toString(16).toUpperCase().padStart(4, '0')}（${s.name}）—— 请人确认`));
  }
  for (const m of r.mixedScript) {
    lines.push(tag('warning',
      `${m.where}:${m.line}:${m.col} 「${m.word}」同一个词里混用了 ${m.scripts.join(' + ')} —— 同形字的典型形状`));
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
  const warn = r.suspicious.length + r.mixedScript.length;
  process.stderr.write(
    `✔ ${r.files} 个文本文件没有 bidi / 零宽字符`
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
