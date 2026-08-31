// PR 分流与路径白名单 —— 06-submission.md §4 / §5。
//
// 🔴 这是一道**安全门**：§4 明确警告「不能配成『任一通过即可』，否则投稿 PR
//    可以伪装成 promotion 分支绕过路径白名单」。所以这一份里最要紧的用例
//    是那条伪装：分支名像 promotion、作者却不是 bot。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyPr, assertPathsAllowed, PROMOTION_PATHS, SUBMISSION_PATHS, SUBMISSION_DENY,
} from '../scripts/submission/pr-classify.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BOT_ID = 'MDQ6Bot_release';
const REPO = 'geoly-ai/skills-hub';
/** 默认是「合法的 promotion PR」，各用例只覆盖它要变的那一项。 */
const cls = (over = {}) => classifyPr({
  headRef: 'promotion/hub-42', authorId: BOT_ID, releaseBotId: BOT_ID,
  headRepo: REPO, thisRepo: REPO, authorLogin: 'bot', ...over,
});

const expectCode = (code, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

// ════════════════════════════════════════════════════════════════════════════
// §4 router
// ════════════════════════════════════════════════════════════════════════════

test('promotion 要**同时**满足：分支名、作者是 bot、且来自本仓库', () => {
  assert.equal(cls(), 'promotion');
  assert.equal(cls({ authorId: 'MDQ6User_路人' }), 'submission', '作者不是 bot');
  assert.equal(cls({ headRepo: '攻击者/skills-hub' }), 'submission', 'promotion 分支不能来自 fork');
  assert.equal(cls({ headRef: 'submit/geoly/alpha@1.0.0' }), 'submission', 'bot 也可能开别的 PR');
});

test('🔴 判据是不可变 node id，不是 login —— login 可改名、可被重新认领', () => {
  // bot 改名后 workflow 配置还留着旧 login，攻击者认领那个旧 login 就能凑齐条件。
  // 用 id 之后，同一个 login 配不同 id 一律不是 bot。
  assert.equal(cls({ authorId: 'MDQ6User_冒名者', authorLogin: 'geoly-release-bot' }), 'submission');
});

test('🔴 伪装成 promotion 分支的 PR：仍按 submission 处理，且**大声说出来**', () => {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (x) => { chunks.push(String(x)); return true; };
  try {
    assert.equal(cls({ headRef: 'promotion/hub-9', authorId: 'MDQ6User_攻击者', authorLogin: '攻击者' }), 'submission');
  } finally { process.stderr.write = orig; }
  assert.match(chunks.join(''), /不是 release bot/, '静默降级会让这类尝试淹没在正常流量里');

  // 判成 submission 之后，它改 artifacts/ 会被拦下 —— 这才是闭环
  expectCode('E_PATH_DENIED', () => assertPathsAllowed({
    kind: 'submission', changedPaths: ['artifacts/skills/geoly/x/1.0.0/skill.json'],
  }));
});

test('promotion 分支号必须是纯十进制无前导零', () => {
  for (const ref of ['promotion/hub-042', 'promotion/hub-', 'promotion/hub-1.0', 'promotion/hub-0x10']) {
    assert.equal(cls({ headRef: ref }), 'submission', `${ref} 不该被当成 promotion 分支`);
  }
  assert.equal(cls({ headRef: 'promotion/hub-0' }), 'promotion');
});

test('router 的输入必须齐全 —— 缺一项就拒，不给默认', () => {
  for (const k of ['headRef', 'authorId', 'releaseBotId', 'headRepo', 'thisRepo']) {
    expectCode('E_CLASSIFY_INPUT', () => cls({ [k]: '' }));
  }
});

// ════════════════════════════════════════════════════════════════════════════
// §4 白名单 + §5 硬拒
// ════════════════════════════════════════════════════════════════════════════

test('submission 只许改 submissions/**', () => {
  assert.equal(assertPathsAllowed({
    kind: 'submission',
    changedPaths: ['submissions/geoly/alpha@1.0.0/skill.json', 'submissions/geoly/alpha@1.0.0/SKILL.md'],
  }), true);
  expectCode('E_PATH_OUTSIDE', () => assertPathsAllowed({
    kind: 'submission', changedPaths: ['README.md'],
  }));
});

test('promotion 只许改 artifacts/ registry/ advisories/', () => {
  assert.equal(assertPathsAllowed({
    kind: 'promotion',
    changedPaths: ['artifacts/skills/geoly/a/1.0.0/skill.json', 'registry/snapshots/hub-42.json', 'advisories/GSA-2026-0001.md'],
  }), true);
  expectCode('E_PATH_OUTSIDE', () => assertPathsAllowed({
    kind: 'promotion', changedPaths: ['submissions/geoly/x@1.0.0/skill.json'],
  }));
});

test('🔴 §5 的硬拒清单：投稿 PR 碰这些一律拒', () => {
  for (const p of ['.github/workflows/ci.yml', 'cli/x.mjs', 'scripts/build-snapshot.mjs',
    'docs/m0/06-submission.md', 'registry/owners.json', 'artifacts/skills/a/b/1.0.0/skill.json']) {
    expectCode('E_PATH_DENIED', () => assertPathsAllowed({ kind: 'submission', changedPaths: [p] }));
  }
});

test('🔴 硬拒清单与白名单是**两道**门，不是一道', () => {
  // 白名单万一被放宽，硬拒清单还在 —— 纵深，不是冗余。
  // 判据：`.github/**` 既不在 submission 白名单里，也在硬拒清单里，
  // 而报出来的应当是**硬拒**那一条（更具体、更该让人看见）。
  const e = expectCode('E_PATH_DENIED', () => assertPathsAllowed({
    kind: 'submission', changedPaths: ['.github/workflows/evil.yml'],
  }));
  assert.match(e.message, /不得\*\*修改\*\*这些路径|不得/);
  // 两张表确实不同
  assert.notDeepEqual([...SUBMISSION_DENY], [...SUBMISSION_PATHS]);
  assert.ok(PROMOTION_PATHS.includes('artifacts/'));
});

test('🔴 路径里有 .. 一律拒 —— 白名单靠前缀判定，`submissions/../cli/x` 的前缀是 submissions/', () => {
  expectCode('E_PATH_TRAVERSAL', () => assertPathsAllowed({
    kind: 'submission', changedPaths: ['submissions/../cli/evil.mjs'],
  }));
  // git 不会产出这种路径，但判据不能依赖「上游不会给我坏输入」
  expectCode('E_PATH_TRAVERSAL', () => assertPathsAllowed({
    kind: 'promotion', changedPaths: ['registry/../.github/workflows/x.yml'],
  }));
});

test('空改动集不判定，交人工', () => {
  expectCode('E_NO_CHANGES', () => assertPathsAllowed({ kind: 'submission', changedPaths: [] }));
});

// ════════════════════════════════════════════════════════════════════════════

test('🔴 CLI 真调用：判定与拒绝都要真的发生（入口守卫）', () => {
  const run = (args) => spawnSync(process.execPath,
    [join(REPO_ROOT, 'scripts/submission/pr-classify.mjs'), ...args], { encoding: 'utf8' });

  const ok = run(['--head-ref', 'submit/geoly/alpha@1.0.0', '--author-id', 'MDQ6User_投稿者',
    '--release-bot-id', BOT_ID, '--head-repo', 'fork/skills-hub', '--this-repo', REPO,
    '--changed-paths', 'submissions/geoly/alpha@1.0.0/skill.json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'submission', '🔴 退出码 0 但没输出 —— 入口守卫判假的症状');

  const attack = run(['--head-ref', 'promotion/hub-9', '--author-id', 'MDQ6User_攻击者',
    '--release-bot-id', BOT_ID, '--head-repo', REPO, '--this-repo', REPO,
    '--changed-paths', 'artifacts/skills/geoly/x/1.0.0/skill.json']);
  assert.notEqual(attack.status, 0);
  assert.match(attack.stderr, /不是 release bot/);
});

test('🔴 裸目录名不算白名单内 —— 同名 symlink/gitlink 顶替目录时会出现这种路径', () => {
  // 第一版有 `p === pre.slice(0,-1)` 这个例外，于是 `submissions` 被放行。
  // 删掉原目录、提交一个同名 symlink 或 gitlink，改动清单里就是这个裸名。
  expectCode('E_PATH_OUTSIDE', () => assertPathsAllowed({
    kind: 'submission', changedPaths: ['submissions'],
  }));
  expectCode('E_PATH_OUTSIDE', () => assertPathsAllowed({
    kind: 'promotion', changedPaths: ['registry'],
  }));
  // 目录内的文件当然照常放行
  assert.equal(assertPathsAllowed({ kind: 'submission', changedPaths: ['submissions/a/b.json'] }), true);
});

test('🔴 前缀混淆：submissions-evil/ 不是 submissions/', () => {
  expectCode('E_PATH_OUTSIDE', () => assertPathsAllowed({
    kind: 'submission', changedPaths: ['submissions-evil/x.json'],
  }));
});

test('🔴 rename 的**两端**都要受检', () => {
  // `.github/x.yml → submissions/x.yml` 在 -M --name-only 下只出现新路径，
  // 于是一次「把受保护文件删掉」的改动会从白名单溜过去。
  for (const entry of ['.github/workflows/ci.yml\tsubmissions/x.yml',
    '.github/workflows/ci.yml -> submissions/x.yml']) {
    expectCode('E_PATH_DENIED', () => assertPathsAllowed({ kind: 'submission', changedPaths: [entry] }));
  }
  // 调用方用 --no-renames 时，git 会拆成一删一增，两端本来就都在清单里
  expectCode('E_PATH_DENIED', () => assertPathsAllowed({
    kind: 'submission', changedPaths: ['.github/workflows/ci.yml', 'submissions/x.yml'],
  }));
});
