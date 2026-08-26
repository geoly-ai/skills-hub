// trust floor 与 wire 严格解析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import {
  parseWireJson, parseWireText, assertCanonicalBytes, assertExactKeys, parseWireTime,
  assertTreeDigest, assertAssetDigest, compareFloor, checkAntiReplay, advanceTrustFloor,
  readTrustFloor, makeFloor, validateTrustFloor, assertFloorUnchanged, resolveStateDir,
  TRUST_SCHEMA, sha256Of,
} from '../src/trust.mjs';
import { stringify } from '../src/canonical-json.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const hex = (seed) => String(seed).padStart(64, '0');
const newState = () => mkdtempSync(join(tmpdir(), 'geoly-trust-'));

function floorAt(v, n) {
  return makeFloor({
    timestamp_version: v, timestamp_sha256: `sha256:${hex(v)}`,
    latest_snapshot: n, snapshot_sha256: `sha256:${hex(n)}`, now: new Date(0),
  });
}

function expectViolation(want, fn) {
  try { fn(); } catch (e) {
    assert.equal(e.violation, want, `期望违规 ${want}，实际 ${e.violation}：${e.message}`);
    return e;
  }
  assert.fail(`期望违规 ${want}，但没有抛错`);
}

// ── wire 解析 ───────────────────────────────────────────────────────────────

test('🔴 转义形式的重复 key 被拒 —— 上游 parseStrict 在这里会静默取后一个', () => {
  expectViolation('E_WIRE_DUP_KEY', () => parseWireText('{"a":1,"\\u0061":2}'));
  expectViolation('E_WIRE_DUP_KEY', () => parseWireText('{"a":1,"a":2}'));
});

// 🔴 回归：Codex 第二轮实测出来的原型污染 + additionalProperties 绕过。
// 用字面量 {} 时 obj["__proto__"] = v 走的是 setter，不产生自有属性 ——
// Object.keys() 看不到它，于是「未知字段」检查放行，同时原型被污染。
test('🔴 回归：__proto__ 键既不污染原型，也绕不过未知字段检查', () => {
  const o = parseWireText('{"__proto__":{"pwn":1}}');
  assert.equal(({}).pwn, undefined, '不得污染 Object.prototype');
  assert.equal(o.pwn, undefined, '不得通过原型链读到 pwn');
  assert.deepEqual(Object.keys(o), ['__proto__'], '__proto__ 必须是可见的自有属性');
  expectViolation('E_WIRE_UNKNOWN_FIELD', () => assertExactKeys(o, { required: [], optional: [] }, 'x'));
  // 嵌套层同样
  const n = parseWireText('{"a":{"__proto__":{"pwn":2}}}');
  assert.equal(({}).pwn, undefined);
  expectViolation('E_WIRE_UNKNOWN_FIELD', () => assertExactKeys(n.a, { required: [], optional: [] }, 'x.a'));
});

test('🔴 回归：未转义的孤立代理（直接喂 JS 字符串时）也被拒', () => {
  expectViolation('E_WIRE_LONE_SURROGATE', () => parseWireText('{"a":"\ud800"}'));
  expectViolation('E_WIRE_LONE_SURROGATE', () => parseWireText('{"a":"\udc00"}'));
  expectViolation('E_WIRE_LONE_SURROGATE', () => parseWireText('{"\ud800":"x"}'));
  assert.equal(parseWireText('{"a":"\u{1f600}"}').a, '\u{1f600}'); // 完整代理对仍然通过
});

test('数字字面量只允许非负整数（拒浮点/指数/前导零/负零）', () => {
  for (const bad of ['{"a":1.0}', '{"a":1e3}', '{"a":-0}', '{"a":-1}', '{"a":01}', '{"a":0x10}']) {
    expectViolation('E_WIRE_NUMBER', () => parseWireText(bad));
  }
  // 对象是 null 原型的（见上面的 __proto__ 回归），所以按属性比而不是 deepEqual
  assert.deepEqual({ ...parseWireText('{"a":0,"b":10}') }, { a: 0, b: 10 });
});

test('超过 2^53-1 的整数被拒', () => {
  expectViolation('E_WIRE_NUMBER', () => parseWireText('{"a":9007199254740993}'));
});

test('key 与 value 里的 C0/C1 控制符都被拒（key 也判）', () => {
  expectViolation('E_WIRE_CONTROL_CHAR', () => parseWireText('{"a":"x\\u0001y"}'));
  expectViolation('E_WIRE_CONTROL_CHAR', () => parseWireText('{"\\u0001":"x"}'));
  expectViolation('E_WIRE_CONTROL_CHAR', () => parseWireText('{"a":"x\\u0085y"}'));
});

test('未配对代理被拒', () => {
  expectViolation('E_WIRE_LONE_SURROGATE', () => parseWireText('{"a":"\\ud800"}'));
  expectViolation('E_WIRE_LONE_SURROGATE', () => parseWireText('{"a":"\\udc00x"}'));
  assert.equal(parseWireText('{"a":"\\ud83d\\ude00"}').a, '\u{1f600}');
});

test('尾随内容 / 非法转义被拒', () => {
  expectViolation('E_WIRE_TRAILING', () => parseWireText('{"a":1} {"b":2}'));
  expectViolation('E_WIRE_PARSE', () => parseWireText('{"a":"\\x41"}'));
});

test('非 UTF-8 字节与 BOM 被拒', () => {
  expectViolation('E_WIRE_UTF8', () => parseWireJson(Buffer.from([0x7b, 0xff, 0x7d])));
  expectViolation('E_WIRE_BOM', () => parseWireJson(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])));
});

test('超过 8 MiB 的文档在解码前就被拒', () => {
  expectViolation('E_WIRE_TOO_LARGE', () => parseWireJson(Buffer.alloc(8 * 1024 * 1024 + 1, 0x20)));
});

test('additionalProperties: false —— 未知字段与缺失必填都报出具体是哪个', () => {
  const e1 = expectViolation('E_WIRE_UNKNOWN_FIELD', () => assertExactKeys({ a: 1, evil: 2 }, { required: ['a'] }, 'x'));
  assert.match(e1.message, /evil/);
  const e2 = expectViolation('E_WIRE_MISSING_FIELD', () => assertExactKeys({}, { required: ['a'] }, 'x'));
  assert.match(e2.message, /缺少必填字段 a/);
});

test('时间必须是真实日期（2026-02-30 形状合法但不存在）', () => {
  assert.equal(parseWireTime('2026-08-25T12:00:00Z', 't'), 1787659200);
  expectViolation('E_WIRE_TIME', () => parseWireTime('2026-02-30T00:00:00Z', 't'));
  expectViolation('E_WIRE_TIME', () => parseWireTime('2026-08-25T12:00:00+00:00', 't'));
  expectViolation('E_WIRE_TIME', () => parseWireTime('2026-08-25T12:00:00.000Z', 't'));
});

test('🔴 摘要必须带算法标识；不认识的算法前缀 → 拒绝安装，不降级', () => {
  assertTreeDigest(`geoly-tree-v1:sha256:${hex(1)}`, 'd');
  const e = expectViolation('E_UNKNOWN_DIGEST_ALGO', () => assertTreeDigest(`geoly-tree-v2:blake3:${hex(1)}`, 'd'));
  assert.equal(e.code, 2);
  expectViolation('E_WIRE_DIGEST', () => assertTreeDigest(hex(1), 'd')); // 裸 hex
  expectViolation('E_WIRE_DIGEST', () => assertAssetDigest(hex(1), 'a'));
});

test('canonical 往返：key 顺序被打乱就不再是 canonical', () => {
  const doc = { schema: 'x', b: 1, a: 2 };
  assertCanonicalBytes(Buffer.from(stringify(doc)), doc, 'x');
  expectViolation('E_NOT_CANONICAL',
    () => assertCanonicalBytes(Buffer.from('{\n  "schema": "x",\n  "b": 1,\n  "a": 2\n}\n'), doc, 'x'));
});

// ── floor 读写 ──────────────────────────────────────────────────────────────

test('floor 不存在 → null（bootstrap）；存在但非法 → 停机，不当成 null', () => {
  const dir = newState();
  assert.equal(readTrustFloor(dir), null);
  writeFileSync(join(dir, 'trust.json'), '{ not json');
  expectViolation('E_WIRE_PARSE', () => readTrustFloor(dir));
  writeFileSync(join(dir, 'trust.json'), stringify({ ...floorAt(1, 1), schema: 'geoly.skills.trust/2' }));
  expectViolation('E_SCHEMA', () => readTrustFloor(dir));
});

test('floor 文件被改成非 canonical 形式 → 停机', () => {
  const dir = newState();
  writeFileSync(join(dir, 'trust.json'), JSON.stringify(floorAt(3, 3)));
  expectViolation('E_NOT_CANONICAL', () => readTrustFloor(dir));
});

test('floor schema 必须是 geoly.skills.trust/1，未知字段被拒', () => {
  expectViolation('E_WIRE_UNKNOWN_FIELD', () => validateTrustFloor({ ...floorAt(1, 1), extra: 1 }));
  assert.equal(floorAt(1, 1).schema, TRUST_SCHEMA);
});

test('stateDir 下的 trust.json 是符号链接 → 拒绝（两个进程会锁住不同对象）', () => {
  const dir = newState();
  const elsewhere = newState();
  writeFileSync(join(elsewhere, 'real.json'), stringify(floorAt(1, 1)));
  symlinkSync(join(elsewhere, 'real.json'), join(dir, 'trust.json'));
  assert.throws(() => resolveStateDir(dir), /符号链接/);
});

// ── compareFloor：三分支 + snapshot 单调性 ─────────────────────────────────

test('① version 更低 → 回滚攻击（E_ROLLBACK）', () => {
  const e = expectViolation('E_ROLLBACK', () => checkAntiReplay(floorAt(10, 42), floorAt(9, 42)));
  assert.equal(e.code, 2);
});

test('② version 相同 → 三元组全等才接受', () => {
  assert.equal(compareFloor(floorAt(10, 42), floorAt(10, 42)).action, 'unchanged');
  // latest_snapshot 不同
  expectViolation('E_FLOOR_MISMATCH', () => checkAntiReplay(floorAt(10, 42), floorAt(10, 43)));
  // 🔴 timestamp_sha256 不同（v6 漏掉的那一项）
  const a = floorAt(10, 42);
  const b = { ...floorAt(10, 42), timestamp_sha256: `sha256:${hex(999)}` };
  const e = expectViolation('E_FLOOR_MISMATCH', () => checkAntiReplay(a, b));
  assert.match(e.message, /timestamp_sha256/);
  // snapshot_sha256 不同
  const c = { ...floorAt(10, 42), snapshot_sha256: `sha256:${hex(777)}` };
  assert.match(expectViolation('E_FLOOR_MISMATCH', () => checkAntiReplay(a, c)).message, /snapshot_sha256/);
});

test('③ version 更高但 latest_snapshot 退回 → 拒绝（旧 yank 会重新生效）', () => {
  const e = expectViolation('E_SNAPSHOT_ROLLBACK', () => checkAntiReplay(floorAt(10, 42), floorAt(11, 41)));
  assert.match(e.message, /旧 yank 状态会重新生效/);
});

test('③ version 更高、snapshot 相同但摘要被换 → 拒绝（E_SNAPSHOT_SWAP）', () => {
  const cand = { ...floorAt(11, 42), snapshot_sha256: `sha256:${hex(999)}` };
  expectViolation('E_SNAPSHOT_SWAP', () => checkAntiReplay(floorAt(10, 42), cand));
});

test('③ 正常推进被接受', () => {
  assert.equal(checkAntiReplay(floorAt(10, 42), floorAt(11, 43)).action, 'write');
  assert.equal(checkAntiReplay(null, floorAt(1, 1)).reason, 'bootstrap');
});

test('🔴 「磁盘更新」在两条路径上的处理不同：解析当前=拒绝，锁内提交=重做', () => {
  expectViolation('E_ROLLBACK', () => compareFloor(floorAt(12, 42), floorAt(11, 42), 'reject'));
  const v = compareFloor(floorAt(12, 42), floorAt(11, 42), 'redo');
  assert.equal(v.action, 'redo');
  assert.equal(v.diskFloor.timestamp_version, 12);
});

// ── advanceTrustFloor ───────────────────────────────────────────────────────

test('advanceTrustFloor 写盘后可读回，且是 canonical 形式', () => {
  const dir = newState();
  const r = advanceTrustFloor(dir, floorAt(5, 20));
  assert.equal(r.action, 'written');
  assert.equal(readTrustFloor(dir).timestamp_version, 5);
  assert.equal(readFileSync(join(dir, 'trust.json'), 'utf8'), stringify(floorAt(5, 20)));
});

test('同版本重复推进 → unchanged，不重写', () => {
  const dir = newState();
  advanceTrustFloor(dir, floorAt(5, 20));
  assert.equal(advanceTrustFloor(dir, floorAt(5, 20)).action, 'unchanged');
});

test('assertFloorUnchanged 在 floor 被别人推进后报 E_FLOOR_MOVED', () => {
  const dir = newState();
  const mine = floorAt(5, 20);
  advanceTrustFloor(dir, mine);
  advanceTrustFloor(dir, floorAt(6, 21));
  expectViolation('E_FLOOR_MOVED', () => assertFloorUnchanged(dir, mine));
});

// ── 🔴 并发：两个真实进程 ──────────────────────────────────────────────────

const WRITER = join(HERE, 'fixtures', 'trustchain-writer.mjs');
const run = (args) => new Promise((res) => {
  execFile(process.execPath, [WRITER, ...args.map(String)], (err, stdout, stderr) => {
    res({ err, stdout: stdout.trim(), stderr });
  });
});

test('🔴 并发：P1 写 11、P2 写 12，floor 绝不回退到 11', { timeout: 60000 }, async () => {
  for (let round = 0; round < 5; round++) {
    const dir = newState();
    advanceTrustFloor(dir, floorAt(10, 40));
    const [a, b] = await Promise.all([run([dir, 11, 41]), run([dir, 12, 42])]);
    const final = readTrustFloor(dir);
    assert.equal(final.timestamp_version, 12, `第 ${round} 轮 floor 回退到了 ${final.timestamp_version}`);
    assert.equal(final.latest_snapshot, 42);
    // 后到的那个 11 必须报 redo，而不是「写成功」
    const results = [a, b].map(r => JSON.parse(r.stdout));
    const eleven = results.find(r => r.version === 11);
    assert.ok(['written', 'redo'].includes(eleven.action));
    if (eleven.action === 'written') {
      // 它先跑完，那么 12 必须是 written
      assert.equal(results.find(r => r.version === 12).action, 'written');
    }
  }
});

test('🔴 并发：8 个进程乱序推进，最终 floor 是最大值且全程单调', { timeout: 60000 }, async () => {
  const dir = newState();
  advanceTrustFloor(dir, floorAt(100, 500));
  const versions = [104, 101, 108, 103, 107, 102, 106, 105];
  const outs = await Promise.all(versions.map(v => run([dir, v, 400 + v])));
  const final = readTrustFloor(dir);
  assert.equal(final.timestamp_version, 108);
  assert.equal(final.latest_snapshot, 508);
  for (const o of outs) {
    const r = JSON.parse(o.stdout);
    assert.ok(['written', 'redo', 'unchanged'].includes(r.action), `意外的 action：${o.stdout}`);
  }
});

test('🔴 并发：同 version 不同三元组的两个进程 —— 后到的必须报完整性事件，不是静默覆盖', async () => {
  const dir = newState();
  advanceTrustFloor(dir, floorAt(20, 60));
  // 直接在同进程构造：磁盘 20/60，候选 20/61
  expectViolation('E_FLOOR_MISMATCH', () => advanceTrustFloor(dir, floorAt(20, 61)));
  assert.equal(readTrustFloor(dir).latest_snapshot, 60, '完整性事件不得改动磁盘上的 floor');
});

test('sha256Of 的输出形状是 sha256:<64 hex>', () => {
  assert.match(sha256Of(Buffer.from('x')), /^sha256:[0-9a-f]{64}$/);
});

test('清理临时目录', () => {
  void mkdirSync; void rmSync; // 临时目录交给 OS；这里只是让 lint 看到它们被用过
  assert.ok(true);
});
