// timestamp 的单资产信封 —— 决策 ③（R-17 剩下那一半）。
//
// 🔴 这一份钉的是：拆出来的必须是**原字节**。任何「顺手规范化一下」都会让
//    正常的东西验不过 —— 而那个失败看起来像被攻击。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wrapTimestamp, unwrapTimestamp, ENVELOPE_SCHEMA } from '../src/timestamp-envelope.mjs';

const BUNDLE = { mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3', x: 1 };
const PAYLOAD = Buffer.from('{"schema":"geoly.skills.timestamp/1","version":7}\n', 'utf8');

const expectV = (violation, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.violation, violation, `实际 ${e.violation}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${violation}，但没有抛错`);
};

test('往返：拆出来的是**原字节**，一个字节都没动', () => {
  const { bytes, bundle } = unwrapTimestamp(wrapTimestamp(PAYLOAD, BUNDLE));
  assert.ok(bytes.equals(PAYLOAD), '重新序列化会让签名验不过');
  assert.deepEqual({ ...bundle }, BUNDLE);
});

test('🔴 payload 里的字节形态原样保留（键序、空白、转义都不动）', () => {
  // 这是 base64 存在的唯一理由：签名签的是确切的字节
  const weird = Buffer.from('{"b":1,\n  "a":  2}   \n\n', 'utf8');
  const { bytes } = unwrapTimestamp(wrapTimestamp(weird, BUNDLE));
  assert.equal(bytes.toString('utf8'), weird.toString('utf8'));
});

test('非 ASCII 也原样保留', () => {
  const cn = Buffer.from('{"reason":"安全问题 🔴"}\n', 'utf8');
  assert.ok(unwrapTimestamp(wrapTimestamp(cn, BUNDLE)).bytes.equals(cn));
});

// ── 形状 ───────────────────────────────────────────────────────────────────

test('键集是精确的 —— 多一个少一个都拒', () => {
  const ok = JSON.parse(wrapTimestamp(PAYLOAD, BUNDLE).toString('utf8'));
  expectV('E_ENVELOPE_SHAPE', () => unwrapTimestamp(Buffer.from(JSON.stringify({ ...ok, 随手加的: 1 }))));
  const { bundle, ...noBundle } = ok;
  expectV('E_ENVELOPE_SHAPE', () => unwrapTimestamp(Buffer.from(JSON.stringify(noBundle))));
});

test('schema 不对就拒', () => {
  expectV('E_SCHEMA', () => unwrapTimestamp(Buffer.from(JSON.stringify({
    schema: 'geoly.skills.timestamp-envelope/2', payload: 'eA==', bundle: BUNDLE,
  }))));
});

test('🔴 非法 base64 在**这里**报，不是拖到验签才报', () => {
  // Node 的 Buffer.from(s,'base64') 会静默跳过非法字符 —— 一串垃圾能解出一个
  // 短 Buffer，然后在「验签失败」那里才炸，错误指向了错的地方
  for (const payload of ['不是 base64', 'a b c', '@@@@', '===']) {
    expectV('E_ENVELOPE_SHAPE', () => unwrapTimestamp(Buffer.from(JSON.stringify({
      schema: ENVELOPE_SCHEMA, payload, bundle: BUNDLE,
    }))));
  }
});

test('payload / bundle 的类型要对', () => {
  for (const doc of [
    { schema: ENVELOPE_SCHEMA, payload: '', bundle: BUNDLE },
    { schema: ENVELOPE_SCHEMA, payload: 123, bundle: BUNDLE },
    { schema: ENVELOPE_SCHEMA, payload: 'eA==', bundle: 'x' },
    { schema: ENVELOPE_SCHEMA, payload: 'eA==', bundle: [1] },
  ]) {
    expectV('E_ENVELOPE_SHAPE', () => unwrapTimestamp(Buffer.from(JSON.stringify(doc))));
  }
});

test('读不出来的信封报 E_ENVELOPE_PARSE（不是当成空的）', () => {
  expectV('E_ENVELOPE_PARSE', () => unwrapTimestamp(Buffer.from('不是 json')));
});

test('🔴 重复键会被 parseStrict 拒 —— 两个 payload 谁说了算是个真问题', () => {
  expectV('E_ENVELOPE_PARSE', () => unwrapTimestamp(Buffer.from(
    `{"schema":"${ENVELOPE_SCHEMA}","payload":"eA==","payload":"eQ==","bundle":{}}`)));
});

test('wrap 的入参也要检', () => {
  expectV('E_ENVELOPE_SHAPE', () => wrapTimestamp(Buffer.alloc(0), BUNDLE));
  expectV('E_ENVELOPE_SHAPE', () => wrapTimestamp('不是 Buffer', BUNDLE));
  expectV('E_ENVELOPE_SHAPE', () => wrapTimestamp(PAYLOAD, null));
});
