// 可安装清单的反漂移门 —— `registry/catalog.md`。
//
// 🔴 判据是**逐字节相等**：重新生成一遍，与仓库里那份一字不差。
//    这同时挡住两种漂移：
//      · 改了快照忘了重新生成清单（agent 会看不到新 skill，或去装一个不存在的）
//      · 有人手改了清单（那份手改在下一次 promote 时会被无声冲掉）
//    这个仓库今天已经四次靠这类对账门抓到「改了一边忘了另一边」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseStrict } from '../src/canonical-json.mjs';
import {
  newestSnapshotPath, oneLine, renderCatalog, tierOf,
} from '../scripts/promote/build-catalog.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(REPO, 'registry', 'catalog.md');

const snapshot = () => parseStrict(readFileSync(newestSnapshotPath(), 'utf8'));
const render = () => `${renderCatalog({ snapshot: snapshot(), artifactsRoot: join(REPO, 'artifacts') })}\n`;

test('🔴 清单与最新快照逐字节一致（改了快照就要重新生成）', () => {
  assert.ok(existsSync(CATALOG), 'registry/catalog.md 不存在');
  assert.equal(readFileSync(CATALOG, 'utf8'), render(),
    '清单与快照对不上 —— 跑 `node scripts/promote/build-catalog.mjs` 重新生成');
});

test('🔴 生成是确定性的：连跑两次字节相同', () => {
  assert.equal(render(), render());
});

// 🔴 正向断言：快照里每一个 published 制品都必须在清单里出现。
//    只比字节的话，一个「两边都漏了同一个制品」的 bug 照样绿。
test('🔴 快照里的每个 published 制品都在清单里', () => {
  const text = readFileSync(CATALOG, 'utf8');
  const live = snapshot().artifacts.filter((r) => r.status === 'published');
  assert.ok(live.length >= 30, `只有 ${live.length} 个 published，快照像是没读对`);
  for (const r of live) {
    assert.ok(text.includes(`\`${r.id}\``), `清单里缺 ${r.id}`);
  }
});

// 反向：清单里出现的每个 id 都必须来自快照 —— 不许凭空多出一个。
test('🔴 清单里没有快照之外的 id', () => {
  const text = readFileSync(CATALOG, 'utf8');
  const known = new Set(snapshot().artifacts.map((r) => r.id));
  const ids = [...text.matchAll(/`((?:skill|pack):[^`]+@[^`]+)`/g)].map((m) => m[1]);
  assert.ok(ids.length >= 30, `只从清单里解析出 ${ids.length} 个 id，正则八成没匹配上`);
  for (const id of ids) assert.ok(known.has(id), `清单里的 ${id} 不在快照里`);
});

// 🔴 非 published 的必须被单独列出并明说不要装 —— 它们仍在快照里（历史不可变），
//    agent 一旦把它们当成「旧版本还能用」就会去装一个已经下架的东西。
test('🔴 非 published 的制品不混进可装区', () => {
  const text = readFileSync(CATALOG, 'utf8');
  const dead = snapshot().artifacts.filter((r) => r.status !== 'published');
  for (const r of dead) {
    assert.ok(text.includes('不要装'), '有非 published 制品，但清单里没有「不要装」这一节');
    assert.ok(text.includes(`\`${r.id}\``), `下架的 ${r.id} 没被列出来`);
  }
  if (dead.length === 0) assert.ok(!text.includes('## 不要装'), '没有下架制品却出现了那一节');
});

test('🔴 Tier 判据与 build-inputs 一致：认不出来的按最高档', () => {
  assert.equal(tierOf(['none']), 0);
  assert.equal(tierOf(['network']), 1);
  assert.equal(tierOf(['external-tool']), 1);
  assert.equal(tierOf(['shell']), 2);
  assert.equal(tierOf(['none', 'credentials']), 2, '取的是最大值，不是第一个');
  assert.equal(tierOf(['某个没见过的能力']), 2, '认不出来必须按最高档，不是忽略');
  assert.equal(tierOf([]), 0);
});

// 🔴 描述来自投稿者，里面可能有换行与竖线 —— 换行撕开表格，竖线多切一列。
test('🔴 描述折行与转义：不许把表格撕开', () => {
  assert.equal(oneLine('a\nb\tc   d'), 'a b c d');
  assert.equal(oneLine('a|b'), 'a\\|b', '竖线要转义，不是删掉 —— 删掉是改了别人的文案');
  assert.equal(oneLine('x'.repeat(200)).length, 111, '截断长度必须固定');
  assert.ok(!oneLine('x'.repeat(200)).includes('\n'));
  assert.equal(oneLine(undefined), '');
  assert.equal(oneLine(null), '');
});

test('清单里写清了 Tier 2 的风险与安装形状', () => {
  const text = readFileSync(CATALOG, 'utf8');
  assert.match(text, /npx @geoly-ai\/skills-hub install skill:/);
  assert.match(text, /npx @geoly-ai\/skills-hub install pack:/);
  assert.match(text, /Tier 2/, '没有提醒 Tier 2 的风险');
  assert.match(text, /不要手改/, '没有写明这是生成物');
});
