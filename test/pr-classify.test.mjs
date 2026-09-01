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
  classifyPr, assertPathsAllowed,
  PROMOTION_PATHS, SUBMISSION_PATHS, SUBMISSION_DENY, MAINTAINER_DENY,
} from '../scripts/submission/pr-classify.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BOT_ID = 'MDQ6Bot_release';
const REPO = 'geoly-ai/skills-hub';
/**
 * 🔴 **release bot 就在维护者名单里** —— 这不是为了造用例方便，是现状：
 *    2026-09-01 用户选了细粒度 PAT 而非 GitHub App，于是 release bot 的 node id
 *    **就是**维护者 chovizzz 的 id。所以默认夹具必须是这个形状，否则
 *    「promotion 与 maintainer 的判据同时成立」这件事根本不会被测到。
 */
const MAINTAINERS = [BOT_ID, 'MDQ6User_另一位维护者'];
const OTHER_MAINTAINER = 'MDQ6User_另一位维护者';
/** 默认是「合法的 promotion PR」，各用例只覆盖它要变的那一项。 */
const cls = (over = {}) => classifyPr({
  headRef: 'promotion/hub-42', authorId: BOT_ID, releaseBotId: BOT_ID,
  headRepo: REPO, thisRepo: REPO, authorLogin: 'bot', maintainerIds: MAINTAINERS, ...over,
});
/** 静默地跑一次（这几条判定会往 stderr 写告警，用例里不关心内容时吞掉）。 */
const quiet = (fn) => {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stderr.write = orig; }
};

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
  assert.equal(quiet(() => cls({ authorId: 'MDQ6User_路人' })), 'submission', '作者不是 bot');
  assert.equal(quiet(() => cls({ headRepo: '攻击者/skills-hub' })), 'submission', 'promotion 分支不能来自 fork');
  // 🔴 bot 开的**别的**分支不是 promotion —— 而它现在落进 `maintainer`，
  //    因为 release bot 的 id 就在维护者名单里。这正是第三类要闭合的缺口：
  //    在此之前它落进 submission，于是维护者改代码的 PR 永远合不了。
  assert.equal(cls({ headRef: 'submit/geoly/alpha@1.0.0' }), 'maintainer');
});

test('🔴 判据是不可变 node id，不是 login —— login 可改名、可被重新认领', () => {
  // bot 改名后 workflow 配置还留着旧 login，攻击者认领那个旧 login 就能凑齐条件。
  // 用 id 之后，同一个 login 配不同 id 一律不是 bot。
  assert.equal(quiet(() => cls({ authorId: 'MDQ6User_冒名者', authorLogin: 'geoly-release-bot' })), 'submission');
  // 维护者那一侧同理：顶着维护者的 login、id 不在名单里 —— 一律不是维护者。
  assert.equal(cls({
    headRef: 'fix/x', authorId: 'MDQ6User_冒名者', authorLogin: 'chovizzz',
  }), 'submission');
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
  // 作者用一个既不是 bot、也不在维护者名单里的 id —— 否则这里测的会变成
  // 「它落进 maintainer 了吗」，而不是「它没被当成 promotion」。
  for (const ref of ['promotion/hub-042', 'promotion/hub-', 'promotion/hub-1.0', 'promotion/hub-0x10']) {
    assert.equal(cls({ headRef: ref, authorId: 'MDQ6User_路人' }), 'submission',
      `${ref} 不该被当成 promotion 分支`);
  }
  assert.equal(cls({ headRef: 'promotion/hub-0' }), 'promotion');
});

test('router 的输入必须齐全 —— 缺一项就拒，不给默认', () => {
  for (const k of ['headRef', 'authorId', 'releaseBotId', 'headRepo', 'thisRepo']) {
    expectCode('E_CLASSIFY_INPUT', () => cls({ [k]: '' }));
  }
  expectCode('E_CLASSIFY_INPUT', () => cls({ maintainerIds: 'a,b' }));
  expectCode('E_CLASSIFY_INPUT', () => cls({ maintainerIds: [''] }));
});

// ════════════════════════════════════════════════════════════════════════════
// §5 第三类：maintainer —— 「改这些路径的 PR 必须来自 org 成员，
//   走单独的 maintainer 路径」，这一节就是那条路径
// ════════════════════════════════════════════════════════════════════════════

test('🔴 maintainer 判据：node id 在名单里 + head 仓库是本仓库', () => {
  const m = (over) => cls({ headRef: 'fix/x', ...over });
  assert.equal(m({ authorId: OTHER_MAINTAINER }), 'maintainer');
  assert.equal(m({ authorId: 'MDQ6User_路人' }), 'submission', '不在名单里');
  assert.equal(quiet(() => m({ authorId: OTHER_MAINTAINER, headRepo: '维护者/skills-hub' })),
    'submission', '🔴 fork 来的一律不算 —— fork 上的分支由 fork 的 owner 说了算');
  // 名单为空 = fail-closed：所有人都是 submission
  assert.equal(m({ authorId: OTHER_MAINTAINER, maintainerIds: [] }), 'submission');
});

test('🔴🔴 优先级：分支名是**第一**判据 —— promotion 永远压过 maintainer', () => {
  // 现状就是这个形状：release bot 的 node id **就是**维护者 chovizzz 的 id，
  // 于是同一个作者同时满足两类判据。谁先判，结果就不一样：
  //   · 先判分支名 → promotion，跑确定性复算门 ✅
  //   · 先判维护者 → maintainer，**复算门被跳过**（那条路径上根本没有这道门）
  // 后者不报错、不变红，只是门没跑 —— 所以这一条必须被钉死。
  assert.ok(MAINTAINERS.includes(BOT_ID), '夹具前提：bot 就在维护者名单里');
  assert.equal(cls({ headRef: 'promotion/hub-42' }), 'promotion',
    '🔴 有人把 maintainer 那段挪到 promotion 前面了 —— 每一张 promotion PR 都会绕过复算门');
  // 反过来：同一个人换个分支名，就该是 maintainer
  assert.equal(cls({ headRef: 'fix/x' }), 'maintainer');
});

test('🔴 `promotion/hub-<N>` 是保留命名空间 —— 伪装不会因为作者是维护者而升级', () => {
  // 一次「分支名像 promotion 却不满足条件」的尝试，落进**最严**的那条路径
  // （只许改 submissions/），而不是权限更大的 maintainer。
  // 维护者要改代码，换个分支名即可；放宽的代价是给伪装留一条更宽的出路。
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (x) => { chunks.push(String(x)); return true; };
  try {
    assert.equal(cls({ headRef: 'promotion/hub-9', authorId: OTHER_MAINTAINER }), 'submission');
  } finally { process.stderr.write = orig; }
  assert.match(chunks.join(''), /保留命名空间/, '降级得说清楚为什么，不然维护者会以为是 bug');
});

test('maintainer 可以改基础设施 —— 这正是它存在的理由', () => {
  // 2026-09-01 真实撞上的两张 PR：#1 改 docs/**、#2 改 test/**，
  // 两张都被判成 submission 后拒掉，报错还指向一条没实现的路径。
  assert.equal(assertPathsAllowed({
    kind: 'maintainer',
    changedPaths: [
      '.github/workflows/validate-pr.yml', 'scripts/submission/pr-classify.mjs',
      'docs/m3/03-golive-check.md', 'test/pr-classify.test.mjs', 'cli/x.mjs',
      'registry/owners.json', 'registry/maintainers.json', 'submissions/geoly/a@1.0.0/skill.json',
      'README.md',
    ],
  }), true);
});

test('🔴🔴 maintainer 仍然不许碰 artifacts/** 与 registry/snapshots/**', () => {
  // 它们受 promotion 路径上的**确定性复算门**与**不可变门**保护，
  // 而 maintainer 路径上没有那两道门。手改一张快照 = 「快照必须能被字节一致地
  // 复算出来」当场失效，而那是签名与时间戳信任链的地基。
  for (const p of ['artifacts/skills/geoly/a/1.0.0/skill.json', 'artifacts/index.json',
    'registry/snapshots/hub-42.json', 'registry/snapshots/hub-0.json']) {
    const e = expectCode('E_PATH_DENIED', () => assertPathsAllowed({ kind: 'maintainer', changedPaths: [p] }));
    assert.match(e.message, /只能由 promotion PR 动/);
  }
  // 🔴 裸目录名同样拒：把目录整个删掉、换成一个同名 symlink/gitlink 时，
  //    git 产出的就是这个裸名，而 `startsWith('artifacts/')` 判假。
  //    投稿路径上这一格由白名单兜着，**maintainer 路径没有白名单** ——
  //    黑名单是唯一的门，漏了就是真的漏了。
  for (const p of ['artifacts', 'registry/snapshots']) {
    expectCode('E_PATH_DENIED', () => assertPathsAllowed({ kind: 'maintainer', changedPaths: [p] }));
  }
  // 相邻但不同的路径不能被误伤
  assert.equal(assertPathsAllowed({
    kind: 'maintainer', changedPaths: ['registry/snapshots-notes.md', 'artifacts-doc/x.md'],
  }), true);
  // 两张 DENY 表确实是两张
  assert.notDeepEqual([...MAINTAINER_DENY], [...SUBMISSION_DENY]);
});

test('🔴 maintainer 的 .. 穿越同样要拒 —— 它没有白名单兜底', () => {
  expectCode('E_PATH_TRAVERSAL', () => assertPathsAllowed({
    kind: 'maintainer', changedPaths: ['registry/snapshots/../../artifacts/x.json'],
  }));
});

test('🔴 maintainer 的 rename 两端都要受检', () => {
  expectCode('E_PATH_DENIED', () => assertPathsAllowed({
    kind: 'maintainer', changedPaths: ['artifacts/skills/a/b/1.0.0/skill.json\tdocs/x.md'],
  }));
});

test('🔴 kind 拼错不能落进「按 submission 判」—— 一个错字换不来一次静默降级', () => {
  for (const kind of ['Maintainer', 'maintainers', '', undefined, null]) {
    expectCode('E_CLASSIFY_INPUT', () => assertPathsAllowed({ kind, changedPaths: ['README.md'] }));
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
    '--maintainer-ids', MAINTAINERS.join(','),
    '--changed-paths', 'submissions/geoly/alpha@1.0.0/skill.json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'submission', '🔴 退出码 0 但没输出 —— 入口守卫判假的症状');

  const attack = run(['--head-ref', 'promotion/hub-9', '--author-id', 'MDQ6User_攻击者',
    '--release-bot-id', BOT_ID, '--head-repo', REPO, '--this-repo', REPO,
    '--maintainer-ids', MAINTAINERS.join(','),
    '--changed-paths', 'artifacts/skills/geoly/x/1.0.0/skill.json']);
  assert.notEqual(attack.status, 0);
  assert.match(attack.stderr, /不是 release bot/);

  // 🔴 维护者改 docs/** —— 2026-09-01 那张被误拒的真 PR，现在必须过
  const maint = run(['--head-ref', 'fix/mutation-reporter', '--author-id', OTHER_MAINTAINER,
    '--release-bot-id', BOT_ID, '--head-repo', REPO, '--this-repo', REPO,
    '--maintainer-ids', MAINTAINERS.join(','),
    '--changed-paths', 'docs/m3/03-golive-check.md\ntest/workflow-invariants.test.mjs']);
  assert.equal(maint.status, 0, maint.stderr);
  assert.equal(maint.stdout.trim(), 'maintainer');

  // 🔴 同一个维护者去改快照 —— 拒
  const snap = run(['--head-ref', 'fix/x', '--author-id', OTHER_MAINTAINER,
    '--release-bot-id', BOT_ID, '--head-repo', REPO, '--this-repo', REPO,
    '--maintainer-ids', MAINTAINERS.join(','),
    '--changed-paths', 'registry/snapshots/hub-42.json']);
  assert.notEqual(snap.status, 0);
  assert.match(snap.stderr, /只能由 promotion PR 动/);

  // 🔴 `--maintainer-ids` 是必填：不给就报错，而不是默默当成空名单。
  //    「名单没取到」与「显式的空名单」长得一样的话，2026-09-01 那场死锁
  //    会原样重演，而且这次连报错都没有。
  const missing = run(['--head-ref', 'fix/x', '--author-id', OTHER_MAINTAINER,
    '--release-bot-id', BOT_ID, '--head-repo', REPO, '--this-repo', REPO,
    '--changed-paths', 'docs/x.md']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /缺少 --maintainer-ids/);
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
