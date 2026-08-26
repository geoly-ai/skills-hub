// attestation（02-registry.md §1.1）—— DSSE envelope + in-toto statement
//
// 🔴 **安装链路不读它。** 它只服务取证：绑定「快照的 sha256 ↔ 源 commit」，
// 单向依赖（source commit → snapshot → attestation），不构成自引用。
// P0-1 把 release commit SHA 从快照里删掉了（那会自引用），代价是失去
// 「哪条流水线生成了它」的强审计；补回来的方式不是塞回快照，而是另发这个签名对象。
//
// 本模块**不导出**任何会被安装链路调用的名字，函数名里带 ForForensics 就是提醒。
import {
  WireError, IntegrityError, REPO,
  parseWireJson, assertExactKeys, assertUint, assertString, assertTreeDigest,
} from './trust.mjs';

export const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const PREDICATE_TYPE = 'https://geoly.ai/skills-hub/release/v1';
export const BUILD_TYPE = 'geoly-skills/release/v1';
export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';

const RE_COMMIT = /^[0-9a-f]{40}$/;
const RE_HEX64 = /^[0-9a-f]{64}$/;
const RE_B64 = /^[A-Za-z0-9+/]*={0,2}$/;

const ENVELOPE_KEYS = { required: ['payload', 'payloadType', 'signatures'] };
const SIG_KEYS = { required: ['sig'], optional: ['keyid'] };
const STATEMENT_KEYS = { required: ['_type', 'subject', 'predicateType', 'predicate'] };
const SUBJECT_KEYS = { required: ['name', 'digest'] };
const PREDICATE_KEYS = { required: ['buildType', 'sourceRepo', 'sourceCommit', 'workflowRef', 'promotionPr'] };

/** DSSE 的 PAE 预认证编码 —— 验签器要签的就是这串字节 */
export function pae(payloadType, payload) {
  const t = Buffer.from(payloadType, 'utf8');
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${t.length} `, 'utf8'), t,
    Buffer.from(` ${p.length} `, 'utf8'), p,
  ]);
}

/** 严格 base64：拒绝空白、换行、非标准字母表、非 canonical 填充 */
function decodeB64Strict(s, where) {
  assertString(s, where);
  if (!RE_B64.test(s) || s.length % 4 !== 0) throw new WireError('E_B64', `${where} 不是严格 base64`);
  const buf = Buffer.from(s, 'base64');
  if (buf.toString('base64') !== s) throw new WireError('E_B64', `${where} 的 base64 不是 canonical 形式`);
  return buf;
}

/**
 * 解析并严格校验一个 attestation。
 *
 * 🔴 **只用于取证**（02-registry.md §1.1 的契约表：「验证者 = 取证工具与人；
 * CLI 的安装链路不读」）。把它接进安装链路等于把一个不参与信任的对象变成信任输入。
 *
 * @param {Buffer} bytes DSSE envelope 的 JSON 字节
 * @param {{expectSnapshotSha256?:string, expectSnapshotN?:number}} expect
 */
export function parseAttestationForForensics(bytes, { expectSnapshotSha256, expectSnapshotN } = {}) {
  const env = parseWireJson(bytes, 'attestation');
  assertExactKeys(env, ENVELOPE_KEYS, 'attestation');
  if (env.payloadType !== DSSE_PAYLOAD_TYPE) {
    throw new WireError('E_DSSE_PAYLOAD_TYPE', `payloadType 必须是 ${DSSE_PAYLOAD_TYPE}，得到 ${JSON.stringify(env.payloadType)}`);
  }
  if (!Array.isArray(env.signatures) || env.signatures.length === 0) {
    throw new WireError('E_DSSE_SIGNATURES', 'signatures 必须是非空数组');
  }
  env.signatures.forEach((s, i) => {
    assertExactKeys(s, SIG_KEYS, `attestation.signatures[${i}]`);
    decodeB64Strict(s.sig, `attestation.signatures[${i}].sig`);
    if (Object.hasOwn(s, 'keyid')) assertString(s.keyid, `attestation.signatures[${i}].keyid`);
  });

  const payload = decodeB64Strict(env.payload, 'attestation.payload');
  const stmt = parseWireJson(payload, 'attestation.payload');
  assertExactKeys(stmt, STATEMENT_KEYS, 'attestation.payload');
  if (stmt._type !== STATEMENT_TYPE) {
    throw new WireError('E_STATEMENT_TYPE', `_type 必须是 ${STATEMENT_TYPE}，得到 ${JSON.stringify(stmt._type)}`);
  }
  if (stmt.predicateType !== PREDICATE_TYPE) {
    throw new WireError('E_PREDICATE_TYPE', `predicateType 必须是固定字符串 ${PREDICATE_TYPE}（变更即升版本）`);
  }
  if (!Array.isArray(stmt.subject) || stmt.subject.length !== 1) {
    throw new WireError('E_SUBJECT_COUNT', 'subject 必须恰好一项（一个 attestation 只绑一张快照）');
  }
  const sub = stmt.subject[0];
  assertExactKeys(sub, SUBJECT_KEYS, 'attestation.subject[0]');
  assertString(sub.name, 'attestation.subject[0].name');
  assertExactKeys(sub.digest, { required: ['sha256'] }, 'attestation.subject[0].digest');
  if (!RE_HEX64.test(assertString(sub.digest.sha256, 'attestation.subject[0].digest.sha256'))) {
    throw new WireError('E_SUBJECT_DIGEST', 'subject[0].digest.sha256 必须是 64 位小写 hex');
  }

  const p = stmt.predicate;
  assertExactKeys(p, PREDICATE_KEYS, 'attestation.predicate');
  if (p.buildType !== BUILD_TYPE) throw new WireError('E_BUILD_TYPE', `buildType 必须是 ${BUILD_TYPE}`);
  if (p.sourceRepo !== REPO) throw new WireError('E_SOURCE_REPO', `sourceRepo 必须是 ${REPO}，得到 ${p.sourceRepo}`);
  if (!RE_COMMIT.test(assertString(p.sourceCommit, 'attestation.predicate.sourceCommit'))) {
    throw new WireError('E_SOURCE_COMMIT', `sourceCommit 必须是 40 位小写 hex，得到 ${p.sourceCommit}`);
  }
  assertUint(p.promotionPr, 'attestation.predicate.promotionPr');

  // 🔴 workflowRef 必须是**不可变标识**：`.github/workflows/release.yml@<40 位 sha>`。
  //    **不接受 `@refs/heads/main`** —— 分支引用本身可变，写它等于没写。
  const wf = assertString(p.workflowRef, 'attestation.predicate.workflowRef');
  if (/@refs\/(heads|tags)\//.test(wf)) {
    throw new WireError('E_WORKFLOW_REF_MUTABLE',
      `workflowRef 用了可变的分支/标签引用（${wf}）：必须钉 40 位 commit sha`);
  }
  const m = /^\.github\/workflows\/release\.yml@([0-9a-f]{40})$/.exec(wf);
  if (!m) {
    throw new WireError('E_WORKFLOW_REF', `workflowRef 必须形如 .github/workflows/release.yml@<40 位小写 hex>，得到 ${wf}`);
  }
  // 规格给的示例里两者相同；这里强制相等，否则「哪条流水线」与「哪个源 commit」可以各说各话。
  if (m[1] !== p.sourceCommit) {
    throw new WireError('E_WORKFLOW_REF_COMMIT',
      `workflowRef 钉的 commit(${m[1]}) 与 sourceCommit(${p.sourceCommit}) 不一致`);
  }

  // 与 timestamp 交叉核对（契约表：subject[].digest.sha256 必须与 timestamp.snapshot_sha256 一致）
  if (expectSnapshotSha256 !== undefined) {
    const want = expectSnapshotSha256.replace(/^sha256:/, '');
    if (sub.digest.sha256 !== want) {
      throw new IntegrityError('E_ATTEST_SUBJECT_MISMATCH',
        `attestation 的 subject 摘要 ${sub.digest.sha256} 与 timestamp.snapshot_sha256 ${want} 不一致`);
    }
  }
  if (expectSnapshotN !== undefined && sub.name !== `hub-${expectSnapshotN}.json`) {
    throw new IntegrityError('E_ATTEST_SUBJECT_NAME',
      `attestation 的 subject.name 是 ${sub.name}，期望 hub-${expectSnapshotN}.json`);
  }

  return { envelope: env, statement: stmt, predicate: p, subject: sub, pae: pae(env.payloadType, payload) };
}

// `assertTreeDigest` 在本模块用不到，但 re-export 会诱使调用方从这里拿安装用的校验器。
// 故意不 re-export —— 保持「attestation 不在安装链路上」这条边界清晰。
void assertTreeDigest;
