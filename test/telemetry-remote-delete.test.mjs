// 客户端的远程删除 —— src/upload.mjs 的 remoteDelete / readBounded / deleteUrls。
//
// 🔴 假服务端**用真的 server/delete.mjs 签发与验签**：客户端怎么签、服务端怎么验，
//    两边都是生产代码，这里只替换了网络。签名消息的定义漂了，这一组会先红。
// 🔴 每个「不该出网」的用例都注入一个**会炸的 fetch**：靠「没断言到调用」证明不出网不算数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DELETE_TIMEOUT_MS, MAX_DELETE_RESPONSE_BYTES, deleteUrls, readBounded, remoteDelete,
} from '../src/upload.mjs';
import {
  CHALLENGE_SCHEMA, DELETE_SCHEMA, checkNonce, mintNonce, pubkeyTag, verifyProof,
} from '../server/delete.mjs';

const SECRET = 'r'.repeat(32);
const DEFAULT_AUD = 'https://skills-hub-telemetry.vercel.app/v1/delete';

function freshKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pubkey: publicKey.export({ format: 'jwk' }).x,
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
}

const ENV_KEYS = ['GEOLY_STATE_DIR', 'GEOLY_OFFLINE', 'GEOLY_TELEMETRY', 'GEOLY_TELEMETRY_UPLOAD', 'GEOLY_TELEMETRY_ENDPOINT'];
async function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GEOLY_STATE_DIR = mkdtempSync(join(tmpdir(), 'rdel-'));
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});
const boom = () => { throw new Error('这个用例不该出网'); };

/**
 * 按真实协议应答的假服务端。`audience` 是它**声称**的删除端点；`verifyAs` 是它真正用来验签的。
 * 两者默认相同 —— 中继攻击就是两者不同的那种形状。
 */
function fakeServer({ audience = DEFAULT_AUD, verifyAs = audience, onDelete } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const body = JSON.parse(init.body);
    if (url.endsWith('/delete/challenge')) {
      return json({
        schema: CHALLENGE_SCHEMA, audience,
        nonce: mintNonce(pubkeyTag(body.pubkey, SECRET), { secret: SECRET }), expires_in: 300,
      });
    }
    if (onDelete) return onDelete(body);
    const ok = verifyProof({ audience: verifyAs, ...body })
      && checkNonce(body.nonce, pubkeyTag(body.pubkey, SECRET), { secret: SECRET }).ok;
    return ok ? json({ schema: DELETE_SCHEMA, deleted: true }) : json({ error: 'bad-proof' }, 400);
  };
  return { calls, fetchImpl };
}

// ── URL ─────────────────────────────────────────────────────────────────────

test('删除端点相对上报端点解析：默认端点 → /v1/delete，自定义前缀保留', () => {
  assert.deepEqual(deleteUrls('https://skills-hub-telemetry.vercel.app/v1/events'), {
    challenge: 'https://skills-hub-telemetry.vercel.app/v1/delete/challenge',
    delete: DEFAULT_AUD,
  });
  assert.equal(deleteUrls('https://x.example/team/v1/events').delete, 'https://x.example/team/v1/delete');
});

// ── 正常路径 ────────────────────────────────────────────────────────────────

test('🔴 与真实验签逻辑往返一轮：取挑战 → 签名 → 删除成功', async () => {
  await withEnv({}, async () => {
    const k = freshKey();
    const srv = fakeServer();
    const r = await remoteDelete({ key: k, fetchImpl: srv.fetchImpl });
    assert.deepEqual(r, { ok: true });
    assert.equal(srv.calls.length, 2);
    assert.equal(srv.calls[0].url, 'https://skills-hub-telemetry.vercel.app/v1/delete/challenge');
    assert.equal(srv.calls[1].url, DEFAULT_AUD);
    for (const c of srv.calls) {
      assert.equal(c.init.method, 'POST');
      assert.equal(c.init.redirect, 'error', '允许重定向 = 一个 307 就能把请求转到别处');
      assert.ok(c.init.signal instanceof AbortSignal, '没有超时');
    }
    assert.deepEqual(Object.keys(srv.calls[1].body).sort(), ['nonce', 'pubkey', 'schema', 'signature']);
    assert.ok(!srv.calls.some((c) => c.init.body.includes('PRIVATE KEY')), '私钥出网了');
  });
});

// 🔴 中继（Codex 2026-09-13 的 P0）：端点声称的 audience 与我们要发去的不同 → 不签。
test('🔴 audience 对不上 → 不签名、不发第二个请求', async () => {
  await withEnv({}, async () => {
    const srv = fakeServer({ audience: 'https://skills-hub-telemetry.vercel.app/v1/other' });
    const r = await remoteDelete({ key: freshKey(), fetchImpl: srv.fetchImpl });
    assert.deepEqual(r, { ok: false, reason: 'audience-mismatch' });
    assert.equal(srv.calls.length, 1, '签名已经发出去了 —— 中继者拿到它就能转发');
  });
});

test('🔴 服务端按另一个 audience 验签（中继到正式服务）→ 删除不成立', async () => {
  await withEnv({}, async () => {
    // 端点对我们声称自己是默认端点，实际把签名转给一个 audience 不同的服务
    const srv = fakeServer({ verifyAs: 'https://real.example/v1/delete' });
    const r = await remoteDelete({ key: freshKey(), fetchImpl: srv.fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'http-400');
  });
});

// ── 否决与前提 ──────────────────────────────────────────────────────────────

// 🔴 三个开关都承诺过「不发网络请求」，删除请求也是网络请求（Codex 2026-09-13 P1）。
for (const [name, env, reason] of [
  ['--offline', { GEOLY_OFFLINE: '1' }, 'offline'],
  ['GEOLY_TELEMETRY=0', { GEOLY_TELEMETRY: '0' }, 'upload-disabled'],
  ['GEOLY_TELEMETRY_UPLOAD=0', { GEOLY_TELEMETRY_UPLOAD: '0' }, 'upload-disabled'],
]) {
  test(`🔴 ${name} 一票否决远程删除，连请求都不构造`, async () => {
    await withEnv(env, async () => {
      const r = await remoteDelete({ key: freshKey(), fetchImpl: boom });
      assert.deepEqual(r, { ok: false, reason });
    });
  });
}

test('没有私钥 → no-key，不出网', async () => {
  await withEnv({}, async () => {
    for (const key of [null, undefined, {}, { pem: 'x', pubkey: 'short' }]) {
      assert.deepEqual(await remoteDelete({ key, fetchImpl: boom }), { ok: false, reason: 'no-key' });
    }
  });
});

test('端点配错 → bad-endpoint，不出网', async () => {
  await withEnv({ GEOLY_TELEMETRY_ENDPOINT: 'http://plain.example/v1/events' }, async () => {
    const r = await remoteDelete({ key: freshKey(), fetchImpl: boom });
    assert.equal(r.reason, 'bad-endpoint');
  });
});

// ── 回执要严格 ──────────────────────────────────────────────────────────────

test('🔴 回执不是恰好 {schema, deleted:true} 就不算删成功', async () => {
  await withEnv({}, async () => {
    for (const [label, res] of [
      ['缺 schema', () => json({ deleted: true })],
      ['多一个键', () => json({ schema: DELETE_SCHEMA, deleted: true, rows: 3 })],
      ['deleted 不是 true', () => json({ schema: DELETE_SCHEMA, deleted: 'yes' })],
      ['HTTP 500', () => json({ error: 'internal' }, 500)],
      ['不是 JSON', () => new Response('<html>ok</html>', { status: 200 })],
      ['JSON 数组', () => json([DELETE_SCHEMA])],
      ['重复键', () => new Response(`{"schema":"${DELETE_SCHEMA}","deleted":false,"deleted":true}`, { status: 200 })],
      ['被重定向', () => ({ ok: true, status: 200, redirected: true, headers: new Headers(), body: null })],
    ]) {
      const srv = fakeServer({ onDelete: res });
      const r = await remoteDelete({ key: freshKey(), fetchImpl: srv.fetchImpl });
      assert.equal(r.ok, false, `${label} 被当成删除成功了`);
    }
  });
});

test('挑战本身不合规 → bad-challenge / bad-response，不签名', async () => {
  await withEnv({}, async () => {
    for (const ch of [
      { schema: 'other', audience: DEFAULT_AUD, nonce: 'x', expires_in: 300 },
      { schema: CHALLENGE_SCHEMA, audience: DEFAULT_AUD, nonce: 'short', expires_in: 300 },
      { schema: CHALLENGE_SCHEMA, audience: DEFAULT_AUD, expires_in: 300 },
    ]) {
      let n = 0;
      const r = await remoteDelete({
        key: freshKey(),
        fetchImpl: async () => { n++; return json(ch); },
      });
      assert.equal(r.ok, false);
      assert.equal(n, 1, `挑战不合规还发了删除请求：${JSON.stringify(ch)}`);
    }
  });
});

// ── 有界读取 ────────────────────────────────────────────────────────────────

const streamOf = (chunks, { close = true } = {}) => new ReadableStream({
  start(c) {
    for (const x of chunks) c.enqueue(typeof x === 'string' ? new TextEncoder().encode(x) : x);
    if (close) c.close();
  },
});

test('🔴 readBounded：声明超限不读；chunked 超限中途取消；按字节不按字符', async () => {
  const declared = new Response(streamOf(['{}']), { headers: { 'content-length': String(MAX_DELETE_RESPONSE_BYTES + 1) } });
  assert.equal(await readBounded(declared, MAX_DELETE_RESPONSE_BYTES), null);

  let pulled = 0;
  const endless = new Response(new ReadableStream({
    pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); },
  }));
  assert.equal(await readBounded(endless, 4096), null);
  assert.ok(pulled <= 6, `超限之后还在读（读了 ${pulled} 块）—— 内存上界不成立`);

  // 「你好」是 2 个字符、6 个字节
  assert.equal(await readBounded(new Response(streamOf(['你好'])), 5), null, '按字符数算了长度');
  assert.equal(await readBounded(new Response(streamOf(['你好'])), 6), '你好');
});

test('readBounded：非法 UTF-8 与没有流的响应一律 null（fail-closed）', async () => {
  assert.equal(await readBounded(new Response(streamOf([new Uint8Array([0xff, 0xfe])])), 100), null);
  assert.equal(await readBounded({ headers: new Headers(), body: null }, 100), null);
  assert.equal(await readBounded({ headers: new Headers() }, 100), null);
});

test('🔴 响应体永不结束 → 超时之后返回失败，不挂住', async () => {
  await withEnv({}, async () => {
    const fetchImpl = async (url, init) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"schema":'));
        // 真实 fetch 在 abort 时会让 body 流出错；替身照做
        init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    }));
    const t0 = Date.now();
    const r = await remoteDelete({ key: freshKey(), fetchImpl, timeoutMs: 50 });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 2000, '超时没有生效');
  });
  assert.ok(DELETE_TIMEOUT_MS >= 1000, '缺省超时太短，慢网下删除永远失败');
});

// 🔴 上报 ACK 与删除回执同一条纪律（Codex 2026-09-13 P1）：早先 ackOk 先 `res.text()` 再比长度，
//    一个 chunked 的恶意端点能先把任意大小的 body 整个塞进内存。
test('🔴 上报 ACK：无限 chunked 响应按字节读到上限就取消，这批留在本地', async () => {
  await withEnv({}, async () => {
    const { flush } = await import('../src/upload.mjs');
    const { record, readAll } = await import('../src/telemetry.mjs');
    record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });
    assert.ok(readAll().length > 0, '前提自查：队列里得有东西');
    let pulled = 0;
    const r = await flush({
      timeoutMs: 2000,
      fetchImpl: async () => new Response(new ReadableStream({
        pull(c) { pulled++; c.enqueue(new Uint8Array(16 * 1024)); },
      }), { status: 200 }),
    });
    assert.equal(r.sent, 0);
    assert.equal(r.reason, 'bad-ack');
    assert.ok(pulled <= 8, `超过 ACK 上限之后还在读（读了 ${pulled} 块）`);
    assert.ok(readAll().length > 0, 'ACK 没通过却把队列消费掉了');
  });
});
