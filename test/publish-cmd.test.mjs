// `publish` 的载荷预检与命令面。
//
// 🔴 这一整个文件里，fetch 桩默认**会抛**。`--dry-run` / 本地门失败 / 未确认
//    这几条路径上，任何一次出网都是 bug —— 而不出网这件事必须由测试证明，
//    不能靠"我们没写出网的代码"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { treeDigest } from '../src/tree-digest.mjs';

import { main } from '../src/cli.mjs';
import { Output } from '../src/commands/output.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import {
  readIdentity, stagePayload, assertRepoPath, submissionPrefix, PayloadError,
} from '../src/publish/payload.mjs';
import { cmdPublish, looksLikeGitInstall, disclosureLines } from '../src/commands/publish.mjs';
import { fakeFetch, Recorder, explodingFetch } from './harness/fake-github.mjs';

const TOKEN = 'ghp_PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
const UP = '/repos/geoly-ai/skills-hub';
const FORK = '/repos/alice/skills-hub';

const tmps = [];
function mkPayload({ ns = 'acme', name = 'foo', version = '1.0.0', extra = {}, manifest = {} } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'pub-test-'));
  tmps.push(d);
  const dir = join(d, 'payload');
  mkdirSync(dir);
  writeFileSync(join(dir, 'skill.json'), `${JSON.stringify({
    schema: 'geoly.skills.skill/1',
    kind: 'skill',
    namespace: ns,
    name,
    version,
    description: 'x'.repeat(40),
    license: 'MIT',
    capabilities: ['none'],
    clients: ['claude'],
    conflicts: [],
    replaces: [],
    ...manifest,
  }, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 一个测试用的 skill\n---\n\n正文。\n`, { mode: 0o644 });
  for (const [p, [content, mode]] of Object.entries(extra)) {
    const abs = join(dir, p);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, { mode });
    chmodSync(abs, mode);
  }
  return dir;
}
process.on('exit', () => { for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

// ── 路径门 ─────────────────────────────────────────────────────────────────

const PREFIX = submissionPrefix('acme', 'foo', '1.0.0');

test('submissionPrefix 就是 submissions/<ns>/<name>@<ver>/', () => {
  assert.equal(PREFIX, 'submissions/acme/foo@1.0.0/');
});

test('正常路径通过', () => {
  assert.equal(assertRepoPath(`${PREFIX}a/b.md`, { prefix: PREFIX }), true);
});

// 🔴 逐条变异：每一格都必须拒
for (const [what, p] of [
  ['前缀之外', 'submissions/other/x@1/a.md'],
  ['..', `${PREFIX}../evil`],
  ['.', `${PREFIX}./a`],
  ['空段（连续斜杠）', `${PREFIX}a//b`],
  ['控制字符 U+0001', `${PREFIX}a\u0001b`],
  ['NUL', `${PREFIX}a\u0000b`],
  ['反斜杠', `${PREFIX}a\\b`],
  ['百分号编码的斜杠 %2F', `${PREFIX}a%2Fb`],
  ['百分号编码的斜杠 %2f（小写）', `${PREFIX}a%2fb`],
  ['百分号编码的反斜杠 %5C', `${PREFIX}a%5Cb`],
  ['百分号编码的 .. （%2e%2e）', `${PREFIX}%2e%2e`],
  ['解不开的百分号转义', `${PREFIX}a%zzb`],
]) {
  test(`🔴 路径门：${what} → 拒`, () => {
    assert.throws(() => assertRepoPath(p, { prefix: PREFIX }), PayloadError, `${what} 没被拒`);
  });
}

test('🔴 manifest 里的 version 塞 `..` 会被前缀门拦住（它没经过载荷路径 grammar）', () => {
  const dir = mkPayload({ version: '1.0.0' });
  // 直接构造一个恶意 identity —— 模拟 manifest 被写成 `"version": "1.0.0/../../.github"`
  assert.throws(
    () => stagePayload(dir, {
      kind: 'skill', namespace: 'acme', name: 'foo', version: '1.0.0/../../.github', manifest: {},
    }),
    PayloadError,
  );
});

// ── readIdentity ───────────────────────────────────────────────────────────

test('readIdentity 读出 kind/ns/name/version', () => {
  const id = readIdentity(mkPayload());
  assert.equal(id.id, 'skill:acme/foo@1.0.0');
  assert.equal(id.kind, 'skill');
});

test('🔴 skill.json 与 pack.json 同时存在 → 拒（"这是什么制品"不能有两个答案）', () => {
  const dir = mkPayload();
  writeFileSync(join(dir, 'pack.json'), '{}\n');
  assert.throws(() => readIdentity(dir), PayloadError);
});

test('🔴 skill.json 里重复 key → parseStrict 拒（JSON.parse 会静默取最后一个）', () => {
  const dir = mkPayload();
  writeFileSync(join(dir, 'skill.json'),
    '{"namespace":"acme","name":"foo","version":"1.0.0","version":"9.9.9"}\n');
  assert.throws(() => readIdentity(dir), PayloadError);
});

// 🔴🔴 ns / name / version 的 grammar —— 它们是投稿者可控的，而且会进**分支名**，
//    而分支名会被拼进我们自己发出去的 API URL。
for (const [what, over] of [
  ['version 里带 ? （能往 API URL 注入 query）', { version: '1.0.0?x=1' }],
  ['version 里带 # （能往 API URL 注入 fragment）', { version: '1.0.0#frag' }],
  ['version 里带 /', { version: '1.0.0/../x' }],
  ['version 不是 semver', { version: 'latest' }],
  ['version 带 +build（D7 禁止）', { version: '1.0.0+build' }],
  ['namespace 大写', { ns: 'Acme' }],
  ['namespace 带下划线', { ns: 'a_b' }],
  ['name 带斜杠', { name: 'a/b' }],
  ['name 带空格', { name: 'a b' }],
]) {
  test(`🔴 manifest grammar：${what} → 拒`, () => {
    assert.throws(() => readIdentity(mkPayload(over)), PayloadError, `${what} 没被拒`);
  });
}

test('🔴 分支名出厂前过字符白名单（与 grammar 门相隔很远，是纵深）', async () => {
  const { branchName } = await import('../src/publish/remote.mjs');
  const d = `geoly-tree-v1:sha256:${'ab'.repeat(32)}`;
  assert.equal(
    branchName({ namespace: 'acme', name: 'foo', version: '1.0.0', treeDigest: d }),
    'submit/acme/foo@1.0.0-abababab',
  );
  for (const bad of ['1.0.0?x', '1.0.0#y', '1.0.0&z', '1.0.0 w']) {
    assert.throws(
      () => branchName({ namespace: 'acme', name: 'foo', version: bad, treeDigest: d }),
      /危险字符/,
      `version=${bad} 竟然拼出了一个被接受的分支名`,
    );
  }
});

// ── stagePayload：0755 保住 ────────────────────────────────────────────────

test('🔴 0755 在暂存树上被原样保住 —— mode 进 tree_digest', () => {
  const dir = mkPayload({ extra: { 'run.sh': ['#!/bin/sh\necho hi\n', 0o755] } });
  const id = readIdentity(dir);
  const st = stagePayload(dir, id);
  try {
    const run = st.files.find((f) => f.repoPath.endsWith('/run.sh'));
    assert.equal(run.mode, 0o755);
    assert.match(st.treeDigest, /^geoly-tree-v1:sha256:[0-9a-f]{64}$/);
  } finally { rmSync(st.staging, { recursive: true, force: true }); }
});

test('🔴 同字节不同 mode → 两个不同的 tree_digest（这是不能用 Contents API 的理由）', () => {
  const digestFor = (mode) => {
    const dir = mkPayload({ extra: { 'run.sh': ['#!/bin/sh\n', mode] } });
    const st = stagePayload(dir, readIdentity(dir));
    try { return st.treeDigest; } finally { rmSync(st.staging, { recursive: true, force: true }); }
  };
  const a = digestFor(0o644);
  const b = digestFor(0o755);
  assert.notEqual(a, b, '同字节不同 mode 竟然算出同一个摘要 —— 那 mode 就不进身份了');
});

test('🔴🔴 冻结之后源目录被改，摘要仍然是**我们要上传的那棵树**的摘要', () => {
  // 这条钉的是 `treeDigest(暂存树)` 而不是 `treeDigest(源目录)`：
  // 两者在正常输入下结果相同，只有在「冻结与算摘要之间源树被改」这个窗口里才分叉。
  // 用 `afterFreeze` 把那个窗口**确定性地**造出来。
  const dir = mkPayload();
  const st = stagePayload(dir, readIdentity(dir), {
    afterFreeze: () => {
      writeFileSync(join(dir, 'SKILL.md'),
        '---\nname: foo\ndescription: 冻结之后被换掉了\n---\n\n完全不同的内容\n');
    },
  });
  try {
    // 摘要必须等于**暂存树**的摘要（= 我们要上传的字节），而不是被改过的源目录的
    const staged = join(st.staging, 'submissions/acme/foo@1.0.0');
    assert.equal(st.treeDigest, treeDigest(staged));
    assert.notEqual(st.treeDigest, treeDigest(dir),
      '摘要跟着被改动的源目录跑了 —— 那么 tree_digest 与实际上传的字节就是两棵树');
    // 上传用的字节也没被带跑
    assert.equal(
      st.files.find((f) => f.repoPath.endsWith('/SKILL.md')).data.toString('utf8').includes('被换掉了'),
      false,
    );
  } finally { rmSync(st.staging, { recursive: true, force: true }); }
});

test('🔴 载荷在暂存之后被改动，不会影响我们要上传的那份字节（读一次盘）', () => {
  const dir = mkPayload();
  const st = stagePayload(dir, readIdentity(dir));
  try {
    const before = st.files.find((f) => f.repoPath.endsWith('/SKILL.md')).data.toString('utf8');
    // 模拟"编辑器在我们算完摘要之后又保存了一次"
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: foo\ndescription: 被换掉了\n---\n\n别的内容\n');
    const after = st.files.find((f) => f.repoPath.endsWith('/SKILL.md')).data.toString('utf8');
    assert.equal(after, before, '要上传的字节被源目录的后续改动带跑了');
    // 暂存树也没有跟着变 —— 摘要算的就是这棵树
    assert.equal(
      readFileSync(join(st.staging, 'submissions/acme/foo@1.0.0/SKILL.md'), 'utf8'), before,
    );
  } finally { rmSync(st.staging, { recursive: true, force: true }); }
});

test('暂存树的布局正好是 submissions/<ns>/<name>@<ver>/…', () => {
  const dir = mkPayload();
  const st = stagePayload(dir, readIdentity(dir));
  try {
    assert.deepEqual(st.files.map((f) => f.repoPath).sort(), [
      'submissions/acme/foo@1.0.0/SKILL.md',
      'submissions/acme/foo@1.0.0/skill.json',
    ]);
    assert.equal(readFileSync(join(st.staging, 'submissions/acme/foo@1.0.0/skill.json'), 'utf8').length > 0, true);
  } finally { rmSync(st.staging, { recursive: true, force: true }); }
});

// ── npx github: 守卫 ───────────────────────────────────────────────────────

test('npx github: 守卫认 gitHead 与 _resolved，registry 装的包放行', () => {
  assert.equal(looksLikeGitInstall('{"gitHead":"abc123"}'), true);
  assert.equal(looksLikeGitInstall('{"_resolved":"git+https://github.com/x/y.git#abc"}'), true);
  assert.equal(looksLikeGitInstall('{"_resolved":"https://registry.npmjs.org/x/-/x-1.tgz"}'), false);
  assert.equal(looksLikeGitInstall('{"name":"x"}'), false);
  assert.equal(looksLikeGitInstall('这不是 JSON'), false, '读不出来时不该误伤');
  assert.equal(looksLikeGitInstall('{"gitHead":""}'), false, '空串不算');
});

// ── 披露 ───────────────────────────────────────────────────────────────────

const PLAN = {
  files: [{ repoPath: `${PREFIX}skill.json`, mode: 0o644 }, { repoPath: `${PREFIX}run.sh`, mode: 0o755 }],
  prefix: PREFIX,
  treeDigest: `geoly-tree-v1:sha256:${'ab'.repeat(32)}`,
  branch: 'submit/acme/foo@1.0.0-abababab',
};
const VIEWER = { login: 'alice', id: 7, nodeId: 'U_alice', scopes: ['repo'] };

test('🔴 披露里有 token 来源、身份、权限面、写操作清单、路径与 mode', () => {
  const L = disclosureLines({
    tokenInfo: { sourceLabel: '环境变量 GH_TOKEN', others: ['GITHUB_TOKEN'] }, viewer: VIEWER, plan: PLAN,
  });
  const txt = L.join('\n');
  // 数个数，不是"出现过"：每条路径必须**恰好**出现一次，且带正确的 mode
  assert.equal(L.filter((l) => l.trim() === `0644  ${PREFIX}skill.json`).length, 1);
  assert.equal(L.filter((l) => l.trim() === `0755  ${PREFIX}run.sh`).length, 1);
  // 身份三样
  assert.equal(L.filter((l) => l.includes('alice（node_id U_alice，id 7）')).length, 1);
  assert.equal(L.filter((l) => l.includes('环境变量 GH_TOKEN')).length, 1);
  assert.equal(L.filter((l) => l.includes('GITHUB_TOKEN') && l.includes('同时存在')).length, 1);
  // 🔴 权限面那句必须在 —— 它是这个授权模型的全部代价
  assert.match(txt, /可读写你\*\*所有\*\*仓库，含\*\*私有\*\*仓库/);
  assert.match(txt, /CLI \*\*无法\*\*收窄它/);
  // 🔴 maintainer_can_modify 是一项额外授出的权限，必须说
  assert.match(txt, /maintainer_can_modify/);
  // 分支与摘要
  assert.equal(L.filter((l) => l.includes(PLAN.branch)).length, 1);
  assert.equal(L.filter((l) => l.includes(PLAN.treeDigest)).length, 1);
});

test('🔴 scopes 看不见时说「看不见」，不说「无」', () => {
  const L = disclosureLines({
    tokenInfo: { sourceLabel: 'x', others: [] }, viewer: { ...VIEWER, scopes: null }, plan: PLAN,
  });
  const line = L.find((l) => l.includes('可见 scope'));
  assert.match(line, /看不见/);
  assert.equal(/无$/.test(line), false);
});

// ── 命令面 ─────────────────────────────────────────────────────────────────

function ctxFor(payloadDir, { fetchImpl = explodingFetch, env = {}, yes = false, stdin = null, offline = false } = {}) {
  return Object.freeze({
    cwd: payloadDir, env: { ...env }, offline, yes, json: false,
    cliVersion: '0.0.0-test', fetchImpl,
    stdin: stdin ?? Object.assign(Readable.from([]), { isTTY: false }),
  });
}
const sink = () => {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
};
const outFor = () => {
  const o = sink(); const e = sink();
  return { out: new Output({ json: false, stdout: o, stderr: e }), o, e };
};

test('🔴 --offline 下 publish 直接拒，且一次出网都没有', async () => {
  const dir = mkPayload();
  const { out } = outFor();
  await assert.rejects(
    () => cmdPublish(ctxFor(dir, { offline: true }), [], out),
    (e) => e.exitCode === EXIT.USAGE,
  );
});

test('🔴 --pack 与实际载荷不符 → 失败（它是断言，不是提示）', async () => {
  const dir = mkPayload();
  const { out } = outFor();
  await assert.rejects(
    () => cmdPublish(ctxFor(dir, { env: { GH_TOKEN: TOKEN } }), ['--pack'], out),
    (e) => e.exitCode === EXIT.USAGE && /期望的是 pack/.test(e.message),
  );
});

test('publish 不认得的 flag → 用法错误', async () => {
  const dir = mkPayload();
  const { out } = outFor();
  await assert.rejects(() => cmdPublish(ctxFor(dir), ['--force'], out), (e) => e.exitCode === EXIT.USAGE);
});

/** 一次完整的成功投稿所需的全部路由。 */
function happyRoutes({ artifacts = [], owners = { acme: { kind: 'user', login: 'alice', id: 'U_alice' } } } = {}) {
  const t = (sha, entries) => ({ json: { sha, truncated: false, tree: entries } });
  const T = (p, sha) => ({ path: p, mode: '040000', type: 'tree', sha });
  const B = (p, sha, mode = '100644') => ({ path: p, mode, type: 'blob', sha });
  const root = [T('artifacts', 'ART'), T('registry', 'REG'), T('submissions', 'SUBOLD')];
  // 🔴 PR 的 head.ref 由**请求体**回显：分支名带 tree_digest 前 8 位，在这里写死
  //    就等于把一个真实的判据（`assertPr` 核对 head.ref）变成永远对不上的噪声。
  //    `assertPr` 的六条判据各有一条**专门的**变异测试（publish-remote.test.mjs），
  //    这里要测的是"整条链跑通"。
  const prFor = ({ body }) => ({
    json: {
      number: 42, html_url: 'https://github.com/geoly-ai/skills-hub/pull/42', state: 'open',
      head: { repo: { id: 5678 }, ref: body.head.split(':')[1], sha: 'NEWCOMMIT' },
      base: { repo: { id: 1234 }, ref: body.base },
      user: { id: 7 },
    },
  });
  return [
    ['GET', '/user', { json: { login: 'alice', id: 7, node_id: 'U_alice' }, headers: { 'x-oauth-scopes': 'repo' } }],
    ['GET', UP, { json: { id: 1234, full_name: 'geoly-ai/skills-hub' } }],
    ['GET', `${UP}/git/ref/heads/main`, { json: { object: { type: 'commit', sha: 'BASECOMMIT' } } }],
    ['GET', `${UP}/git/commits/BASECOMMIT`, { json: { tree: { sha: 'BASETREE' } } }],
    ['GET', `${UP}/git/trees/BASETREE`, t('BASETREE', root)],
    ['GET', `${UP}/git/trees/ART?recursive=1`, t('ART', artifacts.map((p) => B(p, 'x')))],
    ['GET', `${UP}/git/trees/BASETREE`, t('BASETREE', root)],
    ['GET', `${UP}/git/trees/REG`, t('REG', [B('reserved.json', 'R1'), B('owners.json', 'O1')])],
    ['GET', `${UP}/git/trees/BASETREE`, t('BASETREE', root)],
    ['GET', `${UP}/git/trees/SUBOLD`, t('SUBOLD', [])],
    ['GET', `${UP}/git/blobs/R1`, {
      json: {
        encoding: 'base64',
        content: Buffer.from(JSON.stringify({ schema: 'geoly.skills.reserved/1', namespaces: ['geoly'] })).toString('base64'),
      },
    }],
    ['GET', `${UP}/git/blobs/O1`, {
      json: {
        encoding: 'base64',
        content: Buffer.from(JSON.stringify({ namespaces: owners })).toString('base64'),
      },
    }],
    ['GET', `${UP}/pulls?state=open&per_page=100&page=1`, { json: [] }],
    // ── 以下都是写路径 ──
    ['GET', FORK, { json: { id: 5678, fork: true, owner: { id: 7 }, parent: { id: 1234 } } }],
    ['GET', `${FORK}/git/commits/BASECOMMIT`, { json: { sha: 'BASECOMMIT' } }],
    ['GET', /^\/repos\/alice\/skills-hub\/git\/ref\/heads\/submit/, { status: 404, json: {} }],
    ['POST', `${FORK}/git/blobs`, { json: { sha: 'B1' } }],
    ['POST', `${FORK}/git/blobs`, { json: { sha: 'B2' } }],
    ['POST', `${FORK}/git/trees`, { json: { sha: 'NEWTREE' } }],
    ['POST', `${FORK}/git/commits`, { json: { sha: 'NEWCOMMIT' } }],
    ['POST', `${FORK}/git/refs`, { json: {} }],
    // 核对
    ['GET', /^\/repos\/alice\/skills-hub\/git\/ref\/heads\/submit/, { json: { object: { sha: 'NEWCOMMIT' } } }],
    ['GET', `${FORK}/git/commits/NEWCOMMIT`, { json: { parents: [{ sha: 'BASECOMMIT' }], tree: { sha: 'NEWTREE' } } }],
    ['GET', `${UP}/git/trees/BASETREE`, t('BASETREE', root)],
    ['GET', `${FORK}/git/trees/NEWTREE`, t('NEWTREE', [T('artifacts', 'ART'), T('registry', 'REG'), T('submissions', 'SUBNEW')])],
    ['GET', `${UP}/git/trees/SUBOLD`, t('SUBOLD', [])],
    ['GET', `${FORK}/git/trees/SUBNEW`, t('SUBNEW', [T('acme', 'NSNEW')])],
    ['GET', `${FORK}/git/trees/NSNEW`, t('NSNEW', [T('foo@1.0.0', 'LEAF')])],
    ['GET', `${FORK}/git/trees/LEAF?recursive=1`, t('LEAF', [B('SKILL.md', 'B1'), B('skill.json', 'B2')])],
    // PR
    ['GET', /^\/repos\/geoly-ai\/skills-hub\/pulls\?state=all/, { json: [] }],
    ['POST', `${UP}/pulls`, prFor],
  ];
}

test('🔴 --dry-run：跑完全部只读检查与披露，**一个写请求都不发**', async () => {
  const dir = mkPayload();
  const rec = new Recorder();
  const f = fakeFetch(happyRoutes(), rec);
  const { out, o } = outFor();
  const code = await cmdPublish(ctxFor(dir, { fetchImpl: f, env: { GH_TOKEN: TOKEN } }), ['--dry-run'], out);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(rec.writes(), [], `dry-run 发出了写请求：${JSON.stringify(rec.writes())}`);
  // 披露确实打出来了 —— 钉具体那一行
  assert.equal(o.text().split('\n').filter((l) => l.trim() === `0644  ${PREFIX}SKILL.md`).length, 1);
  assert.match(o.text(), /一个写请求都没有发/);
});

test('🔴 --dry-run 之后**没有**要求确认（它本来就不写）', async () => {
  const dir = mkPayload();
  // stdin 是会抛的：一旦去读它就说明走了确认那一支
  const stdin = Object.assign(Readable.from([]), {
    isTTY: true, on: () => { throw new Error('dry-run 不该读 stdin'); },
  });
  const { out } = outFor();
  const code = await cmdPublish(
    ctxFor(dir, { fetchImpl: fakeFetch(happyRoutes()), env: { GH_TOKEN: TOKEN }, stdin }), ['--dry-run'], out,
  );
  assert.equal(code, EXIT.OK);
});

test('🔴 非交互 + 没给 --yes → 拒，且披露之后一个写请求都没发', async () => {
  const dir = mkPayload();
  const rec = new Recorder();
  const f = fakeFetch(happyRoutes(), rec);
  const { out } = outFor();
  await assert.rejects(
    () => cmdPublish(ctxFor(dir, { fetchImpl: f, env: { GH_TOKEN: TOKEN } }), [], out),
    (e) => e.exitCode === EXIT.USAGE && /必须显式给 --yes/.test(e.message),
  );
  assert.deepEqual(rec.writes(), []);
});

test('🔴 TTY 下输错确认词 → 拒，一个写请求都没发', async () => {
  const dir = mkPayload();
  const rec = new Recorder();
  const stdin = Object.assign(Readable.from(['yes\n']), { isTTY: true });
  const { out } = outFor();
  await assert.rejects(
    () => cmdPublish(ctxFor(dir, { fetchImpl: fakeFetch(happyRoutes(), rec), env: { GH_TOKEN: TOKEN }, stdin }), [], out),
    (e) => e.exitCode === EXIT.USAGE && /未确认/.test(e.message),
  );
  assert.deepEqual(rec.writes(), []);
});

test('给了 --yes 的完整一次投稿：写请求恰好是 blob×2 + tree + commit + ref + pr', async () => {
  const dir = mkPayload();
  const rec = new Recorder();
  const f = fakeFetch(happyRoutes(), rec);
  const { out, o } = outFor();
  const code = await cmdPublish(ctxFor(dir, { fetchImpl: f, env: { GH_TOKEN: TOKEN }, yes: true }), [], out);
  assert.equal(code, EXIT.OK);
  // 🔴 数个数 + 顺序：ref 必须在 blob/tree/commit 之后，PR 必须在最后
  assert.deepEqual(rec.writes().map((c) => c.path), [
    `${FORK}/git/blobs`, `${FORK}/git/blobs`, `${FORK}/git/trees`,
    `${FORK}/git/commits`, `${FORK}/git/refs`, `${UP}/pulls`,
  ]);
  assert.match(o.text(), /PR #42 已开/);
});

test('🔴 版本已经在 artifacts/ 里 → 本地门拒，**一个写请求都不发**', async () => {
  const dir = mkPayload();
  const rec = new Recorder();
  const f = fakeFetch(happyRoutes({ artifacts: ['skills/acme/foo/1.0.0/skill.json'] }), rec);
  const { out } = outFor();
  await assert.rejects(
    () => cmdPublish(ctxFor(dir, { fetchImpl: f, env: { GH_TOKEN: TOKEN }, yes: true }), [], out),
    (e) => e.exitCode === EXIT.USAGE && /不合规/.test(e.message),
  );
  assert.deepEqual(rec.writes(), []);
});

test('🔴 保留 namespace → 本地门拒（byMaintainer 恒为 false，与服务端默认一致）', async () => {
  const dir = mkPayload({ ns: 'geoly' });
  const rec = new Recorder();
  // 🔴 owners.json 里**先把 geoly 注册上** —— 否则"未注册 namespace 缺 claim_owner"
  //    那一条也会红，于是把 byMaintainer 改成 true 时这条测试照样绿，
  //    这道闸就等于没被钉住（第一轮变异自检正是这样漏过去的）。
  const f = fakeFetch(happyRoutes({
    owners: { geoly: { kind: 'org', login: 'geoly-ai', id: 'O_g' } },
  }), rec);
  const { out } = outFor();
  await assert.rejects(
    () => cmdPublish(ctxFor(dir, { fetchImpl: f, env: { GH_TOKEN: TOKEN }, yes: true }), [], out),
    (e) => e.exitCode === EXIT.USAGE && /保留清单/.test(e.message),
  );
  assert.deepEqual(rec.writes(), []);
});

test('🔴 同形仿冒的 namespace（ge0ly）→ 本地门也拒（走的是服务端那套折叠表）', async () => {
  const dir = mkPayload({ ns: 'ge0ly' });
  const rec = new Recorder();
  const f = fakeFetch(happyRoutes({
    owners: { ge0ly: { kind: 'user', login: 'alice', id: 'U_alice' } },
  }), rec);
  const { out } = outFor();
  await assert.rejects(
    () => cmdPublish(ctxFor(dir, { fetchImpl: f, env: { GH_TOKEN: TOKEN }, yes: true }), [], out),
    (e) => e.exitCode === EXIT.USAGE && /同形/.test(e.message),
  );
  assert.deepEqual(rec.writes(), []);
});

test('🔴 载荷里有 bidi 控制字符 → 本地门拒（服务端也会拒），不发写请求', async () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE —— scan-text 的 forbidden 档
  const dir = mkPayload({ extra: { 'evil.md': ['正常‮反转\n', 0o644] } });
  const rec = new Recorder();
  const f = fakeFetch(happyRoutes(), rec);
  const { out } = outFor();
  await assert.rejects(
    () => cmdPublish(ctxFor(dir, { fetchImpl: f, env: { GH_TOKEN: TOKEN }, yes: true }), [], out),
    (e) => e.exitCode === EXIT.USAGE && /字符问题/.test(e.message),
  );
  assert.deepEqual(rec.writes(), []);
});

test('写了 provenance → 告警（不拒），并建议删掉', async () => {
  const dir = mkPayload({
    manifest: { provenance: { kind: 'original', author_github_id: 'U_x', submitted_by_pr: 1 } },
  });
  const { out, e } = outFor();
  await cmdPublish(
    ctxFor(dir, { fetchImpl: fakeFetch(happyRoutes()), env: { GH_TOKEN: TOKEN } }), ['--dry-run'], out,
  );
  const hits = out.warnings().filter((w) => w.kind === 'provenance-declared');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /建议直接删掉 provenance/);
  assert.equal(e.text().includes('provenance'), true);
});

test('🔴 本地门失败时**根本没问过 /user** —— 顺序是 基线 → 本地门 → /user', async () => {
  const dir = mkPayload();
  const rec = new Recorder();
  const f = fakeFetch(happyRoutes({ artifacts: ['skills/acme/foo/1.0.0/skill.json'] }), rec);
  const { out } = outFor();
  await assert.rejects(
    () => cmdPublish(ctxFor(dir, { fetchImpl: f, env: { GH_TOKEN: TOKEN }, yes: true }), [], out),
    (e) => e.exitCode === EXIT.USAGE,
  );
  assert.equal(rec.count('GET', '/user'), 0,
    '一个连结构门都过不了的投稿，不该先把身份连同 token 发出去');
});

test('🔴 本地门失败的文案说的是「没发写请求」，不是「没发任何请求」', async () => {
  const dir = mkPayload();
  const rec = new Recorder();
  const f = fakeFetch(happyRoutes({ artifacts: ['skills/acme/foo/1.0.0/skill.json'] }), rec);
  const { out } = outFor();
  let msg = '';
  try {
    await cmdPublish(ctxFor(dir, { fetchImpl: f, env: { GH_TOKEN: TOKEN }, yes: true }), [], out);
  } catch (e) { msg = e.message; }
  // 到这一步确实已经发过只读 GET —— 所以文案不能说"没有发出任何请求"
  assert.ok(rec.calls.length > 0, '取基线本来就要发 GET');
  assert.deepEqual(rec.writes(), []);
  assert.match(msg, /没有\*\*发出任何写请求/);
});

// 🔴 scan-text 有四档：`forbidden` 是**服务端会拒**的（不可见字符 / bidi / symlink），
//    其余三档 `suspicious` / `mixedScript` / `compatibility` **只告警**。
//    三档各喂一个真样本 —— 只测其中一档的话，「把某一档也算进 scanErrors」
//    这种改动照样绿。
for (const [what, file, content] of [
  // `pаypal` 的 `а` 是西里尔字母 → mixedScript
  ['mixedScript（同一个词里混西里尔字母）', 'note.md', '关于 pаypal 的说明\n'],
  // 全角拉丁字母 → NFKC + 折叠之后与 ASCII 同形 → compatibility
  ['compatibility（全角拉丁字母）', 'note.md', '这里写着 ｓｈｅｌｌ 两个字\n'],
  // U+034F CGJ：零宽、能在词里拆开匹配，但本身合法 → suspicious
  ['suspicious（U+034F 组合字位连接符）', 'note.md', 'a\u034fb 这样写\n'],
]) {
  test(`🔴 ${what} → 只告警，**不**阻断`, async () => {
    const dir = mkPayload({ extra: { [file]: [content, 0o644] } });
    const rec = new Recorder();
    const { out } = outFor();
    const code = await cmdPublish(
      ctxFor(dir, { fetchImpl: fakeFetch(happyRoutes(), rec), env: { GH_TOKEN: TOKEN } }), ['--dry-run'], out,
    );
    assert.equal(code, EXIT.OK, `${what} 只该告警，不该把投稿挡下来`);
    assert.deepEqual(rec.writes(), []);
    // 但必须**被说出来**
    assert.equal(out.warnings().filter((w) => w.kind === 'scan-text').length >= 1, true,
      `${what} 没有被告警出来`);
  });
}

test('🔴 三档告警各自被真的样本触发（不是同一条被数了三次）', async () => {
  const { scanTree } = await import('../scripts/submission/scan-text.mjs');
  const cases = [
    ['mixedScript', mkPayload({ extra: { 'a.md': ['关于 pаypal\n', 0o644] } })],
    ['compatibility', mkPayload({ extra: { 'a.md': ['ｓｈｅｌｌ\n', 0o644] } })],
    ['suspicious', mkPayload({ extra: { 'a.md': ['a\u034fb\n', 0o644] } })],
  ];
  for (const [bucket, dir] of cases) {
    const r = scanTree(dir);
    assert.equal(r.forbidden.length, 0, `${bucket} 的样本不该落进 forbidden（那是硬失败档）`);
    assert.ok(r[bucket].length >= 1, `${bucket} 的样本没有触发 ${bucket} 档 —— 这条测试证明不了什么`);
  }
});

test('🔴 上游有开着的同版本 PR → 拒，且没发写请求', async () => {
  const dir = mkPayload();
  const rec = new Recorder();
  const routes = happyRoutes();
  const i = routes.findIndex(([, p]) => p === `${UP}/pulls?state=open&per_page=100&page=1`);
  routes[i] = ['GET', `${UP}/pulls?state=open&per_page=100&page=1`, {
    json: [{ number: 3, head: { sha: 'H3' }, user: { login: 'bob' }, html_url: 'u3', title: 't' }],
  }];
  routes.push(
    ['GET', `${UP}/git/commits/H3`, { json: { tree: { sha: 'T3' } } }],
    ['GET', `${UP}/git/trees/T3`, { json: { tree: [{ path: 'submissions', mode: '040000', type: 'tree', sha: 'S3' }] } }],
    ['GET', `${UP}/git/trees/S3`, { json: { tree: [{ path: 'acme', mode: '040000', type: 'tree', sha: 'N3' }] } }],
    ['GET', `${UP}/git/trees/N3`, { json: { tree: [{ path: 'foo@1.0.0', mode: '040000', type: 'tree', sha: 'D3' }] } }],
  );
  const { out } = outFor();
  await assert.rejects(
    () => cmdPublish(ctxFor(dir, { fetchImpl: fakeFetch(routes, rec), env: { GH_TOKEN: TOKEN }, yes: true }), [], out),
    (e) => e.exitCode === EXIT.CONFLICT && /#3/.test(e.message),
  );
  assert.deepEqual(rec.writes(), []);
});

// ── CLI 接线 ───────────────────────────────────────────────────────────────

test('🔴 publish 挂进了 COMMANDS（未知命令的清单里有它）', async () => {
  const o = sink(); const e = sink();
  const code = await main(['nosuchcmd', '--json'], { stdout: o, stderr: e });
  assert.equal(code, EXIT.USAGE);
  const doc = JSON.parse(o.text());
  assert.match(doc.error.message, /publish/);
});

test('🔴 --help 里写清了 publish 用的是用户已有的 token、且 --yes 不跳过校验', async () => {
  const o = sink(); const e = sink();
  await main(['--help'], { stdout: o, stderr: e });
  const help = o.text();
  const line = help.split('\n').find((l) => l.trim().startsWith('publish '));
  assert.notEqual(line, undefined, 'HELP 里没有 publish 那一行');
  assert.match(help, /\*\*不持有、不存储\*\*它/);
  assert.match(help, /不跳过任何校验/);
});

// ── 包里跑得起来（Codex 点名要的那条）─────────────────────────────────────

test('🔴 从 bin 那条入口动态 import 门模块时，它们的 CLI 入口守卫不会误触发', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `import('${new URL('../scripts/submission/run-gates.mjs', import.meta.url).href}')`
    + `.then(m => process.stdout.write(typeof m.runGates));`,
  ], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
  assert.equal(out.trim(), 'function');
});

test('🔴 npm 包里必须带上 publish 依赖的那四个门模块', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const f of [
    'scripts/submission/structural-gates.mjs', 'scripts/submission/run-gates.mjs',
    'scripts/submission/promotion-file.mjs', 'scripts/submission/scan-text.mjs',
  ]) {
    assert.equal(pkg.files.includes(f), true, `package.json 的 files 少了 ${f} —— publish 在用户机器上会 ERR_MODULE_NOT_FOUND`);
  }
});
