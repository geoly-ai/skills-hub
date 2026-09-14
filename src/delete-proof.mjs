// 删除通道的签名协议 —— **客户端与服务端共用的唯一定义**。
//
// 🔴 放在 src/ 而不是 server/：客户端要照着它签，服务端要照着它验。
//    两边各写一份，迟早一边改了另一边没改 —— 结果不是报错，是「所有删除请求
//    都验不过」或者更糟的「验得过一个不该验过的形状」。与 assertValidEvent 只有一份
//    是同一条纪律。server/delete.mjs 从这里 re-export。
//
// 🔴 **零依赖**：只用 node:buffer。服务端的路由模块会 import 它，而仓库根的测试
//    只装根依赖（server/delete.mjs 文件头那段教训）。

/**
 * 协议版本。**改了它就是换了一套签名语义**，旧签名一律失效 —— 这正是要的。
 * v1 → v2（2026-09-13）：把服务端的 audience 纳入签名（Codex 指出的中继重放，见 signedMessage）。
 */
export const DELETE_PROTOCOL = 'geoly.skills.telemetry-delete/2';

// 三个定长量。**定长不是「不超过」**：可变长度会让塞了别的东西的值混进来。
export const RE_PUBKEY = /^[A-Za-z0-9_-]{43}$/;      // 32 字节 Ed25519 公钥
export const RE_NONCE = /^[A-Za-z0-9_-]{43}$/;       // 32 字节
export const RE_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;   // 64 字节签名

/** audience 的长度上界 —— 它进签名消息，长度前缀是两个字节。 */
export const MAX_AUDIENCE_BYTES = 2048;

/**
 * 是不是**规范**的 base64url，且恰好解出 `bytes` 个字节。
 *
 * 🔴 光过正则不够：43 个字符解出 32 字节时，最后一个字符的低 4 位是填充位，
 *    `…A` 与 `…B` 可能解出同一串字节。同一把公钥有多个文本表示，
 *    tag（按文本算 HMAC）就会不同 —— 同一个人被算成两个，删一个漏一个。
 *    判据：解码再编码，必须逐字相等（Codex 2026-09-13）。
 */
export function isCanonicalB64u(s, bytes) {
  if (typeof s !== 'string') return false;
  const buf = Buffer.from(s, 'base64url');
  return buf.length === bytes && buf.toString('base64url') === s;
}

/**
 * 规范化 audience：它是**删除端点的完整 URL**，客户端与服务端各自独立算出，逐字比对。
 *
 * 只收 http/https、不许带凭据、query 与 fragment —— 这三样都能让「同一个端点」
 * 有多种写法，而 audience 比的是字符串。
 * @returns {string|null} 不合法返回 null
 */
export function normalizeAudience(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  const s = u.toString();
  return Buffer.byteLength(s, 'utf8') <= MAX_AUDIENCE_BYTES ? s : null;
}

/**
 * 被签名的消息：`协议名 || u16be(len(audience)) || audience || 公钥32 || nonce32`。
 *
 * 🔴 **不是「签 nonce 原文」。** 裸签一个随机串意味着这个签名在**任何**
 *    也用 Ed25519 的协议里都可能被复用（跨协议重放）。所以：
 *      · 协议名做**域分离** —— 换了协议就是另一段消息
 *      · 把公钥包进消息 —— 签名与「谁在签」绑死，不能挪给别的公钥用
 * 🔴 **audience 必须进签名**（v2，Codex 2026-09-13 的 P0）：客户端允许自定义端点，
 *    一个恶意端点可以拿受害者的公钥去正式服务取 nonce、原样转给 CLI 签、
 *    再把签名转发回正式服务 —— 禁止重定向挡不住这种代理式中继。
 *    签名里写死「我签给的是哪个端点」，转发出去就对不上。
 * 🔴 audience 是唯一的变长段，所以带**长度前缀**：没有前缀的拼接存在歧义
 *    （audience 末尾挪几个字节给公钥，拼出来一样）。
 */
export function signedMessage({ audience, pubkey, nonce }) {
  const aud = normalizeAudience(audience);
  if (aud === null || aud !== audience) throw new Error('delete: audience 不是规范形式');
  if (!RE_PUBKEY.test(pubkey) || !isCanonicalB64u(pubkey, 32)) throw new Error('delete: pubkey 形状不合法');
  if (!RE_NONCE.test(nonce) || !isCanonicalB64u(nonce, 32)) throw new Error('delete: nonce 形状不合法');
  const audBytes = Buffer.from(aud, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(audBytes.length);
  return Buffer.concat([
    Buffer.from(DELETE_PROTOCOL, 'utf8'), len, audBytes,
    Buffer.from(pubkey, 'base64url'), Buffer.from(nonce, 'base64url'),
  ]);
}

/** 请求与响应信封的 schema。两边共用，理由同上。 */
export const CHALLENGE_SCHEMA = 'geoly.skills.telemetry-delete-challenge/1';
export const DELETE_SCHEMA = 'geoly.skills.telemetry-delete/1';
