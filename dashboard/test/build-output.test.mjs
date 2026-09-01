import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * 构建产物扫描 —— `test/no-client-secrets.test.mjs` 那三条**结构性**断言的兜底。
 *
 * 🔴 为什么两道都要（Codex 2026-09-01 提的）：结构断言是按源码形态推的，
 *    而它推不到的形态一直在长出来 —— 动态 `import()`、re-export、路径别名、
 *    `const { X } = process.env` 这种解构、将来的 Server Action。
 *    这一道直接看**真的被打进浏览器包的字节**，形态无关。
 *
 * ⚠️ 它需要先跑过一次 `next build`，所以 `.next/static` 不在时**跳过**而不是红：
 *    让 `npm test` 强制依赖一次完整构建，结果只会是没人跑测试。
 *    CI 里应该在 `next build` 之后再跑一次 `npm test`，那时这道门才真的在把关。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = join(ROOT, '.next', 'static');

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

test('🔴 客户端产物里不许出现 token / 口令的变量名或值', (t) => {
  if (!existsSync(STATIC)) {
    t.skip('没有 .next/static（还没跑过 next build）。CI 里要在 build 之后再跑一次这个测试');
    return;
  }
  const files = walk(STATIC).filter((f) => /\.(js|mjs|json|txt|map)$/.test(f));
  assert.ok(files.length > 0, '.next/static 里一个可扫的文件都没有，这道门在空跑');

  const banned = [
    'GEOLY_TELEMETRY_SUMMARY_TOKEN',
    'DASHBOARD_ACCESS_SECRET',
    'GEOLY_SUMMARY_URL',
    // 这一句是 server-only 模块的标志串：出现在浏览器包里就说明它被打进去了
    'summary-source.mjs 被打进了客户端 bundle',
  ];
  // 🔴 除了变量**名**，还要扫它们的**值** —— 变量名可以被改名绕过，值不能
  //    （Codex 2026-09-01 指出上一版只扫了名字）。
  //    ⚠️ 只在这次进程里真的配了值时才扫；CI 里应该把这两个变量喂给测试步骤。
  for (const name of ['GEOLY_TELEMETRY_SUMMARY_TOKEN', 'DASHBOARD_ACCESS_SECRET']) {
    const v = process.env[name];
    if (typeof v === 'string' && v.length >= 8) banned.push(v);
  }
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const w of banned) {
      assert.ok(!text.includes(w), `${relative(ROOT, f)} 里出现了 ${w.length > 40 ? '<一个被配置的密钥值>' : w}`);
    }
  }
});

test('🔴 客户端产物里不许出现 UUID 形状的串（install_id 泄漏的形态）', (t) => {
  if (!existsSync(STATIC)) { t.skip('没有 .next/static'); return; }
  const RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
  // ⚠️ source map 也要扫：它是最容易被忘掉的一条出口，而里面装的是**源码原文**
  for (const f of walk(STATIC).filter((x) => /\.(js|mjs|json|txt|map)$/.test(x))) {
    const m = RE_UUID.exec(readFileSync(f, 'utf8'));
    assert.equal(m, null, `${relative(ROOT, f)} 里出现了一个 UUIDv4：${m?.[0]}`);
  }
});
