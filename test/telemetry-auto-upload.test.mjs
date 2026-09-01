// install 成功收尾后的自动上报 —— 规格 §5.1.1（2026-09-01 用户拍板）。
//
// 🔴 这套测试守的是四条，缺一条这个特性就该被打回：
//    ① 只有 install，且**成功**才发；失败 / 部分失败 / 别的命令一律不出网
//    ② 24 小时最多一次，且戳是在**尝试之前**写的（端点挂了不会每次 install 都撞）
//    ③ **首次告知一定先于任何一次自动上报** —— 反过来就是「先发了再告诉你」
//    ④ 两个否决（`--offline` / `GEOLY_TELEMETRY_UPLOAD=0`）照旧一票否决
//
// 另外两条是这次拍板里被点名要「实际验证、不许只推理」的：
//    · 消费式上报的不变量在「服务端已 durable、客户端没拿到 ACK」这一格上是通的
//      （重发 → 服务端按 eid 判 duplicate → 客户端才 retire）
//    · 进程在 ACK 之前被杀掉，事件一条不丢（`sending` 留着，下一轮接着发）
//      —— 这一条用**真的杀进程**验，不是用 mock 模拟崩溃
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

import { main } from '../src/cli.mjs';
import { stringify } from '../src/canonical-json.mjs';
import { verifyAndExtract } from '../src/artifact.mjs';
import { makeTarGz } from './fixtures/trustchain-tar.mjs';
import { makeRecord, makeSnapshotDoc, makeTimestampDoc, bytesOf, fakeVerifier, hex } from './fixtures/trustchain-objects.mjs';
import { wrapTimestamp } from '../src/timestamp-envelope.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const NOW = Date.parse('2026-08-25T13:00:00Z');
const cap = () => { const o = { s: '', write(x) { o.s += x; return true; } }; return o; };

const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-auto-up-')); roots.push(d); return d; };
process.on('exit', () => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

let n = 0;
/**
 * 每个用例一个干净的埋点状态目录 + 干净的开关。
 * 🔴 设的是 **process.env** —— telemetry / upload 读的就是它，注入的 `deps.env` 到不了。
 */
function isoTelemetry() {
  const d = mkdtempSync(join(tmpdir(), 'geoly-auto-st-'));
  roots.push(d);
  process.env.GEOLY_STATE_DIR = d;
  delete process.env.GEOLY_TELEMETRY;          // 埋点：开
  delete process.env.GEOLY_TELEMETRY_UPLOAD;   // 上报：开
  delete process.env.GEOLY_OFFLINE;
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  return d;
}
/** 每个用例换一份模块实例，免得上一条用例的模块级状态（lastError 等）串味 */
const fresh = async () => {
  const q = `?a${++n}`;
  return { tm: await import('../src/telemetry.mjs' + q), up: await import('../src/upload.mjs' + q) };
};

// ── install 世界（与 commands-e2e 同款；这里只需要一个 skill） ───────────────

function makeArtifact({ name = 'demo', version = '0.1.0' } = {}) {
  const skillJson = stringify({
    schema: 'geoly.skills.skill/1',
    kind: 'skill', namespace: 'geoly', name, version,
    description: `${name} 的说明`, license: 'MIT',
    clients: ['claude'], capabilities: ['none'], replaces: [], conflicts: [],
    provenance: { kind: 'original', author_github_id: '1', submitted_by_pr: 2 },
  });
  const gz = makeTarGz([
    { path: 'SKILL.md', data: `---\nname: ${name}\ndescription: demo\n---\n\n# ${name}\n` },
    { path: 'skill.json', data: skillJson },
  ]);
  // 先解一次算真实 tree_digest 再回填 —— record 与字节必须自洽
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
    name, version, clients: ['claude'], status: 'published', tree_digest: td,
    asset: { file: `skill_geoly_${name}_${version}.tar.gz`, sha256: sha(gz), size: gz.length },
  });
  return { gz, record };
}

function makeWorld() {
  const artifacts = [makeArtifact()];
  const root = mkroot();
  const home = join(root, 'home');
  const cacheDir = join(root, 'cache');
  const stateDir = join(root, 'state');
  const projectRoot = join(root, 'repo');
  for (const d of [home, join(cacheDir, 'snapshots'), join(cacheDir, 'assets'), stateDir, projectRoot]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(join(home, '.claude'), { recursive: true });
  const snapBytes = bytesOf(makeSnapshotDoc(artifacts.map((a) => a.record), { snapshot: 42, previous: 41 }));
  writeFileSync(join(cacheDir, 'timestamp.json'), wrapTimestamp(bytesOf(makeTimestampDoc({
    latest_snapshot: 42, snapshot_sha256: sha(snapBytes), min_cli_version: '0.0.0',
  })), {}));
  writeFileSync(join(cacheDir, 'snapshots', '42.json'), snapBytes);
  writeFileSync(join(cacheDir, 'snapshots', '42.sigstore.json'), '{}');
  for (const a of artifacts) writeFileSync(join(cacheDir, 'assets', a.record.asset.sha256.slice(7)), a.gz);
  return { root, home, cacheDir, stateDir, projectRoot };
}

/**
 * 跑一条真命令。
 * 🔴 **不注入 `record`** —— 我们要的正是真的 record 把事件写进队列，
 *    否则「install 之后队列里有东西可发」这个前提就是假的。
 */
async function run(w, argv) {
  const so = cap(); const se = cap();
  const hadOffline = process.env.GEOLY_OFFLINE;
  delete process.env.GEOLY_OFFLINE;
  const code = await main(argv, {
    home: w.home,
    cwd: w.projectRoot,
    env: { ...process.env, CODEX_HOME: undefined },
    stateDir: w.stateDir,
    cacheDir: w.cacheDir,
    now: () => new Date(NOW),
    cliVersion: '1.2.3',
    verifier: fakeVerifier(),
    stdout: so,
    stderr: se,
  });
  if (hadOffline === undefined) delete process.env.GEOLY_OFFLINE;
  else process.env.GEOLY_OFFLINE = hadOffline;
  return { code, stdout: so.s, stderr: se.s };
}

/** 把 globalThis.fetch 换成一个记账的替身，返回记录与还原函数 */
function stubFetch(impl) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return impl ? impl(url, opts) : ackFor(opts);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const ackFor = (opts) => {
  const n = JSON.parse(opts.body).events.length;
  return {
    ok: true, status: 200,
    text: async () => `{"schema":"geoly.skills.telemetry-ack/1","accepted":${n},"duplicate":0,"rejected":0}`,
  };
};

// ════════════════════════════════════════════════════════════════════════════
// 节流
// ════════════════════════════════════════════════════════════════════════════

test('🔴 节流：24 小时内只认领一次名额', async () => {
  isoTelemetry();
  const { tm } = await fresh();
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  assert.equal(tm.claimAutoUploadSlot(t0), true, '第一次该放行');
  assert.equal(tm.claimAutoUploadSlot(t0), false, '同一时刻的第二次该被挡');
  assert.equal(tm.claimAutoUploadSlot(t0 + 23 * 3600_000), false, '23 小时后还不到点');
  assert.equal(tm.claimAutoUploadSlot(t0 + tm.AUTO_UPLOAD_INTERVAL_MS + 1), true, '过了 24 小时该再放行');
});

test('🔴 戳是在**尝试之前**写的 —— 端点挂着也不会每次 install 都去撞', async () => {
  isoTelemetry();
  const { tm, up } = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  tm.maybeNoticeUpload(() => {}, up.endpoint());     // 先过告知那道门

  let calls = 0;
  const dead = async () => { calls++; throw new Error('端点挂了'); };
  const a = await up.maybeAutoUpload({ fetchImpl: dead });
  assert.equal(a.ran, true);
  assert.equal(calls, 1);

  // 🔴 判据是「距上次**尝试**」而不是「距上次**成功**」：上一次明明失败了，
  //    这一次仍然要被挡住。按「上次成功」算的实现会在这里再打一次。
  const b = await up.maybeAutoUpload({ fetchImpl: dead });
  assert.equal(b.ran, false);
  assert.equal(b.reason, 'throttled');
  assert.equal(calls, 1, '失败之后 24 小时内不许再撞一次');
  assert.equal(tm.readAll().length, 1, '没发出去不等于丢了：事件仍在本地');
});

test('戳被写坏时只多放行一次，不会退化成「每次 install 都发」', async () => {
  const d = isoTelemetry();
  const { tm } = await fresh();
  mkdirSync(join(d, 'telemetry'), { recursive: true });
  writeFileSync(join(d, 'telemetry', 'auto-upload.last'), '这不是一个时间戳\n');
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  assert.equal(tm.claimAutoUploadSlot(t0), true, '读不出有效值 = 当作从没发过');
  assert.equal(tm.claimAutoUploadSlot(t0 + 1000), false, '上一次已经把戳修好了');
});

test('时钟回拨（戳在未来）按「没到点」处理，不连着发好几次', async () => {
  const d = isoTelemetry();
  const { tm } = await fresh();
  mkdirSync(join(d, 'telemetry'), { recursive: true });
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  writeFileSync(join(d, 'telemetry', 'auto-upload.last'), String(t0 + 86400_000) + '\n');
  assert.equal(tm.claimAutoUploadSlot(t0), false);
});

// ════════════════════════════════════════════════════════════════════════════
// 三道门：两个否决 + 首次告知
// ════════════════════════════════════════════════════════════════════════════

test('🔴 两个否决一票否决，而且**连节流戳都不写**', async () => {
  for (const off of [{ GEOLY_TELEMETRY_UPLOAD: '0' }, { GEOLY_OFFLINE: '1' }, { GEOLY_TELEMETRY: '0' }]) {
    const d = isoTelemetry();
    Object.assign(process.env, off);
    const { up } = await fresh();
    let called = false;
    const r = await up.maybeAutoUpload({ fetchImpl: async () => { called = true; return ackFor({ body: '{"events":[]}' }); } });
    assert.equal(r.ran, false, JSON.stringify(off));
    assert.equal(r.reason, 'upload-disabled');
    assert.equal(called, false, `${JSON.stringify(off)} 下不许构造请求`);
    // 🔴 `GEOLY_TELEMETRY=0` 承诺的是「本地一个字节都不写」——
    //    为自动上报写个节流戳就是违约。另外两个开关也没理由留下痕迹。
    assert.equal(existsSync(join(d, 'telemetry', 'auto-upload.last')), false, JSON.stringify(off));
  }
  isoTelemetry();
});

test('🔴 首次告知没打过就不自动上报 —— 「先发了再告诉你」比不告知更糟', async () => {
  const d = isoTelemetry();
  const { tm, up } = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  assert.equal(tm.noticeShown(), false, '前提：这台机器还没被告知过');

  let called = false;
  const r = await up.maybeAutoUpload({ fetchImpl: async () => { called = true; return null; } });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'notice-not-shown');
  assert.equal(called, false, '告知之前一个字节都不许出网');
  assert.equal(existsSync(join(d, 'telemetry', 'auto-upload.last')), false, '连名额都不该认领');

  // 告知打完之后同一个调用就该放行 —— 否则上面那条断言可能只是「别的原因挡住了」
  tm.maybeNoticeUpload(() => {}, up.endpoint());
  assert.equal(tm.noticeShown(), true);
  const r2 = await up.maybeAutoUpload({ fetchImpl: async (_u, o) => ackFor(o) });
  assert.equal(r2.ran, true, '告知之后才允许发');
});

// ════════════════════════════════════════════════════════════════════════════
// CLI 级：触发点
// ════════════════════════════════════════════════════════════════════════════

test('🔴 install 成功收尾后自动发一次，且告知**先于**那一次出网', async () => {
  isoTelemetry();
  const w = makeWorld();
  const se = { at: null };          // 出网**那一刻** stderr 上已经有什么
  const orig = globalThis.fetch;
  const bodies = [];
  try {
    const so = cap();
    // 自己写 stderr 出口，好让 fetch 替身能读到「此刻打印到哪儿了」
    const stderr = { s: '', write(x) { stderr.s += x; return true; } };
    globalThis.fetch = async (_u, o) => { se.at = stderr.s; bodies.push(o.body); return ackFor(o); };
    const code = await main(['install', 'demo', '--clients', 'claude'], {
      home: w.home, cwd: w.projectRoot, env: { ...process.env, CODEX_HOME: undefined },
      stateDir: w.stateDir, cacheDir: w.cacheDir, now: () => new Date(NOW),
      cliVersion: '1.2.3', verifier: fakeVerifier(), stdout: so, stderr,
    });
    assert.equal(code, 0, so.s + stderr.s);
    assert.equal(bodies.length, 1, 'install 成功之后应该恰好发一次');
    const sent = JSON.parse(bodies[0]).events;
    assert.ok(sent.some((e) => e.kind === 'install' && e.result === 'ok'), '发的应是这次 install 的事件');

    // 🔴 顺序：出网的那一刻，告知**已经**在 stderr 上了
    assert.match(se.at, /首次运行提示/, '告知必须先于自动上报');
    // 输出契约：自动上报完全静默 —— stdout 里不许多出任何一句关于它的话
    assert.ok(!so.s.includes('已上报'), '自动上报不许打印');
    assert.ok(!so.s.includes('未上报'), '自动上报不许打印');
  } finally { globalThis.fetch = orig; }
});

test('🔴 install 失败不发 —— 一次失败的安装不该再替用户付一次网络代价', async () => {
  isoTelemetry();
  const w = makeWorld();
  const f = stubFetch();
  try {
    const r = await run(w, ['install', '不存在的名字', '--clients', 'claude']);
    assert.notEqual(r.code, 0, '前提：这条 install 确实失败了');
    assert.equal(f.calls.length, 0, '失败的 install 不许出网');
  } finally { f.restore(); }
});

test('🔴 别的命令（哪怕成功）都不自动上报', async () => {
  isoTelemetry();
  const w = makeWorld();
  const f = stubFetch();
  try {
    for (const argv of [['list', '--installed'], ['check'], ['stats'], ['list']]) {
      const r = await run(w, argv);
      assert.equal(r.code, 0, `${argv.join(' ')} 该成功：${r.stdout}`);
    }
    assert.equal(f.calls.length, 0, '只有 install 是触发点');
  } finally { f.restore(); }
});

test('🔴 同一天里第二次 install 不再出网（节流在 CLI 上也生效）', async () => {
  isoTelemetry();
  const w = makeWorld();
  const f = stubFetch();
  try {
    assert.equal((await run(w, ['install', 'demo', '--clients', 'claude'])).code, 0);
    assert.equal(f.calls.length, 1);
    // 第二次装同一个：已装过，仍是成功收尾（退出码 0）
    const r2 = await run(w, ['install', 'demo', '--clients', 'claude']);
    assert.equal(r2.code, 0, r2.stdout);
    assert.equal(f.calls.length, 1, '24 小时内只发一次');
  } finally { f.restore(); }
});

test('🔴 `--offline` 下的 install 成功也不出网', async () => {
  isoTelemetry();
  const w = makeWorld();
  const f = stubFetch();
  try {
    const r = await run(w, ['install', 'demo', '--clients', 'claude', '--offline']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(f.calls.length, 0, '--offline 是进程级的一票否决');
  } finally { f.restore(); delete process.env.GEOLY_OFFLINE; }
});

test('🔴 自动上报炸了也不许把一次成功的 install 变成失败', async () => {
  isoTelemetry();
  const w = makeWorld();
  const orig = globalThis.fetch;
  // 不是「返回失败」，是**抛**：把最坏的一侧摆出来
  globalThis.fetch = () => { throw new Error('网络栈自己炸了'); };
  try {
    const r = await run(w, ['install', 'demo', '--clients', 'claude']);
    assert.equal(r.code, 0, `埋点把 install 的退出码改了：${r.stdout}${r.stderr}`);
    assert.ok(!r.stdout.includes('网络栈自己炸了'), '埋点的异常不许出现在输出里');
    assert.ok(!r.stderr.includes('网络栈自己炸了'));
  } finally { globalThis.fetch = orig; }
});

// ════════════════════════════════════════════════════════════════════════════
// 消费式不变量：1 秒超时打在「服务端已 durable、客户端没收到 ACK」那一格上
//
// 🔴 这两条都用**真 server + 真 store**，而且「ACK 没回来」是让**服务端真的不回**、
//    由客户端的 AbortController 在网络层中断 —— 不是在 fetchImpl 里返回一个
//    假的挂起 `text()`。差别是实质的（Codex 2026-09-01 指出初版就是后者）：
//    假 text() 只验到「读 body 挂住」，验不到「请求发出去了、响应没回来」。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 收下并 durable，然后**永远不回复** —— 被超时/被杀的客户端所处的那一格。
 *
 * ⚠️ 诚实边界（Codex 2026-09-01 复查时点名）：这个 handler **不走** server/app.mjs
 *    的路由、限流与 `send()`，只直接调 `parseBatch` + `store.put`。所以它证明的是
 *    「durable 之后 ACK 没回来」这条链，**不**覆盖服务端的路由/限流行为；
 *    第二轮那个正常应答的端点用的才是生产那份 `createHandler`。
 * ⚠️ 同样没覆盖的：服务端**重启后按落盘内容重建去重索引**。这里两轮共用同一个
 *    存活的 store 实例，验的是「同一份索引」的连续性，不是「重启后仍能去重」。
 */
async function silentDurableServer(store, onBatch) {
  const { parseBatch } = await import('../server/validate.mjs');
  const server = createServer((q, s) => {
    let text = '';
    q.on('data', (c) => (text += c));
    q.on('end', async () => {
      try {
        const { events } = parseBatch(text);
        await store.put(events, Date.now());
        onBatch?.(events.length);
      } catch { s.destroy(); }
      // 故意不 s.end()：ACK 永远不回去
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1/events` };
}

/** 正常应答的真端点（server/app.mjs 那一份，与生产同一套 ACK 契约） */
async function realServer(store) {
  const { createHandler, INGEST_PATH } = await import('../server/app.mjs');
  const handler = createHandler({ store });
  const server = createServer((q, s) => { handler(q, s).catch(() => s.destroy()); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}${INGEST_PATH}` };
}
const close = (h) => new Promise((r) => h.server.close(r));
/** 把 flush 的请求原样（**连 signal 一起**）转给本地 http 端点 */
const via = (url) => (_u, o) => fetch(url, { method: o.method, headers: o.headers, body: o.body, signal: o.signal });

test('🔴 服务端已 durable、ACK 没赶回来：重发 → 同一个服务端判 duplicate → 客户端才 retire', async () => {
  const d = isoTelemetry();
  const { tm, up } = await fresh();
  const { openFileStore } = await import('../server/store.mjs');
  // 🔴 **同一个 store 实例贯穿两轮** —— 去重索引的连续性正是要验的东西，
  //    换一个 store 再把事件灌进去，那是把结论当前提。
  const store = openFileStore(join(d, 'srv'));
  try {
    tm.record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0', client: 'claude', scope: 'global' });
    tm.record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/b@1.0.0', client: 'claude', scope: 'global' });

    // ① 端点收下并 durable 了，但**永不回复**；客户端的超时在网络层把它掐掉
    const silent = await silentDurableServer(store);
    let r1;
    try {
      r1 = await up.flush({ timeoutMs: 150, fetchImpl: via(silent.url) });
    } finally { await close(silent); }
    assert.equal(r1.sent, 0, '没拿到 ACK 就不算发出去');
    assert.match(r1.reason, /^error:AbortError$/, `应是网络层被 abort，实际 ${r1.reason}`);
    assert.equal(store.all().length, 2, '前提：服务端这一侧其实已经 durable 了');
    assert.ok(existsSync(join(d, 'telemetry', 'sending.ndjson')), 'sending 必须留在盘上等重发');
    assert.equal(tm.readAll().length, 2, '一条都不许丢');

    // ② 同一个服务端换成正常应答，把同一批原样重发：
    //    accepted=0 / duplicate=2，三个数之和仍等于本批条数 → ackOk 通过 → retire。
    //    🔴 这就是那条链：客户端「宁可重复不可丢失」+ 服务端「按 eid 去重」，两端合起来才成立。
    const live = await realServer(store);
    let r2;
    const acks = [];
    try {
      r2 = await up.flush({
        fetchImpl: async (_u, o) => {
          const res = await fetch(live.url, { method: o.method, headers: o.headers, body: o.body });
          const body = await res.text();
          acks.push(JSON.parse(body));
          return { ok: true, status: 200, headers: res.headers, text: async () => body };
        },
      });
    } finally { await close(live); }
    assert.equal(r2.sent, 2);
    assert.deepEqual(
      { accepted: acks[0].accepted, duplicate: acks[0].duplicate, rejected: acks[0].rejected },
      { accepted: 0, duplicate: 2, rejected: 0 },
      '重发的那一批服务端应全判成 duplicate',
    );
    assert.equal(store.all().length, 2, '服务端不许因为重发而多出两条');
    assert.equal(tm.readAll().length, 0, 'ACK 之后本地队列才被消费掉');
  } finally { store.close(); }
});

test('🔴 进程在 ACK 之前被真的杀掉：事件一条不丢，下一轮接着发', async () => {
  const d = isoTelemetry();
  const { tm, up } = await fresh();
  const { openFileStore } = await import('../server/store.mjs');
  const store = openFileStore(join(d, 'srv'));      // 同样：一个实例贯穿两轮
  let gotBatch;
  const arrived = new Promise((r) => { gotBatch = r; });
  const silent = await silentDurableServer(store, (k) => gotBatch(k));

  const child = spawn(process.execPath, [join(here, 'fixtures/flush-child.mjs'), silent.url], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, GEOLY_STATE_DIR: d },
  });
  try {
    // 子进程自己 record 两条再 flush；等服务端确认收到、durable 了
    assert.equal(await arrived, 2, '前提：子进程真的把两条发过来了');
    assert.equal(store.all().length, 2, '前提：服务端已 durable');

    // 🔴 就在这一格把它杀掉（SIGKILL，不给任何收尾机会）
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    // 客户端这一侧：sending 还在，事件一条不少 —— 这正是 §5.2 说的「安全的一格」
    assert.ok(existsSync(join(d, 'telemetry', 'sending.ndjson')), 'sending 必须留着，下轮接着发');
    assert.equal(tm.readAll().length, 2, '被杀之后一条都不许丢');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await close(silent);
  }

  // 换成正常应答的**同一个** store：重发全判 duplicate，客户端才把队列消费掉
  const live = await realServer(store);
  try {
    const r = await up.flush({ fetchImpl: via(live.url) });
    assert.equal(r.sent, 2, '重发应该走完整个 retire');
    assert.equal(store.all().length, 2, '服务端按 eid 去重，不会长出第三、四条');
    assert.equal(tm.readAll().length, 0);
  } finally { await close(live); store.close(); }
});

test('🔴 自动上报用的是 1 秒，不是 flush 的 3 秒', async () => {
  isoTelemetry();
  const { tm, up } = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  tm.maybeNoticeUpload(() => {}, up.endpoint());

  // 端点连 header 都不回：唯一能结束这次调用的就是超时
  const hang = (_u, o) => new Promise((_res, rej) => {
    o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const t0 = Date.now();
  const r = await up.maybeAutoUpload({ fetchImpl: hang });   // 🔴 **不传 timeoutMs**，走默认值
  const dt = Date.now() - t0;

  assert.equal(r.ran, true);
  assert.equal(r.result.reason, 'error:AbortError');
  assert.equal(up.AUTO_UPLOAD_TIMEOUT_MS, 1000);
  // 判据要能把 1 秒和 flush 的 3 秒**区分开** —— 只断言「小于 3 秒」太松，
  // 只断言「约等于 1 秒」在慢机器上会假红。取 [800ms, 2500ms]。
  assert.ok(dt >= 800, `不该提前返回：${dt}ms`);
  assert.ok(dt < 2500, `自动上报用了 ${dt}ms —— 看着像走了 flush 的 3 秒默认值`);
  assert.equal(tm.readAll().length, 1, '超时不丢事件');
});

/** 跑一次 claim-racer，拿到 {out, code} */
function claimInChild(d) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [join(here, 'fixtures/claim-racer.mjs')], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, GEOLY_STATE_DIR: d },
    });
    let out = '';
    c.stdout.on('data', (x) => (out += x));
    c.once('exit', (code) => res({ out: out.trim(), code }));
  });
}

test('🔴 认领名额必须在上报锁下 —— 锁被占着的时候一个名额都不许认领', async () => {
  const d = isoTelemetry();
  const { tm } = await fresh();
  const { acquire } = await import('../src/lock.mjs');
  const stamp = join(d, 'telemetry', 'auto-upload.last');
  mkdirSync(join(d, 'telemetry'), { recursive: true });

  // 🔴 判据是**受控前提**（父进程持着那把锁），不是「两个子进程同时抢、看谁赢」：
  //    后者靠时序碰运气 —— A 完整跑完再轮到 B 时，就算完全没有互斥，
  //    也会「只有一个 claimed」而绿掉（Codex 2026-09-01 指出）。
  //    这里则是确定性的：有锁就必然 skipped，没锁就必然 claimed。
  const release = acquire(tm.lockPath());
  let held;
  try {
    held = await claimInChild(d);
  } finally { release(); }
  assert.equal(held.code, 0, '子进程该正常退出，不是崩掉');
  assert.equal(held.out, 'skipped', '锁被占着时不许认领（fail-closed）');
  assert.equal(existsSync(stamp), false, '连戳都不该写下去');

  // 锁放开之后同一个子进程就该拿到 —— 否则上面那条断言可能只是「别的原因挡住了」
  const free = await claimInChild(d);
  assert.equal(free.code, 0);
  assert.equal(free.out, 'claimed', '锁放开之后该正常认领');
  assert.ok(existsSync(stamp));

  // 名额被用掉了：下一个进程与本进程都不该再拿到
  const again = await claimInChild(d);
  assert.equal(again.out, 'skipped');
  assert.equal(tm.claimAutoUploadSlot(), false);
});
