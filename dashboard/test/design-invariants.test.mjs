import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * 设计不变量的构建期检查（DESIGN.md §14.2：「生产实现应把同样这几条搬进构建期检查」）。
 *
 * 这里只放**能在源码上静态判定、且判定不靠猜**的几条。需要真实 DOM 的
 * （抑制位里没有数字、图标越界、375px 无横向溢出、对比度）在浏览器里跑 design-preview.html
 * 的 auditInvariants() 同款脚本 —— 见 README「视觉」一节。
 *
 * ⚠️ 扫描前先剥掉注释：注释里大量引用 `—`、`0`、`--c-ok` 这类「不许出现」的东西来解释为什么不许，
 *    不剥就会误报；而为了不误报去放宽判据，又会漏掉真正的值位（Codex 2026-09-14 提醒）。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir, re, acc = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, re, acc);
    else if (re.test(name)) acc.push(p);
  }
  return acc;
}

/** 去掉 /* … *\/、{/* … *\/} 与整行 // 注释。 */
const stripComments = (s) => s
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:'"`])\/\/[^\n'"`]*$/gm, '$1');

const UI = [...walk('app', /\.(jsx|js|css)$/), ...walk('components', /\.(jsx|css)$/)];
const CSS_NON_TOKEN = ['app/base.css', 'app/components.css'];

test('至少扫到了界面源码（防止 walk 写错导致整份检查空跑）', () => {
  assert.ok(UI.length >= 15, `只扫到 ${UI.length} 个文件`);
  for (const f of CSS_NON_TOKEN) assert.ok(UI.includes(f), `${f} 没被扫到`);
});

test('🔴 颜色只在 tokens.css 里定义：组件样式里零字面量色值', () => {
  for (const f of CSS_NON_TOKEN) {
    const css = stripComments(read(f));
    const hit = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/);
    assert.equal(hit, null, `${f} 里出现了字面量色值：${hit?.[0]}`);
  }
  for (const f of UI.filter((x) => x.endsWith('.jsx'))) {
    const src = stripComments(read(f));
    const hit = src.match(/#[0-9a-fA-F]{6}\b|\brgba?\(/);
    assert.equal(hit, null, `${f} 里出现了字面量色值：${hit?.[0]}`);
  }
});

test('🔴 全站没有绿色：连 token 都不定义', () => {
  for (const f of [...UI, 'app/tokens.css']) {
    const src = stripComments(read(f));
    assert.ok(!/--c-ok\b/.test(src), `${f} 里出现了 --c-ok`);
    assert.ok(!/\bgreen\b/i.test(src), `${f} 里出现了 green`);
  }
});

test('🔴 没有胶囊：不出现 border-radius: 999px', () => {
  for (const f of UI.filter((x) => x.endsWith('.css'))) {
    assert.ok(!/999px|9999px/.test(stripComments(read(f)).replace(/left:\s*-9999px/g, '')), `${f} 里有胶囊圆角`);
  }
});

test('🔴 tokens.css：亮色完整定义在裸 :root，暗色两处都写且 token 集合一致', () => {
  const css = stripComments(read('app/tokens.css'));
  const rootBlock = css.match(/^:root\s*\{([\s\S]*?)^\}/m)?.[1] ?? '';
  const mediaBlock = css.match(/:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const darkBlock = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)^\}/m)?.[1] ?? '';
  const names = (b) => [...b.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
  const light = new Set(names(rootBlock));
  for (const must of ['--c-page', '--c-panel', '--c-inset', '--c-text', '--c-accent', '--c-accent-ink',
    '--c-fault', '--c-withheld', '--c-pending', '--c-unknown', '--c-measure',
    '--p-fault', '--p-withheld', '--p-pending', '--p-quiet', '--hatch-withheld', '--f-sans', '--f-mono']) {
    assert.ok(light.has(must), `:root 里没有 ${must}`);
  }
  const media = names(mediaBlock).sort();
  const dark = names(darkBlock).sort();
  assert.ok(media.length > 10, '@media 暗色块没找到');
  assert.deepEqual(media, dark, '@media 暗色与 [data-theme="dark"] 重定义的 token 不一致：手动切换会漏色');
  for (const n of dark) assert.ok(light.has(n), `${n} 只在暗色里定义，亮色下没有值`);
});

test('🔴 告示条不是 live region：不许 role="status" / role="alert"', () => {
  for (const f of UI.filter((x) => x.endsWith('.jsx'))) {
    assert.ok(!/role=["'](status|alert)["']/.test(stripComments(read(f))), `${f} 用了 live region`);
  }
  assert.match(read('components/nothing.jsx'), /role="group" aria-labelledby=\{id\}/);
});

test('🔴 抑制位三通道：横条与整表告示条都带真实文本「未发布」，值位里没有破折号', () => {
  const dt = stripComments(read('components/dimension-table.jsx'));
  assert.match(dt, /<tr className="withheld-row">[\s\S]*?未发布[\s\S]*?<\/tr>/, '抑制横条缺「未发布」');
  assert.match(dt, /colSpan=\{cols\}/, '抑制行必须是整行 colspan 横条，不按列对齐');
  assert.match(stripComments(read('components/nothing.jsx')), /<span className="withheld">未发布<\/span>/,
    '整表抑制的告示条也要带「未发布」：斜纹读屏读不到');
  for (const f of ['components/dimension-table.jsx', 'components/durations.jsx']) {
    const src = stripComments(read(f));
    assert.ok(!/>\s*[—–-]\s*</.test(src) && !/['"][—–]['"]/.test(src), `${f} 的值位里出现了破折号`);
    assert.ok(!/N\/A/.test(src), `${f} 里出现了 N/A`);
  }
});

test('🔴 「本次读取」不许写成「更新于」，也不许出现从事件时间派生的时间', () => {
  assert.match(read('components/shell.jsx'), /本次读取/);
  for (const f of UI) {
    const src = stripComments(read(f));
    assert.ok(!src.includes('更新于'), `${f} 里出现了「更新于」`);
    assert.ok(!/rolled_up_before|received_at|\.at\b/.test(src), `${f} 碰了事件时间 / 折算水位`);
  }
});

test('🔴 filtered-empty 在加筛选器之前不许被渲染：没有任何地方把 filtered 传成 true', () => {
  for (const f of UI) {
    assert.ok(!/filtered\s*[:=]\s*\{?\s*true/.test(stripComments(read(f))), `${f} 传了 filtered: true`);
  }
});

test('🔴 界面源码里零 emoji（注释里的红点是给读代码的人的，不许跟着上屏）', () => {
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  for (const f of UI.filter((x) => x.endsWith('.jsx'))) {
    const hit = stripComments(read(f)).match(EMOJI);
    assert.equal(hit, null, `${relative(ROOT, join(ROOT, f))} 的非注释部分出现了 emoji：${hit?.[0]}`);
  }
});

test('🔴 KPI 只渲染发布层给的 totalOut / installsOut，不渲染 total 原值', () => {
  const page = stripComments(read('app/page.jsx'));
  assert.match(page, /out=\{view\.totalOut\}/);
  assert.match(page, /out=\{view\.installsOut\}/);
  assert.ok(!/\{\s*(data|view|d)\.total\s*\}/.test(page), 'page.jsx 把 total 原值直接渲染了');
  assert.ok(!/\{\s*(data|view|d)\.installs\s*\}/.test(page), 'page.jsx 把 installs 原值直接渲染了');
});

test('🔴 SOURCE 非 ok 时主区只有告示条：KPI 与面板只在 ok 分支里', () => {
  const page = stripComments(read('app/page.jsx'));
  // 故障分支从 `: (` 到它独占一行的 `)}` 为止（内部的 `(res.status ? …)` 不会独占一行）
  const failBranch = page.match(/\{ok \? <Overview data=\{res\.data\} \/> : \(([\s\S]*?)\n\s*\)\}/)?.[1];
  assert.ok(failBranch, '找不到 ok / 非 ok 两个分支，这条断言在空跑');
  assert.ok(!/Kpi|DimensionTable|Durations/.test(failBranch), '故障分支里渲染了 KPI 或面板');
  assert.match(failBranch, /<Nothing/);
  assert.match(failBranch, /<ServerGaps data=\{null\} \/>/);
});

// 🔴 面板头状态词只有一张表（components/dimension-table.jsx 的 HEAD_WORD）。
//    耗时面板原先手写三元式，把 NO_ROWS 写成了「整表未发布」—— 「没有」与「未发布」混成一个词（§10.1）。
test('🔴 耗时面板的面板头状态词取自共享的 HEAD_WORD，不另写一份', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const src = rf(new URL('../components/durations.jsx', import.meta.url), 'utf8');
  assert.match(src, /right=\{HEAD_WORD\[state\]\}/, '耗时面板没用共享状态词表');
  assert.ok(!/'整表未发布'/.test(src), '耗时面板里又出现了手写的状态词');
  const table = rf(new URL('../components/dimension-table.jsx', import.meta.url), 'utf8');
  for (const k of ['NO_EVENTS', 'NO_ROWS', 'DIMENSION_MISSING', 'UNRECOGNIZED_ROWS', 'FILTERED_EMPTY', 'SUPPRESSED', 'SUPPRESSED_QUANTILE']) {
    assert.match(table, new RegExp(`\\[VIEW\\.${k}\\]:`), `HEAD_WORD 缺 ${k}`);
  }
});

// 🔴 规格 §5.3 那句边界声明在任何宽度都要看得见：侧栏在窄屏隐藏时，主区底部要有同一句。
test('🔴 「禁止用于计费或任何信任判定」窄屏不消失', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const shell = rf(new URL('../components/shell.jsx', import.meta.url), 'utf8');
  const css = rf(new URL('../app/components.css', import.meta.url), 'utf8');
  const n = (shell.match(/禁止用于计费或任何信任判定/g) ?? []).length;
  assert.equal(n, 2, '侧栏与主区底部应各有一份');
  const narrow = css.slice(css.indexOf('@media (max-width: 1119px)'));
  assert.match(narrow.slice(0, narrow.indexOf('}\n}') + 3), /\.mainfoot\s*\{\s*display:\s*block/, '窄屏断点里没把主区那份显示出来');
});
