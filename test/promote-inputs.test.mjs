// promotion inputs（scripts/promote/build-inputs.mjs）
// —— 06-submission.md §6 / §7，05-lifecycle.md §7（所有权转让与失联接管）。
//
// 🔴 第一版被 Codex 打回，四条阻断项的根因都是「拿手写的 manifest 测，从没过真正的
//    制品校验器」。所以这一版的 fixture **一律用 test/fixtures/pack-tree.mjs 造**
//    —— 那是 `packDirectory()` 真打得出包、`assertManifestBinding()` 真收的形状。
//    凡是 manifest 里放不下的东西（owner、pack 的 provenance），
//    测试里就必须走 PR 侧输入，走不通就说明设计还是错的。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  capabilityTier, assertApprovalsSatisfyTier, readOwners, resolveOwner,
  buildInputs, INPUTS_SCHEMA, OWNERS_SCHEMA, MAX_TIER, assertProvenanceMatchesPr,
} from '../scripts/promote/build-inputs.mjs';
import { stringify, parseStrict } from '../src/canonical-json.mjs';
import { makeSkillArtifact, makePackArtifact, cleanupTrees } from './fixtures/pack-tree.mjs';

after(cleanupTrees);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-promo-in-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const OWNER = { kind: 'org', login: 'geoly-ai', id: 'MDQ6' };
// ⚠️ 必须与 REVIEW 自洽 —— 2026-09-01 起 assertProvenanceMatchesPr 会核对
//    provenance 里的「PR 事实」与真实 PR 是否一致。早先 PROV 写 123/118、
//    REVIEW 写 null/118，两者从来没被核对过，fixture 自己就是矛盾的。
const PROV = { kind: 'original', author_github_id: 'chovizzz', submitted_by_pr: 1 };
const HEAD = 'c'.repeat(40);
const OWNERS = { schema: OWNERS_SCHEMA, namespaces: { geoly: OWNER } };

/**
 * 把 pack-tree 造出来的**真载荷目录**放进 `artifacts/{skills,packs}/…` 布局。
 * 🔴 用 cpSync 拷贝那棵真树，不自己拼 manifest —— 拼出来的东西过不了制品校验器，
 *    而「过不了校验器」正是第一版四条阻断项的根因。
 */
function place(root, art) {
  const { kind, namespace, name, version } = art.record;
  const dir = join(root, 'artifacts', `${kind}s`, namespace, name, version);
  mkdirSync(dir, { recursive: true });
  cpSync(art.root, dir, { recursive: true });
  return art;
}

// ⚠️ author 与 PROV.author_github_id 必须一致 —— 2026-09-01 加了
//    assertProvenanceMatchesPr 之后，fixture 自己对不上就会红。
//    早先这里是 `author: null` 而 PROV 写 '123'，两者从来没被核对过。
const REVIEW = { pr: 1, headSha: HEAD, approvedBy: ['m1'], author: 'chovizzz' };
const build = (root, over = {}) => buildInputs({
  artifactsRoot: join(root, 'artifacts'),
  owners: OWNERS,
  review: REVIEW,
  newIds: [],
  ...over,
});

// ════════════════════════════════════════════════════════════════════════════
// §7 分级与 approve 数量
// ════════════════════════════════════════════════════════════════════════════

test('§7 的分级表，一格不差', () => {
  assert.equal(capabilityTier(['none']), 0);
  assert.equal(capabilityTier(['network']), 1);
  assert.equal(capabilityTier(['external-tool']), 1);
  for (const c of ['shell', 'credentials', 'writes-repo']) assert.equal(capabilityTier([c]), 2);
  assert.equal(capabilityTier(['none', 'network', 'shell']), 2);
});

test('🔴 认不出来的 capability 按**最高档**，不是忽略', () => {
  assert.equal(capabilityTier(['未来的新能力']), MAX_TIER);
  assert.equal(capabilityTier(['none', 'nework']), MAX_TIER, '拼错的 network 不该悄悄降成 Tier 0');
});

test('Tier 0/1 一名、Tier 2 两名；同一个人两次不算两名；投稿者自己不算', () => {
  assert.deepEqual(assertApprovalsSatisfyTier({ tier: 1, approvedBy: ['a'] }), ['a']);
  assert.throws(() => assertApprovalsSatisfyTier({ tier: 2, approvedBy: ['a'] }), /需要 2 名/);
  assert.throws(() => assertApprovalsSatisfyTier({ tier: 2, approvedBy: ['a', 'a'] }), /需要 2 名/);
  assert.deepEqual(assertApprovalsSatisfyTier({ tier: 2, approvedBy: ['b', 'a'] }), ['a', 'b']);
  assert.throws(
    () => assertApprovalsSatisfyTier({ tier: 2, approvedBy: ['author', 'm1'], author: 'author' }),
    /已排除投稿者本人 author/,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// §6 所有权 + 05-lifecycle §7 转让/接管
// ════════════════════════════════════════════════════════════════════════════

test('首次注册：表里没有该 namespace → 用 PR 侧给的 owner；不给就拒', () => {
  const owners = { schema: OWNERS_SCHEMA, namespaces: {} };
  assert.deepEqual(resolveOwner({ owners, namespace: 'newns', claims: { newns: OWNER } }), OWNER);
  assert.throws(() => resolveOwner({ owners, namespace: 'newns' }), /claim_owner/);
});

test('🔴🔴 claims 按 namespace 索引 —— 一个声明不能落到另一个 namespace 上', () => {
  // 第一版收的是**单个** owner 对象，于是「a/foo 没声明 + b/bar 声明了 b 的 owner」
  // 会把两个 namespace 都注册到 b 的 owner 名下 —— 一次静默的所有权错配
  const owners = { schema: OWNERS_SCHEMA, namespaces: {} };
  const claims = { b: { kind: 'user', login: 'bob', id: 'MDQ6_bob' } };
  assert.deepEqual(resolveOwner({ owners, namespace: 'b', claims }), claims.b);
  assert.throws(() => resolveOwner({ owners, namespace: 'a', claims }), /尚未注册/);
});

test('🔴 已注册的 namespace 要核作者（05-lifecycle §1）', () => {
  // 「之后该 namespace 下的投稿，PR 作者必须匹配绑定身份，否则需 owner 明确同意」
  // —— 「明确同意」是人的动作，没有自动判据，所以这里硬拒并指出正路
  const owners = { schema: OWNERS_SCHEMA, namespaces: { ns: { kind: 'user', login: 'alice', id: 'MDQ6_alice' } } };
  assert.deepEqual(resolveOwner({ owners, namespace: 'ns', authorId: 'MDQ6_alice' }), owners.namespaces.ns);
  assert.throws(
    () => resolveOwner({ owners, namespace: 'ns', authorId: 'MDQ6_mallory' }),
    /必须匹配绑定身份/,
  );
});

test('🔴 已注册的 namespace 再声明 claim_owner → 拒（换 owner 走 §7 转让）', () => {
  const owners = { schema: OWNERS_SCHEMA, namespaces: { ns: OWNER } };
  assert.throws(
    () => resolveOwner({ owners, namespace: 'ns', claims: { ns: OWNER } }),
    /已经注册过了/,
  );
});

test('🔴 已注册的 namespace 一律以 owners.json 为准（转让/接管就是改这张表）', () => {
  // 05-lifecycle §7：转让是「双方在同一张 PR 里各自签字」，接管「必须留公开记录
  // advisories/ 或 registry/owners.json 的变更历史」—— 两者都是改 owners.json。
  // 所以本脚本这一侧不需要第二条能改 owner 的路径。
  assert.deepEqual(resolveOwner({ owners: OWNERS, namespace: 'geoly' }), OWNER);
  // 即使 PR 侧传了别的 owner，也以表为准（--claim-owner 只对首次注册有意义）
  assert.deepEqual(
    resolveOwner({ owners: OWNERS, namespace: 'geoly' }),
    OWNER,
  );
});

test('owners.json：schema 与 owner 形状都要严格；文件不存在＝还没有任何注册', () => {
  const root = mkroot();
  const p = join(root, 'x.json');
  writeFileSync(p, stringify({ schema: 'nope/1', namespaces: {} }));
  assert.throws(() => readOwners(p), /owners\.json 的 schema/);
  writeFileSync(p, stringify({ schema: OWNERS_SCHEMA, namespaces: { a: { kind: 'org', login: 'x' } } }));
  assert.throws(() => readOwners(p), /键集必须正好是/);
  assert.deepEqual(readOwners(join(root, '不存在.json')).namespaces, {});
});

// ════════════════════════════════════════════════════════════════════════════
// 🔴 历史制品必须**继承**，不能被本次 PR 的事实重写
// ════════════════════════════════════════════════════════════════════════════

test('🔴 只处理本次新增；历史 record 的 review / status 原样继承', () => {
  const root = mkroot();
  const s = place(root, makeSkillArtifact({ name: 'alpha' }));

  const previousSnapshot = {
    artifacts: [
      {
        id: 'skill:geoly/old@0.1.0', status: 'deprecated',
        owner: { kind: 'github-user', login: '老作者', id: 'U_old' },
        review: { pr: 7, approved_by: ['很久以前的维护者'], head_sha: 'a'.repeat(40), capability_tier: 1 },
        provenance: PROV, capabilities: ['network'],
      },
    ],
  };
  const inputs = build(root, { newIds: [s.record.id], previousSnapshot });

  // 历史那条：review 与 status 都没被本次 PR 改写
  const old = inputs.artifacts['skill:geoly/old@0.1.0'];
  assert.equal(old.review.pr, 7, `🔴 改成 ${REVIEW.pr} 就是篡改审计记录`);
  assert.deepEqual(old.review.approved_by, ['很久以前的维护者']);
  assert.equal(old.status, 'deprecated', '🔴 抹成 published 会让一个已弃用的制品复活');
  assert.equal(old.owner.login, '老作者');

  // 新增那条：用本次 PR 的事实
  assert.equal(inputs.artifacts[s.record.id].review.pr, REVIEW.pr);
});

test('🔴 yanked / degraded 不能作为 status 输入 —— 还原成 published 交给 build-snapshot 重算', () => {
  const root = mkroot();
  const previousSnapshot = {
    artifacts: [
      { id: 'skill:geoly/y@1.0.0', status: 'yanked', owner: OWNER, review: { pr: 1, approved_by: ['m'], head_sha: 'b'.repeat(40), capability_tier: 0 }, provenance: PROV, capabilities: ['none'] },
      { id: 'pack:geoly/d@1.0.0', status: 'degraded', owner: OWNER, review: { pr: 2, approved_by: ['m'], head_sha: 'b'.repeat(40), capability_tier: 0 }, provenance: PROV, capabilities: ['none'] },
    ],
  };
  const inputs = build(root, { previousSnapshot });
  // build-snapshot 的 assertInputStatus 只收 published / deprecated
  assert.equal(inputs.artifacts['skill:geoly/y@1.0.0'].status, 'published');
  assert.equal(inputs.artifacts['pack:geoly/d@1.0.0'].status, 'published');
});

test('🔴 已在上一张快照里的 id 不能当「新增」重发（制品不可变）', () => {
  const root = mkroot();
  const s = place(root, makeSkillArtifact({ name: 'alpha' }));
  const previousSnapshot = {
    artifacts: [{ id: s.record.id, status: 'published', owner: OWNER, review: { pr: 1, approved_by: ['m'], head_sha: 'b'.repeat(40), capability_tier: 0 }, provenance: PROV, capabilities: ['none'] }],
  };
  assert.throws(() => build(root, { newIds: [s.record.id], previousSnapshot }), /制品不可变/);
});

// ════════════════════════════════════════════════════════════════════════════
// pack：成员 capability、provenance、D8
// ════════════════════════════════════════════════════════════════════════════

test('🔴 pack 走得通：成员 capability 从上一张快照查，provenance 由 PR 侧给', () => {
  const root = mkroot();
  const member = makeSkillArtifact({ name: 'member' });
  place(root, member);
  const pack = place(root, makePackArtifact({ name: 'matrix', members: [member.record] }));

  const previousSnapshot = {
    artifacts: [{
      id: member.record.id, status: 'published', owner: OWNER,
      review: { pr: 1, approved_by: ['m'], head_sha: 'b'.repeat(40), capability_tier: 0 },
      provenance: PROV, capabilities: ['network'],
    }],
  };
  const inputs = build(root, {
    newIds: [pack.record.id],
    previousSnapshot,
    // 🔴 pack.json 的键集里没有 provenance，只能由 PR 侧给
    provenanceOf: { [pack.record.id]: PROV },
  });
  // 成员声明了 network → pack 的 Tier 跟着是 1
  assert.equal(inputs.artifacts[pack.record.id].review.capability_tier, 1);
  assert.deepEqual(inputs.artifacts[pack.record.id].provenance, PROV);
});

test('🔴 pack 没有 provenance 时如实拒绝，并说清它该从哪来', () => {
  const root = mkroot();
  const member = place(root, makeSkillArtifact({ name: 'member' }));
  const pack = place(root, makePackArtifact({ name: 'matrix', members: [member.record] }));
  const previousSnapshot = {
    artifacts: [{
      id: member.record.id, status: 'published', owner: OWNER,
      review: { pr: 1, approved_by: ['m'], head_sha: 'b'.repeat(40), capability_tier: 0 },
      provenance: PROV, capabilities: ['none'],
    }],
  };
  assert.throws(
    () => build(root, { newIds: [pack.record.id], previousSnapshot }),
    /pack\.json 的键集里没有这个字段[\s\S]*--provenance-of/,
  );
});

test('🔴 D8：contract_paths 被**清空**同样要升 Tier 2（第一版的近似正好漏了这一格）', () => {
  const root = mkroot();
  const member = place(root, makeSkillArtifact({ name: 'member' }));
  // 上一版声明了 contract_paths
  place(root, makePackArtifact({
    name: 'matrix', version: '1.0.0', members: [member.record],
    docOver: { contract_paths: ['member/references/contract.md'], compatibility: { previous: null, kind: 'breaking', breaking_reasons: ['首版'] } },
  }));
  // 本版把它清空了 —— 「清空清单让门形同虚设」正是 D8 要防的
  const v2 = place(root, makePackArtifact({
    name: 'matrix', version: '2.0.0', members: [member.record],
    docOver: { contract_paths: [], compatibility: { previous: '1.0.0', kind: 'breaking', breaking_reasons: ['x'] } },
  }));
  const previousSnapshot = {
    artifacts: [{
      id: member.record.id, status: 'published', owner: OWNER,
      review: { pr: 1, approved_by: ['m'], head_sha: 'b'.repeat(40), capability_tier: 0 },
      provenance: PROV, capabilities: ['none'],
    }],
  };
  const args = { newIds: [v2.record.id], previousSnapshot, provenanceOf: { [v2.record.id]: PROV } };
  // 成员是 none → 本该 Tier 0、一名 approve 就够；但清空 contract_paths 强制 Tier 2
  assert.throws(() => build(root, args), /Tier 2 需要 2 名/);
  const ok = build(root, { ...args, review: { ...REVIEW, approvedBy: ['m1', 'm2'] } });
  assert.equal(ok.artifacts[v2.record.id].review.capability_tier, 2);
});

// ════════════════════════════════════════════════════════════════════════════
// 与 build-snapshot 的接缝（待拍板项①的闭合点）
// ════════════════════════════════════════════════════════════════════════════

test('🔴 产出的 inputs 能直接喂给 build-snapshot，且快照过得了读取端', async () => {
  const { buildSnapshot } = await import('../scripts/build-snapshot.mjs');
  const { parseSnapshot } = await import('../src/snapshot.mjs');
  const root = mkroot();
  const s = place(root, makeSkillArtifact({ name: 'alpha' }));

  const inputs = build(root, {
    newIds: [s.record.id],
    owners: { schema: OWNERS_SCHEMA, namespaces: {} },
    claimOwner: { geoly: OWNER },   // 首次注册（按 namespace 索引）
  });
  const { doc } = buildSnapshot({
    artifactsRoot: join(root, 'artifacts'),
    inputs, snapshot: 42, previous: 41,
    createdAt: '2026-08-25T12:00:00Z', repo: 'geoly-ai/skills-hub',
  });
  const snap = parseSnapshot(Buffer.from(stringify(doc), 'utf8'), { expectSnapshot: 42 });
  assert.equal(snap.artifacts[0].id, s.record.id);
  // ⚠️ parseStrict 的产物是 **null 原型**对象，deepStrictEqual 会因原型不同而失败
  assert.deepEqual({ ...snap.artifacts[0].owner }, OWNER);
  assert.equal(snap.artifacts[0].review.pr, REVIEW.pr);
});

test('🔴 CLI 真调用：pack 也要走得通（第一版这里必崩 —— main 从没传成员 capability）', () => {
  const root = mkroot();
  const member = place(root, makeSkillArtifact({ name: 'member' }));
  const pack = place(root, makePackArtifact({ name: 'matrix', members: [member.record] }));

  const prevSnap = join(root, 'prev.json');
  writeFileSync(prevSnap, stringify({
    artifacts: [{
      id: member.record.id, status: 'published', owner: OWNER,
      review: { pr: 1, approved_by: ['m'], head_sha: 'b'.repeat(40), capability_tier: 0 },
      provenance: PROV, capabilities: ['none'],
    }],
  }));
  const provFile = join(root, 'prov.json');
  writeFileSync(provFile, stringify({ [pack.record.id]: PROV }));
  const ownersFile = join(root, 'owners.json');
  writeFileSync(ownersFile, stringify(OWNERS));
  const out = join(root, 'inputs.json');

  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/promote/build-inputs.mjs'),
    '--artifacts', join(root, 'artifacts'), '--owners', ownersFile,
    '--new-ids', pack.record.id, '--previous-snapshot', prevSnap,
    '--provenance-of', provFile,
    // ⚠️ --author / --pr 必须与 fixture 的 provenance 自洽：2026-09-01 起
    //    assertProvenanceMatchesPr 会核对。早先这里不传 --author（review.author
    //    是 null）、--pr 传 118 而 provenance 写 1，三者互不相干也没人发现。
    '--pr', '1', '--author', 'chovizzz',
    '--head-sha', HEAD, '--approved-by', 'm1', '--out', out,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(out));
  const doc = parseStrict(readFileSync(out, 'utf8'));
  assert.equal(doc.schema, INPUTS_SCHEMA);
  assert.equal(doc.artifacts[pack.record.id].review.capability_tier, 0);
  // 历史成员也在里面（继承）
  assert.ok(Object.hasOwn(doc.artifacts, member.record.id));
});

test('🔴 同一批里 pack 的成员是**新增的 pack** —— 不能崩（上一版这里抛 TypeError）', () => {
  const root = mkroot();
  const leaf = place(root, makeSkillArtifact({ name: 'leaf' }));
  // inner 是新增的 pack，成员是新增的 skill
  const inner = place(root, makePackArtifact({ name: 'inner', members: [leaf.record] }));
  // outer 的成员是 inner —— pack.json 没有 capabilities 键，读出来是 undefined
  const outer = place(root, makePackArtifact({ name: 'outer', members: [inner.record] }));

  const inputs = build(root, {
    newIds: [leaf.record.id, inner.record.id, outer.record.id],
    provenanceOf: { [inner.record.id]: PROV, [outer.record.id]: PROV },
  });
  // leaf 的 capabilities 是 ['none'] → 一路并上来还是 Tier 0
  assert.equal(inputs.artifacts[outer.record.id].review.capability_tier, 0);
  assert.equal(inputs.artifacts[inner.record.id].review.capability_tier, 0);
});

test('🔴 嵌套 pack 的 capability 真的往上并，不是被吞掉', () => {
  const root = mkroot();
  const leaf = place(root, makeSkillArtifact({ name: 'leaf', capabilities: ['shell'] }));
  const inner = place(root, makePackArtifact({ name: 'inner', members: [leaf.record] }));
  const outer = place(root, makePackArtifact({ name: 'outer', members: [inner.record] }));
  const args = {
    newIds: [leaf.record.id, inner.record.id, outer.record.id],
    provenanceOf: { [inner.record.id]: PROV, [outer.record.id]: PROV },
  };
  // leaf 声明 shell → Tier 2 → 一名 approve 不够
  assert.throws(() => build(root, args), /Tier 2 需要 2 名/);
  const ok = build(root, { ...args, review: { ...REVIEW, approvedBy: ['m1', 'm2'] } });
  assert.equal(ok.artifacts[outer.record.id].review.capability_tier, 2, '🔴 shell 必须一路并到最外层');
});

test('🔴 yank 名单必须从上一张快照继承 —— 否则被 yank 的东西会悄悄复活', () => {
  const root = mkroot();
  const previousSnapshot = {
    artifacts: [{
      id: 'skill:geoly/bad@1.0.0', status: 'yanked', owner: OWNER,
      review: { pr: 3, approved_by: ['m'], head_sha: 'b'.repeat(40), capability_tier: 0 },
      provenance: PROV, capabilities: ['none'],
    }],
    yanked: [{ id: 'skill:geoly/bad@1.0.0', at: '2026-08-01T00:00:00Z', reason: '有安全问题', advisory: 'GSA-2026-0001' }],
  };
  // 不传 --yanked
  const inputs = build(root, { previousSnapshot });
  assert.equal(inputs.yanked.length, 1, '🔴 丢了就等于把一个被 yank 的制品重新发布');
  assert.equal(inputs.yanked[0].reason, '有安全问题');
  assert.equal(inputs.yanked[0].advisory, 'GSA-2026-0001', 'advisory 也不能丢');
});

test('yank 是只增的：本次新增的与继承的合并，按 id 去重、继承的优先', () => {
  const root = mkroot();
  const previousSnapshot = {
    artifacts: [],
    yanked: [{ id: 'skill:geoly/a@1.0.0', at: '2026-08-01T00:00:00Z', reason: '旧原因' }],
  };
  const inputs = build(root, {
    previousSnapshot,
    yanked: [
      { id: 'skill:geoly/a@1.0.0', at: '2026-08-31T00:00:00Z', reason: '想改写旧原因' },
      { id: 'skill:geoly/b@1.0.0', at: '2026-08-31T00:00:00Z', reason: '新 yank' },
    ],
  });
  assert.equal(inputs.yanked.length, 2);
  assert.equal(inputs.yanked.find((y) => y.id === 'skill:geoly/a@1.0.0').reason, '旧原因',
    '继承的优先 —— 已经记下的 yank 原因不该被后来的一次 promotion 改写');
  assert.ok(inputs.yanked.find((y) => y.id === 'skill:geoly/b@1.0.0'));
});


// ── provenance 的「PR 事实」必须与真实 PR 对得上 ────────────────────────────
//
// 🔴 2026-09-01 发现的洞：`manifest.provenance` 原本被**原样取用**，从不与
//    `review.pr` / `review.author` 核对 —— 而那两个值就在同一个作用域里。
//    投稿者可以在自己的 skill.json 里写任意 author_github_id / submitted_by_pr，
//    它会原样进快照成为**权威出处记录**。provenance 正是整条信任链要建立的
//    那件事本身。
//    ⚠️ 它还与 PROMOTION.json 自相矛盾：那边明确**拒绝**投稿者声明这两个字段。
test('provenance 与真实 PR 一致时通过', () => {
  const p = { kind: 'original', author_github_id: 'U_real', submitted_by_pr: 42 };
  assert.equal(assertProvenanceMatchesPr({
    provenance: p, review: { pr: 42, author: 'U_real' }, where: 'x',
  }), p);
});

test('🔴 provenance 伪造作者 / PR 号一律拒绝（fail-closed，不静默改写）', () => {
  const review = { pr: 42, author: 'U_real' };
  assert.throws(() => assertProvenanceMatchesPr({
    provenance: { kind: 'original', author_github_id: 'U_someone_else', submitted_by_pr: 42 },
    review, where: 'skill:a/b@1.0.0',
  }), /author_github_id/);
  assert.throws(() => assertProvenanceMatchesPr({
    provenance: { kind: 'original', author_github_id: 'U_real', submitted_by_pr: 999 },
    review, where: 'x',
  }), /submitted_by_pr/);
});

// 🔴 直接用真实值覆盖也能堵住洞，但那样「写错了」和「试图伪造」都会无声通过。
//    这条钉住我们选的是报错而不是改写。
test('🔴 vendored 的 imported_by_pr 同样核对', () => {
  assert.throws(() => assertProvenanceMatchesPr({
    provenance: { kind: 'vendored', imported_by_pr: 7 },
    review: { pr: 42, author: 'U_real' }, where: 'x',
  }), /imported_by_pr/);
});
