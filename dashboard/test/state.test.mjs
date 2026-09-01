import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SOURCE, SOURCE_COPY, VIEW, VIEW_COPY, sourceStateOf, viewStateOf } from '../lib/state.mjs';

/*
 * 🔴 这个文件在防的是一件很具体的事：**把不同的「没有」混成一句话**。
 *    混了以后「服务挂了」会看起来像「没人用」，而后者会让人去下架一个
 *    其实很好用的 skill。
 */

test('数据源状态：从外到内判，不许倒过来', () => {
  assert.equal(sourceStateOf({ configured: false }), SOURCE.UNCONFIGURED);
  assert.equal(sourceStateOf({ configured: true, transportError: 'timeout' }), SOURCE.UNREACHABLE);
  assert.equal(sourceStateOf({ configured: true, status: 401 }), SOURCE.DENIED);
  assert.equal(sourceStateOf({ configured: true, status: 403 }), SOURCE.DENIED);
  // 🔴 404 = 服务端没配 summary token、这个路由压根没开（规格 §5.3 读出面默认关闭）
  assert.equal(sourceStateOf({ configured: true, status: 404 }), SOURCE.DENIED);
  assert.equal(sourceStateOf({ configured: true, status: 500 }), SOURCE.UNREACHABLE);
  assert.equal(sourceStateOf({ configured: true, status: 429 }), SOURCE.UNREACHABLE);
  assert.equal(sourceStateOf({ configured: true, status: 200, bodyOk: true }), SOURCE.OK);
});

test('🔴 HTTP 200 + 形状不对 = invalid，绝不是「0 条事件」', () => {
  assert.equal(sourceStateOf({ configured: true, status: 200, bodyOk: false }), SOURCE.INVALID);
  assert.notEqual(sourceStateOf({ configured: true, status: 200, bodyOk: false }), SOURCE.OK);
});

test('没配端点时，就算传了 status 也要判 unconfigured（配置在最外层）', () => {
  assert.equal(sourceStateOf({ configured: false, status: 200, bodyOk: true }), SOURCE.UNCONFIGURED);
});

test('视图状态：0 事件 → 维度缺 → 空维度 → 被抑制，顺序不许调换', () => {
  assert.equal(viewStateOf({ totalEvents: 0, available: true, candidates: 5, visible: 5 }), VIEW.NO_EVENTS);
  assert.equal(viewStateOf({ totalEvents: 9, available: false, candidates: 0, visible: 0 }), VIEW.DIMENSION_MISSING);
  assert.equal(viewStateOf({ totalEvents: 9, available: true, candidates: 0, visible: 0 }), VIEW.NO_ROWS);
  assert.equal(viewStateOf({ totalEvents: 9, available: true, candidates: 3, visible: 0 }), VIEW.SUPPRESSED);
  assert.equal(viewStateOf({ totalEvents: 9, available: true, candidates: 3, visible: 2 }), VIEW.ROWS);
});

test('🔴 页面上没有筛选器，所以「候选行为 0」不许说成「筛没了」', () => {
  // 那是一句在当前页面里**不可能为真**的话 —— 说出来就是误诊
  assert.equal(viewStateOf({ totalEvents: 9, available: true, candidates: 0, visible: 0 }), VIEW.NO_ROWS);
  // 将来真加了筛选器，把 filtered 传进来，两种说法就都能成立、也仍然分得开
  assert.equal(
    viewStateOf({ totalEvents: 9, available: true, candidates: 0, visible: 0, filtered: true }),
    VIEW.FILTERED_EMPTY,
  );
});

test('🔴 「丢完剩 0 行」不许说成「这个维度本来就是空的」', () => {
  // 非法行被 normalize 静默丢掉后 candidates=0 —— 那是数据质量问题，不是一个结论
  assert.equal(
    viewStateOf({ totalEvents: 9, available: true, candidates: 0, visible: 0, dropped: 3 }),
    VIEW.UNRECOGNIZED_ROWS,
  );
  // 真的一行都没回过，才是「本来就是空的」
  assert.equal(
    viewStateOf({ totalEvents: 9, available: true, candidates: 0, visible: 0, dropped: 0 }),
    VIEW.NO_ROWS,
  );
});

test('🔴 durations 全被挡住时要走专门那句文案，不能沿用「装机数长上去就会出现」', () => {
  assert.equal(
    viewStateOf({ totalEvents: 9, available: true, candidates: 3, visible: 0, quantileGated: true }),
    VIEW.SUPPRESSED_QUANTILE,
  );
});

test('🔴 每一种「没有」的文案必须互不相同 —— 这是硬要求，不是文风', () => {
  const all = [...Object.values(SOURCE_COPY), ...Object.values(VIEW_COPY)];
  const titles = all.map((c) => c.title);
  assert.equal(new Set(titles).size, titles.length, '标题有重复：两种「没有」会被读成同一件事');
  const bodies = all.map((c) => c.body);
  assert.equal(new Set(bodies).size, bodies.length, '正文有重复');
});

test('🔴 禁用词：不许出现「暂无数据」「敬请期待」「Coming soon」', () => {
  const banned = ['暂无数据', '敬请期待', 'Coming soon', 'coming soon', '正在加载', '加载中'];
  const text = JSON.stringify([SOURCE_COPY, VIEW_COPY]);
  for (const w of banned) assert.ok(!text.includes(w), `文案里出现了禁用词 ${w}`);
});

test('每条文案都要说清「下一步看什么」，不能只说「没有」', () => {
  for (const [k, c] of [...Object.entries(SOURCE_COPY), ...Object.entries(VIEW_COPY)]) {
    assert.ok(c.title && c.body && c.next, `${k} 少了 title/body/next 中的一项`);
    assert.ok(c.next.length > 8, `${k} 的 next 太短，说不清下一步`);
  }
});

test('「真实的 0」那一条必须明说它不是故障；「不可用」那一条必须明说它不是没人用', () => {
  assert.ok(VIEW_COPY[VIEW.NO_EVENTS].body.includes('不是故障'));
  assert.ok(SOURCE_COPY[SOURCE.UNREACHABLE].body.includes('不是'));
  assert.ok(SOURCE_COPY[SOURCE.UNCONFIGURED].body.includes('不是因为没人用'));
});
