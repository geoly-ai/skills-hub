import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIMENSIONS, DISPLAYABLE_FIELDS, EVENT_FIELDS, IDENTITY_FIELDS, REASONS as DASH_REASONS,
} from '../lib/whitelist.mjs';

/*
 * 反漂移门。
 *
 * dashboard 的白名单是 `src/telemetry.mjs` 的**抄件**（理由写在 whitelist.mjs 顶部：
 * 独立 Vercel 项目不能跨项目根 import，那会让部署某天悄悄挂掉）。
 * 抄件的代价是会漂移，而漂移**不会让任何东西变红** —— 它只会让
 * 「页面上只展示采集到的东西」这句话某天变成一句假话。
 *
 * 这个测试在仓库里跑（同时看得见两边），把那句话钉住。
 * ⚠️ 加字段的顺序：先改 `src/telemetry.mjs`，再改 `dashboard/lib/whitelist.mjs`，
 *    最后改 `components/privacy.jsx` 的文案（那一条由 privacy-copy.test.mjs 管）。
 */

function walk(dir, prefix) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
      out.push(...walk(resolve(dir, e.name), rel));
    } else out.push(rel);
  }
  return out;
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TELEMETRY = resolve(REPO, 'src/telemetry.mjs');

test('🔴 与 src/telemetry.mjs 的 FIELD_NAMES 逐字相等', async (t) => {
  if (!existsSync(TELEMETRY)) {
    // dashboard 被单独拷出去构建时（Vercel Root Directory = dashboard/）仓库根不在场。
    // 那种情况下跳过是对的：这道门是**仓库内**的反漂移门，不是运行时依赖。
    t.skip('仓库根的 src/telemetry.mjs 不在场（独立构建环境），跳过反漂移门');
    return;
  }
  const { FIELD_NAMES } = await import(TELEMETRY);
  assert.deepEqual(
    [...EVENT_FIELDS].sort(), [...FIELD_NAMES].sort(),
    '采集面白名单漂移了：dashboard/lib/whitelist.mjs 与 src/telemetry.mjs 对不上',
  );
});

test('🔴🔴 REASONS 必须**双向**相等 —— 单向只挡住漏字段，挡不住「表被放宽成正则」', async (t) => {
  if (!existsSync(TELEMETRY)) { t.skip('仓库根不在场'); return; }
  const { REASONS } = await import(TELEMETRY);
  assert.deepEqual([...DASH_REASONS].sort(), [...REASONS].sort(),
    'reason 代码表漂移了。规格 §2.2 收紧成枚举正是为了「有限」——'
    + '这里只验单向（每个 REASONS 都过校验）的话，把 dashboard 换回正则也不会红');
  // 形状合法但不在表里的值必须被拒 —— 摄入面无鉴权，`reason: "alice"` 灌得进来
  for (const bad of ['alice', 'bob-smith', 'a', 'zzz-unknown']) {
    assert.equal(DIMENSIONS.reason.valueOk(bad), false, `${bad} 不在代码表里，不该通过`);
  }
});

test('🔴 KINDS / RESULTS / CLIENTS / SCOPES 与 dashboard 的枚举逐个对上', async (t) => {
  if (!existsSync(TELEMETRY)) { t.skip('仓库根不在场'); return; }
  const m = await import(TELEMETRY);
  const pairs = [['kind', m.KINDS], ['result', m.RESULTS], ['client', m.CLIENTS], ['scope', m.SCOPES]];
  for (const [dim, set] of pairs) {
    for (const v of set) {
      assert.ok(DIMENSIONS[dim].valueOk(v), `${dim} 的合法取值 ${v} 在 dashboard 这边过不了校验`);
    }
  }
});

// 🔴 这一条原来是「不展示的字段就是 schema / eid / install_id」。2026-09-09 加了身份
//    三项之后，它必然会红 —— 但**不能靠放宽它来修**（Codex 在那次评审里点名了这一点：
//    现有断言不能简单删掉，要拆成正向测试）。所以拆成两条，各自钉一件事：
//    ① 结构类隐藏字段仍然**恰好**是那三个（多一个少一个都要有人有意识地来改这行）
//    ② 身份字段**一个都不许**进这个匿名控制台的展示面
test('结构类不展示字段仍是 schema / eid / install_id，改动要有意识', () => {
  const hidden = EVENT_FIELDS
    .filter((f) => !DISPLAYABLE_FIELDS.includes(f) && !IDENTITY_FIELDS.includes(f));
  assert.deepEqual(hidden.sort(), ['eid', 'install_id', 'schema']);
});

test('🔴 身份字段一个都不出现在匿名控制台的展示面上', () => {
  for (const f of IDENTITY_FIELDS) {
    assert.ok(!DISPLAYABLE_FIELDS.includes(f), `身份字段 ${f} 混进了可展示字段`);
  }
  // 反过来也钉住：采集面里确实有它们（否则这条断言会因为「字段压根不存在」而空转通过）
  for (const f of ['os_user', 'host', 'notice']) {
    assert.ok(EVENT_FIELDS.includes(f), `采集面里没有 ${f} —— 这条断言正在空转`);
  }
});

test('🔴 匿名控制台不许 import 身份通道的任何东西', () => {
  // 身份数据归另一个 API、另一套 normalizer。这条挡的是「顺手在这边加个开关」。
  // 🔴 **扫目录，不写固定文件名单**：写死名单的话，新加一个模块就绕过去了，
  //    而绕过去这件事没有任何迹象（Codex 2026-09-09 指出）。
  //    白名单与隐私说明是**定义处**，它们当然要提到身份字段，所以排除掉。
  const EXCLUDE = new Set(['lib/whitelist.mjs', 'components/privacy.jsx']);
  const files = walk(resolve(REPO, 'dashboard'), '')
    .filter((f) => /\.(mjs|jsx|js)$/.test(f))
    .filter((f) => !f.startsWith('node_modules/') && !f.startsWith('test/') && !f.startsWith('.next/'))
    .filter((f) => !EXCLUDE.has(f));
  assert.ok(files.length >= 8, `只扫到 ${files.length} 个文件，扫描器八成没工作`);
  for (const f of files) {
    const text = readFileSync(resolve(REPO, 'dashboard', f), 'utf8');
    assert.ok(!/\bIDENTITY_FIELDS\b/.test(text),
      `${f} 引用了 IDENTITY_FIELDS —— 匿名通道不该知道身份字段的存在`);
    assert.ok(!/\bos_user\b|\bhost\b\s*[:,]/.test(text),
      `${f} 里出现了身份字段名`);
  }
});

test('🔴 每一个维度的 field 都必须在采集白名单里 —— 不许凭空发明维度', () => {
  for (const [k, spec] of Object.entries(DIMENSIONS)) {
    assert.ok(EVENT_FIELDS.includes(spec.field), `维度 ${k} 指向了一个不存在的采集字段 ${spec.field}`);
    assert.ok(DISPLAYABLE_FIELDS.includes(spec.field), `维度 ${k} 指向了一个不许展示的字段 ${spec.field}`);
    assert.equal(typeof spec.valueOk, 'function', `维度 ${k} 缺取值校验器`);
  }
});

test('🔴 页面上没有一个不在白名单里的指标：全仓源码不许出现被禁的词', () => {
  // 这些是「为了页面好看编一个」最常见的形态 —— 本仓库反复踩过的坑
  const banned = [
    'downloads', 'stars', 'rating', 'referrer', 'country', 'region', 'city',
    'ip_address', 'user_agent', 'username', 'email', 'project_name', 'home_dir',
  ];
  const files = ['lib/whitelist.mjs', 'lib/normalize.mjs', 'components/dimension-table.jsx',
    'components/durations.jsx', 'app/page.jsx'];
  for (const f of files) {
    // ⚠️ 先剥注释：注释里正是在**说明**这些东西为什么不采集
    //    （「没有用户名、没有路径、没有 referrer」），那不是一个指标。
    const text = readFileSync(resolve(REPO, 'dashboard', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const w of banned) {
      assert.ok(!new RegExp(`\\b${w}\\b`).test(text), `${f} 里出现了被禁的指标名 ${w}`);
    }
  }
});
