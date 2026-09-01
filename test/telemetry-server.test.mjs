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
