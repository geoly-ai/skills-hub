// 上报端点（server/）—— 规格 docs/telemetry/00-spec.md §5。
//
// 🔴 这套测试的立场：**端点公开可访问、且按 §5.3 不做鉴权，所以每一条输入都当敌意的。**
//    「客户端已经校验过」在这里不是理由 —— 客户端根本不在我们手里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, INGEST_PATH, SUMMARY_PATH } from '../server/app.mjs';
import { openFileStore } from '../server/store.mjs';
import { MAX_BODY_BYTES, MAX_EVENTS, BATCH_SCHEMA } from '../server/validate.mjs';
import { buildEvent, serializeEvent, MAX_QUEUE_BYTES } from '../src/telemetry.mjs';

function ev(over = {}) {
  const base = buildEvent({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0', client: 'claude', ...over.build });
  return { ...base, ...over.raw };
}
const envelope = (events) => JSON.stringify({ schema: BATCH_SCHEMA, events });

/** 起一个真的 http server —— 请求体的字节闸、header、method 都只有真跑才算数 */
async function withServer(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tsrv-'));
  process.env.GEOLY_STATE_DIR = dir;          // buildEvent 要写 install-id
  const store = openFileStore(join(dir, 'data'), opts.storeOpts);
  const handler = createHandler({ store, ...opts });
  const server = createServer((q, s) => { handler(q, s).catch(() => s.destroy()); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(base + INGEST_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  });
  try {
    await fn({ base, post, store, dir: join(dir, 'data') });
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
}

// ── 正常路径 ─────────────────────────────────────────────────────────────────

test('合法批次被收下，ACK 的条数对得上', async () => {
  await withServer(async ({ post, store }) => {
    const r = await post(envelope([ev(), ev()]));
    assert.equal(r.status, 200);
    const ack = await r.json();
    assert.equal(ack.schema, 'geoly.skills.telemetry-ack/1');
    assert.deepEqual([ack.accepted, ack.duplicate, ack.rejected], [2, 0, 0]);
    assert.equal(store.all().length, 2);
  });
});

test('🔴 重复 eid 被去重 —— 跨请求（at-least-once 的重发正是这个形状）', async () => {
  await withServer(async ({ post, store }) => {
    const e = ev();
    assert.equal((await (await post(envelope([e]))).json()).accepted, 1);
    const again = await (await post(envelope([e]))).json();
    assert.deepEqual([again.accepted, again.duplicate], [0, 1]);
    assert.equal(store.all().length, 1, '重发不能在存储里留下第二条');
  });
});

test('🔴 重复 eid 被去重 —— 同一批内（不能等落盘之后才发现）', async () => {
  await withServer(async ({ post, store }) => {
    const e = ev();
    const ack = await (await post(envelope([e, e, ev()]))).json();
    assert.deepEqual([ack.accepted, ack.duplicate], [2, 1]);
    assert.equal(store.all().length, 2);
  });
});

test('🔴 重启后仍然认得旧 eid（去重索引是从盘上重建的）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsrv-'));
  process.env.GEOLY_STATE_DIR = dir;
  const data = join(dir, 'data');
  const e = ev();
  const first = openFileStore(data);
  try { first.put([e], 1_000); } finally { first.close(); }

  const reopened = openFileStore(data);
  try {
    assert.deepEqual(reopened.put([e], 2_000), { accepted: 0, duplicate: 1 });
    assert.equal(reopened.all().length, 1);
  } finally { reopened.close(); }
});

test('🔴 FileStore 单实例独占 —— 两个 worker 各持一份旧去重索引会各自收下同一个 eid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsrv-'));
  const data = join(dir, 'data');
  const held = openFileStore(data);
  try {
    assert.throws(() => openFileStore(data), /单实例/);
  } finally { held.close(); }
});

// ── 敌意输入 ─────────────────────────────────────────────────────────────────

test('🔴 多余字段被丢弃，事件本身照收（§5.3：不要信客户端）', async () => {
  await withServer(async ({ post, store, dir }) => {
    const ack = await (await post(envelope([ev({ raw: { secret: '/Users/alice/.ssh/id_rsa' } })]))).json();
    assert.equal(ack.accepted, 1);
    assert.equal(store.all()[0].event.secret, undefined);
    // 🔴 判据是**落盘的字节**，不是内存里的对象：存的是重新序列化过的形式，
    //    所以我们没打算收的东西不可能出现在文件里。
    const bytes = readFileSync(join(dir, 'events.ndjson'), 'utf8');
    assert.ok(!bytes.includes('alice'), bytes);
    assert.ok(!bytes.includes('secret'), bytes);
  });
});

test('🔴 __proto__ / constructor 当字段名：被丢弃，且不污染原型', async () => {
  await withServer(async ({ post, store }) => {
    // 手写 JSON：JSON.stringify 处理不了这种键的意图
    const e = ev();
    const body = `{"schema":"${BATCH_SCHEMA}","events":[${
      serializeEvent(e).replace(/^\{/, '{"__proto__":{"polluted":true},"constructor":"x",')
    }]}`;
    const ack = await (await post(body)).json();
    assert.equal(ack.accepted, 1);
    assert.equal({}.polluted, undefined, '原型被污染了');
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(store.all()[0].event.polluted, undefined);
  });
});

test('🔴 单条不合规只丢那一条，不退回整批（否则一条脏数据永久卡死一个客户端）', async () => {
  await withServer(async ({ post, store }) => {
    const bad = [
      ev({ raw: { reason: 'alice' } }),                       // reason 不在有限代码表里
      ev({ raw: { artifact: 'skill:g/a@1.0.0/../../etc' } }), // 坐标正则不认
      ev({ raw: { client: { path: '/Users/a' } } }),          // 值是对象
      ev({ raw: { at: '2026-09-01T10:00:00.123Z' } }),        // 带毫秒（可做指纹）
      ev({ raw: { install_id: 'not-a-uuid' } }),
      ev({ raw: { ms: -1 } }),
      null, 'nope', 42, [],
    ];
    const good = ev();
    const ack = await (await post(envelope([...bad, good]))).json();
    assert.equal(ack.accepted, 1);
    assert.equal(ack.rejected, bad.length);
    assert.equal(store.all()[0].event.eid, good.eid);
  });
});

test('🔴 信封坏 = 400（那说明来的根本不是我们的协议）', async () => {
  await withServer(async ({ post }) => {
    const cases = [
      ['malformed-json', '{oops'],
      ['envelope-not-object', '[]'],
      ['envelope-not-object', 'null'],
      ['envelope-unknown-key', `{"schema":"${BATCH_SCHEMA}","events":[],"extra":1}`],
      ['bad-schema', '{"schema":"geoly.skills.telemetry-batch/2","events":[]}'],
      ['bad-schema', '{"events":[]}'],
      ['events-not-array', `{"schema":"${BATCH_SCHEMA}","events":{}}`],
      ['events-empty', `{"schema":"${BATCH_SCHEMA}","events":[]}`],
    ];
    for (const [code, body] of cases) {
      const r = await post(body);
      assert.equal(r.status, 400, body);
      assert.equal((await r.json()).error, code, body);
    }
  });
});

test('🔴 重复 key 的 JSON 被拒 —— JSON.parse 会静默取最后一个，那是绕过按 key 校验的口子', async () => {
  await withServer(async ({ post }) => {
    // schema 解码后就是 schema：判据必须是**解码后**的 key
    const r = await post(`{"schema":"${BATCH_SCHEMA}","\\u0073chema":"evil","events":[]}`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'malformed-json');
  });
});

test('🔴 条数上限：一批塞几万个空对象也要在校验之前被挡下', async () => {
  await withServer(async ({ post }) => {
    const r = await post(`{"schema":"${BATCH_SCHEMA}","events":[${'{},'.repeat(MAX_EVENTS)}{}]}`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'too-many-events');
  });
});

test('🔴 超大 body：声明超限的一个字节都不缓冲，但仍然收得到 413（不是连接被重置）', async () => {
  await withServer(async ({ post }) => {
    const r = await post('x'.repeat(MAX_BODY_BYTES + 1));
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error, 'too-large');
  });
});

test('🔴 超大 body：chunked（没有 Content-Length）也要被字节计数挡下', async () => {
  await withServer(async ({ base }) => {
    // Content-Length 会撒谎，chunked 下压根没有这个头 —— 只信自己数的字节
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(`${base}${INGEST_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      const chunk = 'x'.repeat(64 * 1024);
      for (let n = 0; n < MAX_BODY_BYTES + chunk.length; n += chunk.length) req.write(chunk);
      req.end();
    });
    assert.equal(status, 413);
  });
});

test('🔴 body 上限必须容得下客户端的一整代队列，否则那批永久卡死', async () => {
  // 客户端一次 flush 发的是一整代（§5.2 消费式上报），一代上限 MAX_QUEUE_BYTES。
  // 端点的上限比它小 = 老实客户端被 413 顶回来、sending 原样留着、下轮接着发。
  assert.ok(MAX_BODY_BYTES > MAX_QUEUE_BYTES, '上限必须严格大于客户端单代队列上限');

  // 光比常数不够 —— 真发一批超过一代大小的合法事件过去，看端点收不收
  await withServer(async ({ post, store }) => {
    const one = serializeEvent(ev());
    const events = [];
    for (let n = 0; n <= MAX_QUEUE_BYTES; n += one.length + 1) {
      // 只换 eid：事件其余部分照旧合法，省掉几千次 buildEvent
      events.push(one.replace(/"eid":"[^"]+"/, `"eid":"${crypto.randomUUID()}"`));
    }
    const body = `{"schema":"${BATCH_SCHEMA}","events":[${events.join(',')}]}`;
    assert.ok(Buffer.byteLength(body) > MAX_QUEUE_BYTES, '前提：这一批确实超过了一代队列的大小');
    const r = await post(body);
    assert.equal(r.status, 200, `一整代队列被顶回来了（${r.status}）`);
    assert.equal((await r.json()).accepted, events.length);
    assert.equal(store.all().length, events.length);
  });
});

test('method / content-type / 路径：405 · 415 · 404', async () => {
  await withServer(async ({ base, post }) => {
    const get = await fetch(base + INGEST_PATH);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal((await post(envelope([ev()]), { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await fetch(`${base}/anything`)).status, 404);
    // 带参数的 content-type 要认
    assert.equal((await post(envelope([ev()]), { 'content-type': 'application/json; charset=utf-8' })).status, 200);
  });
});

test('🔴 响应不回显任何输入', async () => {
  await withServer(async ({ post }) => {
    const marker = 'skill:geoly/needle@9.9.9';
    const text = await (await post(envelope([ev({ build: { artifact: marker } })]))).text();
    assert.ok(!text.includes('needle'), `响应回显了输入：${text}`);
  });
});

// ── 资源上界（无鉴权 ≠ 接受被打满） ──────────────────────────────────────────

test('🔴 速率上限：超了回 429，而不是照单全收', async () => {
  await withServer(async ({ post }) => {
    const r1 = await post(envelope([ev()]));
    assert.equal(r1.status, 200);
    const r2 = await post(envelope([ev()]));
    assert.equal(r2.status, 429);
    assert.equal(r2.headers.get('retry-after'), '10');
  }, { ratePerSec: 1, now: () => 1_700_000_000_000 });   // 时钟不动 = 桶不回填
});

test('🔴 存储满：回 503，让客户端把这批留在本地（不是 200 假装收下）', async () => {
  await withServer(async ({ post, store }) => {
    assert.equal((await post(envelope([ev()]))).status, 200);
    const r = await post(envelope([ev()]));
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'store-full');
    assert.equal(store.all().length, 1, '满了就不能再写进去');
  }, { storeOpts: { maxRecords: 1 } });
});

test('🔴 prune 的水位必须是有限数值 —— 一个 NaN 就能把全部原始事件清空', async () => {
  await withServer(async ({ store }) => {
    store.put([ev()], 1_000);
    assert.throws(() => store.prune(NaN), /有限数值/);
    assert.throws(() => store.prune(Number('abc')), /有限数值/);   // 环境变量填错的形态
    assert.equal(store.all().length, 1, '挡下之后数据必须还在');
  });
});

test('🔴 被改过的 rollup 文件不能污染原型，也不能把脏键带进聚合', async () => {
  const { foldInto, summarize } = await import('../server/aggregate.mjs');
  const evil = {
    cutoff: 0, total: 1,
    byArtifact: {
      __proto__: { n: 1 },                                  // 会改原型的键
      'not a coordinate': { n: 5 },                          // 形状不对的键
      'skill:geoly/a@1.0.0': { n: 2, kinds: { evil: 9 }, results: { ok: -3 } },
    },
  };
  const folded = foldInto(evil, []);
  assert.equal({}.n, undefined, '原型被污染了');
  assert.equal(Object.hasOwn(folded.byArtifact, 'not a coordinate'), false);
  const row = folded.byArtifact['skill:geoly/a@1.0.0'];
  assert.equal(row.kinds.evil, undefined, '未知的 kind 不该被带进来');
  assert.equal(row.results.ok, 0, '负数计数要被归零');
  assert.equal(summarize([], folded).byArtifact.length, 1);
});

// ── 聚合与保留期 ─────────────────────────────────────────────────────────────

test('聚合：按 artifact 汇总次数与 result 分布', async () => {
  await withServer(async ({ base, post }) => {
    await post(envelope([
      ev({ build: { artifact: 'skill:geoly/a@1.0.0', kind: 'install', result: 'ok' } }),
      ev({ build: { artifact: 'skill:geoly/a@1.0.0', kind: 'check', result: 'failed' } }),
      ev({ build: { artifact: 'skill:geoly/b@2.0.0', kind: 'remove', result: 'ok' } }),
    ]));
    const r = await fetch(base + SUMMARY_PATH, { headers: { authorization: 'Bearer t0ken' } });
    const sum = await r.json();
    assert.equal(sum.total, 3);
    const a = sum.byArtifact.find((x) => x.artifact === 'skill:geoly/a@1.0.0');
    assert.equal(a.n, 2);
    assert.equal(a.kinds.install, 1);
    assert.equal(a.kinds.check, 1);
    assert.equal(a.results.ok, 1);
    assert.equal(a.results.failed, 1);
  }, { summaryToken: 't0ken' });
});

test('🔴 聚合面默认关闭；配了 token 也要认 token', async () => {
  await withServer(async ({ base }) => {
    // 摄入面无鉴权是 §5.3 明示接受的，**读出面不是** —— 忘了配 token
    // 不能变成"谁都能拉走全量聚合"
    assert.equal((await fetch(base + SUMMARY_PATH)).status, 404);
  });
  await withServer(async ({ base }) => {
    assert.equal((await fetch(base + SUMMARY_PATH)).status, 401);
    assert.equal((await fetch(base + SUMMARY_PATH, { headers: { authorization: 'Bearer nope' } })).status, 401);
  }, { summaryToken: 't0ken' });
});

test('🔴 保留期：原始事件被丢弃前先折进 rollup，且折算是幂等的', async () => {
  await withServer(async ({ store }) => {
    const old = ev();
    const recent = ev();
    store.put([old], 1_000);
    store.put([recent], 9_000);

    assert.equal(store.prune(5_000), 1, '只丢水位之前的');
    assert.equal(store.all().length, 1);
    assert.equal(store.rollup().total, 1);

    // 再 prune 一次同样的水位：不能把已经折算过的再数一遍
    assert.equal(store.prune(5_000), 0);
    assert.equal(store.rollup().total, 1);

    // 聚合查询要把 rollup 和还活着的事件加在一起，否则历史会凭空消失
    const { summarize } = await import('../server/aggregate.mjs');
    assert.equal(summarize(store.all().map((r) => r.event), store.rollup()).total, 2);
  });
});

// 🔴 保留期环境变量填错时 **503 而不是回落到 180**。
//    `Number('180 days')` 是 NaN，一路传下去就是一个写坏 rollup 水位的输入；
//    而回落到默认值同样不对 —— 那会让一次「以为改成 30 天了」的部署静默按 180 天跑。
test('🔴 GEOLY_TELEMETRY_RETENTION_DAYS 读不出整数就 fail-closed', async () => {
  const { retentionDays } = await import('../server/api/prune.js');
  const saved = process.env.GEOLY_TELEMETRY_RETENTION_DAYS;
  try {
    delete process.env.GEOLY_TELEMETRY_RETENTION_DAYS;
    assert.equal(retentionDays(), 180, '没配时用默认 180');
    for (const bad of ['180 days', 'abc', '0', '-1', '1.5', '4000', '']) {
      process.env.GEOLY_TELEMETRY_RETENTION_DAYS = bad;
      const got = retentionDays();
      if (bad === '') { assert.equal(got, 180, '空串按没配处理'); continue; }
      assert.equal(got, null, `${JSON.stringify(bad)} 必须被拒，实际拿到 ${got}`);
    }
    process.env.GEOLY_TELEMETRY_RETENTION_DAYS = '90';
    assert.equal(retentionDays(), 90);
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TELEMETRY_RETENTION_DAYS;
    else process.env.GEOLY_TELEMETRY_RETENTION_DAYS = saved;
  }
});

// ── 摄入层的身份拆分（2026-09-09）───────────────────────────────────────────
//
// 🔴 这一组钉的是 Codex 在方案评审里列的第一个阻断项：
//    「身份字段会直接进 telemetry_events.ev」。判据必须是**存进去的字节里没有它**，
//    不是「下游不会用到它」。

function idEvent(extra = {}) {
  return {
    schema: 'geoly.skills.telemetry/1',
    eid: '11111111-1111-4111-8111-111111111111',
    at: '2026-01-01T00:00:00Z',
    install_id: '22222222-2222-4222-8222-222222222222',
    cli: '0.3.7', os: 'darwin', arch: 'arm64', node: '22.13.0',
    kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0',
    os_user: 'zhang.wei', host: 'MBP-14-zw', notice: 'v2',
    ...extra,
  };
}
const batchOf = (...evs) => JSON.stringify({
  schema: 'geoly.skills.telemetry-batch/1', events: evs,
});

test('🔴 匿名事件里一个身份字段都没有 —— 判据是序列化后的字节', async () => {
  const { parseBatch } = await import('../server/validate.mjs');
  const { events } = parseBatch(batchOf(idEvent()));
  assert.equal(events.length, 1);
  for (const k of ['os_user', 'host', 'notice']) {
    assert.ok(!Object.hasOwn(events[0], k), `匿名事件里混进了 ${k}`);
  }
  // 存进 jsonb 的就是这个对象，所以直接看它的 JSON 文本
  const text = JSON.stringify(events[0]);
  assert.ok(!text.includes('zhang.wei'), '用户名进了匿名事件的字节');
  assert.ok(!text.includes('MBP-14-zw'), '主机名进了匿名事件的字节');
  assert.equal(events[0].artifact, 'skill:geoly/a@1.0.0', '匿名字段不该受影响');
});

test('🔴 服务端身份采集默认关：拆出来但当场丢掉，匿名事件照收', async () => {
  const saved = process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
  delete process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
  try {
    const { parseBatch } = await import('../server/validate.mjs');
    const r = parseBatch(batchOf(idEvent()));
    assert.equal(r.identities.length, 0, '开关没开却存下了身份行');
    assert.equal(r.identityDropped, 1, '丢了要计数，否则没人知道在丢');
    assert.equal(r.events.length, 1, '丢身份不该影响匿名计数');
    assert.equal(r.rejected, 0, '丢身份不是「拒收事件」');
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
    else process.env.GEOLY_TELEMETRY_IDENTITY_INGEST = saved;
  }
});

test('打开 kill switch 后身份行才出现，且只带 eid 与身份三项', async () => {
  const saved = process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
  process.env.GEOLY_TELEMETRY_IDENTITY_INGEST = 'on';
  try {
    const { parseBatch } = await import('../server/validate.mjs');
    const { identities } = parseBatch(batchOf(idEvent()));
    assert.equal(identities.length, 1);
    const row = identities[0];
    assert.equal(row.eid, '11111111-1111-4111-8111-111111111111');
    assert.equal(row.os_user, 'zhang.wei');
    assert.equal(row.host, 'MBP-14-zw');
    assert.equal(row.notice, 'v2');
    // 🔴 身份行里不许重复存匿名字段：抄第二份 = 删的时候必然漏一份
    assert.equal(row.install_id, undefined);
    assert.equal(row.artifact, undefined);
    assert.equal(row.at, undefined);
    assert.deepEqual(Object.keys(row).sort(), ['eid', 'host', 'notice', 'os_user']);
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
    else process.env.GEOLY_TELEMETRY_IDENTITY_INGEST = saved;
  }
});

test('没有身份字段的事件不产生身份行（也不算 dropped）', async () => {
  const saved = process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
  process.env.GEOLY_TELEMETRY_IDENTITY_INGEST = 'on';
  try {
    const { parseBatch } = await import('../server/validate.mjs');
    const plain = idEvent();
    delete plain.os_user; delete plain.host; delete plain.notice;
    const r = parseBatch(batchOf(plain));
    assert.equal(r.events.length, 1);
    assert.equal(r.identities.length, 0);
    assert.equal(r.identityDropped, 0);
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
    else process.env.GEOLY_TELEMETRY_IDENTITY_INGEST = saved;
  }
});

test('🔴 只发了身份字段、匿名部分不合规 → 整条拒，身份也不留', async () => {
  const saved = process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
  process.env.GEOLY_TELEMETRY_IDENTITY_INGEST = 'on';
  try {
    const { parseBatch } = await import('../server/validate.mjs');
    const bad = idEvent({ kind: 'not-a-kind' });
    const r = parseBatch(batchOf(bad));
    assert.equal(r.rejected, 1);
    assert.equal(r.events.length, 0);
    assert.equal(r.identities.length, 0, '事件被拒了，身份行不该独活 —— 它靠 eid 挂在事件上');
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
    else process.env.GEOLY_TELEMETRY_IDENTITY_INGEST = saved;
  }
});

// ── IP 观测（2026-09-09）───────────────────────────────────────────────────
//
// 🔴 这一组钉的是「没有可信代理配置时不存 IP」—— Codex 把「取最左一跳」
//    列为阻断项：直连打端点时整串 XFF 都是攻击者写的，
//    而一个填错的 IP 比没有 IP 更糟，因为它看起来像证据。

// 这批钉的是「取哪一格、非法值怎么办」，所以统一声明平台可信；
// 对端认证本身由下面另一组测试钉。
const reqWith = (xff) => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
function trustPlatform() { process.env.GEOLY_TRUSTED_PROXY_PLATFORM = 'vercel'; }
function untrustPlatform() { delete process.env.GEOLY_TRUSTED_PROXY_PLATFORM; }

test('🔴 没配信任跳数 → 一律 null，不猜', async () => {
  const { clientIp } = await import('../server/app.mjs');
  const saved = process.env.GEOLY_TRUSTED_PROXY_HOPS;
  delete process.env.GEOLY_TRUSTED_PROXY_HOPS;
  try {
    assert.equal(clientIp(reqWith('203.0.113.9')), null);
    assert.equal(clientIp(reqWith('203.0.113.9, 10.0.0.1')), null);
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TRUSTED_PROXY_HOPS;
    else process.env.GEOLY_TRUSTED_PROXY_HOPS = saved;
    untrustPlatform();
  }
});

test('🔴 从右往左数第 N 跳，不是最左那一跳', async () => {
  const { clientIp } = await import('../server/app.mjs');
  const saved = process.env.GEOLY_TRUSTED_PROXY_HOPS;
  try {
    // 客户端自己塞了两个假的，我们的代理在右边追加了真的那一个
    process.env.GEOLY_TRUSTED_PROXY_HOPS = '1';
    trustPlatform();
    assert.equal(
      clientIp(reqWith('1.2.3.4, 5.6.7.8, 203.0.113.9')), '203.0.113.9',
      '取了最左那一跳 —— 那是攻击者写的',
    );
    // 两层代理：真客户端在倒数第二个
    process.env.GEOLY_TRUSTED_PROXY_HOPS = '2';
    trustPlatform();
    assert.equal(clientIp(reqWith('1.2.3.4, 203.0.113.9, 10.0.0.1')), '203.0.113.9');
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TRUSTED_PROXY_HOPS;
    else process.env.GEOLY_TRUSTED_PROXY_HOPS = saved;
    untrustPlatform();
  }
});

test('🔴 链子比信任跳数短 → null（这个请求没走我们以为的那些代理）', async () => {
  const { clientIp } = await import('../server/app.mjs');
  const saved = process.env.GEOLY_TRUSTED_PROXY_HOPS;
  process.env.GEOLY_TRUSTED_PROXY_HOPS = '2';
  trustPlatform();
  try {
    assert.equal(clientIp(reqWith('203.0.113.9')), null);
    assert.equal(clientIp(reqWith('')), null);
    assert.equal(clientIp(reqWith(undefined)), null);
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TRUSTED_PROXY_HOPS;
    else process.env.GEOLY_TRUSTED_PROXY_HOPS = saved;
    untrustPlatform();
  }
});

test('🔴 非法值一律 null；IPv4-mapped IPv6 要归一', async () => {
  const { clientIp } = await import('../server/app.mjs');
  const saved = process.env.GEOLY_TRUSTED_PROXY_HOPS;
  process.env.GEOLY_TRUSTED_PROXY_HOPS = '1';
  trustPlatform();
  try {
    assert.equal(clientIp(reqWith('not-an-ip')), null);
    assert.equal(clientIp(reqWith('999.999.999.999')), null);
    assert.equal(clientIp(reqWith('10.8.14.62; DROP TABLE')), null);
    // ::ffff:10.8.14.62 与 10.8.14.62 是同一台机器，不归一会在归属页排成两行
    assert.equal(clientIp(reqWith('::ffff:10.8.14.62')), '10.8.14.62');
    assert.equal(clientIp(reqWith('2001:db8::1')), '2001:db8::1');
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TRUSTED_PROXY_HOPS;
    else process.env.GEOLY_TRUSTED_PROXY_HOPS = saved;
    untrustPlatform();
  }
});

test('🔴 信任跳数本身填错 → null，不回落到 1', async () => {
  const { clientIp } = await import('../server/app.mjs');
  const saved = process.env.GEOLY_TRUSTED_PROXY_HOPS;
  try {
    for (const bad of ['0', '-1', '1.5', 'abc', '99', '']) {
      process.env.GEOLY_TRUSTED_PROXY_HOPS = bad;
      trustPlatform();
      assert.equal(clientIp(reqWith('203.0.113.9')), null, `${JSON.stringify(bad)} 不该被当成有效配置`);
    }
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TRUSTED_PROXY_HOPS;
    else process.env.GEOLY_TRUSTED_PROXY_HOPS = saved;
    untrustPlatform();
  }
});

test('🔴 端点至今不读 user-agent —— 加 IP 不等于放开了这一段', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/app.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/user-agent/i.test(src), 'app.mjs 里出现了 user-agent');
  // 🔴 `remoteAddress` **只允许出现一次**，就是 clientIp() 里那次对端比对。
  //    §5.3 的「不记 IP」说的是不记录，不是不能看一眼判断可信度；
  //    但多出来的每一次引用都是它流向别处的入口，所以这里按次数钉死。
  const hits = src.match(/remoteAddress/g) ?? [];
  assert.equal(hits.length, 1, `remoteAddress 出现了 ${hits.length} 次，只允许 clientIp() 里那一次`);
  const inClientIp = src.slice(src.indexOf('export function clientIp'),
    src.indexOf('function jsonContentType'));
  assert.match(inClientIp, /remoteAddress/, '那一次必须在 clientIp() 里');
});

test('🔴 对端地址只用来判断可信，绝不当成结果返回', async () => {
  const { clientIp } = await import('../server/app.mjs');
  withEnv({ GEOLY_TRUSTED_PROXY_HOPS: '1', GEOLY_TRUSTED_PROXY_PEERS: '10.0.0.2' }, () => {
    // 代理的地址是 10.0.0.2，客户端是 203.0.113.9 —— 回来的必须是后者
    assert.equal(clientIp(reqFrom('203.0.113.9', '10.0.0.2')), '203.0.113.9');
    // XFF 缺失时不能拿对端地址顶上
    assert.equal(clientIp(reqFrom(undefined, '10.0.0.2')), null);
  });
});

// 🔴 这条早先只 grep 源码，等于「文本里有这个词」就算过 —— 空转
//    （Codex 2026-09-09 指出）。改成**真的调 handler**，看它回什么状态码。
function fakeRes() {
  const r = { statusCode: 0, body: '', headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = b ?? ''; return r; };
  return r;
}
const cronReq = (secret) => ({ headers: { authorization: `Bearer ${secret}` }, method: 'POST' });

async function runPrune(env) {
  const keys = ['CRON_SECRET', 'GEOLY_TELEMETRY_RETENTION_DAYS',
    'GEOLY_TELEMETRY_IDENTITY_RETENTION_DAYS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const mod = await import('../server/api/prune.js');
    const res = fakeRes();
    await mod.default(cronReq(env.CRON_SECRET ?? 'x'), res);
    return res;
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('🔴 保留期填错 → handler 回 503，不是回落到默认值', async () => {
  const res = await runPrune({ CRON_SECRET: 's', GEOLY_TELEMETRY_RETENTION_DAYS: '180 days' });
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /retention_days_invalid/);
});

test('🔴 身份保留期填错 → 同样 503', async () => {
  const res = await runPrune({
    CRON_SECRET: 's', GEOLY_TELEMETRY_IDENTITY_RETENTION_DAYS: 'abc',
  });
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /retention_days_invalid/);
});

test('🔴 身份保留期长过事件保留期 → 503（配反了没有任何迹象）', async () => {
  const res = await runPrune({
    CRON_SECRET: 's',
    GEOLY_TELEMETRY_RETENTION_DAYS: '30',
    GEOLY_TELEMETRY_IDENTITY_RETENTION_DAYS: '90',
  });
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /identity_retention_longer_than_events/);
});

test('没配 CRON_SECRET → 503，不是放行', async () => {
  const res = await runPrune({});
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /cron_secret_not_configured/);
});

test('secret 不对 → 401', async () => {
  const keys = ['CRON_SECRET'];
  const saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'right';
  try {
    const mod = await import('../server/api/prune.js');
    const res = fakeRes();
    await mod.default(cronReq('wrong'), res);
    assert.equal(res.statusCode, 401);
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
    void keys;
  }
});

test('默认配置本身是合法的：身份 90 短于事件 180', async () => {
  const { retentionDays } = await import('../server/api/prune.js');
  const saved = process.env.GEOLY_TELEMETRY_RETENTION_DAYS;
  delete process.env.GEOLY_TELEMETRY_RETENTION_DAYS;
  try {
    assert.equal(retentionDays(), 180);
  } finally {
    if (saved !== undefined) process.env.GEOLY_TELEMETRY_RETENTION_DAYS = saved;
  }
});

test('🔴 文件版 store 收到身份行要报错，不是悄悄丢掉', async () => {
  const { openFileStore } = await import("../server/store.mjs");
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const dir = mkdtempSync(j(tmpdir(), 'ts-'));
  const store = openFileStore(dir);
  try {
    assert.throws(
      () => store.put([{ eid: 'a' }], Date.now(), [{ eid: 'a', os_user: 'x' }]),
      /不支持身份行/,
    );
  } finally { store.close?.(); }
});

// ── clientIp 的对端认证（Codex 2026-09-09 的 P0）─────────────────────────────
//
// 🔴 只按 XFF 取值 = 整条链路没有认证：任何能直连源站的人发一个
//    `X-Forwarded-For: 受害者 IP` 就会被记成受害者。

const reqFrom = (xff, peer) => ({
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  socket: peer === undefined ? undefined : { remoteAddress: peer },
});

function withEnv(env, fn) {
  const keys = ['GEOLY_TRUSTED_PROXY_HOPS', 'GEOLY_TRUSTED_PROXY_PEERS',
    'GEOLY_TRUSTED_PROXY_PLATFORM'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('🔴 只配了跳数、没说清链路可信 → 一律 null（默认 fail-closed）', async () => {
  const { clientIp } = await import('../server/app.mjs');
  withEnv({ GEOLY_TRUSTED_PROXY_HOPS: '1' }, () => {
    assert.equal(clientIp(reqFrom('203.0.113.9', '198.51.100.7')), null,
      '没有任何对端认证就采信了 XFF —— 直连的人可以随便填');
  });
});

test('🔴 配了对端白名单：对端不匹配就 null，匹配才取', async () => {
  const { clientIp } = await import('../server/app.mjs');
  withEnv({ GEOLY_TRUSTED_PROXY_HOPS: '1', GEOLY_TRUSTED_PROXY_PEERS: '10.0.0.2, 10.0.0.3' }, () => {
    // 攻击者直连，自己塞了一个受害者 IP
    assert.equal(clientIp(reqFrom('203.0.113.9', '198.51.100.7')), null);
    // 从我们自己的代理来
    assert.equal(clientIp(reqFrom('203.0.113.9', '10.0.0.2')), '203.0.113.9');
    // 对端也可能是 IPv4-mapped 形式
    assert.equal(clientIp(reqFrom('203.0.113.9', '::ffff:10.0.0.3')), '203.0.113.9');
    // 没有 socket 信息 = 无从判断 = 不采信
    assert.equal(clientIp(reqFrom('203.0.113.9', undefined)), null);
  });
});

test('平台声明（vercel）下才回落到「边缘覆写 XFF」这条假设', async () => {
  const { clientIp } = await import('../server/app.mjs');
  withEnv({ GEOLY_TRUSTED_PROXY_HOPS: '1', GEOLY_TRUSTED_PROXY_PLATFORM: 'vercel' }, () => {
    assert.equal(clientIp(reqFrom('203.0.113.9', '198.51.100.7')), '203.0.113.9');
  });
  // 别的值不算数 —— 这是一句显式断言，不是一个可以随便填的开关
  withEnv({ GEOLY_TRUSTED_PROXY_HOPS: '1', GEOLY_TRUSTED_PROXY_PLATFORM: 'yes' }, () => {
    assert.equal(clientIp(reqFrom('203.0.113.9', '198.51.100.7')), null);
  });
});

test('🔴 取的是 len-hops 那一格：hops=1 取末格，hops=2 取倒数第二格', async () => {
  const { clientIp } = await import('../server/app.mjs');
  // 推导见 clientIp 的注释：每一跳代理追加它的**对端**，不追加自己。
  // 一层代理时，末格就是它的对端 = 客户端真实 IP。
  withEnv({ GEOLY_TRUSTED_PROXY_HOPS: '1', GEOLY_TRUSTED_PROXY_PLATFORM: 'vercel' }, () => {
    assert.equal(clientIp(reqFrom('1.2.3.4, 5.6.7.8, 203.0.113.9')), '203.0.113.9');
  });
  // 两层代理时，最外层追加的是内层代理的地址，客户端退到倒数第二格。
  withEnv({ GEOLY_TRUSTED_PROXY_HOPS: '2', GEOLY_TRUSTED_PROXY_PLATFORM: 'vercel' }, () => {
    assert.equal(clientIp(reqFrom('1.2.3.4, 203.0.113.9, 10.0.0.1')), '203.0.113.9');
  });
});

test('🔴 没有当前版本 notice 的事件不产生身份行（协议见证要真的检查）', async () => {
  const saved = process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
  process.env.GEOLY_TELEMETRY_IDENTITY_INGEST = 'on';
  try {
    const { parseBatch, splitIdentity } = await import('../server/validate.mjs');
    const noNotice = idEvent(); delete noNotice.notice;
    assert.equal(splitIdentity(noNotice), null, '手工构造一个不带 notice 的事件就绕过去了');
    const r = parseBatch(batchOf(noNotice));
    assert.equal(r.identities.length, 0);
    assert.equal(r.events.length, 1, '匿名事件照收');

    // 只有 notice、没有真正的身份内容 —— 不算身份行
    const onlyNotice = idEvent(); delete onlyNotice.os_user; delete onlyNotice.host;
    assert.equal(splitIdentity(onlyNotice), null);
  } finally {
    if (saved === undefined) delete process.env.GEOLY_TELEMETRY_IDENTITY_INGEST;
    else process.env.GEOLY_TELEMETRY_IDENTITY_INGEST = saved;
  }
});
