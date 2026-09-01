// 上报**默认开**（2026-09-01 用户拍板，规格 v5 §4）。
//
// 🔴 这套测试守的是「默认开」那半个决定的另一半：**默认出网就必须先告知**。
//    只落地默认开、不落地告知，才是这件事最糟的形态。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';

let n = 0;
function iso() {
  const d = mkdtempSync(join(tmpdir(), 'don-'));
  process.env.GEOLY_STATE_DIR = d;
  delete process.env.GEOLY_TELEMETRY;
  delete process.env.GEOLY_TELEMETRY_UPLOAD;
  delete process.env.GEOLY_TELEMETRY_ENDPOINT;
  delete process.env.GEOLY_OFFLINE;
  return d;
}
const fresh = async () => {
  const q = `?d${++n}`;
  return { tm: await import('../src/telemetry.mjs' + q), up: await import('../src/upload.mjs' + q) };
};
const cap = () => { const o = { s: '', write(x) { o.s += x; return true; } }; return o; };
const markPath = (d) => join(d, 'telemetry', 'upload-notice.v1');

// ── 首次告知 ─────────────────────────────────────────────────────────────────

test('🔴 首次告知：内容必须说清「收什么 / 发到哪 / 什么时候发 / 怎么关」', async () => {
  iso();
  const { tm, up } = await fresh();
  const txt = tm.uploadNoticeText(up.endpoint());
  assert.match(txt, /docs\/telemetry\/00-spec\.md §2/, '要指向 §2 的采集面白名单');
  assert.match(txt, /GEOLY_TELEMETRY_UPLOAD=0/, '要写怎么只留本地');
  assert.match(txt, /GEOLY_TELEMETRY=0/, '要写怎么完全关掉');
  assert.match(txt, /--offline/);
  assert.ok(txt.includes(up.DEFAULT_ENDPOINT), '要写数据发到哪');
  // 🔴 「什么时候发」必须两件事都写到：install 成功后会**自动**发一次（§5.1.1，
  //    这是 2026-09-01 拍板后的新形态），以及用户随时可以手动 flush。
  //    只写手动那半句，等于让用户以为「我不敲命令就不会出网」—— 那已经不成立了。
  assert.match(txt, /install/, '要写清 install 成功后会自动发');
  assert.match(txt, /24 小时/, '要写清节流窗口');
  assert.match(txt, /telemetry flush/, '要写清还能手动发');
  assert.match(txt, /路径|目录清单|文件内容/, '要写不收什么');
});

test('🔴 首次告知只出现一次，且落盘标记', async () => {
  const d = iso();
  const { tm, up } = await fresh();
  const w = cap();
  assert.equal(tm.maybeNoticeUpload((s) => w.write(s), up.endpoint()), true);
  assert.ok(w.s.includes(up.DEFAULT_ENDPOINT));
  assert.ok(existsSync(markPath(d)), '要落一个标记，否则每次都刷屏');

  const w2 = cap();
  assert.equal(tm.maybeNoticeUpload((s) => w2.write(s), up.endpoint()), false);
  assert.equal(w2.s, '');
});

test('🔴 关掉上报就不告知（没有出网就没什么可告知的），也不落标记', async () => {
  for (const off of [{ GEOLY_TELEMETRY_UPLOAD: '0' }, { GEOLY_TELEMETRY: '0' }, { GEOLY_OFFLINE: '1' }]) {
    const d = iso();
    Object.assign(process.env, off);
    const { tm, up } = await fresh();
    const w = cap();
    assert.equal(tm.maybeNoticeUpload((s) => w.write(s), up.endpoint()), false, JSON.stringify(off));
    assert.equal(w.s, '');
    assert.equal(existsSync(markPath(d)), false);
  }
  iso();
});

// ── CLI 集成 ─────────────────────────────────────────────────────────────────

test('🔴 告知走 stderr —— `--json` 下 stdout 只能有一个 JSON 对象（§7 输出契约）', async () => {
  iso();
  const stdout = cap(); const stderr = cap();
  await main(['telemetry', 'status', '--json'], { stdout, stderr });
  assert.match(stderr.s, /首次运行提示/);
  assert.ok(!stdout.s.includes('首次运行提示'), '告知不能污染 stdout');
});

test('🔴 CLI 上第二次运行不再刷屏', async () => {
  iso();
  const first = cap();
  await main(['telemetry', 'status'], { stdout: cap(), stderr: first });
  assert.match(first.s, /首次运行提示/);
  const second = cap();
  await main(['telemetry', 'status'], { stdout: cap(), stderr: second });
  assert.equal(second.s, '');
});

test('🔴 `telemetry status` 必须把「这是内置默认端点」写在脸上', async () => {
  iso();
  const stdout = cap();
  await main(['telemetry', 'status'], { stdout, stderr: cap() });
  assert.match(stdout.s, /内置默认值/);
  // 用户显式配了就不该再说是默认值
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://team.example/collect';
  const s2 = cap();
  await main(['telemetry', 'status'], { stdout: s2, stderr: cap() });
  assert.match(s2.s, /team\.example/);
  assert.ok(!s2.s.includes('内置默认值'));
  delete process.env.GEOLY_TELEMETRY_ENDPOINT;
});

// ── 两个开关的一票否决（默认开之后这两条更要紧） ─────────────────────────────

test('🔴 GEOLY_TELEMETRY_UPLOAD=0：置位时不构造请求', async () => {
  iso();
  const { tm, up } = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  process.env.GEOLY_TELEMETRY_UPLOAD = '0';
  let called = false;
  const r = await up.flush({ fetchImpl: async () => { called = true; return { ok: true, status: 200 }; } });
  assert.equal(called, false);
  assert.equal(r.reason, 'upload-disabled');
  assert.equal(tm.readAll().length, 1, '不上报不等于丢掉：事件仍留在本地');
});

test('🔴 --offline：置位时不构造请求', async () => {
  iso();
  const { tm, up } = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  process.env.GEOLY_OFFLINE = '1';
  let called = false;
  const r = await up.flush({ fetchImpl: async () => { called = true; return { ok: true, status: 200 }; } });
  assert.equal(called, false);
  assert.equal(r.reason, 'offline');
});

test('🔴 GEOLY_TELEMETRY=0：本地一个字节都不写，更不会出网', async () => {
  const d = iso();
  process.env.GEOLY_TELEMETRY = '0';
  const { tm, up } = await fresh();
  assert.equal(tm.record({ kind: 'install', result: 'ok' }), null);
  assert.equal(existsSync(join(d, 'telemetry')), false, '连目录都不该建');
  let called = false;
  await up.flush({ fetchImpl: async () => { called = true; return { ok: true, status: 200 }; } });
  assert.equal(called, false);
  delete process.env.GEOLY_TELEMETRY;
});

// ── ACK ──────────────────────────────────────────────────────────────────────

test('🔴 只认 ACK，不认「2xx + 一段 HTML」—— 代理错误页会让队列被白白消费掉', async () => {
  iso();
  const { tm, up } = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  const r = await up.flush({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>登录一下</html>' }),
  });
  assert.equal(r.sent, 0);
  assert.equal(r.reason, 'bad-ack');
  assert.equal(tm.readAll().length, 1, '没被收下的事件必须留在本地');
});

test('🔴 ACK 的条数对不上也不算收下', async () => {
  iso();
  const { tm, up } = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  tm.record({ kind: 'check', result: 'ok' });
  const ack = (o) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  const short = await up.flush({
    fetchImpl: ack({ schema: 'geoly.skills.telemetry-ack/1', accepted: 1, duplicate: 0, rejected: 0 }),
  });
  assert.equal(short.reason, 'bad-ack');
  const ok = await up.flush({
    fetchImpl: ack({ schema: 'geoly.skills.telemetry-ack/1', accepted: 2, duplicate: 0, rejected: 0 }),
  });
  assert.equal(ok.sent, 2);
});

test('rejected > 0 仍然算收下 —— 服务端永久拒收的事件重发一万次也是同一个结果', async () => {
  iso();
  const { tm, up } = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  const r = await up.flush({
    fetchImpl: async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ schema: 'geoly.skills.telemetry-ack/1', accepted: 0, duplicate: 0, rejected: 1 }),
    }),
  });
  assert.equal(r.sent, 1);
  assert.equal(tm.readAll().length, 0, '否则这一批会永远卡在 sending 里重发');
});

test('🔴 端点配错要非零退出 —— 否则脚本永远发现不了「这台机器从此不上报」', async () => {
  iso();
  process.env.GEOLY_TELEMETRY_ENDPOINT = '';
  const stdout = cap();
  const code = await main(['telemetry', 'flush'], { stdout, stderr: cap() });
  assert.notEqual(code, 0, `bad-endpoint 退了 ${code}`);
  assert.match(stdout.s, /bad-endpoint/);
  delete process.env.GEOLY_TELEMETRY_ENDPOINT;

  // 对比：正常的「没什么可发的」是 0，别把状态当错误
  iso();
  assert.equal(await main(['telemetry', 'flush', '--offline'], { stdout: cap(), stderr: cap() }), 0);
});

test('🔴 只回 header 不发 body 的端点不能把 flush 挂死（超时要覆盖读 ACK）', async () => {
  iso();
  const { tm, up } = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  // body 永远不来。3 秒超时若只覆盖 fetch 本身，这里会一直挂着 —— 而且
  // 那时它**正持有上报锁**，后面每次 flush 都会 busy（T-5）。
  const r = await up.flush({
    timeoutMs: 200,
    fetchImpl: async (_u, o) => ({
      ok: true, status: 200,
      text: () => new Promise((_res, rej) => { o.signal.addEventListener('abort', () => rej(new Error('aborted'))); }),
    }),
  });
  assert.equal(r.sent, 0);
  assert.equal(r.reason, 'bad-ack');
  assert.equal(tm.readAll().length, 1, '没确认收下的事件必须留在本地');
});

// ── 端到端：客户端 flush → 真端点 → retire ──────────────────────────────────

test('🔴 端到端：客户端发出去的字节，端点这一侧真的收得下（两边的契约是同一份）', async () => {
  const d = iso();
  const { createServer } = await import('node:http');
  const { createHandler, INGEST_PATH } = await import('../server/app.mjs');
  const { openFileStore } = await import('../server/store.mjs');
  const { tm, up } = await fresh();

  const store = openFileStore(join(d, 'srv'));
  const handler = createHandler({ store });
  const server = createServer((q, s) => { handler(q, s).catch(() => s.destroy()); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${server.address().port}${INGEST_PATH}`;
  try {
    tm.record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0', client: 'claude', scope: 'global' });
    tm.record({ kind: 'check', result: 'failed', artifact: 'skill:geoly/a@1.0.0', reason: 'digest-mismatch' });
    // 端点是 https-only，所以本地 http 端点靠注入的 fetchImpl 转接 —— 被测的是
    // **body 与 ACK 这两份契约**，https 那条边界由 upload.test.mjs 另外守
    const via = (_u, o) => fetch(local, o);
    const r = await up.flush({ fetchImpl: via });
    assert.equal(r.sent, 2);
    assert.equal(store.all().length, 2);
    assert.equal(tm.readAll().length, 0, 'ACK 之后本地队列该被消费掉');

    // 重发同一批（at-least-once 的形状）：端点按 eid 去重，存储里不长出第三条
    const { summarize } = await import('../server/aggregate.mjs');
    assert.equal(summarize(store.all().map((x) => x.event)).byArtifact[0].n, 2);
    assert.equal(store.all().length, 2);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
