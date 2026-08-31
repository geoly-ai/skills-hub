// 投稿结构门 —— 06-submission.md §6 里**尚无实现**的那四条。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeName, assertNoNormalizedCollision, readReserved, assertReservedNamespaceAllowed,
  assertVersionUnused, assertCapabilityConsistency, RESERVED_SCHEMA,
} from '../scripts/submission/structural-gates.mjs';
import { collectTree } from '../src/packer.mjs';
import { makeTree, cleanupTrees } from './fixtures/pack-tree.mjs';

after(cleanupTrees);
const roots = [];
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-gate-')); roots.push(d); return d; };

const expectCode = (code, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

// ════════════════════════════════════════════════════════════════════════════
// ② 归一化重名
// ════════════════════════════════════════════════════════════════════════════

test('🔴 在当前 grammar 下，NFKC 与小写都是 no-op —— 只有「去连字符」会触发', () => {
  // name 的 grammar 是 [a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?（01-artifacts.md §3），
  // 全小写 ASCII。这条断言钉住那个事实：哪天 grammar 放宽了，它会变，
  // 改的人就会看到 structural-gates.mjs 里那段说明。
  for (const n of ['alpha', 'plaud-theme-dev', 'a1-b2-c3']) {
    assert.equal(n.normalize('NFKC'), n, `${n} 的 NFKC 应当是恒等`);
    assert.equal(n.toLowerCase(), n, `${n} 的小写应当是恒等`);
  }
  // 真正起作用的是去连字符
  assert.equal(normalizeName('plaud-theme-dev'), 'plaudthemedev');
  assert.equal(normalizeName('plaudthemedev'), 'plaudthemedev');
});

test('🔴 只差连字符的名字视为相撞', () => {
  // 两个只差连字符的名字，agent 的路由判定分不开，人也看不出来
  expectCode('E_NAME_COLLIDE', () => assertNoNormalizedCollision({
    name: 'plaud-theme', existing: ['plaudtheme'],
  }));
  expectCode('E_NAME_COLLIDE', () => assertNoNormalizedCollision({
    name: 'p-l-a-u-d', existing: ['plaud'],
  }));
  // 自己不算撞自己（重发同名的新版本是正常的）
  assert.equal(assertNoNormalizedCollision({ name: 'alpha', existing: ['alpha'] }), true);
  // 真的不同就放行
  assert.equal(assertNoNormalizedCollision({ name: 'beta', existing: ['alpha'] }), true);
});

// ════════════════════════════════════════════════════════════════════════════
// ① 保留 namespace
// ════════════════════════════════════════════════════════════════════════════

test('🔴 保留清单管的是 **namespace**，不是制品 name', () => {
  // 05-lifecycle §1.1：「以下 **namespace** 只能由 hub 维护者使用」。
  // 第一版我按 name 查 —— 那道门等于没设：namespace: geoly 的投稿会直接放行。
  const reserved = { schema: RESERVED_SCHEMA, namespaces: ['geoly', 'admin'] };
  expectCode('E_RESERVED', () => assertReservedNamespaceAllowed({ namespace: 'geoly', reserved }));
  assert.equal(assertReservedNamespaceAllowed({ namespace: 'someone-else', reserved }), true);
});

test('保留 namespace **不是**一刀切禁用 —— 维护者可以用（§1.1）', () => {
  const reserved = { schema: RESERVED_SCHEMA, namespaces: ['geoly'] };
  expectCode('E_RESERVED', () => assertReservedNamespaceAllowed({ namespace: 'geoly', reserved, byMaintainer: false }));
  assert.equal(assertReservedNamespaceAllowed({ namespace: 'geoly', reserved, byMaintainer: true }), true);
});

test('🔴 保留 namespace 的比对也走归一化 —— 否则 `ge-oly` 就绕过了 `geoly`', () => {
  // ⚠️ 这是一处**有意的放宽**（规范只说「不在 reserved.json」，字面判定）：
  //    只比字面量的话，有人抢注 `ge-oly`，随后真正的 `geoly` 反而会被 ② 那道
  //    归一化重名门挡住 —— 保留名把自己锁死了。已记进交付汇报待规格确认。
  const reserved = { schema: RESERVED_SCHEMA, namespaces: ['geoly'] };
  expectCode('E_RESERVED', () => assertReservedNamespaceAllowed({ namespace: 'ge-oly', reserved }));
});

test('reserved.json：schema 严格、**拒绝重复 key**；文件不存在＝还没有保留清单', () => {
  const root = mkroot();
  const p = join(root, 'r.json');
  writeFileSync(p, JSON.stringify({ schema: 'nope/1', namespaces: [] }));
  expectCode('E_RESERVED_SCHEMA', () => readReserved(p));
  writeFileSync(p, JSON.stringify({ schema: RESERVED_SCHEMA, namespaces: [1, 2] }));
  expectCode('E_RESERVED_SCHEMA', () => readReserved(p));
  // 🔴 11-wire-contract §1 把 reserved.json 列进适用对象，§2 要求拒绝重复 key。
  //    JSON.parse 会静默取最后一个 —— 那一行就能把整张保留清单清空。
  writeFileSync(p, '{"schema":"geoly.skills.reserved/1","namespaces":["geoly"],"namespaces":[]}');
  assert.throws(() => readReserved(p));
  assert.deepEqual(readReserved(join(root, 'nonexistent.json')).namespaces, []);
});

test('仓库里的 registry/reserved.json 与 §1.1 的清单一致', async () => {
  const { fileURLToPath } = await import('node:url');
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const doc = readReserved(join(repoRoot, 'registry/reserved.json'));
  for (const ns of ['geoly', 'hub', 'official', 'skills', 'registry', 'anthropic', 'claude',
    'cursor', 'codex', 'openai', 'github', 'npm', 'system', 'admin', 'security',
    'test', 'example', 'local']) {
    assert.ok(doc.namespaces.includes(ns), `§1.1 列了 ${ns}，reserved.json 里却没有`);
  }
  assert.equal(doc.namespaces.length, 18, '多出来的项要么是 §1.1 更新了、要么是写错了');
});

// ════════════════════════════════════════════════════════════════════════════
// ③ 版本未占用（含已 yank）
// ════════════════════════════════════════════════════════════════════════════

test('🔴 yank 不释放版本号', () => {
  const existingIds = ['skill:geoly/alpha@1.0.0'];
  // 即使 alpha@1.0.0 已被 yank，这个版本号也不能重用：
  // 制品不可变，放行等于让同一个 ArtifactId 指向两份不同的字节
  expectCode('E_VERSION_TAKEN', () => assertVersionUnused({ id: 'skill:geoly/alpha@1.0.0', existingIds }));
  assert.equal(assertVersionUnused({ id: 'skill:geoly/alpha@1.0.1', existingIds }), true);
  // 同名不同 kind 是两个东西
  assert.equal(assertVersionUnused({ id: 'pack:geoly/alpha@1.0.0', existingIds }), true);
});

// ════════════════════════════════════════════════════════════════════════════
// ④ capability 一致性
// ════════════════════════════════════════════════════════════════════════════

const entriesOf = (spec) => collectTree(makeTree(spec));

test('声明 none 且载荷干净 → 通过', () => {
  const entries = entriesOf({
    'SKILL.md': '---\nname: a\ndescription: d\n---\n\n正文，没有链接也没有脚本\n',
    'skill.json': '{}\n',
  });
  assert.equal(assertCapabilityConsistency({ capabilities: ['none'], entries }).checked, true);
});

test('🔴 声明 none 却带可执行位 → 拒', () => {
  const entries = entriesOf({
    'SKILL.md': '---\nname: a\ndescription: d\n---\n\n正文\n',
    'bin/run': { data: 'echo hi\n', mode: 0o755 },
  });
  const e = expectCode('E_CAPABILITY_INCONSISTENT', () => assertCapabilityConsistency({ capabilities: ['none'], entries }));
  assert.match(e.message, /可执行位/);
});

test('🔴 声明 none 却含脚本（扩展名或 shebang）→ 拒', () => {
  const byExt = entriesOf({ 'SKILL.md': '---\nname: a\ndescription: d\n---\n\n正文\n', 'helper.py': 'print(1)\n' });
  assert.match(
    expectCode('E_CAPABILITY_INCONSISTENT', () => assertCapabilityConsistency({ capabilities: ['none'], entries: byExt })).message,
    /看起来是脚本/,
  );
  // 没有扩展名，但有 shebang —— 扩展名那一关漏掉的，这一关接住
  const byShebang = entriesOf({ 'SKILL.md': '---\nname: a\ndescription: d\n---\n\n正文\n', 'helper': '#!/bin/sh\necho hi\n' });
  assert.match(
    expectCode('E_CAPABILITY_INCONSISTENT', () => assertCapabilityConsistency({ capabilities: ['none'], entries: byShebang })).message,
    /shebang/,
  );
});

test('🔴 外部 URL 只告警、不拒绝 —— 文档链接不等于运行时网络能力', () => {
  // ⚠️ 这一条**偏离 §6 的字面表述**（它把外部 URL 与 0755/脚本并列成拒绝条件）。
  //    理由：SKILL.md 里放一条参考链接极其常见；按字面实现会拒掉几乎每个声明
  //    none 的正常 skill，而逼人删链接、或改声明 network（错误抬高审查 Tier 与
  //    安装确认要求）两条出路都不对。一道几乎总在报红的门两周内就会被关掉 ——
  //    那时它一条都拦不住。真正处理它的是 §8 人工门第 6 条（间接指令）。
  const entries = entriesOf({
    'SKILL.md': '---\nname: a\ndescription: d\n---\n\n参考 https://docs.example.com 的说明\n',
  });
  const r = assertCapabilityConsistency({ capabilities: ['none'], entries });
  assert.equal(r.checked, true, '不拒绝');
  assert.equal(r.warnings.length, 1, '但要告警 —— 不拒绝不等于装作没看见');
  assert.match(r.warnings[0], /含外部 URL/);
});

test('🔴 capabilities 写两遍不能绕过这道门', () => {
  // 早先判据是 length === 1 && [0] === 'none'，于是 ['none','none'] 让整道门被跳过
  const entries = entriesOf({
    'SKILL.md': '---\nname: a\ndescription: d\n---\n\n正文\n',
    'run.sh': { data: '#!/bin/sh\n', mode: 0o755 },
  });
  expectCode('E_CAPABILITY_INCONSISTENT',
    () => assertCapabilityConsistency({ capabilities: ['none', 'none'], entries }));
});

test('没声明 none 时本门不适用 —— 它只管「声明不实」', () => {
  const entries = entriesOf({
    'SKILL.md': '---\nname: a\ndescription: d\n---\n\n见 https://example.com\n',
    'run.sh': { data: '#!/bin/sh\n', mode: 0o755 },
  });
  // 如实声明了 shell + network 的，本门放行（该不该批是 §8 人工门的事）
  const r = assertCapabilityConsistency({ capabilities: ['shell', 'network'], entries });
  assert.equal(r.checked, false);
});

test('⚠️ 诚实边界：没扩展名、没 shebang、没 URL 的脚本躲得过这道门', () => {
  // 这条测试记录的是**缺口**，不是能力。§8 的人工门才是处理它的地方。
  const entries = entriesOf({
    'SKILL.md': '---\nname: a\ndescription: d\n---\n\n正文\n',
    'helper': 'rm -rf /tmp/x\n',      // 没有 shebang、没有扩展名、mode 0644
  });
  assert.equal(assertCapabilityConsistency({ capabilities: ['none'], entries }).checked, true,
    '本门确实拦不住它 —— 如实记下，不假装能拦');
});
