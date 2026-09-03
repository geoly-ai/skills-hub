// 投稿结构门 —— 06-submission.md §6 里**尚无实现**的那四条。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeName, assertNoNormalizedCollision, readReserved, assertReservedNamespaceAllowed,
  assertVersionUnused, assertCapabilityConsistency, RESERVED_SCHEMA,
  foldConfusables, confusableEquals,
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

// ────────────────────────────────────────────────────────────────────────────
// ①b 同形折叠：保留清单挡不住「数字替字母」（2026-09-03 修）
// ────────────────────────────────────────────────────────────────────────────

/** 仓库真实的 18 条保留清单 —— 这道门的误伤面只在这张固定清单上才说得清。 */
const REAL_RESERVED = {
  schema: RESERVED_SCHEMA,
  namespaces: ['admin', 'anthropic', 'claude', 'codex', 'cursor', 'example', 'geoly',
    'github', 'hub', 'local', 'npm', 'official', 'openai', 'registry', 'security',
    'skills', 'system', 'test'],
};
const allow = (ns) => assertReservedNamespaceAllowed({ namespace: ns, reserved: REAL_RESERVED });

test('🔴 数字替字母的仿冒必须被拦 —— 这是本门存在的**全部理由**', () => {
  // 修之前：normalizeName 只做 NFKC + 小写 + 去连字符，于是
  //   拦住 GEOLY / Geoly / ｇeoly / g-e-o-l-y，却**放行** ge0ly / geo1y / anthrop1c。
  //   保留 anthropic / claude / openai / geoly 就是为了防仿冒，而最常见的那种防不住。
  for (const ns of [
    'ge0ly', 'geo1y', 'g30ly',            // geoly：0→o、1→l、3→e
    'anthrop1c', 'anthr0pic', '4nthropic', // anthropic
    '0penai', 'opena1',                   // openai
    'c1aude', 'ciaude',                   // claude（1→l，以及 i/l 本身同形）
    'te5t', 't3st', '7est',               // test
    'l0cal', '1ocal', 'loca1',            // local
    'sk1lls', 'skil1s',                   // skills
    'curs0r', '5ecurity', 'secur1ty', '4dmin', 'c0dex', 'g1thub', 'reg1stry', 'syst3m',
  ]) {
    expectCode('E_RESERVED', () => allow(ns));
  }
});

test('🔴 大写 I 也走这条路 —— 小写之后是 `i`，字面上并不等于 `geoly`', () => {
  // `geoIy`（大写 i）→ toLowerCase → `geoiy`，与 `geoly` **字面不等**，
  // 旧门直接放行。靠 {i,l,1} 归一到同一类才拦得住。
  expectCode('E_RESERVED', () => allow('geoIy'));
  expectCode('E_RESERVED', () => allow('cIaude'));
});

test('多字符同形：`rn`→`m`、`nn`→`m`、`vv`→`w`、`cl`→`d`', () => {
  // rn/m 是最经典的一类（`rnicrosoft.com`）。
  for (const ns of [
    'adrnin', 'adnnin',       // admin
    'systern', 'systenn',     // system
    'nprn', 'npnn',           // npm
    'exarnple', 'exannple',   // example
    'claucle', 'coclex', 'officlal', 'off1c1al', // cl→d（含与数字折叠的组合）
  ]) {
    expectCode('E_RESERVED', () => allow(ns));
  }
});

test('🔴 `cl`→`d` 与 `l`→`i` 必须闭包 —— 否则 `c1aude` 从缝里钻过去', () => {
  // Codex 2026-09-03：若「先多字符、后单字符」，`cl`→`d` 只认字面 `cl`，
  //   于是 claude→daude 而 c1aude→ciaude，两者不等，**c1aude 直接绕过**。
  //   改成「先单字符、后多字符且模式用折叠后字母」由构造保证闭包。
  const target = foldConfusables('claude');
  for (const v of ['claude', 'c1aude', 'ciaude', 'claucle', 'c1aucle', 'ciauc1e']) {
    assert.ok(confusableEquals(foldConfusables(v), target), `${v} 应与 claude 同形`);
  }
});

test('🔴 `6`/`9` 是**歧义**占位符，不能并成等价类 —— 否则 `hug` 被判成冒充 `hub`', () => {
  // `6` 既像 `b` 又像 `g`，`9` 既像 `g` 又像 `q`。把它们并进一个类会推出 `b ≡ g`，
  // 于是正常名字 `hug` 当场被杀（Codex 2026-09-03 给的误伤例）。
  // 正确做法：保留 6/9 原样，逐位按「候选集合有交集」判 —— 这个关系**故意不传递**：
  //   b ~ 6 ~ g，但 b ≁ g。
  for (const ns of ['hu6', '6eoly', '6ithub', 'githu6', 're6istry', 're9istry', '9eoly']) {
    expectCode('E_RESERVED', () => allow(ns));
  }
  assert.equal(allow('hug'), true, 'hug 是正常名字，不能因为 6 的双重身份被牵连');
  assert.ok(!confusableEquals(foldConfusables('hub'), foldConfusables('hug')), '不传递');
  assert.ok(confusableEquals(foldConfusables('hub'), foldConfusables('hu6')));
  assert.ok(confusableEquals(foldConfusables('hug'), foldConfusables('hu6')));
});

test('⚠️ 诚实边界：`l`/`i` 之外的字母↔字母替换**不覆盖** —— `qeoly` `githug` 放行', () => {
  // 🔴 这条测试钉的是**故意不做的那一层**，不是「还没做」。
  //    要挡住它们就得把 b/g/q 并成一个字母等价类 ⇒ 推出 b ≡ g ⇒ 正常名字 `hug`
  //    被判成冒充 `hub`。数字能按歧义处理（`hu6` 拦、`hug` 放行），是因为
  //    「名字里出现数字」本身是信号；两个都是普通字母时没这个信号，只能二选一。
  //    哪天有人想收紧这一层，会先看到这条测试和它的代价。
  for (const ns of ['qeoly', 'beoly', 'qithub', 'bithub', 'reqistry', 'rebistry', 'githug']) {
    assert.equal(allow(ns), true, `${ns} 属于明确不覆盖的层`);
  }
  // 对照：换成**数字**就拦得住 —— 数字是可用的信号
  for (const ns of ['6eoly', '9eoly', '6ithub', 're6istry', 're9istry']) {
    expectCode('E_RESERVED', () => allow(ns));
  }
});

test('🔴 误伤面：名字里有数字是正常的 —— `web3` `s3` `i18n` `k8s` 必须放行', () => {
  // 一道会把 web3 判成仿冒的门，报错还极难懂，两周之内就会被关掉。
  for (const ns of ['s3', 'web3', 'h5', 'i18n', 'k8s', 'a11y', 'l10n', 'oauth2', 'p2p',
    'sha256', 'base64', 'ipv6', 'vue3', 'es2015', 'node18', 'python3', 'log4j', 'web3-tools']) {
    assert.equal(allow(ns), true, `${ns} 是正常投稿，不该被同形门拦`);
  }
});

test('🔴 短保留名的拦截面是**可穷举**的 —— hub / npm 各只多拦两个串', () => {
  // ⚠️ 这条钉住的是「误伤面到底有多大」，而不是某个具体名字。
  //    整张 18 条清单的拦截面（不含连字符变体）一共 820 个串，全部列得出来 ——
  //    因为 grammar 只给攻击者 a–z0–9-。短词最容易误伤，所以逐个钉死：
  const blocked = (word, cands) => cands.filter(
    (c) => confusableEquals(foldConfusables(c), foldConfusables(word)),
  ).sort();
  const three = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
  const all3 = [];
  for (const a of three) for (const b of three) for (const c of three) all3.push(a + b + c);
  assert.deepEqual(blocked('hub', all3), ['hu6', 'hu8', 'hub'],
    'hub 的三字符拦截面必须恰好是它自己 + hu6 + hu8 —— 多一个就是误伤');
  assert.deepEqual(blocked('npm', all3), ['npm'], 'npm 的三字符拦截面只有它自己');
  // npm 的另外两个是四字符的（rn / nn 比 m 长一位）
  assert.deepEqual(blocked('npm', ['nprn', 'npnn', 'npnm', 'nprm']), ['npnn', 'nprn']);
  // `hug` / `hun` / `hud` 这类正常三字母词必须不在里面
  for (const w of ['hug', 'hun', 'hud', 'hup', 'nom', 'nam', 'npn']) {
    assert.equal(blocked(w, [w]).length, 1);          // 自反
    assert.ok(!blocked('hub', [w]).length && !blocked('npm', [w]).length, `${w} 不该被牵连`);
  }
});

test('🔴 已注册的 namespace 必须继续合法（registry/owners.json，有线上制品）', () => {
  for (const ns of ['geoly-ai', 'prompts-map', 'plaud-theme']) {
    assert.equal(allow(ns), true, `${ns} 已在 owners.json 且有线上制品，不能被误杀`);
  }
});

test('🔴 判据是**全串相等**，不是包含 —— `geoly-ai` / `my-claude-helper` 放行', () => {
  // ⚠️ 这是**有意不覆盖**的一层：包含式判定会当场杀掉 geoly-ai。
  //    「蹭名字」这一路交给 §8 的人工门，不是这道结构门。
  for (const ns of ['geoly-ai', 'my-claude-helper', 'claudes', 'hub-tools', 'testing',
    'anthropic-fan', 'openai-sdk-notes', 'someone-else']) {
    assert.equal(allow(ns), true, `${ns} 只是包含保留词，不是仿冒判据`);
  }
});

test('折叠的结构不变量：幂等，且不会把原本拦住的名字放走', () => {
  const corpus = ['geoly', 'anthropic', 'ge0ly', 'adrnin', 'web3', 'i18n', 'hu6', 'skills',
    'c1aude', 'geoly-ai', 'rnn', 'nnn', 'cinn', 'vvv', 'cicd', '6', '9', 'a-b-c'];
  for (const s of corpus) {
    // 单趟左到右扫描就是不动点（四条多字符规则的首字符 r/n/v/c 两两不同，
    // 输出 m/w/d 也都不是任何规则的首字符或次字符）
    assert.equal(foldConfusables(foldConfusables(s)), foldConfusables(s), `${s} 的折叠应幂等`);
  }
  // 🔴 最危险的回归：某条折叠反而**放走**了本来会被字面相等挡住的名字。
  //    折叠是纯函数、两侧同调 ⇒ normalizeName 相等必然蕴含同形相等。
  for (const a of corpus) {
    for (const b of corpus) {
      if (normalizeName(a) !== normalizeName(b)) continue;
      assert.ok(confusableEquals(foldConfusables(a), foldConfusables(b)),
        `${a} 与 ${b} 归一化后相等，折叠后却不同 —— 折叠放走了原本拦得住的名字`);
    }
  }
});

test('🔴 同形折叠**只**用在保留清单一侧，不用在 namespace 内的重名门', () => {
  // 两边容忍度不同：
  //   · 保留清单是**有限固定**的高风险集合（18 条），可以用更激进的折叠；
  //   · 同 namespace 内的 name 是**开放集合**，折叠会让两个正常名字互撞，
  //     且撞的对数随注册量二次增长 —— 而它挡的不是仿冒，是「人和 agent 分不开」。
  assert.equal(assertNoNormalizedCollision({ name: 'ge0ly', existing: ['geoly'] }), true);
  assert.equal(assertNoNormalizedCollision({ name: 's3-tools', existing: ['se-tools'] }), true);
  // 原有的「去连字符」判据不受影响
  expectCode('E_NAME_COLLIDE', () => assertNoNormalizedCollision({
    name: 'ge-oly', existing: ['geoly'],
  }));
});

test('reserved.json 内部必须折叠单射 —— 否则 fail-closed（折叠表放太宽的告警器）', () => {
  const root = mkroot();
  const p = join(root, 'r.json');
  writeFileSync(p, JSON.stringify({ schema: RESERVED_SCHEMA, namespaces: ['geoly', 'ge0ly'] }));
  expectCode('E_RESERVED_AMBIGUOUS', () => readReserved(p));
  // 真实清单必须是单射的
  writeFileSync(p, JSON.stringify(REAL_RESERVED));
  assert.equal(readReserved(p).namespaces.length, 18);
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
