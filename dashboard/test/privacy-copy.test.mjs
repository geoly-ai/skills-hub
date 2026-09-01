import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENT_FIELDS } from '../lib/whitelist.mjs';

/*
 * 常驻隐私说明的看门狗。
 *
 * 面板是唯一一个非工程同事也会看的界面，隐私契约要在那里被**反复看见**。
 * site/ 那边有同一类测试（`test/dashboard-parity.test.mjs`），这里照做：
 * 🔴 **加字段不改文案就会红。**
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(HERE, '..', p), 'utf8');

test('隐私说明覆盖了字段表里的每一个字段', () => {
  const src = read('components/privacy.jsx');
  // 组件是从 whitelist.mjs 渲染字段表的，所以这里断言的是「它确实这么做了」
  assert.ok(src.includes('DISPLAYABLE_FIELDS'), '字段表必须从白名单渲染，不许手抄一遍');
  assert.ok(src.includes('EVENT_FIELDS'), '被隐藏的字段也要列出来，并说明为什么');
  for (const f of ['install_id', 'eid', 'schema']) {
    assert.ok(src.includes(f), `隐私说明里必须点名 ${f} 并说明它为什么不展示`);
  }
  assert.ok(EVENT_FIELDS.length === 16, '采集面字段数变了，回去核对规格 §2 与这段文案');
});

test('🔴 隐私说明必须写清「为什么不能加下钻」，而不只是「我们没做」', () => {
  const src = read('components/privacy.jsx');
  for (const must of ['T-11', '再识别', '时间线', '去重计数']) {
    assert.ok(src.includes(must), `隐私说明里缺了关键词「${must}」`);
  }
});

test('🔴 代码注释里也要写清同一件事 —— 下一个来加功能的人先看的是代码', () => {
  const src = read('lib/whitelist.mjs');
  for (const must of ['T-11', '再识别', '下钻', '先去改规格']) {
    assert.ok(src.includes(must), `whitelist.mjs 的注释里缺了「${must}」`);
  }
});

test('隐私说明是常驻的：不许被折叠、不许挂在 tooltip 后面', () => {
  const page = read('app/page.jsx');
  assert.ok(page.includes('<PrivacyNotice />'), '首页必须常驻渲染隐私说明');
  const src = read('components/privacy.jsx');
  assert.ok(!/<details|<summary|title=/.test(src), '隐私说明不许折叠或藏进 tooltip');
});

test('🔴 页面按 §1 的三个问题组织，三句问句要原样出现', () => {
  const page = read('app/page.jsx');
  for (const q of ['哪些 skill 真的在被用', '装失败集中在哪', '一次安装要多久']) {
    assert.ok(page.includes(q), `首页少了 §1 的问题「${q}」`);
  }
});

test('🔴 页面上必须写明禁止把埋点用于信任判定（规格 §5.3）', () => {
  const layout = read('app/layout.jsx');
  assert.ok(layout.includes('信任判定') || layout.includes('信任决策'));
  assert.ok(layout.includes('趋势'), '要说清这是趋势信号不是精确指标');
});
