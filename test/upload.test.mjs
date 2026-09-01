import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function iso() {
  const d = mkdtempSync(join(tmpdir(), 'up-'));
  process.env.GEOLY_STATE_DIR = d;
  delete process.env.GEOLY_TELEMETRY;
  delete process.env.GEOLY_TELEMETRY_UPLOAD;
  delete process.env.GEOLY_TELEMETRY_ENDPOINT;
  delete process.env.GEOLY_OFFLINE;
  return d;
}
let n = 0;
const fresh = async () => {
  const q = `?${++n}`;
  return { tm: await import('../src/telemetry.mjs' + q), up: await import('../src/upload.mjs' + q) };
};

// 🔴 这条测试的语义在 2026-09-01 被产品决定翻转了：上报**默认开**，
//    GEOLY_TELEMETRY_ENDPOINT 有内置默认值（规格 v5 §4）。
//    「没配端点 = 不出网」不再成立 —— 现在不配就是**用内置默认端点发**。
//    留着旧断言等于让测试替一条已经作废的保证背书。
test('🔴 没配端点 = 用内置默认端点（默认开）', async () => {
  iso();
  const { tm, up } = await fresh();
  tm.record({ kind: 'install', result: 'ok' });
  let seen = null;
  const r = await up.flush({ fetchImpl: async (u) => { seen = u; return { ok: true, status: 200 }; } });
  assert.equal(seen, up.DEFAULT_ENDPOINT);
  assert.equal(r.sent, 1);
  assert.equal(up.isDefaultEndpoint(), true);
});

test('🔴 内置默认端点自己也要过 https / 凭据校验（不给默认值开后门）', async () => {
  iso();
  const { up } = await fresh();
  const u = new URL(up.DEFAULT_ENDPOINT);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.username, '');
  assert.equal(u.password, '');
  assert.equal(up.endpoint(), u.toString());
});

test('🔴 端点被设成空串 = 配置错误，不是"静默关掉上报"', async () => {
  iso();
  const { tm, up } = await fresh();
  // 部署模板漏填变量最常见的形态就是空串。把它当"关闭"会让整片机器悄悄不上报，
  // 而没有任何人会注意到 —— 关上报有明确的开关（GEOLY_TELEMETRY_UPLOAD=0）。
  process.env.GEOLY_TELEMETRY_ENDPOINT = '';
  tm.record({ kind: 'install', result: 'ok' });
  assert.throws(() => up.endpoint(), /空值/);
  let called = false;
  const r = await up.flush({ fetchImpl: async () => { called = true; } });
  assert.equal(called, false, '配错了也不能构造请求');
  assert.equal(r.reason, 'bad-endpoint');
  assert.match(r.detail, /GEOLY_TELEMETRY_UPLOAD=0/, '要告诉用户正确的关法');
});

test('🔴 http 端点被拒（只允许 https）', async () => {
  iso();
  const { up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'http://evil.example/collect';
  assert.throws(() => up.endpoint(), /必须是 https/);
});

test('上报后游标推进，重复 flush 不重发', async () => {
  iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record({ kind: 'install', result: 'ok', artifact: 'skill:g/a@1.0.0' });
  const bodies = [];
  const f = async (_u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, status: 200 }; };
  assert.equal((await up.flush({ fetchImpl: f })).sent, 1);
  assert.equal((await up.flush({ fetchImpl: f })).sent, 0);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].events[0].artifact, 'skill:g/a@1.0.0');
});

test('🔴 上报体里没有路径、没有家目录、没有用户名', async () => {
  iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record({ kind: 'install', result: 'ok', artifact: 'skill:g/a@1.0.0', client: 'claude', scope: 'project' });
  let body;
  await up.flush({ fetchImpl: async (_u, o) => { body = o.body; return { ok: true, status: 200 }; } });
  assert.ok(!body.includes(process.env.HOME));
  assert.ok(!body.includes(process.env.USER ?? ' nope'));
  assert.ok(!/"[^"]*\/(Users|home)\//.test(body));
});

test('🔴 上报失败不抛错，事件留在本地等下次', async () => {
  iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record({ kind: 'install', result: 'ok' });
  const bad = await up.flush({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(bad.sent, 0);
  assert.match(bad.reason, /^error:/);
  const good = await up.flush({ fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(good.sent, 1); // 没丢
});

test('GEOLY_TELEMETRY_UPLOAD=0 只留本地', async () => {
  iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  process.env.GEOLY_TELEMETRY_UPLOAD = '0';
  tm.record({ kind: 'install', result: 'ok' });
  const r = await up.flush({ fetchImpl: async () => { throw new Error('不该被调用'); } });
  assert.equal(r.reason, 'upload-disabled');
  assert.equal(tm.readAll().length, 1); // 本地照记
});

test('🔴 重定向被拒 —— 恶意 https 端点不能 307 到 http 降级', async () => {
  iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  tm.record({ kind: 'install', result: 'ok' });
  let opts;
  const r = await up.flush({
    fetchImpl: async (_u, o) => { opts = o; return { ok: true, status: 200, redirected: true }; },
  });
  assert.equal(opts.redirect, 'error', 'fetch 必须显式禁止跟随重定向');
  assert.equal(r.sent, 0);
  assert.equal(r.reason, 'redirect-refused');
});

test('🔴 端点里内嵌凭据被拒', async () => {
  iso();
  const { up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://user:pass@hub.example/collect';
  assert.throws(() => up.endpoint(), /凭据/);
});

test('🔴 骗过 startsWith 的畸形 URL 被拒', async () => {
  iso();
  const { up } = await fresh();
  for (const bad of ['not-a-url', 'ftp://hub.example/x']) {
    process.env.GEOLY_TELEMETRY_ENDPOINT = bad;
    assert.throws(() => up.endpoint(), /https|合法 URL/, bad);
  }
});

test('🔴 --offline 时不发任何网络请求', async () => {
  iso();
  const { tm, up } = await fresh();
  process.env.GEOLY_TELEMETRY_ENDPOINT = 'https://hub.example/collect';
  process.env.GEOLY_OFFLINE = '1';
  tm.record({ kind: 'install', result: 'ok' });
  const r = await up.flush({ fetchImpl: async () => { throw new Error('offline 下不该发'); } });
  assert.equal(r.reason, 'offline');
  assert.equal(tm.readAll().length, 1, '本地仍照记');
  delete process.env.GEOLY_OFFLINE;
});
