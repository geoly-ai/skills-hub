import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify, parseStrict, encodeString } from '../src/canonical-json.mjs';

test('schema 置首，其余按字节序', () => {
  const s = stringify({ zeta: 1, alpha: 2, schema: 'x/1' });
  assert.equal(s, '{\n  "schema": "x/1",\n  "alpha": 2,\n  "zeta": 1\n}\n');
});

test('结尾恰好一个换行', () => {
  assert.ok(stringify({ a: 1 }).endsWith('}\n'));
  assert.ok(!stringify({ a: 1 }).endsWith('\n\n'));
});

test('数组每元素一行；空数组/空对象紧凑', () => {
  assert.equal(stringify({ a: [1, 2] }), '{\n  "a": [\n    1,\n    2\n  ]\n}\n');
  assert.equal(stringify({ a: [], b: {} }), '{\n  "a": [],\n  "b": {}\n}\n');
});

test('非 ASCII 转义为小写 hex', () => {
  assert.equal(encodeString('中'), '"\\u4e2d"');
});

test('BMP 外字符写成代理对', () => {
  assert.equal(encodeString('😀'), '"\\ud83d\\ude00"');
});

test('未配对代理 → 抛错', () => {
  assert.throws(() => encodeString('\ud83d'), /未配对/);
  assert.throws(() => encodeString('\ude00'), /未配对/);
});

test('负数与浮点被拒', () => {
  assert.throws(() => stringify({ a: -1 }), /非负整数/);
  assert.throws(() => stringify({ a: 1.5 }), /非负整数/);
});

test('确定性：同一输入两次字节相同', () => {
  const v = { schema: 's/1', b: [1, { z: 1, a: 2 }], a: '中文' };
  assert.equal(stringify(v), stringify(v));
});

test('parseStrict 拒绝重复 key', () => {
  assert.throws(() => parseStrict('{"a":1,"a":2}'), /重复 key/);
  assert.doesNotThrow(() => parseStrict('{"a":1,"b":{"a":2}}'));
});

test('重复 key 检测不被字符串里的引号骗到', () => {
  assert.doesNotThrow(() => parseStrict('{"a":"x\\":1,\\"a","b":2}'));
});
