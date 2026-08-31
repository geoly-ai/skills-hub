// token 存储与 npx github: 判定 —— 06-submission.md §9。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  authFilePath, writeTokenFile, readTokenFile, deleteTokenFile,
  isGitSpec, detectNpxGit, assertNotNpxGit, REQUIRED_SCOPE, SCOPE_DISCLOSURE,
  makeAuthStore,
} from '../src/auth.mjs';

const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-auth-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const expectCode = (code, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

const mode = (p) => statSync(p).mode & 0o777;

// ── 存放位置 ───────────────────────────────────────────────────────────────

test('默认落在 ~/.local/state/geoly-skills/auth.json', () => {
  assert.equal(authFilePath({ env: {}, home: '/home/u' }),
    '/home/u/.local/state/geoly-skills/auth.json');
});

test('🔴 认 XDG_STATE_HOME —— 用户把 state 挪到加密卷是常见做法', () => {
  assert.equal(authFilePath({ env: { XDG_STATE_HOME: '/mnt/enc/state' }, home: '/home/u' }),
    '/mnt/enc/state/geoly-skills/auth.json');
  // 相对路径不认（XDG 规定必须是绝对路径），退回默认
  assert.equal(authFilePath({ env: { XDG_STATE_HOME: 'relative' }, home: '/home/u' }),
    '/home/u/.local/state/geoly-skills/auth.json');
});

// ── 权限 ───────────────────────────────────────────────────────────────────

test('🔴 文件 0600、父目录 0700（§9 明写）', () => {
  const p = join(mkroot(), '.local', 'state', 'geoly-skills', 'auth.json');
  writeTokenFile('gho_xxx', { path: p });
  assert.equal(mode(p), 0o600);
  assert.equal(mode(join(p, '..')), 0o700);
});

test('🔴 父目录**已存在且是 0755** 时也要收紧 —— mkdir 的 mode 对已有目录不生效', () => {
  const root = mkroot();
  const dir = join(root, 'state', 'geoly-skills');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  writeTokenFile('gho_xxx', { path: join(dir, 'auth.json') });
  assert.equal(mode(dir), 0o700, '不收紧的话，凭据就躺在一个别人能进的目录里');
});

test('🔴 文件**已存在且是 0644** 时也要收紧 —— writeFileSync 的 mode 只在新建时生效', () => {
  const p = join(mkroot(), 'auth.json');
  writeFileSync(p, '{}');
  chmodSync(p, 0o644);
  writeTokenFile('gho_xxx', { path: p });
  assert.equal(mode(p), 0o600, '沿用旧权限的话，一次 chmod 就永久变宽了');
});

// ── 读写 ───────────────────────────────────────────────────────────────────

test('写了能读回来，且带上 scope', () => {
  const p = join(mkroot(), 'auth.json');
  writeTokenFile('gho_abc', { path: p, now: () => new Date('2026-08-31T00:00:00Z') });
  const d = readTokenFile({ path: p });
  assert.equal(d.token, 'gho_abc');
  assert.equal(d.scope, REQUIRED_SCOPE);
  assert.equal(d.created_at, '2026-08-31T00:00:00.000Z');
});

test('没有文件 → null，不是抛错（未登录是正常状态）', () => {
  assert.equal(readTokenFile({ path: join(mkroot(), '没有.json') }), null);
});

test('🔴 权限变宽只告警，**不拒绝读** —— 用户此刻多半正要 logout', () => {
  const p = join(mkroot(), 'auth.json');
  writeTokenFile('gho_abc', { path: p });
  chmodSync(p, 0o644);
  const warnings = [];
  const d = readTokenFile({ path: p, warn: (s) => warnings.push(s) });
  assert.equal(d.token, 'gho_abc', '拒绝读会让他连撤销都做不了');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /644/);
});

test('坏掉的文件 → E_AUTH_CORRUPT，说清楚怎么办', () => {
  const p = join(mkroot(), 'auth.json');
  writeFileSync(p, '不是 json');
  assert.match(expectCode('E_AUTH_CORRUPT', () => readTokenFile({ path: p })).message, /删掉它再 login/);

  const p2 = join(mkroot(), 'auth.json');
  writeFileSync(p2, '{"schema":"geoly.skills.auth/1"}');
  expectCode('E_AUTH_CORRUPT', () => readTokenFile({ path: p2 }));
});

test('delete：有就删、没有返回 false', () => {
  const p = join(mkroot(), 'auth.json');
  assert.equal(deleteTokenFile({ path: p }), false);
  writeTokenFile('x', { path: p });
  assert.equal(deleteTokenFile({ path: p }), true);
  assert.equal(existsSync(p), false);
});

// ── npx github: ────────────────────────────────────────────────────────────

test('isGitSpec：git 形态的 spec 全认', () => {
  for (const s of [
    'github:geoly-ai/skills-hub', 'github:geoly-ai/skills-hub#main',
    'gitlab:a/b', 'git+https://x.com/a/b.git', 'git@github.com:a/b.git',
    'https://github.com/a/b.git', 'geoly-ai/skills-hub', 'geoly-ai/skills-hub#v1',
  ]) assert.equal(isGitSpec(s), true, s);
});

test('isGitSpec：正常的版本 spec 一个都不认（误拒比放过更常见）', () => {
  for (const s of ['^1.2.3', '1.2.3', '~0.1.0', 'latest', '*', 'npm:other@1', '', null, undefined]) {
    assert.equal(isGitSpec(s), false, String(s));
  }
});

/** 摆一个 npx 缓存的形状：`<root>/_npx/<hash>/{package.json,node_modules/<name>}`。 */
function npxCache(spec, { name = 'skills-hub' } = {}) {
  const root = mkroot();
  const hash = 'a1b2c3d4e5f6';
  const cache = join(root, '_npx', hash);
  const moduleDir = join(cache, 'node_modules', name, 'src');
  mkdirSync(moduleDir, { recursive: true });
  if (spec !== null) {
    writeFileSync(join(cache, 'package.json'), JSON.stringify({ dependencies: { [name]: spec } }));
  }
  return moduleDir;
}

test('🔴 npx github: → 认出来', () => {
  const d = detectNpxGit(npxCache('github:geoly-ai/skills-hub'));
  assert.equal(d.isNpxGit, true);
  assert.equal(d.spec, 'github:geoly-ai/skills-hub');
});

test('npx <registry 包> → 不认（那是正常用法）', () => {
  assert.equal(detectNpxGit(npxCache('^1.2.3')).isNpxGit, false);
});

test('装好的 CLI（路径里没有 _npx）→ 不认', () => {
  assert.equal(detectNpxGit('/usr/local/lib/node_modules/skills-hub/src').isNpxGit, false);
  assert.equal(detectNpxGit('/Users/x/workspace/skills-hub/src').isNpxGit, false);
});

test('🔴 _npx 目录但读不到 / 读不出 manifest → **不**断言是 git spec', () => {
  // 这道门是尽力性质的：误拒一个正常的 npx 比放过一个 npx github: 更常见
  assert.equal(detectNpxGit(npxCache(null)).isNpxGit, false);
  const dir = npxCache('github:a/b');
  writeFileSync(join(dir, '..', '..', '..', 'package.json'), '不是 json');
  assert.equal(detectNpxGit(dir).isNpxGit, false);
});

test('🔴 assertNotNpxGit：拒的时候要说清楚为什么，以及改用什么', () => {
  const e = expectCode('E_NPX_GIT', () => assertNotNpxGit(npxCache('github:geoly-ai/skills-hub'), 'publish'));
  assert.match(e.message, /publish/);
  assert.match(e.message, /ref 指向的内容随时可以被换掉/, '不说理由的拒绝，用户只会去找绕过的办法');
  assert.match(e.message, /npm i -g skills-hub/, '要给出替代做法');
  // 正常路径返回 false，不抛
  assert.equal(assertNotNpxGit('/usr/local/lib/node_modules/skills-hub/src', 'publish'), false);
});

// ── Q4 的落点 ──────────────────────────────────────────────────────────────

test('🔴 权限面披露要说清楚「它实际能做什么」，不是只报 scope 名字', () => {
  assert.match(SCOPE_DISCLOSURE, /public_repo/);
  assert.match(SCOPE_DISCLOSURE, /所有\*\*公开仓库/, '「public_repo」这四个字本身不说明任何事');
  assert.match(SCOPE_DISCLOSURE, /不用 `login`/, '要给出「不授权也能投稿」这条路');
});

// ── keychain 优先，文件兜底（§9）──────────────────────────────────────────

/** 假的命令执行器：记录调用，按脚本返回。 */
function fakeRun(script) {
  const calls = [];
  const run = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const r = script(cmd, args, input);
    if (r instanceof Error) throw r;
    return r;
  };
  return { run, calls };
}
const OK = { status: 0, stdout: '', stderr: '' };
const FAIL = { status: 1, stdout: '', stderr: 'not found' };

test('keychain 可用 → 存进 keychain，不落盘', () => {
  const p = join(mkroot(), 'auth.json');
  const { run, calls } = fakeRun(() => OK);
  const store = makeAuthStore({ run, platform: 'darwin', path: p });
  assert.equal(store.save('gho_abc'), 'keychain');
  assert.equal(existsSync(p), false, '🔴 keychain 存成了还落一份明文，等于白存');
  assert.equal(calls[0].cmd, 'security');
  assert.ok(calls[0].args.includes('-U'), 'macOS 上不加 -U，第二次 login 会以 45 号错误失败');
});

test('🔴 Linux 上 token 走 stdin，不进 argv', () => {
  const { run, calls } = fakeRun(() => OK);
  makeAuthStore({ run, platform: 'linux', path: join(mkroot(), 'auth.json') }).save('gho_secret');
  assert.equal(calls[0].input, 'gho_secret');
  assert.ok(!calls[0].args.includes('gho_secret'),
    '🔴 argv 在 /proc/<pid>/cmdline 里全用户可读 —— 存得再安全，取的路上漏了也白搭');
});

test('⚠️ macOS 的 add-generic-password 没有 stdin 选项，只能走 argv —— 如实记着', () => {
  // 这是平台限制，不是选择。缓解见 src/auth.mjs 里 KEYCHAIN 的注释。
  const { run, calls } = fakeRun(() => OK);
  makeAuthStore({ run, platform: 'darwin', path: join(mkroot(), 'auth.json') }).save('gho_secret');
  assert.ok(calls[0].args.includes('gho_secret'));
});

test('keychain 不可用 → 落文件，**并且说出来**', () => {
  const p = join(mkroot(), 'auth.json');
  const warnings = [];
  const { run } = fakeRun(() => FAIL);
  const store = makeAuthStore({ run, platform: 'linux', path: p, warn: (s) => warnings.push(s) });
  assert.equal(store.save('gho_abc'), 'file');
  assert.equal(mode(p), 0o600);
  assert.match(warnings.join('\n'), /keychain 不可用/, '用户有权知道 token 躺在哪儿');
  assert.match(warnings.join('\n'), /明文文件/);
});

test('命令根本不存在（抛错）也算不可用，不是崩', () => {
  const p = join(mkroot(), 'auth.json');
  const { run } = fakeRun(() => new Error('ENOENT'));
  assert.equal(makeAuthStore({ run, platform: 'linux', path: p }).save('x'), 'file');
});

test('不认识的平台（没有 keychain 实现）→ 直接落文件', () => {
  const p = join(mkroot(), 'auth.json');
  const { run, calls } = fakeRun(() => OK);
  assert.equal(makeAuthStore({ run, platform: 'aix', path: p }).save('x'), 'file');
  assert.equal(calls.length, 0);
});

test('load：keychain 有就用 keychain 的', () => {
  const p = join(mkroot(), 'auth.json');
  writeTokenFile('文件里的旧的', { path: p });
  const { run } = fakeRun(() => ({ status: 0, stdout: 'keychain 里的\n', stderr: '' }));
  const d = makeAuthStore({ run, platform: 'darwin', path: p }).load();
  assert.deepEqual(d, { token: 'keychain 里的', from: 'keychain' });
});

test('load：keychain 返回空串不算命中（别把空 token 当登录状态）', () => {
  const p = join(mkroot(), 'auth.json');
  writeTokenFile('文件里的', { path: p });
  const { run } = fakeRun(() => ({ status: 0, stdout: '\n', stderr: '' }));
  assert.equal(makeAuthStore({ run, platform: 'darwin', path: p }).load().from, 'file');
});

test('load：两边都没有 → null', () => {
  const { run } = fakeRun(() => FAIL);
  assert.equal(makeAuthStore({ run, platform: 'linux', path: join(mkroot(), 'auth.json') }).load(), null);
});

test('🔴 clear：keychain 与文件**两处都要清**', () => {
  // 只清 keychain 的话，一个早先落过盘的 auth.json 会留在原地 ——
  // 用户以为 logout 了，token 还躺在那儿
  const p = join(mkroot(), 'auth.json');
  writeTokenFile('落过盘的', { path: p });
  const { run } = fakeRun(() => OK);
  assert.deepEqual(makeAuthStore({ run, platform: 'darwin', path: p }).clear(), ['keychain', 'file']);
  assert.equal(existsSync(p), false);
});

// ⚠️ **没有覆盖**：目录 chmod 失败（EPERM，目录不归我们所有）那条降级路径。
//    要造出它得有一个别的用户拥有的目录，测试里造不出来（chmod 自己的目录总是成功）。
//    行为写在 src/auth.mjs 的 writeTokenFile 注释里：告警但仍然存下 token，
//    因为文件的 0600 才是保护**内容**的那一道，目录权限管的是能不能列目录。
