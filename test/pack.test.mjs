// pack 模型 —— 03-packs.md §2 / §3 / §3.1 / §4 / §4.1 / §4.2 / §5。
// 🔴 断言的是**具体那一条**（WireError.violation），不是「抛了错」。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArtifactId, formatArtifactId, parseRootKey,
  parseConflictPattern, conflictMatches,
  validateContractPath, matchContractPath, effectiveContractPaths, contractPathsChanged,
  assertPreviousIsDirectAncestor, checkPackCompat,
  validatePackManifest, derivePackClients, derivePackCapabilities,
  computePackStatus, computePackStatusClosure,
  selectInstallableVersion, explainNoInstallableVersion,
  resolvePackInstall, addRequestedBy, removeRequestedBy, assertRefGraphClosed,
  diffPackMembers,
} from '../src/pack.mjs';
import { packDoc, packRecord } from './fixtures/pack-tree.mjs';

// 🔴 只用 hex 字符：assertTreeDigest 校的是 64 位小写 hex，随手写个 'l' 会让
//    「本该通过的用例」以完全无关的理由变红，读起来像被测代码有问题。
const D = (c) => 'geoly-tree-v1:sha256:' + String(c).repeat(64).slice(0, 64);

function expectViolation(want, fn) {
  try { fn(); } catch (err) {
    assert.equal(err.violation ?? err.code, want, `期望 ${want}，实际 ${err.violation ?? err.code}：${err.message}`);
    return err;
  }
  assert.fail(`期望 ${want}，但没有抛错`);
}

// ── §2 ArtifactId ──────────────────────────────────────────────────────────

test('parseArtifactId：精确版本才收，range 一律拒（§2 成员锁定）', () => {
  const a = parseArtifactId('skill:geoly/plaud-theme-dev@0.3.6');
  assert.deepEqual(
    { kind: a.kind, namespace: a.namespace, name: a.name, version: a.version },
    { kind: 'skill', namespace: 'geoly', name: 'plaud-theme-dev', version: '0.3.6' });
  assert.equal(formatArtifactId(a), 'skill:geoly/plaud-theme-dev@0.3.6');
  for (const bad of ['skill:geoly/dev@^0.3.6', 'skill:geoly/dev@~0.3', 'skill:geoly/dev@*', 'skill:geoly/dev@ 0.3.6']) {
    expectViolation('E_SEMVER', () => parseArtifactId(bad));
  }
  expectViolation('E_SEMVER_BUILD', () => parseArtifactId('skill:geoly/dev@0.3.6+build1'));
  expectViolation('E_ARTIFACT_ID', () => parseArtifactId('bundle:geoly/dev@0.3.6'));
  expectViolation('E_ARTIFACT_ID', () => parseArtifactId('skill:geoly/a/b@0.3.6'));
  expectViolation('E_NAMESPACE', () => parseArtifactId('skill:Geoly/dev@0.3.6'));
  expectViolation('E_NAME', () => parseArtifactId('skill:geoly/-dev@0.3.6'));
});

test('parseArtifactId 与 snapshot 的 ns/name grammar 判定一致（防两份正则分叉）', async () => {
  const { parseSnapshot } = await import('../src/snapshot.mjs');
  const { stringify } = await import('../src/canonical-json.mjs');
  const cases = ['geoly', 'a', 'a-b', 'A', '-a', 'a-', 'a'.repeat(32), 'a'.repeat(33), 'a_b'];
  for (const ns of cases) {
    let mine = true;
    try { parseArtifactId(`skill:${ns}/dev@1.0.0`); } catch { mine = false; }
    const rec = { ...packRecord(), kind: 'skill', namespace: ns, name: 'dev', version: '1.0.0' };
    rec.id = `skill:${ns}/dev@1.0.0`;
    rec.path = `artifacts/skills/${ns}/dev/1.0.0`;
    const snap = {
      schema: 'geoly.skills.snapshot/2', snapshot: 1, previous: 0,
      created_at: '2026-01-01T00:00:00Z', repo: 'geoly-ai/skills-hub',
      artifacts: [rec], yanked: [], latest: { dev: '1.0.0' },
    };
    let theirs = true;
    try { parseSnapshot(Buffer.from(stringify(snap), 'utf8'), { expectSnapshot: 1 }); } catch (e) {
      theirs = !/E_NAMESPACE|E_NAME\b/.test(e.violation ?? '');
    }
    assert.equal(mine, theirs, `namespace ${JSON.stringify(ns)}：pack.mjs 判 ${mine}，snapshot.mjs 判 ${theirs}`);
  }
});

test('root key grammar：all@snapshot 的 N 不许有前导零（R-11 的别名问题）', () => {
  assert.equal(parseRootKey('pack:geoly/m@0.3.6').kind, 'pack');
  assert.equal(parseRootKey('direct:skill:geoly/d@0.3.6').kind, 'direct');
  assert.equal(parseRootKey('all@snapshot:42').snapshot, 42);
  expectViolation('E_ROOT_KEY', () => parseRootKey('all@snapshot:01'));
  expectViolation('E_ROOT_KEY', () => parseRootKey('../escape'));
  // pack: 前缀套一个 skill id：namespace 位变成 'skill:geoly'，由 grammar 挡下
  expectViolation('E_NAMESPACE', () => parseRootKey('pack:skill:geoly/d@1.0.0'));
  expectViolation('E_ROOT_KEY', () => parseRootKey('bundle:geoly/m@1.0.0'));
});

// ── §2.3 conflicts ─────────────────────────────────────────────────────────

test('conflicts 只支持三种形态，不支持正则', () => {
  assert.equal(parseConflictPattern('skill:geoly/x@1.0.0').form, 'exact');
  assert.equal(parseConflictPattern('skill:geoly/x').form, 'any-version');
  assert.equal(parseConflictPattern('skill:*/x').form, 'any-namespace');
  for (const bad of ['skill:ge*/x', 'skill:*/*', 'skill:*', '^skill:.*$', 'skill:geoly/x*']) {
    expectViolation('E_CONFLICT_FORM', () => parseConflictPattern(bad));
  }
});

test('conflictMatches 三种形态的命中面', () => {
  assert.equal(conflictMatches('skill:*/x', 'skill:other/x@9.9.9'), true);
  assert.equal(conflictMatches('skill:*/x', 'pack:other/x@9.9.9'), false, 'kind 必须相同');
  assert.equal(conflictMatches('skill:geoly/x', 'skill:geoly/x@0.0.1'), true);
  assert.equal(conflictMatches('skill:geoly/x', 'skill:other/x@0.0.1'), false);
  assert.equal(conflictMatches('skill:geoly/x@1.0.0', 'skill:geoly/x@1.0.1'), false);
});

// ── §3.1 contract_paths 的绕过面 ───────────────────────────────────────────

test('contract_paths 的 glob：* 只能整段、不跨 /、无 **', () => {
  assert.equal(matchContractPath('*/matrix-contract.md', 'plaud-theme-dev/matrix-contract.md'), true);
  assert.equal(matchContractPath('*/matrix-contract.md', 'a/b/matrix-contract.md'), false, '* 不跨 /');
  assert.equal(matchContractPath('a/b.md', 'a/b.md'), true);
  assert.equal(matchContractPath('a/b.md', 'x/a/b.md'), false, '整路径锚定');
  expectViolation('E_CONTRACT_PATH', () => validateContractPath('**/x.md'));
  expectViolation('E_CONTRACT_PATH', () => validateContractPath('foo*/x.md'));
  expectViolation('E_CONTRACT_PATH', () => validateContractPath('../x.md'));
  expectViolation('E_CONTRACT_PATH', () => validateContractPath('/x.md'));
});

test('🔴 护栏①：生效清单是本版 ∪ 上一版 —— 作者清空清单不能让门失效', () => {
  const eff = effectiveContractPaths([], ['a/contract.md', '*/x.md']);
  assert.deepEqual(eff, ['*/x.md', 'a/contract.md']);
});

test('🔴 护栏②：contract_paths 有任何增减都升 Tier 2', () => {
  assert.deepEqual(contractPathsChanged(['a'], ['a']), { changed: false, added: [], removed: [], tier: 1 });
  assert.equal(contractPathsChanged(['a', 'b'], ['a']).tier, 2);
  assert.equal(contractPathsChanged([], ['a']).tier, 2, '删也算变更');
});

test('§3 零差异门：改动 / 删除 / 改名 都拒绝 compatible', () => {
  const cp = ['shared/contract.md'];
  const base = new Map([['shared/contract.md', Buffer.from('契约 v1\n')]]);

  // 无差异 → 过
  assert.equal(checkPackCompat({
    kind: 'compatible', contractPaths: cp, currentFiles: new Map(base), previousFiles: base,
  }).ok, true);

  // 改内容 → 拒
  const changed = checkPackCompat({
    kind: 'compatible', contractPaths: cp,
    currentFiles: new Map([['shared/contract.md', Buffer.from('契约 v2\n')]]), previousFiles: base,
  });
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.differences, [{ path: 'shared/contract.md', why: 'changed' }]);

  // 删掉 → 拒（🔴 只比「两边都有的」会放行这一条）
  const removed = checkPackCompat({
    kind: 'compatible', contractPaths: cp, currentFiles: new Map(), previousFiles: base,
  });
  assert.equal(removed.ok, false);
  assert.deepEqual(removed.differences, [{ path: 'shared/contract.md', why: 'removed' }]);

  // 改名躲开 glob → 旧路径缺失即差异，仍然拒
  const renamed = checkPackCompat({
    kind: 'compatible', contractPaths: cp,
    currentFiles: new Map([['shared/contract-v2.md', Buffer.from('契约 v1\n')]]), previousFiles: base,
  });
  assert.equal(renamed.ok, false);

  // breaking 不过这道门
  assert.equal(checkPackCompat({
    kind: 'breaking', contractPaths: cp, currentFiles: new Map(), previousFiles: base,
  }).ok, true);
});

test('🔴 归一化只放过版本戳与日期，且必须同时报出逐字节差异供人复核', () => {
  const cp = ['c.md'];
  const r = checkPackCompat({
    kind: 'compatible', contractPaths: cp, currentVersion: '0.3.6', previousVersion: '0.3.5',
    currentFiles: new Map([['c.md', Buffer.from('版本 0.3.6 于 2026-08-27\n')]]),
    previousFiles: new Map([['c.md', Buffer.from('版本 0.3.5 于 2026-08-01\n')]]),
  });
  assert.equal(r.ok, true, '只有版本戳与日期变了 → 门放行');
  assert.deepEqual(r.strictDifferences, [{ path: 'c.md', why: 'changed' }], '逐字节确实变了');
  assert.deepEqual(r.normalizedOnly, ['c.md'], '🔴 必须点名交人复核，不能当没变过');
});

test('previous 必须是直接前一版 —— 跳版会漏掉中间版本的 contract_paths', () => {
  assert.equal(assertPreviousIsDirectAncestor('0.3.5', ['0.3.4', '0.3.5']).raw, '0.3.5');
  expectViolation('E_COMPAT_PREVIOUS', () => assertPreviousIsDirectAncestor('0.3.4', ['0.3.4', '0.3.5']));
});

// ── §2 pack.json 全量校验 ──────────────────────────────────────────────────

test('validatePackManifest 接受一份结构完整的 pack.json', () => {
  const m = validatePackManifest(packDoc());
  assert.equal(m.id, 'pack:geoly/plaud-theme-matrix@0.3.6');
  assert.equal(m.members.length, 2);
  assert.equal(m.bundled.length, 1);
});

test('🔴 role 必须与所在列表一致 —— 否则「必装还是可跳过」有两个答案', () => {
  expectViolation('E_PACK_ROLE', () => validatePackManifest(packDoc({
    members: [{ id: 'skill:geoly/a@1.0.0', tree_digest: D('a'), role: 'tool' }],
  })));
  expectViolation('E_PACK_ROLE', () => validatePackManifest(packDoc({
    bundled: [{ id: 'skill:geoly/b@1.0.0', tree_digest: D('b'), role: 'matrix' }],
  })));
});

test('成员不得重复、不得跨列表出现、不得自引用；members 不得为空', () => {
  expectViolation('E_PACK_MEMBER_DUP', () => validatePackManifest(packDoc({
    bundled: [{ id: 'skill:geoly/plaud-theme-dev@0.3.6', tree_digest: D('a'), role: 'tool' }],
  })));
  expectViolation('E_PACK_SELF_MEMBER', () => validatePackManifest(packDoc({
    members: [{ id: 'pack:geoly/plaud-theme-matrix@0.3.5', tree_digest: D('a'), role: 'matrix' }],
  })));
  expectViolation('E_PACK_NO_MEMBERS', () => validatePackManifest(packDoc({ members: [] })));
});

test('🔴 首版（previous 为 null）不得声明 compatible —— 没有可比对象等于空基线过门', () => {
  expectViolation('E_COMPAT_PREVIOUS', () => validatePackManifest(packDoc({
    compatibility: { previous: null, kind: 'compatible', breaking_reasons: [] },
  })));
  // breaking 可以
  assert.ok(validatePackManifest(packDoc({
    compatibility: { previous: null, kind: 'breaking', breaking_reasons: ['首版'] },
  })));
  // previous 必须严格小于本版
  expectViolation('E_COMPAT_PREVIOUS', () => validatePackManifest(packDoc({
    compatibility: { previous: '0.3.6', kind: 'breaking', breaking_reasons: ['x'] },
  })));
});

test('🔴 属性：validatePackManifest 接受的 doc，assertManifestBinding 也必须接受', async () => {
  const { assertManifestBinding } = await import('../src/artifact.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { stringify } = await import('../src/canonical-json.mjs');

  const variants = [
    packDoc(),
    packDoc({ bundled: [] }),
    packDoc({ conflicts: [], contract_paths: [] }),
    packDoc({ compatibility: { previous: null, kind: 'breaking', breaking_reasons: ['首版'] } }),
    packDoc({ members: [{ id: 'pack:geoly/other@1.0.0', tree_digest: D('e'), role: 'matrix' }], bundled: [] }),
  ];
  for (const doc of variants) {
    validatePackManifest(doc);   // 前提：本模块接受它
    const dir = mkdtempSync(join(tmpdir(), 'geoly-bind-'));
    try {
      writeFileSync(join(dir, 'pack.json'), stringify(doc));
      // 不该抛 —— 抛了就说明两个校验器的接受集合方向反了
      assertManifestBinding(packRecord(), dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// ── §2.1 推导 ──────────────────────────────────────────────────────────────

test('clients 取成员交集（bundled 不参与），capabilities 取全体并集', () => {
  const members = [
    { clients: ['claude', 'cursor', 'codex'], capabilities: ['none'] },
    { clients: ['claude', 'codex', 'agents'], capabilities: ['shell'] },
  ];
  const bundled = [{ clients: ['claude'], capabilities: ['network'] }];
  assert.deepEqual(derivePackClients(members), ['claude', 'codex']);
  assert.deepEqual(derivePackCapabilities([...members, ...bundled]), ['network', 'none', 'shell']);
  // 交集为空 → 空数组，由 promotion 拒绝
  assert.deepEqual(derivePackClients([{ clients: ['a'], capabilities: [] }, { clients: ['b'], capabilities: [] }]), []);
});

// ── §5 yank 闭包 ───────────────────────────────────────────────────────────

const M = validatePackManifest(packDoc());
const allPublished = () => ({ status: 'published' });

test('§5 四行表', () => {
  // 全部 published → published
  assert.equal(computePackStatus({ selfStatus: 'published', manifest: M, statusOf: allPublished }).status, 'published');
  // deprecated 成员仍可装
  assert.equal(computePackStatus({
    selfStatus: 'published', manifest: M,
    statusOf: (id) => ({ status: id.includes('dev') ? 'deprecated' : 'published' }),
  }).status, 'published');
  // 必装成员被 yank → degraded，且点名成员与 advisory
  const deg = computePackStatus({
    selfStatus: 'published', manifest: M,
    statusOf: (id) => id.includes('shared')
      ? ({ status: 'yanked', advisory: 'GSA-2026-0001' }) : ({ status: 'published' }),
  });
  assert.equal(deg.status, 'degraded');
  assert.deepEqual(deg.degradedBy.map(d => [d.id, d.reason, d.advisory]),
    [['skill:geoly/plaud-theme-shared@0.3.6', 'yanked', 'GSA-2026-0001']]);
  // 只有 bundled 被 yank → published + 告警
  const b = computePackStatus({
    selfStatus: 'published', manifest: M,
    statusOf: (id) => id.includes('yidian') ? ({ status: 'yanked' }) : ({ status: 'published' }),
  });
  assert.equal(b.status, 'published');
  assert.deepEqual(b.skippedBundled.map(x => x.id), ['skill:geoly/yidian-draft-pr@0.3.6']);
  // pack 自身被 yank
  assert.equal(computePackStatus({ selfStatus: 'yanked', manifest: M, statusOf: allPublished }).status, 'yanked');
});

test('🔴 成员缺失按 degraded 记（fail-open 会让引用了不存在成员的 pack 显示 published）', () => {
  const r = computePackStatus({
    selfStatus: 'published', manifest: M,
    statusOf: (id) => id.includes('shared') ? undefined : ({ status: 'published' }),
  });
  assert.equal(r.status, 'degraded');
  assert.equal(r.degradedBy[0].reason, 'missing');
});

test('degraded 不得作为 computePackStatus 的输入（它是输出，不是事实）', () => {
  expectViolation('E_PACK_STATUS_INPUT',
    () => computePackStatus({ selfStatus: 'degraded', manifest: M, statusOf: allPublished }));
});

test('🔴 嵌套 pack：degraded 沿必装边传递上来', () => {
  const inner = validatePackManifest(packDoc({
    name: 'inner', version: '1.0.0',
    members: [{ id: 'skill:geoly/leaf@1.0.0', tree_digest: D('d'), role: 'matrix' }],
    bundled: [], compatibility: { previous: null, kind: 'breaking', breaking_reasons: ['首版'] },
  }));
  const outer = validatePackManifest(packDoc({
    name: 'outer', version: '1.0.0',
    members: [{ id: 'pack:geoly/inner@1.0.0', tree_digest: D('e'), role: 'matrix' }],
    bundled: [], compatibility: { previous: null, kind: 'breaking', breaking_reasons: ['首版'] },
  }));
  const db = {
    'pack:geoly/outer@1.0.0': { status: 'published', manifest: outer },
    'pack:geoly/inner@1.0.0': { status: 'published', manifest: inner },
    'skill:geoly/leaf@1.0.0': { status: 'yanked', advisory: 'GSA-2026-0002' },
  };
  const closure = computePackStatusClosure({ rootId: 'pack:geoly/outer@1.0.0', lookup: (id) => db[id] });
  assert.equal(closure.get('pack:geoly/inner@1.0.0').status, 'degraded');
  assert.equal(closure.get('pack:geoly/outer@1.0.0').status, 'degraded',
    '内层 degraded 必须拖垮把它列为必装的外层');
});

test('🔴 嵌套 pack：成员图有环 → 报错，不是无限递归也不是「看情况」', () => {
  const a = validatePackManifest(packDoc({
    name: 'a', version: '1.0.0',
    members: [{ id: 'pack:geoly/b@1.0.0', tree_digest: D('b'), role: 'matrix' }],
    bundled: [], compatibility: { previous: null, kind: 'breaking', breaking_reasons: ['x'] },
  }));
  const b = validatePackManifest(packDoc({
    name: 'b', version: '1.0.0',
    members: [{ id: 'pack:geoly/a@1.0.0', tree_digest: D('a'), role: 'matrix' }],
    bundled: [], compatibility: { previous: null, kind: 'breaking', breaking_reasons: ['x'] },
  }));
  const db = {
    'pack:geoly/a@1.0.0': { status: 'published', manifest: a },
    'pack:geoly/b@1.0.0': { status: 'published', manifest: b },
  };
  expectViolation('E_PACK_CYCLE',
    () => computePackStatusClosure({ rootId: 'pack:geoly/a@1.0.0', lookup: (id) => db[id] }));
});

// ── §5 latest ──────────────────────────────────────────────────────────────

test('🔴 latest 排除 degraded / yanked / 预发布', () => {
  const cands = [
    { version: '0.3.4', status: 'published' },
    { version: '0.3.5', status: 'published' },
    { version: '0.3.6', status: 'degraded' },
    { version: '0.3.7', status: 'yanked' },
    { version: '0.4.0-rc.1', status: 'published' },
  ];
  assert.equal(selectInstallableVersion(cands).version, '0.3.5');
  assert.equal(selectInstallableVersion(cands, { pre: true }).version, '0.4.0-rc.1');
  // 全部 degraded → null，并列出每个版本被谁拖累
  const all = [{ version: '1.0.0', status: 'degraded' }, { version: '1.1.0', status: 'degraded' }];
  assert.equal(selectInstallableVersion(all), null);
  const why = explainNoInstallableVersion(all, new Map([['1.1.0', [{ id: 'skill:geoly/x@1.0.0' }]]]));
  assert.deepEqual(why[1], { version: '1.1.0', status: 'degraded', degraded_by: ['skill:geoly/x@1.0.0'] });
});

// ── §4 安装解析 ────────────────────────────────────────────────────────────

const memberRec = (id, over = {}) => {
  const a = parseArtifactId(id);
  return { ...packRecord(), id, kind: a.kind, namespace: a.namespace, name: a.name, version: a.version,
    path: `artifacts/${a.kind}s/${a.namespace}/${a.name}/${a.version}`, tree_digest: D('a'), ...over };
};
const lookupAll = (id) => memberRec(id);

test('§4 正路：members 全装、bundled 默认装、--no-bundled 跳过', () => {
  const r = resolvePackInstall({ manifest: M, packRecord: packRecord(), lookup: lookupAll, client: 'claude' });
  assert.deepEqual(r.install.map(x => x.id).sort(), [
    'skill:geoly/plaud-theme-dev@0.3.6', 'skill:geoly/plaud-theme-shared@0.3.6', 'skill:geoly/yidian-draft-pr@0.3.6']);
  const nb = resolvePackInstall({ manifest: M, packRecord: packRecord(), lookup: lookupAll, intent: { noBundled: true } });
  assert.equal(nb.install.length, 2);
  assert.deepEqual(nb.skipped, [{ id: 'skill:geoly/yidian-draft-pr@0.3.6', why: 'no-bundled' }]);
});

test('🔴 pack.json 锁的摘要与快照不符 → 完整性事件，整个安装终止', () => {
  expectViolation('E_PACK_MEMBER_DIGEST', () => resolvePackInstall({
    manifest: M, packRecord: packRecord(),
    lookup: (id) => memberRec(id, { tree_digest: D('f') }),
  }));
});

test('🔴 任一成员不存在 → 整个安装终止（不做「跳过坏的装剩下的」）', () => {
  expectViolation('E_PACK_MEMBER_MISSING', () => resolvePackInstall({
    manifest: M, packRecord: packRecord(),
    lookup: (id) => (id.includes('shared') ? undefined : memberRec(id)),
  }));
});

test('🔴 degraded 的 pack 不可新装，而且 --allow-yanked 不放行它', () => {
  expectViolation('E_PACK_DEGRADED', () => resolvePackInstall({
    manifest: M, packRecord: packRecord({ status: 'degraded' }), lookup: lookupAll,
    intent: { allowYanked: true },
  }));
});

test('bundled 成员被 yank → 跳过并告警；必装成员被 yank → 拒绝', () => {
  const ok = resolvePackInstall({
    manifest: M, packRecord: packRecord(),
    lookup: (id) => memberRec(id, id.includes('yidian') ? { status: 'yanked' } : {}),
  });
  assert.deepEqual(ok.skipped, [{ id: 'skill:geoly/yidian-draft-pr@0.3.6', why: 'bundled-yanked' }]);
  expectViolation('E_PACK_MEMBER_YANKED', () => resolvePackInstall({
    manifest: M, packRecord: packRecord(),
    lookup: (id) => memberRec(id, id.includes('shared') ? { status: 'yanked' } : {}),
  }));
});

test('🔴 bundled 成员 degraded：closure 与 resolve 必须给出一致的答案', () => {
  // Codex 第二轮抓到的不一致：快照说 published，普通安装却必然失败。
  // 统一到 §5 的 bundled 行 —— 跳过并告警，两处都是。
  const closure = computePackStatus({
    selfStatus: 'published', manifest: M,
    statusOf: (id) => (id.includes('yidian') ? { status: 'degraded' } : { status: 'published' }),
  });
  assert.equal(closure.status, 'published', 'bundled 的问题不让 pack 变 degraded（§5）');
  assert.deepEqual(closure.skippedBundled.map(x => [x.id, x.reason]),
    [['skill:geoly/yidian-draft-pr@0.3.6', 'degraded']]);

  const r = resolvePackInstall({
    manifest: M, packRecord: packRecord(),
    lookup: (id) => memberRec(id, id.includes('yidian') ? { status: 'degraded' } : {}),
  });
  assert.equal(r.install.length, 2, '🔴 快照说 published，安装就必须真的能装');
  assert.deepEqual(r.skipped, [{ id: 'skill:geoly/yidian-draft-pr@0.3.6', why: 'bundled-degraded' }]);

  // 必装成员 degraded 仍然终止
  expectViolation('E_PACK_MEMBER_DEGRADED', () => resolvePackInstall({
    manifest: M, packRecord: packRecord(),
    lookup: (id) => memberRec(id, id.includes('shared') ? { status: 'degraded' } : {}),
  }));
});

test('客户端兼容性：pack 的 clients 不含该 target → 硬错误', () => {
  expectViolation('E_CLIENT_UNSUPPORTED', () => resolvePackInstall({
    manifest: M, packRecord: packRecord({ clients: ['codex'] }), lookup: lookupAll, client: 'claude',
  }));
});

// ── §4.1 refcount ──────────────────────────────────────────────────────────

test('requested_by 去重 + 字节序严格升序（ledger.validateEntry 就是这么校的）', () => {
  const k1 = 'pack:geoly/m@0.3.6', k2 = 'direct:skill:geoly/d@0.3.6';
  let l = addRequestedBy([], k1);
  l = addRequestedBy(l, k2);
  l = addRequestedBy(l, k1);           // 幂等
  assert.deepEqual(l, [k2, k1].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.equal(new Set(l).size, l.length);
  expectViolation('E_ROOT_KEY', () => addRequestedBy([], '../escape'));
});

test('只有最后一个请求方被移除后才真删目录（§4.1）', () => {
  const k1 = 'pack:geoly/m@0.3.6', k2 = 'direct:skill:geoly/d@0.3.6';
  const l = addRequestedBy(addRequestedBy([], k1), k2);
  assert.equal(removeRequestedBy(l, k1).removeDirectory, false);
  assert.equal(removeRequestedBy(removeRequestedBy(l, k1).requested_by, k2).removeDirectory, true);
});

test('引用图闭合：requested_by 指向不存在的 root → 悬挂，拒绝（R-11）', () => {
  const L = {
    roots: { 'pack:geoly/m@0.3.6': {} },
    entries: { a: { requested_by: ['pack:geoly/m@0.3.6'] } },
  };
  assert.equal(assertRefGraphClosed(L), true);
  L.entries.b = { requested_by: ['pack:geoly/gone@1.0.0'] };
  expectViolation('E_REF_DANGLING', () => assertRefGraphClosed(L));
});

// ── §4.2 升级 ──────────────────────────────────────────────────────────────

test('🔴 成员集合变了绝不整体拒绝更新，只给差集', () => {
  const oldM = validatePackManifest(packDoc());
  const newM = validatePackManifest(packDoc({
    version: '0.3.7',
    members: [
      { id: 'skill:geoly/plaud-theme-shared@0.3.7', tree_digest: D('9'), role: 'matrix' },  // changed
      { id: 'skill:geoly/plaud-theme-new@0.3.7', tree_digest: D('8'), role: 'matrix' },     // added
    ],
    bundled: [{ id: 'skill:geoly/yidian-draft-pr@0.3.6', tree_digest: D('a'), role: 'tool' }],
    compatibility: { previous: '0.3.6', kind: 'breaking', breaking_reasons: ['成员变化'] },
  }));
  const d = diffPackMembers(oldM, newM);
  assert.deepEqual(d.added.map(x => x.key), ['skill:geoly/plaud-theme-new']);
  assert.deepEqual(d.removed.map(x => x.key), ['skill:geoly/plaud-theme-dev']);
  assert.deepEqual(d.changed.map(x => x.key), ['skill:geoly/plaud-theme-shared']);
  assert.deepEqual(d.unchanged.map(x => x.key), ['skill:geoly/yidian-draft-pr']);
});

test('成员从 members 挪到 bundled 算 changed（必装性变了）', () => {
  const oldM = validatePackManifest(packDoc({ bundled: [] }));
  const newM = validatePackManifest(packDoc({
    members: [{ id: 'skill:geoly/plaud-theme-shared@0.3.6', tree_digest: D('a'), role: 'matrix' }],
    bundled: [{ id: 'skill:geoly/plaud-theme-dev@0.3.6', tree_digest: D('a'), role: 'tool' }],
  }));
  const d = diffPackMembers(oldM, newM);
  assert.deepEqual(d.changed.map(x => x.key), ['skill:geoly/plaud-theme-dev']);
});
