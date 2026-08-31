// submissions/ → artifacts/ 的搬运 —— 06-submission.md §1 / §3。
//
// 🔴 这一份钉的是「先全判后全搬」：一半搬完再失败会留下半新半旧的树，
//    而下一步 build-snapshot 会把它当成完整事实照单全收。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planStaging, stageSubmissions } from '../scripts/promote/stage-submissions.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-stage-')); roots.push(d); return d; };
after(() => {
  for (const d of roots) {
    try { chmodSync(join(d, 'artifacts'), 0o755); } catch { /* 可能不存在 */ }
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

const expectCode = (code, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

/** 造一个投稿目录。`kind` 决定放 skill.json 还是 pack.json。 */
function submit(root, { ns = 'geoly', name, version, kind = 'skill', both = false } = {}) {
  const dir = join(root, 'submissions', ns, `${name}@${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`);
  if (kind === 'skill' || both) writeFileSync(join(dir, 'skill.json'), '{}\n');
  if (kind === 'pack' || both) writeFileSync(join(dir, 'pack.json'), '{}\n');
  return dir;
}

const artRoot = (root) => join(root, 'artifacts');

// ════════════════════════════════════════════════════════════════════════════

test('搬运：布局转换 + 删源 + 返回 id 列表', () => {
  const root = mkroot();
  submit(root, { name: 'alpha', version: '1.0.0' });
  submit(root, { name: 'matrix', version: '2.1.0', kind: 'pack' });

  const ids = stageSubmissions({ submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root) });
  assert.deepEqual(ids, ['pack:geoly/matrix@2.1.0', 'skill:geoly/alpha@1.0.0'], 'id 按字节序');

  assert.ok(existsSync(join(artRoot(root), 'skills', 'geoly', 'alpha', '1.0.0', 'SKILL.md')));
  assert.ok(existsSync(join(artRoot(root), 'packs', 'geoly', 'matrix', '2.1.0', 'pack.json')));
  // 🔴 源要删干净 —— 留着的话下一次 push 会把同一批再 promote 一遍
  assert.ok(!existsSync(join(root, 'submissions', 'geoly')), 'namespace 目录也要清掉');
});

test('🔴 目标已存在 → 拒，且**一个文件都没动**', () => {
  const root = mkroot();
  submit(root, { name: 'alpha', version: '1.0.0' });
  submit(root, { name: 'beta', version: '1.0.0' });
  // beta@1.0.0 已经发布过了
  mkdirSync(join(artRoot(root), 'skills', 'geoly', 'beta', '1.0.0'), { recursive: true });
  writeFileSync(join(artRoot(root), 'skills', 'geoly', 'beta', '1.0.0', 'SKILL.md'), '# 原来的\n');

  expectCode('E_VERSION_TAKEN',
    () => stageSubmissions({ submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root) }));

  // 🔴 alpha 排在 beta 前面，「边搬边判」的实现会把它搬完才发现 beta 有问题
  assert.ok(!existsSync(join(artRoot(root), 'skills', 'geoly', 'alpha')),
    'alpha 不该被搬 —— 先全判后全搬');
  assert.ok(existsSync(join(root, 'submissions', 'geoly', 'alpha@1.0.0')), '源也不该被删');
  assert.equal(
    readdirSync(join(artRoot(root), 'skills', 'geoly', 'beta', '1.0.0')).join(),
    'SKILL.md', '已有制品原封不动');
});

test('🔴 kind 判不出来（两个 manifest 都在 / 都不在）→ 拒', () => {
  const root = mkroot();
  submit(root, { name: 'alpha', version: '1.0.0', both: true });
  expectCode('E_KIND_AMBIGUOUS',
    () => planStaging({ submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root) }));

  const root2 = mkroot();
  const d = join(root2, 'submissions', 'geoly', 'alpha@1.0.0');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), '# x\n');
  expectCode('E_KIND_AMBIGUOUS',
    () => planStaging({ submissionsRoot: join(root2, 'submissions'), artifactsRoot: artRoot(root2) }));
});

test('dry-run 只算不动盘', () => {
  const root = mkroot();
  submit(root, { name: 'alpha', version: '1.0.0' });
  const ids = stageSubmissions({
    submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root), dryRun: true,
  });
  assert.deepEqual(ids, ['skill:geoly/alpha@1.0.0']);
  assert.ok(!existsSync(artRoot(root)));
  assert.ok(existsSync(join(root, 'submissions', 'geoly', 'alpha@1.0.0')));
});

test('submissions/ 为空 → planStaging 返回空（判定交给 CLI）', () => {
  const root = mkroot();
  assert.deepEqual(planStaging({ submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root) }), []);
});

test('🔴 CLI：一个都没有时非零退出，不产出空 promotion', () => {
  const root = mkroot();
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/promote/stage-submissions.mjs'),
    '--submissions', join(root, 'submissions'), '--artifacts', artRoot(root),
  ], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_NOTHING_TO_STAGE\]/);
  assert.equal(r.stdout, '', '空的 id 列表更危险 —— 它会被直接喂给 --new-ids');
});

test('🔴 CLI：stdout 只放 id 列表（要直接喂给 build-inputs 的 --new-ids）', () => {
  const root = mkroot();
  submit(root, { name: 'alpha', version: '1.0.0' });
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/promote/stage-submissions.mjs'),
    '--submissions', join(root, 'submissions'), '--artifacts', artRoot(root),
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'skill:geoly/alpha@1.0.0\n');
});

test('🔴 CLI 拒拼错的选项', () => {
  const root = mkroot();
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/promote/stage-submissions.mjs'),
    '--submisions', join(root, 'submissions'),
  ], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_STAGE_INPUT\]/);
});
