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

// ── Codex 2026-08-31 的四条 ────────────────────────────────────────────────

test('🔴 `alpha@.` / `alpha@..` 会映射到同一个目标 → 在预检就拒', () => {
  for (const version of ['.', '..']) {
    const root = mkroot();
    submit(root, { name: 'alpha', version });
    expectCode('E_BAD_SEGMENT',
      () => planStaging({ submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root) }));
  }
});

test('🔴 同 namespace 内 skill 与 pack 同名 → 拒（01-artifacts §2）', () => {
  const root = mkroot();
  // 目录名不带 kind，所以 `foo@1.0.0` 与 `foo@2.0.0` 可以一个是 skill 一个是 pack
  submit(root, { name: 'foo', version: '1.0.0', kind: 'skill' });
  submit(root, { name: 'foo', version: '2.0.0', kind: 'pack' });
  expectCode('E_NAME_TAKEN',
    () => planStaging({ submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root) }));
});

test('🔴 已经作为另一种 kind 存在于 artifacts/ → 拒', () => {
  const root = mkroot();
  submit(root, { name: 'foo', version: '1.0.0', kind: 'skill' });
  mkdirSync(join(artRoot(root), 'packs', 'geoly', 'foo', '9.0.0'), { recursive: true });
  expectCode('E_NAME_TAKEN',
    () => planStaging({ submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root) }));
});

test('🔴🔴 积压：submissions/ 里有上一次没搬走的，会被错误标成本次 PR 审过的', () => {
  const root = mkroot();
  submit(root, { name: 'alpha', version: '1.0.0' });   // 本次 PR 带来的
  submit(root, { name: 'stale', version: '0.1.0' });   // 上一次 promote 没跑完
  const args = { submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root) };

  // 不给 --only 时它就这么一起搬走了 —— 这正是要拦的
  assert.equal(planStaging(args).length, 2);

  const e = expectCode('E_SUBMISSIONS_MISMATCH',
    () => planStaging({ ...args, only: ['geoly/alpha@1.0.0'] }));
  assert.match(e.message, /geoly\/stale@0\.1\.0/, '要指名道姓，否则没人知道积压的是哪个');

  // 名单里有、盘上没有 —— 同样是前提不成立
  expectCode('E_SUBMISSIONS_MISMATCH',
    () => planStaging({ ...args, only: ['geoly/alpha@1.0.0', 'geoly/stale@0.1.0', 'geoly/ghost@1.0.0'] }));
  // 对得上就放行
  assert.equal(planStaging({ ...args, only: ['geoly/alpha@1.0.0', 'geoly/stale@0.1.0'] }).length, 2);
});

test('🔴 搬到一半失败 → 已经搬好的要撤掉，不留半棵树', () => {
  const root = mkroot();
  submit(root, { name: 'alpha', version: '1.0.0' });
  submit(root, { name: 'beta', version: '1.0.0' });
  // beta 的目标父目录被一个**普通文件**占着 → mkdir 会 ENOTDIR。
  // 预检看的是 `<...>/beta/1.0.0` 存不存在，所以这一步是过得去的 ——
  // 「预检通过 ≠ 搬得动」正是这条要钉的。
  mkdirSync(join(artRoot(root), 'skills', 'geoly'), { recursive: true });
  writeFileSync(join(artRoot(root), 'skills', 'geoly', 'beta'), '不是目录\n');
  const plan = planStaging({ submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root) });
  assert.equal(plan.length, 2);

  assert.throws(() => stageSubmissions({
    submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root),
  }));
  assert.ok(!existsSync(join(artRoot(root), 'skills', 'geoly', 'alpha')),
    '🔴 alpha 已经搬好了，必须撤掉 —— 下一步 build-snapshot 会把半棵树当成完整事实');
});

test('🔴 PROMOTION.json 是描述符，不该跟着搬进 artifacts/', () => {
  // 搬进去的话：① 它会进 tree_digest 与资产字节，用户装到一份内部材料；
  // ② vendored 的 origin_tree_digest 永远对不上（多了一个上游没有的文件）
  const root = mkroot();
  const dir = join(root, 'submissions', 'geoly', 'alpha@1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# alpha\n');
  writeFileSync(join(dir, 'skill.json'), '{}\n');
  writeFileSync(join(dir, 'PROMOTION.json'), '{"schema":"geoly.skills.promotion-file/1"}');

  stageSubmissions({ submissionsRoot: join(root, 'submissions'), artifactsRoot: artRoot(root) });
  const out = readdirSync(join(artRoot(root), 'skills', 'geoly', 'alpha', '1.0.0')).sort();
  assert.deepEqual(out, ['SKILL.md', 'skill.json']);
});
