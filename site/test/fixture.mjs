// 造一张**真的**快照给站点开发与测试用。
//
// 🔴 **不手写假 JSON。** 快照的字段集、排序、latest 投影、pack 的 clients 交集 /
//    capabilities 并集 / degraded 闭包，全都由 `scripts/build-snapshot.mjs` 算 ——
//    手写的假快照第一会漏字段（`parseSnapshot` 的 RECORD_KEYS 是精确键集），
//    第二会让页面按一份现实里不会出现的形状开发，上线当天才发现对不上。
//    这里走的是 promotion 的同一条路径，产出的字节 `parseSnapshot()` 收得下。
//
// 树的构造用 `test/fixtures/pack-tree.mjs` 的 `makeTree`（它已经处理好临时目录与清理）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTree } from '../../test/fixtures/pack-tree.mjs';
import { packDirectory } from '../../src/packer.mjs';
import { stringify } from '../../src/canonical-json.mjs';
import { buildSnapshot } from '../../scripts/build-snapshot.mjs';

const REPO = 'geoly-ai/skills-hub';
const CREATED_AT = '2026-08-25T12:00:00Z';

const owner = (login, id) => ({ kind: 'github-user', login, id });
const review = (pr, approvers, tier) => ({
  pr, approved_by: approvers, head_sha: String(pr).padStart(40, '0'), capability_tier: tier,
});

function skillManifest({ namespace, name, version, description, capabilities, clients, provenance, license = 'MIT' }) {
  return {
    schema: 'geoly.skills.skill/1', kind: 'skill', namespace, name, version,
    description, license, clients, capabilities,
    replaces: [], conflicts: [],
    provenance,
  };
}

const ORIGINAL = { kind: 'original', author_github_id: 'chovizzz', submitted_by_pr: 118 };

/** 一份 vendored provenance（05-lifecycle.md §6 的全字段）。 */
const VENDORED = {
  kind: 'vendored',
  origin_repo: 'acme/upstream-skills',
  origin_ref: 'refs/tags/v2.0.0',
  origin_commit: 'a'.repeat(40),
  origin_subpath: 'skills/report-writer',
  origin_tree_digest: `geoly-tree-v1:sha256:${'b'.repeat(64)}`,
  license_evidence: 'LICENSE（MIT），与上游 v2.0.0 逐字节一致',
  imported_at: '2026-08-20T09:00:00Z',
  imported_by_pr: 201,
  added_files: ['skill.json'],
};

const ALL_CLIENTS = ['claude', 'cursor', 'codex', 'agents'];

/** 站点开发用的一组制品：覆盖多版本、预发布、yank、degraded、vendored、Tier 0/1/2。 */
const SKILLS = [
  {
    namespace: 'geoly', name: 'plaud-theme-shared', version: '0.3.6',
    description: 'Plaud 主题矩阵的共享约定与交接契约', capabilities: ['none'],
    clients: ALL_CLIENTS, provenance: ORIGINAL, status: 'published',
    owner: owner('chovizzz', 'U_kgDODu4RvA'), review: review(118, ['maintainer-a'], 0),
  },
  {
    namespace: 'geoly', name: 'plaud-theme-dev', version: '0.3.5',
    description: 'Plaud 主题的通用开发（旧版）', capabilities: ['none'],
    clients: ALL_CLIENTS, provenance: ORIGINAL, status: 'deprecated',
    owner: owner('chovizzz', 'U_kgDODu4RvA'), review: review(101, ['maintainer-a'], 0),
  },
  {
    namespace: 'geoly', name: 'plaud-theme-dev', version: '0.3.6',
    description: 'Plaud 主题的通用开发：bug 修复、性能优化、UX 微调',
    capabilities: ['network'], clients: ALL_CLIENTS, provenance: ORIGINAL, status: 'published',
    owner: owner('chovizzz', 'U_kgDODu4RvA'), review: review(119, ['maintainer-a'], 1),
  },
  {
    namespace: 'geoly', name: 'legacy-runner', version: '1.0.0',
    description: '会跑 shell 的旧版执行器', capabilities: ['shell', 'credentials'],
    clients: ['claude', 'codex'], provenance: ORIGINAL, status: 'published',
    owner: owner('chovizzz', 'U_kgDODu4RvA'), review: review(90, ['maintainer-a', 'maintainer-b'], 2),
    yank: {
      at: '2026-08-28T03:00:00Z',
      reason: '会把 ~/.aws/credentials 读进上下文',
      advisory: 'GSA-2026-0001',
      superseded_by: 'skill:geoly/legacy-runner@1.1.0-rc.1',
    },
  },
  {
    namespace: 'geoly', name: 'legacy-runner', version: '1.1.0-rc.1',
    description: '执行器的预发布版：去掉了凭据读取', capabilities: ['shell'],
    clients: ['claude', 'codex'], provenance: ORIGINAL, status: 'published',
    owner: owner('chovizzz', 'U_kgDODu4RvA'), review: review(121, ['maintainer-a', 'maintainer-b'], 2),
  },
  {
    // 🔴 **敌意文本**要一直留在 fixture 里。description 是自由文本，
    //    它会同时进 HTML 正文和列表页那份序列化数据 —— 两条路都得转义。
    //    把它做成常驻用例，比"想起来再测一次"可靠。
    namespace: 'acme', name: 'tricky-text', version: '0.1.0',
    description: '</script><script>alert(1)</script> & "引号" <img src=x onerror=alert(2)>',
    capabilities: ['none'], clients: ALL_CLIENTS, provenance: ORIGINAL, status: 'published',
    owner: { kind: 'organization', login: 'acme', id: 'O_kgDOAcme01' },
    review: review(202, ['maintainer-a'], 0),
  },
  {
    namespace: 'acme', name: 'report-writer', version: '2.0.0',
    description: '从上游 vendor 过来的报告写作 skill', capabilities: ['external-tool'],
    clients: ALL_CLIENTS, provenance: VENDORED, status: 'published',
    owner: { kind: 'organization', login: 'acme', id: 'O_kgDOAcme01' },
    review: review(201, ['maintainer-a'], 1),
  },
];

/**
 * pack 列表。🔴 **必须按依赖序排**（被引用的排在前面）：pack.json 里锁定的是成员的
 * **真实 tree_digest**，而 pack 引用 pack 时，外层要先知道内层打出来是什么摘要。
 *
 * 覆盖：正常 pack、必装成员被 yank 的 degraded pack、以及一条**三层嵌套链**
 * （l0 → l1 → l2），后者专门用来验"归因不完整"的检测能走到第二层以下。
 */
const PACKS = [
  {
    namespace: 'geoly', name: 'plaud-theme-matrix', version: '0.3.6',
    description: 'Plaud 主题矩阵',
    members: ['skill:geoly/plaud-theme-shared@0.3.6', 'skill:geoly/plaud-theme-dev@0.3.6'],
    bundled: ['skill:acme/report-writer@2.0.0'],
    contract_paths: ['plaud-theme-shared/references/handoff-schema.md'],
    status: 'published',
    owner: owner('chovizzz', 'U_kgDODu4RvA'),
    // 🔴 故意让 review.capability_tier 高于 capabilities 算出来的档：
    //    `contract_paths` 变更强制 Tier 2（D8），而成员并集只到 Tier 1。
    //    页面必须能把这两个数并列摆出来而不宣称谁错了。
    review: review(150, ['maintainer-a', 'maintainer-b'], 2),
  },
  {
    namespace: 'geoly', name: 'legacy-matrix', version: '0.1.0',
    description: '把被 yank 的执行器列为必装成员的矩阵',
    members: ['skill:geoly/plaud-theme-shared@0.3.6', 'skill:geoly/legacy-runner@1.0.0'],
    bundled: [],
    contract_paths: [],
    status: 'published',
    owner: owner('chovizzz', 'U_kgDODu4RvA'),
    review: review(151, ['maintainer-a', 'maintainer-b'], 2),
  },
  {
    namespace: 'geoly', name: 'l2-matrix', version: '0.1.0',
    description: '嵌套链的最里层', members: ['skill:geoly/plaud-theme-shared@0.3.6'],
    bundled: [], contract_paths: [], status: 'published',
    owner: owner('chovizzz', 'U_kgDODu4RvA'), review: review(160, ['maintainer-a', 'maintainer-b'], 2),
  },
  {
    namespace: 'geoly', name: 'l1-matrix', version: '0.1.0',
    description: '嵌套链的中间层', members: ['pack:geoly/l2-matrix@0.1.0'],
    bundled: [], contract_paths: [], status: 'published',
    owner: owner('chovizzz', 'U_kgDODu4RvA'), review: review(161, ['maintainer-a', 'maintainer-b'], 2),
  },
  {
    namespace: 'geoly', name: 'l0-matrix', version: '0.1.0',
    description: '嵌套链的最外层', members: ['pack:geoly/l1-matrix@0.1.0'],
    bundled: [], contract_paths: [], status: 'published',
    owner: owner('chovizzz', 'U_kgDODu4RvA'), review: review(162, ['maintainer-a', 'maintainer-b'], 2),
  },
];

/**
 * 造 fixture。
 * @returns {{artifactsRoot:string, snapshotsDir:string, snapshotNumber:number, doc:object}}
 */
export function makeFixtureRegistry({ snapshotNumber = 42, previous = 41 } = {}) {
  // ── 第 1 步：skill 载荷 ──────────────────────────────────────────────────
  const spec = {};
  for (const s of SKILLS) {
    const dir = `skills/${s.namespace}/${s.name}/${s.version}`;
    spec[`${dir}/SKILL.md`] = `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n正文\n`;
    spec[`${dir}/skill.json`] = stringify(skillManifest(s));
  }
  const artifactsRoot = makeTree(spec);

  // ── 第 2 步：pack.json 里锁定的成员 tree_digest 必须是**真的** ─────────────
  // 🔴 pack.json 冗余记一份成员摘要，promotion 会拿它跟实际打出来的比（对不上即
  //    「完整性事件」）。所以这里必须先把成员打一遍拿到真摘要，不能填占位。
  const digestOf = new Map();
  for (const s of SKILLS) {
    const dir = join(artifactsRoot, `skills/${s.namespace}/${s.name}/${s.version}`);
    digestOf.set(`skill:${s.namespace}/${s.name}@${s.version}`, packDirectory(dir).tree_digest);
  }

  for (const p of PACKS) {
    const dir = join(artifactsRoot, `packs/${p.namespace}/${p.name}/${p.version}`);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const manifest = {
      schema: 'geoly.skills.pack/1', kind: 'pack',
      namespace: p.namespace, name: p.name, version: p.version,
      description: p.description, license: 'MIT',
      members: p.members.map((id, i) => ({ id, tree_digest: digestOf.get(id), role: 'matrix', order: i })),
      bundled: p.bundled.map((id) => ({ id, tree_digest: digestOf.get(id), role: 'tool' })),
      conflicts: [], contract_paths: p.contract_paths,
      compatibility: { previous: null, kind: 'breaking', breaking_reasons: ['首版'] },
    };
    writeFileSync(join(dir, 'pack.json'), stringify(manifest), { mode: 0o644 });
    writeFileSync(join(dir, 'MATRIX.md'), `# ${p.name}\n`, { mode: 0o644 });
    // pack 也可以做别的 pack 的成员，所以它的摘要也要登记 —— 靠 PACKS 的依赖序保证
    // 引用它的那个 pack 在这之后才被写出来。
    digestOf.set(`pack:${p.namespace}/${p.name}@${p.version}`, packDirectory(dir).tree_digest);
  }

  // ── 第 3 步：promotion inputs（owner / review / status 是投稿 PR 的事实）────
  const inputs = { artifacts: {}, yanked: [] };
  for (const s of SKILLS) {
    inputs.artifacts[`skill:${s.namespace}/${s.name}@${s.version}`] =
      { status: s.status, owner: s.owner, review: s.review };
    if (s.yank) inputs.yanked.push({ id: `skill:${s.namespace}/${s.name}@${s.version}`, ...s.yank });
  }
  for (const p of PACKS) {
    inputs.artifacts[`pack:${p.namespace}/${p.name}@${p.version}`] =
      { status: p.status, owner: p.owner, review: p.review, provenance: ORIGINAL };
  }

  // ── 第 4 步：跑 promotion 的那份 buildSnapshot ────────────────────────────
  const { doc } = buildSnapshot({
    artifactsRoot, inputs, snapshot: snapshotNumber, previous,
    createdAt: CREATED_AT, repo: REPO,
  });

  const snapshotsDir = makeTree({ '.keep': '' });
  writeFileSync(join(snapshotsDir, `hub-${snapshotNumber}.json`), stringify(doc), { mode: 0o644 });

  return { artifactsRoot, snapshotsDir, snapshotNumber, doc };
}
