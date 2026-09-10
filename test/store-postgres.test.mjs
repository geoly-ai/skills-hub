// Postgres store 的单测 —— 用一个**忠实于真实驱动形状**的假 sql。
//
// ⚠️ 上一版的教训（Codex 2026-09-01）：假 sql 直接消费 JS 数组，于是
//    `unnest` 的参数写法错了也测不出来 —— 真库上非空 put() 直接 500。
//    所以这里的假 sql **不解释 SQL 语义**，只记录「传进来的参数长什么样」，
//    并让测试断言那些参数是**驱动能接受的形状**（JSON 字符串而不是数组）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openPostgresStore, MAX_SCAN_ROWS, StoreUnavailableError } from '../server/store-postgres.mjs';

/** 造一个模板标签函数；`plan` 决定每次调用返回什么。 */
function fakeSql(plan = [], tombstoned = []) {
  const calls = [];
  const sql = (strings, ...args) => {
    const text = strings.join('?');
    calls.push({ text, args });
    // 🔴 **基础设施语句自动应答，不消耗 plan。**
    //    advisory lock 与查墓碑是 2026-09-10 才加进摄入路径的；假 sql 原本
    //    严格按调用顺序发结果，于是「加了两条查询」把所有既有测试的计划整个冲乱。
    //    ⚠️ 这不是把测试改松：这两条的**返回值**不参与任何断言
    //    （锁没有返回值；墓碑为空是默认情形，非空的那一支由专门的测试用
    //    `tombstoned` 显式打开）。真正被断言的仍然是插入语句的参数与顺序。
    if (/pg_advisory_xact_lock/.test(text)) return Promise.resolve([]);
    if (/from telemetry_delete_tombstone/.test(text)) {
      return Promise.resolve(tombstoned.map((t) => ({ pubkey_tag: t })));
    }
    const next = plan.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? []);
  };
  // 🔴 记录事务边界。上一版的 fake `begin()` 直接把同一个 sql 传下去，
  //    于是「两条 insert 在不在同一个事务里」根本测不出来 —— 拆成两个事务
  //    照样绿（Codex 2026-09-09 指出）。这里在前后各记一个标记，
  //    测试就能断言两条 insert 落在同一对标记之间。
  sql.begin = async (fn) => {
    calls.push({ text: '<<BEGIN>>', args: [] });
    try {
      return await fn(sql);
    } finally {
      calls.push({ text: '<<COMMIT>>', args: [] });
    }
  };
  sql.calls = calls;
  return sql;
}

test('put 空数组不打库', async () => {
  const sql = fakeSql();
  const r = await openPostgresStore(sql).put([], Date.now());
  assert.deepEqual(r, { accepted: 0, duplicate: 0, identities: 0 });
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
  assert.deepEqual(r, { accepted: 2, duplicate: 1, identities: 0 });
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

// 🔴 **契约是 `Array<{ received_at, event }>`，不是裸事件**（store.mjs 顶部的
//    interface 注释）。第一版返回了裸事件，于是 app.mjs 的
//    `records.filter(r => r.received_at >= cutoff)` 里 `undefined >= 0` 恒假 ——
//    **每一行都被滤掉，/v1/summary 永远回 total: 0**，而 put() 明明在 accepted。
//    ⚠️ 而当时这条测试断言的是**错的契约**，所以它一路绿着。
//    **测试写错契约时，它守的就是那个错的契约。**
test('🔴 all() 返回 { received_at, event } 包装，不是裸事件', async () => {
  const store = openPostgresStore(fakeSql([[{ ev: { eid: 'x' }, received_ms: '1700000000000' }]]));
  const got = await store.all();
  assert.deepEqual(got, [{ received_at: 1_700_000_000_000, event: { eid: 'x' } }]);
  // received_at 必须是 number —— pg 的 bigint 默认回字符串，而 `'…' >= 0` 是 true，
  // 那会让过滤"碰巧能用"却在别处出错。
  assert.equal(typeof got[0].received_at, 'number');
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

// 🔴 **prune 必须把折算结果写回去。**（Codex 2026-09-09 在身份字段评审里翻出来的）
//    `foldInto` 是纯函数、返回新对象；这里早先写成 `foldInto(roll, …)` 丢掉返回值，
//    再把**没折算过**的 roll 写回：水位照推、计数一条不涨，被删掉的事件从历史里
//    彻底消失，而且**不报错、不掉测试**。文件版 store.mjs 一直是对的，只有这条路径漏了。
//    ⚠️ 它平时看不出来：live 事件还在库里时页面数字是对的，只有**过了保留期**才露馅。
test('🔴 prune 把 foldInto 的返回值写回 rollup（不是丢掉返回值写回原对象）', async () => {
  const ev = (eid) => ({
    schema: 'geoly.skills.telemetry/1', eid, at: '2026-01-01T00:00:00Z',
    install_id: '00000000-0000-4000-8000-000000000000', cli: '0.1.0',
    os: 'darwin', arch: 'arm64', node: '22.13.0',
    kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0',
  });
  const sql = fakeSql([
    [],                                   // set local synchronous_commit
    [{ doc: { schema: 'geoly.skills.telemetry-rollup/1', cutoff: 0, total: 0, byArtifact: {} } }],
    [{ ev: ev('e1') }, { ev: ev('e2') }], // doomed
    [],                                   // insert rollup
    [1, 1],                               // delete returning
  ]);
  const r = await openPostgresStore(sql).prune(180, 1_800_000_000_000);
  assert.deepEqual(r, { folded: 2, deleted: 2 });

  const ins = sql.calls.find((c) => c.text.includes('insert into telemetry_rollup'));
  assert.ok(ins, '没发出 rollup upsert');
  const doc = JSON.parse(ins.args.find((a) => typeof a === 'string' && a.startsWith('{')));
  assert.equal(doc.total, 2, '折算后的总数没写回去 —— 被删掉的事件从历史里消失了');
  assert.equal(doc.byArtifact['skill:geoly/a@1.0.0']?.n, 2, '按制品的计数没写回去');
  assert.equal(doc.cutoff, 1_800_000_000_000 - 180 * 86_400_000, '水位没推');
});

// 🔴 与文件版同一道闸 —— Postgres 这条路径早先没有。
test('🔴 prune 的水位不是有限数值时抛错，不写坏 rollup', async () => {
  const store = openPostgresStore(fakeSql());
  await assert.rejects(() => store.prune(NaN), /有限数值/);
  await assert.rejects(() => store.prune(Number('180 days')), /有限数值/);
});

// ── 身份行（2026-09-09）──────────────────────────────────────────────────
test('🔴 身份行与事件在同一个事务里写，且 eid 冲突时 do nothing', async () => {
  const sql = fakeSql([[], [{ eid: 'a' }]]);
  const r = await openPostgresStore(sql).put(
    [{ eid: 'a', kind: 'install' }], 1_700_000_000_000,
    [{ eid: 'a', os_user: 'zhang.wei', host: 'MBP-14-zw', notice: 'v2' }],
    '10.8.14.62',
  );
  assert.equal(r.identities, 1);
  const ins = sql.calls.find((c) => c.text.includes('insert into telemetry_identity'));
  assert.ok(ins, '没发出身份行 insert');
  assert.match(ins.text, /::text::jsonb/, '与事件同一条纪律：先过 ::text 再 ::jsonb');
  assert.match(ins.text, /on conflict \(eid\) do nothing/, '重发一批不该覆盖已存的身份');
  assert.match(ins.text, /::inet/, 'ip 必须按 inet 存，不是自由文本');
  // 🔴 同一个事务：两条 insert 之间**不能有** COMMIT/BEGIN。
  //    判据是事务标记的位置，不是「谁先谁后」—— 后者拆成两个事务照样成立。
  const idxEvents = sql.calls.findIndex((c) => c.text.includes('insert into telemetry_events'));
  const idxId = sql.calls.findIndex((c) => c.text.includes('insert into telemetry_identity'));
  assert.ok(idxEvents >= 0 && idxId > idxEvents, '身份行必须在事件之后');
  const between = sql.calls.slice(idxEvents, idxId).map((c) => c.text);
  assert.ok(!between.includes('<<COMMIT>>'), '两条 insert 之间提交了 —— 不是同一个事务');
  assert.ok(!between.includes('<<BEGIN>>'), '两条 insert 之间又开了一个事务');
});

// 🔴 事件是旧的（eid 冲突没插进去）时，身份行**不许补写**。
//    形态：一台机器今天开了身份、重发了半年前的队列 ——
//    半年前那些事件会被补上今天观测到的 IP 与用户名。
//    上一版只靠 `on conflict (eid) do nothing` 兜底，那句挡的是另一件事。
test('🔴 重发旧事件不会给它补上身份行', async () => {
  // 事件 insert 的 RETURNING 回空 = 这一批全是重复
  const sql = fakeSql([[], []]);
  const r = await openPostgresStore(sql).put(
    [{ eid: 'old', kind: 'install' }], Date.now(),
    [{ eid: 'old', os_user: 'zhang.wei', host: 'MBP-14-zw', notice: 'v2' }],
    '10.8.14.62',
  );
  assert.equal(r.accepted, 0);
  assert.equal(r.duplicate, 1);
  assert.equal(r.identities, 0, '给一条旧事件补上了身份');
  assert.ok(!sql.calls.some((c) => c.text.includes('insert into telemetry_identity')),
    '压根不该发出这条 insert');
});

test('一批里只给新插进去的那些事件写身份行', async () => {
  // 两条事件，只有 'a' 是新的
  const sql = fakeSql([[], [{ eid: 'a' }]]);
  const r = await openPostgresStore(sql).put(
    [{ eid: 'a' }, { eid: 'b' }], Date.now(),
    [{ eid: 'a', os_user: 'li.na' }, { eid: 'b', os_user: 'chen.yu' }],
    null,
  );
  assert.equal(r.identities, 1);
  const ins = sql.calls.find((c) => c.text.includes('insert into telemetry_identity'));
  const payload = JSON.parse(ins.args.find((x) => typeof x === 'string' && x.startsWith('[')));
  assert.deepEqual(payload.map((x) => x.eid), ['a']);
});

test('没有身份行时不发那条 insert', async () => {
  const sql = fakeSql([[], [{ eid: 'a' }]]);
  await openPostgresStore(sql).put([{ eid: 'a' }], Date.now());
  assert.ok(!sql.calls.some((c) => c.text.includes('telemetry_identity')));
});

test('🔴 身份保留期是独立的一条线，且只删不折算', async () => {
  const sql = fakeSql([[1, 1, 1]]);
  const r = await openPostgresStore(sql).pruneIdentity(90, 1_800_000_000_000);
  assert.deepEqual(r, { deleted: 3 });
  const del = sql.calls.find((c) => c.text.includes('delete from telemetry_identity'));
  assert.ok(del, '没发出身份清理');
  // 🔴 身份不进 rollup —— 一份「按人的历史计数」会让删除变成空话
  assert.ok(!sql.calls.some((c) => c.text.includes('telemetry_rollup')),
    'pruneIdentity 不该碰 rollup');
});

test('🔴 pruneIdentity 也有 NaN 闸', async () => {
  const store = openPostgresStore(fakeSql());
  await assert.rejects(() => store.pruneIdentity(NaN), /有限数值/);
});

// ── install_id 纳入 90 天身份生命周期（用户 2026-09-09 选 1A）──────────────
//
// 🔴 身份行 90 天后删了，但 install_id 还在事件 JSON 里躺到 180 天 ——
//    它配上时间线仍能把同一台机器串起来，再与新数据一关联就重新指回人。
test('🔴 到期剥掉 install_id：用 jsonb_exists，不用 ? 操作符', async () => {
  const sql = fakeSql([[1, 1, 1]]);
  const r = await openPostgresStore(sql).pruneInstallIds(90, 1_800_000_000_000);
  assert.deepEqual(r, { stripped: 3, capped: false });
  const up = sql.calls.find((c) => c.text.includes('telemetry_events'));
  assert.ok(up, '没发出剥离语句');
  assert.match(up.text, /jsonb_exists\(ev, 'install_id'\)/,
    "必须用 jsonb_exists —— `?` 在很多驱动里是参数占位符，写进模板是自找的歧义");
  assert.match(up.text, /set ev = e\.ev - 'install_id'/, '剥的必须是这一个键');
  assert.ok(!up.text.includes('delete from'), '这一步只剥键，不删事件');
});

test('🔴 每轮有上限，撞上限要说出来（悄悄剥一半是最糟的）', async () => {
  const sql = fakeSql([[1, 1]]);
  const r = await openPostgresStore(sql).pruneInstallIds(90, 1_800_000_000_000, 2);
  assert.equal(r.stripped, 2);
  assert.equal(r.capped, true, '撞上限没有说出来');
  const up = sql.calls.find((c) => c.text.includes('limit'));
  assert.ok(up, '没有封顶 —— 第一次跑会把定时任务拖成长事务');
});

test('🔴 pruneInstallIds 同样有 NaN 闸', async () => {
  await assert.rejects(() => openPostgresStore(fakeSql()).pruneInstallIds(NaN), /有限数值/);
});

test('🔴 install_id 与身份三项走同一条到期线', async () => {
  const src = readFileSync(new URL('../server/api/prune.js', import.meta.url), 'utf8');
  assert.match(src, /pruneInstallIds\(idDays\)/,
    'install_id 必须用身份那条保留期（idDays），不是事件那条');
});

// ── 墓碑与串行化（Codex 2026-09-10 的第一条阻断项）─────────────────────────
//
// 🔴 没有那把锁时的竞态：摄入查墓碑没命中 → 删除写墓碑并删身份 → 摄入把身份插回去。
//    结果是「删完之后身份又回来了」，而两边各自看都没错。
test('🔴 写身份行之前按 tag 上事务锁 —— 不是会话锁', async () => {
  const sql = fakeSql([[], [{ eid: 'a' }]]);
  await openPostgresStore(sql).put(
    [{ eid: 'a' }], Date.now(),
    [{ eid: 'a', os_user: 'zhang.wei', pubkey_tag: 'tag-1' }], null,
  );
  const lock = sql.calls.find((c) => c.text.includes('pg_advisory_xact_lock'));
  assert.ok(lock, '没上锁 —— 删除与摄入之间的竞态是开着的');
  assert.deepEqual(lock.args, ['tag-1'], '锁的必须是这一批的 tag');
  assert.ok(!sql.calls.some((c) => /pg_advisory_lock\(/.test(c.text)),
    '用了会话级锁 —— serverless 下连接复用，忘了释放就是永久死锁');
  // 锁必须在插入之前
  const iLock = sql.calls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
  const iIns = sql.calls.findIndex((c) => c.text.includes('insert into telemetry_identity'));
  assert.ok(iLock >= 0 && iLock < iIns, '锁在插入之后取，等于没取');
});

test('🔴 命中墓碑 → 身份丢掉，匿名事件照收', async () => {
  const sql = fakeSql([[], [{ eid: 'a' }]], ['tag-dead']);
  const r = await openPostgresStore(sql).put(
    [{ eid: 'a' }], Date.now(),
    [{ eid: 'a', os_user: 'zhang.wei', pubkey_tag: 'tag-dead' }], '10.0.0.1',
  );
  assert.equal(r.accepted, 1, '匿名事件必须照收 —— 删除的语义是「不要认出我」，不是「不要数我」');
  assert.equal(r.identities, 0, '已删除的机器又被写回了身份');
  assert.ok(!sql.calls.some((c) => c.text.includes('insert into telemetry_identity')),
    '压根不该发出这条 insert');
});

test('一批里只有部分命中墓碑：命中的丢，没命中的照写', async () => {
  const sql = fakeSql([[], [{ eid: 'a' }, { eid: 'b' }]], ['tag-dead']);
  const r = await openPostgresStore(sql).put(
    [{ eid: 'a' }, { eid: 'b' }], Date.now(),
    [
      { eid: 'a', os_user: 'x', pubkey_tag: 'tag-dead' },
      { eid: 'b', os_user: 'y', pubkey_tag: 'tag-live' },
    ], null,
  );
  assert.equal(r.identities, 1);
  const ins = sql.calls.find((c) => c.text.includes('insert into telemetry_identity'));
  const payload = JSON.parse(ins.args.find((x) => typeof x === 'string' && x.startsWith('[')));
  assert.deepEqual(payload.map((x) => x.eid), ['b']);
});

test('🔴 身份行落库带 pubkey_tag（删除要靠它找行）', async () => {
  const sql = fakeSql([[], [{ eid: 'a' }]]);
  await openPostgresStore(sql).put(
    [{ eid: 'a' }], Date.now(), [{ eid: 'a', os_user: 'x', pubkey_tag: 'tag-1' }], null,
  );
  const ins = sql.calls.find((c) => c.text.includes('insert into telemetry_identity'));
  assert.match(ins.text, /pubkey_tag/, '没写 pubkey_tag —— 删除时按什么找行？');
});
