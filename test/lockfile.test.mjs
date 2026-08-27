// lockfile：按 target 分组的投影 + 消费它时的可验证闭包。
//
// 🔴 lockfile 是**仓库里的未签名文件**。这些测试全都在证明「它骗不了我们」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerSkeleton } from '../src/ledger.mjs';
import {
  LOCKFILE_SCHEMA, artifactName, projectLockfile, rootKind, validateLockfileShape,
  verifyLockfileClosure,
} from '../src/lockfile.mjs';

const AT = '2026-08-26T00:00:00Z';
const D = (c) => `geoly-tree-v1:sha256:${String(c).repeat(64).slice(0, 64)}`;
const S = (c) => `sha256:${String(c).repeat(64).slice(0, 64)}`;
const META = (p) => ({ client: 'claude', fstype: 'apfs', path: p, realpath: p, scope: 'project' });

function ledgerWith() {
  return {
    ...ledgerSkeleton(META('.claude/skills')),
    entries: {
      dev: { artifact: 'skill:geoly/dev@0.3.6', generation: 7, installed_at: AT, requested_by: ['pack:geoly/m@0.3.6'], snapshot: 42, state: 'ok', tree_digest: D('1') },
      qa: { artifact: 'skill:geoly/qa@0.3.6', generation: 7, installed_at: AT, requested_by: ['pack:geoly/m@0.3.6'], snapshot: 42, state: 'ok', tree_digest: D('2') },
    },
    roots: {
      'pack:geoly/m@0.3.6': { artifact: 'pack:geoly/m@0.3.6', intent: { allow_yanked: true, no_bundled: false, pre: false }, kind: 'pack', requested_at: AT, snapshot: 42, tree_digest: D('3') },
    },
  };
}
const targets = () => [{
  assetSha256: { dev: S('a'), qa: S('b') },
  client: 'claude', ledger: ledgerWith(), path: '.claude/skills', scope: 'project',
}];

test('投影：按 target 分组、逐层排序、每个 entry 带自己的 requested_by', () => {
  const lf = projectLockfile({ registry: 'geoly-ai/skills-hub', targets: targets() });
  assert.equal(lf.schema, LOCKFILE_SCHEMA);
  assert.equal(lf.targets.length, 1);
  assert.deepEqual(lf.targets[0].entries.map((e) => e.name), ['dev', 'qa']);
  assert.deepEqual(lf.targets[0].entries[0].requested_by, ['pack:geoly/m@0.3.6']);
  assert.ok(validateLockfileShape(lf));
});

test('🔴 lockfile 的 intent 里**没有** allow_yanked —— 未签名文件不得授予该例外', () => {
  const lf = projectLockfile({ registry: 'r', targets: targets() });
  assert.deepEqual(Object.keys(lf.targets[0].roots[0].intent).sort(), ['no_bundled', 'pre']);
  const bad = structuredClone(lf);
  bad.targets[0].roots[0].intent.allow_yanked = true;
  assert.throws(() => validateLockfileShape(bad), /未知字段 allow_yanked/);
});

test('🔴 明确不进 lockfile 的本机运行历史：generation / installed_at / state / fstype', () => {
  const lf = projectLockfile({ registry: 'r', targets: targets() });
  const text = JSON.stringify(lf);
  for (const k of ['generation', 'installed_at', 'requested_at', 'fstype', 'realpath']) {
    assert.ok(!text.includes(`"${k}"`), `${k} 不该出现在 lockfile 里`);
  }
});

test('🔴 entries[].name 必须精确等于 artifact 的 name —— 这是比 target path 更直接的写入逃逸口', () => {
  const lf = projectLockfile({ registry: 'r', targets: targets() });
  const evil = structuredClone(lf);
  evil.targets[0].entries[0].name = '.geoly';
  assert.throws(() => validateLockfileShape(evil), /name|路径/);
  const evil2 = structuredClone(lf);
  evil2.targets[0].entries[0].artifact = 'skill:geoly/other@0.3.6';
  assert.throws(() => validateLockfileShape(evil2), /!= artifact 的 name/);
});

test('🔴 target path 只能由 adapter 推导；绝对路径与 .. 一律拒绝', () => {
  const lf = projectLockfile({ registry: 'r', targets: targets() });
  const o = { adapterProjectPath: () => '.claude/skills', knownClient: (c) => c === 'claude' };
  assert.ok(verifyLockfileClosure(lf, o).unproven.length > 0, '没注入 resolver 时必须如实标注未证明');
  const evil = structuredClone(lf);
  evil.targets[0].path = '../../etc/skills';
  assert.throws(() => verifyLockfileClosure(evil, o), /只能由 adapter 推导/);
  assert.throws(() => verifyLockfileClosure(lf, { ...o, knownClient: () => false }), /不是已知 adapter/);
});

test('🔴 双向图闭合：删掉 pack 的必装成员，剩下的 entries 仍「个个闭合」也必须被抓住', () => {
  const lf = projectLockfile({ registry: 'r', targets: targets() });
  const expected = [
    { artifact: 'skill:geoly/dev@0.3.6', asset_sha256: S('a'), name: 'dev', tree_digest: D('1') },
    { artifact: 'skill:geoly/qa@0.3.6', asset_sha256: S('b'), name: 'qa', tree_digest: D('2') },
  ];
  const o = {
    adapterProjectPath: () => '.claude/skills',
    knownClient: () => true,
    resolveRoot: () => ({ entries: expected }),
  };
  assert.ok(verifyLockfileClosure(lf, o).ok);
  const evil = structuredClone(lf);
  evil.targets[0].entries = evil.targets[0].entries.filter((e) => e.name !== 'qa');
  assert.throws(() => verifyLockfileClosure(evil, o), /缺少期望图里的成员 qa/);
});

test('🔴 顶点标签也要逐字段相等：同名同边但换成另一个已签名 artifact 必须被拒', () => {
  const lf = projectLockfile({ registry: 'r', targets: targets() });
  const o = {
    adapterProjectPath: () => '.claude/skills',
    knownClient: () => true,
    resolveRoot: () => ({
      entries: [
        { artifact: 'skill:geoly/dev@0.3.6', asset_sha256: S('a'), name: 'dev', tree_digest: D('1') },
        { artifact: 'skill:geoly/qa@0.3.6', asset_sha256: S('b'), name: 'qa', tree_digest: D('2') },
      ],
    }),
  };
  const evil = structuredClone(lf);
  evil.targets[0].entries[0].tree_digest = D('9');
  assert.throws(() => verifyLockfileClosure(evil, o), /tree_digest 与重解析结果不等/);
});

test('🔴 root 的顶点标签按三种 root 各自定义（direct 是 "direct:" + artifact）', () => {
  assert.equal(rootKind('pack:geoly/m@1'), 'pack');
  assert.equal(rootKind('direct:skill:geoly/d@1'), 'direct');
  assert.equal(rootKind('all@snapshot:42'), 'all');
  assert.throws(() => rootKind('weird'), /grammar/);
  assert.equal(artifactName('skill:geoly/plaud-theme-dev@0.3.6'), 'plaud-theme-dev');
});

test('🔴 all@snapshot 的 record 不带 artifact / tree_digest，且 N 必须与 snapshot 一致', () => {
  const L = ledgerWith();
  L.roots = { 'all@snapshot:42': { intent: { no_bundled: false, pre: false }, kind: 'all', requested_at: AT, snapshot: 42 } };
  L.entries.dev.requested_by = ['all@snapshot:42'];
  L.entries.qa.requested_by = ['all@snapshot:42'];
  const lf = projectLockfile({
    registry: 'r',
    targets: [{ assetSha256: { dev: S('a'), qa: S('b') }, client: 'claude', ledger: L, path: '.claude/skills', scope: 'project' }],
  });
  assert.ok(!('artifact' in lf.targets[0].roots[0]));
  const evil = structuredClone(lf);
  evil.targets[0].roots[0].snapshot = 43;
  assert.throws(() => validateLockfileShape(evil), /snapshot 必须与 key 里的 N 一致/);
});

test('🔴 requested_by 指向同一 target 里不存在的 root → 拒绝', () => {
  const L = ledgerWith();
  L.entries.dev.requested_by = ['pack:geoly/ghost@1'];
  assert.throws(() => projectLockfile({
    registry: 'r',
    targets: [{ assetSha256: { dev: S('a'), qa: S('b') }, client: 'claude', ledger: L, path: '.claude/skills', scope: 'project' }],
  }), /不存在的 root/);
});
