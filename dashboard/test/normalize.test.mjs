import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SUMMARY_SCHEMA, normalizeSummary } from '../lib/normalize.mjs';
import { isIdentifierKey, stripIdentifiers } from '../lib/whitelist.mjs';

const base = (extra = {}) => ({ schema: SUMMARY_SCHEMA, total: 10, ...extra });

test('认得 server/aggregate.mjs 当前那个形状', () => {
  const r = normalizeSummary(base({
    rolled_up_before: 0,
    byArtifact: [{ artifact: 'skill:geoly/pr-draft@1.2.0', n: 7, kinds: { install: 7 }, results: { ok: 7 } }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.total, 10);
  assert.equal(r.dimensions.artifact.available, true);
  assert.equal(r.dimensions.artifact.rows[0].key, 'skill:geoly/pr-draft@1.2.0');
  assert.equal(r.dimensions.artifact.rows[0].events, 7);
  // 服务端没给 installs → null，抑制器会据此 fail-closed
  assert.equal(r.dimensions.artifact.rows[0].installs, null);
});

test('服务端没给的维度是 available:false，不是空表', () => {
  const r = normalizeSummary(base());
  assert.equal(r.dimensions.reason.available, false);
  assert.equal(r.durations.available, false);
  // 🔴 「服务端还没算」与「算了但是 0 行」必须分得开
  assert.deepEqual(r.dimensions.reason.rows, []);
});

test('对象映射形状也认', () => {
  const r = normalizeSummary(base({ byClient: { cursor: { n: 3, installs: 6 }, claude: { n: 9, installs: 8 } } }));
  assert.equal(r.dimensions.client.available, true);
  assert.deepEqual(r.dimensions.client.rows.map((x) => x.key), ['claude', 'cursor']);
  assert.equal(r.dimensions.client.rows[0].installs, 8);
});

test('snake_case 键也认（by_client）', () => {
  const r = normalizeSummary(base({ by_client: { codex: { n: 1 } } }));
  assert.equal(r.dimensions.client.available, true);
});

test('🔴 白名单之外的取值一律丢掉，不渲染 —— 摄入端点是无鉴权的', () => {
  const r = normalizeSummary(base({
    byClient: { claude: { n: 5 }, 'vscode<script>': { n: 99 }, '': { n: 1 } },
    byOs: { darwin: { n: 2 }, windows: { n: 8 } },
    byArtifact: [{ artifact: '/Users/alice/secret', n: 3 }, { artifact: 'skill:a/b@1', n: 1 }],
  }));
  assert.deepEqual(r.dimensions.client.rows.map((x) => x.key), ['claude']);
  assert.deepEqual(r.dimensions.os.rows.map((x) => x.key), ['darwin']);
  assert.deepEqual(r.dimensions.artifact.rows.map((x) => x.key), ['skill:a/b@1']);
});

test('🔴🔴 install_id / eid 形态的键在归一化时被递归剥掉', () => {
  const r = normalizeSummary(base({
    install_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    byInstallId: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': { n: 40 } },
    byClient: { claude: { n: 5, install_ids: ['x'], eid: 'y', installs: 6 } },
  }));
  const json = JSON.stringify(r);
  assert.ok(!json.includes('install_id'), 'viewmodel 里不许出现 install_id');
  assert.ok(!json.includes('aaaaaaaa-aaaa'), 'viewmodel 里不许出现任何 UUID');
  assert.equal(r.dimensions.client.rows[0].installs, 6, '计数形态的 installs 要留下');
});

test('识别符键名判据认形态，不只认那两个字面量', () => {
  for (const k of ['install_id', 'installId', 'INSTALL-ID', 'byInstallId', 'by_install_ids', 'eid', 'eids', 'uuid', 'machine_id', 'deviceId']) {
    assert.ok(isIdentifierKey(k), `${k} 应该被判为识别符`);
  }
  for (const k of ['installs', 'kinds', 'results', 'artifact', 'reason', 'total']) {
    assert.ok(!isIdentifierKey(k), `${k} 不该被误杀`);
  }
});

test('stripIdentifiers 不让 __proto__ 污染原型', () => {
  const out = stripIdentifiers(JSON.parse('{"__proto__":{"polluted":1},"a":2}'));
  assert.equal(out.a, 2);
  assert.equal({}.polluted, undefined);
});

test('🔴 HTTP 200 也可能不是一份汇总 —— schema 对不上要说 invalid，不能当 0', () => {
  assert.equal(normalizeSummary({ total: 0 }).ok, false);
  assert.equal(normalizeSummary('<html>Login</html>').ok, false);
  assert.equal(normalizeSummary(null).ok, false);
  assert.equal(normalizeSummary([]).ok, false);
  assert.equal(normalizeSummary(base({ total: -1 })).ok, false);
  assert.equal(normalizeSummary(base({ total: '10' })).ok, false);
});

test('total 为 0 是合法的汇总（真实的 0），不是 invalid', () => {
  const r = normalizeSummary(base({ total: 0 }));
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
});

test('durations：分组维度必须在白名单里，p50/p95 必须是有限非负数', () => {
  const r = normalizeSummary(base({
    durations: [
      { version: '1.2.0', n: 30, installs: 9, p50: 840, p95: 2100 },
      { hostname: 'alices-mbp', n: 5, p50: 1 },     // 分组维度不在白名单 → 丢
      { version: '9.9.9', n: 5, p50: -3, p95: NaN }, // 数值非法 → p50/p95 为 null
    ],
  }));
  assert.equal(r.durations.available, true);
  assert.equal(r.durations.groups.length, 2);
  assert.equal(r.durations.groups[0].p95, 2100);
  assert.equal(r.durations.groups[1].p50, null);
});

test('🔴 维度容器形状不对 = invalid，不能被说成「筛没了」或「服务端没算」', () => {
  // Codex 2026-09-01 P1：初稿把 `byArtifact: "x"` 读成空表，
  // 于是页面说「当前筛选条件下没有行」—— 把一次故障说成了一个结论
  assert.equal(normalizeSummary(base({ byArtifact: 'x' })).ok, false);
  assert.equal(normalizeSummary(base({ byClient: 3 })).ok, false);
  assert.equal(normalizeSummary(base({ durations: {} })).ok, false);
  assert.equal(normalizeSummary(base({ durations: 'x' })).ok, false);
  // null / 缺失仍然是「服务端没算」，那是合法的
  assert.equal(normalizeSummary(base({ byArtifact: null })).ok, true);
  assert.equal(normalizeSummary(base({ byArtifact: null })).dimensions.artifact.available, false);
});

test('🔴 reason 是有限代码表，不是形状 —— `alice` 形状合法但必须被丢掉', () => {
  const r = normalizeSummary(base({
    byReason: { alice: { n: 99, installs: 9 }, 'network-error': { n: 3, installs: 9 } },
  }));
  assert.deepEqual(r.dimensions.reason.rows.map((x) => x.key), ['network-error']);
});

test('🔴 嵌套的 kinds / results 连读都不读 —— 父行达标不代表交叉子组达标', () => {
  const r = normalizeSummary(base({
    byArtifact: [{ artifact: 'skill:a/b@1', n: 10, installs: 5, kinds: { install: 10 }, results: { failed: 1, ok: 9 } }],
  }));
  const row = r.dimensions.artifact.rows[0];
  assert.equal(row.results, undefined, 'results 进了 viewmodel 就迟早会被渲染出来');
  assert.equal(row.kinds, undefined);
  assert.ok(!JSON.stringify(r).includes('failed'));
});

test('🔴 折算水位只留布尔，不留时间戳（多余的运行元数据 + toISOString 会抛）', () => {
  const a = normalizeSummary(base({ rolled_up_before: 1_700_000_000_000 }));
  assert.equal(a.hasRolledUp, true);
  assert.equal(a.rolledUpBefore, undefined);
  assert.equal(normalizeSummary(base({ rolled_up_before: 0 })).hasRolledUp, false);
  // 一个合法但极大的整数不该让页面炸
  assert.equal(normalizeSummary(base({ rolled_up_before: Number.MAX_SAFE_INTEGER })).ok, true);
});

test('🔴 数一下被丢掉的行 —— 「丢完剩 0 行」与「本来就是 0 行」是两件事', () => {
  const dirty = normalizeSummary(base({ byOs: { windows: { n: 8 }, plan9: { n: 2 } } }));
  assert.equal(dirty.dimensions.os.rows.length, 0);
  assert.equal(dirty.dimensions.os.dropped, 2, '不数的话，页面会把一次数据质量问题说成「本来就是空的」');

  const empty = normalizeSummary(base({ byOs: {} }));
  assert.equal(empty.dimensions.os.dropped, 0);

  const mixed = normalizeSummary(base({ byOs: { darwin: { n: 5, installs: 9 }, windows: { n: 8 } } }));
  assert.equal(mixed.dimensions.os.rows.length, 1);
  assert.equal(mixed.dimensions.os.dropped, 1);
});

test('不做任何聚合：不给的东西就是 null，不从别处推', () => {
  const r = normalizeSummary(base({ byArtifact: [{ artifact: 'skill:a/b@1', n: 10, installs: 7 }] }));
  // 顶层 installs 没给，就算 byArtifact 里有 installs 也不许拿来当全局值
  assert.equal(r.installs, null);
});
