// `update [<spec>…] | --all` 端到端 —— 09-cli.md §1，04-install.md §8「受控地改 lockfile」。
//
// 🔴 不 mock 内核：`derivePlan` / `runTransaction` / 账本 / attic 都是真跑的。
//    注入的只有验签器与缓存目录，以及一个**会抛的 fetchImpl**（测试绝不出网）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.mjs';
import { parseStrict, stringify } from '../src/canonical-json.mjs';
import { readLedger, layout } from '../src/ledger.mjs';
import { treeDigest } from '../src/tree-digest.mjs';
import { assertRefGraphClosed } from '../src/pack.mjs';
import { effectiveIntent, compileSelector, selectRoots } from '../src/commands/update.mjs';
import { makeSnapshotDoc, makeTimestampDoc, bytesOf, fakeVerifier } from './fixtures/trustchain-objects.mjs';
import { makeSkillArtifact, makePackArtifact, cleanupTrees } from './fixtures/pack-tree.mjs';
import { wrapTimestamp } from '../src/timestamp-envelope.mjs';

process.env.GEOLY_TELEMETRY = '0';
after(cleanupTrees);

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const NOW = Date.parse('2026-08-25T13:00:00Z');
const cap = () => { const o = { s: '', write(x) { o.s += x; return true; } }; return o; };
const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-update-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const P36 = 'pack:geoly/plaud-theme-matrix@0.3.6';
const P40 = 'pack:geoly/plaud-theme-matrix@0.4.0';
const P50 = 'pack:geoly/plaud-theme-matrix@0.5.0';
const DEV36 = 'skill:geoly/plaud-theme-dev@0.3.6';
const DEV40 = 'skill:geoly/plaud-theme-dev@0.4.0';

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
const dirs = (w) => readdirSync(SKILLS(w)).filter((n) => !n.startsWith('.')).sort();

/**
 * 一个覆盖 changed / added / removed / **成员没变但 root 换了** 四种情形的世界：
 *
 *   pack@0.3.6 → [shared@0.3.6, dev@0.3.6]
 *   pack@0.4.0 → [shared@0.3.6（**没变**）, dev@0.4.0（changed）, newbie@0.4.0（added）]
 *   pack@0.5.0 → [dev@0.4.0]（shared 被移除 → removed）
 */
function scenario() {
  const shared = makeSkillArtifact({ name: 'plaud-theme-shared', version: '0.3.6' });
  const dev36 = makeSkillArtifact({ name: 'plaud-theme-dev', version: '0.3.6' });
  const dev40 = makeSkillArtifact({ name: 'plaud-theme-dev', version: '0.4.0', files: { 'NEW.md': 'v2\n' } });
  const newbie = makeSkillArtifact({ name: 'newbie', version: '0.4.0' });
  const solo36 = makeSkillArtifact({ name: 'yidian-draft-pr', version: '0.3.6' });
  const solo40 = makeSkillArtifact({ name: 'yidian-draft-pr', version: '0.4.0', files: { 'NEW.md': 'v2\n' } });
  const pack36 = makePackArtifact({ version: '0.3.6', members: [shared.record, dev36.record] });
  const pack40 = makePackArtifact({ version: '0.4.0', members: [shared.record, dev40.record, newbie.record] });
  const pack50 = makePackArtifact({ version: '0.5.0', members: [dev40.record] });
  return {
    shared, dev36, dev40, newbie, solo36, solo40, pack36, pack40, pack50,
    artifacts: [shared, dev36, dev40, newbie, solo36, solo40, pack36, pack40, pack50],
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 纯函数
// ════════════════════════════════════════════════════════════════════════════

test('effectiveIntent：账本的 snake 字段要转成 resolvePackInstall 的 camel，并与本次 flag 取并', () => {
  const a = effectiveIntent({ no_bundled: true, pre: false }, { noBundled: false, pre: false, allowYanked: false });
  // 🔴 直接把 no_bundled 传下去的话，resolvePackInstall 读到的是 undefined ——
  //    「那次是带 --no-bundled 装的」这个意图会在 update 时静默失效
  assert.equal(a.camel.noBundled, true);
  assert.deepEqual(a.snake, { no_bundled: true, pre: false });
  const b = effectiveIntent({ no_bundled: false, pre: false }, { noBundled: false, pre: true, allowYanked: true });
  assert.deepEqual(b.camel, { allowYanked: true, noBundled: false, pre: true });
  assert.deepEqual(b.snake, { allow_yanked: true, no_bundled: false, pre: true });
});

test('selectRoots：一条 spec 命中多条 root 时拒绝，不猜', () => {
  const led = {
    roots: {
      'pack:geoly/m@1.0.0': { kind: 'pack' },
      'pack:other/m@1.0.0': { kind: 'pack' },
    },
  };
  assert.throws(() => selectRoots(led, [compileSelector('m')], { all: false }), /命中了多条 root/);
  assert.equal(selectRoots(led, [compileSelector('geoly/m')], { all: false })[0].key, 'pack:geoly/m@1.0.0');
  assert.equal(selectRoots(led, [], { all: true }).length, 2);
});

test('compileSelector：`all@snapshot:N` 走原文匹配；裸 `all` 当成普通 name', () => {
  const s = compileSelector('all@snapshot:42');
  assert.equal(s.kind, 'all-root');
  assert.equal(s.match('all@snapshot:42'), true);
  assert.equal(s.match('all@snapshot:43'), false);
  // 🔴 `all` 是一个合法的 skill name —— 不许把它当成「全部 all root」
  assert.equal(compileSelector('all').kind, 'artifact');
});

// ════════════════════════════════════════════════════════════════════════════
// 端到端
// ════════════════════════════════════════════════════════════════════════════

test('update pack:@<ver>：changed / added 一起做，root 从旧 key 换成新 key', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P36, '--clients', 'claude'])).code, 0);
  assert.deepEqual(dirs(w), ['plaud-theme-dev', 'plaud-theme-shared']);

  const r = await run(w, ['update', 'pack:plaud-theme-matrix@0.4.0', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);

  // 1. dev 真的换了字节；newbie 真的装进来了
  assert.deepEqual(dirs(w), ['newbie', 'plaud-theme-dev', 'plaud-theme-shared']);
  assert.ok(existsSync(join(SKILLS(w), 'plaud-theme-dev', 'NEW.md')), 'dev 应该被换成 0.4.0');
  assert.equal(treeDigest(join(SKILLS(w), 'plaud-theme-dev')), s.dev40.record.tree_digest);
  assert.equal(treeDigest(join(SKILLS(w), 'newbie')), s.newbie.record.tree_digest);

  // 2. 账本：root 换掉了，旧 root 不见了
  const led = L(w);
  assert.ok(led.roots[P40], '新 root 要在');
  assert.equal(led.roots[P36], undefined, '🔴 旧 pack root 必须被删掉');
  assert.equal(led.entries['plaud-theme-dev'].artifact, DEV40);

  // 3. 🔴 **成员没变的那一个，旧 root 边也必须消失**（Codex 2026-09-04 P0-1）。
  //    直接复用 install 的 planEntryRefs 会在这里留下 [P36, P40] 两条边 ——
  //    于是旧 root 永远删不掉、lockfile 里多出一条假记录。
  assert.deepEqual(led.entries['plaud-theme-shared'].requested_by, [P40]);
  assert.equal(led.entries['plaud-theme-shared'].artifact, 'skill:geoly/plaud-theme-shared@0.3.6');
  assert.deepEqual(led.entries['plaud-theme-dev'].requested_by, [P40]);
  assert.deepEqual(led.entries.newbie.requested_by, [P40]);
  assertRefGraphClosed(led);
  assert.equal(led.transaction, null);

  // 4. diff 里如实报了三类
  const d = r.json.targets[0].diff;
  assert.deepEqual(d.changed.map((x) => x.name), ['plaud-theme-dev']);
  assert.deepEqual(d.added.map((x) => x.name), ['newbie']);
  assert.deepEqual(d.edges.map((x) => x.name), ['plaud-theme-shared']);
  assert.deepEqual(d.root_changes, [{ from: P36, intent_changed: false, kind: 'pack', to: P40 }]);
  // 5. 埋点用 kind: 'update'
  assert.ok(r.events.some((e) => e.kind === 'update' && e.result === 'ok'));
});

test('update pack:：成员被移除 → retire-only，旧树进 attic', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P36, '--clients', 'claude'])).code, 0);

  // 不带版本 = 取 latest（0.5.0），它只剩 dev 一个成员
  const r = await run(w, ['update', 'pack:plaud-theme-matrix', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);

  assert.deepEqual(dirs(w), ['plaud-theme-dev']);
  assert.equal(existsSync(join(SKILLS(w), 'plaud-theme-shared')), false);
  const led = L(w);
  assert.equal(led.entries['plaud-theme-shared'], undefined);
  assert.ok(led.roots[P50]);
  assertRefGraphClosed(led);
  // 🔴 被退役的树进了 attic —— 可复位，不是就地蒸发
  const gen = r.json.targets[0].generation;
  assert.ok(existsSync(join(SKILLS(w), '.geoly', 'attic', String(gen), 'plaud-theme-shared.tar')));
  assert.deepEqual(r.json.targets[0].diff.removed.map((x) => x.name), ['plaud-theme-shared']);
});

test('update <name>：direct root 升到 latest', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', 'yidian-draft-pr@0.3.6', '--clients', 'claude'])).code, 0);
  assert.equal(L(w).entries['yidian-draft-pr'].artifact, 'skill:geoly/yidian-draft-pr@0.3.6');

  const r = await run(w, ['update', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  const led = L(w);
  assert.equal(led.entries['yidian-draft-pr'].artifact, 'skill:geoly/yidian-draft-pr@0.4.0');
  assert.deepEqual(led.entries['yidian-draft-pr'].requested_by, ['direct:skill:geoly/yidian-draft-pr@0.4.0']);
  assert.equal(led.roots['direct:skill:geoly/yidian-draft-pr@0.3.6'], undefined);
  assert.ok(existsSync(join(SKILLS(w), 'yidian-draft-pr', 'NEW.md')));
  assertRefGraphClosed(led);
});

test('🔴 update：未被选中的 root 还锁着旧制品 → 拒绝（判据是「任意 root」，不只是 pack）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  // dev 同时被 pack@0.3.6 与一条 direct@0.3.6 请求
  assert.equal((await run(w, ['install', P36, `${DEV36}`, '--clients', 'claude'])).code, 0);
  assert.deepEqual(L(w).entries['plaud-theme-dev'].requested_by, [P36, `direct:${DEV36}`].sort());

  const r = await run(w, ['update', 'pack:plaud-theme-matrix@0.4.0', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.json.error.message, /没有被本次选中\*\*的 root 仍然锁着/);
  assert.match(r.json.error.message, /direct:skill:geoly\/plaud-theme-dev@0\.3\.6/);
  // 什么都没动
  const led = L(w);
  assert.equal(led.entries['plaud-theme-dev'].artifact, DEV36);
  assert.ok(led.roots[P36]);

  // 🔴 把两条一起 update（--all）就该通过 —— 那时没有任何 root 还锁着旧制品
  const ok = await run(w, ['update', '--all', '--clients', 'claude', '--yes', '--json']);
  assert.equal(ok.code, 0, `${ok.stderr}\n${ok.stdout}`);
  const led2 = L(w);
  assert.equal(led2.entries['plaud-theme-dev'].artifact, DEV40);
  assert.deepEqual(led2.entries['plaud-theme-dev'].requested_by, [P50, `direct:${DEV40}`].sort());
  assertRefGraphClosed(led2);
});

test('🔴 update：非交互且有变化时，没有 --yes 就拒绝（04-install.md §8「要求确认」）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P36, '--clients', 'claude'])).code, 0);

  const r = await run(w, ['update', '--all', '--clients', 'claude', '--json'], {
    stdin: { isTTY: false, readableEnded: true },
  });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.json.error.message, /必须显式给 --yes/);
  // 一个字节都没动
  assert.equal(L(w).entries['plaud-theme-dev'].artifact, DEV36);
  assert.equal(existsSync(join(SKILLS(w), 'newbie')), false);
});

test('update：已经是最新 → 什么都不做，退 0，且不问确认', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P50, '--clients', 'claude'])).code, 0);
  const genBefore = L(w).last_applied_generation;

  const r = await run(w, ['update', '--all', '--clients', 'claude', '--json'], {
    stdin: { isTTY: false, readableEnded: true },     // 没有 --yes 也该过
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.targets[0].changed, false);
  // 🔴 没有变化就不该烧掉一代 generation
  assert.equal(L(w).last_applied_generation, genBefore);
});

test('🔴 update 拒绝 --snapshot：钉快照回答不了「现在还该不该用」', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P36, '--clients', 'claude'])).code, 0);
  const r = await run(w, ['update', '--all', '--snapshot', '42', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.json.error.message, /update 不接受 --snapshot/);
});

test('update：spec 一个 root 都没匹配上 → 用法错误，且如实说去哪看', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P36, '--clients', 'claude'])).code, 0);
  const r = await run(w, ['update', 'newbie', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.json.error.message, /没有任何 target 的账本里有匹配/);
});

test('update：没有账本的 target 是 skipped，算成功；也不建目录', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  const r = await run(w, ['update', '--all', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.targets, []);
  assert.equal(existsSync(SKILLS(w)), false);
});

test('🔴 update --all：`all@snapshot` root 推到当前全量集合 → 走 §3 的强确认（--yes 不够）', async () => {
  const s = scenario();
  // 造一张只有 skill 的世界，让 `install --all` 装得动
  const w = world({ artifacts: [s.shared, s.dev36, s.solo36] });
  assert.equal((await run(w, ['install', '--all', '--clients', 'claude',
    '--yes-i-really-want-everything'])).code, 0);
  assert.ok(L(w).roots['all@snapshot:42']);

  // 换一张更大的快照（多了 newbie）—— 直接改缓存里的快照 43 并把 timestamp 指过去
  const bigger = [s.shared, s.dev40, s.solo40, s.newbie];
  const doc = makeSnapshotDoc(bigger.map((a) => a.record), { snapshot: 43, previous: 42 });
  const bytes = bytesOf(doc);
  writeFileSync(join(w.cacheDir, 'snapshots', '43.json'), bytes);
  writeFileSync(join(w.cacheDir, 'snapshots', '43.sigstore.json'), '{}');
  // 🔴 换快照必须**同时把 timestamp.version 往前推**：同一个 version 却换了
  //    latest_snapshot / snapshot_sha256 是抗回滚要抓的完整性事件（E_FLOOR_MISMATCH）。
  writeFileSync(join(w.cacheDir, 'timestamp.json'), wrapTimestamp(bytesOf(makeTimestampDoc({
    version: 138, latest_snapshot: 43, snapshot_sha256: sha(bytes), min_cli_version: '0.0.0',
  })), {}));
  for (const a of bigger) writeFileSync(join(w.cacheDir, 'assets', a.record.asset.sha256.slice(7)), a.bytes);

  // 🔴 `--yes` 不够：全量集合的扩张必须过 §3
  const no = await run(w, ['update', '--all', '--clients', 'claude', '--yes', '--json'], {
    stdin: { isTTY: false, readableEnded: true },
  });
  assert.equal(no.code, 1, no.stderr);
  assert.match(no.json.error.message, /--yes-i-really-want-everything/);
  assert.equal(existsSync(join(SKILLS(w), 'newbie')), false);

  const yes = await run(w, ['update', '--all', '--clients', 'claude', '--yes',
    '--yes-i-really-want-everything', '--json'], { stdin: { isTTY: false, readableEnded: true } });
  assert.equal(yes.code, 0, `${yes.stderr}\n${yes.stdout}`);
  const led = L(w);
  assert.ok(led.roots['all@snapshot:43']);
  assert.equal(led.roots['all@snapshot:42'], undefined);
  assert.ok(led.entries.newbie, 'newbie 应被装进来');
  assertRefGraphClosed(led);
});

test('🔴 update：确认之后账本被改动 → 中止，不按旧计划动手', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P36, '--clients', 'claude'])).code, 0);

  // 交互式确认：在读到 y 的那一刻把账本改掉（模拟另一个进程插进来）
  const P = layout(SKILLS(w));
  const stdin = {
    isTTY: true,
    _h: {},
    on(ev, fn) { this._h[ev] = fn; return this; },
    removeListener() { return this; },
    pause() { return this; },
    resume() {
      const led = readLedger(P.ledger);
      led.entries['plaud-theme-shared'].requested_by = ['direct:skill:geoly/plaud-theme-shared@0.3.6', P36];
      led.roots['direct:skill:geoly/plaud-theme-shared@0.3.6'] = {
        artifact: 'skill:geoly/plaud-theme-shared@0.3.6', kind: 'direct',
        intent: { no_bundled: false, pre: false }, requested_at: '2026-08-25T13:00:00Z',
        snapshot: 42, tree_digest: s.shared.record.tree_digest,
      };
      writeFileSync(P.ledger, stringify(led));
      queueMicrotask(() => this._h.data?.(Buffer.from('y\n')));
      return this;
    },
  };
  const r = await run(w, ['update', 'pack:plaud-theme-matrix@0.4.0', '--clients', 'claude', '--json'], { stdin });
  assert.equal(r.code, 1, `${r.stderr}\n${r.stdout}`);
  assert.match(r.json.error.message, /账本在确认之后被改动了/);
  // 什么都没动
  assert.equal(existsSync(join(SKILLS(w), 'newbie')), false);
  assert.equal(L(w).entries['plaud-theme-dev'].artifact, DEV36);
});

test('🔴 update --project：lockfile 跟着账本一起改', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  mkdirSync(join(w.repo, '.claude'), { recursive: true });
  assert.equal((await run(w, ['install', P36, '--clients', 'claude', '--project'])).code, 0);
  const lf = join(w.repo, 'geoly-skills.lock.json');
  assert.deepEqual(parseStrict(readFileSync(lf, 'utf8')).targets[0].roots.map((x) => x.root), [P36]);

  const r = await run(w, ['update', 'pack:plaud-theme-matrix@0.4.0', '--clients', 'claude',
    '--project', '--yes', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  const doc = parseStrict(readFileSync(lf, 'utf8'));
  assert.deepEqual(doc.targets[0].roots.map((x) => x.root), [P40]);
  assert.deepEqual(doc.targets[0].entries.map((e) => e.name).sort(),
    ['newbie', 'plaud-theme-dev', 'plaud-theme-shared']);
  for (const e of doc.targets[0].entries) assert.deepEqual(e.requested_by, [P40]);
});

test('🔴 update：账本里的 pack root 不在当前快照 → 拒绝（拿不到它的 conflicts 就证明不了）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P36, 'yidian-draft-pr@0.3.6', '--clients', 'claude'])).code, 0);

  // 换一张不含 pack@0.3.6 的快照（43），并让 timestamp 指过去
  const shrunk = [s.shared, s.dev36, s.solo36, s.solo40];
  const doc = makeSnapshotDoc(shrunk.map((a) => a.record), { snapshot: 43, previous: 42 });
  const bytes = bytesOf(doc);
  writeFileSync(join(w.cacheDir, 'snapshots', '43.json'), bytes);
  writeFileSync(join(w.cacheDir, 'snapshots', '43.sigstore.json'), '{}');
  // 🔴 换快照必须**同时把 timestamp.version 往前推**：同一个 version 却换了
  //    latest_snapshot / snapshot_sha256 是抗回滚要抓的完整性事件（E_FLOOR_MISMATCH）。
  writeFileSync(join(w.cacheDir, 'timestamp.json'), wrapTimestamp(bytesOf(makeTimestampDoc({
    version: 138, latest_snapshot: 43, snapshot_sha256: sha(bytes), min_cli_version: '0.0.0',
  })), {}));

  // 只 update 那条 direct root —— pack root 没被选中，但它的 conflicts 仍要被验
  const r = await run(w, ['update', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.json.error.message, /拿不到它的 conflicts 声明/);
  assert.equal(L(w).entries['yidian-draft-pr'].artifact, 'skill:geoly/yidian-draft-pr@0.3.6');
});

test('🔴 update：新成员撞上未被账本认领的同名目录 → 退出码 3（不是 5）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P36, '--clients', 'claude'])).code, 0);
  // 用户自己在 target 里放了一个叫 newbie 的目录 —— pack@0.4.0 的新成员正好同名
  mkdirSync(join(SKILLS(w), 'newbie'), { recursive: true });
  writeFileSync(join(SKILLS(w), 'newbie', 'MINE.md'), '这是我自己的\n');

  const r = await run(w, ['update', 'pack:plaud-theme-matrix@0.4.0', '--clients', 'claude', '--yes', '--json']);
  // 🔴 3 = 冲突未解决。**不是 5** —— 没有任何残留事务，recover 无事可做。
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.json.error.message, /未被账本认领/);
  // 用户自己的目录一个字节都没动
  assert.equal(readFileSync(join(SKILLS(w), 'newbie', 'MINE.md'), 'utf8'), '这是我自己的\n');
  assert.equal(L(w).entries['plaud-theme-dev'].artifact, DEV36);
});

test('🔴 update：未选中的 pack root 现在是 degraded → 每一行都要标 [degraded]', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P36, 'yidian-draft-pr@0.3.6', '--clients', 'claude'])).code, 0);

  // 新快照 43：pack@0.3.6 被标成 degraded（某个成员被 yank 拖累），solo 有了 0.4.0
  const degraded = { ...s.pack36, record: { ...s.pack36.record, status: 'degraded' } };
  const set = [s.shared, s.dev36, s.solo36, s.solo40, degraded];
  const doc = makeSnapshotDoc(set.map((a) => a.record), { snapshot: 43, previous: 42 });
  const bytes = bytesOf(doc);
  writeFileSync(join(w.cacheDir, 'snapshots', '43.json'), bytes);
  writeFileSync(join(w.cacheDir, 'snapshots', '43.sigstore.json'), '{}');
  writeFileSync(join(w.cacheDir, 'timestamp.json'), wrapTimestamp(bytesOf(makeTimestampDoc({
    version: 138, latest_snapshot: 43, snapshot_sha256: sha(bytes), min_cli_version: '0.0.0',
  })), {}));

  // 只 update 那条 direct root；pack root 没被选中，但它现在是 degraded
  const r = await run(w, ['update', 'yidian-draft-pr', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  // 🔴 §7：degraded 必须在这一行上标出来 —— 写死 false 的话这条永远不亮
  assert.equal(r.json.targets[0].annotations.degraded, true);
});

test('🔴 update：要退役的成员被外部改过 → 退出码 2，**不删**（P0）', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  assert.equal((await run(w, ['install', P36, '--clients', 'claude'])).code, 0);
  // pack@0.5.0 会把 shared 退役 —— 用户先在里面加了自己的东西
  writeFileSync(join(SKILLS(w), 'plaud-theme-shared', 'MY-NOTES.md'), '我自己写的\n');

  const r = await run(w, ['update', 'pack:plaud-theme-matrix', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.json.error.message, /已经不是账本记录的那棵树/);
  // 🔴 判据：目录与用户的改动都还在，账本也没动
  assert.equal(readFileSync(join(SKILLS(w), 'plaud-theme-shared', 'MY-NOTES.md'), 'utf8'), '我自己写的\n');
  assert.ok(L(w).roots[P36]);
  assert.ok(L(w).entries['plaud-theme-shared']);
});

test('🔴 update：只有 intent 变了（root 与成员图都没变）也必须被当成一次变化', async () => {
  const s = scenario();
  const w = world({ artifacts: s.artifacts });
  // 装 pack@0.5.0（当前 latest），它只有 dev 一个成员 —— update 不会换任何东西
  assert.equal((await run(w, ['install', P50, '--clients', 'claude'])).code, 0);
  assert.deepEqual(L(w).roots[P50].intent, { no_bundled: false, pre: false });

  // 这一次带上 --no-bundled：root key 不变、成员图不变，**只有意图变了**
  const r = await run(w, ['update', '--all', '--no-bundled', '--clients', 'claude', '--yes', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  // 🔴 不能被当成「无变化」提前返回 —— 那样这个意图永远写不进账本，
  //    而账本记的是本机历史，历史必须是真的。
  assert.equal(r.json.targets[0].changed !== false, true, 'intent-only 变化不该被判成无变化');
  assert.deepEqual(L(w).roots[P50].intent, { no_bundled: true, pre: false });
  assert.deepEqual(r.json.targets[0].diff.root_changes,
    [{ from: P50, intent_changed: true, kind: 'pack', to: P50 }]);
});
