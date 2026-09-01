// timestamp 的**单资产信封** —— 02-registry.md §3，以及 2026-08-31 的决策 ③
// （R-17 剩下那一半的闭合方式）。
//
// ── 🔴 它闭的是什么 ────────────────────────────────────────────────────────
// 原来 timestamp 是**两个** release 资产：`timestamp.json` 与
// `timestamp.json.sigstore.json`。`gh release upload --clobber` 是**逐文件**的，
// 所以两者之间必然有一个新旧混搭的窗口：
//   · 先传 bundle → 中间态是「旧正文 + 新 bundle」；
//   · 先传正文   → 中间态是「新正文 + 旧 bundle」。
// **两种都验不过**，而客户端看到的是「验签失败」—— 一个看起来像被攻击的错误。
//
// 合成一个资产之后，那个窗口在**构造上**不存在了：一次替换只动一个文件。
// ⚠️ 单资产替换本身也不是原子的（`--clobber` 是删了再传），但它的中间态是
// **资产不存在** → 客户端拿到 404 → 干净地重试或报「取不到」。
// 🔴 **这才是真正的收益**：失败形态从「验签失败（像被攻击）」变成
//    「取不到（像网络问题）」。前者会让人去查一个不存在的攻击。
//
// ── 🔴 为什么 payload 是 base64，而不是把 JSON 对象直接嵌进来 ───────────────
// 签名签的是**确切的字节**。把内层文档作为 JSON 对象嵌进外层，取出来时要重新
// 序列化 —— 而重新序列化不保证还原原字节（键序、转义、空白都可能变）。
// base64 原样保存那串字节，这是它存在的唯一理由。

import { parseStrict } from './canonical-json.mjs';
import { WireError } from './trust.mjs';

export const ENVELOPE_SCHEMA = 'geoly.skills.timestamp-envelope/1';

const ENVELOPE_KEYS = ['bundle', 'payload', 'schema'];

/**
 * 把「正文字节 + bundle」封成一个资产。
 * @param {Buffer} payloadBytes  `timestamp.json` 的 canonical 字节（被签的那一份）
 * @param {object} bundle        Sigstore bundle（已解析的对象）
 * @returns {Buffer}
 */
export function wrapTimestamp(payloadBytes, bundle) {
  if (!Buffer.isBuffer(payloadBytes) || payloadBytes.length === 0) {
    throw new WireError('E_ENVELOPE_SHAPE', 'wrapTimestamp 的 payloadBytes 必须是非空 Buffer');
  }
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new WireError('E_ENVELOPE_SHAPE', 'wrapTimestamp 的 bundle 必须是对象');
  }
  // 🔴 外层**不走 canonical-json 的 stringify**：那会把 bundle 里的键重排。
  //    外层不参与签名，所以它的字节形态无所谓；重要的是 payload 原样保留。
  //    （内层的 canonical 由 build-timestamp 保证。）
  return Buffer.from(`${JSON.stringify({
    schema: ENVELOPE_SCHEMA,
    payload: payloadBytes.toString('base64'),
    bundle,
  })}\n`, 'utf8');
}

/**
 * 拆开信封。**在验签之前**调用 —— 它只做形状检查，不做任何信任判断。
 *
 * 🔴 拆出来的 `bytes` 必须是**原字节**，调用方拿它去验签。
 *    任何「顺手规范化一下」都会让签名验不过（那是好事：说明有人动过），
 *    但更常见的是让**正常**的东西验不过。所以这里一个字节都不动。
 *
 * @param {Buffer} envelopeBytes
 * @returns {{bytes:Buffer, bundle:object}}
 */
export function unwrapTimestamp(envelopeBytes) {
  let doc;
  try {
    doc = parseStrict(envelopeBytes.toString('utf8'));
  } catch (e) {
    throw new WireError('E_ENVELOPE_PARSE', `timestamp 信封读不出来：${e.message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new WireError('E_ENVELOPE_SHAPE', 'timestamp 信封必须是对象');
  }
  const keys = Object.keys(doc).sort();
  if (keys.join(',') !== ENVELOPE_KEYS.join(',')) {
    throw new WireError('E_ENVELOPE_SHAPE',
      `timestamp 信封的键集必须正好是 {${ENVELOPE_KEYS.join(', ')}}，得到 {${keys.join(', ')}}`);
  }
  if (doc.schema !== ENVELOPE_SCHEMA) {
    throw new WireError('E_SCHEMA',
      `timestamp 信封的 schema 必须是 ${ENVELOPE_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
  }
  if (typeof doc.payload !== 'string' || doc.payload === '') {
    throw new WireError('E_ENVELOPE_SHAPE', 'timestamp 信封的 payload 必须是非空字符串');
  }
  if (doc.bundle === null || typeof doc.bundle !== 'object' || Array.isArray(doc.bundle)) {
    throw new WireError('E_ENVELOPE_SHAPE', 'timestamp 信封的 bundle 必须是对象');
  }
  // 🔴 **严格 base64**：Node 的 `Buffer.from(s, 'base64')` 会**静默跳过**
  //    非法字符。一串垃圾能解出一个短 Buffer，然后在「验签失败」那里才报错 ——
  //    错误指向了错的地方。这里先判形状，让它在正确的位置失败。
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(doc.payload)) {
    throw new WireError('E_ENVELOPE_SHAPE', 'timestamp 信封的 payload 不是合法 base64');
  }
  const bytes = Buffer.from(doc.payload, 'base64');
  if (bytes.length === 0) {
    throw new WireError('E_ENVELOPE_SHAPE', 'timestamp 信封的 payload 解出来是空的');
  }
  // 往返一致：确认解码没有丢字节（padding 写错时会）
  if (bytes.toString('base64').replace(/=+$/, '') !== doc.payload.replace(/=+$/, '')) {
    throw new WireError('E_ENVELOPE_SHAPE', 'timestamp 信封的 payload base64 往返不一致');
  }
  return { bytes, bundle: doc.bundle };
}
