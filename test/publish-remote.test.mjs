// `publish` 的远端一侧：fork 身份、重复检测、写完核对、PR 核对。
//
// 🔴 fetch 桩默认**会抛**（见 `harness/fake-github.mjs`）：任何没预期到的
//    请求当场炸。这条命令会建 fork / 建分支 / 开 PR —— 一个"没匹配上就返回 404"
//    的桩会把一次意外的写请求变成一次通过的测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '../src/publish/github.mjs';
import {
  getViewer, getBaseline, derivedFromTree, ensureFork, findOpenDuplicates,
  branchName, assertBranchFree, pushSubmission, verifyBranch, openPullRequest, assertPr,
  resolvePath, getTree, RemoteError,
} from '../src/publish/remote.mjs';
import { fakeFetch, Recorder } from './harness/fake-github.mjs';

const TOKEN = 'ghp_TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT';
const mk = (f) => createClient({ token: TOKEN, fetchImpl: f, userAgent: 'test/1' });
/** 超时用例专用：把超时压到 5 ms，好让 `{ abort: true }` 的路由很快触发。 */
const mkFast = (f) => createClient({ token: TOKEN, fetchImpl: f, userAgent: 'test/1', timeoutMs: 5 });
const UP = '/repos/geoly-ai/skills-hub';
const FORK = '/repos/alice/skills-hub';
const VIEWER = { login: 'alice', id: 7, nodeId: 'U_alice', scopes: ['repo'] };
const UPSTREAM_ID = 1234;
const FORK_ID = 5678;

const tree = (sha, entries, truncated = false) => ({ json: { sha, truncated, tree: entries } });
const blobE = (path, sha, mode = '100644') => ({ path, mode, type: 'blob', sha });
const treeE = (path, sha) => ({ path, mode: '040000', type: 'tree', sha });

// ── getTree / resolvePath ───────────────────────────────────────────────────

test('🔴 truncated 的 tree 一律抛 —— 不在截断结果上判定"路径不存在"', async () => {
  const f = fakeFetch([['GET', `${UP}/git/trees/T`, tree('T', [], true)]]);
  await assert.rejects(
    () => getTree(mk(f), UP, 'T'),
    (e) => e instanceof RemoteError && e.exitCode === 6 && /截断/.test(e.message),
  );
});

test('resolvePath 逐层走；中间一段不是目录就是"不存在"', async () => {
  const f = fakeFetch([
    ['GET', `${UP}/git/trees/ROOT`, tree('ROOT', [blobE('submissions', 'B')])],
  ]);
  assert.equal(await resolvePath(mk(f), UP, 'ROOT', ['submissions', 'ns']), null);
});

test('resolvePath 找到最后一段就返回那个 entry', async () => {
  const f = fakeFetch([
    ['GET', `${UP}/git/trees/ROOT`, tree('ROOT', [treeE('submissions', 'S')])],
    ['GET', `${UP}/git/trees/S`, tree('S', [treeE('ns', 'N')])],
  ]);
  const hit = await resolvePath(mk(f), UP, 'ROOT', ['submissions', 'ns']);
  assert.equal(hit.sha, 'N');
});

// ── derivedFromTree ─────────────────────────────────────────────────────────

test('derivedFromTree 从 artifacts/ 路径派生 id 与同 ns 的 name', () => {
  const r = derivedFromTree([
    'artifacts/skills/acme/foo/1.0.0/skill.json',
    'artifacts/skills/acme/foo/1.0.0/SKILL.md',
    'artifacts/skills/acme/bar/2.0.0/skill.json',
    'artifacts/packs/acme/p/0.1.0/pack.json',
    'artifacts/skills/acme/foo',          // 目录本身，段数不够 → 忽略
    'artifacts/other/acme/x/1/y',         // 不是 skills/packs → 忽略
  ]);
  assert.deepEqual(r.existingIds.sort(), [
    'pack:acme/p@0.1.0', 'skill:acme/bar@2.0.0', 'skill:acme/foo@1.0.0',
  ]);
  assert.deepEqual([...r.existingNamesByNs.get('acme')].sort(), ['bar', 'foo', 'p']);
});

// ── getViewer ───────────────────────────────────────────────────────────────

test('🔴 x-oauth-scopes 缺席时 scopes 是 null（= 看不见），不是空数组（= 没有权限）', async () => {
  const f = fakeFetch([['GET', '/user', { json: { login: 'a', id: 1, node_id: 'U_1' } }]]);
  assert.equal((await getViewer(mk(f))).scopes, null);

  const g = fakeFetch([['GET', '/user', {
    json: { login: 'a', id: 1, node_id: 'U_1' }, headers: { 'x-oauth-scopes': '' },
  }]]);
  assert.deepEqual((await getViewer(mk(g))).scopes, [], '头在但为空 → 空数组，与缺席可区分');
});

test('/user 少了 node_id → 拒绝在身份不明的情况下继续（exit 7）', async () => {
  const f = fakeFetch([['GET', '/user', { json: { login: 'a', id: 1 } }]]);
  await assert.rejects(() => getViewer(mk(f)), (e) => e.exitCode === 7);
});

// ── getBaseline ─────────────────────────────────────────────────────────────

const RESERVED = JSON.stringify({ schema: 'geoly.skills.reserved/1', namespaces: ['geoly', 'claude'] });
const OWNERS = JSON.stringify({ namespaces: { acme: { kind: 'user', login: 'alice', id: 'U_x' } } });
const b64 = (s) => ({ json: { encoding: 'base64', content: Buffer.from(s).toString('base64') } });

function baselineRoutes({ submissionExists = false, artifacts = [] } = {}) {
  return [
    ['GET', UP, { json: { id: UPSTREAM_ID, full_name: 'geoly-ai/skills-hub' } }],
    ['GET', `${UP}/git/ref/heads/main`, { json: { object: { type: 'commit', sha: 'BASECOMMIT' } } }],
    ['GET', `${UP}/git/commits/BASECOMMIT`, { json: { tree: { sha: 'BASETREE' } } }],
    // ① artifacts
    ['GET', `${UP}/git/trees/BASETREE`, tree('BASETREE', [
      treeE('artifacts', 'ART'), treeE('registry', 'REG'), treeE('submissions', 'SUB'),
    ])],
    ['GET', `${UP}/git/trees/ART?recursive=1`, tree('ART', artifacts.map((p) => blobE(p, 'x')))],
    // ② registry
    ['GET', `${UP}/git/trees/BASETREE`, tree('BASETREE', [
      treeE('artifacts', 'ART'), treeE('registry', 'REG'), treeE('submissions', 'SUB'),
    ])],
    ['GET', `${UP}/git/trees/REG`, tree('REG', [blobE('reserved.json', 'R1'), blobE('owners.json', 'O1')])],
    // ③ 投稿路径
    ['GET', `${UP}/git/trees/BASETREE`, tree('BASETREE', [
      treeE('artifacts', 'ART'), treeE('registry', 'REG'), treeE('submissions', 'SUB'),
    ])],
    ['GET', `${UP}/git/trees/SUB`, tree('SUB', submissionExists ? [treeE('acme', 'NS')] : [])],
    ...(submissionExists
      ? [['GET', `${UP}/git/trees/NS`, tree('NS', [treeE('foo@1.0.0', 'OLD')])]]
      : []),
    ['GET', `${UP}/git/blobs/R1`, b64(RESERVED)],
    ['GET', `${UP}/git/blobs/O1`, b64(OWNERS)],
  ];
}

const SEGMENTS = ['submissions', 'acme', 'foo@1.0.0'];

test('getBaseline 只递归 artifacts/ 那一棵，**不发整仓 recursive=1**', async () => {
  const rec = new Recorder();
  const f = fakeFetch(baselineRoutes({ artifacts: ['skills/acme/bar/2.0.0/skill.json'] }), rec);
  const b = await getBaseline(mk(f), { submissionSegments: SEGMENTS });
  assert.deepEqual(b.existingIds, ['skill:acme/bar@2.0.0']);
  assert.deepEqual([...b.registeredNamespaces], ['acme']);
  assert.deepEqual(b.reserved.namespaces, ['geoly', 'claude']);
  assert.equal(b.existingSubmission, null);
  // 🔴 唯一一次 recursive 是对 artifacts 那棵子树 —— 数个数，不是"出现过"
  const recursive = rec.paths('GET').filter((p) => p.includes('recursive=1'));
  assert.deepEqual(recursive, [`${UP}/git/trees/ART?recursive=1`]);
});

test('base 上已经有这条投稿路径 → existingSubmission 不为 null', async () => {
  const f = fakeFetch(baselineRoutes({ submissionExists: true }));
  const b = await getBaseline(mk(f), { submissionSegments: SEGMENTS });
  assert.notEqual(b.existingSubmission, null);
  assert.equal(b.existingSubmission.sha, 'OLD');
});

test('🔴 上游 full_name 对不上（改名/转移）→ 拒绝继续', async () => {
  const f = fakeFetch([['GET', UP, { json: { id: 1, full_name: 'someone/else' } }]]);
  await assert.rejects(() => getBaseline(mk(f), { submissionSegments: SEGMENTS }), RemoteError);
});

test('🔴 owners.json 读不出来 → 拒，不当成"一个都没注册"', async () => {
  const routes = baselineRoutes();
  const i = routes.findIndex(([, p]) => p === `${UP}/git/blobs/O1`);
  routes[i] = ['GET', `${UP}/git/blobs/O1`, b64('{ 这不是 JSON')];
  await assert.rejects(
    () => getBaseline(mk(fakeFetch(routes)), { submissionSegments: SEGMENTS }),
    (e) => /不知道谁注册过/.test(e.message),
  );
});

test('🔴 reserved.json 走的是 structural-gates 那一份实现（重复 key 会被拒）', async () => {
  const routes = baselineRoutes();
  const i = routes.findIndex(([, p]) => p === `${UP}/git/blobs/R1`);
  routes[i] = ['GET', `${UP}/git/blobs/R1`,
    b64('{"schema":"geoly.skills.reserved/1","namespaces":["geoly"],"namespaces":[]}')];
  await assert.rejects(
    () => getBaseline(mk(fakeFetch(routes)), { submissionSegments: SEGMENTS }),
    // parseStrict 拒重复 key —— 若这里换成 JSON.parse，保留清单会被静默清空
    (e) => /重复|duplicate/i.test(e.message),
  );
});

test('registry/reserved.json 不是 blob（被换成目录/gitlink）→ 拒，不当成"文件不存在"', async () => {
  const routes = baselineRoutes();
  const i = routes.findIndex(([, p]) => p === `${UP}/git/trees/REG`);
  routes[i] = ['GET', `${UP}/git/trees/REG`,
    tree('REG', [treeE('reserved.json', 'R1'), blobE('owners.json', 'O1')])];
  await assert.rejects(
    () => getBaseline(mk(fakeFetch(routes)), { submissionSegments: SEGMENTS }),
    (e) => /不是普通文件/.test(e.message),
  );
});

// 🔴🔴 一组「fail-open 退化」的门：判据缺席时**不能**变成恒真 / 空表。
test('🔴 tree 的响应里 tree 不是数组 → 抛，不当成空树', async () => {
  const f = fakeFetch([['GET', `${UP}/git/trees/T`, { json: { sha: 'T', truncated: false, tree: null } }]]);
  await assert.rejects(
    () => getTree(mk(f), UP, 'T'),
    (e) => e instanceof RemoteError && /拒绝把它当成空树/.test(e.message),
  );
});

test('🔴 上游 repo.id 缺席 → 拒（否则 fork.parent.id 那道门退化成 undefined===undefined）', async () => {
  const routes = baselineRoutes();
  routes[0] = ['GET', UP, { json: { full_name: 'geoly-ai/skills-hub' } }];   // 没有 id
  await assert.rejects(
    () => getBaseline(mk(fakeFetch(routes)), { submissionSegments: SEGMENTS }),
    (e) => /repo.id 不是整数/.test(e.message),
  );
});

test('🔴 判据真的会退化：upstreamId 与 parent.id 都缺席时，fork 门必须仍然拒', async () => {
  // 直接喂给 ensureFork 一个 undefined 的 upstreamId + 一个 parent.id 缺席的 fork
  const f = fakeFetch([['GET', FORK, {
    json: { id: 9, fork: true, owner: { id: VIEWER.id }, parent: {} },
  }]]);
  await assert.rejects(
    () => ensureFork(mk(f), { viewer: VIEWER, upstreamId: undefined, baseCommitSha: 'BASECOMMIT' }),
    RemoteError,
    'upstreamId 与 parent.id 都是 undefined 时，fork 身份门竟然放行了',
  );
});

// ⚠️ 这里用**字符串 id**，不用 `null`。`null` 会被上面那圈「字段缺席」检查先接住，
//    于是把整数校验删掉这条测试**照样绿** —— 那是一条抓不住变异的测试
//    （第一版就是这么写的，变异自检当场发现）。字符串 id 只有整数校验拦得住。
test('🔴 /user 的 id 不是整数（如 JSON 给了字符串）→ 拒：它是 owner.id / PR 作者核对的判据', async () => {
  const f = fakeFetch([['GET', '/user', { json: { login: 'a', id: '7', node_id: 'U_1' } }]]);
  await assert.rejects(() => getViewer(mk(f)), (e) => e.exitCode === 7 && /不是整数/.test(e.message));
});

test('/user 的 id 缺席 → 同样拒（走的是「字段缺席」那圈）', async () => {
  const f = fakeFetch([['GET', '/user', { json: { login: 'a', node_id: 'U_1' } }]]);
  await assert.rejects(() => getViewer(mk(f)), (e) => e.exitCode === 7);
});

test('🔴 registry 在但不是目录 → 拒，不把保留清单当成空表', async () => {
  const routes = baselineRoutes();
  const i = routes.findIndex(([m, p]) => m === 'GET' && p === `${UP}/git/trees/BASETREE`);
  // 第二次读 BASETREE（找 registry）那一条改成 registry 是 blob
  const idx = routes.map((r, k) => [r, k]).filter(([r]) => r[1] === `${UP}/git/trees/BASETREE`)[1][1];
  routes[idx] = ['GET', `${UP}/git/trees/BASETREE`, tree('BASETREE', [
    treeE('artifacts', 'ART'), blobE('registry', 'REGBLOB'), treeE('submissions', 'SUB'),
  ])];
  void i;
  await assert.rejects(
    () => getBaseline(mk(fakeFetch(routes)), { submissionSegments: SEGMENTS }),
    (e) => /不是目录/.test(e.message),
  );
});

// ── ensureFork ──────────────────────────────────────────────────────────────

const goodFork = {
  json: { id: FORK_ID, fork: true, owner: { id: VIEWER.id }, parent: { id: UPSTREAM_ID } },
};

test('已有合格的 fork → 不发任何写请求', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', FORK, goodFork],
    ['GET', `${FORK}/git/commits/BASECOMMIT`, { json: { sha: 'BASECOMMIT' } }],
  ], rec);
  const r = await ensureFork(mk(f), { viewer: VIEWER, upstreamId: UPSTREAM_ID, baseCommitSha: 'BASECOMMIT' });
  assert.equal(r.created, false);
  assert.deepEqual(rec.writes(), [], '不该有任何写请求');
});

for (const [what, repo] of [
  ['不是 fork', { id: 9, fork: false, owner: { id: VIEWER.id }, parent: { id: UPSTREAM_ID } }],
  ['owner 不是我', { id: 9, fork: true, owner: { id: 999 }, parent: { id: UPSTREAM_ID } }],
  ['parent 不是上游', { id: 9, fork: true, owner: { id: VIEWER.id }, parent: { id: 4242 } }],
]) {
  test(`🔴 fork 身份三条缺一不可：${what} → 拒`, async () => {
    const rec = new Recorder();
    const f = fakeFetch([['GET', FORK, { json: repo }]], rec);
    await assert.rejects(
      () => ensureFork(mk(f), { viewer: VIEWER, upstreamId: UPSTREAM_ID, baseCommitSha: 'BASECOMMIT' }),
      RemoteError,
    );
    assert.deepEqual(rec.writes(), [], '拒绝时不该已经写过东西');
  });
}

test('🔴 fork 里读不到 base commit → 拒（不去建一棵引用不到的树）', async () => {
  const f = fakeFetch([
    ['GET', FORK, goodFork],
    ['GET', `${FORK}/git/commits/BASECOMMIT`, { status: 404, json: { message: 'Not Found' } }],
  ]);
  await assert.rejects(
    () => ensureFork(mk(f), { viewer: VIEWER, upstreamId: UPSTREAM_ID, baseCommitSha: 'BASECOMMIT' }),
    (e) => e.exitCode === 6 && /读不到上游/.test(e.message),
  );
});

test('🔴 没有 fork → POST 一次，然后**轮询读回**才算就绪（POST 只发一次）', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', FORK, { status: 404, json: { message: 'Not Found' } }],
    ['POST', `${UP}/forks`, { status: 202, json: {} }],
    ['GET', FORK, { status: 404, json: { message: 'Not Found' } }],   // 还没建好
    ['GET', FORK, goodFork],
    ['GET', `${FORK}/git/ref/heads/main`, { json: { object: { sha: 'BASECOMMIT' } } }],
    ['GET', `${FORK}/git/commits/BASECOMMIT`, { json: { sha: 'BASECOMMIT' } }],
  ], rec);
  const r = await ensureFork(mk(f), {
    viewer: VIEWER, upstreamId: UPSTREAM_ID, baseCommitSha: 'BASECOMMIT', sleep: async () => {},
  });
  assert.equal(r.created, true);
  assert.equal(rec.count('POST', `${UP}/forks`), 1, 'fork 的 POST 只能发一次');
});

test('🔴 fork 等超时 → 网络错误退出，且**没有**重发 POST', async () => {
  const rec = new Recorder();
  let t = 0;
  const f = fakeFetch([
    ['GET', FORK, { status: 404, json: {} }],
    ['POST', `${UP}/forks`, { status: 202, json: {} }],
    ['GET', FORK, { status: 404, json: {} }],
  ], rec);
  await assert.rejects(
    () => ensureFork(mk(f), {
      viewer: VIEWER, upstreamId: UPSTREAM_ID, baseCommitSha: 'BASECOMMIT',
      sleep: async () => {}, maxWaitMs: 0, now: () => { t += 1000; return t; },
    }),
    (e) => e.exitCode === 6,
  );
  assert.equal(rec.count('POST', `${UP}/forks`), 1);
});

test('🔴 fork 的 POST **超时** → 轮询读回；读到就绪就成功，且 POST 只发过一次', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', FORK, { status: 404, json: {} }],
    ['POST', `${UP}/forks`, { abort: true }],          // ← 真的超时（signal 触发）
    ['GET', FORK, goodFork],
    ['GET', `${FORK}/git/ref/heads/main`, { json: { object: { sha: 'BASECOMMIT' } } }],
    ['GET', `${FORK}/git/commits/BASECOMMIT`, { json: { sha: 'BASECOMMIT' } }],
  ], rec);
  const r = await ensureFork(mkFast(f), {
    viewer: VIEWER, upstreamId: UPSTREAM_ID, baseCommitSha: 'BASECOMMIT', sleep: async () => {},
  });
  assert.equal(r.created, true);
  assert.equal(rec.count('POST', `${UP}/forks`), 1, '超时之后重发了 fork 的 POST');
});

test('🔴 fork 的 POST 超时且始终读不到 → 网络错误退出，**绝不重发**', async () => {
  const rec = new Recorder();
  let t = 0;
  const f = fakeFetch([
    ['GET', FORK, { status: 404, json: {} }],
    ['POST', `${UP}/forks`, { abort: true }],
    ['GET', FORK, { status: 404, json: {} }],
  ], rec);
  await assert.rejects(
    () => ensureFork(mkFast(f), {
      viewer: VIEWER, upstreamId: UPSTREAM_ID, baseCommitSha: 'BASECOMMIT',
      sleep: async () => {}, maxWaitMs: 0, now: () => { t += 1000; return t; },
    }),
    (e) => e.exitCode === 6,
  );
  assert.equal(rec.count('POST', `${UP}/forks`), 1);
});

test('🔴 fork 的 POST 收到 5xx → 同样走轮询读回，不重发', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', FORK, { status: 404, json: {} }],
    ['POST', `${UP}/forks`, { status: 502, json: { message: 'Bad gateway' } }],
    ['GET', FORK, goodFork],
    ['GET', `${FORK}/git/ref/heads/main`, { json: { object: { sha: 'BASECOMMIT' } } }],
    ['GET', `${FORK}/git/commits/BASECOMMIT`, { json: { sha: 'BASECOMMIT' } }],
  ], rec);
  await ensureFork(mk(f), {
    viewer: VIEWER, upstreamId: UPSTREAM_ID, baseCommitSha: 'BASECOMMIT', sleep: async () => {},
  });
  assert.equal(rec.count('POST', `${UP}/forks`), 1);
});

test('🔴 fork 的 POST 收到 4xx（不是超时/5xx）→ 直接抛，不进轮询', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', FORK, { status: 404, json: {} }],
    ['POST', `${UP}/forks`, { status: 403, json: { message: 'Forbidden' } }],
  ], rec);
  await assert.rejects(
    () => ensureFork(mk(f), {
      viewer: VIEWER, upstreamId: UPSTREAM_ID, baseCommitSha: 'BASECOMMIT', sleep: async () => {},
    }),
    (e) => e.status === 403 && e.exitCode === 7,
  );
  assert.equal(rec.count('POST', `${UP}/forks`), 1);
});

// ── 重复投稿检测 ────────────────────────────────────────────────────────────

test('🔴 重复检测走 head.sha 的 tree 解析，**不**读 /pulls/<n>/files', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', `${UP}/pulls?state=open&per_page=100&page=1`, {
      json: [{ number: 3, head: { sha: 'H3' }, user: { login: 'bob' }, html_url: 'u3', title: 't' }],
    }],
    ['GET', `${UP}/git/commits/H3`, { json: { tree: { sha: 'T3' } } }],
    ['GET', `${UP}/git/trees/T3`, tree('T3', [treeE('submissions', 'S3')])],
    ['GET', `${UP}/git/trees/S3`, tree('S3', [treeE('acme', 'N3')])],
    ['GET', `${UP}/git/trees/N3`, tree('N3', [treeE('foo@1.0.0', 'D3')])],
  ], rec);
  const r = await findOpenDuplicates(mk(f), { submissionSegments: SEGMENTS });
  assert.deepEqual(r.matches.map((m) => m.number), [3]);
  // 🔴 一次 /files 都不许发 —— 它会分页会截断，"没看到"与"不在里面"分不开
  assert.equal(rec.calls.filter((c) => c.path.includes('/files')).length, 0);
});

test('开放 PR 里没有这条路径 → 没有 match', async () => {
  const f = fakeFetch([
    ['GET', `${UP}/pulls?state=open&per_page=100&page=1`, {
      json: [{ number: 4, head: { sha: 'H4' }, user: { login: 'b' }, html_url: 'u', title: 't' }],
    }],
    ['GET', `${UP}/git/commits/H4`, { json: { tree: { sha: 'T4' } } }],
    ['GET', `${UP}/git/trees/T4`, tree('T4', [treeE('submissions', 'S4')])],
    ['GET', `${UP}/git/trees/S4`, tree('S4', [treeE('other', 'X')])],
  ]);
  const r = await findOpenDuplicates(mk(f), { submissionSegments: SEGMENTS });
  assert.deepEqual(r.matches, []);
  assert.equal(r.scanned, 1);
});

test('🔴 有一个 PR 的 head commit 读不到 → 整个检测失败，不宣布"没有重复"', async () => {
  const f = fakeFetch([
    ['GET', `${UP}/pulls?state=open&per_page=100&page=1`, {
      json: [{ number: 5, head: { sha: 'H5' }, user: {}, html_url: 'u', title: 't' }],
    }],
    ['GET', `${UP}/git/commits/H5`, { status: 404, json: { message: 'gone' } }],
  ]);
  await assert.rejects(
    () => findOpenDuplicates(mk(f), { submissionSegments: SEGMENTS }),
    (e) => e.exitCode === 6 && /没查成/.test(e.message),
  );
});

test('🔴 开放 PR 超过分页预算 → 抛，不是"告警后继续"', async () => {
  const page = Array.from({ length: 2 }, (_, i) => ({ number: i, head: { sha: 'H' } }));
  const f = fakeFetch([
    ['GET', `${UP}/pulls?state=open&per_page=100&page=1`, { json: Array.from({ length: 100 }, () => page[0]) }],
    ['GET', `${UP}/pulls?state=open&per_page=100&page=2`, { json: Array.from({ length: 100 }, () => page[0]) }],
  ]);
  await assert.rejects(
    () => findOpenDuplicates(mk(f), { submissionSegments: SEGMENTS, maxPages: 2 }),
    (e) => e.name === 'TruncatedError',
  );
});

// ── 分支名 / 已存在的分支 ───────────────────────────────────────────────────

test('分支名带 tree_digest 前 8 位 —— 内容变了就是另一个分支', () => {
  const d = `geoly-tree-v1:sha256:${'ab'.repeat(32)}`;
  assert.equal(
    branchName({ namespace: 'acme', name: 'foo', version: '1.0.0', treeDigest: d }),
    'submit/acme/foo@1.0.0-abababab',
  );
});

test('🔴 分支已存在 → 拒，且一个写请求都不发（不 force-push、不 amend）', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', `${FORK}/git/ref/heads/submit/acme/foo@1.0.0-aaaaaaaa`,
      { json: { object: { sha: 'OTHER' } } }],
  ], rec);
  await assert.rejects(
    () => assertBranchFree(mk(f), { login: 'alice', branch: 'submit/acme/foo@1.0.0-aaaaaaaa' }),
    (e) => e.exitCode === 3,
  );
  assert.deepEqual(rec.writes(), []);
});

// ── 写：blob → tree → commit → ref ─────────────────────────────────────────

const FILES = [
  { repoPath: 'submissions/acme/foo@1.0.0/skill.json', mode: 0o644, data: Buffer.from('{}') },
  { repoPath: 'submissions/acme/foo@1.0.0/run.sh', mode: 0o755, data: Buffer.from('#!/bin/sh\n') },
];

test('🔴 mode 原样进 tree（0755 → 100755），且 ref 是**最后**一步', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['POST', `${FORK}/git/blobs`, { json: { sha: 'B1' } }],
    ['POST', `${FORK}/git/blobs`, { json: { sha: 'B2' } }],
    ['POST', `${FORK}/git/trees`, { json: { sha: 'NEWTREE' } }],
    ['POST', `${FORK}/git/commits`, { json: { sha: 'NEWCOMMIT' } }],
    ['POST', `${FORK}/git/refs`, { json: {} }],
  ], rec);
  const r = await pushSubmission(mk(f), {
    login: 'alice', branch: 'br', files: FILES,
    baseTreeSha: 'BASETREE', baseCommitSha: 'BASECOMMIT', message: 'm',
  });
  assert.equal(r.commitSha, 'NEWCOMMIT');

  const treeCall = rec.calls.find((c) => c.path === `${FORK}/git/trees`);
  assert.equal(treeCall.body.base_tree, 'BASETREE');
  assert.deepEqual(treeCall.body.tree, [
    { path: FILES[0].repoPath, mode: '100644', type: 'blob', sha: 'B1' },
    { path: FILES[1].repoPath, mode: '100755', type: 'blob', sha: 'B2' },
  ]);
  const commitCall = rec.calls.find((c) => c.path === `${FORK}/git/commits`);
  assert.deepEqual(commitCall.body.parents, ['BASECOMMIT']);

  // 🔴 建 ref 必须是**最后**一个写请求：中途失败不能在仓库上留下可见的东西
  const w = rec.writes().map((c) => c.path);
  assert.equal(w[w.length - 1], `${FORK}/git/refs`);
  assert.equal(w.filter((p) => p === `${FORK}/git/refs`).length, 1);
});

test('🔴 建 ref 撞上 422（分支已存在）→ 拒绝改写', async () => {
  const f = fakeFetch([
    ['POST', `${FORK}/git/blobs`, { json: { sha: 'B1' } }],
    ['POST', `${FORK}/git/blobs`, { json: { sha: 'B2' } }],
    ['POST', `${FORK}/git/trees`, { json: { sha: 'NEWTREE' } }],
    ['POST', `${FORK}/git/commits`, { json: { sha: 'NEWCOMMIT' } }],
    ['POST', `${FORK}/git/refs`, { status: 422, json: { message: 'Reference already exists' } }],
  ]);
  await assert.rejects(
    () => pushSubmission(mk(f), {
      login: 'alice', branch: 'br', files: FILES,
      baseTreeSha: 'BASETREE', baseCommitSha: 'BASECOMMIT', message: 'm',
    }),
    (e) => e.exitCode === 3 && /拒绝改写/.test(e.message),
  );
});

const pushArgs = {
  login: 'alice', branch: 'br', files: FILES,
  baseTreeSha: 'BASETREE', baseCommitSha: 'BASECOMMIT', message: 'm',
};
const upToRef = [
  ['POST', `${FORK}/git/blobs`, { json: { sha: 'B1' } }],
  ['POST', `${FORK}/git/blobs`, { json: { sha: 'B2' } }],
  ['POST', `${FORK}/git/trees`, { json: { sha: 'NEWTREE' } }],
  ['POST', `${FORK}/git/commits`, { json: { sha: 'NEWCOMMIT' } }],
];

test('🔴 建 ref **超时** → 读回；指向的正是我们建的 commit ⇒ 成功，且不重发', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ...upToRef,
    ['POST', `${FORK}/git/refs`, { abort: true }],
    ['GET', `${FORK}/git/ref/heads/br`, { json: { object: { sha: 'NEWCOMMIT' } } }],
  ], rec);
  const r = await pushSubmission(mkFast(f), pushArgs);
  assert.equal(r.commitSha, 'NEWCOMMIT');
  assert.equal(rec.count('POST', `${FORK}/git/refs`), 1, '超时之后重发了建 ref 的 POST');
});

test('🔴 建 ref 超时 → 读回指向**别的** commit ⇒ 冲突，拒绝改写', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ...upToRef,
    ['POST', `${FORK}/git/refs`, { abort: true }],
    ['GET', `${FORK}/git/ref/heads/br`, { json: { object: { sha: 'SOMEONE_ELSE' } } }],
  ], rec);
  await assert.rejects(
    () => pushSubmission(mkFast(f), pushArgs),
    (e) => e.exitCode === 3 && /不是我们建的/.test(e.message),
  );
  assert.equal(rec.count('POST', `${FORK}/git/refs`), 1);
});

test('🔴 建 ref 超时 → 读回 404（说不清成没成）⇒ 以网络错误退出，**不重发**', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ...upToRef,
    ['POST', `${FORK}/git/refs`, { abort: true }],
    ['GET', `${FORK}/git/ref/heads/br`, { status: 404, json: {} }],
  ], rec);
  await assert.rejects(
    () => pushSubmission(mkFast(f), pushArgs),
    (e) => e.timedOut === true && e.exitCode === 6,
  );
  assert.equal(rec.count('POST', `${FORK}/git/refs`), 1);
});

// ── 写完的核对 ──────────────────────────────────────────────────────────────

const TREE_ITEMS = [
  { path: FILES[0].repoPath, mode: '100644', type: 'blob', sha: 'B1' },
  { path: FILES[1].repoPath, mode: '100755', type: 'blob', sha: 'B2' },
];

/** 一组"完全正确"的核对路由；`patch` 用来逐条改坏做变异自检。 */
function verifyRoutes(patch = {}) {
  const baseRoot = [treeE('artifacts', 'ART'), treeE('registry', 'REG'), treeE('submissions', 'SUBOLD')];
  const newRoot = [treeE('artifacts', 'ART'), treeE('registry', 'REG'), treeE('submissions', 'SUBNEW')];
  return [
    ['GET', `${FORK}/git/ref/heads/br`, { json: { object: { sha: patch.refSha ?? 'NEWCOMMIT' } } }],
    ['GET', `${FORK}/git/commits/NEWCOMMIT`, {
      json: { parents: patch.parents ?? [{ sha: 'BASECOMMIT' }], tree: { sha: patch.commitTree ?? 'NEWTREE' } },
    }],
    ['GET', `${UP}/git/trees/BASETREE`, tree('BASETREE', patch.baseRoot ?? baseRoot)],
    ['GET', `${FORK}/git/trees/NEWTREE`, tree('NEWTREE', patch.newRoot ?? newRoot)],
    ['GET', `${UP}/git/trees/SUBOLD`, tree('SUBOLD', patch.baseSub ?? [treeE('other', 'O')])],
    ['GET', `${FORK}/git/trees/SUBNEW`, tree('SUBNEW', patch.newSub ?? [treeE('other', 'O'), treeE('acme', 'NSNEW')])],
    ['GET', `${UP}/git/trees/undefined`, tree('x', [])],   // base 里没有 acme/ 时不会走到
    ['GET', `${FORK}/git/trees/NSNEW`, tree('NSNEW', patch.newNs ?? [treeE('foo@1.0.0', 'LEAF')])],
    ['GET', `${FORK}/git/trees/LEAF?recursive=1`, tree('LEAF', patch.leaf ?? [
      blobE('skill.json', 'B1', '100644'), blobE('run.sh', 'B2', '100755'),
    ])],
  ];
}

const verifyArgs = {
  login: 'alice', branch: 'br', segments: SEGMENTS, treeItems: TREE_ITEMS,
  commitSha: 'NEWCOMMIT', newTreeSha: 'NEWTREE', baseCommitSha: 'BASECOMMIT', baseTreeSha: 'BASETREE',
};

test('核对：一切正确时通过', async () => {
  const r = await verifyBranch(mk(fakeFetch(verifyRoutes())), verifyArgs);
  assert.equal(r.files.length, 2);
});

test('🔴 核对**不**依赖 /compare —— 它的 files 封顶 300 条且看不见 mode', async () => {
  const rec = new Recorder();
  await verifyBranch(mk(fakeFetch(verifyRoutes(), rec)), verifyArgs);
  assert.equal(rec.calls.filter((c) => c.path.includes('/compare/')).length, 0);
});

// 🔴 变异自检：把远端返回逐条改坏，每一条都必须变红
for (const [what, patch] of [
  ['ref 指向别的 commit', { refSha: 'SOMETHINGELSE' }],
  ['commit 的 parent 不是 base', { parents: [{ sha: 'OTHERBASE' }] }],
  ['commit 有两个 parent', { parents: [{ sha: 'BASECOMMIT' }, { sha: 'X' }] }],
  ['commit 的 tree 不是我们建的那棵', { commitTree: 'OTHERTREE' }],
  ['根目录多改了一个别的条目', {
    newRoot: [treeE('artifacts', 'TAMPERED'), treeE('registry', 'REG'), treeE('submissions', 'SUBNEW')],
  }],
  ['submissions 层多动了一个别的目录', { newSub: [treeE('other', 'TAMPERED'), treeE('acme', 'NSNEW')] }],
  ['🔴 0755 被写成了 0644（mode 进 tree_digest）', {
    leaf: [blobE('skill.json', 'B1', '100644'), blobE('run.sh', 'B2', '100644')],
  }],
  ['blob sha 与我们上传的不符', {
    leaf: [blobE('skill.json', 'B1', '100644'), blobE('run.sh', 'TAMPERED', '100755')],
  }],
  ['投稿目录里多了一个文件', {
    leaf: [blobE('skill.json', 'B1', '100644'), blobE('run.sh', 'B2', '100755'), blobE('x', 'B3')],
  }],
  ['投稿目录里少了一个文件', { leaf: [blobE('skill.json', 'B1', '100644')] }],
  ['投稿目录里有 gitlink（submodule）', {
    leaf: [blobE('skill.json', 'B1', '100644'), blobE('run.sh', 'B2', '100755'),
      { path: 'sub', mode: '160000', type: 'commit', sha: 'C' }],
  }],
]) {
  test(`🔴 核对变异：${what} → 必须失败`, async () => {
    await assert.rejects(
      () => verifyBranch(mk(fakeFetch(verifyRoutes(patch))), verifyArgs),
      (e) => e instanceof RemoteError && e.exitCode === 2,
      `${what}：这个变异没有被核对抓住`,
    );
  });
}

test('🔴 投稿目录在 base 上已经存在 → 核对失败（publish 只新增，不覆盖）', async () => {
  const routes = verifyRoutes({ baseSub: [treeE('other', 'O'), treeE('acme', 'NSOLD')] });
  routes.push(['GET', `${UP}/git/trees/NSOLD`, tree('NSOLD', [treeE('foo@1.0.0', 'OLDLEAF')])]);
  await assert.rejects(
    () => verifyBranch(mk(fakeFetch(routes)), verifyArgs),
    (e) => e.exitCode === 2 && /只新增/.test(e.message),
  );
});

test('🔴 核对失败时明确说"没有开 PR、分支不会被自动删"', async () => {
  let msg = '';
  try {
    await verifyBranch(mk(fakeFetch(verifyRoutes({ refSha: 'X' }))), verifyArgs);
  } catch (e) { msg = e.message; }
  assert.match(msg, /\*\*没有\*\*开 PR/);
  assert.match(msg, /不会\*\*自动删它/);
});

// ── PR ──────────────────────────────────────────────────────────────────────

const okPr = {
  number: 42, html_url: 'https://github.com/geoly-ai/skills-hub/pull/42', state: 'open',
  head: { repo: { id: FORK_ID }, ref: 'br', sha: 'NEWCOMMIT' },
  base: { repo: { id: UPSTREAM_ID }, ref: 'main' },
  user: { id: VIEWER.id },
};
const prArgs = { branch: 'br', viewer: VIEWER, forkId: FORK_ID, upstreamId: UPSTREAM_ID, commitSha: 'NEWCOMMIT' };

test('PR 核对：六条全对时通过', () => {
  assert.equal(assertPr(okPr, prArgs).number, 42);
});

// 🔴 变异自检：六条判据逐条改坏
for (const [what, mut] of [
  ['head 仓库不是我的 fork', { head: { ...okPr.head, repo: { id: 99 } } }],
  ['head 分支不是我们建的那个', { head: { ...okPr.head, ref: 'other' } }],
  ['head sha 不是我们建的 commit', { head: { ...okPr.head, sha: 'OTHER' } }],
  ['base 仓库不是上游', { base: { ...okPr.base, repo: { id: 99 } } }],
  ['base 分支不是 main', { base: { ...okPr.base, ref: 'develop' } }],
  ['PR 作者不是认证用户', { user: { id: 99 } }],
]) {
  test(`🔴 PR 核对变异：${what} → 必须失败`, () => {
    assert.throws(() => assertPr({ ...okPr, ...mut }, prArgs), (e) => e.exitCode === 2);
  });
}

test('🔴 head 上已经有 PR → 只读取报告，**不**再 POST 一个', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', `${UP}/pulls?state=all&head=alice%3Abr`, { json: [{ number: 9, state: 'open', html_url: 'u9' }] }],
  ], rec);
  await assert.rejects(
    () => openPullRequest(mk(f), { login: 'alice', branch: 'br', title: 't', body: 'b', ...prArgs }),
    (e) => e.exitCode === 3 && e.prNumber === 9,
  );
  assert.deepEqual(rec.writes(), [], '已有 PR 时不许发任何写请求');
});

test('🔴 开 PR 超时 → 先查；查不到就以网络错误退出，**不重发**', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', `${UP}/pulls?state=all&head=alice%3Abr`, { json: [] }],
    ['POST', `${UP}/pulls`, { abort: true }],
    ['GET', `${UP}/pulls?state=all&head=alice%3Abr`, { json: [] }],
  ], rec);
  await assert.rejects(
    () => openPullRequest(mkFast(f), { login: 'alice', branch: 'br', title: 't', body: 'b', ...prArgs }),
    (e) => e.exitCode === 6 && /拒绝重发/.test(e.message),
  );
  assert.equal(rec.count('POST', `${UP}/pulls`), 1, 'PR 的 POST 只能发一次');
});

test('开 PR 超时但查得到 → 用查到的那个，并照样核对', async () => {
  const f = fakeFetch([
    ['GET', `${UP}/pulls?state=all&head=alice%3Abr`, { json: [] }],
    ['POST', `${UP}/pulls`, { abort: true }],
    ['GET', `${UP}/pulls?state=all&head=alice%3Abr`, { json: [okPr] }],
  ]);
  const r = await openPullRequest(mkFast(f), { login: 'alice', branch: 'br', title: 't', body: 'b', ...prArgs });
  assert.equal(r.number, 42);
});

test('🔴 PR 里带 maintainer_can_modify（披露里说过它）', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', `${UP}/pulls?state=all&head=alice%3Abr`, { json: [] }],
    ['POST', `${UP}/pulls`, { json: okPr }],
  ], rec);
  await openPullRequest(mk(f), { login: 'alice', branch: 'br', title: 't', body: 'b', ...prArgs });
  const post = rec.calls.find((c) => c.method === 'POST');
  assert.equal(post.body.maintainer_can_modify, true);
  assert.equal(post.body.base, 'main');
  assert.equal(post.body.head, 'alice:br');
});
