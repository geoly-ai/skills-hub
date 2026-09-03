// pack / packer 测试用的临时目录树构造器。
//
// 🔴 **不在 `tmpdir()` 根上数文件**：那是别人也能写的命名空间，靠「数一数有几个」
//    做判据会被其它进程的并发测试污染（M1 里真的产生过跨进程假红）。
//    每个用例拿自己的 mkdtemp 目录，判据只落在自己的那棵树上。
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const roots = [];

/** 建一棵树：`{ 'a/b.md': '内容' }` 或 `{ 'bin/run.sh': { data, mode } }` */
export function makeTree(spec, { dirs = [], links = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'geoly-packtest-'));
  roots.push(root);
  for (const [rel, v] of Object.entries(spec)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o755 });
    const data = typeof v === 'string' ? Buffer.from(v) : (Buffer.isBuffer(v.data) ? v.data : Buffer.from(v.data));
    writeFileSync(abs, data);
    chmodSync(abs, typeof v === 'string' ? 0o644 : (v.mode ?? 0o644));
  }
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true, mode: 0o755 });
  for (const [rel, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true, mode: 0o755 });
    symlinkSync(target, join(root, rel));
  }
  return root;
}

export function cleanupTrees() {
  while (roots.length) {
    try { rmSync(roots.pop(), { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
}

/** 一个最小但**合法**的 skill 载荷。 */
export const MIN_SKILL = Object.freeze({
  'SKILL.md': '---\nname: demo\ndescription: demo skill\n---\n\n正文\n',
  'skill.json': '{"schema":"geoly.skills.skill/1"}\n',
});

/** 一个最小但**合法**的 pack 载荷。 */
export const MIN_PACK = Object.freeze({
  'pack.json': '{"schema":"geoly.skills.pack/1"}\n',
  'README.md': '# pack\n',
});

/** 一份结构完整的 pack.json（validatePackManifest 应当接受）。 */
export function packDoc(over = {}) {
  const d = 'geoly-tree-v1:sha256:' + 'a'.repeat(64);
  return {
    schema: 'geoly.skills.pack/1',
    kind: 'pack',
    namespace: 'geoly',
    name: 'plaud-theme-matrix',
    version: '0.3.6',
    description: 'Plaud 矩阵',
    license: 'MIT',
    members: [
      { id: 'skill:geoly/plaud-theme-shared@0.3.6', tree_digest: d, role: 'matrix', order: 0 },
      { id: 'skill:geoly/plaud-theme-dev@0.3.6', tree_digest: d, role: 'matrix', order: 1 },
    ],
    bundled: [
      { id: 'skill:geoly/yidian-draft-pr@0.3.6', tree_digest: d, role: 'tool' },
    ],
    conflicts: ['skill:*/plaud-shopify-theme'],
    contract_paths: ['plaud-theme-shared/references/handoff-schema.md', '*/matrix-contract.md'],
    compatibility: { previous: '0.3.5', kind: 'compatible', breaking_reasons: [] },
    ...over,
  };
}

/** 快照 record 的最小合法形状（供 assertManifestBinding / resolvePackInstall 用）。 */
export function packRecord(over = {}) {
  return {
    id: 'pack:geoly/plaud-theme-matrix@0.3.6',
    kind: 'pack',
    namespace: 'geoly',
    name: 'plaud-theme-matrix',
    version: '0.3.6',
    path: 'artifacts/packs/geoly/plaud-theme-matrix/0.3.6',
    tree_digest: 'geoly-tree-v1:sha256:' + 'b'.repeat(64),
    asset: { file: 'pack_geoly_plaud-theme-matrix_0.3.6.tar.gz', sha256: 'sha256:' + 'c'.repeat(64), size: 1 },
    clients: ['claude', 'cursor', 'codex', 'agents'],
    capabilities: ['none'],
    replaces: [], conflicts: [], license: 'MIT',
    owner: { kind: 'org', login: 'geoly-ai', id: 'MDQ6' },
    provenance: { kind: 'original', author_github_id: 'chovizzz', submitted_by_pr: 1 },
    status: 'published',
    review: { pr: 1, approved_by: ['a'], head_sha: '0'.repeat(40), capability_tier: 0 },
    ...over,
  };
}

// ── 真制品（能过 withVerifiedArtifact 的那种） ──────────────────────────────
import { packDirectory } from '../../src/packer.mjs';
import { stringify } from '../../src/canonical-json.mjs';

function recordFor({ kind, namespace, name, version, packed, over }) {
  return {
    id: `${kind}:${namespace}/${name}@${version}`,
    kind, namespace, name, version,
    path: `artifacts/${kind}s/${namespace}/${name}/${version}`,
    tree_digest: packed.tree_digest,
    // 🔴 命名必须与**发布端**一致（`scripts/build-snapshot.mjs` 的 `assetFileName()`）。
    //    夹具原本写的是 `${name}-${version}.tar.gz` —— 生产里从来不会产生这种名字
    //    （核对过 registry/snapshots/hub-2.json 的 23 条，全是下面这个形状）。
    //    夹具与生产不一致时，**测试测的是一个不存在的世界**：
    //    客户端按记录字段重算文件名去下载，照夹具那种名字永远 404。
    asset: { file: `${kind}_${namespace}_${name}_${version}.tar.gz`, sha256: packed.sha256, size: packed.size },
    clients: ['claude', 'cursor', 'codex', 'agents'],
    capabilities: ['none'],
    replaces: [], conflicts: [], license: 'MIT',
    owner: { kind: 'org', login: 'geoly-ai', id: 'MDQ6' },
    provenance: { kind: 'original', author_github_id: 'chovizzz', submitted_by_pr: 1 },
    status: 'published',
    review: { pr: 1, approved_by: ['a'], head_sha: '0'.repeat(40), capability_tier: 0 },
    ...over,
  };
}

/** 一个真的能装的 skill 制品：{root, bytes, record}。 */
export function makeSkillArtifact({
  namespace = 'geoly', name, version = '0.3.6', files = {}, over = {},
  // 🔴 `over` 改的是 **record**，不是载荷里的 manifest。要让 `skill.json` 里的
  //    capabilities / clients 也变，得走这两个参数 —— 否则会出现「record 说 shell、
  //    载荷说 none」的自相矛盾，而读 manifest 的那一侧看到的是 none。
  capabilities = ['none'], clients = ['claude', 'cursor', 'codex', 'agents'],
} = {}) {
  const manifest = {
    schema: 'geoly.skills.skill/1', kind: 'skill', namespace, name, version,
    description: `${name} 的描述`, license: 'MIT',
    clients, capabilities,
    replaces: [], conflicts: [],
    provenance: { kind: 'original', author_github_id: 'chovizzz', submitted_by_pr: 1 },
  };
  const root = makeTree({
    'SKILL.md': `---\nname: ${name}\ndescription: ${name} 的描述\n---\n\n正文\n`,
    'skill.json': stringify(manifest),
    ...files,
  });
  const packed = packDirectory(root);
  return {
    root, bytes: packed.bytes, packed,
    record: recordFor({ kind: 'skill', namespace, name, version, packed, over: { clients, capabilities, ...over } }),
  };
}

/** 一个真的 pack 制品。`members` / `bundled` 传成员 record 列表。 */
export function makePackArtifact({
  namespace = 'geoly', name = 'plaud-theme-matrix', version = '0.3.6',
  members = [], bundled = [], files = {}, over = {}, docOver = {},
} = {}) {
  const manifest = {
    schema: 'geoly.skills.pack/1', kind: 'pack', namespace, name, version,
    description: '矩阵', license: 'MIT',
    members: members.map((r, i) => ({ id: r.id, tree_digest: r.tree_digest, role: 'matrix', order: i })),
    bundled: bundled.map(r => ({ id: r.id, tree_digest: r.tree_digest, role: 'tool' })),
    conflicts: [], contract_paths: [],
    compatibility: { previous: null, kind: 'breaking', breaking_reasons: ['首版'] },
    ...docOver,
  };
  const root = makeTree({ 'pack.json': stringify(manifest), 'MATRIX.md': '# 矩阵\n', ...files });
  const packed = packDirectory(root);
  return { root, bytes: packed.bytes, packed, manifest, record: recordFor({ kind: 'pack', namespace, name, version, packed, over }) };
}
