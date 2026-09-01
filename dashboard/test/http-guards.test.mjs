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
