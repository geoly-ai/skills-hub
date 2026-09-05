// `publish` 的 HTTP 客户端 —— host 钉死、不跟随重定向、token 不泄漏、分页不静默截断。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createClient, getAllPages, seg, API_ORIGIN, UPSTREAM_FULL, BASE_BRANCH,
  ApiHttpError, ApiNetworkError, TruncatedError,
} from '../src/publish/github.mjs';
import { fakeFetch, Recorder } from './harness/fake-github.mjs';

const TOKEN = 'ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
const mk = (fetchImpl) => createClient({ token: TOKEN, fetchImpl, userAgent: 'test/1' });

// ── 固定的那几个常量 ────────────────────────────────────────────────────────

test('🔴 host / 上游 / base 分支是钉死的常量，不是参数', () => {
  assert.equal(API_ORIGIN, 'https://api.github.com');
  assert.equal(UPSTREAM_FULL, 'geoly-ai/skills-hub');
  assert.equal(BASE_BRANCH, 'main');
});

// ── fetch 注入没有逃生口 ────────────────────────────────────────────────────

test('🔴 不给 fetchImpl 就抛 —— **没有**隐式回退到 globalThis.fetch', () => {
  assert.throws(
    () => createClient({ token: TOKEN, userAgent: 'x' }),
    (e) => e instanceof ApiNetworkError,
  );
  // 显式给 null / 非函数同样抛（"忘了注入"与"注入了个假的"都不该静默出网）
  assert.throws(() => createClient({ token: TOKEN, fetchImpl: null, userAgent: 'x' }), ApiNetworkError);
});

// ── host 钉死 ──────────────────────────────────────────────────────────────

test('🔴 路径里塞一个绝对 URL 也换不掉 host —— 断言在**拼接之后**', async () => {
  const c = mk(() => { throw new Error('不该发出去'); });
  await assert.rejects(
    () => c.get('https://evil.example/x'),
    (e) => e instanceof ApiNetworkError && /拒绝向 https:\/\/evil\.example/.test(e.message),
  );
  // 协议相对写法（`//host/path`）同样要被挡住
  await assert.rejects(() => c.get('//evil.example/x'), ApiNetworkError);
});

test('正常请求确实发向 api.github.com，并带上固定的四个头', async () => {
  const rec = new Recorder();
  const f = fakeFetch([['GET', '/user', { json: { login: 'a' } }]], rec);
  await mk(f).get('/user');
  assert.equal(rec.calls.length, 1);
  const h = rec.calls[0].headers;
  assert.equal(h.Authorization, `Bearer ${TOKEN}`);
  assert.equal(h.Accept, 'application/vnd.github+json');
  assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(h['User-Agent'], 'test/1');
});

// ── 重定向 ─────────────────────────────────────────────────────────────────

test('🔴 fetch 一律用 redirect:"manual"，且任何 3xx 都抛（同 host 也抛）', async () => {
  const rec = new Recorder();
  const f = fakeFetch([
    ['GET', '/a', { status: 301, headers: { location: 'https://api.github.com/b' } }],
  ], rec);
  await assert.rejects(
    () => mk(f).get('/a'),
    (e) => e instanceof ApiNetworkError && /301 重定向/.test(e.message),
  );
  assert.equal(rec.calls[0].redirect, 'manual');
  // 🔴 只发了一次 —— 没有跟随
  assert.equal(rec.calls.length, 1);
});

// ── token 不泄漏 ───────────────────────────────────────────────────────────

test('🔴 HTTP 错误的文案里没有 Authorization、也没有 token 原文', async () => {
  const f = fakeFetch([['GET', '/user', { status: 403, json: { message: `你的 ${TOKEN} 没权限` } }]]);
  let msg = '';
  try { await mk(f).get('/user'); } catch (e) { msg = e.message; }
  assert.equal(msg.includes(TOKEN), false, 'token 原文进了错误文案');
  assert.equal(/Bearer/.test(msg), false, 'Authorization 头进了错误文案');
  assert.equal(/\*\*\*/.test(msg), true, '应当被 scrub 成 ***');
});

test('401 / 403 → exitCode 7；其余 HTTP 错误 → 6', async () => {
  for (const [status, code] of [[401, 7], [403, 7], [404, 6], [422, 6], [500, 6]]) {
    const f = fakeFetch([['GET', '/x', { status, json: { message: 'no' } }]]);
    await assert.rejects(
      () => mk(f).get('/x'),
      (e) => e instanceof ApiHttpError && e.status === status && e.exitCode === code,
    );
  }
});

test('softStatus 里的状态码原样返回，不抛', async () => {
  const f = fakeFetch([['GET', '/x', { status: 404, json: { message: 'Not Found' } }]]);
  const r = await mk(f).get('/x', { softStatus: [404] });
  assert.equal(r.status, 404);
  assert.equal(r.ok, false);
});

// ── seg ────────────────────────────────────────────────────────────────────

test('🔴 seg 把斜杠也转义掉 —— 一个叫 a/b 的分支名不该变成两层路径', () => {
  assert.equal(seg('a/b'), 'a%2Fb');
  assert.equal(seg('x..y'), 'x..y');            // 转义不负责语义，那是别处的门
  assert.equal(seg('a b'), 'a%20b');
});

// ── 分页 ───────────────────────────────────────────────────────────────────

test('分页取到不满一页为止', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i }));
  const f = fakeFetch([
    ['GET', '/p?per_page=100&page=1', { json: page1 }],
    ['GET', '/p?per_page=100&page=2', { json: [{ number: 100 }] }],
  ]);
  const all = await getAllPages(mk(f), '/p', { perPage: 100, maxPages: 5 });
  assert.equal(all.length, 101);
});

test('🔴 分页预算用尽 → 抛 TruncatedError，**不**返回"取到的那部分"', async () => {
  const full = Array.from({ length: 2 }, (_, i) => ({ number: i }));
  const f = fakeFetch([
    ['GET', '/p?per_page=2&page=1', { json: full }],
    ['GET', '/p?per_page=2&page=2', { json: full }],
  ]);
  await assert.rejects(
    () => getAllPages(mk(f), '/p', { perPage: 2, maxPages: 2 }),
    (e) => e instanceof TruncatedError && e.got === 4,
  );
});

test('🔴 分页返回的不是数组 → 抛，不当成"这一页是空的"', async () => {
  const f = fakeFetch([['GET', '/p?per_page=100&page=1', { json: { message: 'oops' } }]]);
  await assert.rejects(
    () => getAllPages(mk(f), '/p'),
    (e) => e instanceof TruncatedError && /这一页是空的/.test(e.message),
  );
});

test('已有 query 时分页参数用 & 拼接，不再加一个 ?', async () => {
  const rec = new Recorder();
  const f = fakeFetch([['GET', '/p?state=open&per_page=100&page=1', { json: [] }]], rec);
  await getAllPages(mk(f), '/p?state=open');
  assert.equal(rec.calls[0].path, '/p?state=open&per_page=100&page=1');
});

// ── 超时 ───────────────────────────────────────────────────────────────────

test('🔴 超时抛出的错带 timedOut=true —— 写路径靠它决定"先查再说"', async () => {
  const c = createClient({
    token: TOKEN,
    fetchImpl: (u, init) => new Promise((_, rej) => {
      init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    userAgent: 'x',
    timeoutMs: 5,
  });
  await assert.rejects(
    () => c.post('/repos/x/y/forks', {}),
    (e) => e.timedOut === true && e.exitCode === 6 && /可能已经生效/.test(e.message),
  );
});
