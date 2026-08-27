// vendor 物化器 —— 03-packs.md §6，以及 05-lifecycle.md §6.1 / 08-matrix-migration.md
// §3.1 的双摘要 CI 门。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  materializeVendor, recoverVendor, buildVendoredManifest, verifyVendoredPayload,
  VENDORED_FILE, VENDORED_SCHEMA, STAGING_PREFIX, RETIRED_PREFIX,
} from '../src/vendor.mjs';
import { treeDigest } from '../src/tree-digest.mjs';
import { parseStrict } from '../src/canonical-json.mjs';
import {
  makeTree, cleanupTrees, makeSkillArtifact, makePackArtifact, MIN_SKILL,
} from './fixtures/pack-tree.mjs';

after(cleanupTrees);

const outs = [];
function freshOut() {
  const d = mkdtempSync(join(tmpdir(), 'geoly-vendorout-'));
  outs.push(d);
  return join(d, 'plaud-theme-matrix');
}
after(() => { for (const d of outs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const ZERO_DIGEST = 'geoly-tree-v1:sha256:' + '0'.repeat(64);
function writeIntent(parent, over = {}) {
  const doc = {
    schema: 'geoly.skills.vendor-intent/1',
    out: join(parent, 'vendored'),
    staging: join(parent, `${STAGING_PREFIX}abc123`),
    retired: null,
    tree_digest: ZERO_DIGEST,
    ...over,
  };
  writeFileSync(join(parent, '.geoly-vendor-intent.json'), JSON.stringify(doc) + '\n');
  return doc;
}

function expectCode(want, fn) {
  try { fn(); } catch (err) {
    assert.equal(err.code ?? err.violation, want, `期望 ${want}，实际 ${err.code ?? err.violation}：${err.message}`);
    return err;
  }
  assert.fail(`期望 ${want}，但没有抛错`);
}

function scenario() {
  const shared = makeSkillArtifact({ name: 'plaud-theme-shared', files: { 'references/handoff-schema.md': '# 契约\n' } });
  const dev = makeSkillArtifact({ name: 'plaud-theme-dev' });
  const tool = makeSkillArtifact({ name: 'yidian-draft-pr' });
  const pack = makePackArtifact({ members: [shared.record, dev.record], bundled: [tool.record] });
  return { shared, dev, tool, pack };
}

// ── §6 正路 ────────────────────────────────────────────────────────────────

test('物化：<out>/<member-name>/… + pack 载荷在根上 + VENDORED.json', () => {
  const { shared, dev, tool, pack } = scenario();
  const out = freshOut();
  const r = materializeVendor({
    pack: { bytes: pack.bytes, record: pack.record },
    members: [
      { bytes: shared.bytes, record: shared.record, role: 'matrix' },
      { bytes: dev.bytes, record: dev.record, role: 'matrix' },
      { bytes: tool.bytes, record: tool.record, role: 'tool' },
    ],
    out, snapshot: 42,
  });
  assert.deepEqual(readdirSync(out).sort(),
    ['MATRIX.md', 'VENDORED.json', 'pack.json', 'plaud-theme-dev', 'plaud-theme-shared', 'yidian-draft-pr']);
  // 成员载荷逐字节等于制品里的那份
  assert.equal(readFileSync(join(out, 'plaud-theme-shared/references/handoff-schema.md'), 'utf8'), '# 契约\n');
  assert.equal(r.tree_digest, treeDigest(out));

  const v = parseStrict(readFileSync(join(out, VENDORED_FILE), 'utf8'));
  assert.equal(v.schema, VENDORED_SCHEMA);
  assert.equal(v.pack, 'pack:geoly/plaud-theme-matrix@0.3.6');
  assert.equal(v.snapshot, 42);
  assert.deepEqual(v.members.map(m => m.dir).sort(), ['plaud-theme-dev', 'plaud-theme-shared', 'yidian-draft-pr']);
  // 🔴 记的是 tree_digest（能对着磁盘复算），不是 asset.sha256
  assert.equal(v.members.find(m => m.dir === 'plaud-theme-dev').tree_digest, dev.record.tree_digest);
});

test('整目录替换：旧内容一个不剩，且不会留下半新半旧的混合树', () => {
  const { shared, pack } = scenario();
  const out = freshOut();
  mkdirSync(out, { recursive: true, mode: 0o755 });
  writeFileSync(join(out, 'STALE.md'), '上一轮留下的\n');
  mkdirSync(join(out, 'gone'), { recursive: true, mode: 0o755 });
  writeFileSync(join(out, 'gone/x.md'), 'x');

  const p2 = makePackArtifact({ members: [shared.record], bundled: [] });
  materializeVendor({
    pack: { bytes: p2.bytes, record: p2.record },
    members: [{ bytes: shared.bytes, record: shared.record, role: 'matrix' }],
    out, snapshot: 7,
  });
  assert.equal(existsSync(join(out, 'STALE.md')), false, '🔴 整目录替换，不是逐文件合并');
  assert.equal(existsSync(join(out, 'gone')), false);
  assert.ok(existsSync(join(out, 'plaud-theme-shared/SKILL.md')));
  // 意图文件收尾时必须被删掉
  assert.equal(existsSync(join(out, '..', '.geoly-vendor-intent.json')), false);
});

test('物化失败时 out 保持原样（不留半成品）', () => {
  const { shared, pack } = scenario();
  const out = freshOut();
  mkdirSync(out, { recursive: true, mode: 0o755 });
  writeFileSync(join(out, 'KEEP.md'), '旧的\n');
  // 摘要对不上的成员 → withVerifiedArtifact 抛错
  const broken = { ...shared.record, tree_digest: 'geoly-tree-v1:sha256:' + 'a'.repeat(64) };
  assert.throws(() => materializeVendor({
    pack: { bytes: pack.bytes, record: pack.record },
    members: [{ bytes: shared.bytes, record: broken, role: 'matrix' }],
    out, snapshot: 1,
  }));
  assert.equal(readFileSync(join(out, 'KEEP.md'), 'utf8'), '旧的\n');
  assert.deepEqual(readdirSync(out), ['KEEP.md']);
});

// ── §6 拒绝面 ──────────────────────────────────────────────────────────────

test('layout 只认 flat，别的值不给「合理默认」', () => {
  const { shared, pack } = scenario();
  expectCode('E_VENDOR_LAYOUT', () => materializeVendor({
    pack: { bytes: pack.bytes, record: pack.record },
    members: [{ bytes: shared.bytes, record: shared.record, role: 'matrix' }],
    out: freshOut(), snapshot: 1, layout: 'nested',
  }));
  expectCode('E_VENDOR_LAYOUT', () => buildVendoredManifest({
    packId: 'pack:geoly/m@1.0.0', snapshot: 1, layout: 'tree', members: [],
  }));
});

test('嵌套 pack 成员：flat 布局没有定义，拒绝而不是猜', () => {
  const inner = makePackArtifact({ name: 'inner', members: [], bundled: [] });
  const outer = makePackArtifact({ name: 'outer', members: [], bundled: [] });
  expectCode('E_VENDOR_NESTED_PACK', () => materializeVendor({
    pack: { bytes: outer.bytes, record: outer.record },
    members: [{ bytes: inner.bytes, record: inner.record, role: 'matrix' }],
    out: freshOut(), snapshot: 1,
  }));
});

test('pack 载荷文件与成员目录同名 → 拒绝，不做「谁覆盖谁」的默认', () => {
  const dev = makeSkillArtifact({ name: 'plaud-theme-dev' });
  // pack 载荷里塞一个与成员目录同名的目录
  const pack = makePackArtifact({
    members: [dev.record], bundled: [],
    files: { 'plaud-theme-dev/README.md': '撞名\n' },
  });
  expectCode('E_VENDOR_DIR_COLLIDE', () => materializeVendor({
    pack: { bytes: pack.bytes, record: pack.record },
    members: [{ bytes: dev.bytes, record: dev.record, role: 'matrix' }],
    out: freshOut(), snapshot: 1,
  }));
});

test('两个成员大小写折叠后同名 → 拒绝（macOS 上会互相覆盖）', () => {
  const a = makeSkillArtifact({ name: 'plaud-dev' });
  // 同名不同 namespace：01-artifacts.md §3 说这在同一 target 上是硬冲突
  const b = makeSkillArtifact({ namespace: 'other', name: 'plaud-dev' });
  const pack = makePackArtifact({ members: [a.record, b.record], bundled: [] });
  expectCode('E_VENDOR_DIR_COLLIDE', () => materializeVendor({
    pack: { bytes: pack.bytes, record: pack.record },
    members: [
      { bytes: a.bytes, record: a.record, role: 'matrix' },
      { bytes: b.bytes, record: b.record, role: 'matrix' },
    ],
    out: freshOut(), snapshot: 1,
  }));
});

test('🔴 交上来的成员必须正好是 pack.json 锁定的那一组', () => {
  const { shared, dev, tool, pack } = scenario();
  const args = (members, skipped) => ({
    pack: { bytes: pack.bytes, record: pack.record }, members, out: freshOut(), snapshot: 1, skipped,
  });
  const all = [
    { bytes: shared.bytes, record: shared.record, role: 'matrix' },
    { bytes: dev.bytes, record: dev.record, role: 'matrix' },
    { bytes: tool.bytes, record: tool.record, role: 'tool' },
  ];
  // 少给一个：物化出的树缺东西，而 VENDORED.json 会照样自洽 —— 必须在这里拦
  expectCode('E_VENDOR_MEMBER_MISSING', () => materializeVendor(args(all.slice(0, 2))));
  // 列进 skipped 就允许（--no-bundled 的正常路径）
  const ok = materializeVendor(args(all.slice(0, 2), ['skill:geoly/yidian-draft-pr@0.3.6']));
  assert.deepEqual(ok.skipped, ['skill:geoly/yidian-draft-pr@0.3.6']);
  // 多给一个不属于这个 pack 的 skill
  const stranger = makeSkillArtifact({ name: 'stranger' });
  expectCode('E_VENDOR_MEMBER_EXTRA', () => materializeVendor(
    args([...all, { bytes: stranger.bytes, record: stranger.record, role: 'matrix' }])));
});

test('out 必须是绝对路径；父目录必须存在', () => {
  const { shared, pack } = scenario();
  const args = (out) => ({
    pack: { bytes: pack.bytes, record: pack.record },
    members: [{ bytes: shared.bytes, record: shared.record, role: 'matrix' }],
    out, snapshot: 1,
  });
  expectCode('E_VENDOR_INPUT', () => materializeVendor(args('relative/dir')));
  expectCode('E_VENDOR_INPUT', () => materializeVendor(args('/nonexistent-parent-xyz/out')));
});

// ── 恢复协议 ───────────────────────────────────────────────────────────────

test('recoverVendor：没有意图文件时什么都不做', () => {
  const d = mkdtempSync(join(tmpdir(), 'geoly-vr-'));
  outs.push(d);
  assert.deepEqual(recoverVendor(d), { action: 'none' });
});

test('recoverVendor：staging 还在、out 不在 → 前滚，且前滚前重算摘要', () => {
  const parent = mkdtempSync(join(tmpdir(), 'geoly-vr-'));
  outs.push(parent);
  const staging = join(parent, `${STAGING_PREFIX}abc123`);
  mkdirSync(staging, { recursive: true, mode: 0o755 });
  writeFileSync(join(staging, 'a.md'), 'new\n');
  const { out } = writeIntent(parent, { staging, tree_digest: treeDigest(staging) });
  assert.deepEqual(recoverVendor(parent), { action: 'rolled-forward', out });
  assert.equal(readFileSync(join(out, 'a.md'), 'utf8'), 'new\n');
  assert.equal(existsSync(join(parent, '.geoly-vendor-intent.json')), false);
});

test('🔴 recoverVendor：staging 的摘要与意图不符 → 拒绝前滚（意图文件只指路，不作数）', () => {
  const parent = mkdtempSync(join(tmpdir(), 'geoly-vr-'));
  outs.push(parent);
  const staging = join(parent, `${STAGING_PREFIX}abc123`);
  mkdirSync(staging, { recursive: true, mode: 0o755 });
  writeFileSync(join(staging, 'a.md'), 'tampered\n');
  const { out } = writeIntent(parent, { staging });   // tree_digest 是全零，对不上
  expectCode('E_VENDOR_RECOVER', () => recoverVendor(parent));
  assert.equal(existsSync(out), false, '拒绝前滚就不能把它换上去');
});

test('recoverVendor：只剩 retired → 把旧树放回去', () => {
  const parent = mkdtempSync(join(tmpdir(), 'geoly-vr-'));
  outs.push(parent);
  const retired = join(parent, `${RETIRED_PREFIX}x`);
  mkdirSync(retired, { recursive: true, mode: 0o755 });
  writeFileSync(join(retired, 'old.md'), 'old\n');
  const { out } = writeIntent(parent, { staging: join(parent, `${STAGING_PREFIX}gone`), retired });
  assert.deepEqual(recoverVendor(parent), { action: 'restored-old', out });
  assert.equal(readFileSync(join(out, 'old.md'), 'utf8'), 'old\n');
});

test('🔴 intent 必须是最后一个消失的东西：删 retired 失败时 intent 还在，orphan 可回收', async () => {
  // Codex 第二轮 #1：若先删 intent 再删 retired，两者之间崩一下就留下
  // 「intent 没了、retired 还在」——recoverVendor 返回 none，那棵旧树永远回收不掉。
  // 这条测试用故障注入把 rmtree 打断，断言 intent **仍然在**。
  const { arm, disarm, reset } = await import('../src/fault-inject.mjs');
  const shared = makeSkillArtifact({ name: 'plaud-theme-shared' });
  const pack = makePackArtifact({ members: [shared.record], bundled: [] });
  const out = freshOut();
  const parent = join(out, '..');
  mkdirSync(out, { recursive: true, mode: 0o755 });
  writeFileSync(join(out, 'OLD.md'), 'old\n');

  const args = {
    pack: { bytes: pack.bytes, record: pack.record },
    members: [{ bytes: shared.bytes, record: shared.record, role: 'matrix' }],
    out, snapshot: 1,
  };
  disarm(); reset();
  // rmtree 在物化过程里会被调到多次（清 staging 等），这里打最后那次：删 retired。
  // 用 mode:'throw' 让它抛，模拟「删到一半失败/崩溃」。
  arm({ name: 'rmtree:pre', nth: 1, mode: 'throw' });
  let threw = false;
  try { materializeVendor(args); } catch { threw = true; } finally { disarm(); reset(); }
  assert.ok(threw, '注入没生效，这条测试就没测到东西');

  // 🔴 判据：intent 还在 → recoverVendor 有据可依
  assert.equal(existsSync(join(parent, '.geoly-vendor-intent.json')), true,
    'intent 必须是最后一个消失的东西，否则残留的旧树无人认领');
  const r = recoverVendor(parent);
  assert.ok(['already-done', 'rolled-forward', 'rolled-back', 'restored-old'].includes(r.action), r.action);
  // 收敛之后：out 在，parent 下不再有 .geoly-vendor-old-* 残留
  assert.equal(existsSync(out), true);
  assert.deepEqual(readdirSync(parent).filter(n => n.startsWith(RETIRED_PREFIX)), []);
  assert.equal(existsSync(join(parent, '.geoly-vendor-intent.json')), false);
});

// ── 意图文件是磁盘上的普通文件，谁都能改它，而 recover 会照着它删目录 ────────

test('🔴 恶意意图文件不能让 recover 替攻击者删任意目录', () => {
  const parent = mkdtempSync(join(tmpdir(), 'geoly-vr-'));
  const victim = mkdtempSync(join(tmpdir(), 'geoly-victim-'));
  outs.push(parent, victim);
  mkdirSync(join(victim, 'precious'), { recursive: true, mode: 0o755 });
  writeFileSync(join(victim, 'precious/data.md'), '别删我\n');

  // ① staging 指到别人家
  writeIntent(parent, { staging: join(victim, 'precious') });
  expectCode('E_VENDOR_INTENT', () => recoverVendor(parent));
  // ② staging 在 parent 下但不带我们的前缀
  writeIntent(parent, { staging: join(parent, 'not-ours') });
  expectCode('E_VENDOR_INTENT', () => recoverVendor(parent));
  // ③ retired 指到别人家
  writeIntent(parent, { retired: join(victim, 'precious') });
  expectCode('E_VENDOR_INTENT', () => recoverVendor(parent));
  // ④ tree_digest 形状不对
  writeIntent(parent, { tree_digest: 'not-a-digest' });
  expectCode('E_VENDOR_INTENT', () => recoverVendor(parent));
  // ⑤ 缺 retired 字段（旧版会在 existsSync(undefined) 上抛 TypeError）
  const p5 = join(parent, '.geoly-vendor-intent.json');
  writeFileSync(p5, JSON.stringify({
    schema: 'geoly.skills.vendor-intent/1', out: join(parent, 'vendored'),
    staging: join(parent, `${STAGING_PREFIX}a`), tree_digest: ZERO_DIGEST,
  }) + '\n');
  expectCode('E_VENDOR_INTENT', () => recoverVendor(parent));

  assert.equal(readFileSync(join(victim, 'precious/data.md'), 'utf8'), '别删我\n');
});

test('🔴 意图文件被截断 → 报错并保留它，不当作「没有未收尾的事务」', () => {
  const parent = mkdtempSync(join(tmpdir(), 'geoly-vr-'));
  outs.push(parent);
  writeFileSync(join(parent, '.geoly-vendor-intent.json'), '{"schema":"geoly.sk');
  expectCode('E_VENDOR_INTENT', () => recoverVendor(parent));
  assert.equal(existsSync(join(parent, '.geoly-vendor-intent.json')), true, '删掉它等于把「没收尾」这个事实也抹掉');
});

test('🔴 recover 不跟随 symlink：out/staging/retired 任一是 symlink 都拒', () => {
  const parent = mkdtempSync(join(tmpdir(), 'geoly-vr-'));
  const real = mkdtempSync(join(tmpdir(), 'geoly-real-'));
  outs.push(parent, real);
  symlinkSync(real, join(parent, 'vendored'));
  writeIntent(parent);
  expectCode('E_VENDOR_RECOVER', () => recoverVendor(parent));
  assert.equal(existsSync(join(real)), true);
});

test('🔴 out 是悬空 symlink 时不得被当成「目标不存在」直接覆盖', () => {
  const shared = makeSkillArtifact({ name: 'plaud-theme-shared' });
  const pack = makePackArtifact({ members: [shared.record], bundled: [] });
  const parent = mkdtempSync(join(tmpdir(), 'geoly-vr-'));
  outs.push(parent);
  const out = join(parent, 'vendored');
  symlinkSync(join(parent, 'nowhere-at-all'), out);   // 悬空：existsSync 会返回 false
  expectCode('E_VENDOR_TARGET', () => materializeVendor({
    pack: { bytes: pack.bytes, record: pack.record },
    members: [{ bytes: shared.bytes, record: shared.record, role: 'matrix' }],
    out, snapshot: 1,
  }));
});

test('上一次没收尾时不许覆盖意图文件', () => {
  const shared = makeSkillArtifact({ name: 'plaud-theme-shared' });
  const pack = makePackArtifact({ members: [shared.record], bundled: [] });
  const parent = mkdtempSync(join(tmpdir(), 'geoly-vr-'));
  outs.push(parent);
  writeFileSync(join(parent, '.geoly-vendor-intent.json'), '{}');
  expectCode('E_VENDOR_INTENT_PENDING', () => materializeVendor({
    pack: { bytes: pack.bytes, record: pack.record },
    members: [{ bytes: shared.bytes, record: shared.record, role: 'matrix' }],
    out: join(parent, 'v'), snapshot: 1,
  }));
});

// ── 05-lifecycle §6.1 / 08-matrix §3.1 双摘要 ──────────────────────────────

test('verifyVendoredPayload：去掉 skill.json 之后逐字节等于上游，且摘要相符', () => {
  const origin = makeTree({ 'SKILL.md': '---\nname: x\ndescription: d\n---\n', 'refs/a.md': 'A' });
  const hub = makeTree({
    'SKILL.md': '---\nname: x\ndescription: d\n---\n', 'refs/a.md': 'A',
    'skill.json': '{"schema":"geoly.skills.skill/1"}\n',
  });
  const r = verifyVendoredPayload({
    hubPayloadDir: hub, originDir: origin, addedFiles: ['skill.json'],
    expectedOriginTreeDigest: treeDigest(origin),
  });
  assert.equal(r.origin_tree_digest, treeDigest(origin));
  assert.deepEqual(r.added_files, ['skill.json']);
  // 🔴 双摘要必然不相等 —— v1 承诺两者一致，那是错的
  assert.notEqual(treeDigest(hub), treeDigest(origin));
});

test('🔴 added_files 白名单只允许 skill.json，任何其它新增都让门失败', () => {
  const origin = makeTree({ 'SKILL.md': '---\nname: x\n---\n' });
  const hub = makeTree({ 'SKILL.md': '---\nname: x\n---\n', 'skill.json': '{}\n', 'EXTRA.md': '偷带\n' });
  expectCode('E_VENDORED_EXTRA', () => verifyVendoredPayload({
    hubPayloadDir: hub, originDir: origin, addedFiles: ['skill.json'],
    expectedOriginTreeDigest: treeDigest(origin),
  }));
  // 把它列进 added_files 也不行 —— 白名单是硬编码的
  expectCode('E_VENDORED_ADDED', () => verifyVendoredPayload({
    hubPayloadDir: hub, originDir: origin, addedFiles: ['skill.json', 'EXTRA.md'],
    expectedOriginTreeDigest: treeDigest(origin),
  }));
});

test('🔴 任何修改 / 删除都让门失败；判据是逐字节，不是「文件在不在」', () => {
  const origin = makeTree({ 'SKILL.md': '---\nname: x\n---\n', 'refs/a.md': 'A' });
  // 修改：文件都在，内容变了
  const modified = makeTree({ 'SKILL.md': '---\nname: x\n---\n', 'refs/a.md': 'B', 'skill.json': '{}\n' });
  expectCode('E_VENDORED_MODIFIED', () => verifyVendoredPayload({
    hubPayloadDir: modified, originDir: origin, addedFiles: ['skill.json'],
    expectedOriginTreeDigest: treeDigest(origin),
  }));
  // 删除
  const deleted = makeTree({ 'SKILL.md': '---\nname: x\n---\n', 'skill.json': '{}\n' });
  expectCode('E_VENDORED_MISSING', () => verifyVendoredPayload({
    hubPayloadDir: deleted, originDir: origin, addedFiles: ['skill.json'],
    expectedOriginTreeDigest: treeDigest(origin),
  }));
  // mode 变了也是修改（mode 进树摘要，且关联 shell capability）
  const chmoded = makeTree({
    'SKILL.md': '---\nname: x\n---\n', 'refs/a.md': { data: 'A', mode: 0o755 }, 'skill.json': '{}\n',
  });
  expectCode('E_VENDORED_MODIFIED', () => verifyVendoredPayload({
    hubPayloadDir: chmoded, originDir: origin, addedFiles: ['skill.json'],
    expectedOriginTreeDigest: treeDigest(origin),
  }));
});

test('🔴 用 added_files 掩盖一次修改：上游已有同名文件时不算新增', () => {
  const origin = makeTree({ 'SKILL.md': '---\nname: x\n---\n', 'skill.json': '上游自己的\n' });
  const hub = makeTree({ 'SKILL.md': '---\nname: x\n---\n', 'skill.json': 'hub 改过的\n' });
  expectCode('E_VENDORED_ADDED', () => verifyVendoredPayload({
    hubPayloadDir: hub, originDir: origin, addedFiles: ['skill.json'],
    expectedOriginTreeDigest: treeDigest(origin),
  }));
});

test('origin_tree_digest 对不上 → 拒绝（证明「导入的内容确实来自那个 commit」）', () => {
  const origin = makeTree(MIN_SKILL);
  const hub = makeTree(MIN_SKILL);
  expectCode('E_VENDORED_ORIGIN_DIGEST', () => verifyVendoredPayload({
    hubPayloadDir: hub, originDir: origin, addedFiles: [],
    expectedOriginTreeDigest: 'geoly-tree-v1:sha256:' + '0'.repeat(64),
  }));
});

test('added_files 缺失或重复都拒（ERRATA E-1：它是必填）', () => {
  const origin = makeTree(MIN_SKILL);
  expectCode('E_VENDORED_ADDED', () => verifyVendoredPayload({
    hubPayloadDir: origin, originDir: origin, addedFiles: undefined,
    expectedOriginTreeDigest: treeDigest(origin),
  }));
  expectCode('E_VENDORED_ADDED', () => verifyVendoredPayload({
    hubPayloadDir: origin, originDir: origin, addedFiles: ['skill.json', 'skill.json'],
    expectedOriginTreeDigest: treeDigest(origin),
  }));
});
