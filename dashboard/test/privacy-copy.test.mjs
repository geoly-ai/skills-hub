import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENT_FIELDS } from '../lib/whitelist.mjs';

/*
 * 隐私契约的看门狗。
 *
 * 面板是唯一一个非工程同事也会看的界面，隐私契约要在那里被**反复看见**。
 * site/ 那边有同一类测试（`test/dashboard-parity.test.mjs`），这里照做：
 * 🔴 **加字段不改文案就会红。**
 *
 * 2026-09-14 值班台重做（DESIGN.md §3.2）：原来那一整块常驻长文拆成两处 ——
 *   · components/collection-bar.jsx：常驻每一页、不可折叠的**契约条**（三句硬内容）
 *   · components/privacy.jsx：「口径与边界」页的**长论证**（文件名沿用，
 *     因为 test/whitelist-drift.test.mjs 把它登记为身份字段清单的唯一定义处）
 *   断言一条没删，只是各自指向真正承载它的文件；并补上「契约条确实挂在每一页骨架上」。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(HERE, '..', p), 'utf8');

test('字段表从白名单渲染，被隐藏的字段与身份字段都点名并说明为什么', () => {
  const bar = read('components/collection-bar.jsx');
  assert.match(bar, /DISPLAYABLE_FIELDS\.map/, '契约条的字段 chip 必须从白名单渲染，不许手抄一遍');

  const src = read('components/privacy.jsx');
  assert.match(src, /DISPLAYABLE_FIELDS\.map/, '口径页的字段表必须从白名单渲染');
  assert.ok(src.includes('EVENT_FIELDS'), '被隐藏的字段也要列出来，并说明为什么');
  for (const f of ['install_id', 'eid', 'schema']) {
    assert.ok(src.includes(f), `口径页里必须点名 ${f} 并说明它为什么不展示`);
  }
  // 🔴 这个数字是**故意写死**的：它不是「有几个字段」，是「文案与规格对过账了」。
  //    2026-09-09 从 16 变成 19（加了 os_user / host / notice）；
  //    2026-09-10 变成 20（加了 pubkey —— 删除时用来证明「这批数据是我的」）。
  //    再变的时候请连着这段文案一起看，不要只把数字改大。
  assert.ok(EVENT_FIELDS.length === 20, '采集面字段数变了，回去核对规格 §2 与这段文案');
  // 🔴 这里**不能**写成 `src.includes(f) || src.includes('IDENTITY_FIELDS')` ——
  //    import 行里就有 IDENTITY_FIELDS，右边恒真，整条断言空转。
  //    （Codex 2026-09-09 揪出来的：这正是本仓库最常犯的「看起来守住了」。）
  //    判据改成**渲染出来的东西**：组件必须真的把身份字段渲染成一份清单。
  assert.match(src, /identityHidden\.map/,
    '身份字段必须被渲染成一份清单，而不是只在 import 里出现过');
  assert.match(src, /IDENTITY_FIELDS\.includes/,
    '清单必须从白名单推导，不许手抄');
  assert.match(src, /自报/, '不许把客户端自报的用户名/主机名说成「真实归属」');
  assert.match(src, /默认关闭/, '必须写明身份字段默认是关的');
});

test('🔴 口径页必须写清「为什么不能加下钻」，而不只是「我们没做」', () => {
  const src = read('components/privacy.jsx');
  for (const must of ['T-11', '再识别', '时间线', '去重计数']) {
    assert.ok(src.includes(must), `口径页里缺了关键词「${must}」`);
  }
});

test('🔴 代码注释里也要写清同一件事 —— 下一个来加功能的人先看的是代码', () => {
  const src = read('lib/whitelist.mjs');
  for (const must of ['T-11', '再识别', '下钻', '先去改规格']) {
    assert.ok(src.includes(must), `whitelist.mjs 的注释里缺了「${must}」`);
  }
});

test('🔴 契约条是常驻的：挂在每一页的骨架上，不许折叠、不许挂在 tooltip 后面', () => {
  const shell = read('components/shell.jsx');
  assert.ok(shell.includes('<CollectionBar />'), '骨架必须常驻渲染契约条');
  for (const p of ['app/page.jsx', 'app/boundary/page.jsx']) {
    assert.match(read(p), /<Shell\b/, `${p} 必须套骨架（于是必然带契约条）`);
  }
  const bar = read('components/collection-bar.jsx');
  assert.ok(!/<details|<summary|title=/.test(bar), '契约条不许折叠或藏进 tooltip');
  // 三句硬内容（DESIGN.md §3.2）：少一句都不行
  assert.match(bar, /DISPLAYABLE_FIELDS\.length/, '① 这一页只能有这些字段');
  assert.match(bar, /install_id 只拿来去重计数，不显示/, '② install_id 不上屏');
  assert.match(bar, /MIN_INSTALLS\} 台的细分不展示/, '③ 有小样本抑制');
});

test('🔴 登录页上没有契约条、没有骨架 —— 那时我们还没问过任何东西（DESIGN.md §15）', () => {
  const login = read('app/login/page.jsx');
  assert.ok(!/CollectionBar|<Shell\b|statechip/.test(login));
  // 只看指令位置（文件顶部）与真实标签；注释里提到 'use client' 是在解释为什么没有它
  assert.ok(!/^\s*['"]use client['"]/m.test(login) && !/<script/.test(login), '登录页不许有客户端 JS');
});

test('🔴 页面按 §1 的三个问题组织，三句问句要原样出现', () => {
  const page = read('app/page.jsx');
  for (const q of ['哪些 skill 真的在被用', '装失败集中在哪', '一次安装要多久']) {
    assert.ok(page.includes(q), `首页少了 §1 的问题「${q}」`);
  }
});

test('🔴 页面上必须写明禁止把埋点用于信任判定（规格 §5.3）', () => {
  // 骨架的侧栏底部常驻这一句（重做前在 layout 的页脚里）
  const shell = read('components/shell.jsx');
  assert.ok(shell.includes('信任判定') || shell.includes('信任决策'));
  assert.ok(shell.includes('趋势'), '要说清这是趋势信号不是精确指标');
});
