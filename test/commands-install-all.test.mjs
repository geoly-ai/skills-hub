// `install --all` —— 09-cli.md §3。
//
// §3 的三条硬约束，每条一个用例：
//   · 名单 = 全部 kind:skill、status:published、且声明支持该 target client 的制品；
//     **不含** pack / deprecated / degraded / yanked / prerelease；
//   · 交互式要求输入**数量数字**（回车不算）；非交互必须
//     `--yes-i-really-want-everything`，🔴 `--yes` **不够**；
//   · 一律打印「装太多会让路由判定互相竞争」的告警。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.mjs';
import { parseStrict } from '../src/canonical-json.mjs';
import { readLedger, layout } from '../src/ledger.mjs';
import { assertRefGraphClosed } from '../src/pack.mjs';
import { allInstallable } from '../src/commands/install.mjs';
import { makeSnapshotDoc, makeTimestampDoc, bytesOf, fakeVerifier } from './fixtures/trustchain-objects.mjs';
import { makeSkillArtifact, makePackArtifact, cleanupTrees } from './fixtures/pack-tree.mjs';

after(cleanupTrees);

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const NOW = Date.parse('2026-08-25T13:00:00Z');
const cap = () => { const o = { s: '', write(x) { o.s += x; return true; } }; return o; };

const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-inst-all-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

/** 一个假的交互式 stdin：`isTTY` 为真，`feed()` 喂一行进去。 */
function fakeTty(line) {
  const s = new EventEmitter();
  s.isTTY = true;
  s.resume = () => { if (line !== null) queueMicrotask(() => s.emit('data', Buffer.from(`${line}\n`))); };
  s.pause = () => {};
  return s;
}

function makeWorld({ artifacts, snapshot = 42 } = {}) {
  const root = mkroot();
  const home = join(root, 'home');
  const cacheDir = join(root, 'cache');
  const stateDir = join(root, 'state');
  const repo = join(root, 'repo');
  for (const d of [home, join(cacheDir, 'snapshots'), join(cacheDir, 'assets'), stateDir, repo]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(join(home, '.claude'), { recursive: true });
  const snapDoc = makeSnapshotDoc(artifacts.map((a) => a.record), { snapshot, previous: snapshot - 1 });
  const snapBytes = bytesOf(snapDoc);
  writeFileSync(join(cacheDir, 'timestamp.json'), bytesOf(makeTimestampDoc({
    latest_snapshot: snapshot, snapshot_sha256: sha(snapBytes), min_cli_version: '0.0.0',
  })));
  writeFileSync(join(cacheDir, 'timestamp.sigstore.json'), '{}');
  writeFileSync(join(cacheDir, 'snapshots', `${snapshot}.json`), snapBytes);
  writeFileSync(join(cacheDir, 'snapshots', `${snapshot}.sigstore.json`), '{}');
  for (const a of artifacts) writeFileSync(join(cacheDir, 'assets', a.record.asset.sha256.slice(7)), a.bytes);
  return { root, home, cacheDir, stateDir, repo, snapshot, snapDoc };
}

async function run(w, argv, { stdin = null } = {}) {
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
    now: () => new Date(NOW),
    cliVersion: '1.2.3',
    verifier: fakeVerifier(),
    record: (ev) => { events.push(ev); return ev; },
    stdin: stdin ?? { isTTY: false, on() {}, removeListener() {}, resume() {}, pause() {} },
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
const dirs = (w) => (existsSync(SKILLS(w)) ? readdirSync(SKILLS(w)).filter((n) => !n.startsWith('.')).sort() : []);

/** 一锅什么都有的快照：正常两个 + 各种该被排除的。 */
function zoo() {
  const ok1 = makeSkillArtifact({ name: 'alpha' });
  const ok2 = makeSkillArtifact({ name: 'beta' });
  const dep = makeSkillArtifact({ name: 'gamma', over: { status: 'deprecated' } });
  const yank = makeSkillArtifact({ name: 'delta', over: { status: 'yanked' } });
  const degr = makeSkillArtifact({ name: 'epsilon', over: { status: 'degraded' } });
  const pre = makeSkillArtifact({ name: 'zeta', version: '0.4.0-rc.1' });
  const other = makeSkillArtifact({ name: 'eta', over: { clients: ['codex'] } });
  const pack = makePackArtifact({ members: [ok1.record] });
  return { ok1, ok2, dep, yank, degr, pre, other, pack };
}

// ════════════════════════════════════════════════════════════════════════════

test('allInstallable：只留 published 的 skill，且声明支持该 client', () => {
  const z = zoo();
  const snap = makeSnapshotDoc(Object.values(z).map((a) => a.record), { snapshot: 42 });
  const got = allInstallable(snap, 'claude').map((r) => r.name);
  assert.deepEqual(got, ['alpha', 'beta']);
  // 🔴 逐条说明为什么不在里面 —— 免得将来有人「顺手放宽一条」
  assert.equal(got.includes('gamma'), false, 'deprecated 不进');
  assert.equal(got.includes('delta'), false, 'yanked 不进');
  assert.equal(got.includes('epsilon'), false, 'degraded 不进');
  assert.equal(got.includes('zeta'), false, 'prerelease 不进');
  assert.equal(got.includes('eta'), false, '不声明支持该 client 的不进');
  assert.equal(got.includes('plaud-theme-matrix'), false, 'pack 不进');
  // 别的 client 拿到的是**另一份**名单
  assert.deepEqual(allInstallable(snap, 'codex').map((r) => r.name), ['alpha', 'beta', 'eta']);
});

test('🔴 非交互下 --all 必须给 --yes-i-really-want-everything；--yes 不够', async () => {
  const z = zoo();
  const w = makeWorld({ artifacts: Object.values(z) });

  const r1 = await run(w, ['install', '--all', '--clients', 'claude', '--json']);
  assert.equal(r1.code, 1, r1.json?.error?.message);
  assert.match(r1.json.error.message, /yes-i-really-want-everything/);

  const r2 = await run(w, ['install', '--all', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r2.code, 1, '🔴 --yes 跳过的是「可跳过的确认」，这一条不可跳过');
  assert.match(r2.json.error.message, /--yes \*\*不够\*\*|--yes/);

  // 两次都**什么都没装**
  assert.deepEqual(dirs(w), []);
});

test('--all --yes-i-really-want-everything：装全部可装的，root 是一条 all@snapshot:N', async () => {
  const z = zoo();
  const w = makeWorld({ artifacts: Object.values(z) });
  const r = await run(w, [
    'install', '--all', '--clients', 'claude', '--yes-i-really-want-everything', '--json',
  ]);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.deepEqual(dirs(w), ['alpha', 'beta']);

  const led = readLedger(layout(SKILLS(w)).ledger);
  // 🔴 一条 all root，不是 N 条 direct
  assert.deepEqual(Object.keys(led.roots), ['all@snapshot:42']);
  assert.equal(led.roots['all@snapshot:42'].kind, 'all');
  // all root **不带** artifact / tree_digest（ledger.validateRoot 明令）
  assert.equal(Object.hasOwn(led.roots['all@snapshot:42'], 'artifact'), false);
  assert.equal(Object.hasOwn(led.roots['all@snapshot:42'], 'tree_digest'), false);
  for (const n of ['alpha', 'beta']) {
    assert.deepEqual(led.entries[n].requested_by, ['all@snapshot:42']);
  }
  assertRefGraphClosed(led);

  // §3 末句：一律打印告警
  assert.match(r.stderr, /路由判定互相竞争/);
});

test('🔴 交互式：要输入**数量数字**；回车 / 别的输入都不算确认', async () => {
  const z = zoo();

  const no = makeWorld({ artifacts: Object.values(z) });
  const r1 = await run(no, ['install', '--all', '--clients', 'claude', '--json'], { stdin: fakeTty('') });
  assert.equal(r1.code, 1, '回车不算确认');
  assert.match(r1.json.error.message, /需要输入数量 2/);
  assert.deepEqual(dirs(no), [], '什么都没做');

  const nope = makeWorld({ artifacts: Object.values(z) });
  const r2 = await run(nope, ['install', '--all', '--clients', 'claude', '--json'], { stdin: fakeTty('y') });
  assert.equal(r2.code, 1, '「y」不算确认 —— §3 要的是数量');
  assert.deepEqual(dirs(nope), []);

  const yes = makeWorld({ artifacts: Object.values(z) });
  const r3 = await run(yes, ['install', '--all', '--clients', 'claude'], { stdin: fakeTty('2') });
  assert.equal(r3.code, 0, r3.stderr);
  assert.deepEqual(dirs(yes), ['alpha', 'beta']);
  // 交互式必须先把**完整名单与数量**列出来
  assert.match(r3.stdout, /--all 会装下面 2 个 skill/);
  assert.match(r3.stdout, /alpha/);
  assert.match(r3.stdout, /beta/);
});

test('🔴 --all 不与显式 spec 混用', async () => {
  const z = zoo();
  const w = makeWorld({ artifacts: Object.values(z) });
  const r = await run(w, ['install', '--all', 'alpha', '--clients', 'claude', '--json']);
  assert.equal(r.code, 1);
  assert.match(r.json.error.message, /不与显式 spec 混用/);
  assert.deepEqual(dirs(w), []);
});

test('🔴 --allow-yanked / --pre 不放宽 --all 的名单', async () => {
  const z = zoo();
  const w = makeWorld({ artifacts: Object.values(z) });
  const r = await run(w, [
    'install', '--all', '--clients', 'claude', '--yes-i-really-want-everything',
    '--allow-yanked', '--pre', '--json',
  ]);
  assert.equal(r.code, 0, r.stderr);
  // 它们是针对「我知道我在装什么」的具体制品的知情豁免；
  // --all 恰恰是「我没有逐个看」，叠加等于用一个开关授权一批没人看过的例外。
  assert.deepEqual(dirs(w), ['alpha', 'beta']);
});

test('🔴 --all：名单为空的 client 整个跳过，不走空事务、不留悬挂 root', async () => {
  // 只有 claude 支持的一个 skill —— codex 的名单是空的
  const only = makeSkillArtifact({ name: 'alpha', over: { clients: ['claude'] } });
  const w = makeWorld({ artifacts: [only] });
  mkdirSync(join(w.home, '.codex'), { recursive: true });

  const r = await run(w, [
    'install', '--all', '--clients', 'claude,codex', '--yes-i-really-want-everything', '--json',
  ]);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.deepEqual(dirs(w), ['alpha']);

  // 🔴 不跳的话它会 bootstrap 出 .geoly、烧掉一代 generation，并写进一条
  //    all@snapshot:N root 而**没有任何 entry 指向它** —— 那就是悬挂 root。
  assert.equal(existsSync(join(w.home, '.codex', 'skills')), false,
    'codex 上不该留下任何东西（连 .geoly 都不该建）');
  const row = r.json.skipped.find((x) => x.client === 'codex');
  assert.equal(row?.reason, 'nothing-installable');
  assert.equal(r.json.targets.some((t) => t.client === 'codex'), false, '它不该出现在逐 target 结果表里');
  assert.match(r.stderr, /nothing-installable/);
});

test('--all：所有 target 都没有可装的 → 0，如实说明', async () => {
  const only = makeSkillArtifact({ name: 'eta', over: { clients: ['codex'] } });
  const w = makeWorld({ artifacts: [only] });
  const r = await run(w, [
    'install', '--all', '--clients', 'claude', '--yes-i-really-want-everything', '--json',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.targets, []);
  assert.equal(r.json.skipped.find((x) => x.client === 'claude')?.reason, 'nothing-installable');
  assert.deepEqual(dirs(w), []);
});

test('🔴 同一个 skill 有两个正式版本时，--all 只取 latest（不是全都要）', async () => {
  // 🔴 这是 --all 最容易踩的坑：快照保留同一个 skill 的多个 published 版本。
  //    照着 §3 的措辞手写过滤条件会把它们全选中，两者要落到同一个目录名上 ——
  //    于是「只要有任何一个 skill 发过第二个正式版本，install --all 就永远跑不起来」。
  //    正解是用快照自己的 latest 投影（promotion 算好、parseSnapshot 校验过自洽）。
  const v1 = makeSkillArtifact({ name: 'foo', version: '1.0.0' });
  const v2 = makeSkillArtifact({ name: 'foo', version: '2.0.0' });
  const other = makeSkillArtifact({ name: 'bar', version: '0.3.6' });
  const w = makeWorld({ artifacts: [v1, v2, other] });

  const r = await run(w, [
    'install', '--all', '--clients', 'claude', '--yes-i-really-want-everything', '--json',
  ]);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.deepEqual(dirs(w), ['bar', 'foo']);
  const led = readLedger(layout(SKILLS(w)).ledger);
  assert.equal(led.entries.foo.artifact, 'skill:geoly/foo@2.0.0', '取 latest，不是第一个碰到的');

  // allInstallable 自己也要能直接查
  const snap = makeSnapshotDoc([v1.record, v2.record, other.record], { snapshot: 42 });
  assert.deepEqual(allInstallable(snap, 'claude').map((x) => x.id),
    ['skill:geoly/bar@0.3.6', 'skill:geoly/foo@2.0.0']);
});

test('🔴 交互式下 --yes-i-really-want-everything 不许跳过数量确认', async () => {
  // 09-cli.md §2 写死了它是「**仅** --all 在**非交互**下使用」——
  // 它不是「确认的第二种写法」，而是「没有终端可问时的替代品」。
  const z = zoo();
  const w = makeWorld({ artifacts: Object.values(z) });
  const r = await run(w,
    ['install', '--all', '--clients', 'claude', '--yes-i-really-want-everything', '--json'],
    { stdin: fakeTty('') });
  assert.equal(r.code, 1, '终端下它必须照常问');
  assert.match(r.json.error.message, /需要输入数量 2/);
  assert.match(r.stderr, /仅在\*\*非交互\*\*下使用|非交互/);
  assert.deepEqual(dirs(w), []);

  // 输入数量才放行
  const ok = makeWorld({ artifacts: Object.values(z) });
  const r2 = await run(ok,
    ['install', '--all', '--clients', 'claude', '--yes-i-really-want-everything'],
    { stdin: fakeTty('2') });
  assert.equal(r2.code, 0, r2.stderr);
  assert.deepEqual(dirs(ok), ['alpha', 'beta']);
});

test('🔴 all root 的 intent 不许记下那些在它身上不生效的 flag', async () => {
  const z = zoo();
  const w = makeWorld({ artifacts: Object.values(z) });
  const r = await run(w, [
    'install', '--all', '--clients', 'claude', '--yes-i-really-want-everything',
    '--pre', '--allow-yanked', '--no-bundled', '--json',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const root = readLedger(layout(SKILLS(w)).ledger).roots['all@snapshot:42'];
  // 账本记的是本机历史，历史必须是真的 —— 这三个 flag 一个都没起作用
  assert.equal(root.intent.pre, false);
  assert.equal(root.intent.no_bundled, false);
  assert.equal(Object.hasOwn(root.intent, 'allow_yanked'), false);
  // 而且要**明说**被忽略了，不能默默吞掉
  assert.match(r.stderr, /--pre 在 --all 下\*\*不生效\*\*/);
});

test('🔴 stdin 已结束 / 已 destroy 时不许挂死', async () => {
  const z = zoo();
  for (const make of [
    () => { const s2 = new EventEmitter(); s2.isTTY = true; s2.readableEnded = true; s2.resume = () => {}; s2.pause = () => {}; return s2; },
    () => { const s2 = new EventEmitter(); s2.isTTY = true; s2.destroyed = true; s2.resume = () => {}; s2.pause = () => {}; return s2; },
  ]) {
    const w = makeWorld({ artifacts: Object.values(z) });
    // 只挂 data/end/error 的读行器在这两种 stdin 上会**永远 pending**：
    // 命令挂死、没有任何输出。这里靠测试超时之外的断言把它钉住。
    const r = await run(w, ['install', '--all', '--clients', 'claude', '--json'], { stdin: make() });
    assert.equal(r.code, 1, '读不到就是没确认，而不是挂着');
    assert.match(r.json.error.message, /未确认/);
    assert.deepEqual(dirs(w), []);
  }
});

test('🔴 latest 指向 artifacts 里不存在的 id → 报「内部错误」，不静默少装一个', () => {
  // parseSnapshot 的 E_LATEST_KEYS / E_LATEST_VALUE 已经保证不会发生；
  // 走到这里只可能是我们自己的 bug，静默跳过会把它掩盖成「名单少了一个」。
  const a = makeSkillArtifact({ name: 'alpha' });
  const snap = makeSnapshotDoc([a.record], { snapshot: 42 });
  snap.latest['skill:geoly/ghost'] = '9.9.9';
  assert.throws(() => allInstallable(snap, 'claude'), /artifacts 里没有 skill:geoly\/ghost@9\.9\.9/);
});

test('🔴 §3 的「一律告警」在两条早退路径上也要打', async () => {
  const z = zoo();

  // ① 所有 client 都没有可装的 skill
  const only = makeSkillArtifact({ name: 'eta', over: { clients: ['codex'] } });
  const w1 = makeWorld({ artifacts: [only] });
  const r1 = await run(w1, [
    'install', '--all', '--clients', 'claude', '--yes-i-really-want-everything', '--json',
  ]);
  assert.equal(r1.code, 0, r1.stderr);
  assert.match(r1.stderr, /路由判定互相竞争/, '空名单也要打那条告警');

  // ② 一个 target 都选不出来：本机一个 client 目录都没有，且没点名 --clients
  //    （点名一个不存在的 client 是**硬错误**，走不到这条早退路径）
  const w2 = makeWorld({ artifacts: Object.values(z) });
  rmSync(join(w2.home, '.claude'), { recursive: true, force: true });
  const r2 = await run(w2, ['install', '--all', '--yes-i-really-want-everything', '--json']);
  assert.equal(r2.code, 0, `${r2.stderr}\n${r2.stdout}`);
  assert.match(r2.stderr, /什么都不会装/);
});

test('🔴 空名单 + TTY + flag：仍要说清那个 flag 被忽略了', async () => {
  const only = makeSkillArtifact({ name: 'eta', over: { clients: ['codex'] } });
  const w = makeWorld({ artifacts: [only] });
  const r = await run(w,
    ['install', '--all', '--clients', 'claude', '--yes-i-really-want-everything', '--json'],
    { stdin: fakeTty('0') });
  assert.equal(r.code, 0, r.stderr);
  // 它是对用户输入的如实反馈，与名单里有几个东西无关
  assert.match(r.stderr, /仅在\*\*非交互\*\*下使用/);
});
