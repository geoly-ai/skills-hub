// 删除通道的纯逻辑单测 —— 不碰数据库。
//
// 🔴 这一组钉的是「所有权证明真的成立」：签名不能跨协议重放、不能挪给别的公钥、
//    tag 不能被外人算出来、密钥缺失必须炸而不是静默降级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';

import {
  DELETE_PROTOCOL, RE_NONCE, RE_PUBKEY, RE_SIGNATURE,
  pubkeyTag, signedMessage, tagMatches, taggingAvailable, verifyProof,
} from '../server/delete.mjs';

const SECRET = 'x'.repeat(32);
const NONCE = Buffer.alloc(32, 7).toString('base64url');

function freshKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pubkey: publicKey.export({ format: 'jwk' }).x, privateKey };
}
const proofFor = ({ pubkey, privateKey }, nonce = NONCE) =>
  edSign(null, signedMessage({ pubkey, nonce }), privateKey).toString('base64url');

test('三个定长量的形状：43 / 43 / 86', () => {
  const k = freshKey();
  assert.match(k.pubkey, RE_PUBKEY);
  assert.match(NONCE, RE_NONCE);
  assert.match(proofFor(k), RE_SIGNATURE);
});

test('正常的证明能通过', () => {
  const k = freshKey();
  assert.equal(verifyProof({ pubkey: k.pubkey, nonce: NONCE, signature: proofFor(k) }), true);
});

// 🔴 签名把公钥包进了消息 —— 一个签名挪给另一把公钥必须失效。
test('🔴 签名不能挪给别的公钥用', () => {
  const a = freshKey(); const b = freshKey();
  const sig = proofFor(a);
  assert.equal(verifyProof({ pubkey: b.pubkey, nonce: NONCE, signature: sig }), false);
});

test('🔴 换个 nonce 就失效（一次性的前提）', () => {
  const k = freshKey();
  const other = Buffer.alloc(32, 9).toString('base64url');
  assert.equal(verifyProof({ pubkey: k.pubkey, nonce: other, signature: proofFor(k) }), false);
});

// 🔴 域分离：裸签 nonce 的话，同一个签名在任何也用 Ed25519 的协议里都可能被复用。
test('🔴 被签的不是 nonce 原文，而是「协议名 || 公钥 || nonce」', () => {
  const k = freshKey();
  const msg = signedMessage({ pubkey: k.pubkey, nonce: NONCE });
  assert.equal(msg.length, DELETE_PROTOCOL.length + 32 + 32, '消息长度不是三段定长拼接');
  assert.equal(msg.subarray(0, DELETE_PROTOCOL.length).toString('utf8'), DELETE_PROTOCOL);
  // 拿「只签 nonce 原文」的签名来验，必须不通过
  const naive = edSign(null, Buffer.from(NONCE, 'base64url'), k.privateKey).toString('base64url');
  assert.equal(verifyProof({ pubkey: k.pubkey, nonce: NONCE, signature: naive }), false);
});

test('🔴 畸形输入一律 false，不抛（输入完全由请求方控制，不该变成 500）', () => {
  const k = freshKey();
  const sig = proofFor(k);
  for (const bad of [
    { pubkey: 'short', nonce: NONCE, signature: sig },
    { pubkey: k.pubkey, nonce: 'short', signature: sig },
    { pubkey: k.pubkey, nonce: NONCE, signature: 'short' },
    { pubkey: k.pubkey, nonce: NONCE, signature: 'A'.repeat(86) },
    { pubkey: null, nonce: NONCE, signature: sig },
    { pubkey: `${'A'.repeat(42)}+`, nonce: NONCE, signature: sig },
  ]) {
    assert.equal(verifyProof(bad), false, `${JSON.stringify(bad).slice(0, 60)} 不该通过`);
  }
});

// ── tag ─────────────────────────────────────────────────────────────────────

test('🔴 缺密钥就抛 —— 不许静默降级成裸哈希', () => {
  const k = freshKey();
  assert.throws(() => pubkeyTag(k.pubkey, undefined), /TAG_SECRET/);
  assert.throws(() => pubkeyTag(k.pubkey, 'tooshort'), /TAG_SECRET/);
  assert.equal(taggingAvailable(undefined), false);
  assert.equal(taggingAvailable('tooshort'), false);
  assert.equal(taggingAvailable(SECRET), true);
});

test('tag 稳定、定长、且换密钥就变', () => {
  const k = freshKey();
  const t1 = pubkeyTag(k.pubkey, SECRET);
  assert.equal(t1, pubkeyTag(k.pubkey, SECRET), '同输入必须同输出');
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.notEqual(t1, pubkeyTag(k.pubkey, 'y'.repeat(32)), '换密钥应当换 tag');
});

// 🔴 裸 sha256 的问题：谁拿到公钥都能自己算出 tag。带密钥之后算不出来。
test('🔴 外人拿到公钥也算不出 tag（这正是不用裸 sha256 的原因）', async () => {
  const { createHash } = await import('node:crypto');
  const k = freshKey();
  const naive = createHash('sha256').update(k.pubkey).digest('hex');
  assert.notEqual(pubkeyTag(k.pubkey, SECRET), naive);
});

test('不同公钥的 tag 不同', () => {
  assert.notEqual(pubkeyTag(freshKey().pubkey, SECRET), pubkeyTag(freshKey().pubkey, SECRET));
});

test('tagMatches 是常数时间比较，且长度不同直接 false', () => {
  const t = pubkeyTag(freshKey().pubkey, SECRET);
  assert.equal(tagMatches(t, t), true);
  assert.equal(tagMatches(t, `${t}0`), false);
  assert.equal(tagMatches(t, null), false);
  assert.equal(tagMatches(t, t.replace(/.$/, (c) => (c === '0' ? '1' : '0'))), false);
});
