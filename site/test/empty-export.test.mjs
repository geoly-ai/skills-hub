// 空 registry 的**产物**测试 —— 这是仓库现在真实的状态，必须验它真的构建得出来、
// 而且首页整页就是空状态。
//
// 🔴 空状态下 `next build` 走的是**另一条路**（不开 `output: 'export'`，见 next.config.mjs），
//    所以模型层绿灯证明不了它 —— 只有真跑一次才知道。上线当天才发现构建失败，
//    正是「空状态被当成补丁」的典型后果。
//
// ⚠️ 与 export.test.mjs 一样会覆盖 `.generated/` 与构建产物，所以 npm test 串行跑
//    （package.json 里的 --test-concurrency=1）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walk, assertNoBannedWords } from './banned-words.mjs';

const SITE = fileURLToPath(new URL('../', import.meta.url));
const run = (args) => execFileSync(process.execPath, args, { cwd: SITE, stdio: 'pipe', encoding: 'utf8' });

// 用一个空目录当 snapshots dir，效果与仓库现状（目录不存在）等价，且不依赖仓库当下的状态。
const emptyDir = mkdtempSync(join(tmpdir(), 'geoly-site-empty-build-'));
// 🔴 **先清干净再构建。** `next build` 不会删上一次留下的页面目录 ——
//    本地从"有制品"切到"空 registry"时，`.next/server/app/artifact/**` 会原样留着，
//    于是"空状态下不该有制品页"这条断言会被一堆陈旧文件绊倒（实测踩到）。
//    这也是本地换状态调试时要记得清的原因；Vercel 每次都是全新目录，不受影响。
for (const d of ['out', '.next']) rmSync(join(SITE, d), { recursive: true, force: true });
run(['build.mjs', '--snapshots', emptyDir]);
run([join(SITE, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build']);

const html = readFileSync(join(SITE, '.next', 'server', 'app', 'index.html'), 'utf8');

test('空 registry 也能构建出首页，并说清 0 是一条事实', () => {
  assert.ok(html.includes('一个制品都没有'));
  assert.ok(html.includes('连一张快照都还没有'));
  // 「0」是全站唯一的大号数字，它必须真的被排版出来，而不是缩成一句"暂无"
  assert.ok(html.includes('zerocount'), '零计数块必须在');
  assert.ok(html.includes('不是加载失败'), '必须说清 0 不是加载失败');
});

test('空状态指向三件上线前置，并说清这是有意的 fail-closed', () => {
  assert.ok(html.includes('maintainers'));
  assert.ok(html.includes('RELEASE_BOT_ID'));
  assert.ok(html.includes('CODEOWNERS'));
  assert.ok(html.includes('这是有意的，不是故障'));
});

test('🔴 空状态的产物里同样不出现使用情况指标与占位', () => {
  // 🔴 **两种构建形态都要扫。** 空状态走的是另一条构建路径、渲染的是另一套分支，
  //    只扫有制品时的 out/ 等于把现在唯一会上线的那份产物排除在检查之外。
  const dirs = [join(SITE, '.next', 'server', 'app'), join(SITE, '.next', 'static')];
  const files = dirs.filter((d) => existsSync(d)).flatMap((d) => walk(d, ['.html', '.js', '.txt', '.rsc']));
  assert.ok(files.length > 0, '没扫到任何产物文件，检查本身失效了');
  assertNoBannedWords(files, assert, SITE);
  assert.ok(!html.includes('TODO'));
});

test('🔴 空状态下不生成任何制品页', () => {
  assert.ok(!existsSync(join(SITE, 'out')), 'out/ 不该存在：空 registry 走的是非导出构建');
  // ⚠️ `.next/server/app/artifact/[kind]/…` 这些**带方括号的目录**是路由本身的编译产物，
  //    零个页面时也会有。判据是有没有真的渲染出 HTML —— 目录在不在不说明问题。
  const dir = join(SITE, '.next', 'server', 'app', 'artifact');
  const pages = existsSync(dir) ? walk(dir, ['.html']).map((p) => p.slice(SITE.length)) : [];
  assert.deepEqual(pages, [], `空 registry 却渲染出了制品页：${pages.join(', ')}`);
});
