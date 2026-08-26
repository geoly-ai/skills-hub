import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, textReport } from '../src/stats.mjs';

const ev = (o) => ({ at: '2026-08-26T00:00:00Z', kind: 'install', result: 'ok', ...o });

test('聚合计数与成功率', () => {
  const a = aggregate([
    ev({ artifact: 'skill:g/a@1.0.0', client: 'claude', ms: 10 }),
    ev({ artifact: 'skill:g/a@1.0.0', client: 'cursor', result: 'failed' }),
    ev({ artifact: 'skill:g/b@1.0.0', client: 'claude', ms: 30, kind: 'check' }),
  ]);
  assert.equal(a.total, 3); assert.equal(a.ok, 2); assert.equal(a.failed, 1);
  assert.equal(a.avgMs, 20);
  assert.equal(a.byArtifact[0].key, 'skill:g/a@1.0.0');
  assert.equal(a.byArtifact[0].n, 2);
  assert.equal(a.byClient.find(r => r.key === 'claude').ok, 2);
});

test('空数据给的是解释，不是空表', () => {
  const out = textReport(aggregate([]));
  assert.match(out, /还没有埋点事件/);
  assert.ok(!out.includes('按制品'));
});

test('报表是纯 ASCII 骨架，数字对齐', () => {
  const out = textReport(aggregate([ev({ artifact: 'skill:g/a@1.0.0', client: 'claude', ms: 5 })]));
  assert.match(out, /成功率 100\.0%/);
  assert.match(out, /按制品/);
  // 表头必须是 ASCII —— 中文双宽会让列错位
  const header = out.split('\n').find(l => l.trimStart().startsWith('N ') || / N +OK +FAIL$/.test(l));
  assert.ok(header, '应有 ASCII 表头');
  const row = out.split('\n').find(l => l.startsWith('skill:'));
  assert.equal(row.length, header.length, '数据行与表头等宽');
});
