import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_EVENTS_FOR_QUANTILE, bucketCount, publish } from '../lib/publish.mjs';

/*
 * 🔴 这个文件守的是 Codex 2026-09-01 挡下的那条 P0：
 *    **一个精确的顶层 `total` 会把表内的抑制原样还原回来。**
 *      被抑制组的事件数 = total − 该表所有可见行之和
 *    「HTML 里搜不到那个数」不等于「那个数推不出来」。
 */

const vm = (over = {}) => ({
  total: 137, installs: 11, hasRolledUp: false,
  dimensions: { artifact: { available: true, rows: [] } },
  durations: { available: false, groups: [] },
  ...over,
});

const dims = (rows) => ({ artifact: { available: true, rows } });
const row = (key, events, installs) => ({ key, events, installs });

test('没有任何抑制时，顶层 total 精确发布', () => {
  const v = publish(vm({ dimensions: dims([row('a', 90, 9), row('b', 47, 8)]) }));
  assert.equal(v.anySuppressed, false);
  assert.deepEqual(v.totalOut, { kind: 'exact', text: '137' });
  assert.equal(v.installsOut.kind, 'exact');
});

test('🔴 只要有一行被抑制，顶层 total 就必须分桶 —— 否则一减就还原了', () => {
  const v = publish(vm({ dimensions: dims([row('a', 90, 9), row('b', 43, 7), row('c', 4, 1)]) }));
  assert.equal(v.anySuppressed, true);
  assert.equal(v.totalOut.kind, 'bucketed');
  assert.notEqual(v.totalOut.text, '137');
  // 装机数也一样：它同样能当约束
  assert.equal(v.installsOut.kind, 'bucketed');
});

test('抑制发生在别的表上，顶层照样要分桶（抑制不是逐表独立的）', () => {
  const v = publish(vm({
    dimensions: {
      artifact: { available: true, rows: [row('a', 90, 9), row('b', 47, 9)] },
      client: { available: true, rows: [row('claude', 100, 9), row('cursor', 37, 9), row('codex', 1, 1)] },
    },
  }));
  assert.equal(v.anySuppressed, true);
  assert.equal(v.totalOut.kind, 'bucketed');
});

test('分桶：区间落在正确的桶里，且 0 仍然精确（0 不泄漏任何东西）', () => {
  assert.deepEqual(bucketCount(0), { kind: 'exact', text: '0' });
  assert.equal(bucketCount(1).text, '1–9');
  assert.equal(bucketCount(9).text, '1–9');
  assert.equal(bucketCount(137).text, '100–499');
  assert.equal(bucketCount(999).text, '500–999');
  assert.equal(bucketCount(1_000_000).text, '≥100000');
  assert.equal(bucketCount(undefined).kind, 'unknown');
  assert.equal(bucketCount(-1).kind, 'unknown');
  assert.equal(bucketCount(1.5).kind, 'unknown');
});

test('🔴 分桶后的区间必须真的含住原值（否则页面在撒谎）', () => {
  for (const n of [1, 7, 10, 49, 50, 99, 100, 499, 500, 4999, 5000, 99_999]) {
    const [lo, hi] = bucketCount(n).text.split('–').map(Number);
    assert.ok(n >= lo && n <= hi, `${n} 不在桶 ${bucketCount(n).text} 里`);
  }
});

test('durations：事件数不足门槛的行不发布（分位数是顺序统计量）', () => {
  const groups = [
    { dim: 'version', key: '1.0.0', label: '制品版本', events: 30, installs: 9, p50: 800, p95: 2000 },
    { dim: 'version', key: '2.0.0', label: '制品版本', events: 25, installs: 9, p50: 900, p95: 2500 },
    { dim: 'version', key: '3.0.0', label: '制品版本', events: 5, installs: 9, p50: 100, p95: 100 },
  ];
  const v = publish(vm({ durations: { available: true, groups } }));
  // 3.0.0 因事件数不足被挡；只挡住一行 → 互补抑制把最小的可见行（2.0.0，25 条）也拿掉
  assert.deepEqual(v.durations.visible.map((g) => g.key), ['1.0.0']);
  assert.equal(v.durations.quantileGated, true);
  assert.equal(v.durations.suppressed.rows, 2);
  assert.ok(MIN_EVENTS_FOR_QUANTILE > 5, '门槛必须严于装机数门槛，否则它没有存在意义');
});

test('durations：机器够多但每台只装一两次 —— quantileGated 必须为真，好让文案说对', () => {
  const groups = [{ dim: 'version', key: '1.0.0', label: '制品版本', events: 6, installs: 6, p50: 1, p95: 2 }];
  const v = publish(vm({ durations: { available: true, groups } }));
  assert.equal(v.durations.visible.length, 0);
  assert.equal(v.durations.quantileGated, true,
    '不标出来的话，页面会说「装机数长上去就会出现」—— 而装机数已经够了');
});

test('上游不可用（data=null）时 publish 返回 null，不编一份空视图出来', () => {
  assert.equal(publish(null), null);
});
