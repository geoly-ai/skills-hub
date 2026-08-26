import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

let n = 0;
function iso() {
  const d = mkdtempSync(join(tmpdir(), 'tm-'));
  process.env.GEOLY_STATE_DIR = d;
  delete process.env.GEOLY_TELEMETRY;
  delete process.env.GEOLY_CLI_VERSION;
  return d;
}
const fresh = () => import('../src/telemetry.mjs?t' + ++n);

// ── 构造面 ───────────────────────────────────────────────────────────────────

test('白名单：未知字段进不去', async () => {
  iso();
  const { buildEvent } = await fresh();
  const ev = buildEvent({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0', secret: 'nope' });
  assert.equal(ev.secret, undefined);
  assert.equal(ev.artifact, 'skill:geoly/a@1.0.0');
});

test('kind / result 受枚举约束', async () => {
  iso();
  const { buildEvent } = await fresh();
  assert.throws(() => buildEvent({ kind: 'nope', result: 'ok' }), /kind/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'maybe' }), /result/);
});

// ── 隐私契约：值必须受控，不只是「不含路径」 ────────────────────────────────

test('🔴 值不是字符串就拒绝 —— 对象/数组不能借值的类型溜过校验', async () => {
  iso();
  const { buildEvent } = await fresh();
  // 这是最早那版「只扫字符串」的漏洞：client 是对象时扫描直接 continue，整个漏出去
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', client: { path: '/Users/a' } }), /对象|不合规/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', reason: ['/Users/a'] }), /对象|不合规/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', ms: NaN }), /ms/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', ms: Infinity }), /ms/);
});

test('🔴 client / scope 是枚举，不是自由文本', async () => {
  iso();
  const { buildEvent } = await fresh();
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', client: 'chovi@example.com' }), /client/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', scope: '/Users/chovi/proj' }), /scope/);
  assert.ok(buildEvent({ kind: 'install', result: 'ok', client: 'claude', scope: 'project' }));
});

test('🔴 reason 是有限代码表，挡住用户名/邮箱/token/路径', async () => {
  iso();
  const { buildEvent } = await fresh();
  const bad = [
    '/Users/x/.claude/skills 写失败', // 路径
    'C:\\Users\\x\\skills', // Windows 路径
    '\\\\server\\share', // UNC
    '~ 下没有 skills', // ~ 展开前
    'chovi@example.com', // 邮箱
    'sk-ant-api03-AbCdEf0123456789', // token
    'signature mismatch', // 带空格的自由文本
    homedir(), // 家目录字面量
    'alice', // 🔴 形状合法但不在代码表里 —— 自由字段就是这么变成侧信道的
    'signature-mismatchh', // 拼错也拒绝，不做模糊匹配
  ];
  for (const r of bad) {
    assert.throws(() => buildEvent({ kind: 'install', result: 'failed', reason: r }), /reason/, `应拒绝：${r}`);
  }
  assert.equal(
    buildEvent({ kind: 'install', result: 'failed', reason: 'signature-mismatch' }).reason,
    'signature-mismatch',
  );
});

test('🔴 artifact 必须是制品坐标，塞路径进去照样被拒', async () => {
  iso();
  const { buildEvent } = await fresh();
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', artifact: '/Users/x/secret' }), /artifact/);
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok', artifact: 'skill:g/a@1.0.0/../../etc' }), /artifact/);
  assert.ok(buildEvent({ kind: 'install', result: 'ok', artifact: 'pack:geoly/theme-matrix@0.3.1' }));
});

test('🔴 GEOLY_CLI_VERSION 是可注入的环境变量，也要过校验', async () => {
  iso();
  process.env.GEOLY_CLI_VERSION = '/Users/chovi/leak';
  const { buildEvent } = await fresh();
  assert.throws(() => buildEvent({ kind: 'install', result: 'ok' }), /cli/);
  delete process.env.GEOLY_CLI_VERSION;
});

test('🔴 缺必填字段的事件被拒（防手改队列删字段）', async () => {
  iso();
  const { assertValidEvent, buildEvent } = await fresh();
  const ev = buildEvent({ kind: 'install', result: 'ok' });
  for (const k of ['schema', 'eid', 'at', 'install_id', 'cli', 'os', 'arch', 'node', 'kind', 'result']) {
    const copy = { ...ev };
    delete copy[k];
    assert.throws(() => assertValidEvent(copy), new RegExp(k), `删掉 ${k} 应被拒`);
  }
});

// ── 落盘 / 读回 ──────────────────────────────────────────────────────────────

test('关掉埋点后一个字节都不写', async () => {
  iso();
  process.env.GEOLY_TELEMETRY = '0';
  const { record, readAll } = await fresh();
  assert.equal(record({ kind: 'install', result: 'ok' }), null);
  assert.deepEqual(readAll(), []);
  delete process.env.GEOLY_TELEMETRY;
});

test('install_id 稳定且是随机 UUID（与身份无关）', async () => {
  iso();
  const { installId } = await fresh();
  const a = installId();
  assert.equal(a, installId());
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.ok(!a.includes(process.env.USER ?? 'nobody'));
});

test('记录后可读回', async () => {
  iso();
  const { record, readAll } = await fresh();
  record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0', client: 'claude', scope: 'global', ms: 12 });
  const all = readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].client, 'claude');
});

test('🔴 record 绝不向主命令抛错（威胁模型 T-5）', async () => {
  iso();
  const { record, lastError } = await fresh();
  // 非法输入不该炸掉安装事务，只该拒绝落盘
  assert.equal(record({ kind: 'install', result: 'ok', client: { evil: '/Users/a' } }), null);
  assert.match(String(lastError()), /client|对象/);
  assert.equal(record({ kind: 'bogus', result: 'ok' }), null);
});

test('🔴 手改队列塞进去的脏行，读回时被丢弃', async () => {
  const d = iso();
  const { record, readAll, exportJson } = await fresh();
  record({ kind: 'install', result: 'ok', artifact: 'skill:geoly/a@1.0.0' });
  const qp = join(d, 'telemetry', 'queue.ndjson');
  const good = readFileSync(qp, 'utf8');
  const base = JSON.parse(good.trim());
  const tampered =
    [
      JSON.stringify({ ...base, leaked: '/Users/chovi/.ssh/id_rsa' }), // 未知字段
      JSON.stringify({ ...base, client: { path: '/Users/a' } }), // 嵌套对象
      '{不是合法 JSON',
    ].join('\n') + '\n';
  writeFileSync(qp, good + tampered);

  const all = readAll();
  assert.equal(all.length, 1, '只应剩那条干净的');
  const dumped = exportJson();
  assert.ok(!dumped.includes('id_rsa'));
  assert.ok(!dumped.includes('leaked'));
});

test('🔴 原型污染键不能借 Object.prototype 混进去', async () => {
  iso();
  const { assertValidEvent, buildEvent, isValidEvent } = await fresh();
  const base = buildEvent({ kind: 'install', result: 'ok' });
  // JSON.parse 会把 __proto__ 建成**自有属性**，Object.keys 看得见它
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const ev = JSON.parse(JSON.stringify(base));
    Object.defineProperty(ev, key, { value: '/Users/chovi/.ssh/id_rsa', enumerable: true, configurable: true });
    assert.throws(() => assertValidEvent(ev), /未知字段/, `${key} 应被当成未知字段拒绝`);
    assert.equal(isValidEvent(ev), false);
  }
  // 反过来：原型上有 toString 不代表事件「有」这个必填字段
  assert.equal(isValidEvent(base), true);
});

test('🔴 空对象 / 数组 / null 不是事件', async () => {
  iso();
  const { assertValidEvent } = await fresh();
  for (const v of [null, [], 'x', 42, undefined]) {
    assert.throws(() => assertValidEvent(v), /普通对象/);
  }
});
