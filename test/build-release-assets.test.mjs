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

import { buildReleaseAssets, parseArtifactId } from '../scripts/release/build-release-assets.mjs';
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

test('parseArtifactId：认得出四段', () => {
  assert.deepEqual(parseArtifactId('skill:geoly/alpha@1.0.0'),
    { kind: 'skill', namespace: 'geoly', name: 'alpha', version: '1.0.0' });
  // 版本里可以有 `-rc.1`、`+` 不允许（那是 01-artifacts 的事，这里只要能切开）
  assert.equal(parseArtifactId('pack:a/b@1.0.0-rc.1').version, '1.0.0-rc.1');
  expectCode('E_ASSET_INPUT', () => parseArtifactId('不是 id'));
  expectCode('E_ASSET_INPUT', () => parseArtifactId('other:a/b@1.0.0'));
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
