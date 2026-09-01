import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIMENSIONS, DISPLAYABLE_FIELDS, EVENT_FIELDS, REASONS as DASH_REASONS,
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

test('三个不展示的字段就是 schema / eid / install_id，改动要有意识', () => {
  const hidden = EVENT_FIELDS.filter((f) => !DISPLAYABLE_FIELDS.includes(f));
  assert.deepEqual(hidden.sort(), ['eid', 'install_id', 'schema']);
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
