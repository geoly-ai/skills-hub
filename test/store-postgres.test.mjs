// Postgres store 的单测 —— 用一个**忠实于真实驱动形状**的假 sql。
//
// ⚠️ 上一版的教训（Codex 2026-09-01）：假 sql 直接消费 JS 数组，于是
//    `unnest` 的参数写法错了也测不出来 —— 真库上非空 put() 直接 500。
//    所以这里的假 sql **不解释 SQL 语义**，只记录「传进来的参数长什么样」，
//    并让测试断言那些参数是**驱动能接受的形状**（JSON 字符串而不是数组）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPostgresStore, MAX_SCAN_ROWS, StoreUnavailableError } from '../server/store-postgres.mjs';

/** 造一个模板标签函数；`plan` 决定每次调用返回什么。 */
function fakeSql(plan = []) {
  const calls = [];
  const sql = (strings, ...args) => {
    const text = strings.join('?');
    calls.push({ text, args });
    const next = plan.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? []);
  };
  sql.begin = async (fn) => fn(sql);
  sql.calls = calls;
  return sql;
}

test('put 空数组不打库', async () => {
  const sql = fakeSql();
  const r = await openPostgresStore(sql).put([], Date.now());
  assert.deepEqual(r, { accepted: 0, duplicate: 0 });
  assert.equal(sql.calls.length, 0);
});

// 🔴 **这条是为上一版那个 P0 设的。** 参数必须是**一个 JSON 字符串**，
//    不是 JS 数组 —— 数组走 unnest 的路上参数类型推断会出错，真库上直接 500，
//    而「假 sql 直接消费数组」的测试完全看不出来。
test('🔴 events 以单个 JSON 字符串传参（不是 JS 数组）', async () => {
  const sql = fakeSql([[], [{ eid: 'a' }]]);
  await openPostgresStore(sql).put([{ eid: 'a', kind: 'install' }], 1_700_000_000_000);
  const insert = sql.calls.find((c) => c.text.includes('insert into telemetry_events'));
  assert.ok(insert, '没发出 insert');
  const jsonArg = insert.args.find((a) => typeof a === 'string' && a.startsWith('['));
  assert.ok(jsonArg, `参数里没有 JSON 字符串，实际：${insert.args.map((a) => typeof a).join(', ')}`);
  assert.deepEqual(JSON.parse(jsonArg)[0].eid, 'a');

  // 🔴 **光是「参数是 JSON 字符串」还不够 —— cast 也得对。**
  //    实测（真库 2026-09-02）：`${json}::jsonb` 被当成 JSON 字符串**标量**，
  //    报 `cannot extract elements from a scalar`；必须先过 `::text`。
  //    ⚠️ 这正是 Codex 警告过的那类：**假 sql 看不见 cast**。
  //    所以这里退而求其次，断言 SQL 文本里真的写了 `::text::jsonb`。
  assert.match(insert.text, /::text::jsonb/,
    'jsonb 参数必须写成 `::text::jsonb` —— 只写 `::jsonb` 会被当成标量');
});

// 🔴 去重靠**数据库唯一索引**，不是进程内存 —— 这是它比文件版强的地方。
test('🔴 accepted 取 RETURNING 的行数，重复的算 duplicate', async () => {
  // 三条进去，数据库只回两条 → 一条是重复
  const sql = fakeSql([[], [{ eid: 'a' }, { eid: 'b' }]]);
  const r = await openPostgresStore(sql).put(
    [{ eid: 'a' }, { eid: 'b' }, { eid: 'a' }], Date.now(),
  );
  assert.deepEqual(r, { accepted: 2, duplicate: 1 });
});

test('🔴 每个写事务显式 set local synchronous_commit = on', async () => {
  const sql = fakeSql([[], [{ eid: 'a' }]]);
  await openPostgresStore(sql).put([{ eid: 'a' }], Date.now());
  assert.ok(sql.calls.some((c) => c.text.includes('synchronous_commit')),
    '没有钉死 synchronous_commit —— 连接级默认值可能被别处改掉');
});

// 🔴 截断的聚合看起来正常但少算，而且没有任何迹象。宁可报错。
test('🔴 all() 超过上界时报错，不返回截断的结果', async () => {
  const rows = Array.from({ length: MAX_SCAN_ROWS + 1 }, (_, i) => ({ ev: { eid: String(i) } }));
  const store = openPostgresStore(fakeSql([rows]));
  await assert.rejects(() => store.all(), /E_STORE_TOO_MANY_ROWS|超过/);
});

test('all() 在上界内正常返回', async () => {
  const store = openPostgresStore(fakeSql([[{ ev: { eid: 'x' } }]]));
  assert.deepEqual(await store.all(), [{ eid: 'x' }]);
});

// 🔴 数据库不可用**不能**掉进「当成空库」——那会绕过全部准入控制。
test('🔴 数据库出错 → StoreUnavailableError，不是空结果', async () => {
  const store = openPostgresStore(fakeSql([new Error('boom')]));
  await assert.rejects(() => store.all(), (e) => e instanceof StoreUnavailableError);
});

test('rollup 表为空时给 emptyRollup，不是 undefined', async () => {
  const r = await openPostgresStore(fakeSql([[]])).rollup();
  assert.equal(typeof r, 'object');
  assert.ok(r !== null);
});
