// 静态页把聚合逻辑重写了一遍（它不能 import ESM 模块）。
// 两份实现一旦漂移，面板上的数字就跟 `skills-hub stats` 对不上 —— 这条测试就是防这个。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aggregate } from '../src/stats.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'docs/dashboard/index.html'), 'utf8');

function pageAggregate() {
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const stub = () => ({
    addEventListener() {}, classList: { add() {}, remove() {} },
    textContent: '', innerHTML: '', hidden: false, files: [],
  });
  const fn = new Function('document', 'fetch', js + '; return aggregate;');
  return fn({ getElementById: stub }, () => Promise.reject(new Error('no net')));
}

const EVENTS = [
  { at: '2026-08-01T00:00:00Z', kind: 'install', result: 'ok', artifact: 'skill:g/a@1.0.0', client: 'claude', ms: 840 },
  { at: '2026-08-02T00:00:00Z', kind: 'install', result: 'failed', artifact: 'skill:g/b@0.3.1', client: 'codex', ms: 120 },
  { at: '2026-08-03T00:00:00Z', kind: 'check', result: 'ok', artifact: 'skill:g/a@1.0.0', client: 'claude', ms: 40 },
  { at: '2026-08-04T00:00:00Z', kind: 'rollback', result: 'skipped' },
];

test('静态页的聚合结果与 src/stats.mjs 完全一致', () => {
  assert.equal(JSON.stringify(pageAggregate()(EVENTS)), JSON.stringify(aggregate(EVENTS)));
});

test('空输入两边也一致', () => {
  assert.equal(JSON.stringify(pageAggregate()([])), JSON.stringify(aggregate([])));
});

test('静态页不含外部资源引用（离线可用、无外发）', () => {
  const external = html.match(/(?:src|href)\s*=\s*"(?!#)([^"]+)"/g) ?? [];
  assert.deepEqual(external, [], `不应有外部引用：${external}`);
  // 唯一允许的 fetch 是同目录 data.json
  const fetches = [...html.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(fetches, ['./data.json', './data.sample.json']);
});

test('隐私说明常驻页面，且穷举了实际采集的字段', () => {
  assert.match(html, /<strong>没有<\/strong>路径/);
  assert.match(html, /install_id/);
  // 页面上列的字段必须覆盖实现里 FIELDS 的全部键，否则就是「说的比收的少」
  const impl = readFileSync(join(root, 'src/telemetry.mjs'), 'utf8');
  const block = impl.slice(impl.indexOf('const FIELDS = {'), impl.indexOf('export function assertValidEvent'));
  const keys = [...block.matchAll(/^  ([a-z_]+): \{ required/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 15, `没解析到字段表：${keys}`);
  const privacy = html.slice(html.indexOf('class="privacy"'), html.indexOf('</header>'));
  for (const k of keys) {
    if (k === 'schema') continue; // 常量，不是采集面
    assert.ok(privacy.includes(`<code>${k}</code>`), `隐私说明漏了字段 ${k}`);
  }
});
