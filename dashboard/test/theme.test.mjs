import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEME_COOKIE, nextTheme, parseTheme, themeLabel } from '../lib/theme.mjs';

/*
 * 主题三态（lib/theme.mjs + app/api/theme/route.js）。
 *
 * 逻辑本身无害，但它是一个**新的写入口**：这里守的是「加一个外观按钮没有顺手拆掉护栏」
 * —— 门禁、同源检查、开放重定向、cookie 属性（Codex 2026-09-14 计划评审提的）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(HERE, '..', p), 'utf8');

test('三态循环：跟随系统 → 亮 → 暗 → 跟随系统', () => {
  assert.equal(nextTheme(undefined), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), null);
});

test('只认 light / dark；篡改的值一律当「跟随系统」，不会被写进 data-theme', () => {
  for (const bad of ['', 'Dark', 'green', '"><script>', 'light ', null, 1]) {
    assert.equal(parseTheme(bad), null, `parseTheme(${JSON.stringify(bad)})`);
    assert.equal(nextTheme(bad), 'light');
  }
  assert.equal(themeLabel('dark'), '暗');
  assert.equal(themeLabel('light'), '亮');
  assert.equal(themeLabel('x'), '跟随系统');
});

test('🔴 主题口不是公开路径：proxy 的 PUBLIC 里只有登录页与登录口', () => {
  const proxy = read('proxy.js');
  const m = proxy.match(/const PUBLIC = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'proxy.js 里找不到 PUBLIC 集合，这条断言在空跑');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(entries, ['/api/login', '/login']);
});

test('🔴 主题口与登录口同一套护栏：同源检查 + safeNext + __Host- cookie', () => {
  const src = read('app/api/theme/route.js');
  assert.match(src, /if \(!sameOrigin\(req\)\) return/, '缺同源检查（CSRF）');
  assert.match(src, /safeNext\(form\?\.get\('to'\)\)/, '回跳地址必须过 safeNext（开放重定向）');
  assert.match(src, /secure: true/);
  assert.match(src, /httpOnly: true/);
  assert.match(src, /sameSite: 'lax'/);
  assert.match(src, /path: '\/'/);
  assert.ok(THEME_COOKIE.startsWith('__Host-'), '`__Host-` 前缀强制 Secure + Path=/ + 无 Domain');
  assert.ok(!/'use client'|"use client"/.test(src));
});
