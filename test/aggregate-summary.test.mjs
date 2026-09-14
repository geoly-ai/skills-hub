// server/aggregate.mjs 的 summarize() —— 与 dashboard 之间的形状契约。
//
// 🔴 这份测试有两层：
//    ① 单测：计数、去重、非法取值、rollup 与 live 的口径、分位数与取整、隐私。
//    ② 契约：把 summarize() 的**真实输出**喂给 dashboard 的 normalizeSummary()。
//       两边形状一旦漂移，dashboard 会把维度判成「服务端还没算」或「一行都不认得」——
//       那类错不会让服务端的任何测试变红，只有这一条会。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  summarize, foldInto, emptyRollup, MIN_EVENTS_FOR_QUANTILE, QUANTILE_ROUND_MS, SUMMARY_SCHEMA,
} from '../server/aggregate.mjs';
import { normalizeSummary, SUMMARY_SCHEMA as DASHBOARD_SCHEMA } from '../dashboard/lib/normalize.mjs';
import { DIMENSIONS } from '../dashboard/lib/whitelist.mjs';

const ID = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
let eidSeq = 0;

/** 一条合法的匿名事件。`over` 覆盖任意字段；值为 undefined 的键会被删掉。 */
function ev(over = {}) {
  const e = {
    schema: 'geoly.skills.telemetry/1',
    eid: `11111111-1111-4111-8111-${String(++eidSeq).padStart(12, '0')}`,
    at: '2026-09-14T00:00:00.000Z',
    install_id: ID(1),
    cli: '0.3.7', os: 'darwin', arch: 'arm64', node: '22.13.0',
    kind: 'install', result: 'ok',
    artifact: 'skill:geoly/a@1.0.0', version: '1.0.0', client: 'claude', scope: 'global',
    ...over,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

const row = (sum, dim, value) => sum[`by${dim[0].toUpperCase()}${dim.slice(1)}`].find((r) => r[dim] === value);

// ── ① 单测 ─────────────────────────────────────────────────────────────────

test('各维度按取值计数 n，并带去重装机数 installs', () => {
  const sum = summarize([
    ev({ install_id: ID(1), client: 'claude', os: 'darwin' }),
    ev({ install_id: ID(1), client: 'claude', os: 'linux' }),
    ev({ install_id: ID(2), client: 'cursor', os: 'linux', kind: 'remove', result: 'failed', reason: 'timeout' }),
    ev({ install_id: ID(3), client: 'claude', os: 'linux', scope: 'project' }),
  ]);
  assert.equal(sum.schema, SUMMARY_SCHEMA);
  assert.equal(sum.total, 4);
  assert.equal(sum.installs, 3);
  assert.deepEqual(row(sum, 'client', 'claude'), { client: 'claude', n: 3, installs: 2 });
  assert.deepEqual(row(sum, 'client', 'cursor'), { client: 'cursor', n: 1, installs: 1 });
  assert.deepEqual(row(sum, 'os', 'linux'), { os: 'linux', n: 3, installs: 3 });
  assert.deepEqual(row(sum, 'kind', 'install'), { kind: 'install', n: 3, installs: 2 });
  assert.deepEqual(row(sum, 'result', 'failed'), { result: 'failed', n: 1, installs: 1 });
  assert.deepEqual(row(sum, 'reason', 'timeout'), { reason: 'timeout', n: 1, installs: 1 });
  assert.deepEqual(row(sum, 'scope', 'project'), { scope: 'project', n: 1, installs: 1 });
  assert.deepEqual(row(sum, 'cli', '0.3.7'), { cli: '0.3.7', n: 4, installs: 3 });
  assert.deepEqual(row(sum, 'node', '22.13.0'), { node: '22.13.0', n: 4, installs: 3 });
  assert.deepEqual(row(sum, 'arch', 'arm64'), { arch: 'arm64', n: 4, installs: 3 });
  assert.deepEqual(row(sum, 'version', '1.0.0'), { version: '1.0.0', n: 4, installs: 3 });
  // 行排序：n 降序，同数按取值升序
  assert.deepEqual(sum.byClient.map((r) => r.client), ['claude', 'cursor']);
  // 缺字段的事件不造「(none)」行
  assert.equal(sum.byReason.length, 1);
});

test('byArtifact 保留 kinds / results，并补上 installs', () => {
  const sum = summarize([
    ev({ install_id: ID(1), kind: 'install', result: 'ok' }),
    ev({ install_id: ID(1), kind: 'check', result: 'failed' }),
    ev({ install_id: ID(2), artifact: 'skill:geoly/b@2.0.0', kind: 'remove' }),
    ev({ install_id: ID(2), artifact: undefined, kind: 'sync-lock' }),
  ]);
  const a = row(sum, 'artifact', 'skill:geoly/a@1.0.0');
  assert.equal(a.n, 2);
  assert.equal(a.installs, 1, '同一台机器两条事件只算一台');
  assert.equal(a.kinds.install, 1);
  assert.equal(a.kinds.check, 1);
  assert.equal(a.results.ok, 1);
  assert.equal(a.results.failed, 1);
  assert.equal(sum.byArtifact.length, 2, '没有 artifact 的事件不进 byArtifact');
  assert.equal(sum.total, 4, '但要进总数');
});

test('installs 去重：顶层与行内都是 distinct install_id；被剥掉 install_id 的事件只计 n', () => {
  const sum = summarize([
    ev({ install_id: ID(7) }), ev({ install_id: ID(7) }), ev({ install_id: ID(7) }),
    ev({ install_id: ID(8) }),
    ev({ install_id: undefined }),     // 90 天到期线 / 删除通道剥过的形态
    ev({ install_id: undefined }),
  ]);
  assert.equal(sum.installs, 2);
  assert.deepEqual(row(sum, 'client', 'claude'), { client: 'claude', n: 6, installs: 2 },
    'installs 是下界：偏差方向必须是「多抑制」');
});

test('🔴 非法取值被丢，不进任何一行（服务端不信事件内容）', () => {
  const sum = summarize([
    ev({ client: 'vim', os: 'win32', arch: 'ia32', node: 'v22', kind: 'hack', result: 'meh',
      scope: 'galaxy', reason: 'alice', cli: '../../etc', version: 'x'.repeat(40),
      artifact: 'skill:geoly/<script>@1' }),
    ev({ client: { path: '/Users/a' }, os: ['darwin'], reason: 42 }),
    ev({ artifact: '__proto__', client: 'constructor' }),
  ]);
  assert.equal(sum.total, 3, '事件本身仍计入总数');
  for (const dim of Object.keys(DIMENSIONS)) {
    const rows = sum[`by${dim[0].toUpperCase()}${dim.slice(1)}`];
    for (const r of rows) {
      assert.ok(typeof r[dim] === 'string' && DIMENSIONS[dim].valueOk(r[dim]), `${dim} 漏进了非法取值 ${r[dim]}`);
    }
  }
  assert.equal(sum.byClient.length, 0, '三条事件的 client 都非法');
  assert.equal(sum.byReason.length, 0);
  assert.deepEqual(sum.byArtifact.map((r) => r.artifact), ['skill:geoly/a@1.0.0'], '只有第二条的默认坐标合法');
  assert.deepEqual(sum.byOs.map((r) => r.os), ['darwin'], '第一条 win32、第二条数组都要丢');
  assert.equal({}.n, undefined, '原型被污染了');
});

test('🔴 rollup 与 live：计数带 installs 的行只来自 live，历史单独放、total 两者相加', () => {
  const rollup = foldInto(emptyRollup(), [
    ev({ artifact: 'skill:geoly/a@1.0.0' }), ev({ artifact: 'skill:geoly/a@1.0.0' }),
    ev({ artifact: 'skill:geoly/old@0.1.0' }),
    ev({ artifact: undefined, kind: 'rollback' }),
  ]);
  rollup.cutoff = 5_000;
  const sum = summarize([
    ev({ install_id: ID(1), artifact: 'skill:geoly/a@1.0.0' }),
    ev({ install_id: ID(2), artifact: 'skill:geoly/b@2.0.0' }),
  ], rollup);

  assert.equal(sum.total, 6, 'total = live 2 + 历史 4');
  assert.equal(sum.rolled_up_before, 5_000);
  assert.equal(sum.installs, 2, 'installs 只数 live');

  // 🔴 同一行里 n 与 installs 必须是同一批事件
  assert.deepEqual(
    { n: row(sum, 'artifact', 'skill:geoly/a@1.0.0').n, installs: row(sum, 'artifact', 'skill:geoly/a@1.0.0').installs },
    { n: 1, installs: 1 },
    '历史的 2 条混进来了：那会说成「3 条事件、1 台机器」',
  );
  assert.equal(row(sum, 'artifact', 'skill:geoly/old@0.1.0'), undefined, '只有历史的制品不能以 installs:0 的行出现');
  assert.equal(row(sum, 'kind', 'rollback'), undefined, '历史事件没有维度，不能出现在 byKind 里');

  // 历史按制品单独给，且不带 installs
  const hist = sum.rolled_up.byArtifact;
  assert.deepEqual(hist.map((r) => [r.artifact, r.n]), [['skill:geoly/a@1.0.0', 2], ['skill:geoly/old@0.1.0', 1]]);
  for (const r of hist) assert.equal(Object.hasOwn(r, 'installs'), false);

  // 不改入参
  assert.equal(rollup.total, 4);
});

test('durations：只用 kind=install 且 result=ok 带 ms 的事件，按制品版本分组', () => {
  const events = [];
  for (let i = 0; i < 25; i++) events.push(ev({ install_id: ID(i % 6), version: '1.0.0', ms: 100 + i }));
  for (let i = 0; i < 3; i++) events.push(ev({ install_id: ID(1), version: '2.0.0', ms: 900 }));
  // 下面这些都不该进 durations
  events.push(ev({ version: '1.0.0', ms: 99_999, result: 'failed', reason: 'timeout' }));
  events.push(ev({ version: '1.0.0', ms: 99_999, kind: 'update' }));
  events.push(ev({ version: '1.0.0', ms: undefined }));
  events.push(ev({ version: '1.0.0', ms: -1 }));
  events.push(ev({ version: '1.0.0', ms: 1.5 }));
  events.push(ev({ version: '1.0.0', ms: '120' }));
  events.push(ev({ version: '../x', ms: 100 }));
  events.push(ev({ version: undefined, ms: 100 }));

  const sum = summarize(events);
  assert.deepEqual(sum.durations.map((g) => g.version), ['1.0.0', '2.0.0']);
  const g1 = sum.durations[0];
  assert.equal(g1.n, 25);
  assert.equal(g1.installs, 6);
  // 最近秩：p50 = 第 13 小 = 112 → 150；p95 = 第 24 小 = 123 → 150
  assert.equal(g1.p50, 150);
  assert.equal(g1.p95, 150);
  for (const g of sum.durations) {
    assert.deepEqual(Object.keys(g).sort(), ['installs', 'n', 'p50', 'p95', 'version'], '不许带原始 ms 或别的字段');
  }
});

test('durations：分位数按 50ms 向上取整，恰在边界上不再进位', () => {
  const ms = [];
  for (let i = 1; i <= 100; i++) ms.push(i * 10);   // 10..1000
  const sum = summarize(ms.map((m, i) => ev({ install_id: ID(i), ms: m })));
  const g = sum.durations[0];
  assert.equal(g.p50, 500, '第 50 小 = 500，已在边界上');
  assert.equal(g.p95, 950, '第 95 小 = 950');
  assert.equal(g.p50 % QUANTILE_ROUND_MS, 0);

  const odd = summarize(Array.from({ length: 20 }, (_, i) => ev({ install_id: ID(i), ms: 1001 + i })));
  assert.equal(odd.durations[0].p50, 1050, '1010 → 1050');
  assert.equal(odd.durations[0].p95, 1050, '1019 → 1050');

  const zero = summarize(Array.from({ length: 20 }, (_, i) => ev({ install_id: ID(i), ms: 0 })));
  assert.equal(zero.durations[0].p50, 0);
});

test('🔴 durations：事件数不足门槛时服务端不给分位数（原始响应里也不带小样本顺序统计量）', () => {
  const few = summarize(Array.from({ length: MIN_EVENTS_FOR_QUANTILE - 1 }, (_, i) => ev({ install_id: ID(i), ms: 1234 })));
  assert.deepEqual(few.durations, [{ version: '1.0.0', n: MIN_EVENTS_FOR_QUANTILE - 1, installs: MIN_EVENTS_FOR_QUANTILE - 1, p50: null, p95: null }]);
  assert.equal(JSON.stringify(few).includes('1234'), false);
  assert.equal(JSON.stringify(few).includes('1250'), false);
});

test('没有带 ms 的安装事件时 durations 是空数组（不是缺键）', () => {
  const sum = summarize([ev({ ms: undefined }), ev({ kind: 'remove', ms: 10 })]);
  assert.deepEqual(sum.durations, []);
  assert.deepEqual(summarize([]).durations, []);
});

test('🔴 输出里没有任何 install_id / eid / 身份字段的值（按 JSON 文本断言）', () => {
  const secrets = {
    install_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    eid: 'ffffffff-1111-4222-8333-444444444444',
    os_user: 'alice-secret-user',
    host: 'alice-macbook-secret-host',
    notice: 'v2-secret-notice',
    pubkey: 'PUBKEY-SECRET-MATERIAL',
    ip: '203.0.113.77',
  };
  const events = [];
  for (let i = 0; i < 25; i++) {
    events.push(ev({ ...secrets, eid: `${secrets.eid.slice(0, -2)}${String(i).padStart(2, '0')}`, ms: 300 }));
  }
  const text = JSON.stringify(summarize(events, foldInto(emptyRollup(), events.slice(0, 3))));
  for (const [k, v] of Object.entries(secrets)) {
    assert.equal(text.includes(v), false, `${k} 的值出现在输出里`);
  }
  assert.equal(text.includes(secrets.eid.slice(0, 20)), false, 'eid 的前缀出现在输出里');
  for (const k of ['install_id', 'eid', 'os_user', 'host', 'notice', 'pubkey', '"ip"']) {
    assert.equal(text.includes(k), false, `输出里出现了键 ${k}`);
  }
});

// ── ② 契约：真实输出 → dashboard 的 normalizeSummary() ──────────────────────

/** 一份每个维度都有行、durations 过门槛、还带历史的样本。 */
function richSample() {
  const events = [];
  const combos = [
    { client: 'claude', os: 'darwin', arch: 'arm64', scope: 'global' },
    { client: 'cursor', os: 'linux', arch: 'x64', scope: 'project' },
    { client: 'codex', os: 'linux', arch: 'arm64', scope: 'global' },
    { client: 'agents', os: 'darwin', arch: 'x64', scope: 'project' },
  ];
  for (let i = 0; i < 40; i++) {
    events.push(ev({
      install_id: ID(i % 9), ...combos[i % combos.length],
      artifact: i % 2 ? 'skill:geoly/a@1.0.0' : 'pack:geoly/matrix@2.1.0',
      version: i % 2 ? '1.0.0' : '2.1.0',
      ms: 200 + i * 7,
    }));
  }
  events.push(ev({ install_id: ID(3), kind: 'update', result: 'failed', reason: 'network-error', ms: 5000 }));
  events.push(ev({ install_id: ID(4), kind: 'sync-lock', result: 'skipped', artifact: undefined, version: undefined, client: undefined, scope: undefined }));
  // 🔴 脏事件：摄入面无鉴权。服务端不校验取值的话，这些会变成 dashboard 那侧的 dropped > 0，
  //    契约测试据此变红（变异自检时「取值不校验」这一格就是靠它抓到的）。
  for (const d of [
    { client: 'vim', os: 'win32', arch: 'ia32', node: 'v22', kind: 'hack', result: 'meh', scope: 'galaxy',
      reason: 'alice', cli: '../x', version: 'x'.repeat(40), artifact: 'skill:geoly/<b>@1', ms: 300 },
    { client: 42, os: ['darwin'], reason: { path: '/Users/a' } },
  ]) events.push(ev({ install_id: ID(5), ...d }));
  const rollup = { ...foldInto(emptyRollup(), [ev(), ev({ artifact: 'skill:geoly/gone@0.0.1' })]), cutoff: 1_700_000_000_000 };
  return summarize(events, rollup);
}

test('🔴 契约：summarize() 的真实输出被 dashboard 完整认得', () => {
  const sum = richSample();
  // 经 JSON 往返：dashboard 拿到的是 HTTP body，不是这个进程里的对象
  const vm = normalizeSummary(JSON.parse(JSON.stringify(sum)));
  assert.equal(vm.ok, true, `dashboard 判成 INVALID：${vm.why}`);
  assert.equal(sum.schema, DASHBOARD_SCHEMA);
  assert.equal(vm.total, sum.total);
  assert.equal(vm.installs, sum.installs, '顶层 installs 没被认出来（键名被剥掉或不是整数）');
  assert.equal(vm.hasRolledUp, true);

  for (const dim of Object.keys(DIMENSIONS)) {
    const block = vm.dimensions[dim];
    assert.equal(block.available, true, `维度 ${dim} 被判成「服务端还没算」`);
    assert.equal(block.dropped, 0, `维度 ${dim} 有行被 dashboard 丢掉`);
    assert.ok(block.rows.length > 0, `样本应让维度 ${dim} 至少有一行`);
    const serverRows = sum[`by${dim[0].toUpperCase()}${dim.slice(1)}`];
    assert.equal(block.rows.length, serverRows.length, `维度 ${dim} 行数对不上`);
    for (const r of block.rows) {
      assert.ok(Number.isInteger(r.installs) && r.installs >= 0, `维度 ${dim} 的行 ${r.key} 缺 installs（会被 fail-closed 整表挡掉）`);
      assert.ok(r.installs <= r.events, `维度 ${dim} 的行 ${r.key} installs 大于事件数`);
    }
  }

  assert.equal(vm.durations.available, true, 'durations 被判成「服务端还没算」');
  assert.equal(vm.durations.groups.length, sum.durations.length, 'durations 有组被 dashboard 丢掉');
  assert.ok(vm.durations.groups.length > 0);
  for (const g of vm.durations.groups) {
    assert.equal(g.dim, 'version');
    assert.ok(Number.isInteger(g.installs), `durations 组 ${g.key} 缺 installs`);
    assert.ok(Number.isFinite(g.p50) && Number.isFinite(g.p95), `durations 组 ${g.key} 过了门槛却没有分位数`);
    assert.ok(g.p50 <= g.p95);
  }
});

test('🔴 契约：空输入也是一份合法汇总 —— 每个维度「算了但为空」，不是「没算」', () => {
  const vm = normalizeSummary(JSON.parse(JSON.stringify(summarize([]))));
  assert.equal(vm.ok, true, vm.why);
  assert.equal(vm.total, 0);
  assert.equal(vm.installs, 0);
  assert.equal(vm.hasRolledUp, false);
  for (const dim of Object.keys(DIMENSIONS)) {
    assert.equal(vm.dimensions[dim].available, true, dim);
    assert.equal(vm.dimensions[dim].rows.length, 0, dim);
  }
  assert.equal(vm.durations.available, true);
});
