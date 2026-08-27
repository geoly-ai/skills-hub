// 制品链：资产验证 → 隔离解包 → 重算树摘要 → manifest 绑定
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertAssetBytes, verifyAndExtract, verifyArtifact, assertManifestBinding,
  assertModeCapabilityBinding, parseFrontmatter, createIsolatedDir, writeEntries,
} from '../src/artifact.mjs';
import { treeDigest } from '../src/tree-digest.mjs';
import { stringify } from '../src/canonical-json.mjs';
import { makeTarGz } from './fixtures/trustchain-tar.mjs';
import { makeRecord, hex } from './fixtures/trustchain-objects.mjs';

const shaOf = (b) => 'sha256:' + createHash('sha256').update(b).digest('hex');

function expectViolation(want, fn) {
  try { fn(); } catch (e) {
    assert.equal(e.violation, want, `期望违规 ${want}，实际 ${e.violation}：${e.message}`);
    return e;
  }
  assert.fail(`期望违规 ${want}，但没有抛错`);
}

/** 造一个自洽的 skill 制品：tar.gz + 与之匹配的 snapshot record */
function makeArtifact(over = {}) {
  const name = over.name ?? 'demo';
  const version = over.version ?? '0.1.0';
  const skillJson = stringify({
    schema: 'geoly.skills.skill/1', kind: 'skill', namespace: 'geoly', name, version,
    description: 'demo skill', license: 'MIT', clients: ['claude'],
    capabilities: over.capabilities ?? ['none'], replaces: [], conflicts: [],
    provenance: { kind: 'original', author_github_id: '1', submitted_by_pr: 2 },
    ...(over.manifestOver ?? {}),
  });
  const skillMd = over.skillMd ?? `---\nname: ${name}\ndescription: demo\n---\n\n# ${name}\n`;
  const files = over.files ?? [
    { path: 'SKILL.md', data: skillMd },
    { path: 'skill.json', data: skillJson },
  ];
  const gz = makeTarGz(files);
  // 先解一次算出真实 tree_digest，再回填进 record —— 这样 record 与字节自洽
  const probe = verifyAndExtractRaw(gz);
  const record = makeRecord({
    name, version,
    capabilities: over.capabilities ?? ['none'],
    tree_digest: over.tree_digest ?? probe,
    asset: { file: `skill_geoly_${name}_${version}.tar.gz`, sha256: shaOf(gz), size: gz.length },
    ...(over.recordOver ?? {}),
  });
  return { gz, record, skillJson, skillMd };
}

/** 只为算摘要：绕过 record 校验解一次 */
function verifyAndExtractRaw(gz, capabilities = ['none']) {
  const fake = makeRecord({ capabilities, asset: { file: 'x', sha256: shaOf(gz), size: gz.length }, tree_digest: `geoly-tree-v1:sha256:${hex(0)}` });
  try {
    verifyAndExtract({ bytes: gz, record: fake });
  } catch (e) {
    const m = /解包后重算 (geoly-tree-v1:sha256:[0-9a-f]{64})/.exec(e.message);
    if (m) return m[1];
    throw e;
  }
  throw new Error('unreachable');
}

// ── 资产摘要 ────────────────────────────────────────────────────────────────

test('asset.sha256 不符 → 拒绝（E_ASSET_SHA256）', () => {
  const { gz, record } = makeArtifact();
  const tampered = Buffer.concat([gz]);
  tampered[tampered.length - 5] ^= 0xff;
  expectViolation('E_ASSET_SHA256', () => assertAssetBytes(tampered, record));
});

test('asset.size 不符 → 拒绝（E_ASSET_SIZE）', () => {
  const { gz, record } = makeArtifact();
  expectViolation('E_ASSET_SIZE', () => assertAssetBytes(gz, { ...record, asset: { ...record.asset, size: 1 } }));
});

test('🔴 不给期望摘要就直接拒绝 —— API 上没有「跳过校验」的口子', () => {
  const { gz } = makeArtifact();
  expectViolation('E_NO_EXPECTED_DIGEST', () => assertAssetBytes(gz, { asset: {} }));
  expectViolation('E_NO_EXPECTED_DIGEST', () => assertAssetBytes(gz, {}));
});

test('🔴 资产字节被篡改时，解包根本不会发生', () => {
  const { gz, record } = makeArtifact();
  const tampered = Buffer.concat([gz]);
  tampered[tampered.length - 5] ^= 0xff;
  expectViolation('E_ASSET_SHA256', () => verifyAndExtract({ bytes: tampered, record }));
});

// ── 解包与树摘要 ────────────────────────────────────────────────────────────

test('正路：解包成功、mode 与内容正确、mtime 置 0', () => {
  const { gz, record } = makeArtifact();
  const r = verifyAndExtract({ bytes: gz, record });
  assert.deepEqual(readdirSync(r.dir).sort(), ['SKILL.md', 'skill.json']);
  const st = lstatSync(join(r.dir, 'SKILL.md'));
  assert.equal(st.mode & 0o777, 0o644);
  assert.equal(st.mtimeMs, 0, '§6.2：mtime 解包时一律置 0');
  assert.equal(treeDigest(r.dir), record.tree_digest);
});

test('嵌套目录：中间目录被建成 0755，且树摘要对得上', () => {
  const files = [
    { path: 'SKILL.md', data: '---\nname: demo\ndescription: d\n---\n' },
    { path: 'refs/a/b.md', data: 'x' },
    { path: 'skill.json', data: '{}' },
  ];
  const gz = makeTarGz(files);
  const td = verifyAndExtractRaw(gz);
  const record = makeRecord({ tree_digest: td, asset: { file: 'a', sha256: shaOf(gz), size: gz.length } });
  const r = verifyAndExtract({ bytes: gz, record });
  assert.equal(lstatSync(join(r.dir, 'refs', 'a')).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(r.dir, 'refs', 'a', 'b.md'), 'utf8'), 'x');
});

test('🔴 树摘要不符 → 拒绝（E_TREE_DIGEST）', () => {
  const { gz, record } = makeArtifact();
  expectViolation('E_TREE_DIGEST',
    () => verifyAndExtract({ bytes: gz, record: { ...record, tree_digest: `geoly-tree-v1:sha256:${hex(7)}` } }));
});

test('🔴 0755 需要 shell capability（mode 进摘要正是因为它关联这条 capability）', () => {
  const entries = [{ path: 'run.sh', mode: 0o755, data: Buffer.from('x') }];
  const e = expectViolation('E_MODE_CAPABILITY', () => assertModeCapabilityBinding(entries, { capabilities: ['none'] }));
  assert.match(e.message, /run\.sh/);
  assertModeCapabilityBinding(entries, { capabilities: ['shell'] }); // 声明了就放行
  assertModeCapabilityBinding([{ path: 'a.md', mode: 0o644 }], { capabilities: ['none'] });
});

test('声明了 shell 的制品，0755 文件能正常装；同样的字节在 none 下被拒', () => {
  const files = [
    { path: 'SKILL.md', data: '---\nname: demo\ndescription: d\n---\n' },
    { path: 'run.sh', mode: 0o755, data: '#!/bin/sh\n' },
    { path: 'skill.json', data: '{}' },
  ];
  const gz = makeTarGz(files);
  const td = verifyAndExtractRaw(gz, ['shell']);
  const asset = { file: 'a', sha256: shaOf(gz), size: gz.length };
  const ok = verifyAndExtract({ bytes: gz, record: makeRecord({ capabilities: ['shell'], tree_digest: td, asset }) });
  assert.equal(lstatSync(join(ok.dir, 'run.sh')).mode & 0o777, 0o755);
  // 🔴 同一串字节，capability 换成 none 就必须被拒 —— 这条绑定不在树摘要里
  expectViolation('E_MODE_CAPABILITY',
    () => verifyAndExtract({ bytes: gz, record: makeRecord({ capabilities: ['none'], tree_digest: td, asset }) }));
});

test('空制品被拒（E_EMPTY_ARTIFACT）', () => {
  const gz = makeTarGz([]);
  const record = makeRecord({ asset: { file: 'a', sha256: shaOf(gz), size: gz.length } });
  expectViolation('E_EMPTY_ARTIFACT', () => verifyAndExtract({ bytes: gz, record }));
});

test('🔴 隔离目录：mode 0700，名字不可预测', () => {
  const d1 = createIsolatedDir();
  const d2 = createIsolatedDir();
  assert.notEqual(d1, d2);
  assert.equal(lstatSync(d1).mode & 0o777, 0o700);
});

test('🔴 隔离目录里被人预先塞了同名文件 → 拒绝写入（E_DEST_DIRTY）', () => {
  const d = createIsolatedDir();
  writeFileSync(join(d, 'SKILL.md'), 'squatted');
  expectViolation('E_DEST_DIRTY', () => writeEntries(d, [{ path: 'SKILL.md', mode: 0o644, data: Buffer.from('x') }]));
});

test('🔴 隔离目录里被人预先塞了同名 symlink → O_NOFOLLOW 挡下（E_DEST_DIRTY）', () => {
  const d = createIsolatedDir();
  const outside = mkdtempSync(join(tmpdir(), 'geoly-outside-'));
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'original');
  symlinkSync(victim, join(d, 'SKILL.md'));
  expectViolation('E_DEST_DIRTY', () => writeEntries(d, [{ path: 'SKILL.md', mode: 0o644, data: Buffer.from('pwned') }]));
  assert.equal(readFileSync(victim, 'utf8'), 'original', '目标文件不得被写穿');
});

// ── frontmatter ─────────────────────────────────────────────────────────────

test('frontmatter：单行 key: value 可解析；引号被剥掉', () => {
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: "a b"\n---\nbody\n'), { name: 'x', description: 'a b' });
});

test('frontmatter：缺 --- / 未闭合 / TAB / 锚点 / 重复 key 一律拒绝', () => {
  expectViolation('E_FRONTMATTER', () => parseFrontmatter('name: x\n'));
  expectViolation('E_FRONTMATTER', () => parseFrontmatter('---\nname: x\n'));
  expectViolation('E_FRONTMATTER', () => parseFrontmatter('---\nname:\tx\n---\n'));
  expectViolation('E_FRONTMATTER', () => parseFrontmatter('---\nname: &a x\n---\n'));
  expectViolation('E_FRONTMATTER', () => parseFrontmatter('---\nname: x\nname: y\n---\n'));
  expectViolation('E_FRONTMATTER', () => parseFrontmatter('---\nnested:\n  a: 1\n---\n'));
});

// ── manifest 绑定（§5.3 六项 + skill 第七项） ─────────────────────────────

test('正路：六项 + 第七项全等时通过', () => {
  const { gz, record } = makeArtifact();
  const r = verifyArtifact({ bytes: gz, record });
  assert.equal(r.manifest.name, 'demo');
  assert.equal(r.frontmatter.name, 'demo');
});

test('🔴 载荷声明的 version 与路径/record 不一致 → 拒绝（v1 能发出这种制品）', () => {
  const { gz, record } = makeArtifact({ manifestOver: { version: '2.0.0' } });
  const e = expectViolation('E_MANIFEST_BINDING', () => verifyArtifact({ bytes: gz, record }));
  assert.match(e.message, /⑤ version/);
});

test('载荷声明的 namespace / name / kind 不一致 → 拒绝', () => {
  for (const [k, v, label] of [['namespace', 'evil', '③'], ['name', 'other', '④'], ['kind', 'pack', '②']]) {
    const { gz, record } = makeArtifact({ manifestOver: { [k]: v } });
    const e = expectViolation('E_MANIFEST_BINDING', () => verifyArtifact({ bytes: gz, record }));
    assert.match(e.message, new RegExp(label));
  }
});

test('🔴 skill.json 里出现 digest 字段 → 专门的违规码（投稿者声明的摘要一律不读）', () => {
  const { gz, record } = makeArtifact({ manifestOver: { digest: `sha256:${hex(1)}` } });
  const e = expectViolation('E_MANIFEST_DIGEST', () => verifyArtifact({ bytes: gz, record }));
  assert.match(e.message, /投稿者声明的摘要一律不读/);
});

test('🔴 SKILL.md frontmatter 的 name 与 record 不一致 → 拒绝（第七项）', () => {
  const { gz, record } = makeArtifact({ skillMd: '---\nname: impostor\ndescription: d\n---\n' });
  const e = expectViolation('E_MANIFEST_BINDING', () => verifyArtifact({ bytes: gz, record }));
  assert.match(e.message, /⑦/);
});

test('🔴 SKILL.md frontmatter 不得带 version（版本只放 skill.json）', () => {
  const { gz, record } = makeArtifact({ skillMd: '---\nname: demo\ndescription: d\nversion: 9.9.9\n---\n' });
  expectViolation('E_MANIFEST_BINDING', () => verifyArtifact({ bytes: gz, record }));
});

test('缺 SKILL.md / skill.json → 拒绝（E_MANIFEST_MISSING）', () => {
  const noManifest = makeTarGz([{ path: 'SKILL.md', data: '---\nname: demo\ndescription: d\n---\n' }]);
  const td = verifyAndExtractRaw(noManifest);
  const rec = makeRecord({ tree_digest: td, asset: { file: 'a', sha256: shaOf(noManifest), size: noManifest.length } });
  expectViolation('E_MANIFEST_MISSING', () => verifyArtifact({ bytes: noManifest, record: rec }));

  const noSkillMd = makeTarGz([{
    path: 'skill.json',
    data: stringify({
      schema: 'geoly.skills.skill/1', kind: 'skill', namespace: 'geoly', name: 'demo', version: '0.1.0',
      description: 'd', license: 'MIT', clients: ['claude'], capabilities: ['none'], replaces: [], conflicts: [],
      provenance: { kind: 'original', author_github_id: '1', submitted_by_pr: 2 },
    }),
  }]);
  const td2 = verifyAndExtractRaw(noSkillMd);
  const rec2 = makeRecord({ tree_digest: td2, asset: { file: 'a', sha256: shaOf(noSkillMd), size: noSkillMd.length } });
  expectViolation('E_MANIFEST_MISSING', () => verifyArtifact({ bytes: noSkillMd, record: rec2 }));
});

test('skill.json 未知字段被拒（additionalProperties: false）', () => {
  const { gz, record } = makeArtifact({ manifestOver: { evil: 1 } });
  expectViolation('E_WIRE_UNKNOWN_FIELD', () => verifyArtifact({ bytes: gz, record }));
});

// 🔴 回归：Codex 指出 pack.json 以前只查 kind/ns/name/version，
// 一份不含 schema/members/bundled 的 manifest 也能过绑定检查。
function makePackArtifact(over = {}) {
  const packJson = stringify({
    schema: over.schema ?? 'geoly.skills.pack/1',
    kind: 'pack', namespace: 'geoly', name: 'matrix', version: '0.1.0',
    description: 'demo pack', license: 'MIT',
    members: over.members ?? [{ id: 'skill:geoly/a@0.1.0', tree_digest: `geoly-tree-v1:sha256:${hex(1)}`, role: 'matrix', order: 0 }],
    bundled: over.bundled ?? [],
    conflicts: [], contract_paths: [],
    compatibility: { previous: '0.0.9', kind: 'compatible', breaking_reasons: [] },
    ...(over.extra ?? {}),
  });
  const gz = makeTarGz([{ path: 'pack.json', data: packJson }]);
  const td = verifyAndExtractRaw(gz);
  const record = makeRecord({
    kind: 'pack', name: 'matrix', version: '0.1.0', tree_digest: td,
    asset: { file: 'pack_geoly_matrix_0.1.0.tar.gz', sha256: shaOf(gz), size: gz.length },
  });
  return { gz, record };
}

test('pack.json：合法的能过绑定检查', () => {
  const { gz, record } = makePackArtifact();
  const r = verifyArtifact({ bytes: gz, record });
  assert.equal(r.manifest.schema, 'geoly.skills.pack/1');
  assert.equal(r.frontmatter, null, 'pack 没有 SKILL.md');
});

test('🔴 pack.json 缺 members/bundled 等必填字段 → 拒绝（以前能蒙混过关）', () => {
  const bare = stringify({ kind: 'pack', namespace: 'geoly', name: 'matrix', version: '0.1.0' });
  const gz = makeTarGz([{ path: 'pack.json', data: bare }]);
  const td = verifyAndExtractRaw(gz);
  const record = makeRecord({
    kind: 'pack', name: 'matrix', version: '0.1.0', tree_digest: td,
    asset: { file: 'a', sha256: shaOf(gz), size: gz.length },
  });
  expectViolation('E_WIRE_MISSING_FIELD', () => verifyArtifact({ bytes: gz, record }));
});

test('pack.json schema 不对 → 拒绝', () => {
  const { gz, record } = makePackArtifact({ schema: 'geoly.skills.pack/2' });
  expectViolation('E_SCHEMA', () => verifyArtifact({ bytes: gz, record }));
});

test('🔴 pack 成员用 semver range 而不是精确版本 → 拒绝（装的时候才知道装到什么）', () => {
  for (const bad of ['skill:geoly/a@^0.1.0', 'skill:geoly/a@~0.1.0', 'skill:geoly/a@*']) {
    const { gz, record } = makePackArtifact({
      members: [{ id: bad, tree_digest: `geoly-tree-v1:sha256:${hex(1)}`, role: 'matrix', order: 0 }],
    });
    expectViolation('E_PACK_MEMBER_ID', () => verifyArtifact({ bytes: gz, record }));
  }
});

test('pack 成员的 tree_digest 必须带算法标识', () => {
  const { gz, record } = makePackArtifact({
    members: [{ id: 'skill:geoly/a@0.1.0', tree_digest: hex(1), role: 'matrix', order: 0 }],
  });
  expectViolation('E_WIRE_DIGEST', () => verifyArtifact({ bytes: gz, record }));
});

test('🔴 恶意 tar 的违规码能一路传到调用方（不是笼统「安装失败」）', () => {
  const gz = makeTarGz([{ path: '../escape.md', data: 'x' }]);
  const rec = makeRecord({ asset: { file: 'a', sha256: shaOf(gz), size: gz.length } });
  const e = expectViolation('E_PATH_DOTDOT', () => verifyAndExtract({ bytes: gz, record: rec }));
  assert.match(e.message, /escape\.md/);
});

// ── Codex 第四轮：artifact 接缝的两个加固点 ────────────────────────────────

test('asset.size 缺失时拒绝校验（E_NO_EXPECTED_SIZE），不是「没有就跳过」', () => {
  const { gz } = makeArtifact();
  const record = { asset: { sha256: shaOf(gz) } }; // 有 sha256、没有 size
  expectViolation('E_NO_EXPECTED_SIZE', () => assertAssetBytes(gz, record));
});

test('asset.size 不符仍然被拒（E_ASSET_SIZE）—— 收紧没有把这条判定弄丢', () => {
  const { gz } = makeArtifact();
  expectViolation('E_ASSET_SIZE',
    () => assertAssetBytes(gz, { asset: { sha256: shaOf(gz), size: gz.length + 1 } }));
});

test('🔴 树摘要不符时隔离临时目录被清理，不会在 /tmp 里堆积', () => {
  const parent = mkdtempSync(join(tmpdir(), 'unpack-parent-'));
  const { gz, record } = makeArtifact();
  const bad = { ...record, tree_digest: `geoly-tree-v1:sha256:${hex(7)}` };

  const before = readdirSync(parent);
  assert.equal(before.length, 0, '前提：父目录一开始必须是空的');

  expectViolation('E_TREE_DIGEST', () => verifyAndExtract({ bytes: gz, record: bad, parent }));

  const after = readdirSync(parent);
  assert.deepEqual(after, [], `失败路径留下了残骸：${after.join(', ')}`);
});

test('成功路径不清理 —— 目录所有权交给调用方', () => {
  const parent = mkdtempSync(join(tmpdir(), 'unpack-parent-ok-'));
  const { gz, record } = makeArtifact();
  const { dir } = verifyAndExtract({ bytes: gz, record, parent });
  assert.ok(existsSync(dir), '成功时目录必须还在，否则调用方拿到的是个空路径');
  assert.ok(existsSync(join(dir, 'SKILL.md')));
});

// ── 隔离目录的生命周期 ───────────────────────────────────────────────────────

test('🔴 withVerifiedArtifact 无论成败都清掉隔离目录', async () => {
  const { withVerifiedArtifact } = await import('../src/artifact.mjs');
  const { existsSync } = await import('node:fs');
  const { gz: bytes, record } = makeArtifact();

  let seen;
  const out = withVerifiedArtifact({ bytes, record }, (art) => {
    seen = art.dir;
    assert.ok(existsSync(seen), 'fn 执行期间目录必须在');
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(existsSync(seen), false, '正常返回后必须清掉');

  let seen2;
  assert.throws(() => withVerifiedArtifact({ bytes, record }, (art) => {
    seen2 = art.dir;
    throw new Error('boom');
  }), /boom/);
  assert.equal(existsSync(seen2), false, '抛错后同样必须清掉');
});

test('🔴 withVerifiedArtifact 支持异步 fn', async () => {
  const { withVerifiedArtifact } = await import('../src/artifact.mjs');
  const { existsSync } = await import('node:fs');
  const { gz: bytes, record } = makeArtifact();

  let seen;
  await withVerifiedArtifact({ bytes, record }, async (art) => {
    seen = art.dir;
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(existsSync(seen), '异步 fn 还没结束时不能提前清');
  });
  assert.equal(existsSync(seen), false, '异步 fn 结束后必须清掉');
});

test('dispose 可重复调用', async () => {
  const { verifyArtifact } = await import('../src/artifact.mjs');
  const { existsSync } = await import('node:fs');
  const { gz: bytes, record } = makeArtifact();
  const art = verifyArtifact({ bytes, record });
  art.dispose();
  assert.equal(existsSync(art.dir), false);
  assert.doesNotThrow(() => art.dispose(), '第二次 dispose 不该抛');
});


// ── DISPOSE_GUARD ────────────────────────────────────────────────────────────
// 🔴 这一份里有十几处直接调 verifyArtifact 的地方，成功路径的隔离目录归调用方清。
// 实测「靠调用方记得」不成立：这一份跑一轮就漏 25 个 geoly-unpack-*，
// 全量跑完 $TMPDIR 里堆了 3807 个。新代码请用 withVerifiedArtifact。
// 下面这条测试盯着这件事，别让它再退回去。

test('🔴 这一份测试自己不许漏隔离目录', async () => {
  const { mkdtempSync, readdirSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { withVerifiedArtifact, verifyArtifact } = await import('../src/artifact.mjs');

  const sandbox = mkdtempSync(join(tmpdir(), 'leakcheck-'));
  const { gz, record } = makeArtifact();

  // 作用域版：结构上不可能漏
  withVerifiedArtifact({ bytes: gz, record, parent: sandbox }, () => {});
  // 裸调用 + 显式 dispose：也不该漏
  verifyArtifact({ bytes: gz, record, parent: sandbox }).dispose();

  const left = readdirSync(sandbox).filter((n) => n.startsWith('geoly-unpack-'));
  assert.deepEqual(left, [], `隔离目录没清干净：${left}`);
  assert.ok(existsSync(sandbox));
});

test('🔴 manifest 绑定失败时也不能留下解包目录', async () => {
  // dispose 原先构造在 assertManifestBinding 之后 —— 绑定一抛错，
  // 目录就没人收，而调用方连 dir 都拿不到（异常里没有它）。
  const { verifyArtifact } = await import('../src/artifact.mjs');
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const sandbox = mkdtempSync(join(tmpdir(), 'bindleak-'));
  // record 与载荷里的 manifest 对不上 → assertManifestBinding 必抛
  const { gz, record } = makeArtifact();
  const bad = { ...record, name: 'not-the-name-in-manifest' };
  assert.throws(() => verifyArtifact({ bytes: gz, record: bad, parent: sandbox }));
  const left = readdirSync(sandbox).filter((n) => n.startsWith('geoly-unpack-'));
  assert.deepEqual(left, [], `绑定失败后仍留下隔离目录：${left}`);
});
