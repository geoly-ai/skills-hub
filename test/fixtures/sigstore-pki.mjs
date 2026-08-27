// 测试夹具：一整套**合成的 Sigstore PKI**（自建 Fulcio CA / CT log / Rekor），
// 用来喂**真的** `@sigstore/verify`。
//
// 🔴 为什么不用「假 bundle + 假验签器」：那种夹具只能证明我们的胶水代码在
//    高兴路径上不崩，证明不了验签器真的会拒。这里造的每一个字节都要经过
//    真实的密码学检查 —— 证书链、SCT（RFC6962 PreCert）、Rekor 的 SET 与
//    Merkle 包含证明 —— 篡改任何一处，真验签器都会真的拒绝。
//
// 🔴 这套 PKI 的信任根是**测试自己生成的** CA/CT/Rekor 密钥，塞进测试用的
//    TrustedRoot。所以它证明的是「验签器按 Sigstore 的规则办事」，
//    **不是**「我们信任公共 Sigstore 实例」。后者由 §8.1 的内置 TUF 根负责，
//    见 `test/sigstore.test.mjs` 里那条「换一套 trusted root 就必须失败」的测试。
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';

// ── 最小 DER 编码器 ─────────────────────────────────────────────────────────

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) b.unshift(x % 256);
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, ...content) => {
  const c = Buffer.concat(content.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))));
  return Buffer.concat([Buffer.from([tag]), len(c.length), c]);
};
const SEQ = (...c) => tlv(0x30, ...c);
const SET = (...c) => tlv(0x31, ...c);
const BOOL = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const OCTET = (...c) => tlv(0x04, ...c);
const UTF8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const IA5 = (s) => tlv(0x16, Buffer.from(s, 'ascii'));
const CTX = (n, ...c) => tlv(0xa0 | n, ...c); // [n] constructed
const CTX_P = (n, s) => tlv(0x80 | n, Buffer.from(s, 'ascii')); // [n] primitive
const NULL = Buffer.from([0x05, 0x00]);

function INT(n) {
  let hex = BigInt(n).toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let b = Buffer.from(hex, 'hex');
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); // 保持正数
  return tlv(0x02, b);
}

function OID(dotted) {
  const p = dotted.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) {
    const stack = [v & 0x7f];
    for (let x = v >>> 7; x > 0; x >>>= 7) stack.unshift((x & 0x7f) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

/** BIT STRING，unused-bits 前缀固定为 0 */
const BITSTR = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));

/** keyUsage 那种带 unused-bits 的位串 */
function KEYUSAGE_BITS(bits) {
  // bits: 布尔数组，bits[0] = digitalSignature … bits[5] = keyCertSign
  const nbytes = Math.ceil(bits.length / 8) || 1;
  const buf = Buffer.alloc(nbytes);
  bits.forEach((on, i) => { if (on) buf[i >> 3] |= 0x80 >> (i & 7); });
  const unused = nbytes * 8 - bits.length;
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
}

/** RFC 5280 的 UTCTime（YYMMDDHHMMSSZ）—— 我们的测试时间都在 2050 年之前 */
function UTCTIME(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

const OID_CN = '2.5.4.3';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SAN = '2.5.29.17';
const OID_SCT = '1.3.6.1.4.1.11129.2.4.2';
/** Fulcio 的 OIDC issuer 扩展。V2 在 extnValue 里再包一层 DER UTF8String */
export const OID_FULCIO_ISSUER_V2 = '1.3.6.1.4.1.57264.1.8';

const ALG_ECDSA_SHA256 = SEQ(OID(OID_ECDSA_SHA256));
const nameCN = (cn) => SEQ(SET(SEQ(OID(OID_CN), UTF8(cn))));
const ext = (oid, critical, valueDer) =>
  critical ? SEQ(OID(oid), BOOL(true), OCTET(valueDer)) : SEQ(OID(oid), OCTET(valueDer));

// ── 密钥 ────────────────────────────────────────────────────────────────────

export function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey, privateKey, spki, keyId: createHash('sha256').update(spki).digest() };
}

const signDer = (data, key) => nodeSign('sha256', data, key); // EC → ASN.1 ECDSA-Sig-Value

// ── 证书 ────────────────────────────────────────────────────────────────────

function tbs({ serial, issuerCN, subjectCN, spki, notBefore, notAfter, exts }) {
  return SEQ(
    CTX(0, INT(2)),                 // version v3
    INT(serial),
    ALG_ECDSA_SHA256,
    nameCN(issuerCN),
    SEQ(UTCTIME(notBefore), UTCTIME(notAfter)),
    nameCN(subjectCN),
    spki,
    CTX(3, SEQ(...exts)),
  );
}

const wrapCert = (tbsDer, sig) => SEQ(tbsDer, ALG_ECDSA_SHA256, BITSTR(sig));

const DEFAULT_NOT_BEFORE = new Date('2026-01-01T00:00:00Z');
const DEFAULT_NOT_AFTER = new Date('2036-01-01T00:00:00Z');

/** 自签 CA（Fulcio 的角色） */
export function makeCA({ cn = 'geoly-test-fulcio', key = newKey(), notBefore = DEFAULT_NOT_BEFORE, notAfter = DEFAULT_NOT_AFTER } = {}) {
  const exts = [
    ext(OID_BASIC_CONSTRAINTS, true, SEQ(BOOL(true))),
    // keyCertSign 是第 6 位（index 5）—— `X509Certificate.isCA` 要求它置位
    ext(OID_KEY_USAGE, true, KEYUSAGE_BITS([false, false, false, false, false, true, true])),
  ];
  const t = tbs({ serial: 1, issuerCN: cn, subjectCN: cn, spki: key.spki, notBefore, notAfter, exts });
  return { cn, key, der: wrapCert(t, signDer(t, key.privateKey)) };
}

/**
 * 签一张 Fulcio 风格的叶子证书：SAN(URI) + issuer 扩展 + 内嵌 SCT。
 *
 * SCT 的签名对象是 RFC6962 的 PreCert：`sha256(签发者 SPKI) || uint24(len(TBS)) || TBS`，
 * 其中 TBS 是**去掉 SCT 扩展之后重新 DER 编码**的那份。所以这里分两步：
 * 先按不带 SCT 的扩展表编一份 TBS 去算签名，再把 SCT 扩展**追加到末尾**
 * （必须在末尾，`verifySCTs` 是 splice 掉它再重编码的）。
 */
export function makeLeaf({
  ca, ctLog, identity, issuer, key = newKey(), serial = 2,
  notBefore = DEFAULT_NOT_BEFORE, notAfter = DEFAULT_NOT_AFTER,
  sctTimestamp = new Date('2026-06-01T00:00:00Z'),
  ctSignerKey,           // 用别的密钥签 SCT → 应当验不过
  omitSan = false, omitIssuerExt = false, omitSct = false,
}) {
  const baseExts = [
    ext(OID_BASIC_CONSTRAINTS, true, SEQ()),
    ext(OID_KEY_USAGE, true, KEYUSAGE_BITS([true])), // digitalSignature
  ];
  if (!omitSan) baseExts.push(ext(OID_SAN, true, SEQ(CTX_P(6, identity)))); // [6] URI
  if (!omitIssuerExt) baseExts.push(ext(OID_FULCIO_ISSUER_V2, false, UTF8(issuer)));

  const common = { serial, issuerCN: ca.cn, subjectCN: '', spki: key.spki, notBefore, notAfter };
  const tbsNoSct = tbs({ ...common, exts: baseExts });

  if (omitSct) {
    return { key, identity, issuer, der: wrapCert(tbsNoSct, signDer(tbsNoSct, ca.key.privateKey)) };
  }

  // ── RFC6962 §3.2 PreCert ──
  const preCert = Buffer.concat([
    createHash('sha256').update(ca.key.spki).digest(),
    u24(tbsNoSct.length),
    tbsNoSct,
  ]);
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigInt64BE(BigInt(sctTimestamp.getTime()));
  // digitally-signed struct：version, SignatureType(0), timestamp, LogEntryType(1=precert), precert, ext_len
  const toSign = Buffer.concat([
    Buffer.from([0x00, 0x00]), tsBuf, u16(0x0001), preCert, u16(0),
  ]);
  const sctSig = signDer(toSign, (ctSignerKey ?? ctLog.key).privateKey);
  // SCT 的 TLS 编码
  const sct = Buffer.concat([
    Buffer.from([0x00]), ctLog.key.keyId, tsBuf, u16(0),
    Buffer.from([0x04, 0x03]), // sha256 / ecdsa
    u16(sctSig.length), sctSig,
  ]);
  const sctList = Buffer.concat([u16(sct.length + 2), u16(sct.length), sct]);
  // extnValue 里再包一层 OCTET STRING（RFC6962 §3.3）
  const exts = [...baseExts, ext(OID_SCT, false, OCTET(sctList))];
  const t = tbs({ ...common, exts });
  return { key, identity, issuer, der: wrapCert(t, signDer(t, ca.key.privateKey)) };
}

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u24 = (n) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

// ── Rekor ───────────────────────────────────────────────────────────────────

/** RFC 8785 / JCS 的一个够用子集：这里的键都是 ASCII 且无需转义 */
function jcs(o) {
  if (Array.isArray(o)) return `[${o.map(jcs).join(',')}]`;
  if (o !== null && typeof o === 'object') {
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(o);
}

const leafHash = (body) => createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), body])).digest();

/**
 * 造一条 hashedrekord v0.0.1 的透明日志条目，带 inclusion promise（SET）
 * 与 inclusion proof（tree size = 1 的退化 Merkle 证明）。
 */
export function makeTLogEntry({
  rekor, bytes, signature, certDer, logIndex = 0, integratedTime = 1780000000,
  setSignerKey, checkpointSignerKey, tamperBodySignature = false, tamperBodyDigest = false,
  tamperRootHash = false, omitInclusionProof = false, omitInclusionPromise = false,
  origin = 'rekor.test.invalid',
}) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const body = Buffer.from(JSON.stringify({
    apiVersion: '0.0.1',
    kind: 'hashedrekord',
    spec: {
      data: { hash: { algorithm: 'sha256', value: tamperBodyDigest ? 'f'.repeat(64) : digest } },
      signature: {
        content: (tamperBodySignature ? Buffer.concat([signature, Buffer.from([0])]) : signature).toString('base64'),
        publicKey: { content: Buffer.from(pem(certDer)).toString('base64') },
      },
    },
  }), 'utf8');

  const logID = rekor.key.keyId;
  const entry = {
    logIndex: String(logIndex),
    logId: { keyId: logID.toString('base64') },
    kindVersion: { kind: 'hashedrekord', version: '0.0.1' },
    integratedTime: String(integratedTime),
    canonicalizedBody: body.toString('base64'),
  };

  if (!omitInclusionPromise) {
    const payload = Buffer.from(jcs({
      body: body.toString('base64'),
      integratedTime,
      logIndex,
      logID: logID.toString('hex'),
    }), 'utf8');
    entry.inclusionPromise = {
      signedEntryTimestamp: signDer(payload, (setSignerKey ?? rekor.key).privateKey).toString('base64'),
    };
  }

  if (!omitInclusionProof) {
    const root = tamperRootHash ? Buffer.alloc(32, 0xab) : leafHash(body);
    const note = `${origin}\n1\n${root.toString('base64')}\n`;
    const noteSig = signDer(Buffer.from(note, 'utf8'), (checkpointSignerKey ?? rekor.key).privateKey);
    const envelope = `${note}\n— ${origin} ${Buffer.concat([logID.subarray(0, 4), noteSig]).toString('base64')}\n`;
    entry.inclusionProof = {
      logIndex: String(logIndex),
      rootHash: root.toString('base64'),
      treeSize: '1',
      hashes: [],
      checkpoint: { envelope },
    };
  }
  return entry;
}

const pem = (der) =>
  `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;

// ── trusted root ────────────────────────────────────────────────────────────

const logInstance = (key, baseUrl) => ({
  baseUrl,
  hashAlgorithm: 'SHA2_256',
  publicKey: {
    rawBytes: key.spki.toString('base64'),
    keyDetails: 'PKIX_ECDSA_P256_SHA_256',
    validFor: { start: '2020-01-01T00:00:00.000Z' },
  },
  logId: { keyId: key.keyId.toString('base64') },
});

export function makeTrustedRoot({ ca, rekor, ctLog }) {
  return {
    mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
    tlogs: [logInstance(rekor.key, 'https://rekor.test.invalid')],
    ctlogs: [logInstance(ctLog.key, 'https://ct.test.invalid')],
    certificateAuthorities: [{
      subject: { organization: 'geoly-test', commonName: ca.cn },
      uri: 'https://fulcio.test.invalid',
      certChain: { certificates: [{ rawBytes: ca.der.toString('base64') }] },
      validFor: { start: '2020-01-01T00:00:00.000Z' },
    }],
    timestampAuthorities: [],
  };
}

// ── 一步到位：造一整份合法 bundle ───────────────────────────────────────────

export const BUNDLE_V03_MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json';

/**
 * @param {object} o
 * @param {Buffer} o.bytes    被签的原始字节
 * @param {string} o.identity SAN URI
 * @param {string} o.issuer   OIDC issuer
 * @param {object} o.pki      `makePKI()` 的返回值
 * @param {object} [o.leafOpts] 传给 `makeLeaf` 的覆盖项（用来造各种伪造）
 * @param {object} [o.entryOpts] 传给 `makeTLogEntry` 的覆盖项
 * @param {Buffer} [o.signBytes] 实际拿去签名的字节（默认 = bytes；不同即「签的不是这串」）
 */
export function makeBundle({
  bytes, identity, issuer, pki, leafOpts = {}, entryOpts = {}, signBytes,
  mediaType = BUNDLE_V03_MEDIA_TYPE,
  /** 让 bundle 里的 messageDigest 谎称自己是别的字节的摘要 */
  digestBytes,
  /** 把 messageDigest 的算法换成别的（降级攻击） */
  digestAlgorithm = 'SHA2_256',
  /**
   * 🔴 用**别的私钥**签，但摘要与 tlog body 全都与 `bytes` 保持一致。
   * 这样前面每一道（我们的摘要预检、tlog body 的签名/摘要比对）都过得去，
   * 只剩最后那一步 `verifySignature(artifact)` 能拦住它 —— 这是唯一能证明
   * 「最终的 ECDSA 校验真的在跑」的构造。
   */
  wrongSigningKey,
}) {
  const leaf = makeLeaf({ ca: pki.ca, ctLog: pki.ctLog, identity, issuer, ...leafOpts });
  const signature = signDer(signBytes ?? bytes, (wrongSigningKey ?? leaf.key).privateKey);
  const entry = makeTLogEntry({
    rekor: pki.rekor, bytes: signBytes ?? bytes, signature, certDer: leaf.der, ...entryOpts,
  });
  return {
    mediaType,
    verificationMaterial: {
      certificate: { rawBytes: leaf.der.toString('base64') },
      tlogEntries: [entry],
    },
    // 🔴 protobuf 的 oneof 在 JSON 里是**平铺**的：`messageSignature` / `dsseEnvelope`
    //    直接挂在 bundle 上，不是嵌在 `content` 里。
    messageSignature: {
      messageDigest: {
        algorithm: digestAlgorithm,
        digest: createHash('sha256').update(digestBytes ?? signBytes ?? bytes).digest().toString('base64'),
      },
      signature: signature.toString('base64'),
    },
  };
}

/**
 * DSSE 形态的 bundle。证书、SCT、Rekor 条目全都合法 —— 唯一的问题是
 * DSSE 的签名对象是 envelope 自己的 PAE，与我们手上的 `bytes` 毫无绑定。
 * 这正是 `assertMessageSignature()` 要挡的东西。
 */
export function makeDsseBundle({ bytes, identity, issuer, pki }) {
  const leaf = makeLeaf({ ca: pki.ca, ctLog: pki.ctLog, identity, issuer });
  const payloadType = 'application/vnd.in-toto+json';
  const p = Buffer.from(JSON.stringify({ _type: 'x' }), 'utf8');
  const paeBytes = Buffer.concat([
    Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${p.length} `, 'utf8'), p,
  ]);
  const signature = signDer(paeBytes, leaf.key.privateKey);
  return {
    mediaType: BUNDLE_V03_MEDIA_TYPE,
    verificationMaterial: {
      certificate: { rawBytes: leaf.der.toString('base64') },
      tlogEntries: [makeTLogEntry({ rekor: pki.rekor, bytes: paeBytes, signature, certDer: leaf.der })],
    },
    dsseEnvelope: {
      payload: p.toString('base64'),
      payloadType,
      signatures: [{ sig: signature.toString('base64') }],
    },
  };
}

/** 裸公钥形态：没有证书，也就没有 SAN / issuer —— 身份判定无从谈起 */
export function makePublicKeyBundle({ bytes, pki }) {
  const key = newKey();
  const signature = signDer(bytes, key.privateKey);
  return {
    mediaType: BUNDLE_V03_MEDIA_TYPE,
    verificationMaterial: {
      publicKey: { hint: 'test-hint' },
      tlogEntries: [makeTLogEntry({ rekor: pki.rekor, bytes, signature, certDer: pki.ca.der })],
    },
    messageSignature: {
      messageDigest: { algorithm: 'SHA2_256', digest: createHash('sha256').update(bytes).digest().toString('base64') },
      signature: signature.toString('base64'),
    },
  };
}

export function makePKI() {
  const ca = makeCA();
  const rekor = { key: newKey() };
  const ctLog = { key: newKey() };
  const pki = { ca, rekor, ctLog };
  return { ...pki, trustedRoot: makeTrustedRoot(pki) };
}
