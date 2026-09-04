// `remove <name>` 端到端 —— 09-cli.md §1「减引用；为空才删目录」，04-install.md §4.1。
//
// 🔴 不 mock 内核：`derivePlan` / `runTransaction` / 账本 / attic 都是真跑的。
//    注入的只有验签器与缓存目录，以及一个**会抛的 fetchImpl**（测试绝不出网）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync,
  renameSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.mjs';
import { parseStrict, stringify } from '../src/canonical-json.mjs';
import { readLedger, layout } from '../src/ledger.mjs';
import { assertRefGraphClosed } from '../src/pack.mjs';
import { makeSnapshotDoc, makeTimestampDoc, bytesOf, fakeVerifier } from './fixtures/trustchain-objects.mjs';
import { makeSkillArtifact, makePackArtifact, cleanupTrees } from './fixtures/pack-tree.mjs';
import { wrapTimestamp } from '../src/timestamp-envelope.mjs';

process.env.GEOLY_TELEMETRY = '0';
after(cleanupTrees);

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const NOW = Date.parse('2026-08-25T13:00:00Z');
const cap = () => { const o = { s: '', write(x) { o.s += x; return true; } }; return o; };
const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-remove-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const PACK_ID = 'pack:geoly/plaud-theme-matrix@0.3.6';
const DEV = 'skill:geoly/plaud-theme-dev@0.3.6';

function world({ artifacts, snapshot = 42 } = {}) {
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
  writeFileSync(join(cacheDir, 'timestamp.json'), wrapTimestamp(bytesOf(makeTimestampDoc({
    latest_snapshot: snapshot, snapshot_sha256: sha(snapBytes), min_cli_version: '0.0.0',
  })), {}));
  writeFileSync(join(cacheDir, 'snapshots', `${snapshot}.json`), snapBytes);
  writeFileSync(join(cacheDir, 'snapshots', `${snapshot}.sigstore.json`), '{}');
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
    cwd: w.repo,
    env: { ...process.env, GEOLY_TELEMETRY: '0', CODEX_HOME: undefined },
    stateDir: w.stateDir,
    cacheDir: w.cacheDir,
    // 🔴 **测试绝不出网**：注入一个会抛的 fetch，任何意外访问当场暴露。
    fetchImpl: () => { throw new Error('测试里不许出网（没有注入 fetchImpl）'); },
    now: () => new Date(NOW),
    cliVersion: '1.2.3',
    verifier: fakeVerifier(),
    record: (ev) => { events.push(ev); return ev; },
    stdout: so,
    stderr: se,
    ...over,
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
const names = (w) => readdirSync(SKILLS(w)).filter((n) => !n.startsWith('.')).sort();

/** 一个既有 pack 又有 direct 的现场：dev 被两边一起要着。 */
function scenario() {
  const shared = makeSkillArtifact({ name: 'plaud-theme-shared' });
  const dev = makeSkillArtifact({ name: 'plaud-theme-dev' });
  const solo = makeSkillArtifact({ name: 'yidian-draft-pr' });
  const pack = makePackArtifact({ members: [shared.record, dev.record], bundled: [] });
  return { shared, dev, solo, pack, artifacts: [shared, dev, solo, pack] };
}

// ════════════════════════════════════════════════════════════════════════════

test('remove：引用归零 → 真的删目录，旧树进 attic，root 一并删掉', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', '--clients', 'claude'])).code, 0);
  assert.ok(names(w).includes('yidian-draft-pr'));

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);

  // 1. 目录真的没了
  assert.equal(existsSync(join(SKILLS(w), 'yidian-draft-pr')), false);
  // 2. 账本里 entry 与 root 都没了，图仍然闭合
  const led = L(w);
  assert.equal(led.entries['yidian-draft-pr'], undefined);
  assert.equal(led.roots['direct:skill:geoly/yidian-draft-pr@0.3.6'], undefined);
  assert.equal(led.transaction, null);
  assertRefGraphClosed(led);
  // 3. 🔴 旧树进了 attic —— 「删掉」必须是可复位的，不是就地蒸发
  const gen = r.json.targets[0].generation;
  const attic = join(SKILLS(w), '.geoly', 'attic', String(gen));
  assert.ok(existsSync(join(attic, 'yidian-draft-pr.tar')), `attic 里应有 tar：${readdirSync(attic)}`);
  assert.ok(existsSync(join(attic, 'manifest.json')));
  // 4. §7 输出契约
  assert.equal(r.json.targets[0].deleted, true);
  assert.deepEqual(Object.keys(r.json.targets[0].annotations).sort(),
    ['degraded', 'offline', 'shadowed', 'stale', 'yanked']);
  // 5. 埋点
  assert.equal(r.events.filter((e) => e.kind === 'remove').length, 1);
  assert.equal(r.events.find((e) => e.kind === 'remove').result, 'ok');
});

test('🔴 remove：引用没归零 → **不删目录**，只摘掉那一条 direct 边', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  // dev 被 pack 与 direct 同时请求
  assert.equal((await run(w, ['install', PACK_ID, 'plaud-theme-dev', '--clients', 'claude'])).code, 0);
  assert.deepEqual(L(w).entries['plaud-theme-dev'].requested_by, [PACK_ID, `direct:${DEV}`].sort());

  const r = await run(w, ['remove', 'plaud-theme-dev', '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);

  // 🔴 目录**必须还在** —— 这是「减引用；为空才删目录」的正主
  assert.ok(existsSync(join(SKILLS(w), 'plaud-theme-dev', 'SKILL.md')));
  const led = L(w);
  assert.deepEqual(led.entries['plaud-theme-dev'].requested_by, [PACK_ID]);
  assert.equal(led.roots[`direct:${DEV}`], undefined, 'direct root 已经没有人指向，应被删掉');
  assert.ok(led.roots[PACK_ID], 'pack root 还要留着');
  assertRefGraphClosed(led);
  assert.equal(r.json.targets[0].deleted, false);
  assert.deepEqual(r.json.targets[0].remaining, [PACK_ID]);
  // 🔴 只减边时**不问确认**（没给 --yes 也过了）：没有任何东西会被删
  assert.equal(r.json.targets[0].ok, true);
});

test('🔴 remove：只被 pack 请求时拒绝 —— 不发明「删掉整条 pack root」的语法', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', PACK_ID, '--clients', 'claude'])).code, 0);

  const r = await run(w, ['remove', 'plaud-theme-shared', '--clients', 'claude', '--yes', '--json']);
  // 🔴 1（用法）：这是「你要的这件事这条命令做不到，请改命令行」，
  //    不是「两样东西不能共存」（3）。规范只给了 `remove <name>` 一种语法。
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.json.error.message, /没有可减的\*\*直接\*\*引用/);
  assert.match(r.json.error.message, new RegExp(PACK_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // 什么都没动
  assert.ok(existsSync(join(SKILLS(w), 'plaud-theme-shared', 'SKILL.md')));
  assert.deepEqual(L(w).entries['plaud-theme-shared'].requested_by, [PACK_ID]);
});

test('🔴 remove：账本里有 entry、磁盘上目录缺席 → 退出码 2（不是 5）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', '--clients', 'claude'])).code, 0);
  rmSync(join(SKILLS(w), 'yidian-draft-pr'), { recursive: true, force: true });

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  // 🔴 2 = 完整性失败。**不是 5** —— 没有 journal 可续做，recover 对它无事可做。
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.json.error.message, /账本与磁盘不符/);
  assert.doesNotMatch(r.json.error.message, /先跑 check 就好/);
  // 账本没被动过
  assert.ok(L(w).entries['yidian-draft-pr']);
});

test('🔴 remove：目录内容被外部改过 → 拒绝改账本（严格复验，不是只比摘要）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', PACK_ID, 'plaud-theme-dev', '--clients', 'claude'])).code, 0);
  // dev 会走「只减边」的 adopt 分支 —— 把它的字节改掉
  writeFileSync(join(SKILLS(w), 'plaud-theme-dev', 'SKILL.md'), '被别人改过\n');

  const r = await run(w, ['remove', 'plaud-theme-dev', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 2, r.stderr);
  // 账本没被改：那两条边都还在
  assert.deepEqual(L(w).entries['plaud-theme-dev'].requested_by, [PACK_ID, `direct:${DEV}`].sort());
});

test('🔴 remove：非交互且会删目录时，没有 --yes 就拒绝（什么都不做）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', '--clients', 'claude'])).code, 0);

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--json'], {
    stdin: { isTTY: false, readableEnded: true },
  });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.json.error.message, /必须显式给 --yes/);
  assert.ok(existsSync(join(SKILLS(w), 'yidian-draft-pr')), '拒绝之后目录必须还在');
});

test('remove：没装过 / 没有账本的 target 是 skipped，算成功', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.targets, []);
  assert.ok(r.json.skipped.some((x) => x.reason === 'no-target' || x.reason === 'no-ledger'));
});

test('remove：用法门 —— 恰好一个 name，且必须过路径 grammar', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['remove', '--json'])).code, 1);
  assert.equal((await run(w, ['remove', 'a', 'b', '--json'])).code, 1);
  const bad = await run(w, ['remove', '../etc', '--json']);
  assert.equal(bad.code, 1);
  assert.match(bad.json.error.message, /不合法/);
  // 🔴 root key 不是合法入参 —— 规范只给了 `remove <name>`
  const rk = await run(w, ['remove', PACK_ID, '--json']);
  assert.equal(rk.code, 1, rk.stderr);
});

test('🔴 remove --project：账本变了之后 lockfile 必须被重算', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  mkdirSync(join(w.repo, '.claude'), { recursive: true });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', 'plaud-theme-shared',
    '--clients', 'claude', '--project'])).code, 0);
  const lf = join(w.repo, 'geoly-skills.lock.json');
  assert.ok(existsSync(lf));
  assert.equal(parseStrict(readFileSync(lf, 'utf8')).targets[0].entries.length, 2);

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--project', '--yes', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  const doc = parseStrict(readFileSync(lf, 'utf8'));
  assert.deepEqual(doc.targets[0].entries.map((e) => e.name), ['plaud-theme-shared']);
  assert.deepEqual(doc.targets[0].roots.map((x) => x.root), ['direct:skill:geoly/plaud-theme-shared@0.3.6']);
});

test('🔴 remove --project：lockfile 要用的历史快照取不回来时，**在提交之前**就失败', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  mkdirSync(join(w.repo, '.claude'), { recursive: true });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', 'plaud-theme-shared',
    '--clients', 'claude', '--project'])).code, 0);
  const before = readFileSync(join(w.repo, 'geoly-skills.lock.json'), 'utf8');
  const projSkills = join(w.repo, '.claude', 'skills');
  assert.ok(existsSync(join(projSkills, 'yidian-draft-pr')));
  // 把缓存里的快照删掉：钩子在 runCleanup 末尾才调，那时事务已经提交、
  // journal 已经清掉 —— 预热的全部意义就是把这一格搬到还没动手的时刻。
  rmSync(join(w.cacheDir, 'snapshots', '42.json'));

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--project', '--yes', '--json']);
  assert.notEqual(r.code, 0, '取不到历史快照就必须失败');
  assert.match(r.json.error.message, /asset_sha256|取不回来/);
  // 🔴 判据：**事务没有发生** —— 目录还在、账本没变、lockfile 没变
  assert.ok(existsSync(join(projSkills, 'yidian-draft-pr')));
  assert.ok(readLedger(layout(projSkills).ledger).entries['yidian-draft-pr']);
  assert.equal(readFileSync(join(w.repo, 'geoly-skills.lock.json'), 'utf8'), before);
});

test('🔴 remove：direct root 被别的 entry 也指着（坏账本）→ 拒绝，不「顺手修」', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', 'plaud-theme-shared',
    '--clients', 'claude'])).code, 0);
  // 手动把 shared 的 requested_by 指到 yidian 的 direct root 上 —— 一张不自洽的图
  const P = layout(SKILLS(w));
  const led = readLedger(P.ledger);
  led.entries['plaud-theme-shared'].requested_by = ['direct:skill:geoly/yidian-draft-pr@0.3.6'];
  writeFileSync(P.ledger, stringify(led));

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 2, r.stderr);
  assert.ok(existsSync(join(SKILLS(w), 'yidian-draft-pr')));
});

test('🔴 remove：账本的引用图不闭合（悬挂边）→ 消费之前就拒绝', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', '--clients', 'claude'])).code, 0);
  const P = layout(SKILLS(w));
  const led = readLedger(P.ledger);
  led.entries['yidian-draft-pr'].requested_by = ['pack:geoly/nope@1.0.0'];
  writeFileSync(P.ledger, stringify(led));

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.json.error.message, /引用图不自洽/);
});

// remove 不该建任何目录：`--create-missing` 只该得到一句告警
test('🔴 remove 不为没有账本的 target 建目录（--create-missing 只告警）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  const codexHome = join(w.home, '.codex');
  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude',
    '--create-missing', 'all', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(codexHome), false);
  assert.ok(r.json.warnings.some((x) => /--create-missing 在 remove 上不生效/.test(x.message)));
  // target 目录本身也不许被建出来
  assert.equal(existsSync(SKILLS(w)), false);
});

test('🔴 remove：要删的目录被外部改过 → 退出码 2，**不删**（P0：只查存在性会静默删掉用户改动）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', '--clients', 'claude'])).code, 0);
  // 用户在里面加了自己的东西
  writeFileSync(join(SKILLS(w), 'yidian-draft-pr', 'MY-NOTES.md'), '我自己写的\n');

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  // 🔴 2 = 完整性。早先只查 existsSync，于是 derivePlan 会对**当前**内容重算
  //    old_digest，把这棵被改过的树归档删掉，命令还返回 0。
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.json.error.message, /已经不是账本记录的那棵树/);
  // 🔴 判据：目录与用户的改动都还在
  assert.equal(readFileSync(join(SKILLS(w), 'yidian-draft-pr', 'MY-NOTES.md'), 'utf8'), '我自己写的\n');
  assert.ok(L(w).entries['yidian-draft-pr']);
});

test('🔴 remove --project：预热覆盖**全部在册**项目 target，不只是本次动的那个', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  mkdirSync(join(w.repo, '.claude'), { recursive: true });
  mkdirSync(join(w.repo, '.codex'), { recursive: true });
  // 两个 client 都装上 —— recalcLockfile 投影的是**全部**项目级 target
  assert.equal((await run(w, ['install', 'yidian-draft-pr', '--clients', 'claude', '--project'])).code, 0);
  assert.equal((await run(w, ['install', 'plaud-theme-shared', '--clients', 'codex', '--project'])).code, 0);

  const projSkills = join(w.repo, '.claude', 'skills');
  const before = readFileSync(join(w.repo, 'geoly-skills.lock.json'), 'utf8');
  // codex 那份 entry 也要靠快照 42 取 asset_sha256 —— 缓存里没有它，
  // 收尾钩子就会在**事务已提交之后**炸。预热必须把这一格提到动手之前。
  rmSync(join(w.cacheDir, 'snapshots', '42.json'));

  const r = await run(w, ['remove', 'yidian-draft-pr', '--project', '--yes', '--json']);
  assert.notEqual(r.code, 0, '任一在册项目 target 缺历史快照都必须在提交之前挡住');
  // 🔴 判据：事务没有发生
  assert.ok(existsSync(join(projSkills, 'yidian-draft-pr')));
  assert.ok(readLedger(layout(projSkills).ledger).entries['yidian-draft-pr']);
  assert.equal(readFileSync(join(w.repo, 'geoly-skills.lock.json'), 'utf8'), before);
});

test('🔴 remove：账本顶点标签错配（entry 名 ≠ artifact 的 name）→ 消费之前就拒绝', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', '--clients', 'claude'])).code, 0);
  const P = layout(SKILLS(w));
  const led = readLedger(P.ledger);
  // 边照旧闭合，只是把 artifact 换成另一个名字的制品 —— 只查边的门看不见这个
  led.entries['yidian-draft-pr'].artifact = 'skill:geoly/plaud-theme-dev@0.3.6';
  led.roots['direct:skill:geoly/plaud-theme-dev@0.3.6'] = led.roots['direct:skill:geoly/yidian-draft-pr@0.3.6'];
  delete led.roots['direct:skill:geoly/yidian-draft-pr@0.3.6'];
  led.entries['yidian-draft-pr'].requested_by = ['direct:skill:geoly/plaud-theme-dev@0.3.6'];
  led.roots['direct:skill:geoly/plaud-theme-dev@0.3.6'].artifact = 'skill:geoly/plaud-theme-dev@0.3.6';
  writeFileSync(P.ledger, stringify(led));

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.json.error.message, /引用图不自洽/);
  assert.ok(existsSync(join(SKILLS(w), 'yidian-draft-pr')));
});

test('🔴 remove --project：预热遇到**完整性**错时不许降成网络错（6）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  mkdirSync(join(w.repo, '.claude'), { recursive: true });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', 'plaud-theme-shared',
    '--clients', 'claude', '--project'])).code, 0);
  const projSkills = join(w.repo, '.claude', 'skills');
  const before = readFileSync(join(w.repo, 'geoly-skills.lock.json'), 'utf8');

  // 把缓存里的 42.json 换成一份「自称是 99 号」的快照：
  // readHistoricalSnapshot 的 expectSnapshot 会抛 IntegrityError（E_SNAPSHOT_N）。
  const tampered = makeSnapshotDoc(s.artifacts.map((a) => a.record), { snapshot: 99, previous: 98 });
  writeFileSync(join(w.cacheDir, 'snapshots', '42.json'), bytesOf(tampered));

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--project', '--yes', '--json']);
  // 🔴 **2（完整性），不是 6（网络）**。把所有异常一律包成 NetworkError 的话，
  //    「有人在改字节」会被报成「网络不好」——那正是 isDegradable 那条注释在防的事。
  assert.equal(r.code, 2, `${r.stderr}\n${JSON.stringify(r.json.error)}`);
  assert.equal(r.json.error.name, 'IntegrityError');
  // 事务没有发生
  assert.ok(existsSync(join(projSkills, 'yidian-draft-pr')));
  assert.equal(readFileSync(join(w.repo, 'geoly-skills.lock.json'), 'utf8'), before);
});

test('🔴 remove：entry 根被换成 symlink（内容一模一样）→ 严格验明必须失败', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', '--clients', 'claude'])).code, 0);
  // 把真目录挪到外面，原地放一条指向它的软链 —— 内容逐字节相同、摘要也相同
  const real = join(w.root, 'elsewhere');
  renameSync(join(SKILLS(w), 'yidian-draft-pr'), real);
  symlinkSync(real, join(SKILLS(w), 'yidian-draft-pr'));

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  // 🔴 strictPayloadCheck 是从 readdirSync(dir) 开始递归的 —— 它查子项是不是
  //    symlink，**不查根自己**。不补这道门的话，这条软链会被当成我们的制品处置。
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.json.error.message, /symlink|普通目录/);
  // 外面那棵真树一个字节都没动
  assert.ok(existsSync(join(real, 'SKILL.md')));
});

test('🔴 remove --project：**别的**项目 target 停在未完成事务时，也要在提交之前挡住', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  mkdirSync(join(w.repo, '.claude'), { recursive: true });
  mkdirSync(join(w.repo, '.codex'), { recursive: true });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', '--clients', 'claude', '--project'])).code, 0);
  assert.equal((await run(w, ['install', 'plaud-theme-shared', '--clients', 'codex', '--project'])).code, 0);

  // 给 codex 那份（本次只动 claude）造一份停在 prepared 的 journal
  const otherP = layout(join(w.repo, '.codex', 'skills'), 9);
  mkdirSync(otherP.journalDir, { recursive: true });
  writeFileSync(otherP.journal, stringify({
    schema: 'geoly.skills.journal/1',
    generation: 9,
    items: {},
    ledger_image: {
      ledger_existed: true,
      post: { entries: {}, last_applied_generation: 9, roots: {} },
      pre: { entries: {}, last_applied_generation: 8, roots: {} },
    },
    phase: 'prepared',
    tx_dir: 'tx-9',
  }));

  const projSkills = join(w.repo, '.claude', 'skills');
  const before = readFileSync(join(w.repo, 'geoly-skills.lock.json'), 'utf8');
  const r = await run(w, ['remove', 'yidian-draft-pr', '--project', '--clients', 'claude,codex',
    '--yes', '--json']);
  assert.notEqual(r.code, 0, '别人停在未完成事务时也必须在提交之前挡住');
  // 🔴 判据：事务没有发生
  assert.ok(existsSync(join(projSkills, 'yidian-draft-pr')));
  assert.equal(readFileSync(join(w.repo, 'geoly-skills.lock.json'), 'utf8'), before);
});

test('🔴 remove：root 记录的 kind 与 key 的 grammar 不一致 → 消费之前就拒绝', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', 'yidian-draft-pr', '--clients', 'claude'])).code, 0);
  const P = layout(SKILLS(w));
  const led = readLedger(P.ledger);
  led.roots['direct:skill:geoly/yidian-draft-pr@0.3.6'].kind = 'pack';
  writeFileSync(P.ledger, stringify(led));

  const r = await run(w, ['remove', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.json.error.message, /kind=pack 与 key 推出的 direct 不一致/);
  assert.ok(existsSync(join(SKILLS(w), 'yidian-draft-pr')));
});
