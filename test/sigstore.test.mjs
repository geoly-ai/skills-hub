// 真 Sigstore 验签器：正例 + 每一类伪造，各自断言**具体的违规码**。
//
// 🔴 这里用的是**真的** `@sigstore/verify`，喂给它一整套合成 PKI
//    （见 `fixtures/sigstore-pki.mjs`）。所以下面每一条「应当失败」都是
//    真实的密码学检查在拒绝，不是我们的胶水代码在自说自话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSigstoreVerifier, trustMaterialFrom } from '../src/sigstore.mjs';
import {
  verifySigned, isVerified, resolveCurrent, readHistoricalSnapshot,
  RELEASE_IDENTITY, TIMESTAMP_IDENTITY, OIDC_ISSUER,
} from '../src/snapshot.mjs';
import { sha256Of } from '../src/trust.mjs';
import {
  makePKI, makeBundle, makeDsseBundle, makePublicKeyBundle, makeCA, newKey,
} from './fixtures/sigstore-pki.mjs';
import { makeRecord, makeSnapshotDoc, makeTimestampDoc, bytesOf, NOW } from './fixtures/trustchain-objects.mjs';

function expectViolation(want, fn) {
  try { fn(); } catch (e) {
    assert.equal(e.violation, want, `期望违规 ${want}，实际 ${e.violation}：${e.message}`);
    return e;
  }
  assert.fail(`期望违规 ${want}，但没有抛错`);
}

const PKI = makePKI();
const BYTES = Buffer.from('{"schema":"geoly.skills.snapshot/2"}', 'utf8');
const verifier = createSigstoreVerifier({ trustedRoot: PKI.trustedRoot });

/** 造一份「本该通过」的 bundle，再用 over 把某一处弄坏 */
const bundleFor = (identity, over = {}) =>
  makeBundle({ bytes: BYTES, identity, issuer: OIDC_ISSUER, pki: PKI, ...over });

const run = (bundle, expectIdentity = RELEASE_IDENTITY, bytes = BYTES) =>
  verifier({ bytes, bundle, expectIdentity, expectIssuer: OIDC_ISSUER });

// ── 正例 ────────────────────────────────────────────────────────────────────

test('正例：release.yml 身份签的 snapshot 字节，真验签器通过', () => {
  const r = run(bundleFor(RELEASE_IDENTITY));
  assert.equal(r.ok, true);
  assert.equal(r.identity, RELEASE_IDENTITY);
  assert.equal(r.issuer, OIDC_ISSUER);
  assert.equal(r.sha256, sha256Of(BYTES));
});

test('正例：timestamp.yml 身份也通过（两个身份各自成立）', () => {
  const r = run(bundleFor(TIMESTAMP_IDENTITY), TIMESTAMP_IDENTITY);
  assert.equal(r.identity, TIMESTAMP_IDENTITY);
});

test('正例：接进 verifySigned() 能拿到 branded VerifiedBytes', () => {
  const v = verifySigned({
    bytes: BYTES, bundle: bundleFor(RELEASE_IDENTITY),
    expectIdentity: RELEASE_IDENTITY, verifier, where: 'snapshot',
  });
  assert.ok(isVerified(v));
  assert.equal(v.identity, RELEASE_IDENTITY);
  assert.ok(v.bytes.equals(BYTES));
});

// ── 🔴 反恒真：验签器必须真的会拒 ───────────────────────────────────────────
//
// 「一个恒返回成功的验签器」是这一整块最危险的失败模式。下面三条是它的
// 直接证伪：身份、issuer、字节各错一次，必须各自失败在**不同的**违规码上。

test('🔴 反恒真：证书里的身份换成别的 → E_IDENTITY_MISMATCH', () => {
  const e = expectViolation('E_IDENTITY_MISMATCH',
    () => run(bundleFor('https://github.com/evil/repo/.github/workflows/release.yml@refs/heads/main')));
  assert.match(e.message, /精确比对/);
});

test('🔴 反恒真：证书里的 issuer 换成别的 → E_ISSUER_MISMATCH', () => {
  expectViolation('E_ISSUER_MISMATCH', () => {
    const b = makeBundle({ bytes: BYTES, identity: RELEASE_IDENTITY, issuer: 'https://evil.example', pki: PKI });
    run(b);
  });
});

test('🔴 反恒真：拿别的字节的 bundle 来验 → E_BUNDLE_DIGEST_MISMATCH', () => {
  expectViolation('E_BUNDLE_DIGEST_MISMATCH',
    () => run(bundleFor(RELEASE_IDENTITY, { signBytes: Buffer.from('别的字节') })));
});

test('🔴 反恒真：摘要谎称对得上、签名却是签在别的字节上 → 签名验证失败', () => {
  // 绕过我们自己的摘要预检（digestBytes 让 messageDigest 谎称是 BYTES 的），
  // 于是必须由**真正的签名验证**把它挡下来。
  const e = expectViolation('E_SIGSTORE_VERIFY',
    () => run(bundleFor(RELEASE_IDENTITY, { signBytes: Buffer.from('别的字节'), digestBytes: BYTES })));
  assert.match(e.message, /TLOG_BODY_ERROR|SIGNATURE_ERROR/);
});

test('🔴 反恒真：只有最终的 artifact 签名是坏的 → SIGNATURE_ERROR', () => {
  // Codex 第二轮指出：上一条虽然过了，但它其实是被 `verifyTLogBody` 拦下的，
  // **根本没走到** `verifySignature(artifact)`。这一条专门补那一步：
  // 摘要、tlog body 的签名与摘要**全都自洽**，只有签名本身是用别的私钥签的。
  const e = expectViolation('E_SIGSTORE_VERIFY',
    () => run(bundleFor(RELEASE_IDENTITY, { wrongSigningKey: newKey() })));
  assert.match(e.message, /SIGNATURE_ERROR/,
    `本该走到最终 artifact 签名校验，实际停在：${e.message}`);
});

test('🔴 反恒真：换一套完全独立的 PKI（CA 不在 trusted root 里）→ 拒绝', () => {
  // 这条证明验签器**真的在用 trusted root**，而不是「谁签的都收」。
  const other = makePKI();
  const b = makeBundle({ bytes: BYTES, identity: RELEASE_IDENTITY, issuer: OIDC_ISSUER, pki: other });
  const e = expectViolation('E_SIGSTORE_VERIFY', () => run(b));
  assert.match(e.message, /CERTIFICATE_ERROR/);
  // 反过来：同一份 bundle 在它自己的 trusted root 下是通得过的 ——
  // 所以上面失败的原因确实是信任根，不是 bundle 本身有毛病。
  const otherVerifier = createSigstoreVerifier({ trustedRoot: other.trustedRoot });
  assert.equal(otherVerifier({ bytes: BYTES, bundle: b, expectIdentity: RELEASE_IDENTITY, expectIssuer: OIDC_ISSUER }).ok, true);
});

// ── 🔴 两个 OIDC 身份不可互换（§8） ─────────────────────────────────────────

test('🔴 用 release.yml 身份签的 bundle 当 timestamp 用 → 拒绝', () => {
  expectViolation('E_IDENTITY_MISMATCH', () => run(bundleFor(RELEASE_IDENTITY), TIMESTAMP_IDENTITY));
});

test('🔴 用 timestamp.yml 身份签的 bundle 当 snapshot 用 → 拒绝', () => {
  expectViolation('E_IDENTITY_MISMATCH', () => run(bundleFor(TIMESTAMP_IDENTITY), RELEASE_IDENTITY));
});

// ── 🔴 身份不能被通配 / 前后缀糊弄 ──────────────────────────────────────────
//
// `@sigstore/verify` 的 `verifySubjectAlternativeName` 是
// `signerIdentity.match(policyIdentity)` —— 把期望身份当**正则**且**不锚定**。
// 我们因此完全不用它的 policy，只做 `===`。下面把那些「库会放过、我们必须拒」
// 的串逐条钉死。

const FOOLERS = [
  // `.` 当通配：`/.github/` 里的点匹配任意字符
  ['https://github.com/geoly-ai/skills-hub/Xgithub/workflows/release.yml@refs/heads/main', '`.` 当通配符'],
  // 不锚定 → 后缀糊弄
  [`${RELEASE_IDENTITY}-EVIL`, '后缀糊弄'],
  [`${RELEASE_IDENTITY}.evil.example`, '后缀加域名'],
  // 不锚定 → 前缀糊弄
  [`https://evil.example/?x=${RELEASE_IDENTITY}`, '前缀糊弄'],
  // 大小写
  [RELEASE_IDENTITY.replace('release.yml', 'RELEASE.yml'), '大小写变体'],
  // 分支不同
  [RELEASE_IDENTITY.replace('refs/heads/main', 'refs/heads/attacker'), '换分支'],
];

for (const [san, why] of FOOLERS) {
  test(`🔴 身份糊弄（${why}）必须被拒：${san.slice(0, 60)}…`, () => {
    expectViolation('E_IDENTITY_MISMATCH', () => run(bundleFor(san)));
  });
}

test('🔴 证据：上面那些串确实能骗过库自带的 policy（所以我们绝不能用它）', async () => {
  const { PolicyError } = await import('@sigstore/verify');
  const { verifySubjectAlternativeName } = await import('@sigstore/verify/dist/policy.js');
  let fooled = 0;
  for (const [san] of FOOLERS) {
    try { verifySubjectAlternativeName(RELEASE_IDENTITY, san); fooled++; } catch (e) {
      assert.ok(e instanceof PolicyError);
    }
  }
  // 至少那几条「不锚定 / `.` 当通配」的必须真的骗过它 —— 否则这条推理就过期了，
  // 该重读库的实现，而不是把测试改绿。
  assert.ok(fooled >= 3, `库的 policy 只被骗过 ${fooled} 条：实现可能变了，重新评估`);
  void PolicyError;
});

// ── 证书链 / SCT ────────────────────────────────────────────────────────────

test('SCT 用错误的 CT log 密钥签 → 拒绝', () => {
  const e = expectViolation('E_SIGSTORE_VERIFY',
    () => run(bundleFor(RELEASE_IDENTITY, { leafOpts: { ctSignerKey: newKey() } })));
  assert.match(e.message, /CERTIFICATE_ERROR/);
});

test('叶子证书根本没有 SCT → 拒绝（ctlogThreshold=1）', () => {
  const e = expectViolation('E_SIGSTORE_VERIFY',
    () => run(bundleFor(RELEASE_IDENTITY, { leafOpts: { omitSct: true } })));
  assert.match(e.message, /expected 1 SCTs, got 0/);
});

test('叶子证书由别的 CA 签发（但 SCT 仍是我们的 CT log）→ 拒绝', () => {
  const rogue = makeCA({ cn: 'rogue-fulcio' });
  const e = expectViolation('E_SIGSTORE_VERIFY', () => {
    const b = makeBundle({
      bytes: BYTES, identity: RELEASE_IDENTITY, issuer: OIDC_ISSUER,
      pki: { ...PKI, ca: rogue },
    });
    run(b);
  });
  assert.match(e.message, /CERTIFICATE_ERROR/);
});

test('证书在 Rekor 的 integratedTime 时点已过期 → 拒绝', () => {
  const e = expectViolation('E_SIGSTORE_VERIFY', () => run(bundleFor(RELEASE_IDENTITY, {
    leafOpts: { notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2026-01-02T00:00:00Z') },
  })));
  // `describe()` 把 cause 链摊平，所以「过期」与「CA 不认识」在日志里可区分
  assert.match(e.message, /not valid or expired/, `诊断信息丢了 cause：${e.message}`);
});

test('证书没有 SAN → E_NO_SAN（不是「身份为空所以放行」）', () => {
  expectViolation('E_NO_SAN', () => run(bundleFor(RELEASE_IDENTITY, { leafOpts: { omitSan: true } })));
});

test('证书没有 Fulcio issuer 扩展 → E_NO_ISSUER', () => {
  expectViolation('E_NO_ISSUER', () => run(bundleFor(RELEASE_IDENTITY, { leafOpts: { omitIssuerExt: true } })));
});

// ── Rekor 透明日志 ──────────────────────────────────────────────────────────

test('inclusion promise（SET）用错误的 Rekor 密钥签 → 拒绝', () => {
  const e = expectViolation('E_SIGSTORE_VERIFY',
    () => run(bundleFor(RELEASE_IDENTITY, { entryOpts: { setSignerKey: newKey() } })));
  assert.match(e.message, /TLOG_INCLUSION_PROMISE_ERROR/);
});

test('checkpoint 用错误的密钥签 → 拒绝', () => {
  const e = expectViolation('E_SIGSTORE_VERIFY',
    () => run(bundleFor(RELEASE_IDENTITY, { entryOpts: { checkpointSignerKey: newKey() } })));
  assert.match(e.message, /invalid checkpoint signature/);
});

test('Merkle root 对不上叶子哈希 → 拒绝（包含证明真的验了）', () => {
  const e = expectViolation('E_SIGSTORE_VERIFY',
    () => run(bundleFor(RELEASE_IDENTITY, { entryOpts: { tamperRootHash: true } })));
  assert.match(e.message, /TLOG_INCLUSION_PROOF_ERROR/);
});

test('tlog body 里的签名被改 → 拒绝', () => {
  const e = expectViolation('E_SIGSTORE_VERIFY',
    () => run(bundleFor(RELEASE_IDENTITY, { entryOpts: { tamperBodySignature: true } })));
  assert.match(e.message, /TLOG/);
});

test('tlog body 里的摘要被改 → 拒绝', () => {
  const e = expectViolation('E_SIGSTORE_VERIFY',
    () => run(bundleFor(RELEASE_IDENTITY, { entryOpts: { tamperBodyDigest: true } })));
  assert.match(e.message, /TLOG/);
});

test('bundle 里没有任何 tlog 条目 → E_NO_TLOG_ENTRY', () => {
  const b = bundleFor(RELEASE_IDENTITY);
  b.verificationMaterial.tlogEntries = [];
  expectViolation('E_NO_TLOG_ENTRY', () => run(b));
});

test('只有 inclusion promise、没有包含证明 → E_NO_INCLUSION_PROOF', () => {
  expectViolation('E_NO_INCLUSION_PROOF',
    () => run(bundleFor(RELEASE_IDENTITY, { entryOpts: { omitInclusionProof: true }, mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.1' })));
});

test('🔴 mediaType 降级到 v0.1 骗不掉包含证明的要求', () => {
  // `bundleFromJSON` 只在 v0.3 下强制包含证明，而 mediaType 是 bundle 里的
  // 一个字段、**由对手控制**。我们对已解析结构自己查一遍，与声明的版本无关。
  expectViolation('E_NO_INCLUSION_PROOF', () => run(bundleFor(RELEASE_IDENTITY, {
    entryOpts: { omitInclusionProof: true },
    mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.1',
  })));
});

test('包含证明缺 checkpoint → E_NO_INCLUSION_PROOF', () => {
  // 用 v0.1 媒体类型让它先过得了 `bundleFromJSON`（v0.3 会自己先拒），
  // 好确认**我们这一层**也拦得住，而不是只靠库的版本校验。
  const b = bundleFor(RELEASE_IDENTITY, { mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.1' });
  delete b.verificationMaterial.tlogEntries[0].inclusionProof.checkpoint;
  expectViolation('E_NO_INCLUSION_PROOF', () => run(b));
});

test('v0.3 bundle 缺包含证明时，库自己也会先拒 → E_BUNDLE_MALFORMED', () => {
  const b = bundleFor(RELEASE_IDENTITY);
  delete b.verificationMaterial.tlogEntries[0].inclusionProof;
  expectViolation('E_BUNDLE_MALFORMED', () => run(b));
});

// ── bundle 形态 ─────────────────────────────────────────────────────────────

test('🔴 DSSE envelope 形态被拒：它的签名与待验字节没有绑定', () => {
  const b = makeDsseBundle({ bytes: BYTES, identity: RELEASE_IDENTITY, issuer: OIDC_ISSUER, pki: PKI });
  expectViolation('E_BUNDLE_NOT_MESSAGE_SIGNATURE', () => run(b));
});

test('🔴 裸公钥形态被拒：没有证书就没有身份可判', () => {
  const b = makePublicKeyBundle({ bytes: BYTES, pki: PKI });
  expectViolation('E_BUNDLE_NO_CERT', () => run(b));
});

test('messageDigest 的算法被降级 → E_BUNDLE_DIGEST_ALGO', () => {
  expectViolation('E_BUNDLE_DIGEST_ALGO',
    () => run(bundleFor(RELEASE_IDENTITY, { digestAlgorithm: 'SHA2_512' })));
});

test('bundle 不是对象 / 结构非法 → E_BUNDLE_MALFORMED', () => {
  expectViolation('E_BUNDLE_MALFORMED', () => run(null));
  expectViolation('E_BUNDLE_MALFORMED', () => run([]));
  expectViolation('E_BUNDLE_MALFORMED', () => run({}));
  expectViolation('E_BUNDLE_MALFORMED', () => run({ mediaType: 'text/plain' }));
});

// ── 构造期的 fail-closed ────────────────────────────────────────────────────

test('没有 trusted root 就造不出验签器 → E_TRUST_ROOT', () => {
  expectViolation('E_TRUST_ROOT', () => createSigstoreVerifier({}));
  expectViolation('E_TRUST_ROOT', () => createSigstoreVerifier({ trustedRoot: null }));
  expectViolation('E_TRUST_ROOT', () => trustMaterialFrom('{ 不是 json'));
  expectViolation('E_TRUST_ROOT', () => trustMaterialFrom({ mediaType: 'x', tlogs: [], ctlogs: [], certificateAuthorities: [], timestampAuthorities: [] }));
});

test('🔴 阈值 0 是个逃生口，禁掉 → E_VERIFIER_CONFIG', () => {
  expectViolation('E_VERIFIER_CONFIG', () => createSigstoreVerifier({ trustedRoot: PKI.trustedRoot, tlogThreshold: 0 }));
  expectViolation('E_VERIFIER_CONFIG', () => createSigstoreVerifier({ trustedRoot: PKI.trustedRoot, ctlogThreshold: 0 }));
});

test('输入参数不合法即拒，不猜 → E_VERIFIER_INPUT', () => {
  const b = bundleFor(RELEASE_IDENTITY);
  expectViolation('E_VERIFIER_INPUT', () => verifier({ bytes: 'not a buffer', bundle: b, expectIdentity: RELEASE_IDENTITY, expectIssuer: OIDC_ISSUER }));
  expectViolation('E_VERIFIER_INPUT', () => verifier({ bytes: BYTES, bundle: b, expectIdentity: '', expectIssuer: OIDC_ISSUER }));
  expectViolation('E_VERIFIER_INPUT', () => verifier({ bytes: BYTES, bundle: b, expectIdentity: RELEASE_IDENTITY, expectIssuer: '' }));
});

// ── 接进完整验证链（§6 第 1–6 步） ──────────────────────────────────────────

test('🔴 端到端：resolveCurrent() 用真验签器跑通整条链', () => {
  const snapDoc = makeSnapshotDoc([makeRecord()], { snapshot: 42, previous: 41 });
  const snapBytes = bytesOf(snapDoc);
  const tsDoc = makeTimestampDoc({ latest_snapshot: 42, snapshot_sha256: sha256Of(snapBytes) });
  const tsBytes = bytesOf(tsDoc);

  const r = resolveCurrent({
    stateDir: mkdtempSync(join(tmpdir(), 'geoly-sigstore-')),
    fetchTimestamp: () => ({ bytes: tsBytes, bundle: makeBundle({ bytes: tsBytes, identity: TIMESTAMP_IDENTITY, issuer: OIDC_ISSUER, pki: PKI }) }),
    fetchSnapshot: () => ({ bytes: snapBytes, bundle: makeBundle({ bytes: snapBytes, identity: RELEASE_IDENTITY, issuer: OIDC_ISSUER, pki: PKI }) }),
    verifier, cliVersion: '9.9.9', now: NOW,
  });
  assert.equal(r.snapshot.snapshot, 42);
  assert.equal(r.timestamp.version, 137);
});

test('🔴 端到端：timestamp 用 release.yml 身份签 → 整条链在第 1 步就断', () => {
  const snapDoc = makeSnapshotDoc([makeRecord()], { snapshot: 42, previous: 41 });
  const snapBytes = bytesOf(snapDoc);
  const tsBytes = bytesOf(makeTimestampDoc({ latest_snapshot: 42, snapshot_sha256: sha256Of(snapBytes) }));
  expectViolation('E_IDENTITY_MISMATCH', () => resolveCurrent({
    stateDir: mkdtempSync(join(tmpdir(), 'geoly-sigstore-')),
    // 身份用错 —— 这份 bundle 本身完全合法，只是签名者不对
    fetchTimestamp: () => ({ bytes: tsBytes, bundle: makeBundle({ bytes: tsBytes, identity: RELEASE_IDENTITY, issuer: OIDC_ISSUER, pki: PKI }) }),
    fetchSnapshot: () => { assert.fail('第 1 步就该断，不该走到取快照'); },
    verifier, cliVersion: '9.9.9', now: NOW,
  }));
});

test('🔴 端到端：历史快照路径同样要过真验签', () => {
  const snapBytes = bytesOf(makeSnapshotDoc([makeRecord()], { snapshot: 7, previous: 6 }));
  const ok = readHistoricalSnapshot({
    bytes: snapBytes, expectSnapshot: 7, verifier,
    bundle: makeBundle({ bytes: snapBytes, identity: RELEASE_IDENTITY, issuer: OIDC_ISSUER, pki: PKI }),
  });
  assert.equal(ok.snapshot.snapshot, 7);
  expectViolation('E_IDENTITY_MISMATCH', () => readHistoricalSnapshot({
    bytes: snapBytes, expectSnapshot: 7, verifier,
    bundle: makeBundle({ bytes: snapBytes, identity: TIMESTAMP_IDENTITY, issuer: OIDC_ISSUER, pki: PKI }),
  }));
});

// ── 离线性质 ────────────────────────────────────────────────────────────────

test('🔴 验签全程不出网：`--offline` 下也能验', async () => {
  // 把 TCP 出口打掉，再跑一遍正例。只要验签器偷偷联网
  //（Fulcio / Rekor / TUF），这条就会炸。
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const net = require('node:net');
  const tls = require('node:tls');
  const dns = require('node:dns');
  const boom = () => { throw new Error('验签器试图出网'); };
  const saved = [
    [net.Socket.prototype, 'connect', net.Socket.prototype.connect],
    [net, 'connect', net.connect],
    [tls, 'connect', tls.connect],
    [dns, 'lookup', dns.lookup],
  ];
  for (const [obj, key] of saved) obj[key] = boom;
  try {
    process.env.GEOLY_OFFLINE = '1';
    const v = createSigstoreVerifier({ trustedRoot: PKI.trustedRoot });
    assert.equal(
      v({ bytes: BYTES, bundle: bundleFor(RELEASE_IDENTITY), expectIdentity: RELEASE_IDENTITY, expectIssuer: OIDC_ISSUER }).ok,
      true,
    );
  } finally {
    for (const [obj, key, orig] of saved) obj[key] = orig;
    delete process.env.GEOLY_OFFLINE;
  }
});

// ── Codex 评审后补的口子 ────────────────────────────────────────────────────

test('🔴 oneof 歧义：同时给 messageSignature 与 dsseEnvelope → E_BUNDLE_ONEOF_AMBIGUOUS', () => {
  // protobuf parser 会按固定优先级挑一个、不报错。我们按一个分支判、别的工具
  // 按另一个分支判 —— 同一份 bundle 两种含义。歧义即拒。
  const b = bundleFor(RELEASE_IDENTITY);
  const d = makeDsseBundle({ bytes: BYTES, identity: RELEASE_IDENTITY, issuer: OIDC_ISSUER, pki: PKI });
  expectViolation('E_BUNDLE_ONEOF_AMBIGUOUS', () => run({ ...b, dsseEnvelope: d.dsseEnvelope }));
});

test('🔴 oneof 歧义：verificationMaterial 同时给 certificate 与 publicKey → 拒绝', () => {
  const b = bundleFor(RELEASE_IDENTITY);
  b.verificationMaterial.publicKey = { hint: 'x' };
  expectViolation('E_BUNDLE_ONEOF_AMBIGUOUS', () => run(b));
});

test('🔴 只有包含证明、没有可信时间来源 → E_NO_TRUSTED_TIME', () => {
  // 库只认 inclusion promise（SET）与 RFC3161 TSA 作为可信时间；包含证明**不提供时间**。
  // 不提前挡的话会报成一句看不懂的 `expected 1 timestamps, got 0`。
  const e = expectViolation('E_NO_TRUSTED_TIME',
    () => run(bundleFor(RELEASE_IDENTITY, { entryOpts: { omitInclusionPromise: true } })));
  assert.match(e.message, /包含证明本身不提供时间/);
});

test('🔴 tlog body 里的摘要算法被降级 → E_TLOG_BODY_DIGEST_ALGO', () => {
  // 库的 `verifyHashedRekordTLogBody()` 只比对摘要字节，**不看** algorithm 字段。
  const b = bundleFor(RELEASE_IDENTITY);
  const e0 = b.verificationMaterial.tlogEntries[0];
  const body = JSON.parse(Buffer.from(e0.canonicalizedBody, 'base64').toString('utf8'));
  body.spec.data.hash.algorithm = 'sha1';
  e0.canonicalizedBody = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  expectViolation('E_TLOG_BODY_DIGEST_ALGO', () => run(b));
});

test('tlog 条目的 kind / version 认不出就拒，不猜', () => {
  const b1 = bundleFor(RELEASE_IDENTITY);
  b1.verificationMaterial.tlogEntries[0].kindVersion.kind = 'dsse';
  expectViolation('E_TLOG_KIND', () => run(b1));

  const b2 = bundleFor(RELEASE_IDENTITY);
  b2.verificationMaterial.tlogEntries[0].kindVersion.version = '0.0.2';
  expectViolation('E_TLOG_BODY_VERSION', () => run(b2));
});

test('trusted root 缺 ctlogs → E_TRUST_ROOT（不拖到「SCT 验不过」才报）', () => {
  const noCt = { ...PKI.trustedRoot, ctlogs: [] };
  expectViolation('E_TRUST_ROOT', () => createSigstoreVerifier({ trustedRoot: noCt }));
});

// ── 🔴 对着**真实**的 Sigstore 生产信任根与真实 bundle 验一遍 ───────────────
//
// 上面那一整套合成 PKI 证明的是「验签器按 Sigstore 的规则办事」。
// 它证明不了「我们能吃下真实的公共实例信任根」，也证明不了「真实的 GitHub
// Actions Fulcio 证书能被我们正确读出身份」。这一节补这两条。
//
// 夹具来源（2026-08-26 取，均为公开数据）：
//   · `sigstore-trusted-root-prod.json` —— `@sigstore/tuf@5.0.0` 的 TUF seed 里
//     `https://tuf-repo-cdn.sigstore.dev` 的 `trusted_root.json` 目标。
//   · `sigstore-real-bundle.json` —— npm 上 `sigstore@5.0.0` 的 SLSA provenance
//     attestation bundle（由 GitHub Actions 的 keyless 流程真实签出）。

const { default: PROD_ROOT } = await import('./fixtures/sigstore-trusted-root-prod.json', { with: { type: 'json' } });
const { default: REAL_BUNDLE } = await import('./fixtures/sigstore-real-bundle.json', { with: { type: 'json' } });

/** 真实 bundle 是 DSSE，走不到我们的 verifier，这里直接用库把身份读出来 */
async function realSigner(root) {
  const { Verifier, toTrustMaterial, toSignedEntity } = await import('@sigstore/verify');
  const { bundleFromJSON } = await import('@sigstore/bundle');
  const { TrustedRoot } = await import('@sigstore/protobuf-specs');
  return new Verifier(toTrustMaterial(TrustedRoot.fromJSON(root)))
    .verify(toSignedEntity(bundleFromJSON(REAL_BUNDLE)));
}

test('🔴 真实的生产 trusted root 能被我们的加载器吃下', () => {
  const m = trustMaterialFrom(PROD_ROOT);
  assert.ok(m.certificateAuthorities.length > 0);
  assert.ok(m.tlogs.length > 0);
  assert.ok(m.ctlogs.length > 0);
  // 传 Buffer / 字符串也要能吃
  assert.ok(trustMaterialFrom(Buffer.from(JSON.stringify(PROD_ROOT))).tlogs.length > 0);
});

test('🔴 真实的 GitHub Actions bundle 在真实生产根下验得过，身份读得对', async () => {
  const signer = await realSigner(PROD_ROOT);
  // 注意这个 SAN 与我们 §8 的身份**形状完全一样**（同一条 GitHub Actions 流水线
  // 身份格式），只是仓库不同 —— 说明我们的身份提取逻辑对真证书成立。
  assert.equal(signer.identity.subjectAlternativeName,
    'https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main');
  assert.equal(signer.identity.extensions.issuer, OIDC_ISSUER);
});

test('🔴 换根就必须失败：真实 bundle 配我们的合成根 → 拒绝', async () => {
  // 这条是「测试是不是在自证」的直接证伪：如果验签器只是把我们塞给它的东西
  // 一律放行，这里就不会炸。
  await assert.rejects(async () => { await realSigner(PKI.trustedRoot); },
    (e) => /CERTIFICATE_ERROR|Failed to verify/.test(e.message));
});

test('🔴 换根就必须失败：合成 bundle 配真实生产根 → 拒绝', () => {
  const prodVerifier = createSigstoreVerifier({ trustedRoot: PROD_ROOT });
  const e = expectViolation('E_SIGSTORE_VERIFY', () => prodVerifier({
    bytes: BYTES, bundle: bundleFor(RELEASE_IDENTITY),
    expectIdentity: RELEASE_IDENTITY, expectIssuer: OIDC_ISSUER,
  }));
  assert.match(e.message, /CERTIFICATE_ERROR|TLOG/);
});

test('🔴 真实的 DSSE bundle 走我们的 verifier 必须被形态检查挡下', () => {
  const prodVerifier = createSigstoreVerifier({ trustedRoot: PROD_ROOT });
  expectViolation('E_BUNDLE_NOT_MESSAGE_SIGNATURE', () => prodVerifier({
    bytes: BYTES, bundle: REAL_BUNDLE,
    expectIdentity: RELEASE_IDENTITY, expectIssuer: OIDC_ISSUER,
  }));
});

test('🔴 真证书上的身份同样不能被正则糊弄', async () => {
  const signer = await realSigner(PROD_ROOT);
  const real = signer.identity.subjectAlternativeName;
  const { verifySubjectAlternativeName } = await import('@sigstore/verify/dist/policy.js');
  // 设想对手拿到一张 SAN 是 `real` 变体的真证书。期望身份（policy）是 `real`，
  // 证书上的身份（signer）是 fooler —— 库拿 policy 当正则去 match signer。
  for (const fooler of [
    real.replace('/.github/', '/Xgithub/'), // `.` 当通配
    `${real}-EVIL`,                         // 不锚定 → 后缀
    `https://evil.example/?x=${real}`,      // 不锚定 → 前缀
  ]) {
    verifySubjectAlternativeName(real, fooler); // 库：不抛 = 认了
    assert.notEqual(real, fooler);              // 我们：`===` 直接不等
  }
});

test('🔴 错误信息里的对手数据被消毒：不能靠 ANSI / 换行伪造日志', () => {
  // SAN 里塞进 ANSI 转义与换行，伪装成一行「验签通过」。
  const evil = 'https://evil.example' + '\u001b[2K\r\n\u001b[32m[OK] 验签通过 —— release.yml\u001b[0m';
  const e = expectViolation('E_IDENTITY_MISMATCH', () => run(bundleFor(evil)));
  assert.ok(!e.message.includes('\u001b'), '错误信息里还留着 ANSI 转义');
  assert.ok(!e.message.includes('\n'), '错误信息里还留着换行');
  assert.ok(!e.message.includes('\r'), '错误信息里还留着回车');
});

test('错误信息会截断超长的对手串', () => {
  const long = `https://evil.example/${'A'.repeat(5000)}`;
  const e = expectViolation('E_IDENTITY_MISMATCH', () => run(bundleFor(long)));
  assert.ok(e.message.length < 1000, `错误信息 ${e.message.length} 字，没截断`);
  assert.match(e.message, /已截断/);
});

test('🔴 只改 inclusionProof.rootHash（不动 checkpoint）→ E_PROOF_INCONSISTENT', () => {
  // 库的 `verifyMerkleInclusion()` 只读已签名 checkpoint 里的根，压根不看这个
  // 字段 —— 不自己查的话，这份自相矛盾的 bundle 会以 ok:true 通过。
  const b = bundleFor(RELEASE_IDENTITY);
  b.verificationMaterial.tlogEntries[0].inclusionProof.rootHash = Buffer.alloc(32, 0xab).toString('base64');
  expectViolation('E_PROOF_INCONSISTENT', () => run(b));
});

test('🔴 inclusionProof 的 treeSize / logIndex 与 checkpoint、条目不一致 → 拒绝', () => {
  const b1 = bundleFor(RELEASE_IDENTITY);
  b1.verificationMaterial.tlogEntries[0].inclusionProof.treeSize = '999';
  expectViolation('E_PROOF_INCONSISTENT', () => run(b1));

  const b2 = bundleFor(RELEASE_IDENTITY);
  b2.verificationMaterial.tlogEntries[0].inclusionProof.logIndex = '7';
  expectViolation('E_PROOF_INCONSISTENT', () => run(b2));
});

test('🔴 塞一大堆 tlog 条目做拒绝服务 → E_BUNDLE_TOO_LARGE（在做密码学之前）', () => {
  const b = bundleFor(RELEASE_IDENTITY);
  const one = b.verificationMaterial.tlogEntries[0];
  b.verificationMaterial.tlogEntries = Array.from({ length: 500 }, () => structuredClone(one));
  const t0 = Date.now();
  expectViolation('E_BUNDLE_TOO_LARGE', () => run(b));
  // 关键是它**没有**先把 500 条都验一遍（库的去重还是 O(n²)）
  assert.ok(Date.now() - t0 < 500, '超限的 bundle 不该先被拿去做密码学运算');
});

test('超大的 canonicalizedBody 被挡在解析之前 → E_BUNDLE_TOO_LARGE', () => {
  const b = bundleFor(RELEASE_IDENTITY);
  b.verificationMaterial.tlogEntries[0].canonicalizedBody =
    Buffer.alloc((1 << 20) + 1, 0x41).toString('base64');
  expectViolation('E_BUNDLE_TOO_LARGE', () => run(b));
});

// ── 内置信任根 ───────────────────────────────────────────────────────────────

test('🔴 内置信任根能加载，且真验签器接受它', async () => {
  const { loadBuiltinTrustedRoot, trustMaterialFrom } = await import('../src/sigstore.mjs');
  const root = loadBuiltinTrustedRoot();
  assert.equal(root.mediaType?.includes('trustedroot'), true, `不像 TUF 根：${root.mediaType}`);
  for (const k of ['tlogs', 'certificateAuthorities', 'ctlogs']) {
    assert.ok(Array.isArray(root[k]) && root[k].length > 0, `${k} 不能为空`);
  }
  assert.ok(trustMaterialFrom(root), '真验签器必须能吃下内置根');
});

test('🔴 内置根不接受任何外部覆盖', async () => {
  const { loadBuiltinTrustedRoot } = await import('../src/sigstore.mjs');
  // 函数不收参数：传了也不该改变结果。防的是「哪天有人加个 path 参数图方便」
  assert.equal(loadBuiltinTrustedRoot.length, 0, 'loadBuiltinTrustedRoot 不得接受参数');
  const a = JSON.stringify(loadBuiltinTrustedRoot());
  const b = JSON.stringify(loadBuiltinTrustedRoot('/tmp/evil-root.json'));
  assert.equal(a, b, '传参不得改变加载结果');
});

test('🔴 内置根被打包进发布物（package.json files 覆盖 src）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('src'), 'files 必须含 src，否则信任根不会随包发出去');
  // 依赖必须钉死：^ 浮动会让未来的 4.x 悄悄要求更高的 Node（见 R-5）
  assert.match(pkg.dependencies['@sigstore/verify'], /^\d+\.\d+\.\d+$/, '安全依赖必须钉死精确版本');
});

// ── 冗余字段一致性：拿真实 bundle 当判据 ────────────────────────────────────

test('🔴 真实 bundle 的包含证明必须通过一致性检查（分片下两个 logIndex 本就不等）', async () => {
  // 🔴 这条测试是补上一个**缺口**：夹具早就在仓库里，但没有任何测试把
  // assertProofSelfConsistent 跑在它上面。于是「logIndex 必须相等」这个错误判据
  // 一路通过了全部单测，直到 release dry-run 的 canary 才在真实签发时炸出来。
  //
  // Rekor 里这两个字段语义不同：
  //   entry.logIndex = 全局索引（跨分片单调）
  //   proof.logIndex = 当前这棵树内的索引
  // 分片之后本来就差一个偏移。真实值：2620957627 vs 2499053365，差约 1.2 亿。
  const { assertProofSelfConsistent } = await import('../src/sigstore.mjs');
  const entry = REAL_BUNDLE.verificationMaterial.tlogEntries[0];
  const proof = {
    ...entry.inclusionProof,
    logIndex: BigInt(entry.inclusionProof.logIndex),
    treeSize: BigInt(entry.inclusionProof.treeSize),
    rootHash: Buffer.from(entry.inclusionProof.rootHash, 'base64'),
  };
  assert.notEqual(String(entry.logIndex), String(proof.logIndex),
    '前提：真实 bundle 里这两个索引确实不相等，否则这条测试没在测该测的东西');
  assert.doesNotThrow(() => assertProofSelfConsistent(entry, proof, 'real'));
});

test('🔴 树内索引超出 treeSize 仍要拒 —— 放宽不等于不检查', async () => {
  const { assertProofSelfConsistent } = await import('../src/sigstore.mjs');
  const entry = REAL_BUNDLE.verificationMaterial.tlogEntries[0];
  const base = entry.inclusionProof;
  const mk = (logIndex) => ({
    ...base, logIndex,
    treeSize: BigInt(base.treeSize),
    rootHash: Buffer.from(base.rootHash, 'base64'),
  });
  for (const bad of [BigInt(base.treeSize), BigInt(base.treeSize) + 1n, -1n]) {
    assert.throws(() => assertProofSelfConsistent(entry, mk(bad), 'x'),
      /E_PROOF_INCONSISTENT|不在 \[0, treeSize/, `应拒绝 logIndex=${bad}`);
  }
});
