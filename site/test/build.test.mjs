// 数据管道的测试。跑法：`npm test --prefix site`（不动仓库根的 npm test）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectData } from '../build.mjs';
import { makeFixtureRegistry } from './fixture.mjs';

const fixture = makeFixtureRegistry();
const data = collectData({ snapshotsDir: fixture.snapshotsDir, artifactsRoot: fixture.artifactsRoot });
const byId = new Map(data.artifacts.map((a) => [a.id, a]));

test('空 registry：目录不存在 → 正常产出空状态，不是报错', () => {
  const d = collectData({ snapshotsDir: join(tmpdir(), 'geoly-site-does-not-exist-9d3f') });
  assert.equal(d.empty, true);
  assert.match(d.empty_reason, /不存在/);
  assert.equal(d.prerequisites.length, 3, '空状态必须指向 docs/m3/02-decisions.md 的三件上线前置');
  assert.equal(d.artifacts, undefined, '空状态不该编出一个空制品列表来');
});

test('空 registry：目录在但没有可识别的快照文件 → 也是空状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geoly-site-empty-'));
  writeFileSync(join(dir, 'README.md'), '# 还没有快照\n');
  const d = collectData({ snapshotsDir: dir });
  assert.equal(d.empty, true);
  assert.match(d.empty_reason, /没有可识别的快照文件/);
});

test('🔴 真故障不能被伪装成空 registry', () => {
  // `newestSnapshot()` 用同一个 TimestampError 报「没有快照」和「快照号超出安全整数范围」。
  // 后者是磁盘上确实有东西但读不对 —— 吞掉它，页面就会平静地宣布 registry 是空的。
  const dir = mkdtempSync(join(tmpdir(), 'geoly-site-bogus-'));
  writeFileSync(join(dir, 'hub-9007199254740993.json'), '{}');
  assert.throws(() => collectData({ snapshotsDir: dir }), /安全整数范围/);
});

test('快照来源：文件名编号与内部编号分别摆出来', () => {
  assert.equal(data.empty, false);
  assert.equal(data.source.file_number, 42);
  assert.equal(data.source.internal_number, 42);
  assert.equal(data.source.number_agrees, true);
  assert.match(data.source.sha256, /^sha256:[0-9a-f]{64}$/);
});

test('record 的每一个快照字段都进了模型', () => {
  const a = byId.get('skill:geoly/plaud-theme-dev@0.3.6');
  for (const k of ['id', 'kind', 'namespace', 'name', 'version', 'path', 'tree_digest', 'asset',
    'clients', 'capabilities', 'replaces', 'conflicts', 'license', 'owner', 'provenance', 'status', 'review']) {
    assert.ok(a[k] !== undefined, `缺字段 ${k}`);
  }
  assert.match(a.tree_digest, /^geoly-tree-v1:sha256:[0-9a-f]{64}$/);
  assert.match(a.asset.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.install_command, 'skills-hub install skill:geoly/plaud-theme-dev@0.3.6');
});

test('capability 的 Tier 按 §7 那张表标注', () => {
  const t = (id) => Object.fromEntries(byId.get(id).capabilities.map((c) => [c.name, c.tier]));
  assert.deepEqual(t('skill:geoly/plaud-theme-shared@0.3.6'), { none: 0 });
  assert.deepEqual(t('skill:geoly/plaud-theme-dev@0.3.6'), { network: 1 });
  assert.deepEqual(t('skill:acme/report-writer@2.0.0'), { 'external-tool': 1 });
  assert.deepEqual(t('skill:geoly/legacy-runner@1.0.0'), { shell: 2, credentials: 2 });
});

test('🔴 声明 Tier 与 review.capability_tier 是两个数，不合并', () => {
  const pack = byId.get('pack:geoly/plaud-theme-matrix@0.3.6');
  assert.equal(pack.declared_tier, 1, 'capabilities 并集只到 Tier 1');
  assert.equal(pack.review.capability_tier, 2, 'contract_paths 变更强制 Tier 2（D8）');
});

test('yank 的 reason / advisory / superseded_by 都在', () => {
  const y = byId.get('skill:geoly/legacy-runner@1.0.0');
  assert.equal(y.status, 'yanked');
  assert.equal(y.yank.advisory, 'GSA-2026-0001');
  assert.match(y.yank.reason, /credentials/);
  assert.equal(y.yank.superseded_by, 'skill:geoly/legacy-runner@1.1.0-rc.1');
});

test('latest 投影：排除 yanked / degraded / 预发布', () => {
  assert.equal(data.latest['skill:geoly/plaud-theme-dev'], '0.3.6');
  assert.equal(data.latest['skill:geoly/legacy-runner'], undefined, '唯一的正式版被 yank 了');
  assert.equal(data.latest['pack:geoly/legacy-matrix'], undefined, 'degraded 不进 latest');
  const g = data.groups.find((x) => x.key === 'pack:geoly/legacy-matrix');
  assert.match(g.latest_absent_reason, /没有可安装版本/);
});

test('版本历史：同名制品的全部版本，从新到旧', () => {
  const g = data.groups.find((x) => x.key === 'skill:geoly/legacy-runner');
  assert.deepEqual(g.versions, [
    'skill:geoly/legacy-runner@1.1.0-rc.1',
    'skill:geoly/legacy-runner@1.0.0',
  ], '预发布 1.1.0-rc.1 比 1.0.0 新');
  assert.equal(byId.get('skill:geoly/legacy-runner@1.1.0-rc.1').is_prerelease, true);
});

test('pack：成员列表 + 派生字段复算 + degraded 归因', () => {
  const p = byId.get('pack:geoly/legacy-matrix@0.1.0');
  assert.equal(p.status, 'degraded');
  assert.equal(p.pack.members_available, true);
  assert.deepEqual(p.pack.members.map((m) => m.id), [
    'skill:geoly/plaud-theme-shared@0.3.6',
    'skill:geoly/legacy-runner@1.0.0',
  ]);
  assert.ok(p.pack.members.every((m) => m.digest_matches === true));
  assert.equal(p.pack.derived.clients_match, true);
  assert.equal(p.pack.derived.capabilities_match, true);
  assert.equal(p.pack.blame.matches_snapshot, true);
  assert.equal(p.pack.blame.complete, true);
  assert.deepEqual(p.pack.blame.degraded_by.map((d) => d.id), ['skill:geoly/legacy-runner@1.0.0']);
  assert.equal(p.pack.blame.degraded_by[0].reason, 'yanked');
});

test('🔴 归因不完整的检测要走到第二层以下', () => {
  // l0 → l1 → l2 三层。抽掉 **l2** 的载荷（不是直接成员 l1）——
  // 只看「闭包键集 + 根的直接成员」的实现会漏掉它，然后把一次不完整的归因宣布成完整的。
  const partial = makeFixtureRegistry();
  rmSync(join(partial.artifactsRoot, 'packs/geoly/l2-matrix'), { recursive: true });
  const d = collectData({ snapshotsDir: partial.snapshotsDir, artifactsRoot: partial.artifactsRoot });
  const l0 = d.artifacts.find((a) => a.id === 'pack:geoly/l0-matrix@0.1.0');
  assert.equal(l0.pack.members_available, true, 'l0 自己的载荷还在');
  assert.equal(l0.pack.blame.complete, false);
  assert.deepEqual(l0.pack.blame.opaque_packs, ['pack:geoly/l2-matrix@0.1.0']);
});

test('🔴 拿不到载荷时不展示 description 与 pack 成员', () => {
  // 快照 record 里根本没有 description / members，所以载荷缺席时它们必须缺席。
  const d = collectData({
    snapshotsDir: fixture.snapshotsDir,
    artifactsRoot: join(tmpdir(), 'geoly-site-no-artifacts-7c1a'),
  });
  for (const a of d.artifacts) {
    assert.equal(a.payload.state, 'absent');
    assert.equal(a.description, null, `${a.id} 没有载荷却有 description`);
    if (a.kind === 'pack') assert.equal(a.pack.members_available, false);
  }
});

test('路由段安全：生成的链接不含 .. 或多余的路径分隔', () => {
  for (const a of data.artifacts) {
    assert.match(a.href, /^\/artifact\/(skill|pack)\/[a-z0-9-]+\/[a-z0-9-]+\/[A-Za-z0-9.-]+$/);
    assert.ok(!a.href.includes('..'));
    assert.equal(a.href, `${a.group_href}/${a.version}`);
  }
});

test('🔴 模型里不存在任何使用量字段', () => {
  const json = JSON.stringify(data);
  for (const banned of ['downloads', 'installs', 'install_count', 'popularity', 'trending', 'stars', 'usage_count']) {
    assert.ok(!json.includes(banned), `模型里出现了 ${banned}`);
  }
});
