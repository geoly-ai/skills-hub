// `install pack:<spec>` 端到端 —— 03-packs.md §4 / §4.1 / §5，04-install.md §4。
//
// 🔴 不 mock 内核：`runTransaction` / `derivePlan` / 账本都是真跑的，
//    制品是 `packDirectory()` 真打出来的字节。注入的只有验签器与缓存目录。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.mjs';
import { parseStrict } from '../src/canonical-json.mjs';
import { readLedger, layout } from '../src/ledger.mjs';
import { assertRefGraphClosed } from '../src/pack.mjs';
import { buildUnits, planEntryRefs, orphanRootsAfter } from '../src/commands/install.mjs';
import { makeSnapshotDoc, makeTimestampDoc, bytesOf, fakeVerifier } from './fixtures/trustchain-objects.mjs';
import { makeSkillArtifact, makePackArtifact, cleanupTrees } from './fixtures/pack-tree.mjs';
import { wrapTimestamp } from '../src/timestamp-envelope.mjs';

// 🔴 埋点整体关掉，而且是设 **process.env**，不是注入的 `deps.env`。
//    install 成功收尾后会自动上报一次（规格 §5.1.1），而 telemetry / upload
//    读的是 process.env（`--offline` 那条注释里已经说过这件事）。
//    只在 deps.env 里写 GEOLY_TELEMETRY=0 拦不住它 —— 那会让这套测试真的
//    往内置默认端点发一次 POST，并把状态写进开发机自己的 ~/.local/state。
process.env.GEOLY_TELEMETRY = '0';


after(cleanupTrees);

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const NOW = Date.parse('2026-08-25T13:00:00Z');
const cap = () => { const o = { s: '', write(x) { o.s += x; return true; } }; return o; };

const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-inst-pack-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const PACK_ID = 'pack:geoly/plaud-theme-matrix@0.3.6';

function scenario({ memberOver = {}, packOver = {}, docOver = {} } = {}) {
  const shared = makeSkillArtifact({ name: 'plaud-theme-shared', over: memberOver.shared ?? {} });
  const dev = makeSkillArtifact({ name: 'plaud-theme-dev', over: memberOver.dev ?? {} });
  const tool = makeSkillArtifact({ name: 'yidian-draft-pr', over: memberOver.tool ?? {} });
  const pack = makePackArtifact({
    members: [shared.record, dev.record], bundled: [tool.record], over: packOver, docOver,
  });
  return { shared, dev, tool, pack };
}

function makeWorld({ artifacts, inSnapshot = null, snapshot = 42 } = {}) {
  const root = mkroot();
  const home = join(root, 'home');
  const cacheDir = join(root, 'cache');
  const stateDir = join(root, 'state');
  const repo = join(root, 'repo');
  for (const d of [home, join(cacheDir, 'snapshots'), join(cacheDir, 'assets'), stateDir, repo]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(join(home, '.claude'), { recursive: true });
  const snapDoc = makeSnapshotDoc((inSnapshot ?? artifacts).map((a) => a.record), {
    snapshot, previous: snapshot - 1,
  });
  const snapBytes = bytesOf(snapDoc);
  // 🔴 timestamp 是**单资产信封**（决策 ③）：正文与 bundle 封在同一个文件里。
  writeFileSync(join(cacheDir, 'timestamp.json'), wrapTimestamp(bytesOf(makeTimestampDoc({
    latest_snapshot: snapshot, snapshot_sha256: sha(snapBytes), min_cli_version: '0.0.0',
  })), {}));
  writeFileSync(join(cacheDir, 'snapshots', `${snapshot}.json`), snapBytes);
  writeFileSync(join(cacheDir, 'snapshots', `${snapshot}.sigstore.json`), '{}');
  for (const a of artifacts) writeFileSync(join(cacheDir, 'assets', a.record.asset.sha256.slice(7)), a.bytes);
  return { root, home, cacheDir, stateDir, repo, snapshot };
}

async function run(w, argv) {
  const so = cap(); const se = cap();
  const events = [];
  const hadOffline = process.env.GEOLY_OFFLINE;
  delete process.env.GEOLY_OFFLINE;
  const code = await main(argv, {
    home: w.home,
    cwd: w.repo,
    env: { ...process.env, GEOLY_TELEMETRY: '0', CODEX_HOME: undefined },
    stateDir: w.stateDir,
    cacheDir: w.cacheDir,
    // 🔴 **测试绝不出网。** 注入一个会炸的 fetch —— 任何意外的网络访问
    //    当场暴露，而不是变成一次静默的真实下载。
    //    ⚠️ 2026-09-03 踩到：`fetchImpl` 缺省是 null，preheat 拿到 null 时报
    //    「没有内建 fetch」，被当成「网络失败」吞掉、退回缓存 —— 于是这套测试
    //    **看起来**是离线的。修好 null 之后它们真的开始下载 github 上的
    //    timestamp，58 个测试当场红。掩盖它的正是那个 bug。
    fetchImpl: () => { throw new Error('测试里不许出网（没有注入 fetchImpl）'); },
    now: () => new Date(NOW),
    cliVersion: '1.2.3',
    verifier: fakeVerifier(),
    record: (ev) => { events.push(ev); return ev; },
    stdout: so,
    stderr: se,
  });
  if (hadOffline === undefined) delete process.env.GEOLY_OFFLINE;
  else process.env.GEOLY_OFFLINE = hadOffline;
  let json = null;
  if (argv.includes('--json')) {
    assert.ok(so.s.length > 0, `--json 但 stdout 是空的：${se.s}`);
    json = parseStrict(so.s);
  }
  return { code, stdout: so.s, stderr: se.s, json, events };
}

const SKILLS = (w) => join(w.home, '.claude', 'skills');
const L = (w) => readLedger(layout(SKILLS(w)).ledger);

// ════════════════════════════════════════════════════════════════════════════

test('install pack:：装的是它的成员；pack 自己是 root，不是目录', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  const r = await run(w, ['install', PACK_ID, '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);

  // 1. 三个成员各一个目录
  assert.deepEqual(readdirSync(SKILLS(w)).filter((n) => !n.startsWith('.')).sort(),
    ['plaud-theme-dev', 'plaud-theme-shared', 'yidian-draft-pr']);
  // 🔴 pack 是引用不是容器：它自己**不落成目录**
  assert.equal(existsSync(join(SKILLS(w), 'plaud-theme-matrix')), false);

  // 2. 账本：pack 是一条 root，成员的 requested_by 指向它
  const led = L(w);
  assert.equal(led.roots[PACK_ID].kind, 'pack');
  assert.equal(led.roots[PACK_ID].artifact, PACK_ID);
  assert.equal(led.roots[PACK_ID].tree_digest, s.pack.record.tree_digest);
  assert.equal(led.roots[PACK_ID].snapshot, 42);
  assert.equal(Object.keys(led.entries).length, 3);
  for (const n of ['plaud-theme-dev', 'plaud-theme-shared', 'yidian-draft-pr']) {
    assert.deepEqual(led.entries[n].requested_by, [PACK_ID], `${n} 的 requested_by`);
  }
  // 3. root ↔ requested_by 图闭合（R-11 的那道门）
  assertRefGraphClosed(led);
  assert.equal(led.transaction, null, '事务收尾后 transaction 必须清空');
});

test('install pack: --no-bundled：role=tool 的成员不装，并告警', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  const r = await run(w, ['install', PACK_ID, '--clients', 'claude', '--no-bundled', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(join(SKILLS(w), 'yidian-draft-pr')), false);
  assert.deepEqual(Object.keys(L(w).entries).sort(), ['plaud-theme-dev', 'plaud-theme-shared']);
  assert.match(r.stderr, /yidian-draft-pr/);
  // 意图如实记进 root（本机历史）
  assert.equal(L(w).roots[PACK_ID].intent.no_bundled, true);
});

test('🔴 同一个 skill 被 pack 与 direct 同时请求 → **一个 entry、两条 requested_by**', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  const r = await run(w, [
    'install', PACK_ID, 'skill:geoly/plaud-theme-dev@0.3.6', '--clients', 'claude', '--json',
  ]);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  const led = L(w);
  const e = led.entries['plaud-theme-dev'];
  // 🔴 derivePlan 的 claim() 对同一事务里重复的 name 直接抛错 —— 必须合并成一项
  assert.deepEqual(e.requested_by, [PACK_ID, 'direct:skill:geoly/plaud-theme-dev@0.3.6'].sort());
  assert.equal(Object.keys(led.roots).length, 2);
  assertRefGraphClosed(led);
});

test('🔴 先 direct 装、再装含它的 pack —— direct 那条边不许被抹掉', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  assert.equal((await run(w, ['install', 'skill:geoly/plaud-theme-dev@0.3.6', '--clients', 'claude'])).code, 0);
  assert.deepEqual(L(w).entries['plaud-theme-dev'].requested_by, ['direct:skill:geoly/plaud-theme-dev@0.3.6']);

  const r = await run(w, ['install', PACK_ID, '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  const led = L(w);
  // 抹掉的话，M4 的 remove 会在还有人要它的时候把目录删掉
  assert.deepEqual(led.entries['plaud-theme-dev'].requested_by,
    [PACK_ID, 'direct:skill:geoly/plaud-theme-dev@0.3.6'].sort());
  assertRefGraphClosed(led);
});

test('🔴 两个 pack 共享一个成员 → 一个 entry、两个 pack root', async () => {
  const shared = makeSkillArtifact({ name: 'plaud-theme-shared' });
  const dev = makeSkillArtifact({ name: 'plaud-theme-dev' });
  const packA = makePackArtifact({ name: 'matrix-a', members: [shared.record, dev.record] });
  const packB = makePackArtifact({ name: 'matrix-b', members: [shared.record] });
  const w = makeWorld({ artifacts: [shared, dev, packA, packB] });
  const r = await run(w, [
    'install', 'pack:geoly/matrix-a@0.3.6', 'pack:geoly/matrix-b@0.3.6', '--clients', 'claude', '--json',
  ]);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  const led = L(w);
  assert.deepEqual(led.entries['plaud-theme-shared'].requested_by,
    ['pack:geoly/matrix-a@0.3.6', 'pack:geoly/matrix-b@0.3.6']);
  assert.deepEqual(led.entries['plaud-theme-dev'].requested_by, ['pack:geoly/matrix-a@0.3.6']);
  assertRefGraphClosed(led);
});

test('🔴 同一个目录名被两个不同制品请求 → 3，不猜谁覆盖谁', () => {
  const a = makeSkillArtifact({ name: 'dup', version: '0.1.0' });
  const b = makeSkillArtifact({ name: 'dup', version: '0.2.0' });
  assert.throws(
    () => buildUnits([a.record, b.record], []),
    (e) => e.exitCode === 3 && /两个不同的制品/.test(e.message),
  );
});

test('🔴 pack 的 conflicts 命中已装制品 → 3；--replace 必须**真的把它退掉**', async () => {
  const s = scenario();
  const rival = makeSkillArtifact({ name: 'plaud-shopify-theme' });
  const pack = makePackArtifact({
    members: [s.shared.record], bundled: [],
    docOver: { conflicts: ['skill:*/plaud-shopify-theme'] },
  });
  const w = makeWorld({ artifacts: [s.shared, rival, pack] });
  assert.equal((await run(w, ['install', 'skill:geoly/plaud-shopify-theme@0.3.6', '--clients', 'claude'])).code, 0);
  assert.ok(existsSync(join(SKILLS(w), 'plaud-shopify-theme')));

  const r = await run(w, ['install', PACK_ID, '--clients', 'claude', '--json']);
  assert.equal(r.code, 3, r.json?.error?.message);
  assert.match(r.json.error.message, /conflicts/);
  assert.match(r.json.error.message, /--replace plaud-shopify-theme/);
  // 冲突未解决时**磁盘不动**：新成员一个都不许落
  assert.equal(existsSync(join(SKILLS(w), 'plaud-theme-shared')), false);

  const r2 = await run(w, ['install', PACK_ID, '--clients', 'claude', '--replace', 'plaud-shopify-theme']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(existsSync(join(SKILLS(w), 'plaud-theme-shared')));
  // 🔴 这一条才是重点：早先 --replace 只是**跳过冲突检查**，旧的原样留着 ——
  //    门看起来在，实际两边共存。它必须在同一个事务里被退掉。
  assert.equal(existsSync(join(SKILLS(w), 'plaud-shopify-theme')), false,
    '--replace 必须真的退掉冲突方，不能只是跳过检查');
  const led = L(w);
  assert.equal(Object.hasOwn(led.entries, 'plaud-shopify-theme'), false);
  // 它的 root 失去全部引用 → 一并删掉，不留悬挂记录
  assert.equal(Object.hasOwn(led.roots, 'direct:skill:geoly/plaud-shopify-theme@0.3.6'), false);
  assertRefGraphClosed(led);
});

test('🔴 conflicts 也要看**本次事务要装的东西**，不只看账本现状', async () => {
  const rival = makeSkillArtifact({ name: 'plaud-shopify-theme' });
  const member = makeSkillArtifact({ name: 'plaud-theme-shared' });
  const pack = makePackArtifact({
    members: [member.record], bundled: [],
    docOver: { conflicts: ['skill:*/plaud-shopify-theme'] },
  });
  const w = makeWorld({ artifacts: [member, rival, pack] });
  // 空 target 上一次装两个：账本是空的，只看账本这道门就白设了
  const r = await run(w, [
    'install', PACK_ID, 'skill:geoly/plaud-shopify-theme@0.3.6', '--clients', 'claude', '--json',
  ]);
  assert.equal(r.code, 3, `${r.stdout}\n${r.stderr}`);
  assert.match(r.json.error.message, /本次要装的/);
  // 两样都是本次要装的 —— 没有 --replace 出路
  const r2 = await run(w, [
    'install', PACK_ID, 'skill:geoly/plaud-shopify-theme@0.3.6',
    '--clients', 'claude', '--replace', 'plaud-shopify-theme', '--json',
  ]);
  assert.equal(r2.code, 3);
  assert.equal(existsSync(SKILLS(w)) && readdirSync(SKILLS(w)).some((n) => !n.startsWith('.')), false);
});

test('🔴 同一条 spec 写两遍：只 fetch/验签一次', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  let fetches = 0;
  const so = cap(); const se = cap();
  const { createCacheRegistry } = await import('../src/commands/registry.mjs');
  const code = await main(
    ['install', PACK_ID, PACK_ID, 'skill:geoly/plaud-theme-dev@0.3.6', '--clients', 'claude'],
    {
      home: w.home, cwd: w.repo, stateDir: w.stateDir, cacheDir: w.cacheDir,
      env: { ...process.env, GEOLY_TELEMETRY: '0', CODEX_HOME: undefined },
      now: () => new Date(NOW), cliVersion: '1.2.3', verifier: fakeVerifier(),
      registryFactory: (o) => {
        const base = createCacheRegistry(o);
        return Object.freeze({
          ...base,
          fetchAsset(rec) { if (rec.id === PACK_ID) fetches += 1; return base.fetchAsset(rec); },
        });
      },
      stdout: so, stderr: se,
    },
  );
  assert.equal(code, 0, se.s);
  assert.equal(fetches, 1, `pack 本体应当只取一次，实际 ${fetches} 次`);
});

test('🔴 pack 的 clients（成员交集）不含该 target → 3', async () => {
  const s = scenario({ packOver: { clients: ['codex'] } });
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  const r = await run(w, ['install', PACK_ID, '--clients', 'claude', '--json']);
  assert.equal(r.code, 3, r.json?.error?.message);
  assert.match(r.json.error.message, /client=claude/);
  assert.equal(existsSync(SKILLS(w)) && readdirSync(SKILLS(w)).some((n) => !n.startsWith('.')), false);
});

test('🔴 必装成员不在快照里 → 3，整个安装终止（缺一个成员的矩阵不是矩阵）', async () => {
  const s = scenario();
  const w = makeWorld({
    artifacts: [s.shared, s.dev, s.tool, s.pack],
    inSnapshot: [s.shared, s.tool, s.pack],     // dev 的字节在缓存里，但不进快照
  });
  const r = await run(w, ['install', PACK_ID, '--clients', 'claude', '--json']);
  assert.equal(r.code, 3, r.json?.error?.message);
  assert.equal(r.json.error.unclassified, false, '🔴 不得报成「CLI 自身的 bug」');
  // 🔴 不做「跳过坏的装剩下的」
  assert.equal(existsSync(join(SKILLS(w), 'plaud-theme-shared')), false);
});

test('planEntryRefs：制品没变就合并旧边；换了版本则丢弃并交出孤儿 root', () => {
  const ledger = {
    entries: { x: { artifact: 'skill:geoly/x@0.1.0', requested_by: ['direct:skill:geoly/x@0.1.0'] } },
  };
  const same = planEntryRefs(ledger, { name: 'x', id: 'skill:geoly/x@0.1.0' }, ['pack:geoly/p@1.0.0']);
  assert.deepEqual(same.requested_by,
    ['direct:skill:geoly/x@0.1.0', 'pack:geoly/p@1.0.0'].sort(
      (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.deepEqual(same.orphanedRoots, []);

  const changed = planEntryRefs(ledger, { name: 'x', id: 'skill:geoly/x@0.2.0' }, ['pack:geoly/p@1.0.0']);
  assert.deepEqual(changed.requested_by, ['pack:geoly/p@1.0.0'], '换版本后旧 root 不再被满足');
  assert.deepEqual(changed.orphanedRoots, ['direct:skill:geoly/x@0.1.0'],
    '🔴 光丢边不够 —— 旧 root 会变成没人指向的悬挂记录');
});

test('🔴 pack 锁着的成员不许被 install 换版本（那会弄断矩阵的锁）', () => {
  const ledger = {
    entries: { x: { artifact: 'skill:geoly/x@0.1.0', requested_by: ['pack:geoly/m@0.3.6'] } },
  };
  assert.throws(
    () => planEntryRefs(ledger, { name: 'x', id: 'skill:geoly/x@0.2.0' }, ['direct:skill:geoly/x@0.2.0']),
    (e) => e.exitCode === 3 && /update pack:/.test(e.message),
  );
});

test('orphanRootsAfter：判据是**事务后的全景**，不是单条 entry 掉了哪些边', () => {
  const ledger = {
    roots: {
      'pack:geoly/m@0.3.6': {}, 'direct:skill:geoly/a@0.1.0': {}, 'direct:skill:geoly/z@0.1.0': {},
    },
    entries: {
      a: { artifact: 'skill:geoly/a@0.1.0', requested_by: ['pack:geoly/m@0.3.6', 'direct:skill:geoly/a@0.1.0'] },
      b: { artifact: 'skill:geoly/b@0.1.0', requested_by: ['pack:geoly/m@0.3.6'] },
      z: { artifact: 'skill:geoly/z@0.1.0', requested_by: ['direct:skill:geoly/z@0.1.0'] },
    },
  };
  // a 换了制品、只剩 direct 新边；但 b 还指着 pack root → pack root **不是**孤儿
  const orphans = orphanRootsAfter(ledger,
    [{ name: 'a', requested_by: ['direct:skill:geoly/a@0.2.0'] }], []);
  assert.deepEqual(orphans, ['direct:skill:geoly/a@0.1.0']);

  // 把 b 也退掉，pack root 才失去全部引用
  const orphans2 = orphanRootsAfter(ledger,
    [{ name: 'a', requested_by: ['direct:skill:geoly/a@0.2.0'] }], ['b']);
  assert.deepEqual(orphans2, ['direct:skill:geoly/a@0.1.0', 'pack:geoly/m@0.3.6']);
});
