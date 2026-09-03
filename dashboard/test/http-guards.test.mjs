import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeNext, sameOrigin } from '../lib/http-guards.mjs';

const req = (url, headers = {}) => ({
  url,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

test('safeNext：只放行站内相对路径', () => {
  assert.equal(safeNext('/artifacts'), '/artifacts');
  assert.equal(safeNext('/'), '/');
  // 🔴 协议相对跳转：`//evil.com` 是合法的绝对跳转
  assert.equal(safeNext('//evil.com'), '/');
  assert.equal(safeNext('/\\evil.com'), '/');
  assert.equal(safeNext('https://evil.com'), '/');
  assert.equal(safeNext('javascript:alert(1)'), '/');
  assert.equal(safeNext(undefined), '/');
  assert.equal(safeNext(null), '/');
  assert.equal(safeNext(42), '/');
});

test('sameOrigin：没有 Origin 头（老浏览器 / 普通 form POST）放行', () => {
  assert.equal(sameOrigin(req('https://dash.example/api/login')), true);
});

test('sameOrigin：同源放行，跨站拒', () => {
  assert.equal(sameOrigin(req('https://dash.example/api/login', { origin: 'https://dash.example' })), true);
  assert.equal(sameOrigin(req('https://dash.example/api/login', { origin: 'https://evil.example' })), false);
});

test('🔴 只比 host 会把同主机的 http 当成同源 —— 必须比完整 origin', () => {
  assert.equal(
    sameOrigin(req('https://dash.example/api/login', { origin: 'http://dash.example' })),
    false,
    '一个能在 http 上落地页面的攻击者就能对 https 这一站发登录 CSRF',
  );
});

test('Vercel 上运行时看到的是内部 http，要用 x-forwarded-proto 还原对外协议', () => {
  assert.equal(sameOrigin(req('http://dash.example/api/login', {
    origin: 'https://dash.example', 'x-forwarded-proto': 'https',
  })), true);
  // 多级代理会给逗号分隔的一串，取第一个
  assert.equal(sameOrigin(req('http://dash.example/api/login', {
    origin: 'https://dash.example', 'x-forwarded-proto': 'https, http',
  })), true);
});

test('sec-fetch-site 说是跨站就直接拒，不看 Origin', () => {
  assert.equal(sameOrigin(req('https://dash.example/api/login', {
    'sec-fetch-site': 'cross-site', origin: 'https://dash.example',
  })), false);
  assert.equal(sameOrigin(req('https://dash.example/api/login', { 'sec-fetch-site': 'same-origin' })), true);
  // `none` = 用户直接敲地址栏/书签，不是跨站
  assert.equal(sameOrigin(req('https://dash.example/api/login', { 'sec-fetch-site': 'none' })), true);
});

test('畸形 Origin 一律拒，不抛异常', () => {
  assert.equal(sameOrigin(req('https://dash.example/api/login', { origin: 'not a url' })), false);
});

// ── `same-site` 必须放行 —— 这是一次真实的误伤 ────────────────────────────
//
// 🔴 2026-09-03 线上实测：用户从别处点链接进来、或从 Vercel SSO 跳回来时，
//    浏览器发的 `sec-fetch-site` 是 **`same-site`**（不是 `same-origin`），
//    于是登录直接 403 `bad-origin`。**而报错完全指不到真正的原因** ——
//    用户会以为是口令错了，反复重试。
//
// ⚠️ 拒掉 `same-site` 并没有换来任何安全：真正的判据是 origin 的**精确比对**
//    （见下一条），而 `__Host-` cookie 本来就只在完全同源下才会被发送。
//    ⚠️ **不要因为「看起来更严」而把它收紧回去。**
test('🔴 sec-fetch-site: same-site 放行（从别处点进来 / SSO 跳回来）', () => {
  const req = {
    url: 'https://d.example/api/login',
    headers: new Map([
      ['sec-fetch-site', 'same-site'],
      ['origin', 'https://d.example'],
      ['x-forwarded-proto', 'https'],
    ]),
  };
  req.headers.get = (k) => (new Map([
    ['sec-fetch-site', 'same-site'], ['origin', 'https://d.example'], ['x-forwarded-proto', 'https'],
  ])).get(k) ?? null;
  assert.equal(sameOrigin(req), true);
});

test('🔴 cross-site 仍然拒（login CSRF 就是这个形状）', () => {
  const h = new Map([
    ['sec-fetch-site', 'cross-site'], ['origin', 'https://evil.example'], ['x-forwarded-proto', 'https'],
  ]);
  const req = { url: 'https://d.example/api/login', headers: { get: (k) => h.get(k) ?? null } };
  assert.equal(sameOrigin(req), false);
});

// 🔴 **信 `Sec-Fetch-Site` 是有依据的，不是图省事。**
//
// 它是**禁止的请求头**（forbidden header name）——页面里的 JS **改不了**它，
// 只有浏览器能设。所以「浏览器说这次是 cross-site」是可信的。
// ⚠️ 非浏览器客户端（curl 等）当然能随便设，但那时 CSRF 本来就不成立：
//    攻击者**没有受害者的 cookie**。CSRF 防的是「借用户的浏览器发请求」。
//
// ⚠️ 我一度写过一条相反的断言（「即便 sec-fetch-site 说同源，origin 对不上也要拒」），
//    理由是「那个头是客户端发的」。**那个理由是错的** ——
//    它混淆了「客户端可控」与「浏览器可控」。两个立场只能选一个，这里选前者。
test('🔴 sec-fetch-site 存在时以它为准（它是浏览器设的，页面 JS 改不了）', () => {
  const h = new Map([
    ['sec-fetch-site', 'same-origin'],
    ['origin', 'null'],                 // ← 被 referrer-policy: no-referrer 抹成 null
    ['x-forwarded-proto', 'https'],
  ]);
  const req = { url: 'https://d.example/api/login', headers: { get: (k) => h.get(k) ?? null } };
  assert.equal(sameOrigin(req), true, 'Origin 被策略抹成 null 时，同源提交必须仍能通过');
});

// 🔴 这是本次线上故障的**精确形状**，钉住它。
//    `referrer-policy: no-referrer`（本站每个响应都设，为隐私）会让规范把
//    `Origin` 序列化成字面 `"null"`。⚠️ curl 复现不出来 —— curl 不遵守引荐来源策略，
//    所以四种 header 组合全通过，而真实浏览器仍然被拒。
test('🔴 Origin: null（no-referrer 造成）+ 无 sec-fetch-site → 放行', () => {
  const h = new Map([['origin', 'null'], ['x-forwarded-proto', 'https']]);
  const req = { url: 'https://d.example/api/login', headers: { get: (k) => h.get(k) ?? null } };
  assert.equal(sameOrigin(req), true);
});
