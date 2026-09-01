// 命令面端到端：造一个**真的**本地 fixture 制品，用注入的验签器，
// 真的装进一个临时 target，再 check / list / why / recover / sync-lock 一遍。
//
// 🔴 这一份不 mock 内核：`runTransaction` / `recover` / `projectLockfile` 都是真跑的。
//    注入的只有两样：**验签器**（fixture 签不出真 sigstore bundle）与
//    **缓存目录**（M1 没有网络客户端，registry 就是缓存）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync,
  readdirSync, rmSync, statSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { parseStrict, stringify } from '../src/canonical-json.mjs';
import { verifyAndExtract } from '../src/artifact.mjs';
import { treeDigest } from '../src/tree-digest.mjs';
import { readLedger, layout } from '../src/ledger.mjs';
import { readJournal, writeJournal } from '../src/journal.mjs';
import { makeTarGz } from './fixtures/trustchain-tar.mjs';
import { makeRecord, makeSnapshotDoc, makeTimestampDoc, bytesOf, fakeVerifier, hex } from './fixtures/trustchain-objects.mjs';
import { wrapTimestamp } from '../src/timestamp-envelope.mjs';

// 🔴 埋点整体关掉，而且是设 **process.env**，不是注入的 `deps.env`。
//    install 成功收尾后会自动上报一次（规格 §5.1.1），而 telemetry / upload
//    读的是 process.env（`--offline` 那条注释里已经说过这件事）。
//    只在 deps.env 里写 GEOLY_TELEMETRY=0 拦不住它 —— 那会让这套测试真的
//    往内置默认端点发一次 POST，并把状态写进开发机自己的 ~/.local/state。
process.env.GEOLY_TELEMETRY = '0';


const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const NOW = Date.parse('2026-08-25T13:00:00Z');
const cap = () => { const o = { s: '', write(x) { o.s += x; return true; } }; return o; };
const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-cli-e2e-')); roots.push(d); return d; };
process.on('exit', () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

// ── fixture 制品 ────────────────────────────────────────────────────────────

/** 造一个自洽的 skill 制品：tar.gz + 与字节相符的 snapshot record。 */
function makeArtifact({ name = 'demo', version = '0.1.0', clients = ['claude'], status = 'published', body = 'hello' } = {}) {
  const skillJson = stringify({
    schema: 'geoly.skills.skill/1',
    kind: 'skill',
    namespace: 'geoly',
    name,
    version,
    description: `${name} 的说明`,
    license: 'MIT',
    clients,
    capabilities: ['none'],
    replaces: [],
    conflicts: [],
    provenance: { kind: 'original', author_github_id: '1', submitted_by_pr: 2 },
  });
  const skillMd = `---\nname: ${name}\ndescription: demo\n---\n\n# ${name}\n\n${body}\n`;
  const gz = makeTarGz([
    { path: 'SKILL.md', data: skillMd },
    { path: 'skill.json', data: skillJson },
  ]);
  // 先解一次算真实 tree_digest，再回填进 record —— 这样 record 与字节自洽
  const probe = makeRecord({
    name, version, asset: { file: 'x', sha256: sha(gz), size: gz.length },
    tree_digest: `geoly-tree-v1:sha256:${hex(0)}`,
  });
  let td;
  try { verifyAndExtract({ bytes: gz, record: probe }); } catch (e) {
    td = /重算 (geoly-tree-v1:sha256:[0-9a-f]{64})/.exec(e.message)?.[1] ?? null;
    if (!td) throw e;
  }
  const record = makeRecord({
    name, version, clients, status,
    tree_digest: td,
    asset: { file: `skill_geoly_${name}_${version}.tar.gz`, sha256: sha(gz), size: gz.length },
  });
  return { gz, record, skillMd };
}

/**
 * 造一个完整的世界：home / cache / state，以及缓存里的 timestamp + snapshot + 资产。
 * 🔴 cache 是**内容寻址**的（`assets/<sha256 hex>`），与 `registry.mjs` 的布局一致。
 */
function makeWorld({ artifacts = [makeArtifact()], snapshot = 42, minCli = '0.0.0', yanked } = {}) {
  const root = mkroot();
  const home = join(root, 'home');
  const cacheDir = join(root, 'cache');
  const stateDir = join(root, 'state');
  const projectRoot = join(root, 'repo');
  for (const d of [home, join(cacheDir, 'snapshots'), join(cacheDir, 'assets'), stateDir, projectRoot]) {
    mkdirSync(d, { recursive: true });
  }
  // 🔴 「本机已存在的 client 目录」= `$HOME/.claude`。默认造出来，
  //    这样绝大多数用例走的是**正常现场**；「目录不存在」单独有一个用例测。
  //    注意：target 是它下面的 `skills/`，那一层**故意不建** —— 由 CLI 自己建。
  mkdirSync(join(home, '.claude'), { recursive: true });
  const snapDoc = makeSnapshotDoc(artifacts.map((a) => a.record), {
    snapshot, previous: snapshot - 1, ...(yanked === undefined ? {} : { yanked }),
  });
  const snapBytes = bytesOf(snapDoc);
  const tsDoc = makeTimestampDoc({ latest_snapshot: snapshot, snapshot_sha256: sha(snapBytes), min_cli_version: minCli });
  // 🔴 timestamp 是**单资产信封**（决策 ③）：正文与 bundle 封在同一个文件里。
  writeFileSync(join(cacheDir, 'timestamp.json'), wrapTimestamp(bytesOf(tsDoc), {}));
  writeFileSync(join(cacheDir, 'snapshots', `${snapshot}.json`), snapBytes);
  writeFileSync(join(cacheDir, 'snapshots', `${snapshot}.sigstore.json`), '{}');
  for (const a of artifacts) {
    writeFileSync(join(cacheDir, 'assets', a.record.asset.sha256.slice(7)), a.gz);
  }
  return { root, home, cacheDir, stateDir, projectRoot, snapDoc, tsDoc, artifacts };
}

/** 跑一条命令。返回 `{ code, stdout, stderr, json, events }`。 */
async function run(w, argv, over = {}) {
  const so = cap(); const se = cap();
  const events = [];
  // 🔴 `--offline` 置的是 **process.env**（telemetry / upload 读的就是它，
  //    而 `--offline` 承诺的是一条进程级保证）。真实 CLI 一个进程只跑一条命令，
  //    所以它「粘住」是对的；但测试在**同一个进程里**连跑多条，
  //    不重置就会让上一条的 --offline 悄悄影响下一条。
  const hadOffline = process.env.GEOLY_OFFLINE;
  delete process.env.GEOLY_OFFLINE;
  const code = await main(argv, {
    home: w.home,
    cwd: over.cwd ?? w.projectRoot,
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

const CLAUDE_G = (w) => join(w.home, '.claude', 'skills');

// ════════════════════════════════════════════════════════════════════════════
// install
// ════════════════════════════════════════════════════════════════════════════

test('端到端：install 真的把制品装进 target，并留下自洽的账本', async () => {
  const w = makeWorld();
  const r = await run(w, ['install', 'demo', '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);

  // 1. 磁盘上真的有那棵树，且字节等于 record 的 tree_digest
  const dir = join(CLAUDE_G(w), 'demo');
  assert.ok(existsSync(join(dir, 'SKILL.md')));
  assert.equal(treeDigest(dir), w.artifacts[0].record.tree_digest);
  assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /hello/);

  // 2. 账本自洽：entry + root + requested_by 边
  const L = readLedger(layout(CLAUDE_G(w)).ledger);
  assert.equal(L.entries.demo.artifact, 'skill:geoly/demo@0.1.0');
  assert.equal(L.entries.demo.tree_digest, w.artifacts[0].record.tree_digest);
  assert.deepEqual(L.entries.demo.requested_by, ['direct:skill:geoly/demo@0.1.0']);
  assert.equal(L.roots['direct:skill:geoly/demo@0.1.0'].kind, 'direct');
  assert.equal(L.transaction, null, '事务收尾后 transaction 必须清空');

  // 3. 🔴 §7：逐 target 结果表，即使全部成功
  assert.equal(r.json.targets.length, 1);
  assert.equal(r.json.targets[0].client, 'claude');
  assert.equal(r.json.targets[0].ok, true);
  assert.deepEqual(r.json.targets[0].installed, ['demo']);
  assert.equal(r.json.snapshot, 42);

  // 4. 🔴 标注挂在每一个 target 上，不是只挂顶层
  assert.deepEqual(Object.keys(r.json.targets[0].annotations).sort(),
    ['degraded', 'offline', 'shadowed', 'stale', 'yanked']);

  // 5. 埋点：kind 用枚举、有 client/scope、成功时不带 reason
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, 'install');
  assert.equal(r.events[0].result, 'ok');
  assert.equal(r.events[0].client, 'claude');
  assert.equal(r.events[0].artifact, 'skill:geoly/demo@0.1.0');
  assert.equal(r.events[0].reason, undefined);

  // 6. trust floor 被推进并落盘
  const floor = parseStrict(readFileSync(join(w.stateDir, 'trust.json'), 'utf8'));
  assert.equal(floor.latest_snapshot, 42);

  // 7. 🔴 事务收尾后不留半截状态：没有 tx-*、没有未完成 journal、解包目录已清
  const state = layout(CLAUDE_G(w)).state;
  assert.deepEqual(readdirSync(state).filter((n) => n.startsWith('tx-')), []);
  assert.deepEqual(readdirSync(state).filter((n) => n.startsWith('geoly-unpack-')), []);
  assert.equal(existsSync(join(state, 'journal', '1.json')), false);
});

test('install 幂等：同一条命令跑第二遍仍然 0，且账本只有一条 entry', async () => {
  const w = makeWorld();
  const a = ['install', 'demo', '--clients', 'claude', '--json'];
  assert.equal((await run(w, a)).code, 0);
  const r2 = await run(w, a);
  assert.equal(r2.code, 0, r2.stderr);
  const L = readLedger(layout(CLAUDE_G(w)).ledger);
  assert.deepEqual(Object.keys(L.entries), ['demo']);
  assert.equal(L.transaction, null);
});

test('🔴 未被账本认领的同名目录：默认阻断（退出码 3），--replace 点名才放行', async () => {
  const w = makeWorld();
  const dir = join(CLAUDE_G(w), 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '别人的东西\n');

  const r = await run(w, ['install', 'demo', '--clients', 'claude', '--json']);
  assert.equal(r.code, 3, r.stdout);
  assert.match(r.json.targets[0].error, /未被账本认领/);
  assert.match(r.json.targets[0].error, /--replace demo/);
  // 🔴 没有泛化的 --force
  assert.match(r.json.targets[0].error, /没有泛化的 --force/);
  // 阻断了就不许动那个目录
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '别人的东西\n');

  const r2 = await run(w, ['install', 'demo', '--clients', 'claude', '--replace', 'demo', '--json']);
  assert.equal(r2.code, 0, r2.stdout);
  assert.equal(treeDigest(dir), w.artifacts[0].record.tree_digest);
});

test('🔴 yanked 默认拒绝（3）；--allow-yanked 放行并写进账本 intent', async () => {
  const a = makeArtifact({ name: 'demo', status: 'yanked' });
  const w = makeWorld({ artifacts: [a] });
  const r = await run(w, ['install', 'demo@0.1.0', '--clients', 'claude', '--json']);
  assert.equal(r.code, 3, r.stdout);
  assert.match(r.json.error.message, /已被 yank/);

  const r2 = await run(w, ['install', 'demo@0.1.0', '--clients', 'claude',
    '--allow-yanked', '--json']);
  assert.equal(r2.code, 0, r2.stdout);
  assert.match(r2.stderr, /已被 yank，仍按 --allow-yanked 安装/);
  const L = readLedger(layout(CLAUDE_G(w)).ledger);
  assert.equal(L.roots['direct:skill:geoly/demo@0.1.0'].intent.allow_yanked, true);
  // 🔴 每一次相关输出都要标 yanked
  assert.equal(r2.json.targets[0].annotations.yanked, true);
});

test('§5 解析规则：@ 精确版本、latest 取最高非 prerelease', async () => {
  const w = makeWorld({
    artifacts: [
      makeArtifact({ name: 'demo', version: '0.1.0' }),
      makeArtifact({ name: 'demo', version: '0.2.0' }),
      makeArtifact({ name: 'demo', version: '0.3.0-rc.1' }),
    ],
  });
  const r = await run(w, ['install', 'demo', '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.installed[0].artifact, 'skill:geoly/demo@0.2.0');

  const w2 = makeWorld({ artifacts: [makeArtifact({ name: 'demo', version: '0.1.0' }), makeArtifact({ name: 'demo', version: '0.2.0' })] });
  const r2 = await run(w2, ['install', 'demo@0.1.0', '--clients', 'claude', '--json']);
  assert.equal(r2.json.installed[0].artifact, 'skill:geoly/demo@0.1.0');
});

test('§5 规则 2：多 namespace 同名 → 报错列候选，不猜（退出码 1）', async () => {
  const a = makeArtifact({ name: 'demo' });
  const b = makeArtifact({ name: 'demo' });
  b.record = { ...b.record, namespace: 'other', id: 'skill:other/demo@0.1.0', path: 'artifacts/skills/other/demo/0.1.0' };
  const w = makeWorld({ artifacts: [a, b] });
  const r = await run(w, ['install', 'demo', '--clients', 'claude', '--json']);
  // geoly 优先（规则 2 ①），所以这里其实**能**解析出来
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.installed[0].artifact, 'skill:geoly/demo@0.1.0');

  // 两个都不在 geoly 下时才是歧义
  const c = makeArtifact({ name: 'demo' });
  c.record = { ...c.record, namespace: 'nsa', id: 'skill:nsa/demo@0.1.0', path: 'artifacts/skills/nsa/demo/0.1.0' };
  const d = makeArtifact({ name: 'demo' });
  d.record = { ...d.record, namespace: 'nsb', id: 'skill:nsb/demo@0.1.0', path: 'artifacts/skills/nsb/demo/0.1.0' };
  const w2 = makeWorld({ artifacts: [c, d] });
  const r2 = await run(w2, ['install', 'demo', '--clients', 'claude', '--json']);
  assert.equal(r2.code, 1, r2.stdout);
  assert.deepEqual(r2.json.error.candidates, ['nsa/demo', 'nsb/demo']);
});

test('🔴 制品未声明支持该 client → 冲突（3），不静默跳过', async () => {
  const w = makeWorld({ artifacts: [makeArtifact({ clients: ['cursor'] })] });
  const r = await run(w, ['install', 'demo', '--clients', 'claude', '--json']);
  assert.equal(r.code, 3, r.stdout);
  assert.match(r.json.error.message, /未声明支持 client=claude/);
});

test('🔴 --clients 点了一个门没过的 client → 硬错误，不降级成 skipped', async () => {
  const w = makeWorld();
  const r = await run(w, ['install', 'demo', '--clients', 'cursor', '--json']);
  assert.notEqual(r.code, 0);
  assert.match(r.json.error.message, /Q12 门是 pending/);
  // 🔴 硬错误，不是 skipped —— 「兼容性不是部分失败」
  assert.match(r.json.error.message, /目标解析失败/);
});

test('目录不存在且没给 --create-missing → skipped，且**算成功**（退出码 0）', async () => {
  const w = makeWorld();
  rmSync(join(w.home, '.claude'), { recursive: true, force: true });
  const r = await run(w, ['install', 'demo', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.targets.length, 0);
  assert.ok(r.json.skipped.some((s) => s.reason === 'missing-dir'));
});

// ════════════════════════════════════════════════════════════════════════════
// --offline
// ════════════════════════════════════════════════════════════════════════════

test('🔴 --offline 且缓存未命中 → 退出码 6，且措辞点明是离线未命中', async () => {
  const w = makeWorld();
  rmSync(join(w.cacheDir, 'timestamp.json'));
  const r = await run(w, ['install', 'demo', '--clients', 'claude', '--offline', '--json']);
  assert.equal(r.code, 6, r.stdout);
  assert.match(r.json.error.message, /未命中缓存（--offline）/);
});

test('🔴 --offline 全程无网络出口：process 里没有任何 fetch 被调用', async () => {
  const w = makeWorld();
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => { called++; throw new Error('测试断言：--offline 下不得出网'); };
  try {
    const r = await run(w, ['install', 'demo', '--clients', 'claude', '--offline', '--json']);
    assert.equal(r.code, 0, r.stdout);
  } finally { globalThis.fetch = orig; }
  assert.equal(called, 0, 'fetch 被调用了 —— --offline 被绕过');
});

test('🔴 --offline 时 GEOLY_OFFLINE 被置位，埋点上报据此停掉', async () => {
  const w = makeWorld();
  const env = { ...process.env, GEOLY_TELEMETRY: '0' };
  delete env.GEOLY_OFFLINE;
  await run(w, ['list', '--installed', '--offline', '--json'], { deps: { env } });
  assert.equal(env.GEOLY_OFFLINE, '1');
});

test('🔴 --offline 拦得住 telemetry flush —— 而且是在**埋点开着、端点配好**的前提下', async () => {
  // ⚠️ 这条测试的第一版是**假的**：它同时设了 GEOLY_TELEMETRY=0，
  //    于是「fetch 次数为 0」只能证明埋点被关了，证明不了 --offline 起了作用
  //    （Codex 第三轮指出）。现在把埋点**打开**、端点**配好**、队列里**真有事件**，
  //    这样唯一还能拦住出网的就只有 --offline 那一条。
  const w = makeWorld();
  const tele = join(w.root, 'tele');
  mkdirSync(join(tele, 'telemetry'), { recursive: true });
  const saved = {
    GEOLY_STATE_DIR: process.env.GEOLY_STATE_DIR,
    GEOLY_TELEMETRY: process.env.GEOLY_TELEMETRY,
    GEOLY_TELEMETRY_ENDPOINT: process.env.GEOLY_TELEMETRY_ENDPOINT,
  };
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => { called++; return Promise.reject(new Error('测试断言：--offline 下不得出网')); };
  try {
    process.env.GEOLY_STATE_DIR = tele;
    delete process.env.GEOLY_TELEMETRY;                       // 埋点：开
    process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://example.invalid/t';
    const tm = await import('../src/telemetry.mjs');
    assert.equal(tm.enabled(), true, '前提：埋点是开着的');
    // 队列里放一条真事件，否则 flush 会因为「没东西可发」而跳过 —— 那也证明不了什么
    assert.ok(tm.record({ kind: 'check', result: 'ok' }), '前提：事件真的写进了队列');
    assert.ok(tm.readAll().length > 0, '前提：队列非空');

    // ① 不给 --offline：确认这条路**本来是会出网的**（否则上面的断言是空的）
    await run(w, ['telemetry', 'flush'], { deps: { env: process.env } });
    assert.ok(called > 0, '前提不成立：不给 --offline 时它本来就不出网，这条测试证明不了任何事');

    // ② 给 --offline：一次都不许
    called = 0;
    const r = await run(w, ['telemetry', 'flush', '--offline'], { deps: { env: process.env } });
    assert.equal(called, 0, `telemetry flush 在 --offline 下出网了：${r.stdout}`);
    // （不在这里断言 process.env.GEOLY_OFFLINE —— run() 每次跑完会把它还原，
    //   免得上一条命令的 --offline 影响下一条。真正的判据就是上面那个 called === 0。）
    assert.match(r.stdout, /未上报/);
  } finally {
    globalThis.fetch = orig;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete process.env.GEOLY_OFFLINE;
  }
});

test('🔴 取锁之前就挡掉 .geoly 的 symlink（SQLite 会跟随它写到 target 之外）', async () => {
  const { symlinkSync } = await import('node:fs');
  const w = makeWorld();
  const target = CLAUDE_G(w);
  mkdirSync(target, { recursive: true });
  const outside = join(w.root, 'outside');
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(target, '.geoly'));
  const r = await run(w, ['install', 'demo', '--clients', 'claude', '--json']);
  // 🔴 路径安全属于 §3.4 那一类 → §6 第 9 条，不是「需要 recover」的 5
  assert.equal(r.code, 9, r.stdout);
  assert.match(r.json.error.message, /symlink/);
  // 🔴 关键断言：target 之外那个目录里**一个字节都没写进去**
  assert.deepEqual(readdirSync(outside), [], '锁被写到了 target 外面');
});

test('🔴 target 的**父级**被换成 symlink：建目录之前就要拒（早于取锁与预检）', async () => {
  const { symlinkSync } = await import('node:fs');
  const w = makeWorld();
  const outside = join(w.root, 'outside2');
  mkdirSync(outside, { recursive: true });
  // 把 `$HOME/.claude` 整个换成指向 target 之外的软链 —— 之后 mkdir `.claude/skills`
  // 就会在 outside 里造目录
  rmSync(join(w.home, '.claude'), { recursive: true, force: true });
  symlinkSync(outside, join(w.home, '.claude'));
  const r = await run(w, ['install', 'demo', '--clients', 'claude', '--json']);
  assert.equal(r.code, 9, r.stdout);
  assert.match(r.json.error.message, /路径链检查不通过|symlink/);
  assert.deepEqual(readdirSync(outside), [], 'target 目录被建到了可信 base 之外');
});

test('🔴 repo 锁的 db 是 symlink 时也要拒（它同样被 SQLite 直接 open）', async () => {
  const { symlinkSync } = await import('node:fs');
  const w = makeWorld();
  mkdirSync(join(w.projectRoot, '.claude'), { recursive: true });
  const outside = join(w.root, 'outside3');
  mkdirSync(outside, { recursive: true });
  symlinkSync(join(outside, 'stolen.db'), join(w.projectRoot, '.geoly-skills.lock.db'));
  const r = await run(w, ['install', 'demo', '--project', w.projectRoot, '--clients', 'claude', '--json']);
  assert.equal(r.code, 9, r.stdout);
  assert.match(r.json.error.message, /repo 锁/);
  assert.deepEqual(readdirSync(outside), []);
});

test('🔴 本地缓存超过 8 MiB 不得被当成「网络取不到」而静默放行', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  // 把 timestamp 撑到 8 MiB 以上：文件明明在，只是超限 —— 那是解析失败，不是取不到
  writeFileSync(join(w.cacheDir, 'timestamp.json'), Buffer.alloc(9 * 1024 * 1024, 0x20));
  const r = await run(w, ['list', '--clients', 'claude', '--json']);
  assert.notEqual(r.code, 6, 'list 把「超限」当成可降级的网络失败静默放行了');
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.json.error.message, /超过 8 MiB/);
});

// ════════════════════════════════════════════════════════════════════════════
// check —— §4 两阶段
// ════════════════════════════════════════════════════════════════════════════

test('check 两阶段：字节 OK + 当前状态 published', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  const r = await run(w, ['check', '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.entries.length, 1);
  assert.equal(r.json.entries[0].bytes.ok, true);
  assert.equal(r.json.entries[0].status, 'published');
  assert.equal(r.json.entries[0].status_known, true);
  assert.equal(r.json.second_question_answered, true);
});

test('🔴 check 第一问：磁盘被改过 → bytes 不符，退出码 2', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  writeFileSync(join(CLAUDE_G(w), 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 被改过\n---\n');
  const r = await run(w, ['check', '--clients', 'claude', '--json']);
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.entries[0].bytes.ok, false);
  assert.equal(r.json.entries[0].bytes.why, 'digest-mismatch');
});

test('🔴 check 第二问离线答不了 → 固定措辞「状态未知（离线，最后验证于 …）」，**不默认为正常**', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  // 把 timestamp 从缓存里拿掉：第二问再也答不了，但第一问（历史快照）仍然可答
  rmSync(join(w.cacheDir, 'timestamp.json'));
  const r = await run(w, ['check', '--clients', 'claude', '--offline', '--json']);
  assert.equal(r.json.second_question_answered, false);
  assert.equal(r.json.entries[0].status_known, false);
  assert.equal(r.json.entries[0].status, null, '答不了就必须是 null，不能填一个「正常」');
  assert.match(r.json.entries[0].status_message, /^状态未知（离线，最后验证于 .+）$/);
  assert.match(r.json.second_question_unknown_reason, /^状态未知（离线，最后验证于 /);
  // 第一问仍然答得出来
  assert.equal(r.json.entries[0].bytes.ok, true);
});

test('🔴 check 第一问取不回安装时快照 → 报「未证明」，不按通过处理', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  rmSync(join(w.cacheDir, 'snapshots', '42.json'));
  const r = await run(w, ['check', '--clients', 'claude', '--offline', '--json']);
  assert.equal(r.json.entries[0].bytes.ok, false);
  assert.equal(r.json.entries[0].bytes.why, 'unproven');
  assert.equal(r.code, 2);
});

test('🔴 check 报告未完成事务，并给出 5（先去 recover）', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  // 手工造一个停在 prepared 的残留 journal（内核的 journal 写入器保证它自洽）
  const P = layout(CLAUDE_G(w), 9);
  mkdirSync(P.journalDir, { recursive: true });
  mkdirSync(P.stage, { recursive: true });
  mkdirSync(P.retired, { recursive: true });
  writeJournal(P.journal, {
    schema: 'geoly.skills.journal/1',
    generation: 9,
    items: { demo: { op: 'retire-only', had_old: true, state: 'planned', old_digest: w.artifacts[0].record.tree_digest } },
    ledger_image: { ledger_existed: true, pre: { entries: {}, roots: {}, last_applied_generation: 1 }, post: { entries: {}, roots: {}, last_applied_generation: 9 } },
    phase: 'prepared',
    tx_dir: 'tx-9',
  });
  const r = await run(w, ['check', '--clients', 'claude', '--json']);
  assert.equal(r.code, 5, r.stdout);
  assert.equal(r.json.targets[0].unfinished_transactions[0].phase, 'prepared');
});

// ════════════════════════════════════════════════════════════════════════════
// list / search / why
// ════════════════════════════════════════════════════════════════════════════

test('🔴 stale 不得被 list / check 吞成 offline —— 它有自己的退出码 8', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  // 把「现在」推到 timestamp 的 valid_until 之后：解析当前快照会抛 StaleError
  const late = () => new Date(Date.parse('2026-09-20T00:00:00Z'));
  for (const argv of [['list', '--clients', 'claude', '--json'], ['check', '--clients', 'claude', '--json']]) {
    const r = await run(w, argv, { deps: { now: late } });
    assert.equal(r.code, 8, `${argv[0]} 应当报 8（陈旧），实际 ${r.code}：${r.stdout}`);
    assert.equal(r.json.error.name, 'StaleError');
  }
  // ⚠️ 内核语义：`--allow-stale` **只在 `--offline` 下生效**（snapshot.assertFresh：
  //    联网时过期一律硬 StaleError，没有覆盖开关；错误文案自己也是这么写的）。
  const r2 = await run(w, ['check', '--clients', 'claude', '--offline', '--allow-stale', '--json'],
    { deps: { now: late } });
  assert.equal(r2.code, 0, `${r2.stdout}\n${r2.stderr}`);
  assert.equal(r2.json.entries[0].annotations.stale, true, '每一行都要标 stale');
  assert.match(r2.stderr, /timestamp 已过期/);

  // 只给 --allow-stale 而不给 --offline 仍然是 8 —— 不静默放行
  const r3 = await run(w, ['check', '--clients', 'claude', '--allow-stale', '--json'], { deps: { now: late } });
  assert.equal(r3.code, 8, r3.stdout);
});

test('🔴 完整性失败也不得被 list 吞掉（快照字节被改过 → 2，不是 offline）', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  // 改掉快照字节：它的 sha256 就不再等于 timestamp.snapshot_sha256
  const sp = join(w.cacheDir, 'snapshots', '42.json');
  writeFileSync(sp, readFileSync(sp, 'utf8').replace('"license": "MIT"', '"license": "MIt"'));
  const r = await run(w, ['list', '--clients', 'claude', '--json']);
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.error.name, 'IntegrityError');
});

test('list / list --installed / list --outdated', async () => {
  const w = makeWorld({ artifacts: [makeArtifact({ version: '0.1.0' }), makeArtifact({ version: '0.2.0' })] });
  const r0 = await run(w, ['list', '--clients', 'claude', '--json']);
  assert.equal(r0.code, 0, r0.stdout);
  assert.equal(r0.json.rows.length, 1, '每个 name 只列 latest 那一行');
  assert.equal(r0.json.rows[0].installed, false);

  await run(w, ['install', 'demo@0.1.0', '--clients', 'claude']);
  const r1 = await run(w, ['list', '--clients', 'claude', '--installed', '--json']);
  assert.equal(r1.json.rows[0].artifact, 'skill:geoly/demo@0.1.0');
  const r2 = await run(w, ['list', '--clients', 'claude', '--outdated', '--json']);
  assert.equal(r2.json.rows.length, 1);
  assert.equal(r2.json.rows[0].latest, 'skill:geoly/demo@0.2.0');
  assert.equal(r2.json.rows[0].artifact, 'skill:geoly/demo@0.1.0');
});

test('🔴 list --installed 离线也能跑（纯本地，不解析快照）', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  rmSync(join(w.cacheDir, 'timestamp.json'));
  const r = await run(w, ['list', '--clients', 'claude', '--installed', '--offline', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.rows[0].annotations.offline, true);
});

test('search 只搜 name/id，并如实声明搜了哪些字段', async () => {
  const w = makeWorld({ artifacts: [makeArtifact({ name: 'demo' }), makeArtifact({ name: 'other' })] });
  const r = await run(w, ['search', 'dem', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.hits.map((h) => h.name), ['demo']);
  assert.deepEqual(r.json.searched_fields, ['id', 'name']);
  assert.match(r.stderr, /description 在制品的载荷 manifest 里/);
});

test('why 读账本的 roots + requested_by', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  const r = await run(w, ['why', 'demo', '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.entries.length, 1);
  assert.equal(r.json.entries[0].requested_by[0].root, 'direct:skill:geoly/demo@0.1.0');
  assert.equal(r.json.entries[0].requested_by[0].record.kind, 'direct');
  // 没装过的名字不是错
  const r2 = await run(w, ['why', 'nope', '--clients', 'claude', '--json']);
  assert.equal(r2.code, 0);
  assert.deepEqual(r2.json.entries, []);
});

// ════════════════════════════════════════════════════════════════════════════
// recover
// ════════════════════════════════════════════════════════════════════════════

test('recover：干净现场 → 无残留可处理，退出码 0', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  const r = await run(w, ['recover', '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.targets[0].outcome, 'nothing');
});

test('🔴 recover 无 flag（auto）遇到 prepared 残留 → 停机提示，退出码 5', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  const target = CLAUDE_G(w);
  const P = layout(target, 9);
  mkdirSync(P.journalDir, { recursive: true });
  // 真事务在第 5 步就建好了 tx-<gen>/{stage,retired}；手工造残留时也要有它们
  mkdirSync(P.stage, { recursive: true });
  mkdirSync(P.retired, { recursive: true });
  writeJournal(P.journal, {
    schema: 'geoly.skills.journal/1',
    generation: 9,
    items: { demo: { op: 'retire-only', had_old: true, state: 'planned', old_digest: treeDigest(join(target, 'demo')) } },
    ledger_image: { ledger_existed: true, pre: { entries: {}, roots: {}, last_applied_generation: 1 }, post: { entries: {}, roots: {}, last_applied_generation: 9 } },
    phase: 'prepared',
    tx_dir: 'tx-9',
  });
  const r = await run(w, ['recover', '--clients', 'claude', '--json']);
  assert.equal(r.code, 5, r.stdout);
  assert.match(r.json.targets[0].error, /recover --continue.*recover --rollback/s);
  // §5.5：逐项报告
  assert.equal(r.json.targets[0].report.generations.find((g) => g.generation === 9).items.demo.state, 'planned');
});

test('🔴 recover --continue 把 prepared 的 retire-only 事务续做完，账本随之更新', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  const target = CLAUDE_G(w);
  const L0 = readLedger(layout(target).ledger);
  const P = layout(target, 9);
  mkdirSync(P.journalDir, { recursive: true });
  // 真事务在第 5 步就建好了 tx-<gen>/{stage,retired}；手工造残留时也要有它们
  mkdirSync(P.stage, { recursive: true });
  mkdirSync(P.retired, { recursive: true });
  writeJournal(P.journal, {
    schema: 'geoly.skills.journal/1',
    generation: 9,
    items: { demo: { op: 'retire-only', had_old: true, state: 'planned', old_digest: treeDigest(join(target, 'demo')) } },
    ledger_image: {
      ledger_existed: true,
      pre: { entries: { demo: L0.entries.demo }, roots: {}, last_applied_generation: L0.last_applied_generation },
      post: { entries: { demo: null }, roots: {}, last_applied_generation: 9 },
    },
    phase: 'prepared',
    tx_dir: 'tx-9',
  });
  const r = await run(w, ['recover', '--continue', '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.json.targets[0].outcome, 'resumed-forward');
  const L = readLedger(layout(target).ledger);
  assert.equal(L.entries.demo, undefined, 'retire-only 续做完之后 entry 应当消失');
  assert.equal(existsSync(join(target, 'demo')), false);
  assert.equal(L.transaction, null);
});

test('🔴 recover --rollback 把 prepared 的 retire-only 事务反向复位', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  const target = CLAUDE_G(w);
  const L0 = readLedger(layout(target).ledger);
  const digest = treeDigest(join(target, 'demo'));
  const P = layout(target, 9);
  mkdirSync(P.journalDir, { recursive: true });
  // 真事务在第 5 步就建好了 tx-<gen>/{stage,retired}；手工造残留时也要有它们
  mkdirSync(P.stage, { recursive: true });
  mkdirSync(P.retired, { recursive: true });
  writeJournal(P.journal, {
    schema: 'geoly.skills.journal/1',
    generation: 9,
    items: { demo: { op: 'retire-only', had_old: true, state: 'planned', old_digest: digest } },
    ledger_image: {
      ledger_existed: true,
      pre: { entries: { demo: L0.entries.demo }, roots: {}, last_applied_generation: L0.last_applied_generation },
      post: { entries: { demo: null }, roots: {}, last_applied_generation: 9 },
    },
    phase: 'prepared',
    tx_dir: 'tx-9',
  });
  const r = await run(w, ['recover', '--rollback', '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.json.targets[0].outcome, 'rolled-back');
  // 目录与账本都回到 pre
  assert.equal(treeDigest(join(target, 'demo')), digest);
  assert.equal(readLedger(layout(target).ledger).entries.demo.artifact, 'skill:geoly/demo@0.1.0');
});

test('🔴 分流矩阵：物理 corrupt 时 --continue 与 --rollback 都拒绝', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  const target = CLAUDE_G(w);
  const P = layout(target, 9);
  mkdirSync(P.journalDir, { recursive: true });
  // 真事务在第 5 步就建好了 tx-<gen>/{stage,retired}；手工造残留时也要有它们
  mkdirSync(P.stage, { recursive: true });
  mkdirSync(P.retired, { recursive: true });
  const J = {
    schema: 'geoly.skills.journal/1',
    generation: 9,
    items: { demo: { op: 'retire-only', had_old: true, state: 'corrupt', old_digest: treeDigest(join(target, 'demo')) } },
    ledger_image: { ledger_existed: true, pre: { entries: {}, roots: {}, last_applied_generation: 1 }, post: { entries: {}, roots: {}, last_applied_generation: 9 } },
    phase: 'prepared',
    tx_dir: 'tx-9',
  };
  writeJournal(P.journal, J);
  for (const flag of ['--continue', '--rollback']) {
    const r = await run(w, ['recover', flag, '--clients', 'claude', '--json']);
    assert.notEqual(r.code, 0, `${flag} 应当拒绝`);
    assert.match(r.json.targets[0].error, /corrupt/, flag);
  }
});

test('🔴 --reinstall 在 cleanup_pending 且无物理 corrupt 时被 CLI 拒绝（内核会误当成清理续做）', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  const target = CLAUDE_G(w);
  const P = layout(target, 9);
  mkdirSync(P.journalDir, { recursive: true });
  // 真事务在第 5 步就建好了 tx-<gen>/{stage,retired}；手工造残留时也要有它们
  mkdirSync(P.stage, { recursive: true });
  mkdirSync(P.retired, { recursive: true });
  writeJournal(P.journal, {
    schema: 'geoly.skills.journal/1',
    generation: 9,
    items: { demo: { op: 'retire-only', had_old: true, state: 'done', cleanup: 'done', old_digest: treeDigest(join(target, 'demo')) } },
    ledger_image: { ledger_existed: true, pre: { entries: {}, roots: {}, last_applied_generation: 1 }, post: { entries: {}, roots: {}, last_applied_generation: 9 } },
    phase: 'cleanup_pending',
    tx_dir: 'tx-9',
  });
  const r = await run(w, ['recover', '--reinstall', '--clients', 'claude', '--json']);
  assert.notEqual(r.code, 0);
  assert.match(r.json.targets[0].error, /仅物理 corrupt 可用/);
  // 🔴 被拒之后现场没有被动过：journal 还在，phase 还是 cleanup_pending
  assert.equal(readJournal(P.journal).phase, 'cleanup_pending');
});

test('🔴 --release-frozen 如实拒绝（内核缺口），不假装成功', async () => {
  const w = makeWorld();
  const r = await run(w, ['recover', '--release-frozen', 'mig-1', '--clients', 'claude', '--json']);
  assert.equal(r.code, 1);
  assert.match(r.json.error.message, /内核 API 缺口/);
});

// ════════════════════════════════════════════════════════════════════════════
// 项目级：sync-lock / lockfile / 遮蔽
// ════════════════════════════════════════════════════════════════════════════

test('端到端：项目级 install 写出 lockfile，sync-lock 幂等重算出同一份字节', async () => {
  const w = makeWorld();
  mkdirSync(join(w.projectRoot, '.claude'), { recursive: true });
  const r = await run(w, ['install', 'demo', '--project', w.projectRoot, '--clients', 'claude', '--json']);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);

  const lfPath = join(w.projectRoot, 'geoly-skills.lock.json');
  assert.ok(existsSync(lfPath), 'install 收尾必须重算 lockfile（§5.1 末尾）');
  const before = readFileSync(lfPath, 'utf8');
  const lf = parseStrict(before);
  assert.equal(lf.schema, 'geoly.skills.lock/2');
  assert.equal(lf.targets[0].path, '.claude/skills', 'path 只能由 adapter 推导');
  assert.equal(lf.targets[0].entries[0].name, 'demo');
  assert.equal(lf.targets[0].entries[0].asset_sha256, w.artifacts[0].record.asset.sha256);
  // 🔴 lockfile 的 intent 里没有 allow_yanked
  assert.deepEqual(Object.keys(lf.targets[0].roots[0].intent).sort(), ['no_bundled', 'pre']);

  const r2 = await run(w, ['sync-lock', '--project', w.projectRoot, '--clients', 'claude', '--json']);
  assert.equal(r2.code, 0, r2.stdout);
  assert.equal(readFileSync(lfPath, 'utf8'), before, 'sync-lock 必须是幂等重算');
  // 埋点：kind 取 KINDS 里现成的枚举值
  assert.equal(r2.events.at(-1).kind, 'sync-lock');
  assert.equal(r2.events.at(-1).result, 'ok');
});

test('🔴 sync-lock 遇到未恢复事务 → 拒绝重算（5），且不动 lockfile', async () => {
  const w = makeWorld();
  mkdirSync(join(w.projectRoot, '.claude'), { recursive: true });
  await run(w, ['install', 'demo', '--project', w.projectRoot, '--clients', 'claude']);
  const lfPath = join(w.projectRoot, 'geoly-skills.lock.json');
  const before = readFileSync(lfPath, 'utf8');
  const target = join(w.projectRoot, '.claude', 'skills');
  const P = layout(target, 9);
  mkdirSync(P.journalDir, { recursive: true });
  // 真事务在第 5 步就建好了 tx-<gen>/{stage,retired}；手工造残留时也要有它们
  mkdirSync(P.stage, { recursive: true });
  mkdirSync(P.retired, { recursive: true });
  writeJournal(P.journal, {
    schema: 'geoly.skills.journal/1',
    generation: 9,
    items: { demo: { op: 'retire-only', had_old: true, state: 'planned', old_digest: treeDigest(join(target, 'demo')) } },
    ledger_image: { ledger_existed: true, pre: { entries: {}, roots: {}, last_applied_generation: 1 }, post: { entries: {}, roots: {}, last_applied_generation: 9 } },
    phase: 'prepared',
    tx_dir: 'tx-9',
  });
  const r = await run(w, ['sync-lock', '--project', w.projectRoot, '--clients', 'claude', '--json']);
  assert.equal(r.code, 5, r.stdout);
  assert.match(r.json.error.message, /拒绝重算/);
  assert.equal(readFileSync(lfPath, 'utf8'), before);
});

test('🔴 check 报 lockfile 过时并提示 sync-lock', async () => {
  const w = makeWorld();
  mkdirSync(join(w.projectRoot, '.claude'), { recursive: true });
  await run(w, ['install', 'demo', '--project', w.projectRoot, '--clients', 'claude']);
  rmSync(join(w.projectRoot, 'geoly-skills.lock.json'));
  const r = await run(w, ['check', '--project', w.projectRoot, '--clients', 'claude', '--json']);
  assert.equal(r.json.lockfile.ok, false);
  assert.match(r.json.lockfile.message, /sync-lock/);
});

test('🔴 §8.2 遮蔽：全局已有同名时项目级安装默认拒绝（3），--shadow-global 才继续并标注', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  mkdirSync(join(w.projectRoot, '.claude'), { recursive: true });

  const r = await run(w, ['install', 'demo', '--project', w.projectRoot, '--clients', 'claude', '--json']);
  assert.equal(r.code, 3, r.stdout);
  assert.match(r.json.error.message, /全局已存在同名 skill/);
  assert.match(r.json.error.message, /--shadow-global/);

  const r2 = await run(w, ['install', 'demo', '--project', w.projectRoot, '--clients', 'claude',
    '--shadow-global', '--json']);
  assert.equal(r2.code, 0, `${r2.stdout}\n${r2.stderr}`);
  assert.equal(r2.json.targets[0].annotations.shadowed, true);

  // check 如实并列，**不声称哪份生效**
  const r3 = await run(w, ['check', '--project', w.projectRoot, '--clients', 'claude', '--json']);
  assert.deepEqual(r3.json.shadowed, ['demo']);
  assert.equal(r3.json.entries[0].annotations.shadowed, true);
  // 人类输出里那句话也必须在（--json 下 stdout 只有那一个对象，所以另跑一次）
  const r4 = await run(w, ['check', '--project', w.projectRoot, '--clients', 'claude']);
  assert.match(r4.stdout, /生效者取决于客户端，本工具不做判断/);
});

test('sync-lock 只对项目级有意义；全局跑要报用法错误', async () => {
  const w = makeWorld();
  const r = await run(w, ['sync-lock', '--json']);
  assert.equal(r.code, 1);
  assert.match(r.json.error.message, /--project/);
});

// ════════════════════════════════════════════════════════════════════════════
// 锁（§5.1）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 起一个**真的另一个进程**去持锁。
 * 🔴 同进程 `acquire` 会撞上 `src/lock.mjs` 的「禁止重入」，那测的是另一件事 ——
 *    「锁被别的活进程占用」必须真有第二个进程，否则这条用例证明不了退出码 5。
 */
async function holdLockInChild(dbPath) {
  const { spawn } = await import('node:child_process');
  const src = [
    "process.emit = ((o) => function (n, d, ...r) {",
    "  if (n === 'warning' && /SQLite/i.test(d?.message ?? '')) return false;",
    "  return o.call(this, n, d, ...r);",
    "})(process.emit);",
    `const { acquire } = await import(${JSON.stringify(new URL('../src/lock.mjs', import.meta.url).href)});`,
    `acquire(${JSON.stringify(dbPath)});`,
    "process.stdout.write('HELD\\n');",
    'setInterval(() => {}, 1 << 30);',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', src],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => {
    child.stdout.on('data', (b) => { if (String(b).includes('HELD')) res(); });
    child.on('exit', (c) => rej(new Error(`持锁子进程提前退出（${c}）`)));
    setTimeout(() => rej(new Error('持锁子进程 5s 没就绪')), 5000).unref?.();
  });
  return () => child.kill('SIGKILL');
}

test('🔴 target 锁被别的活进程占用 → 退出码 5，措辞是「上一次持锁的是 pid X（可能已不是当前持有者）」', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  const stop = await holdLockInChild(join(CLAUDE_G(w), '.geoly', 'lock.db'));
  try {
    const r = await run(w, ['install', 'demo', '--clients', 'claude', '--json']);
    assert.equal(r.code, 5, r.stdout);
    assert.match(r.json.error.message, /锁被占用/);
    assert.match(r.json.error.message, /可能已不是当前持有者/);
  } finally { stop(); }
});

test('🔴 加锁全序 metadata → repo → target；target 按 (st_dev, st_ino) 去重并排序', async () => {
  const { orderTargets } = await import('../src/commands/locks.mjs');
  const w = makeWorld();
  const a = join(w.root, 'ta');
  const b = join(w.root, 'tb');
  mkdirSync(a); mkdirSync(b);
  const ordered = orderTargets([b, a, b]);
  assert.equal(ordered.length, 2, '同一个路径给两次要去重');
  // 排序键是 (dev, ino) 的定宽 hex，不是路径字典序
  const keys = ordered.map((o) => o.key);
  assert.deepEqual(keys, [...keys].sort());
  for (const o of ordered) {
    const st = statSync(o.path);
    assert.equal(o.dev, st.dev);
    assert.equal(o.ino, st.ino);
  }
});

test('🔴 取锁中途失败 → 已持有的逐一释放，不带着半套锁退出', async () => {
  const { withOrderedLocks } = await import('../src/commands/locks.mjs');
  const { acquire } = await import('../src/lock.mjs');
  const w = makeWorld();
  const a = join(w.root, 'la');
  const b = join(w.root, 'lb');
  mkdirSync(a); mkdirSync(b);
  // 让其中一把先被别人占住
  const { orderTargets } = await import('../src/commands/locks.mjs');
  const ordered = orderTargets([a, b]);
  mkdirSync(join(ordered[1].path, '.geoly'), { recursive: true });
  const stop = await holdLockInChild(join(ordered[1].path, '.geoly', 'lock.db'));
  let threw = null;
  try {
    withOrderedLocks({ targets: [a, b] }, () => assert.fail('不该进到回调'));
  } catch (e) { threw = e; } finally { stop(); }
  assert.equal(threw?.name, 'LockBusyError');
  // 第一把已经被释放了 —— 现在还能再取到
  const again = acquire(join(ordered[0].path, '.geoly', 'lock.db'));
  again();
});

// ════════════════════════════════════════════════════════════════════════════
// 失败路径不留半截状态
// ════════════════════════════════════════════════════════════════════════════

test('🔴 第 4 步验签/解包失败 → 不留 tx-*、不留解包目录、账本没被动过', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  const target = CLAUDE_G(w);
  const before = readFileSync(layout(target).ledger, 'utf8');

  // 造第二个制品，但把缓存里的资产字节改坏 —— 第 4 步的 asset sha256 会当场不符
  const w2 = makeWorld({ artifacts: [makeArtifact({ name: 'other', body: 'x' })] });
  const assetPath = join(w2.cacheDir, 'assets', w2.artifacts[0].record.asset.sha256.slice(7));
  const bad = readFileSync(assetPath);
  bad[bad.length - 3] ^= 0xff;
  writeFileSync(assetPath, bad);
  const r = await run(w2, ['install', 'other', '--clients', 'claude', '--json']);
  assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`);

  const t2 = CLAUDE_G(w2);
  const state2 = layout(t2).state;
  assert.deepEqual(readdirSync(state2).filter((n) => n.startsWith('tx-')), [], '留下了 tx 目录');
  assert.equal(existsSync(join(t2, 'other')), false, 'target 上不该出现半棵树');
  // 第一个世界的账本一个字节都没动
  assert.equal(readFileSync(layout(target).ledger, 'utf8'), before);
});

test('🔴 一次装多个、后一个失败时，**前一个已解包的隔离目录**也要被清掉', async () => {
  // ⚠️ 这条用例是**特意**为了能证伪而设计的：
  //    单个制品失败时，内核 `verifyAndExtract()` 自己会收尸，成功时解包目录又被
  //    `stageTrees` 搬走 —— 两种情况下「裸 verifyArtifact + 忘了 dispose」都看不出来。
  //    只有「前一个解包成功、后一个失败」这条路径能把作用域版与裸版区分开：
  //    嵌套的 withVerifiedArtifact 会在外层 finally 里把前一个的目录清掉，裸版不会。
  const good = makeArtifact({ name: 'aaa' });
  const bad = makeArtifact({ name: 'zzz' });
  const w = makeWorld({ artifacts: [good, bad] });
  // 把第二个（按 spec 顺序在后）的资产字节改坏：它会在 assertAssetBytes 就抛，
  // 而那时第一个的隔离目录已经建出来了
  const p2 = join(w.cacheDir, 'assets', bad.record.asset.sha256.slice(7));
  const b = readFileSync(p2);
  b[b.length - 3] ^= 0xff;
  writeFileSync(p2, b);

  const r = await run(w, ['install', 'aaa', 'zzz', '--clients', 'claude', '--json']);
  assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`);
  const state = layout(CLAUDE_G(w)).state;
  const leaked = readdirSync(state).filter((n) => n.startsWith('geoly-unpack-'));
  assert.deepEqual(leaked, [],
    `🔴 前一个制品的隔离解包目录没被清掉：${leaked.join(', ')} —— 作用域版没起作用`);
});

test('🔴 多 target 一成一败 → 退出码 4，且成功那个是真的装上了', async () => {
  const w = makeWorld({ artifacts: [makeArtifact({ clients: ['claude', 'codex'] })] });
  mkdirSync(join(w.home, '.codex'), { recursive: true });
  // 让 codex 那个 target 装不上：先占一个未被账本认领的同名目录
  const codexTarget = join(w.home, '.codex', 'skills');
  mkdirSync(join(codexTarget, 'demo'), { recursive: true });
  writeFileSync(join(codexTarget, 'demo', 'SKILL.md'), '别人的\n');

  const r = await run(w, ['install', 'demo', '--clients', 'claude,codex', '--json']);
  assert.equal(r.code, 4, `${r.stdout}\n${r.stderr}`);
  const byClient = Object.fromEntries(r.json.targets.map((t) => [t.client, t]));
  assert.equal(byClient.claude.ok, true);
  assert.equal(byClient.codex.ok, false);
  assert.equal(byClient.codex.exit_code, 3, '单项失败要带自己那一格的码');
  // §7：即使有失败，逐 target 结果表照样要完整
  assert.equal(r.json.targets.length, 2);
  assert.equal(treeDigest(join(CLAUDE_G(w), 'demo')), w.artifacts[0].record.tree_digest);
  // 失败那个的现场没被动
  assert.equal(readFileSync(join(codexTarget, 'demo', 'SKILL.md'), 'utf8'), '别人的\n');
});

// ════════════════════════════════════════════════════════════════════════════
// 预检（§3）
// ════════════════════════════════════════════════════════════════════════════

test('🔴 §3.5 嵌套 target → 预检拒绝（9），且 JSON 里保留**全部**违规项', async () => {
  const w = makeWorld();
  await run(w, ['install', 'demo', '--clients', 'claude']);
  // 在 target 之下造一个**带有效 .geoly 状态**的目录 —— 那就是一个嵌套 target
  const nested = join(CLAUDE_G(w), 'nested', '.geoly');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'ledger.json'), '{}');
  const r = await run(w, ['install', 'demo', '--clients', 'claude', '--json']);
  assert.equal(r.code, 9, `${r.stdout}\n${r.stderr}`);
  const codes = r.json.error.violations.map((v) => v.code);
  assert.ok(codes.includes('target.nested'), `实际违规：${codes.join(',')}`);
  // 🔴 JSON 里始终保留全部违规项，不只报优先级最高那一条
  assert.ok(r.json.error.violations.every((v) => typeof v.message === 'string'));
});

test('🔴 target 不可写 → 退出码 10，且 JSON 里保留全部违规项', async () => {
  const w = makeWorld();
  const target = CLAUDE_G(w);
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o500);
  try {
    const r = await run(w, ['install', 'demo', '--clients', 'claude', '--json']);
    assert.equal(r.code, 10, `${r.stdout}\n${r.stderr}`);
    // 取锁（第 1 步）比预检（第 3 步）更早，所以这里报的是「建不出 .geoly」
    assert.match(r.json.error.message, /target 不可写/);
    assert.match(r.json.error.message, /建不出/);
  } finally { chmodSync(target, 0o755); }
});
