// `vendor` 命令面端到端 —— 03-packs.md §6 / 09-cli.md §1（M2）。
//
// 🔴 这一份不 mock 库层：`materializeVendor` / `resolvePackInstall` /
//    `withVerifiedArtifact` 都是真跑的，制品也是 `packDirectory()` 真打出来的字节。
//    注入的只有**验签器**（fixture 签不出真 sigstore bundle）与**缓存目录**
//    （M1/M2 都还没有网络客户端，registry 就是缓存）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.mjs';
import { parseStrict } from '../src/canonical-json.mjs';
import { treeDigest } from '../src/tree-digest.mjs';
import { VENDORED_FILE, VENDORED_SCHEMA, STAGING_PREFIX } from '../src/vendor.mjs';
import { PACK_ERROR_EXIT, annotatePackError } from '../src/commands/pack-errors.mjs';
import { makeSnapshotDoc, makeTimestampDoc, bytesOf, fakeVerifier } from './fixtures/trustchain-objects.mjs';
import { makeSkillArtifact, makePackArtifact, cleanupTrees } from './fixtures/pack-tree.mjs';
import { wrapTimestamp } from '../src/timestamp-envelope.mjs';

after(cleanupTrees);

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const NOW = Date.parse('2026-08-25T13:00:00Z');
const cap = () => { const o = { s: '', write(x) { o.s += x; return true; } }; return o; };

const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-vendor-cli-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

/** 三个成员 + 一个 pack 的标准场景。`over` 可以改任意一份 record。 */
function scenario({ memberOver = {}, packOver = {}, docOver = {} } = {}) {
  const shared = makeSkillArtifact({
    name: 'plaud-theme-shared',
    files: { 'references/handoff-schema.md': '# 契约\n' },
    over: memberOver.shared ?? {},
  });
  const dev = makeSkillArtifact({ name: 'plaud-theme-dev', over: memberOver.dev ?? {} });
  const tool = makeSkillArtifact({ name: 'yidian-draft-pr', over: memberOver.tool ?? {} });
  const pack = makePackArtifact({
    members: [shared.record, dev.record],
    bundled: [tool.record],
    over: packOver,
    docOver,
  });
  return { shared, dev, tool, pack };
}

/**
 * 造一个世界：home / cache / state / repo，缓存里放 timestamp + snapshot + 全部资产。
 * `inSnapshot` 可以只放一部分 record 进快照（用来造「成员不在快照里」）。
 */
function makeWorld({ artifacts, inSnapshot = null, snapshot = 42 } = {}) {
  const root = mkroot();
  const home = join(root, 'home');
  const cacheDir = join(root, 'cache');
  const stateDir = join(root, 'state');
  const repo = join(root, 'repo');
  for (const d of [home, join(cacheDir, 'snapshots'), join(cacheDir, 'assets'), stateDir, repo]) {
    mkdirSync(d, { recursive: true });
  }
  const records = (inSnapshot ?? artifacts).map((a) => a.record);
  const snapDoc = makeSnapshotDoc(records, { snapshot, previous: snapshot - 1 });
  const snapBytes = bytesOf(snapDoc);
  const tsDoc = makeTimestampDoc({
    latest_snapshot: snapshot, snapshot_sha256: sha(snapBytes), min_cli_version: '0.0.0',
  });
  // 🔴 timestamp 是**单资产信封**（决策 ③）：正文与 bundle 封在同一个文件里。
  writeFileSync(join(cacheDir, 'timestamp.json'), wrapTimestamp(bytesOf(tsDoc), {}));
  writeFileSync(join(cacheDir, 'snapshots', `${snapshot}.json`), snapBytes);
  writeFileSync(join(cacheDir, 'snapshots', `${snapshot}.sigstore.json`), '{}');
  // 🔴 资产按**内容寻址**放（assets/<sha256 hex>），与 registry.mjs 的布局一致。
  //    即使某个 record 没进快照，字节也照放 —— 这样「取不到」一定是快照的判定，
  //    不是缓存恰好缺了一份。
  for (const a of artifacts) writeFileSync(join(cacheDir, 'assets', a.record.asset.sha256.slice(7)), a.bytes);
  return { root, home, cacheDir, stateDir, repo, snapshot };
}

async function run(w, argv, over = {}) {
  const so = cap(); const se = cap();
  const events = [];
  const hadOffline = process.env.GEOLY_OFFLINE;
  delete process.env.GEOLY_OFFLINE;
  const code = await main(argv, {
    home: w.home,
    cwd: over.cwd ?? w.repo,
    env: { ...process.env, GEOLY_TELEMETRY: '0', CODEX_HOME: undefined },
    stateDir: w.stateDir,
    cacheDir: w.cacheDir,
    now: () => new Date(NOW),
    cliVersion: '1.2.3',
    verifier: fakeVerifier(),
    record: (ev) => { events.push(ev); return ev; },
    stdout: so,
    stderr: se,
    ...over.deps,
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

const OUT = (w) => join(w.repo, '.github', 'codex', 'plaud-theme-matrix');
function mkOutParent(w) { mkdirSync(join(w.repo, '.github', 'codex'), { recursive: true }); }

// ════════════════════════════════════════════════════════════════════════════
// 正路
// ════════════════════════════════════════════════════════════════════════════

test('vendor：pack + 全部成员物化成一棵目录树，VENDORED.json 与磁盘自洽', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  const r = await run(w, [
    'vendor', 'pack:geoly/plaud-theme-matrix@0.3.6', '--out', OUT(w), '--json',
  ]);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);

  // 1. 布局：成员各一层目录，pack 自己的载荷在根上
  assert.deepEqual(readdirSync(OUT(w)).sort(),
    ['MATRIX.md', 'VENDORED.json', 'pack.json', 'plaud-theme-dev', 'plaud-theme-shared', 'yidian-draft-pr']);
  assert.equal(readFileSync(join(OUT(w), 'plaud-theme-shared/references/handoff-schema.md'), 'utf8'), '# 契约\n');

  // 2. VENDORED.json 记的 tree_digest 能对着磁盘复算
  const v = parseStrict(readFileSync(join(OUT(w), VENDORED_FILE), 'utf8'));
  assert.equal(v.schema, VENDORED_SCHEMA);
  assert.equal(v.pack, 'pack:geoly/plaud-theme-matrix@0.3.6');
  assert.equal(v.snapshot, 42);
  assert.equal(v.layout, 'flat');
  assert.deepEqual(v.skipped, []);
  assert.equal(v.members.find((m) => m.dir === 'plaud-theme-dev').tree_digest, s.dev.record.tree_digest);

  // 3. §7 输出契约：JSON 里逐成员列出来，且顶层摘要 = 整棵树的摘要
  assert.equal(r.json.tree_digest, treeDigest(OUT(w)));
  assert.equal(r.json.members.length, 3);
  assert.deepEqual(r.json.members.map((m) => m.role).sort(), ['matrix', 'matrix', 'tool']);
  assert.equal(r.json.skipped.length, 0);
  assert.equal(r.json.annotations.stale, false);

  // 4. 🔴 vendor **不走安装账本**：什么都不该落进 client 目录
  assert.equal(existsSync(join(w.home, '.claude', 'skills')), false);

  // 5. 埋点：kind=vendor，没有 client / scope（它不属于任何 client 目录）
  const ev = r.events.filter((e) => e.kind === 'vendor');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].artifact, 'pack:geoly/plaud-theme-matrix@0.3.6');
  assert.equal(ev[0].result, 'ok');
  assert.equal(ev[0].client, undefined);
  assert.equal(ev[0].scope, undefined);
});

test('vendor：不带版本走 latest；--out 相对路径按 cwd 解析', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  const r = await run(w, ['vendor', 'pack:plaud-theme-matrix', '--out', '.github/codex/plaud-theme-matrix']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.ok(existsSync(join(OUT(w), VENDORED_FILE)));
  // §7：不允许只打一句 done —— 逐成员列出来
  assert.match(r.stdout, /plaud-theme-shared/);
  assert.match(r.stdout, /yidian-draft-pr/);
});

test('vendor：整目录替换 —— 旧内容一个不剩', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  mkdirSync(OUT(w), { recursive: true });
  writeFileSync(join(OUT(w), '陈年垃圾.md'), 'stale\n');
  const r = await run(w, ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w)]);
  assert.equal(r.code, 0, `${r.stderr}`);
  assert.equal(existsSync(join(OUT(w), '陈年垃圾.md')), false);
  // 交换收尾干净：不留 staging / intent
  assert.deepEqual(readdirSync(join(w.repo, '.github', 'codex')).filter((n) => n.startsWith('.geoly')), []);
});

test('vendor --no-bundled：role=tool 的成员被跳过，且如实记进 VENDORED.json', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  const r = await run(w, ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--no-bundled', '--json']);
  assert.equal(r.code, 0, `${r.stderr}`);
  assert.equal(existsSync(join(OUT(w), 'yidian-draft-pr')), false);
  assert.deepEqual(r.json.skipped, [{ id: 'skill:geoly/yidian-draft-pr@0.3.6', why: 'no-bundled' }]);
  const v = parseStrict(readFileSync(join(OUT(w), VENDORED_FILE), 'utf8'));
  assert.deepEqual(v.skipped, ['skill:geoly/yidian-draft-pr@0.3.6']);
  // 跳过必须**告警**，不能只写进 JSON
  assert.match(r.stderr, /yidian-draft-pr/);
});

test('vendor：bundled 成员被 yank —— §5 跳过并告警，pack 照常物化', async () => {
  const s = scenario({ memberOver: { tool: { status: 'yanked' } } });
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  const r = await run(w, ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--json']);
  assert.equal(r.code, 0, `${r.stderr}`);
  assert.deepEqual(r.json.skipped, [{ id: 'skill:geoly/yidian-draft-pr@0.3.6', why: 'bundled-yanked' }]);
  assert.equal(existsSync(join(OUT(w), 'yidian-draft-pr')), false);
  assert.match(r.stderr, /yank/);
});

// ════════════════════════════════════════════════════════════════════════════
// 拒绝路径 —— 判据是**退出码**，不是文案
// ════════════════════════════════════════════════════════════════════════════

test('vendor：对象不是 pack → 1（用法），并点名怎么写才对', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  const r1 = await run(w, ['vendor', 'skill:geoly/plaud-theme-dev', '--out', OUT(w), '--json']);
  assert.equal(r1.code, 1);
  const r2 = await run(w, ['vendor', 'plaud-theme-dev', '--out', OUT(w), '--json']);
  assert.equal(r2.code, 1);
  assert.match(r2.json.error.message, /vendor 只物化 pack/);
  assert.equal(existsSync(OUT(w)), false, '拒绝路径不得留下半棵树');
});

test('vendor：缺 --out / 未知 flag / 多给一条 spec / 非法 --layout → 1', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  for (const argv of [
    ['vendor', 'pack:geoly/plaud-theme-matrix'],
    ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--layout', 'nested'],
    ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--deep'],
    ['vendor', 'pack:geoly/plaud-theme-matrix', 'pack:geoly/other', '--out', OUT(w)],
    ['vendor', '--out', OUT(w)],
  ]) {
    const r = await run(w, [...argv, '--json']);
    assert.equal(r.code, 1, `${argv.join(' ')} 应当是用法错误，实际 ${r.code}：${r.json?.error?.message}`);
  }
});

test('vendor：必装成员不在快照里 → 3（冲突），不是 2 也不是「内部错误」', async () => {
  const s = scenario();
  // dev 的字节在缓存里，但**不进快照** —— 判定必须来自快照，不是缓存
  const w = makeWorld({
    artifacts: [s.shared, s.dev, s.tool, s.pack],
    inSnapshot: [s.shared, s.tool, s.pack],
  });
  mkOutParent(w);
  const r = await run(w, ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--json']);
  assert.equal(r.code, 3, r.json?.error?.message);
  assert.equal(r.json.error.unclassified, false, '🔴 不得报成「CLI 自身的 bug」');
  assert.match(r.json.error.message, /plaud-theme-dev/);
  assert.equal(existsSync(OUT(w)), false);
});

test('vendor：成员摘要与快照不一致 → 2（完整性事件）', async () => {
  const s = scenario();
  // 快照里那份 record 的 tree_digest 被改掉 —— pack.json 锁的是原值
  const forged = {
    ...s.dev,
    record: { ...s.dev.record, tree_digest: `geoly-tree-v1:sha256:${'e'.repeat(64)}` },
  };
  const w = makeWorld({
    artifacts: [s.shared, s.dev, s.tool, s.pack],
    inSnapshot: [s.shared, forged, s.tool, s.pack],
  });
  mkOutParent(w);
  const r = await run(w, ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--json']);
  assert.equal(r.code, 2, r.json?.error?.message);
  assert.equal(r.json.error.unclassified, false);
  assert.match(r.json.error.message, /完整性事件/);
});

test('vendor：pack 自身 degraded → 3，且 --allow-yanked 不放行', async () => {
  const s = scenario({ packOver: { status: 'degraded' } });
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  const r = await run(w, [
    'vendor', 'pack:geoly/plaud-theme-matrix@0.3.6', '--out', OUT(w), '--allow-yanked', '--json',
  ]);
  assert.equal(r.code, 3, r.json?.error?.message);
  assert.match(r.json.error.message, /degraded/);
});

test('vendor：意图文件坏了 → 5（需人工处置），不覆盖它', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  const intent = join(w.repo, '.github', 'codex', '.geoly-vendor-intent.json');
  writeFileSync(intent, '{ 截断');
  const r = await run(w, ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--json']);
  assert.equal(r.code, 5, r.json?.error?.message);
  assert.ok(existsSync(intent), '🔴 坏掉的意图文件不得被删 —— 那会抹掉「有一次没收尾」这个事实');
});

test('vendor：上一次没收尾（staging 还在、out 也在）→ 自动收敛并大声报出来', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  const parent = join(w.repo, '.github', 'codex');
  // 先物化一次，得到一棵真的旧树
  assert.equal((await run(w, ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w)])).code, 0);
  // 伪造一次「换之前就崩了」：staging 与 intent 都在，out 也在 → 应当 rolled-back
  const staging = join(parent, `${STAGING_PREFIX}crash`);
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'x.md'), 'half\n');
  writeFileSync(join(parent, '.geoly-vendor-intent.json'), `${JSON.stringify({
    schema: 'geoly.skills.vendor-intent/1',
    out: OUT(w), staging, retired: null, tree_digest: `geoly-tree-v1:sha256:${'0'.repeat(64)}`,
  })}\n`);

  const r = await run(w, ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--json']);
  assert.equal(r.code, 0, `${r.stderr}`);
  assert.equal(r.json.recovered.action, 'rolled-back');
  assert.equal(r.json.recovered.out, OUT(w), '收敛的确实是本次这个 out');
  assert.match(r.stderr, /没收尾/);
  assert.equal(existsSync(staging), false);
  assert.ok(existsSync(join(OUT(w), VENDORED_FILE)));
});

// ════════════════════════════════════════════════════════════════════════════
// 退出码映射表本身
// ════════════════════════════════════════════════════════════════════════════

test('annotatePackError：只认表里的码；认不出来的**不给默认值**', () => {
  const err = Object.assign(new Error('x'), { name: 'PackError', code: 'E_VENDOR_LAYOUT' });
  assert.equal(annotatePackError(err).exitCode, 1);

  const unknown = Object.assign(new Error('x'), { name: 'PackError', code: 'E_BRAND_NEW' });
  annotatePackError(unknown);
  assert.equal(unknown.exitCode, undefined, '🔴 新码必须落到 classify 的 fail-closed，不得穿别人的退出码');

  // 原型链不得命中
  const proto = Object.assign(new Error('x'), { name: 'PackError', code: 'constructor' });
  annotatePackError(proto);
  assert.equal(proto.exitCode, undefined);

  // 已经带整数 exitCode 的（我们自己的 CliError）不碰
  const cli = Object.assign(new Error('x'), { exitCode: 7, code: 'E_VENDOR_LAYOUT' });
  assert.equal(annotatePackError(cli).exitCode, 7);
});

test('退出码表里的每一个 reason 都在 telemetry.REASONS 里', async () => {
  const { REASONS } = await import('../src/telemetry.mjs');
  for (const [code, [, reason]] of Object.entries(PACK_ERROR_EXIT)) {
    assert.ok(REASONS.has(reason), `${code} 的 reason ${reason} 不在 REASONS 表里`);
  }
});

test('🔴 收敛的是同一父目录下**别的** out 时，文案不得指着本次的 out 说话', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  const parent = join(w.repo, '.github', 'codex');
  // intent 文件是 `<parent>/.geoly-vendor-intent.json` —— **一个父目录一份**。
  // 邻居 sibling 崩掉留下的残留，会在本次 vendor 时被收敛（这是对的：不收敛
  // materializeVendor 会以 E_VENDOR_INTENT_PENDING 把本次永久挡住）。
  const sibling = join(parent, 'another-matrix');
  mkdirSync(sibling, { recursive: true });
  const staging = join(parent, `${STAGING_PREFIX}crash2`);
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(parent, '.geoly-vendor-intent.json'), `${JSON.stringify({
    schema: 'geoly.skills.vendor-intent/1',
    out: sibling, staging, retired: null, tree_digest: `geoly-tree-v1:sha256:${'0'.repeat(64)}`,
  })}\n`);

  const r = await run(w, ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--json']);
  assert.equal(r.code, 0, `${r.stderr}`);
  assert.equal(r.json.recovered.out, sibling, '如实报出被收敛的是邻居，不是本次的 out');
  assert.match(r.stderr, /另一个/, '必须点明「那不是本次这个目录」');
  assert.ok(existsSync(sibling), '邻居的旧树要留着（rolled-back）');
  assert.equal(existsSync(staging), false);
  assert.ok(existsSync(join(OUT(w), VENDORED_FILE)), '本次照常物化');
});

test('vendor：同一个单值 flag 给两次 → 1，不做「后一个覆盖前一个」', async () => {
  const s = scenario();
  const w = makeWorld({ artifacts: [s.shared, s.dev, s.tool, s.pack] });
  mkOutParent(w);
  const other = join(w.repo, '.github', 'codex', 'not-this-one');
  for (const argv of [
    ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--out', other],
    ['vendor', 'pack:geoly/plaud-theme-matrix', '--out', OUT(w), '--layout', 'flat', '--layout', 'flat'],
  ]) {
    const r = await run(w, [...argv, '--json']);
    assert.equal(r.code, 1, `${argv.join(' ')} 应当拒绝，实际 ${r.code}`);
    assert.match(r.json.error.message, /不止一次/);
  }
  // \U0001f534 静默覆盖的后果是整目录替换落在用户没打算动的目录上 —— 一个都不许落
  assert.equal(existsSync(other), false);
  assert.equal(existsSync(OUT(w)), false);
});

test('annotatePackError：错误对象被冻结时不得抛 TypeError 把真错误顶掉', () => {
  const frozen = Object.freeze(Object.assign(new Error('成员摘要不符'), {
    name: 'PackError', code: 'E_PACK_MEMBER_DIGEST',
  }));
  const got = annotatePackError(frozen);
  assert.equal(got.exitCode, 2);
  // 机器可读的三样必须都还在 —— 脚本靠它们分辨具体是哪一条
  assert.equal(got.name, 'PackError');
  assert.equal(got.code, 'E_PACK_MEMBER_DIGEST');
  assert.equal(got.message, '成员摘要不符');
  assert.equal(frozen.exitCode, undefined, '原对象是冻结的，不该被改（也改不动）');
});

test('E_VENDOR_DIR_COLLIDE 归 1（解析失败），与 pack.json 校验失败同码', async () => {
  const { PACK_ERROR_EXIT: T } = await import('../src/commands/pack-errors.mjs');
  assert.equal(T.E_VENDOR_DIR_COLLIDE[0], 1);
  // 🔴 与它同类的那一条：validatePackManifest 的 WireError 也落 1
  const { EXIT } = await import('../src/exit-codes.mjs');
  assert.equal(T.E_VENDOR_DIR_COLLIDE[0], EXIT.USAGE);
});
