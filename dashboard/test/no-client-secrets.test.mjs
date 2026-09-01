import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * 🔴 **summary token 不许漏进客户端 bundle。**
 *
 * 它是规格 §5.3 里「读出面默认关闭」的钥匙 —— 漏出去等于把全量聚合面对全世界打开，
 * 而且是**静默地**打开：不会有任何东西变红，除非有这样一个测试。
 *
 * 这里查的是**结构**而不是构建产物：结构成立的话，构建产物不可能出问题，
 * 而且这个测试不需要先跑一次 `next build`（那会让它贵到没人愿意跑）。
 *
 * 三条断言：
 *   ① 任何带 `'use client'` 的文件不许读 `process.env`（`NEXT_PUBLIC_` 除外）；
 *   ② 从每一个 client 文件出发递归查 import 图，不许到达 lib/summary-source.mjs；
 *   ③ 源码里不许出现 token 的**字面量**（有人为了调试写死过一次就够）。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.next', 'out', '.vercel', 'test']);
const CODE = /\.(mjs|js|jsx|ts|tsx)$/;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (CODE.test(name)) acc.push(p);
  }
  return acc;
}

const FILES = walk(ROOT);
const SRC = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));

/** 文件顶部有没有 'use client'。 */
const isClient = (text) => /^\s*(['"])use client\1/m.test(text.slice(0, 400));

/** 相对 import 解析成绝对路径（只关心仓库内的相对 import）。 */
function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const cand of [base, `${base}.mjs`, `${base}.js`, `${base}.jsx`, join(base, 'index.mjs')]) {
    if (SRC.has(cand)) return cand;
  }
  return null;
}

function importsOf(file) {
  const text = SRC.get(file) ?? '';
  const out = [];
  for (const m of text.matchAll(/(?:^|\n)\s*import[^'"]*['"]([^'"]+)['"]/g)) {
    const r = resolveImport(file, m[1]);
    if (r) out.push(r);
  }
  return out;
}

test('至少扫到了源码（防止 walk 写错导致这个门空跑）', () => {
  assert.ok(FILES.length >= 10, `只扫到 ${FILES.length} 个文件，walk 大概写错了`);
});

test("🔴 带 'use client' 的文件不许读 process.env（NEXT_PUBLIC_ 除外）", () => {
  for (const [f, text] of SRC) {
    if (!isClient(text)) continue;
    for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      assert.ok(
        m[1].startsWith('NEXT_PUBLIC_'),
        `${relative(ROOT, f)} 是 client component，却读了 process.env.${m[1]}`,
      );
    }
  }
});

test('🔴 没有任何 client component 能（递归地）import 到 summary-source.mjs', () => {
  const target = join(ROOT, 'lib', 'summary-source.mjs');
  assert.ok(SRC.has(target), 'summary-source.mjs 不见了，这个门在空跑');

  for (const [entry, text] of SRC) {
    if (!isClient(text)) continue;
    const seen = new Set([entry]);
    const stack = [entry];
    while (stack.length) {
      const cur = stack.pop();
      for (const next of importsOf(cur)) {
        assert.notEqual(
          next, target,
          `${relative(ROOT, entry)} 是 client component，经 ${relative(ROOT, cur)} 到达了 summary-source.mjs`,
        );
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
  }
});

test('summary-source.mjs 自带运行时护栏（万一结构被绕过也要炸，而不是悄悄工作）', () => {
  const text = SRC.get(join(ROOT, 'lib', 'summary-source.mjs'));
  assert.match(text, /typeof window !== 'undefined'/);
  assert.match(text, /throw new Error/);
});

test('只有一个地方**读** GEOLY_TELEMETRY_SUMMARY_TOKEN', () => {
  // ⚠️ 判据是「读」（`env.X` / `process.env.X`），不是「提到名字」——
  //    「没配这个变量」的空状态文案里会点名它，那不是一次读取。
  const reads = /(?:process\.)?env(?:\.GEOLY_TELEMETRY_SUMMARY_TOKEN|\[['"]GEOLY_TELEMETRY_SUMMARY_TOKEN['"]\])/;
  const readers = [...SRC].filter(([, t]) => reads.test(t)).map(([f]) => relative(ROOT, f));
  assert.deepEqual(readers.sort(), ['lib/summary-source.mjs'],
    `token 的读取点不止一个：${readers.join(', ')}`);
});

test('🔴 源码里不许写死 token / 口令的字面量', () => {
  // Bearer 后面直接跟一串常量、或 SECRET = "…" 这类形态
  for (const [f, text] of SRC) {
    assert.ok(
      !/Bearer\s+[A-Za-z0-9_\-.]{16,}/.test(text),
      `${relative(ROOT, f)} 里像是写死了一个 Bearer token`,
    );
    assert.ok(
      !/DASHBOARD_ACCESS_SECRET\s*=\s*['"][^'"]+['"]/.test(text),
      `${relative(ROOT, f)} 里像是写死了访问口令`,
    );
  }
});

test('🔴 整个项目里不该有 client component —— 抑制必须发生在服务端', () => {
  // 先发原始聚合到浏览器、再靠前端隐藏，等于把它公开了（打开 devtools 就能看见）。
  // 加交互时要走「URL 参数 → 服务端重新取数 → 重新抑制」，不是加一个 client 组件。
  const clients = [...SRC].filter(([, t]) => isClient(t)).map(([f]) => relative(ROOT, f));
  assert.deepEqual(clients, [], `出现了 client component：${clients.join(', ')}。`
    + '若确实需要，必须先证明它拿不到未抑制的数据，并把理由写进这里。');
});
