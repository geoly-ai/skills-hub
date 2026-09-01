import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAUSE, MIN_INSTALLS, formatInstalls, suppressRows } from '../lib/suppress.mjs';

const row = (key, events, installs) => ({ key, events, installs });

test('达标的行原样展示', () => {
  const r = suppressRows([row('a', 100, 9), row('b', 50, 5)]);
  assert.equal(r.visible.length, 2);
  assert.equal(r.suppressed.rows, 0);
  assert.equal(r.tableSuppressed, false);
});

test('installs 恰好等于阈值就算达标（边界不许写成 >）', () => {
  const r = suppressRows([row('a', 1, MIN_INSTALLS), row('b', 1, MIN_INSTALLS), row('c', 1, MIN_INSTALLS)]);
  assert.equal(r.visible.length, 3);
});

test('installs 缺失 = 不达标（fail-closed），且与「样本太少」分开计', () => {
  const r = suppressRows([row('a', 10, undefined), row('b', 10, null), row('c', 10, '7')]);
  assert.equal(r.visible.length, 0);
  assert.equal(r.suppressed.unverifiable, 3);
  assert.equal(r.suppressed.small, 0);
  assert.equal(r.tableSuppressed, true);
});

test('🔴 恰好抑制一行时必须互补抑制 —— 否则「总数 - 可见行」能把它减出来', () => {
  const r = suppressRows([row('big', 100, 9), row('mid', 40, 8), row('tiny', 3, 1)]);
  // tiny 因为 installs<5 被抑制；只抑制了它一个，所以最小的可见行 mid 也被拉进来
  assert.equal(r.suppressed.rows, 2);
  assert.equal(r.suppressed.small, 1);
  assert.equal(r.suppressed.complementary, 1);
  assert.deepEqual(r.visible.map((x) => x.key), ['big']);
});

test('🔴 抑制结果里不许出现「被抑制那一组的事件合计」—— 那是一个减法锚点', () => {
  const r = suppressRows([row('big', 100, 9), row('mid', 40, 8), row('tiny', 3, 1)]);
  assert.equal(r.suppressed.events, undefined,
    '精确合计配合别的表能把某一行减出来（跨表相减），所以连算都不要算');
  assert.ok(!Object.hasOwn(r.suppressed, 'events'));
});

test('互补抑制挑的是事件数最小的可见行（信息量最低的那个）', () => {
  const r = suppressRows([row('a', 90, 9), row('b', 5, 7), row('c', 1, 2)]);
  assert.deepEqual(r.visible.map((x) => x.key), ['a']);
});

test('已经抑制了两行以上就不再互补抑制', () => {
  const r = suppressRows([row('a', 90, 9), row('b', 80, 9), row('c', 1, 1), row('d', 2, 2)]);
  assert.equal(r.suppressed.rows, 2);
  assert.equal(r.suppressed.complementary, 0);
  assert.deepEqual(r.visible.map((x) => x.key), ['a', 'b']);
});

test('整表只有一行且不达标时，整表按被抑制渲染', () => {
  const r = suppressRows([row('only', 3, 1)]);
  assert.equal(r.visible.length, 0);
  assert.equal(r.tableSuppressed, true);
});

test('空表不算被抑制', () => {
  const r = suppressRows([]);
  assert.equal(r.tableSuppressed, false);
  assert.equal(r.suppressed.rows, 0);
});

test('非法 events 不让整个抑制器炸掉（互补抑制要在这些行上也挑得出最小的那个）', () => {
  const r = suppressRows([row('a', 'x', 9), row('b', -5, 9), row('c', 1, 1)]);
  assert.equal(r.suppressed.rows, 2);   // c 被抑制 + 一行互补
  assert.equal(r.visible.length, 1);
});

test('formatInstalls：缺失是「未提供」，不是 0，也不是 <5', () => {
  assert.deepEqual(formatInstalls(undefined), { kind: 'unknown', text: '未提供' });
  assert.deepEqual(formatInstalls(null), { kind: 'unknown', text: '未提供' });
  assert.deepEqual(formatInstalls(1.5), { kind: 'unknown', text: '未提供' });
  assert.equal(formatInstalls(0).kind, 'floored');
  assert.equal(formatInstalls(4).text, `<${MIN_INSTALLS}`);
  assert.deepEqual(formatInstalls(5), { kind: 'exact', text: '5' });
});

test('CAUSE 三个取值都被用到（防止有人加了分类却没接线）', () => {
  const r = suppressRows([row('a', 9, 9), row('b', 1, 1), row('c', 1, undefined)]);
  const causes = new Set();
  if (r.suppressed.small) causes.add(CAUSE.SMALL);
  if (r.suppressed.unverifiable) causes.add(CAUSE.UNVERIFIABLE);
  assert.ok(causes.has(CAUSE.SMALL) && causes.has(CAUSE.UNVERIFIABLE));
});
