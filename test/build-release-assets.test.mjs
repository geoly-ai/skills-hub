// 阶段 C 的资产重建与比对 —— 06-submission.md §1。
//
// 🔴 这一份钉的是「签名签的是快照，用户下载的是资产」：两者对不上就是一次
//    静默的分发事故 —— 验签过得去，装出来的东西却不是被审过的那个。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { buildReleaseAssets, resolveArtifactDir } from '../scripts/release/build-release-assets.mjs';
import { buildSnapshot } from '../scripts/build-snapshot.mjs';
import { stringify } from '../src/canonical-json.mjs';
import { makeSkillArtifact, makePackArtifact, cleanupTrees } from './fixtures/pack-tree.mjs';

after(cleanupTrees);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-rel-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const expectCode = (code, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

const OWNER = { kind: 'org', login: 'geoly-ai', id: 'MDQ6' };
const PROV = { kind: 'original', author_github_id: '123', submitted_by_pr: 118 };
const REVIEW = { pr: 118, approved_by: ['m1'], head_sha: 'c'.repeat(40), capability_tier: 0 };

function place(root, art) {
  const { kind, namespace, name, version } = art.record;
  const dir = join(root, 'artifacts', `${kind}s`, namespace, name, version);
  mkdirSync(dir, { recursive: true });
  cpSync(art.root, dir, { recursive: true });
  return art;
}

/** 一棵 artifacts/ 树 + 一张与它自洽的快照。 */
function scene({ withPack = false } = {}) {
  const root = mkroot();
  const a = place(root, makeSkillArtifact({ name: 'alpha' }));
  const arts = [a];
  if (withPack) arts.push(place(root, makePackArtifact({ name: 'matrix', members: [a.record] })));
  const artifacts = {};
  for (const x of arts) {
    artifacts[x.record.id] = { status: 'published', owner: OWNER, review: REVIEW, provenance: PROV };
  }
  const { doc } = buildSnapshot({
    artifactsRoot: join(root, 'artifacts'),
    inputs: { schema: 'geoly.skills.promotion-inputs/1', artifacts, yanked: [] },
    snapshot: 0, previous: 0,
    createdAt: '2026-08-25T12:00:00Z', repo: 'geoly-ai/skills-hub',
  });
  return { root, artifactsRoot: join(root, 'artifacts'), doc, bytes: Buffer.from(stringify(doc), 'utf8') };
}

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

// ════════════════════════════════════════════════════════════════════════════

test('🔴 目录由已验过的 record.path 得出，不再从 id 正则解析', () => {
  // 从 id 解析的写法（`([^@]+)@(.+)`）会把 `../../etc` 一并吃进 version
  assert.equal(resolveArtifactDir('/r', 'artifacts/skills/geoly/alpha/1.0.0'),
    '/r/skills/geoly/alpha/1.0.0');
  expectCode('E_ASSET_INPUT', () => resolveArtifactDir('/r', 'somewhere/else'));
  for (const p of ['artifacts/../../etc', 'artifacts/skills/../../..', 'artifacts//x']) {
    expectCode('E_ASSET_INPUT', () => resolveArtifactDir('/r', p));
  }
});

test('🔴 输出目录必须是空的 —— 残留会被一起挂上 Release', () => {
  const s = scene();
  const out = join(mkroot(), 'assets');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, '上一轮残留的.tgz'), 'x');
  expectCode('E_ASSET_INPUT',
    () => buildReleaseAssets({ artifactsRoot: s.artifactsRoot, snapshotBytes: s.bytes, outDir: out }));
});

test('自洽的树：全部重建成功，且写出的字节 sha256 与快照记录一致', () => {
  const s = scene({ withPack: true });
  const out = join(mkroot(), 'assets');
  const r = buildReleaseAssets({ artifactsRoot: s.artifactsRoot, snapshotBytes: s.bytes, outDir: out });
  assert.equal(r.built, 2);

  const files = readdirSync(out).sort();
  assert.equal(files.length, 2);
  // 🔴 写出去的**就是**快照记录的那些字节 —— 这是整条链的落点
  for (const rec of s.doc.artifacts) {
    const bytes = readFileSync(join(out, rec.asset.file));
    assert.equal(sha(bytes), rec.asset.sha256, rec.id);
    assert.equal(bytes.length, rec.asset.size, rec.id);
  }
});

test('不给 --out 时只比对、不写盘', () => {
  const s = scene();
  const r = buildReleaseAssets({ artifactsRoot: s.artifactsRoot, snapshotBytes: s.bytes });
  assert.equal(r.built, 1);
});

test('🔴🔴 merge 之后载荷被动过一个字节 → 拒（这正是这一步存在的理由）', () => {
  // promotion PR 上验过一次，但那之后隔着一次 merge
  const s = scene();
  writeFileSync(join(s.artifactsRoot, 'skills', 'geoly', 'alpha', '0.3.6', 'SKILL.md'),
    '---\nname: alpha\ndescription: alpha 的描述\n---\n\n合并之后被动过的正文\n');
  const e = expectCode('E_ASSET_MISMATCH',
    () => buildReleaseAssets({ artifactsRoot: s.artifactsRoot, snapshotBytes: s.bytes }));
  assert.match(e.message, /对不上/);
  assert.match(e.message, /静默的\n?\s*分发事故|静默的/, '要说清楚后果，不然下次有人会想「重签一下就好」');
});

test('🔴 快照里有、树里没有 → 拒（不能挂一个缺资产的 Release）', () => {
  const s = scene();
  rmSync(join(s.artifactsRoot, 'skills'), { recursive: true, force: true });
  const e = expectCode('E_ASSET_MISMATCH',
    () => buildReleaseAssets({ artifactsRoot: s.artifactsRoot, snapshotBytes: s.bytes }));
  assert.match(e.message, /不存在/);
});

test('🔴 一次把**所有**对不上的都报出来，不是遇到第一个就退', () => {
  const s = scene({ withPack: true });
  rmSync(join(s.artifactsRoot, 'skills'), { recursive: true, force: true });
  rmSync(join(s.artifactsRoot, 'packs'), { recursive: true, force: true });
  const e = expectCode('E_ASSET_MISMATCH',
    () => buildReleaseAssets({ artifactsRoot: s.artifactsRoot, snapshotBytes: s.bytes }));
  assert.match(e.message, /^2 个制品/, '让人一次看全，而不是修一个跑一轮');
});

test('🔴 yank 掉的制品**照样**重建 —— 装过它的用户还要能校验', () => {
  const root = mkroot();
  const a = place(root, makeSkillArtifact({ name: 'alpha' }));
  const { doc } = buildSnapshot({
    artifactsRoot: join(root, 'artifacts'),
    inputs: {
      schema: 'geoly.skills.promotion-inputs/1',
      artifacts: { [a.record.id]: { status: 'published', owner: OWNER, review: REVIEW, provenance: PROV } },
      yanked: [{ id: a.record.id, at: '2026-08-26T00:00:00Z', reason: '安全问题' }],
    },
    snapshot: 0, previous: 0, createdAt: '2026-08-25T12:00:00Z', repo: 'geoly-ai/skills-hub',
  });
  assert.equal(doc.artifacts[0].status, 'yanked', '前提：它确实是 yanked');
  const r = buildReleaseAssets({
    artifactsRoot: join(root, 'artifacts'),
    snapshotBytes: Buffer.from(stringify(doc), 'utf8'),
  });
  assert.equal(r.built, 1, '不挂资产等于让装过它的用户 check 失败');
});

test('🔴 读不回来的快照直接拒 —— 谈不上「按它重建」', () => {
  const s = scene();
  assert.throws(() => buildReleaseAssets({
    artifactsRoot: s.artifactsRoot, snapshotBytes: Buffer.from('不是 json'),
  }));
});

// ── CLI ────────────────────────────────────────────────────────────────────

test('🔴 CLI：一致时 0，不一致时非零且打出错误码', () => {
  const s = scene();
  const snapFile = join(s.root, 'hub-0.json');
  writeFileSync(snapFile, s.bytes);
  const out = join(mkroot(), 'assets');

  const ok = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/release/build-release-assets.mjs'),
    '--artifacts', s.artifactsRoot, '--snapshot', snapFile, '--out', out,
  ], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /逐字节一致/);
  assert.equal(readdirSync(out).length, 1);

  writeFileSync(join(s.artifactsRoot, 'skills', 'geoly', 'alpha', '0.3.6', 'SKILL.md'), '被动过\n');
  const bad = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/release/build-release-assets.mjs'),
    '--artifacts', s.artifactsRoot, '--snapshot', snapFile,
  ], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /\[E_ASSET_MISMATCH\]/);
});

test('🔴 CLI 拒拼错的选项', () => {
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/release/build-release-assets.mjs'), '--artifact', 'x',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_ASSET_INPUT\]/);
});

test('🔴 文件名里的 N 与正文的 snapshot 必须绑定', () => {
  // `hub-9.json` 里装一张自洽的 `snapshot: 8` —— 不绑定的话它一路绿到底，
  // 最后 Release 上挂出一张名字是错的快照
  const s = scene();
  assert.throws(() => buildReleaseAssets({
    artifactsRoot: s.artifactsRoot, snapshotBytes: s.bytes, expectSnapshot: 9,
  }), /E_SNAPSHOT_N|snapshot/);
  // 对得上时正常
  const r = buildReleaseAssets({
    artifactsRoot: s.artifactsRoot, snapshotBytes: s.bytes, expectSnapshot: 0,
  });
  assert.equal(r.snapshot, 0);
});

test('🔴 CLI 把用了哪一张、摘要是多少输出到 stdout（下游拿它当真值）', () => {
  const s = scene();
  const dir = join(mkroot(), 'snapshots');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hub-0.json'), s.bytes);
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/release/build-release-assets.mjs'),
    '--artifacts', s.artifactsRoot, '--snapshots-dir', dir,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^snapshot_n=0$/m);
  assert.match(r.stdout, new RegExp(`^snapshot_sha256=${createHash('sha256').update(s.bytes).digest('hex')}$`, 'm'));
});

test('🔴 CLI：快照目录里文件名与正文对不上 → 拒', () => {
  const s = scene();
  const dir = join(mkroot(), 'snapshots');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hub-9.json'), s.bytes);   // 正文是 snapshot: 0
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/release/build-release-assets.mjs'),
    '--artifacts', s.artifactsRoot, '--snapshots-dir', dir,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 1);
});

test('CLI：快照目录不存在 → no-op（第一次 promotion 之前就是这样）', () => {
  const s = scene();
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/release/build-release-assets.mjs'),
    '--artifacts', s.artifactsRoot, '--snapshots-dir', join(mkroot(), '没有'),
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('🔴 --snapshot 与 --snapshots-dir 必须给且只给一个', () => {
  const s = scene();
  for (const extra of [[], ['--snapshot', 'x', '--snapshots-dir', 'y']]) {
    const r = spawnSync(process.execPath, [
      join(REPO_ROOT, 'scripts/release/build-release-assets.mjs'),
      '--artifacts', s.artifactsRoot, ...extra,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[E_ASSET_INPUT\]/);
  }
});
