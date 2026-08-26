// attestation（取证用）—— DSSE envelope + in-toto statement 的严格校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAttestationForForensics, pae, DSSE_PAYLOAD_TYPE, PREDICATE_TYPE, BUILD_TYPE,
} from '../src/attestation.mjs';
import { stringify } from '../src/canonical-json.mjs';
import { makeAttestationBytes, hex, COMMIT } from './fixtures/trustchain-objects.mjs';

function expectViolation(want, fn) {
  try { fn(); } catch (e) {
    assert.equal(e.violation, want, `期望违规 ${want}，实际 ${e.violation}：${e.message}`);
    return e;
  }
  assert.fail(`期望违规 ${want}，但没有抛错`);
}

test('正路：合法 attestation 能解析，并给出 PAE 字节', () => {
  const { bytes, pae: want } = makeAttestationBytes();
  const r = parseAttestationForForensics(bytes, { expectSnapshotSha256: `sha256:${hex(3)}`, expectSnapshotN: 42 });
  assert.equal(r.predicate.buildType, BUILD_TYPE);
  assert.equal(r.predicate.sourceCommit, COMMIT);
  assert.ok(r.pae.equals(want));
});

test('PAE 编码符合 DSSE 规范', () => {
  assert.equal(pae('t', Buffer.from('ab')).toString(), 'DSSEv1 1 t 2 ab');
});

test('payloadType 必须是 application/vnd.in-toto+json', () => {
  const { bytes } = makeAttestationBytes({ payloadType: 'application/json' });
  expectViolation('E_DSSE_PAYLOAD_TYPE', () => parseAttestationForForensics(bytes));
  assert.equal(DSSE_PAYLOAD_TYPE, 'application/vnd.in-toto+json');
});

test('predicateType 必须是固定字符串（变更即升版本）', () => {
  const { bytes } = makeAttestationBytes({ predicateType: 'https://slsa.dev/provenance/v1' });
  expectViolation('E_PREDICATE_TYPE', () => parseAttestationForForensics(bytes));
  assert.equal(PREDICATE_TYPE, 'https://geoly.ai/skills-hub/release/v1');
});

test('signatures 必须非空，且 sig 是严格 base64', () => {
  expectViolation('E_DSSE_SIGNATURES', () => parseAttestationForForensics(makeAttestationBytes({ signatures: [] }).bytes));
  expectViolation('E_B64', () => parseAttestationForForensics(makeAttestationBytes({ signatures: [{ sig: 'not base64!!' }] }).bytes));
});

test('subject 必须恰好一项（一个 attestation 只绑一张快照）', () => {
  const two = [{ name: 'hub-42.json', digest: { sha256: hex(3) } }, { name: 'hub-43.json', digest: { sha256: hex(4) } }];
  expectViolation('E_SUBJECT_COUNT', () => parseAttestationForForensics(makeAttestationBytes({ subject: two }).bytes));
  expectViolation('E_SUBJECT_COUNT', () => parseAttestationForForensics(makeAttestationBytes({ subject: [] }).bytes));
});

test('subject digest 必须是 64 位小写 hex（不带 sha256: 前缀）', () => {
  const bad = [{ name: 'hub-42.json', digest: { sha256: `sha256:${hex(3)}` } }];
  expectViolation('E_SUBJECT_DIGEST', () => parseAttestationForForensics(makeAttestationBytes({ subject: bad }).bytes));
});

test('🔴 workflowRef 用 @refs/heads/main 被拒（分支引用可变，写它等于没写）', () => {
  const { bytes } = makeAttestationBytes({ predicate: { workflowRef: '.github/workflows/release.yml@refs/heads/main' } });
  const e = expectViolation('E_WORKFLOW_REF_MUTABLE', () => parseAttestationForForensics(bytes));
  assert.match(e.message, /必须钉 40 位 commit sha/);
});

test('🔴 workflowRef 用 tag 也被拒', () => {
  const { bytes } = makeAttestationBytes({ predicate: { workflowRef: '.github/workflows/release.yml@refs/tags/v1' } });
  expectViolation('E_WORKFLOW_REF_MUTABLE', () => parseAttestationForForensics(bytes));
});

test('workflowRef 指向别的 workflow 文件被拒', () => {
  const { bytes } = makeAttestationBytes({ predicate: { workflowRef: `.github/workflows/timestamp.yml@${COMMIT}` } });
  expectViolation('E_WORKFLOW_REF', () => parseAttestationForForensics(bytes));
});

test('🔴 workflowRef 钉的 commit 与 sourceCommit 不一致被拒', () => {
  const other = 'a'.repeat(40);
  const { bytes } = makeAttestationBytes({ predicate: { workflowRef: `.github/workflows/release.yml@${other}` } });
  expectViolation('E_WORKFLOW_REF_COMMIT', () => parseAttestationForForensics(bytes));
});

test('sourceCommit 必须是 40 位小写 hex，不能是 tag', () => {
  const { bytes } = makeAttestationBytes({ predicate: { sourceCommit: 'v1.0.0', workflowRef: `.github/workflows/release.yml@${COMMIT}` } });
  expectViolation('E_SOURCE_COMMIT', () => parseAttestationForForensics(bytes));
});

test('sourceRepo 必须是内置常量', () => {
  const { bytes } = makeAttestationBytes({ predicate: { sourceRepo: 'evil/hub' } });
  expectViolation('E_SOURCE_REPO', () => parseAttestationForForensics(bytes));
});

test('predicate 未知字段被拒', () => {
  const { bytes } = makeAttestationBytes({ predicate: { extra: 1 } });
  expectViolation('E_WIRE_UNKNOWN_FIELD', () => parseAttestationForForensics(bytes));
});

test('🔴 subject 摘要与 timestamp.snapshot_sha256 不一致 → 完整性事件（退出码 2）', () => {
  const { bytes } = makeAttestationBytes();
  const e = expectViolation('E_ATTEST_SUBJECT_MISMATCH',
    () => parseAttestationForForensics(bytes, { expectSnapshotSha256: `sha256:${hex(9)}` }));
  assert.equal(e.code, 2);
});

test('subject.name 必须是 hub-<N>.json', () => {
  const { bytes } = makeAttestationBytes();
  expectViolation('E_ATTEST_SUBJECT_NAME', () => parseAttestationForForensics(bytes, { expectSnapshotN: 43 }));
});

test('payload 的 base64 必须 canonical（非标准填充被拒）', () => {
  const env = { payload: 'YQ', payloadType: DSSE_PAYLOAD_TYPE, signatures: [{ sig: 'c2ln' }] };
  expectViolation('E_B64', () => parseAttestationForForensics(Buffer.from(stringify(env))));
});
