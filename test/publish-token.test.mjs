// `publish` 的 token 来源解析 —— 每一道闸各一条测试。
//
// 🔴 **断言一律钉在具体的那一件事上**，不写成「某个字符串在输出里出现过」：
//    本仓库已经栽过五次 —— 文件里有第二处出现时，改坏一处照样绿。
//    这里要么比精确值、要么数个数、要么断言"某个东西**不**出现"。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveToken, resolveEnvToken, resolveGhToken, collectEnvTokens,
  assertTokenShape, scrub, TOKEN_ENV_ORDER, TokenError,
} from '../src/publish/token.mjs';

const TOK_A = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOK_B = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

/** 🔴 会抛的 spawn 桩：任何**没预期到**的子进程调用当场炸。 */
const explodingSpawn = () => { throw new Error('测试没预期到会调子进程'); };

// ── 来源顺序 ────────────────────────────────────────────────────────────────

test('🔴 来源顺序恰好是 GEOLY_GITHUB_TOKEN → GH_TOKEN → GITHUB_TOKEN', () => {
  assert.deepEqual([...TOKEN_ENV_ORDER], ['GEOLY_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
});

test('值相同时按优先级取第一个，其余进 others（供披露列出来）', () => {
  const r = resolveEnvToken({ GH_TOKEN: TOK_A, GITHUB_TOKEN: TOK_A, GEOLY_GITHUB_TOKEN: TOK_A });
  assert.equal(r.token, TOK_A);
  assert.equal(r.source, 'env:GEOLY_GITHUB_TOKEN');
  assert.deepEqual(r.others, ['GH_TOKEN', 'GITHUB_TOKEN']);
});

test('只有一个变量时 others 为空', () => {
  const r = resolveEnvToken({ GITHUB_TOKEN: TOK_A });
  assert.equal(r.source, 'env:GITHUB_TOKEN');
  assert.deepEqual(r.others, []);
});

// ── 🔴 多来源冲突 ──────────────────────────────────────────────────────────

test('🔴 多个变量同时存在**且值不同** → 直接拒，不静默挑一个', () => {
  assert.throws(
    () => resolveEnvToken({ GH_TOKEN: TOK_A, GITHUB_TOKEN: TOK_B }),
    (e) => e instanceof TokenError && e.exitCode === 7,
  );
});

test('🔴 冲突的错误文案里**只有变量名** —— 不含任何一个 token 的值、前缀或长度', () => {
  let msg = '';
  try { resolveEnvToken({ GH_TOKEN: TOK_A, GITHUB_TOKEN: TOK_B }); } catch (e) { msg = e.message; }
  // 值：一个字符都不许出现
  assert.equal(msg.includes(TOK_A), false, 'token 原文进了错误文案');
  assert.equal(msg.includes(TOK_B), false, 'token 原文进了错误文案');
  // 前缀同样不许 —— `ghp_` / `github_pat_` 足以区分凭据类型
  assert.equal(/gh[pousr]_/.test(msg), false, 'token 前缀进了错误文案');
  // 长度也不许（36 / 40 这种数字会暴露是哪一类 token）
  assert.equal(msg.includes(String(TOK_A.length)), false, 'token 长度进了错误文案');
  // 但变量名必须在 —— 否则用户不知道该 unset 哪个
  assert.equal(msg.includes('GH_TOKEN'), true);
  assert.equal(msg.includes('GITHUB_TOKEN'), true);
});

test('🔴 GEOLY_GITHUB_TOKEN 优先级最高，但值不同时**仍然拒**（不是"它赢了"）', () => {
  assert.throws(
    () => resolveEnvToken({ GEOLY_GITHUB_TOKEN: TOK_A, GITHUB_TOKEN: TOK_B }),
    TokenError,
  );
});

test('空串 / 纯空白视为不存在，不触发无意义的冲突', () => {
  assert.deepEqual(collectEnvTokens({ GH_TOKEN: '', GITHUB_TOKEN: '   ' }).length, 0);
  const r = resolveEnvToken({ GH_TOKEN: '', GITHUB_TOKEN: TOK_A });
  assert.equal(r.source, 'env:GITHUB_TOKEN');
  assert.deepEqual(r.others, []);
});

// ── 形状门 ─────────────────────────────────────────────────────────────────

test('token 形状门：多行 / 带空白 / 太短 → 拒', () => {
  assert.throws(() => assertTokenShape(`${TOK_A}\n第二行`, 'x'), TokenError);
  assert.throws(() => assertTokenShape('ghp_ AAA', 'x'), TokenError);
  assert.throws(() => assertTokenShape('short', 'x'), TokenError);
  assert.throws(() => assertTokenShape('a'.repeat(513), 'x'), TokenError);
  assert.equal(assertTokenShape(TOK_A, 'x'), TOK_A);
});

test('🔴 形状门拒绝时，错误文案里不含被拒的那个值', () => {
  let msg = '';
  try { assertTokenShape('ghp_ SECRETSECRETSECRET', 'x'); } catch (e) { msg = e.message; }
  assert.equal(msg.includes('SECRETSECRETSECRET'), false);
});

// ── scrub ──────────────────────────────────────────────────────────────────

test('scrub 同时按原文与形态遮蔽；两条各自都要有效', () => {
  // ① 原文（老式 40 位 hex PAT 只能靠这一条）
  const old40 = 'a'.repeat(40);
  assert.equal(scrub(`x ${old40} y`, old40), 'x *** y');
  // ② 形态（响应体里回显的**别的** token —— 我们不知道它的原文）
  assert.equal(scrub(`x ${TOK_B} y`, TOK_A), 'x *** y');
  assert.equal(scrub(`x github_pat_${'C'.repeat(20)} y`), 'x *** y');
});

test('🔴 scrub 不把 commit sha 打成 ***（那是本命令要给用户看的关键事实）', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(scrub(`commit ${sha}`), `commit ${sha}`);
});

// ── gh 这一层 ──────────────────────────────────────────────────────────────

/** 记录 spawn 收到了什么。 */
function spyGh(result) {
  const calls = [];
  const fn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return result; };
  return { fn, calls };
}

test('🔴 gh 固定 --hostname github.com，且 shell:false', () => {
  const s = spyGh({ status: 0, stdout: `${TOK_A}\n`, stderr: '', signal: null });
  resolveGhToken({}, s.fn);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].cmd, 'gh');
  assert.deepEqual(s.calls[0].args, ['auth', 'token', '--hostname', 'github.com']);
  assert.equal(s.calls[0].opts.shell, false);
});

test('🔴 传给 gh 的环境里，token 类变量与 GH_HOST 全被清掉，GH_HOST 被钉成 github.com', () => {
  const s = spyGh({ status: 0, stdout: TOK_A, stderr: '', signal: null });
  resolveGhToken({
    GH_TOKEN: TOK_B, GITHUB_TOKEN: TOK_B, GH_ENTERPRISE_TOKEN: TOK_B,
    GITHUB_ENTERPRISE_TOKEN: TOK_B, GH_HOST: 'ghe.example.com', GH_REPO: 'x/y',
    PATH: '/usr/bin',
  }, s.fn);
  const env = s.calls[0].opts.env;
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_REPO']) {
    assert.equal(Object.hasOwn(env, k), false, `${k} 泄漏进了 gh 的子进程环境`);
  }
  assert.equal(env.GH_HOST, 'github.com');
  assert.equal(env.PATH, '/usr/bin', '无关的环境变量应当照常传下去');
});

test('🔴 token 绝不进子进程的 argv 或 env', () => {
  const s = spyGh({ status: 0, stdout: TOK_A, stderr: '', signal: null });
  resolveGhToken({ SOMETHING: 'x' }, s.fn);
  const { args, opts } = s.calls[0];
  assert.equal(args.some((a) => a.includes(TOK_A)), false);
  assert.equal(Object.values(opts.env).some((v) => String(v).includes(TOK_A)), false);
});

test('🔴 gh 的 stdout/stderr 一个字节都不进错误文案', () => {
  const leak = `SECRET_FROM_GH_${TOK_B}`;
  for (const r of [
    { status: 1, stdout: leak, stderr: leak, signal: null },
    { status: 0, stdout: '', stderr: leak, signal: null },
    { status: null, stdout: leak, stderr: leak, signal: 'SIGTERM' },
  ]) {
    let msg = '';
    try { resolveGhToken({}, () => r); } catch (e) { msg = e.message; }
    assert.notEqual(msg, '', '这三种情况都应当抛');
    assert.equal(msg.includes('SECRET_FROM_GH'), false, `gh 的输出泄漏进了错误：${msg}`);
    assert.equal(msg.includes(TOK_B), false, `gh 的输出泄漏进了错误：${msg}`);
  }
});

test('gh 没装（ENOENT）与 gh 没登录（非零 exit）给的是不同的文案', () => {
  let a = '';
  try { resolveGhToken({}, () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) })); } catch (e) { a = e.message; }
  let b = '';
  try { resolveGhToken({}, () => ({ status: 1, stdout: '', stderr: '', signal: null })); } catch (e) { b = e.message; }
  assert.notEqual(a, b);
  assert.match(a, /未安装|不在 PATH/);
});

test('🔴 gh 被信号中止（超时）时不当成成功，也不当成 exit 0', () => {
  assert.throws(
    () => resolveGhToken({}, () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' })),
    (e) => e instanceof TokenError && /SIGTERM/.test(e.message),
  );
});

test('gh 输出为空 → 拒，不返回空 token', () => {
  assert.throws(() => resolveGhToken({}, () => ({ status: 0, stdout: '  \n', stderr: '', signal: null })), TokenError);
});

// ── 整条链 ─────────────────────────────────────────────────────────────────

test('🔴 有环境变量时**根本不调** gh（spawn 桩是会抛的）', () => {
  const r = resolveToken({ env: { GITHUB_TOKEN: TOK_A }, spawnSync: explodingSpawn });
  assert.equal(r.source, 'env:GITHUB_TOKEN');
});

test('三个变量都没有才落到 gh', () => {
  const r = resolveToken({
    env: { PATH: '/usr/bin' },
    spawnSync: () => ({ status: 0, stdout: TOK_A, stderr: '', signal: null }),
  });
  assert.equal(r.source, 'gh');
  assert.equal(r.token, TOK_A);
});
