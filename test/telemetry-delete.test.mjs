// 删除通道的纯逻辑单测 —— 不碰数据库、不起 HTTP。
//
// 🔴 这一组钉的是「所有权证明真的成立」：签名不能跨协议重放、不能挪给别的公钥、
//    不能转发给别的端点（audience）、tag 不能被外人算出来、密钥缺失必须炸而不是静默降级、
//    挑战 nonce 伪造不了也过不了期。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';

import {
  DELETE_PROTOCOL, NONCE_TTL_SECONDS, RE_NONCE, RE_PUBKEY, RE_SIGNATURE,
  checkNonce, isCanonicalB64u, mintNonce, normalizeAudience, pubkeyTag, serverAudience,
  signedMessage, tagKeyId, tagMatches, taggingAvailable, verifyProof,
} from '../server/delete.mjs';

const SECRET = 'x'.repeat(32);
const AUD = 'https://t.example/v1/delete';
const NONCE = Buffer.alloc(32, 7).toString('base64url');

function freshKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pubkey: publicKey.export({ format: 'jwk' }).x, privateKey };
}
const proofFor = ({ pubkey, privateKey }, { nonce = NONCE, audience = AUD } = {}) =>
  edSign(null, signedMessage({ audience, pubkey, nonce }), privateKey).toString('base64url');

/** 同一串字节的**非规范**写法：43 字符 = 258 位，最后一个字符的低 2 位是填充。 */
function nonCanonical(b64u) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(b64u.at(-1));
  return b64u.slice(0, -1) + alphabet[last | 1];
}

test('三个定长量的形状：43 / 43 / 86', () => {
  const k = freshKey();
  assert.match(k.pubkey, RE_PUBKEY);
  assert.match(NONCE, RE_NONCE);
  assert.match(proofFor(k), RE_SIGNATURE);
});

test('正常的证明能通过', () => {
  const k = freshKey();
  assert.equal(verifyProof({ audience: AUD, pubkey: k.pubkey, nonce: NONCE, signature: proofFor(k) }), true);
});

// 🔴 签名把公钥包进了消息 —— 一个签名挪给另一把公钥必须失效。
test('🔴 签名不能挪给别的公钥用', () => {
  const a = freshKey(); const b = freshKey();
  assert.equal(verifyProof({ audience: AUD, pubkey: b.pubkey, nonce: NONCE, signature: proofFor(a) }), false);
});

test('🔴 换个 nonce 就失效（一次性的前提）', () => {
  const k = freshKey();
  const other = Buffer.alloc(32, 9).toString('base64url');
  assert.equal(verifyProof({ audience: AUD, pubkey: k.pubkey, nonce: other, signature: proofFor(k) }), false);
});

// 🔴 中继重放（Codex 2026-09-13 的 P0）：恶意端点拿受害者公钥去正式服务取挑战、
//    让 CLI 签、再转发回正式服务。签名里写死了 audience，转发出去就对不上。
test('🔴 签给别的端点的签名，正式端点不收（audience 进签名）', () => {
  const k = freshKey();
  const relayed = proofFor(k, { audience: 'https://evil.example/v1/delete' });
  assert.equal(verifyProof({ audience: AUD, pubkey: k.pubkey, nonce: NONCE, signature: relayed }), false);
});

// 🔴 域分离 + 长度前缀：裸签 nonce 的签名、以及 v1 那种不带 audience 的签名，都必须不通过。
test('🔴 被签的是「协议名 || u16 长度 || audience || 公钥 || nonce」', () => {
  const k = freshKey();
  const msg = signedMessage({ audience: AUD, pubkey: k.pubkey, nonce: NONCE });
  const aud = Buffer.from(AUD, 'utf8');
  assert.equal(msg.length, DELETE_PROTOCOL.length + 2 + aud.length + 32 + 32, '消息长度不是分段定长拼接');
  assert.equal(msg.subarray(0, DELETE_PROTOCOL.length).toString('utf8'), DELETE_PROTOCOL);
  assert.equal(msg.readUInt16BE(DELETE_PROTOCOL.length), aud.length, '长度前缀不对 —— 变长段会有拼接歧义');
  assert.match(DELETE_PROTOCOL, /\/2$/, '签名语义变了，协议版本必须跟着变');

  const naive = edSign(null, Buffer.from(NONCE, 'base64url'), k.privateKey).toString('base64url');
  assert.equal(verifyProof({ audience: AUD, pubkey: k.pubkey, nonce: NONCE, signature: naive }), false);
  const v1 = edSign(null, Buffer.concat([
    Buffer.from('geoly.skills.telemetry-delete/1', 'utf8'),
    Buffer.from(k.pubkey, 'base64url'), Buffer.from(NONCE, 'base64url'),
  ]), k.privateKey).toString('base64url');
  assert.equal(verifyProof({ audience: AUD, pubkey: k.pubkey, nonce: NONCE, signature: v1 }), false,
    'v1 签名在 v2 下还能用 —— 没绑 audience 的旧签名可以被中继');
});

test('🔴 畸形输入一律 false，不抛（输入完全由请求方控制，不该变成 500）', () => {
  const k = freshKey();
  const sig = proofFor(k);
  for (const bad of [
    { audience: AUD, pubkey: 'short', nonce: NONCE, signature: sig },
    { audience: AUD, pubkey: k.pubkey, nonce: 'short', signature: sig },
    { audience: AUD, pubkey: k.pubkey, nonce: NONCE, signature: 'short' },
    { audience: AUD, pubkey: k.pubkey, nonce: NONCE, signature: 'A'.repeat(86) },
    { audience: AUD, pubkey: null, nonce: NONCE, signature: sig },
    { audience: AUD, pubkey: `${'A'.repeat(42)}+`, nonce: NONCE, signature: sig },
    { audience: 'not a url', pubkey: k.pubkey, nonce: NONCE, signature: sig },
    { audience: undefined, pubkey: k.pubkey, nonce: NONCE, signature: sig },
  ]) {
    assert.equal(verifyProof(bad), false, `${JSON.stringify(bad).slice(0, 60)} 不该通过`);
  }
});

// 🔴 同一串字节有两种文本写法时，按文本算的 tag 会不同 —— 同一个人被算成两个。
test('🔴 非规范 base64url 一律拒：同一把公钥不许有第二种写法', () => {
  const k = freshKey();
  const alt = nonCanonical(k.pubkey);
  assert.notEqual(alt, k.pubkey);
  assert.deepEqual(Buffer.from(alt, 'base64url'), Buffer.from(k.pubkey, 'base64url'), '前提自查：解出同一串字节');
  assert.equal(isCanonicalB64u(k.pubkey, 32), true);
  assert.equal(isCanonicalB64u(alt, 32), false);
  assert.equal(verifyProof({ audience: AUD, pubkey: alt, nonce: NONCE, signature: proofFor(k) }), false);
  assert.throws(() => signedMessage({ audience: AUD, pubkey: alt, nonce: NONCE }), /pubkey/);
});

test('audience 只收规范形式：大小写、query、fragment、凭据、非 http(s) 都不算', () => {
  assert.equal(normalizeAudience(AUD), AUD);
  assert.equal(serverAudience(AUD), AUD);
  // 能被规范化成别的样子的，服务端不认 —— 两边比的是字符串
  assert.equal(serverAudience('https://T.example/v1/delete'), null);
  for (const bad of ['https://t.example/v1/delete?x=1', 'https://t.example/v1/delete#a',
    'https://u:p@t.example/v1/delete', 'ftp://t.example/v1/delete', '', undefined, 'nope']) {
    assert.equal(serverAudience(bad), null, `${bad} 不该被当成 audience`);
  }
  assert.throws(() => signedMessage({ audience: 'https://T.example/v1/delete', pubkey: freshKey().pubkey, nonce: NONCE }));
});

// ── tag 与密钥指纹 ──────────────────────────────────────────────────────────

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
test('🔴 外人拿到公钥也算不出 tag（这正是不用裸 sha256 的原因）', () => {
  const k = freshKey();
  assert.notEqual(pubkeyTag(k.pubkey, SECRET), createHash('sha256').update(k.pubkey).digest('hex'));
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

// 🔴 换了密钥，删除会回 deleted:true 却一行没删 —— 指纹就是用来发现「换过」的。
test('🔴 tag 密钥指纹：没密钥是 null、换密钥就变、不含密钥原文', () => {
  assert.equal(tagKeyId(undefined), null);
  assert.equal(tagKeyId('tooshort'), null);
  const id = tagKeyId(SECRET);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(id, tagKeyId(SECRET));
  assert.notEqual(id, tagKeyId('y'.repeat(32)));
  assert.ok(!id.includes('x'.repeat(4)), '指纹里有密钥原文');
  // 与 tag 用的是不同的域：指纹不能等于任何 tag 的前缀
  assert.notEqual(id, pubkeyTag(freshKey().pubkey, SECRET).slice(0, 32));
});

// ── 无状态挑战 ──────────────────────────────────────────────────────────────

test('挑战 nonce：签发的能验过，并带回过期时间', () => {
  const tag = pubkeyTag(freshKey().pubkey, SECRET);
  const now = 1_800_000_000_000;
  const n = mintNonce(tag, { nowMs: now, secret: SECRET });
  assert.match(n, RE_NONCE);
  assert.equal(isCanonicalB64u(n, 32), true);
  const r = checkNonce(n, tag, { nowMs: now + 1000, secret: SECRET });
  assert.equal(r.ok, true);
  assert.equal(r.expiresAtMs, Math.floor(now / 1000) * 1000 + NONCE_TTL_SECONDS * 1000);
});

test('🔴 挑战 nonce 只对签给的那个 tag、那把密钥有效', () => {
  const tag = pubkeyTag(freshKey().pubkey, SECRET);
  const other = pubkeyTag(freshKey().pubkey, SECRET);
  const n = mintNonce(tag, { secret: SECRET });
  assert.equal(checkNonce(n, other, { secret: SECRET }).ok, false, '挑战能挪给别的公钥用');
  assert.equal(checkNonce(n, tag, { secret: 'y'.repeat(32) }).ok, false, '换了密钥还能验过');
  assert.equal(checkNonce(n, tag, { secret: undefined }).ok, false);
});

test('🔴 挑战 nonce 过期就失效，卡在边界上也算过期', () => {
  const tag = pubkeyTag(freshKey().pubkey, SECRET);
  const now = 1_800_000_000_000;
  const n = mintNonce(tag, { nowMs: now, secret: SECRET });
  const exp = Math.floor(now / 1000) * 1000 + NONCE_TTL_SECONDS * 1000;
  assert.equal(checkNonce(n, tag, { nowMs: exp - 1, secret: SECRET }).ok, true);
  assert.equal(checkNonce(n, tag, { nowMs: exp, secret: SECRET }).ok, false, '边界上还算有效 —— 宁紧勿松');
  assert.equal(checkNonce(n, tag, { nowMs: exp + 1, secret: SECRET }).ok, false);
});

test('🔴 挑战 nonce 伪造不了：改任何一个字节、或把过期时间往后拨，都验不过', () => {
  const tag = pubkeyTag(freshKey().pubkey, SECRET);
  const now = 1_800_000_000_000;
  const buf = Buffer.from(mintNonce(tag, { nowMs: now, secret: SECRET }), 'base64url');
  for (let i = 0; i < 32; i++) {
    const t = Buffer.from(buf);
    t[i] ^= 1;
    assert.equal(checkNonce(t.toString('base64url'), tag, { nowMs: now, secret: SECRET }).ok, false, `第 ${i} 字节被改了还能验过`);
  }
  // 非规范写法同样拒
  const n = buf.toString('base64url');
  assert.equal(checkNonce(nonCanonical(n), tag, { nowMs: now, secret: SECRET }).ok, false);
  // 用正确密钥签一个「未来很远」的 —— 签发时最多 now + TTL，超出说明时钟或密钥有问题
  const far = mintNonce(tag, { nowMs: now + 3600_000, secret: SECRET });
  assert.equal(checkNonce(far, tag, { nowMs: now, secret: SECRET }).ok, false);
});

test('checkNonce 对畸形输入一律 {ok:false}，不抛', () => {
  const tag = pubkeyTag(freshKey().pubkey, SECRET);
  for (const bad of [null, 1, '', 'short', 'A'.repeat(44), '!'.repeat(43)]) {
    assert.deepEqual(checkNonce(bad, tag, { secret: SECRET }), { ok: false });
  }
});
