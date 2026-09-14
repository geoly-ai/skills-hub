// 删除通道的 HTTP 面与信封解析 —— 规格 docs/telemetry/00-spec.md §4.4。
//
// 🔴 这一组钉的是：
//    · 对外不泄漏存在性 —— 挑战永远发、证明失败一律 bad-proof、成功只回 deleted:true
//    · 证明不成立就**不碰存储** —— 公开端点不能让任何人灌表或灌审计
//    · 三样全局前提缺一样就 503，不降级 —— audience、tag 密钥、密钥指纹
//    · 摄入面真的把公钥换成 tag 再交给 store（Codex 2026-09-13 P0-1：不能只测拼接）
//    存储层的 SQL 顺序在 store-postgres.test.mjs 里测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';

import { createHandler, DELETE_CHALLENGE_PATH, DELETE_PATH, INGEST_PATH } from '../server/app.mjs';
import {
  BadDeleteRequestError, CHALLENGE_SCHEMA, DELETE_SCHEMA, MAX_DELETE_BODY_BYTES,
  checkNonce, mintNonce, parseChallengeRequest, parseDeleteRequest, pubkeyTag, signedMessage, tagKeyId,
} from '../server/delete.mjs';
import { BATCH_SCHEMA } from '../server/validate.mjs';

const SECRET = 'k'.repeat(32);
const AUD = 'https://t.example/v1/delete';
const ENV = { GEOLY_TELEMETRY_TAG_SECRET: SECRET, GEOLY_TELEMETRY_DELETE_AUDIENCE: AUD };

function freshKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pubkey: publicKey.export({ format: 'jwk' }).x, privateKey };
}
const sign = (k, nonce, audience = AUD) =>
  edSign(null, signedMessage({ audience, pubkey: k.pubkey, nonce }), k.privateKey).toString('base64url');

// ── 信封 ────────────────────────────────────────────────────────────────────

test('challenge 信封：键穷举、schema 常量、pubkey 定长且规范', () => {
  const k = freshKey();
  assert.deepEqual(parseChallengeRequest({ schema: CHALLENGE_SCHEMA, pubkey: k.pubkey }), { pubkey: k.pubkey });
  const code = (fn) => {
    try { fn(); } catch (e) { assert.ok(e instanceof BadDeleteRequestError); return e.code; }
    return 'passed';
  };
  assert.equal(code(() => parseChallengeRequest({ schema: CHALLENGE_SCHEMA, pubkey: k.pubkey, extra: 1 })), 'envelope-keys');
  assert.equal(code(() => parseChallengeRequest({ schema: DELETE_SCHEMA, pubkey: k.pubkey })), 'bad-schema');
  assert.equal(code(() => parseChallengeRequest({ schema: CHALLENGE_SCHEMA, pubkey: 'short' })), 'bad-pubkey');
  assert.equal(code(() => parseChallengeRequest([])), 'envelope-not-object');
  assert.equal(code(() => parseChallengeRequest(null)), 'envelope-not-object');
});

test('🔴 delete 信封：形状不对与签名不对是同一个码（不告诉探测者差在哪）', () => {
  const k = freshKey();
  const nonce = Buffer.alloc(32, 1).toString('base64url');
  const good = { schema: DELETE_SCHEMA, pubkey: k.pubkey, nonce, signature: sign(k, nonce) };
  assert.deepEqual(parseDeleteRequest(good), { pubkey: k.pubkey, nonce, signature: good.signature });
  for (const bad of [{ ...good, nonce: 'short' }, { ...good, signature: 1 }, { ...good, pubkey: 'x' }]) {
    assert.throws(() => parseDeleteRequest(bad), (e) => e.code === 'bad-proof');
  }
  assert.throws(() => parseDeleteRequest({ ...good, extra: 1 }), (e) => e.code === 'envelope-keys');
});

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * 记账的假 store。`deleteIdentity` 按真实语义记「已消费 nonce」：同一个 nonce 第二次回 false。
 * `keyIdOk` 为 false 时模拟「库里指纹与当前密钥对不上」。
 */
function fakeStore({ keyIdOk = true } = {}) {
  const consumed = new Set();
  const calls = { deletes: [], keyChecks: [], puts: [] };
  return {
    calls,
    put: async (events, at, identities, ip) => {
      calls.puts.push({ events, identities, ip });
      return { accepted: events.length, duplicate: 0 };
    },
    all: async () => [],
    rollup: async () => null,
    tagKeyIdMatches: async (expected) => {
      calls.keyChecks.push(expected);
      return keyIdOk && expected === tagKeyId(SECRET);
    },
    deleteIdentity: async (tag, nonce, expiresAtMs, rid) => {
      calls.deletes.push({ tag, nonce, expiresAtMs, rid });
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  };
}

async function withServer(store, fn, env = ENV) {
  const keys = ['GEOLY_TELEMETRY_TAG_SECRET', 'GEOLY_TELEMETRY_DELETE_AUDIENCE', 'GEOLY_TELEMETRY_IDENTITY_INGEST'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  const handler = createHandler({ store });
  const server = createServer((q, s) => { handler(q, s).catch(() => s.destroy()); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  try {
    await fn({ base, post });
  } finally {
    await new Promise((r) => server.close(r));
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const challenge = async (post, k) =>
  (await post(DELETE_CHALLENGE_PATH, { schema: CHALLENGE_SCHEMA, pubkey: k.pubkey })).json();

test('正常路径：取挑战 → 签名 → 删除成功，交给存储的是 tag 不是公钥', async () => {
  const store = fakeStore();
  const k = freshKey();
  await withServer(store, async ({ post }) => {
    const c = await post(DELETE_CHALLENGE_PATH, { schema: CHALLENGE_SCHEMA, pubkey: k.pubkey });
    assert.equal(c.status, 200);
    assert.equal(c.headers.get('cache-control'), 'no-store', '挑战被缓存住就会发给别人');
    const ch = await c.json();
    assert.deepEqual(Object.keys(ch).sort(), ['audience', 'expires_in', 'nonce', 'schema']);
    assert.equal(ch.schema, CHALLENGE_SCHEMA);
    assert.equal(ch.audience, AUD, 'audience 必须来自服务端配置，不是请求');
    assert.equal(ch.expires_in, 300);
    const tag = pubkeyTag(k.pubkey, SECRET);
    assert.equal(checkNonce(ch.nonce, tag, { secret: SECRET }).ok, true, '发出去的 nonce 自己验不过');

    const d = await post(DELETE_PATH, {
      schema: DELETE_SCHEMA, pubkey: k.pubkey, nonce: ch.nonce, signature: sign(k, ch.nonce),
    });
    assert.equal(d.status, 200);
    assert.equal(d.headers.get('cache-control'), 'no-store');
    // 🔴 只有这两个键 —— 行数、tag、任何回显都不许有
    assert.deepEqual(await d.json(), { schema: DELETE_SCHEMA, deleted: true });
    assert.equal(store.calls.deletes.length, 1);
    const call = store.calls.deletes[0];
    assert.equal(call.tag, tag);
    assert.equal(call.nonce, ch.nonce);
    assert.ok(Number.isFinite(call.expiresAtMs) && call.expiresAtMs > Date.now());
    assert.match(call.rid, /^[0-9a-f-]{36}$/, 'request_id 必须由服务端生成');
    assert.ok(!JSON.stringify(store.calls).includes(k.pubkey), '公钥原文进了存储层');
  });
});

test('🔴 同一个挑战用第二次 → bad-proof（重放）', async () => {
  const store = fakeStore();
  const k = freshKey();
  await withServer(store, async ({ post }) => {
    const ch = await challenge(post, k);
    const body = { schema: DELETE_SCHEMA, pubkey: k.pubkey, nonce: ch.nonce, signature: sign(k, ch.nonce) };
    assert.equal((await post(DELETE_PATH, body)).status, 200);
    const again = await post(DELETE_PATH, body);
    assert.equal(again.status, 400);
    assert.deepEqual(await again.json(), { error: 'bad-proof' });
  });
});

test('🔴 签名不对 → 400 bad-proof，而且根本不碰存储（不消费 nonce、不写审计）', async () => {
  const store = fakeStore();
  const k = freshKey(); const other = freshKey();
  await withServer(store, async ({ post }) => {
    const ch = await challenge(post, k);
    const r = await post(DELETE_PATH, { schema: DELETE_SCHEMA, pubkey: k.pubkey, nonce: ch.nonce, signature: sign(other, ch.nonce) });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'bad-proof' });
    assert.equal(store.calls.deletes.length, 0, '验签失败还进了存储层 —— 任何人都能灌审计表');
  });
});

// 🔴 中继（Codex 2026-09-13 的 P0）：签名是签给另一个端点的，正式端点不收。
test('🔴 签给别的 audience 的签名 → bad-proof，不碰存储', async () => {
  const store = fakeStore();
  const k = freshKey();
  await withServer(store, async ({ post }) => {
    const ch = await challenge(post, k);
    const relayed = sign(k, ch.nonce, 'https://evil.example/v1/delete');
    const r = await post(DELETE_PATH, { schema: DELETE_SCHEMA, pubkey: k.pubkey, nonce: ch.nonce, signature: relayed });
    assert.equal(r.status, 400);
    assert.equal(store.calls.deletes.length, 0);
  });
});

test('🔴 挑战是签给别的公钥的 → bad-proof，不碰存储', async () => {
  const store = fakeStore();
  const victim = freshKey(); const attacker = freshKey();
  await withServer(store, async ({ post }) => {
    const ch = await challenge(post, victim);
    // 攻击者用自己的钥匙签「受害者的挑战」
    const r = await post(DELETE_PATH, {
      schema: DELETE_SCHEMA, pubkey: attacker.pubkey, nonce: ch.nonce, signature: sign(attacker, ch.nonce),
    });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'bad-proof' });
    assert.equal(store.calls.deletes.length, 0);
  });
});

test('🔴 过期的挑战 → bad-proof，不碰存储', async () => {
  const store = fakeStore();
  const k = freshKey();
  await withServer(store, async ({ post }) => {
    const stale = mintNonce(pubkeyTag(k.pubkey, SECRET), { nowMs: Date.now() - 301_000, secret: SECRET });
    const r = await post(DELETE_PATH, { schema: DELETE_SCHEMA, pubkey: k.pubkey, nonce: stale, signature: sign(k, stale) });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'bad-proof' });
    assert.equal(store.calls.deletes.length, 0);
  });
});

// 🔴 三样全局前提缺一样就 503 —— 而且响应与请求里是哪把公钥无关。
for (const [name, env, storeOpts] of [
  ['没配 tag 密钥', { GEOLY_TELEMETRY_DELETE_AUDIENCE: AUD }, {}],
  ['没配 audience', { GEOLY_TELEMETRY_TAG_SECRET: SECRET }, {}],
  ['库里的密钥指纹对不上（密钥被换过）', ENV, { keyIdOk: false }],
]) {
  test(`🔴 ${name} → 两个端点都 503 delete-unavailable，不降级、不碰删除`, async () => {
    const store = fakeStore(storeOpts);
    const k = freshKey();
    await withServer(store, async ({ post }) => {
      const nonce = Buffer.alloc(32, 2).toString('base64url');
      for (const [path, body] of [
        [DELETE_CHALLENGE_PATH, { schema: CHALLENGE_SCHEMA, pubkey: k.pubkey }],
        [DELETE_PATH, { schema: DELETE_SCHEMA, pubkey: k.pubkey, nonce, signature: sign(k, nonce) }],
      ]) {
        const r = await post(path, body);
        assert.equal(r.status, 503);
        assert.deepEqual(await r.json(), { error: 'delete-unavailable' });
      }
      assert.equal(store.calls.deletes.length, 0);
    }, env);
  });
}

test('文件版 store（不支持身份）→ 两个删除路由都是 404', async () => {
  const store = { put: async () => ({}), all: async () => [], rollup: async () => null };
  await withServer(store, async ({ post }) => {
    for (const path of [DELETE_CHALLENGE_PATH, DELETE_PATH]) {
      const r = await post(path, {});
      assert.equal(r.status, 404);
      assert.equal(r.headers.get('cache-control'), 'no-store', '「端点不存在」被缓存住，换了 store 之后代理还在回 404');
    }
  });
});

test('方法、content-type、坏 JSON、重复键、超限都挡在门口，且不回显输入', async () => {
  const store = fakeStore();
  await withServer(store, async ({ base, post }) => {
    const g = await fetch(base + DELETE_PATH);
    assert.equal(g.status, 405);
    assert.equal(g.headers.get('allow'), 'POST');
    assert.equal(g.headers.get('cache-control'), 'no-store');
    assert.equal((await post(DELETE_PATH, '{}', { 'content-type': 'text/plain' })).status, 415);

    const bad = await post(DELETE_CHALLENGE_PATH, '{"schema":');
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'malformed-json' });

    const dup = await post(DELETE_CHALLENGE_PATH, `{"schema":"${CHALLENGE_SCHEMA}","pubkey":"a","pubkey":"b"}`);
    assert.equal(dup.status, 400, '重复键必须拒 —— JSON.parse 会静默取最后一个');

    const marker = 'ECHO-MARKER-xyz';
    const echo = await post(DELETE_CHALLENGE_PATH, { schema: CHALLENGE_SCHEMA, pubkey: marker });
    assert.equal(echo.status, 400);
    assert.ok(!(await echo.text()).includes(marker), '响应回显了输入');

    const big = await post(DELETE_PATH, 'x'.repeat(MAX_DELETE_BODY_BYTES + 1));
    assert.equal(big.status, 413);
    assert.equal(store.calls.deletes.length, 0);
  });
});

test('🔴 挑战不看有没有数据、不写库：两把从没见过的公钥拿到同形状的响应', async () => {
  const store = fakeStore();
  await withServer(store, async ({ post }) => {
    const a = await challenge(post, freshKey());
    const b = await challenge(post, freshKey());
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    assert.notEqual(a.nonce, b.nonce, 'nonce 必须每次新生成');
    assert.equal(store.calls.deletes.length, 0, '发挑战碰了删除路径');
  });
});

// ── 摄入面：真 HTTP 把公钥换成 tag 再交给 store（Codex 2026-09-13 P0-1）──────────

function identityEvent(pubkey) {
  return {
    schema: 'geoly.skills.telemetry/1',
    eid: '33333333-3333-4333-8333-333333333333',
    at: '2026-01-01T00:00:00Z',
    install_id: '44444444-4444-4444-8444-444444444444',
    cli: '0.3.7', os: 'darwin', arch: 'arm64', node: '22.13.0',
    kind: 'install', result: 'ok',
    os_user: 'zhang.wei', host: 'MBP-14-zw', notice: 'v2', pubkey,
  };
}

test('🔴 真 HTTP 摄入：交给 store 的身份行带 tag、没有公钥原文', async () => {
  const store = fakeStore();
  const k = freshKey();
  await withServer(store, async ({ post }) => {
    const r = await post(INGEST_PATH, { schema: BATCH_SCHEMA, events: [identityEvent(k.pubkey)] });
    assert.equal(r.status, 200);
    assert.equal(store.calls.puts.length, 1);
    const { events, identities } = store.calls.puts[0];
    assert.equal(identities.length, 1);
    assert.equal(identities[0].pubkey_tag, pubkeyTag(k.pubkey, SECRET));
    assert.ok(!JSON.stringify(store.calls.puts).includes(k.pubkey), '公钥原文进了 store');
    assert.ok(!JSON.stringify(events).includes('zhang.wei'), '身份进了匿名事件');
  }, { ...ENV, GEOLY_TELEMETRY_IDENTITY_INGEST: 'on' });
});

test('🔴 真 HTTP 摄入：密钥指纹对不上 → 身份行一条都不交给 store，匿名事件照收', async () => {
  const store = fakeStore({ keyIdOk: false });
  const k = freshKey();
  await withServer(store, async ({ post }) => {
    const r = await post(INGEST_PATH, { schema: BATCH_SCHEMA, events: [identityEvent(k.pubkey)] });
    assert.equal(r.status, 200);
    const { events, identities } = store.calls.puts[0];
    assert.equal(events.length, 1, '匿名事件必须照收');
    assert.deepEqual(identities, [], '换过密钥还在收身份 —— 墓碑和删除都认不出这批');
  }, { ...ENV, GEOLY_TELEMETRY_IDENTITY_INGEST: 'on' });
});
