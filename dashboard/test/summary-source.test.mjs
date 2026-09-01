import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SUMMARY_SCHEMA } from '../lib/normalize.mjs';
import { fetchSummary, maskUrl } from '../lib/summary-source.mjs';
import { SOURCE } from '../lib/state.mjs';

const ENV = { GEOLY_SUMMARY_URL: 'https://tel.example/v1/summary', GEOLY_TELEMETRY_SUMMARY_TOKEN: 'tok-abc' };
const res = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('没配 = unconfigured，而且一次请求都不发', async () => {
  let called = 0;
  const r = await fetchSummary({ env: {}, fetchImpl: async () => { called++; } });
  assert.equal(r.source, SOURCE.UNCONFIGURED);
  assert.equal(called, 0);
});

test('🔴 空串是「没配」，不是「配了个空的」—— 部署模板漏填最常见的形态', async () => {
  const r = await fetchSummary({ env: { GEOLY_SUMMARY_URL: '   ', GEOLY_TELEMETRY_SUMMARY_TOKEN: '' } });
  assert.equal(r.source, SOURCE.UNCONFIGURED);
});

test('🔴 非 https 一律拒（localhost 除外）—— 否则 token 明文过网', async () => {
  const bad = await fetchSummary({
    env: { GEOLY_SUMMARY_URL: 'http://tel.example/v1/summary', GEOLY_TELEMETRY_SUMMARY_TOKEN: 't' },
    fetchImpl: async () => { throw new Error('不该发出去'); },
  });
  assert.equal(bad.source, SOURCE.UNCONFIGURED);
  assert.match(bad.why, /https/);
});

test('token 走 Authorization 头，且不回到返回值里', async () => {
  let seen = null;
  const r = await fetchSummary({
    env: ENV,
    fetchImpl: async (url, init) => { seen = init; return res(200, { schema: SUMMARY_SCHEMA, total: 0 }); },
  });
  assert.equal(seen.headers.authorization, 'Bearer tok-abc');
  assert.equal(seen.redirect, 'error', '跟随重定向会把 Authorization 头带到别的主机去');
  assert.equal(seen.cache, 'no-store');
  assert.ok(!JSON.stringify(r).includes('tok-abc'), '返回值里出现了 token');
});

test('401 / 403 / 404 都是 denied（404 = 服务端没开这个路由）', async () => {
  for (const s of [401, 403, 404]) {
    const r = await fetchSummary({ env: ENV, fetchImpl: async () => res(s, { error: 'x' }) });
    assert.equal(r.source, SOURCE.DENIED, `${s} 应该判 denied`);
  }
});

test('5xx / 网络错误 = unreachable，且不带出异常消息（里面可能有内网主机名）', async () => {
  const a = await fetchSummary({ env: ENV, fetchImpl: async () => res(503, { error: 'busy' }) });
  assert.equal(a.source, SOURCE.UNREACHABLE);
  const b = await fetchSummary({
    env: ENV,
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED 10.0.0.7:8787'); },
  });
  assert.equal(b.source, SOURCE.UNREACHABLE);
  assert.ok(!JSON.stringify(b).includes('10.0.0.7'));
});

test('🔴 200 + 一段 HTML（代理错误页 / 登录墙）= invalid，绝不当成 0', async () => {
  const r = await fetchSummary({ env: ENV, fetchImpl: async () => res(200, '<html>Sign in</html>') });
  assert.equal(r.source, SOURCE.INVALID);
  assert.equal(r.data, null);
});

test('200 + 合法汇总 = ok，total 为 0 时照样是 ok（真实的 0）', async () => {
  const r = await fetchSummary({ env: ENV, fetchImpl: async () => res(200, { schema: SUMMARY_SCHEMA, total: 0 }) });
  assert.equal(r.source, SOURCE.OK);
  assert.equal(r.data.total, 0);
});

test('端点 URL 掩码：丢掉 query 与内嵌凭据', () => {
  assert.equal(maskUrl('https://a.example/v1/summary?token=leak'), 'https://a.example/v1/summary');
  assert.match(maskUrl('https://u:p@a.example/v1/summary'), /凭据已掩码/);
  assert.equal(maskUrl('not a url'), '<不是一个合法的 URL>');
});
