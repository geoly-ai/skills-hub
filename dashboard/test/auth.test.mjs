import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COOKIE_NAME, SESSION_MS, createLimiter, issueTicket, secretMatches, verifyTicket,
} from '../lib/auth.mjs';

const SECRET = 'a-long-random-shared-secret-for-tests-0123456789';

test('签出来的票能自己验过', async () => {
  const t = await issueTicket(SECRET);
  assert.equal(await verifyTicket(SECRET, t), true);
});

test('🔴 换一把口令就验不过 —— 票是签的，不是猜的', async () => {
  const t = await issueTicket(SECRET);
  assert.equal(await verifyTicket(`${SECRET}x`, t), false);
});

test('票会过期', async () => {
  const now = Date.now();
  const t = await issueTicket(SECRET, now);
  assert.equal(await verifyTicket(SECRET, t, now + SESSION_MS - 1000), true);
  assert.equal(await verifyTicket(SECRET, t, now + SESSION_MS + 1000), false);
});

test('🔴 改过期时间戳会让签名对不上（不能靠改数字把票续期）', async () => {
  const t = await issueTicket(SECRET, Date.now() - SESSION_MS * 2);
  const forged = `${Date.now() + SESSION_MS}.${t.split('.')[1]}`;
  assert.equal(await verifyTicket(SECRET, forged), false);
});

test('畸形票一律拒，不抛异常', async () => {
  for (const bad of ['', '.', 'abc', 'abc.def', '123.zz', '123.', '.abc', null, undefined, 123, {}, '1e9.aa']) {
    assert.equal(await verifyTicket(SECRET, bad), false, `${String(bad)} 应该被拒`);
  }
});

test('🔴 票面里没有口令本身 —— 偷到 cookie 偷不到口令', async () => {
  const t = await issueTicket(SECRET);
  assert.ok(!t.includes(SECRET));
});

test('口令比较：只有完全相等才过，前缀 / 大小写 / 空串都不行', async () => {
  assert.equal(await secretMatches(SECRET, SECRET), true);
  assert.equal(await secretMatches(SECRET, SECRET.slice(0, -1)), false);
  assert.equal(await secretMatches(SECRET, `${SECRET} `), false);
  assert.equal(await secretMatches(SECRET, SECRET.toUpperCase()), false);
  assert.equal(await secretMatches(SECRET, ''), false);
  assert.equal(await secretMatches(SECRET, null), false);
});

test('🔴 cookie 名带 __Host- 前缀（浏览器据此强制 Secure + Path=/ + 无 Domain）', () => {
  assert.ok(COOKIE_NAME.startsWith('__Host-'), '少了 __Host- 前缀，同父域的站点能把伪造 cookie 盖过来');
});

test('登录限速：桶空了要拒，随时间回填', () => {
  let now = 0;
  const take = createLimiter({ capacity: 3, refillPerSec: 1, now: () => now });
  assert.equal(take(), true);
  assert.equal(take(), true);
  assert.equal(take(), true);
  assert.equal(take(), false);
  now = 1000;
  assert.equal(take(), true);
});
