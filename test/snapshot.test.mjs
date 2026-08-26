// timestamp / snapshot 严格解析、验签契约与验证链顺序
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTimestamp, assertFresh, assertMinCliVersion, parseSnapshot, assertSnapshotDigest,
  verifySigned, defaultVerifier, isVerified, assertVerified, resolveCurrent, readHistoricalSnapshot,
  RELEASE_IDENTITY, TIMESTAMP_IDENTITY, OIDC_ISSUER, parseSemver, compareSemver, VerifiedBytes,
} from '../src/snapshot.mjs';
import { readTrustFloor, advanceTrustFloor, makeFloor, sha256Of } from '../src/trust.mjs';
import { stringify } from '../src/canonical-json.mjs';
import {
  makeRecord, makeSnapshotDoc, makeTimestampDoc, bytesOf, fakeVerifier, hex, sha256Hex, NOW,
} from './fixtures/trustchain-objects.mjs';

const newState = () => mkdtempSync(join(tmpdir(), 'geoly-snap-'));

function expectViolation(want, fn) {
  try { fn(); } catch (e) {
    assert.equal(e.violation, want, `期望违规 ${want}，实际 ${e.violation}：${e.message}`);
    return e;
  }
  assert.fail(`期望违规 ${want}，但没有抛错`);
}

/** assert.throws 返回 undefined，拿不到错误对象；要断言退出码就得自己接 */
function catchErr(fn) {
  try { fn(); } catch (e) { return e; }
  assert.fail('期望抛错，但没有');
}

// ── semver ──────────────────────────────────────────────────────────────────

test('禁 +build metadata（D7）；预发布参与 precedence', () => {
  expectViolation('E_SEMVER_BUILD', () => parseSemver('1.0.0+build1', 'v'));
  expectViolation('E_SEMVER', () => parseSemver('1.0', 'v'));
  expectViolation('E_SEMVER', () => parseSemver('01.0.0', 'v'));
  assert.equal(compareSemver(parseSemver('1.0.0', 'v'), parseSemver('1.0.0-rc.1', 'v')), 1);
  assert.equal(compareSemver(parseSemver('1.0.0-rc.2', 'v'), parseSemver('1.0.0-rc.10', 'v')), -1);
});

// ── timestamp ───────────────────────────────────────────────────────────────

test('合法 timestamp 能解析，并带上自身字节的 sha256', () => {
  const b = bytesOf(makeTimestampDoc());
  const ts = parseTimestamp(b);
  assert.equal(ts.version, 137);
  assert.equal(ts._sha256, sha256Of(b));
});

test('timestamp：repo 必须等于内置常量', () => {
  expectViolation('E_REPO', () => parseTimestamp(bytesOf(makeTimestampDoc({ repo: 'evil/hub' }))));
});

test('timestamp：schema 主版本不同 → 拒绝，不做尽力而为地解析', () => {
  const d = { ...makeTimestampDoc(), schema: 'geoly.skills.timestamp/2' };
  expectViolation('E_SCHEMA', () => parseTimestamp(bytesOf(d)));
});

test('timestamp：未知字段被拒（additionalProperties: false）', () => {
  const d = { ...makeTimestampDoc(), extra: 1 };
  expectViolation('E_WIRE_UNKNOWN_FIELD', () => parseTimestamp(bytesOf(d)));
});

test('🔴 timestamp：负有效期被拒（v3 只写了上界）', () => {
  const d = makeTimestampDoc({ created_at: '2026-09-01T12:00:00Z', valid_until: '2026-08-25T12:00:00Z' });
  expectViolation('E_TS_NEGATIVE_VALIDITY', () => parseTimestamp(bytesOf(d)));
});

test('🔴 timestamp：有效期超过 7 天被拒', () => {
  const d = makeTimestampDoc({ valid_until: '2026-09-01T12:00:01Z' });
  expectViolation('E_TS_VALIDITY_TOO_LONG', () => parseTimestamp(bytesOf(d)));
  // 恰好 7 天可以
  parseTimestamp(bytesOf(makeTimestampDoc({ valid_until: '2026-09-01T12:00:00Z' })));
});

test('🔴 timestamp：签发时间在未来（超出 5 分钟偏移）被拒', () => {
  const ts = parseTimestamp(bytesOf(makeTimestampDoc()));
  expectViolation('E_TS_FUTURE', () => assertFresh(ts, { now: Date.parse('2026-08-25T11:50:00Z') }));
  // 5 分钟以内容忍
  assert.equal(assertFresh(ts, { now: Date.parse('2026-08-25T11:58:00Z') }).stale, false);
});

test('timestamp 过期 → StaleError（退出码 8）；--offline 下降级为 stale 标记', () => {
  const ts = parseTimestamp(bytesOf(makeTimestampDoc()));
  const after = Date.parse('2026-09-02T00:00:00Z');
  const e = catchErr(() => assertFresh(ts, { now: after }));
  assert.equal(e.code, 8);
  assert.equal(assertFresh(ts, { now: after, offline: true }).stale, true);
});

test('min_cli_version：低于要求 → 退出码 11', () => {
  const ts = parseTimestamp(bytesOf(makeTimestampDoc()));
  const e = catchErr(() => assertMinCliVersion(ts, "1.1.9"));
  assert.equal(e.code, 11);
  assertMinCliVersion(ts, '1.2.0');
});

test('timestamp 必须是 canonical 字节', () => {
  const d = makeTimestampDoc();
  expectViolation('E_NOT_CANONICAL', () => parseTimestamp(Buffer.from(JSON.stringify(d))));
});

// ── snapshot ────────────────────────────────────────────────────────────────

test('合法 snapshot 能解析', () => {
  const doc = makeSnapshotDoc([makeRecord(), makeRecord({ name: 'other' })]);
  const s = parseSnapshot(bytesOf(doc), { expectSnapshot: 42 });
  assert.equal(s.artifacts.length, 2);
  assert.deepEqual({ ...s.latest }, { 'skill:geoly/demo': '0.1.0', 'skill:geoly/other': '0.1.0' });
});

test('snapshot 号与 timestamp.latest_snapshot 不符 → 拒绝', () => {
  const doc = makeSnapshotDoc([makeRecord()]);
  expectViolation('E_SNAPSHOT_N', () => parseSnapshot(bytesOf(doc), { expectSnapshot: 43 }));
});

test('🔴 artifacts 未按 id 字节序升序 → 拒绝（顺序参与确定性）', () => {
  const doc = makeSnapshotDoc([makeRecord({ name: 'aaa' }), makeRecord({ name: 'bbb' })]);
  doc.artifacts.reverse();
  expectViolation('E_ARTIFACTS_ORDER', () => parseSnapshot(bytesOf(doc)));
});

test('id 重复 → 拒绝', () => {
  const doc = makeSnapshotDoc([makeRecord(), makeRecord()]);
  expectViolation('E_ID_DUPLICATE', () => parseSnapshot(bytesOf(doc)));
});

test('id / path 与 kind+ns+name+version 不一致 → 拒绝', () => {
  const doc1 = makeSnapshotDoc([makeRecord({ id: 'skill:geoly/demo@9.9.9' })]);
  expectViolation('E_ID_MISMATCH', () => parseSnapshot(bytesOf(doc1)));
  const doc2 = makeSnapshotDoc([makeRecord({ path: 'artifacts/skills/evil/demo/0.1.0' })]);
  expectViolation('E_PATH_MISMATCH', () => parseSnapshot(bytesOf(doc2)));
});

test('🔴 latest 不得包含 degraded 的最高版（v2 会把它选成默认，然后安装必失败）', () => {
  const lo = makeRecord({ version: '0.1.0' });
  const hi = makeRecord({ version: '0.2.0', status: 'degraded' });
  const doc = makeSnapshotDoc([lo, hi]);
  assert.equal(doc.latest['skill:geoly/demo'], '0.1.0');
  parseSnapshot(bytesOf(doc));
  // 手工把 degraded 的版本塞进 latest → 必须被拒
  doc.latest['skill:geoly/demo'] = '0.2.0';
  expectViolation('E_LATEST_VALUE', () => parseSnapshot(bytesOf(doc)));
});

test('latest 不得包含 yanked 与 prerelease', () => {
  const doc = makeSnapshotDoc([makeRecord({ version: '0.1.0' }), makeRecord({ version: '0.2.0-rc.1' })]);
  assert.equal(doc.latest['skill:geoly/demo'], '0.1.0');
  doc.latest['skill:geoly/demo'] = '0.2.0-rc.1';
  expectViolation('E_LATEST_VALUE', () => parseSnapshot(bytesOf(doc)));
});

test('latest 的键集必须自洽（多一个键也不行）', () => {
  const doc = makeSnapshotDoc([makeRecord()]);
  doc.latest['skill:geoly/ghost'] = '1.0.0';
  expectViolation('E_LATEST_KEYS', () => parseSnapshot(bytesOf(doc)));
});

test('status=yanked 必须同时出现在 yanked 列表里，反之亦然', () => {
  const doc = makeSnapshotDoc([makeRecord({ status: 'yanked' })]);
  parseSnapshot(bytesOf(doc));
  doc.yanked = [];
  expectViolation('E_YANK_MISSING', () => parseSnapshot(bytesOf(doc)));
});

test('🔴 submitted / in_review / approved / rejected 不得进快照（§2.3）', () => {
  for (const s of ['submitted', 'in_review', 'approved', 'rejected']) {
    const doc = makeSnapshotDoc([makeRecord({ status: s })]);
    expectViolation('E_STATUS_NOT_IN_SNAPSHOT', () => parseSnapshot(bytesOf(doc)));
  }
});

test('🔴 provenance.origin_commit 只记 tag 被拒（tag 可以被移动）', () => {
  const prov = {
    kind: 'vendored', origin_repo: 'https://github.com/x/y', origin_ref: 'v0.3.6',
    origin_commit: 'v0.3.6', origin_subpath: 'a', origin_tree_digest: `sha256:${hex(4)}`,
    license_evidence: 'LICENSE', imported_at: '2026-08-24T00:00:00Z', imported_by_pr: 3,
    added_files: ['skill.json'],
  };
  expectViolation('E_PROV_COMMIT', () => parseSnapshot(bytesOf(makeSnapshotDoc([makeRecord({ provenance: prov })]))));
});

test('tree_digest 用了不认识的算法 → 拒绝安装（不降级）', () => {
  const doc = makeSnapshotDoc([makeRecord({ tree_digest: `geoly-tree-v2:sha256:${hex(1)}` })]);
  expectViolation('E_UNKNOWN_DIGEST_ALGO', () => parseSnapshot(bytesOf(doc)));
});

test('snapshot 字节 sha256 与 timestamp.snapshot_sha256 不符 → 拒绝', () => {
  const b = bytesOf(makeSnapshotDoc([makeRecord()]));
  assertSnapshotDigest(b, sha256Of(b));
  expectViolation('E_SNAPSHOT_SHA256', () => assertSnapshotDigest(b, `sha256:${hex(0)}`));
});

// ── 验签契约 ────────────────────────────────────────────────────────────────

test('🔴 默认验签器永远抛错（fail-closed，不存在 --no-verify）', () => {
  const e = expectViolation('E_VERIFIER_MISSING', () => defaultVerifier());
  assert.equal(e.code, 2);
  expectViolation('E_VERIFIER_MISSING',
    () => verifySigned({ bytes: Buffer.from('x'), bundle: {}, expectIdentity: RELEASE_IDENTITY }));
});

test('🔴 验签器返回 undefined / true / {ok:false} 都不算成功', () => {
  const bytes = Buffer.from('x');
  for (const v of [() => undefined, () => true, () => ({}), () => ({ ok: false })]) {
    expectViolation('E_SIGNATURE', () => verifySigned({ bytes, bundle: {}, expectIdentity: RELEASE_IDENTITY, verifier: v }));
  }
});

test('🔴 两个签名身份不可互换：用 release.yml 身份签的 timestamp 必须被拒', () => {
  const bytes = bytesOf(makeTimestampDoc());
  const e = expectViolation('E_IDENTITY_MISMATCH', () => verifySigned({
    bytes, bundle: {}, expectIdentity: TIMESTAMP_IDENTITY, verifier: fakeVerifier({ signAs: RELEASE_IDENTITY }),
  }));
  assert.match(e.message, /不可互换/);
  // 反向同理
  expectViolation('E_IDENTITY_MISMATCH', () => verifySigned({
    bytes, bundle: {}, expectIdentity: RELEASE_IDENTITY, verifier: fakeVerifier({ signAs: TIMESTAMP_IDENTITY }),
  }));
});

test('身份精确比对，不做前缀匹配', () => {
  const bytes = Buffer.from('x');
  expectViolation('E_IDENTITY_MISMATCH', () => verifySigned({
    bytes, bundle: {}, expectIdentity: RELEASE_IDENTITY,
    verifier: fakeVerifier({ signAs: RELEASE_IDENTITY + '.evil' }),
  }));
  expectViolation('E_UNKNOWN_IDENTITY', () => verifySigned({
    bytes, bundle: {}, expectIdentity: 'https://github.com/evil/x@refs/heads/main', verifier: fakeVerifier(),
  }));
});

test('issuer 必须是 GitHub Actions 的 OIDC issuer', () => {
  const bytes = Buffer.from('x');
  expectViolation('E_ISSUER_MISMATCH', () => verifySigned({
    bytes, bundle: {}, expectIdentity: RELEASE_IDENTITY,
    verifier: () => ({ ok: true, identity: RELEASE_IDENTITY, issuer: 'https://evil', sha256: sha256Of(bytes) }),
  }));
});

test('🔴 验签器声称验的字节必须就是我们手上这串', () => {
  expectViolation('E_SIGNED_BYTES_MISMATCH', () => verifySigned({
    bytes: Buffer.from('x'), bundle: {}, expectIdentity: RELEASE_IDENTITY, verifier: fakeVerifier({ corruptSha: true }),
  }));
});

test('🔴 VerifiedBytes 无法从外部构造，assertVerified 认 brand 不认形状', () => {
  assert.throws(() => new VerifiedBytes(Symbol('fake'), Buffer.from('x'), RELEASE_IDENTITY, OIDC_ISSUER));
  const v = verifySigned({ bytes: Buffer.from('x'), bundle: {}, expectIdentity: RELEASE_IDENTITY, verifier: fakeVerifier() });
  assert.ok(isVerified(v));
  assert.equal(assertVerified(v, 'x'), v);
  // 长得一样的普通对象过不去
  expectViolation('E_NOT_VERIFIED',
    () => assertVerified({ bytes: Buffer.from('x'), identity: RELEASE_IDENTITY, issuer: OIDC_ISSUER }, 'x'));
});

// ── 验证链顺序 ──────────────────────────────────────────────────────────────

function chain(over = {}) {
  const records = over.records ?? [makeRecord()];
  const snapDoc = makeSnapshotDoc(records, { snapshot: over.snapshotN ?? 42 });
  const snapBytes = bytesOf(snapDoc);
  const tsDoc = makeTimestampDoc({
    latest_snapshot: over.snapshotN ?? 42,
    snapshot_sha256: over.snapshotSha ?? sha256Of(snapBytes),
    ...over.ts,
  });
  const tsBytes = bytesOf(tsDoc);
  const calls = [];
  return {
    tsBytes, snapBytes, calls,
    args: {
      fetchTimestamp: () => { calls.push('fetch-ts'); return { bytes: tsBytes, bundle: {} }; },
      fetchSnapshot: (n) => { calls.push(`fetch-snap:${n}`); return { bytes: snapBytes, bundle: {} }; },
      verifier: (a) => { calls.push(`verify:${a.expectIdentity.includes('timestamp') ? 'ts' : 'release'}`); return fakeVerifier()(a); },
      cliVersion: '1.2.0',
      now: NOW,
    },
  };
}

test('🔴 验证链的调用顺序：验 timestamp 签名 → 取 snapshot → 验 snapshot 签名 → 推进 floor', () => {
  const dir = newState();
  const c = chain();
  const r = resolveCurrent({ stateDir: dir, ...c.args });
  assert.deepEqual(c.calls, ['fetch-ts', 'verify:ts', 'fetch-snap:42', 'verify:release']);
  assert.equal(r.snapshot.snapshot, 42);
  // 🔴 floor 在**下载制品之前**就已经落盘
  assert.equal(readTrustFloor(dir).timestamp_version, 137);
});

test('🔴 timestamp 验签失败时，snapshot 根本不会被取（更不会解包）', () => {
  const dir = newState();
  const c = chain();
  assert.throws(() => resolveCurrent({
    stateDir: dir, ...c.args,
    verifier: (a) => { c.calls.push('verify'); return { ok: false }; },
  }), /E_SIGNATURE/);
  assert.ok(!c.calls.some(x => x.startsWith('fetch-snap')), '不应取 snapshot');
  assert.equal(readTrustFloor(dir), null, 'floor 不应被推进');
});

test('🔴 snapshot 字节摘要不符时，不会去验它的签名', () => {
  const dir = newState();
  const c = chain({ snapshotSha: `sha256:${hex(0)}` });
  assert.throws(() => resolveCurrent({ stateDir: dir, ...c.args }), /E_SNAPSHOT_SHA256/);
  assert.ok(!c.calls.includes('verify:release'));
  assert.equal(readTrustFloor(dir), null);
});

test('🔴 回滚的 timestamp 在推进 floor 之前就被挡下', () => {
  const dir = newState();
  advanceTrustFloor(dir, makeFloor({
    timestamp_version: 999, timestamp_sha256: `sha256:${hex(9)}`,
    latest_snapshot: 42, snapshot_sha256: `sha256:${hex(8)}`, now: new Date(0),
  }));
  const c = chain();
  assert.throws(() => resolveCurrent({ stateDir: dir, ...c.args }), /E_ROLLBACK/);
  assert.ok(!c.calls.some(x => x.startsWith('fetch-snap')));
  assert.equal(readTrustFloor(dir).timestamp_version, 999, 'floor 不得被降回去');
});

test('CLI 版本过低在取 snapshot 之前就停下（退出码 11）', () => {
  const dir = newState();
  const c = chain();
  const e = catchErr(() => resolveCurrent({ stateDir: dir, ...c.args, cliVersion: "1.0.0" }));
  assert.equal(e.code, 11);
  assert.ok(!c.calls.some(x => x.startsWith('fetch-snap')));
});

test('🔴 缓存命中不跳过验签：offline 路径同样调用 verifier', () => {
  const dir = newState();
  const c = chain();
  resolveCurrent({ stateDir: dir, ...c.args, offline: true, allowStale: true });
  assert.equal(c.calls.filter(x => x.startsWith('verify')).length, 2);
});

test('历史快照是只读路径：验它自己的签名，且标记 readOnly', () => {
  const snapDoc = makeSnapshotDoc([makeRecord()], { snapshot: 7, previous: 6 });
  const r = readHistoricalSnapshot({
    bytes: bytesOf(snapDoc), bundle: {}, verifier: fakeVerifier(), expectSnapshot: 7,
  });
  assert.equal(r.readOnly, true);
  assert.equal(r.snapshot.snapshot, 7);
  assert.ok(Object.isFrozen(r));
});

test('历史快照也不接受 timestamp.yml 身份', () => {
  const snapDoc = makeSnapshotDoc([makeRecord()], { snapshot: 7, previous: 6 });
  expectViolation('E_IDENTITY_MISMATCH', () => readHistoricalSnapshot({
    bytes: bytesOf(snapDoc), bundle: {}, verifier: fakeVerifier({ signAs: TIMESTAMP_IDENTITY }), expectSnapshot: 7,
  }));
});

// 🔴 回归：Codex 第二轮的最高危发现 ——
// resolveCurrent 以前无论 advanced.action 是什么都成功返回，于是 floor 在验证期间
// 被别的进程推高时，调用方会拿着**旧 snapshot** 继续下载安装。
test('🔴 回归：floor 在验证期间被推高时，resolveCurrent 不得返回旧 snapshot', () => {
  const dir = newState();
  const c = chain();
  const newer = makeFloor({
    timestamp_version: 9999, timestamp_sha256: `sha256:${hex(5)}`,
    latest_snapshot: 900, snapshot_sha256: `sha256:${hex(6)}`, now: new Date(0),
  });
  const e = catchErr(() => resolveCurrent({
    stateDir: dir, ...c.args,
    // 在「验完 timestamp、还没推进 floor」的窗口里，模拟另一个进程抢先推进
    fetchSnapshot: () => { advanceTrustFloor(dir, newer); return { bytes: c.snapBytes, bundle: {} }; },
  }));
  // 🔴 要点是**必须抛错、绝不返回旧 snapshot**。
  //    第一次尝试拿到 redo → 整个重来；重来时那份旧 timestamp 相对新 floor 已经是回滚，
  //    于是在第 3 步就被 E_ROLLBACK 挡下。两个码都是硬失败，都满足安全属性。
  assert.ok(['E_FLOOR_REDO', 'E_ROLLBACK'].includes(e.violation), `实际：${e.violation} ${e.message}`);
  assert.equal(e.code, 2);
  assert.equal(readTrustFloor(dir).timestamp_version, 9999, '别人推进的 floor 不得被覆盖');
});

test('🔴 回归：advanceTrustFloor 返回 redo 时 resolveCurrent 绝不返回成功', () => {
  const dir = newState();
  const c = chain();
  let calls = 0;
  const r = catchErr(() => resolveCurrent({
    stateDir: dir, ...c.args, maxAttempts: 2,
    fetchSnapshot: () => {
      // 每次都把 floor 推到比候选更高，逼出 redo
      calls++;
      advanceTrustFloor(dir, makeFloor({
        timestamp_version: 500 + calls, timestamp_sha256: `sha256:${hex(100 + calls)}`,
        latest_snapshot: 800 + calls, snapshot_sha256: `sha256:${hex(200 + calls)}`, now: new Date(0),
      }));
      return { bytes: c.snapBytes, bundle: {} };
    },
  }));
  assert.equal(r.code, 2, '必须是完整性失败，不能是成功返回');
  assert.ok(r instanceof Error);
});

test('semver：预发布数字标识符不得有前导零，也不得超出安全整数', () => {
  expectViolation('E_SEMVER', () => parseSemver('1.0.0-01', 'v'));
  expectViolation('E_SEMVER', () => parseSemver('1.0.0-9007199254740993', 'v'));
  parseSemver('1.0.0-0', 'v');       // 单个 0 合法
  parseSemver('1.0.0-alpha01', 'v'); // 非纯数字标识符不受前导零规则约束
});

test('yanked 列表里 id 重复 → 拒绝（E_YANK_DUPLICATE）', () => {
  const r = makeRecord({ status: 'yanked' });
  const doc = makeSnapshotDoc([r]);
  doc.yanked = [
    { id: r.id, at: '2026-08-25T12:00:00Z', reason: 'a' },
    { id: r.id, at: '2026-08-25T12:00:00Z', reason: 'b' },
  ];
  expectViolation('E_YANK_DUPLICATE', () => parseSnapshot(bytesOf(doc)));
});

test('夹具自检：sha256Hex 与 stringify 一致', () => {
  const b = bytesOf(makeTimestampDoc());
  assert.equal(sha256Of(b), 'sha256:' + sha256Hex(b));
  assert.equal(b.toString(), stringify(makeTimestampDoc()));
});
