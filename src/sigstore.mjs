// 真正的 Sigstore 验签器 —— **纯离线**，验证时不出网。
//
// 规范：02-registry.md §8（签名身份）、§8.1（TUF 根随 CLI 内置）、§9.2（缓存命中不跳过验签）、
//       07-threat-model.md、00-decisions.md ⑤（Sigstore keyless + npm provenance）
//
// ── 为什么只引 `@sigstore/verify` ────────────────────────────────────────────
// `sigstore` 全家桶把「签名 + 上传」和「验证」焊在一起：`@sigstore/sign` 带
// `make-fetch-happen`（要出网连 Fulcio / Rekor），`@sigstore/tuf` 带 `tuf-js`
// （要出网刷 TUF 根）。CLI 只需要**验证**那半边，两个联网包一个都不引。
//
// 🔴 `--offline` 是全局 flag，规范承诺「离线时也必须重验签名，缓存只省网络、
//    不省任何一次密码学校验」。联网验签会让这条承诺直接破产，所以制品与 bundle
//    一起分发、验签全程离线：证书链 + SCT + Rekor 包含证明都在 bundle 里带齐。
//
// ── trusted root 从哪来 ─────────────────────────────────────────────────────
// §8.1：Sigstore TUF trust root **随 CLI 内置**。本模块因此**不自己去取根**，
// 由调用方把 protobuf `TrustedRoot` 的 JSON 传进来。没有根就验不了 —— 这是
// fail-closed，不是缺陷。
//
// 🔴 **信任根是本模块唯一的信任输入，而本模块不认证它。**
//    这里做不到也不该做：TUF 根的真伪要靠「随 CLI 内置 + npm provenance」
//    那一跳（§8.2 明确承认第一跳的信任锚是 npm registry + TLS）。
//    推论，接线的人必须守住：
//      · 只喂**编译进包里**的根，或已按 TUF 流程验过签的根；
//      · **绝不**把网络上取来的、或缓存目录里读到的根直接传进来 ——
//        对手能自带 CA/CT/Rekor，那样整套验证一次性失守，而且全程「验签通过」；
//      · 记 `root_version` 与过期时间，根过期/轮换走 Sigstore 标准流程。
import { Verifier, toTrustMaterial, toSignedEntity } from '@sigstore/verify';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot, HashAlgorithm } from '@sigstore/protobuf-specs';
import { IntegrityError, sha256Of } from './trust.mjs';
import { readFileSync } from 'node:fs';
import { parseStrict } from './canonical-json.mjs';

/**
 * 🔴 **绝不使用 `@sigstore/verify` 的 `policy` 参数做身份判定。**
 *
 * `dist/policy.js` 的实现是 `signerIdentity.match(policyIdentity)` ——
 * 把 policy 字符串当成**正则**，而且**不锚定**。我们的身份串里全是 `.` 和 `/`：
 *
 *   https://github.com/geoly-ai/skills-hub/.github/workflows/release.yml@refs/heads/main
 *
 * 作为正则，`.` 匹配任意字符，`/` 无意义，且不锚定 → 下面这些**都会 match 成功**：
 *
 *   …/skills-hub/Xgithub/workflows/release.yml@refs/heads/main        （`.` 当通配）
 *   …/skills-hub/.github/workflows/release.yml@refs/heads/main-EVIL   （后缀糊弄）
 *   https://evil.example/?x=https://github.com/…/main                 （前缀糊弄）
 *
 * 所以身份判定**只走本模块自己的 `===`**：从 `Verifier.verify()` 返回的
 * `Signer.identity` 上取 SAN 与 issuer 扩展，逐字符精确比对。
 * 上层 `verifySigned()` 还会再独立比一遍（§8 要求「精确比对，不做前缀匹配、
 * 不做通配」）——两道都是 `===`，故意冗余。
 */
const NO_POLICY = undefined;

/** 只接受 SHA2-256 的 messageDigest：算法降级是攻击面，不是兼容性 */
const REQUIRED_HASH = HashAlgorithm.SHA2_256;

function fail(violation, msg) {
  throw new IntegrityError(violation, msg);
}

/**
 * 把库的错误摊平成一行。`@sigstore/verify` 的证书链错误把真正的原因塞在
 * `cause` 里（外层只有一句 `Failed to verify certificate chain`），不跟下去
 * 的话「证书过期」和「CA 不认识」在日志里长得一模一样。
 */
function describe(e, depth = 0) {
  if (!e || depth > 4) return String(e);
  const code = e.code ? `${e.code}: ` : '';
  const head = safe(`${code}${e.message ?? e}`);
  return e.cause ? `${head} ← ${describe(e.cause, depth + 1)}` : head;
}

/**
 * 🔴 错误信息里会带上**对手控制的**字符串（证书 SAN、issuer、tlog 里的字段）。
 * 原样打到终端就是一个注入面：ANSI 转义能改写已经打出来的行、换行能伪造出
 * 一条看起来像我们自己打的日志（「验签通过」）。这里统一去掉控制字符并截断。
 */
function safe(s, max = 200) {
  const t = String(s).replace(/[\p{Cc}\p{Cf}]/gu, '�');
  return t.length > max ? `${t.slice(0, max)}…（已截断 ${t.length - max} 字）` : t;
}

/**
 * 把 TUF trusted root（protobuf `TrustedRoot` 的 JSON 形式）转成 TrustMaterial。
 * @param {object|string|Buffer} root
 */
/**
 * 🔴 加载**编译进包**的 Sigstore 公共实例信任根。
 *
 * 这是整个验签体系唯一的信任输入，所以这个函数刻意做得没有任何活动部件：
 *
 * - 路径由 `import.meta.url` 推出，**不接受参数**；
 * - **不读环境变量、不读命令行、不读缓存、不出网**。
 *
 * 为什么这么死：验签器本身**不认证信任根**，它只负责「按这个根去验」。
 * 一旦根能被外部指定，对手自带 CA + CT log + Rekor 就能让整套验证一次性失守，
 * 而且全程显示「验签通过」——这是最坏的一种失败：**看起来是成功的**。
 *
 * ⚠️ `02-registry.md` §8.2 自己承认「内置 + npm provenance」不是自洽闭环：
 * 根的真伪最终依赖发包渠道。那是**已知的**信任边界，见 docs/m1/01-residual-risks.md。
 */
export function loadBuiltinTrustedRoot() {
  const p = new URL('./trust-roots/sigstore-public-good.json', import.meta.url);
  // 用 parseStrict：重复 key 在这里意味着两份互相矛盾的信任材料，必须报错而不是取最后一个
  return parseStrict(readFileSync(p, 'utf8'));
}

export function trustMaterialFrom(root) {
  if (root === undefined || root === null) {
    fail('E_TRUST_ROOT', 'Sigstore trusted root 未提供：没有信任根就验不了签（§8.1，不存在跳过）');
  }
  let obj = root;
  if (Buffer.isBuffer(root) || typeof root === 'string') {
    try {
      obj = JSON.parse(Buffer.isBuffer(root) ? root.toString('utf8') : root);
    } catch (e) {
      fail('E_TRUST_ROOT', `Sigstore trusted root 不是合法 JSON：${e.message}`);
    }
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    fail('E_TRUST_ROOT', 'Sigstore trusted root 必须是对象');
  }
  let parsed;
  try {
    parsed = TrustedRoot.fromJSON(obj);
  } catch (e) {
    fail('E_TRUST_ROOT', `Sigstore trusted root 解析失败：${e.message}`);
  }
  // 空的信任集合会让 Verifier 在「没有任何可信 CA」的情况下走到别的报错分支，
  // 诊断信息很难懂。这里提前挡掉，并且明确它是 fail-closed。
  if (!parsed.certificateAuthorities?.length) {
    fail('E_TRUST_ROOT', 'Sigstore trusted root 里没有任何 certificateAuthorities');
  }
  if (!parsed.tlogs?.length) {
    fail('E_TRUST_ROOT', 'Sigstore trusted root 里没有任何 tlogs（Rekor）');
  }
  // ctlogs 缺失会一路拖到「SCT 验不过」才报，诊断信息指错方向。提前挡。
  if (!parsed.ctlogs?.length) {
    fail('E_TRUST_ROOT', 'Sigstore trusted root 里没有任何 ctlogs（证书透明日志）：SCT 无从验起');
  }
  try {
    return toTrustMaterial(parsed);
  } catch (e) {
    fail('E_TRUST_ROOT', `Sigstore trusted root 无法构造 TrustMaterial：${e.message}`);
  }
}

/**
 * 造一个可以喂给 `verifySigned({ verifier })` 的真验签器。
 *
 * @param {object} o
 * @param {object|string|Buffer} o.trustedRoot  protobuf TrustedRoot 的 JSON（§8.1 内置根）
 * @param {number} [o.tlogThreshold=1]   至少要几条 Rekor 条目
 * @param {number} [o.ctlogThreshold=1]  至少要几条 SCT
 *
 * 🔴 **没有「放宽」的旋钮。** 两个阈值只允许往严了调（`<1` 直接拒），
 *    包含证明是**无条件**要求的。任何一个能关掉检查的参数，接到 CLI 上就是
 *    一个 `--no-verify`；这里从一开始就不留。
 * @returns {(a:{bytes:Buffer,bundle:*,expectIdentity:string,expectIssuer:string})=>
 *            {ok:true,identity:string,issuer:string,sha256:string}}
 */
export function createSigstoreVerifier({
  trustedRoot,
  tlogThreshold = 1,
  ctlogThreshold = 1,
} = {}) {
  for (const [k, v] of Object.entries({ tlogThreshold, ctlogThreshold })) {
    if (!Number.isInteger(v) || v < 1) {
      // 阈值 0 等于「不要求透明日志 / 不要求 SCT」—— 那是一个逃生口，禁掉。
      fail('E_VERIFIER_CONFIG', `${k} 必须是 ≥1 的整数，得到 ${v}（阈值 0 等于关掉检查）`);
    }
  }

  // 根在造 verifier 时就解析好：坏根要在启动时炸，而不是在第一次装东西时炸。
  const material = trustMaterialFrom(trustedRoot);
  const verifier = new Verifier(material, {
    tlogThreshold,
    ctlogThreshold,
    timestampThreshold: 1,
  });

  return function sigstoreVerifier({ bytes, bundle, expectIdentity, expectIssuer }) {
    if (!Buffer.isBuffer(bytes)) fail('E_VERIFIER_INPUT', '待验字节必须是 Buffer');
    if (typeof expectIdentity !== 'string' || expectIdentity === '') {
      fail('E_VERIFIER_INPUT', 'expectIdentity 必须是非空字符串');
    }
    if (typeof expectIssuer !== 'string' || expectIssuer === '') {
      fail('E_VERIFIER_INPUT', 'expectIssuer 必须是非空字符串');
    }

    const b = parseBundle(bundle);
    assertBundleSize(b);
    assertMessageSignature(b, bytes);
    assertHasCertificate(b);
    assertInclusionProofs(b);
    assertVerifiableTime(b);
    assertTLogBodyShape(b);

    let signer;
    try {
      // 🔴 不传 policy（见 NO_POLICY 的注释）。库负责密码学，身份归我们判。
      signer = verifier.verify(toSignedEntity(b, bytes), NO_POLICY);
    } catch (e) {
      // 🔴 不吞、不降级、不重试。库说不过就是不过。
      fail('E_SIGSTORE_VERIFY', `Sigstore 验签失败（${describe(e)}）`);
    }

    const identity = signer?.identity?.subjectAlternativeName;
    const issuer = signer?.identity?.extensions?.issuer;
    if (typeof identity !== 'string' || identity === '') {
      fail('E_NO_SAN', '叶子证书没有 SubjectAlternativeName：拿不到签名身份');
    }
    if (typeof issuer !== 'string' || issuer === '') {
      fail('E_NO_ISSUER', '叶子证书没有 Fulcio issuer 扩展：拿不到 OIDC issuer');
    }
    // 🔴 `===`，不是 `startsWith` / `includes` / 正则（§8）
    if (identity !== expectIdentity) {
      fail('E_IDENTITY_MISMATCH',
        `签名身份是 ${safe(identity)}，期望 ${safe(expectIdentity)}（精确比对，两个身份不可互换）`);
    }
    if (issuer !== expectIssuer) {
      fail('E_ISSUER_MISMATCH', `OIDC issuer 是 ${safe(issuer)}，期望 ${safe(expectIssuer)}`);
    }

    return { ok: true, identity, issuer, sha256: sha256Of(bytes) };
  };
}

// ── 各项前置检查 ────────────────────────────────────────────────────────────

function parseBundle(bundle) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    fail('E_BUNDLE_MALFORMED', 'bundle 必须是对象');
  }
  // 🔴 protobuf 的 oneof 在 JSON 里是平铺的，而生成的 parser 遇到**两个都在**
  //    时按固定优先级挑一个、不报错。于是对手可以同时塞 `messageSignature` 与
  //    `dsseEnvelope`：我们按一个分支判、别的工具按另一个分支判，同一份 bundle
  //    在两边有两种含义（类型混淆）。歧义即拒。
  assertNoOneofAmbiguity(bundle, ['messageSignature', 'dsseEnvelope'], 'bundle 的内容');
  assertNoOneofAmbiguity(bundle.verificationMaterial ?? {},
    ['publicKey', 'certificate', 'x509CertificateChain'], 'bundle 的 verificationMaterial');
  try {
    return bundleFromJSON(bundle);
  } catch (e) {
    fail('E_BUNDLE_MALFORMED', `bundle 解析失败：${safe(e?.message ?? e)}`);
  }
}

function assertNoOneofAmbiguity(obj, keys, where) {
  const present = keys.filter((k) => obj?.[k] !== undefined && obj?.[k] !== null);
  if (present.length > 1) {
    fail('E_BUNDLE_ONEOF_AMBIGUOUS',
      `${where}同时给了 ${safe(present.join(' 和 '))}：oneof 有歧义，不同实现会解读成不同东西`);
  }
}

/**
 * 🔴 只接受 `messageSignature`，拒绝 `dsseEnvelope`。
 *
 * snapshot / timestamp 签的是**原始 JSON 字节**。`messageSignature` 的
 * `verifySignature()` 是对我们传进去的 artifact 字节验的 —— 签名与我们手上的
 * 字节**真的绑定**。而 `dsseEnvelope` 的签名是对 envelope 自己的 PAE 验的，
 * 跟我们手上的 `bytes` **一点关系都没有**：拿一个身份正确、签名有效的 DSSE
 * bundle 配任意字节，库这一层照样过。
 *
 * （attestation 确实是 DSSE，但 02-registry.md §1.1 写死了它**只服务取证、
 * 安装链路不读**；`src/attestation.mjs` 单独处理，不走这个 verifier。）
 */
function assertMessageSignature(b, bytes) {
  const c = b.content;
  if (c?.$case !== 'messageSignature') {
    fail('E_BUNDLE_NOT_MESSAGE_SIGNATURE',
      `bundle 的内容类型是 ${safe(c?.$case ?? '(缺失)')}，只接受 messageSignature：` +
      'DSSE envelope 的签名与待验字节没有绑定关系');
  }
  const md = c.messageSignature.messageDigest;
  if (md?.algorithm !== REQUIRED_HASH) {
    fail('E_BUNDLE_DIGEST_ALGO', `messageDigest.algorithm 必须是 SHA2-256，得到 ${md?.algorithm}`);
  }
  // 库内部确实也会比对（`verifyTLogBody` 的 `compareSignedDigest`，以及
  // `verifySignature(artifact)`），但那两处都在**验签之后**、且依赖 tlog 条目
  // 存在。这里在进库之前先用我们自己算的摘要卡一道：便宜、诊断清楚，
  // 而且不依赖库的内部实现细节继续保持现状。
  const want = Buffer.from(sha256Of(bytes).slice('sha256:'.length), 'hex');
  if (!Buffer.isBuffer(md.digest) || !want.equals(Buffer.from(md.digest))) {
    fail('E_BUNDLE_DIGEST_MISMATCH',
      `bundle 里的 messageDigest 不是待验字节的 sha256（bundle=${safe(Buffer.from(md.digest ?? []).toString('hex'), 64)}）`);
  }
}

/**
 * 拒绝裸公钥 bundle。`publicKey` 形态没有证书，也就没有 SAN 与 issuer 扩展 ——
 * §8 的身份判定根本无从谈起，而 `Verifier` 对这种 bundle 会返回
 * `identity === undefined`。不挡掉的话，「身份判定」会退化成「有没有 identity」，
 * 那正是把验签器变成恒真的路子。
 */
function assertHasCertificate(b) {
  const vm = b.verificationMaterial?.content;
  if (vm?.$case !== 'certificate' && vm?.$case !== 'x509CertificateChain') {
    fail('E_BUNDLE_NO_CERT',
      `bundle 的 verificationMaterial 是 ${safe(vm?.$case ?? '(缺失)')}：` +
      '裸公钥没有 SAN / issuer 扩展，无法做 §8 的身份判定');
  }
}

/**
 * 🔴 要求真正的**包含证明**（checkpoint 签名 + RFC6962 Merkle 路径），
 * 不接受只有 inclusion promise（SET）的 bundle。
 *
 * 两者的安全性不一样：SET 只证明「Rekor 当时承诺会收录」，包含证明才证明
 * 「它确实在那棵已签名的树里」。07-threat-model.md 把「透明日志事后可发现」
 * 当成对手 C（维护者账号被接管）的唯一兜底 —— 承诺兑现不了的话这条兜底就是空的。
 *
 * ⚠️ **不能靠 `mediaType` 来间接实现这条。** `bundleFromJSON` 只在 v0.3
 * 媒体类型下强制包含证明，而 `mediaType` 是 bundle 里的一个字段、**由对手控制**：
 * 声明成 `…;version=0.1` 就能走到只校验 inclusion promise 的分支。
 * 所以这里对**已解析的结构**自己查一遍，与声明的版本无关。
 */
function assertInclusionProofs(b) {
  const entries = b.verificationMaterial?.tlogEntries ?? [];
  if (entries.length === 0) {
    fail('E_NO_TLOG_ENTRY', 'bundle 里没有 Rekor 透明日志条目');
  }
  entries.forEach((e, i) => {
    const p = e.inclusionProof;
    if (!p) {
      fail('E_NO_INCLUSION_PROOF',
        `tlogEntries[${i}] 只有 inclusion promise，没有包含证明：` +
        '承诺不等于收录，透明日志的事后可发现性会落空');
    }
    if (!p.checkpoint?.envelope) {
      fail('E_NO_INCLUSION_PROOF', `tlogEntries[${i}] 的包含证明缺 checkpoint`);
    }
    assertProofSelfConsistent(e, p, `tlogEntries[${i}]`);
  });
}

/**
 * 包含证明里有一组**冗余字段**：`rootHash` / `treeSize` / `logIndex` 在
 * 已签名的 checkpoint 里各有一份。`verifyMerkleInclusion()` 只读 checkpoint
 * 里那一份（那才是被签名的权威值），**完全不看** proof 自己带的这几个。
 *
 * 于是一个把 `inclusionProof.rootHash` 改成任意值的 bundle 照样能验过。
 * 密码学上没问题，但形态是自相矛盾的 —— 下游要是拿这几个字段去展示或入库，
 * 记下来的就是攻击者写的数。这里要求它们与 checkpoint 一致，矛盾即拒。
 *
 * ⚠️ 这是**一致性**检查，不是安全检查：此时 checkpoint 还没验签。
 *    真正的权威仍然是库验过签之后的 checkpoint。
 */
function assertProofSelfConsistent(entry, p, where) {
  // checkpoint note 的前三行：origin / logSize / base64(rootHash)
  const note = String(p.checkpoint.envelope).split('\n\n')[0];
  const lines = note.split('\n');
  if (lines.length < 3) {
    fail('E_PROOF_INCONSISTENT', `${where} 的 checkpoint 头部行数不足`);
  }
  const [, logSize, rootB64] = lines;
  const proofRoot = Buffer.from(p.rootHash ?? []).toString('base64');
  if (proofRoot !== rootB64) {
    fail('E_PROOF_INCONSISTENT',
      `${where}.inclusionProof.rootHash 与已签名 checkpoint 里的根不一致：` +
      '冗余字段自相矛盾（Merkle 验证只认 checkpoint，这份会被下游误读）');
  }
  if (String(p.treeSize) !== logSize) {
    fail('E_PROOF_INCONSISTENT',
      `${where}.inclusionProof.treeSize=${safe(String(p.treeSize), 32)} 与 checkpoint 的 logSize=${safe(logSize, 32)} 不一致`);
  }
  if (String(p.logIndex) !== String(entry.logIndex)) {
    fail('E_PROOF_INCONSISTENT',
      `${where}.inclusionProof.logIndex=${safe(String(p.logIndex), 32)} 与条目自身的 logIndex=${safe(String(entry.logIndex), 32)} 不一致`);
  }
}

/**
 * 🔴 bundle 整份都是**对手控制**的，而库对 tlog 条目与 SCT 的去重是 O(n²)、
 * 且去重之前每一条都要先做一次真的密码学验证。塞几千条进来就是一个可远程
 * 触发的 CPU/内存打点。这里先按上限卡死 —— 真实 bundle 只有个位数条目。
 *
 * 这不影响正确性（超限只会更早失败），只关掉可用性打点。
 */
const MAX_TLOG_ENTRIES = 8;
const MAX_TLOG_BODY_BYTES = 1 << 20; // 1 MiB

function assertBundleSize(b) {
  const entries = b.verificationMaterial?.tlogEntries ?? [];
  if (entries.length > MAX_TLOG_ENTRIES) {
    fail('E_BUNDLE_TOO_LARGE',
      `bundle 带了 ${entries.length} 条 tlog 条目，上限 ${MAX_TLOG_ENTRIES}（去重是 O(n²)，这是拒绝服务面）`);
  }
  const tsa = b.verificationMaterial?.timestampVerificationData?.rfc3161Timestamps ?? [];
  if (tsa.length > MAX_TLOG_ENTRIES) {
    fail('E_BUNDLE_TOO_LARGE', `bundle 带了 ${tsa.length} 个 RFC3161 时间戳，上限 ${MAX_TLOG_ENTRIES}`);
  }
  entries.forEach((e, i) => {
    const n = e.canonicalizedBody?.length ?? 0;
    if (n > MAX_TLOG_BODY_BYTES) {
      fail('E_BUNDLE_TOO_LARGE', `tlogEntries[${i}].canonicalizedBody 有 ${n} 字节，上限 ${MAX_TLOG_BODY_BYTES}`);
    }
  });
}

/**
 * 🔴 证书链的有效期是**对着可信时间戳**校验的，而 `@sigstore/verify` 只认两种
 * 可信时间来源：Rekor 条目的 **inclusion promise（SET）**，或 RFC3161 的
 * **TSA 时间戳**。**inclusion proof 本身不提供时间** —— `getTLogTimestamp()`
 * 在没有 `inclusionPromise` 时直接返回 undefined。
 *
 * 于是「只有包含证明、没有承诺、也没有 TSA」的 bundle 会以
 * `TIMESTAMP_ERROR: expected 1 timestamps, got 0` 失败 —— 是 fail-closed，
 * 但报错指向「时间戳不够」，看的人会以为是时钟问题。这里提前查一遍，
 * 把它变成一条说得清的错。
 *
 * （实测 2026-08-26：npm / GitHub Actions 由 sigstore-js 产出的 v0.2 与 v0.3
 * bundle **两者都带**，所以这条不会挡住今天的生产制品。Rekor v2 会去掉 SET、
 * 改用 TSA，那条路这里也认。）
 */
function assertVerifiableTime(b) {
  const entries = b.verificationMaterial?.tlogEntries ?? [];
  const tsaCount = b.verificationMaterial?.timestampVerificationData?.rfc3161Timestamps?.length ?? 0;
  const promises = entries.filter((e) => e.inclusionPromise).length;
  if (promises + tsaCount === 0) {
    fail('E_NO_TRUSTED_TIME',
      'bundle 里没有任何可信时间来源（Rekor inclusion promise / RFC3161 TSA）：' +
      '证书有效期无从校验。包含证明本身不提供时间');
  }
}

/**
 * 🔴 库的 `verifyHashedRekordTLogBody()` 逐字节比对摘要，却**不看**
 * `spec.data.hash.algorithm`。我们要求 SHA-256，那就自己查这个字段 ——
 * 只查 bundle 的 `messageDigest.algorithm` 是不够的，那是另一处字段。
 *
 * 同时把 tlog 条目的种类钉死在 `hashedrekord`：一个 messageSignature 的 bundle
 * 配着 `dsse` / `intoto` 的 tlog 条目本身就是形状不对。
 */
function assertTLogBodyShape(b) {
  const entries = b.verificationMaterial?.tlogEntries ?? [];
  entries.forEach((e, i) => {
    const where = `tlogEntries[${i}]`;
    const kind = e.kindVersion?.kind;
    const version = e.kindVersion?.version;
    if (kind !== 'hashedrekord') {
      fail('E_TLOG_KIND', `${where}.kindVersion.kind 是 ${safe(kind)}，messageSignature 的 bundle 只接受 hashedrekord`);
    }
    if (version !== '0.0.1') {
      // 未知版本的 spec 形状我们没审过，也就无从确认它的摘要算法字段。
      // 认不出就拒，不猜。
      //
      // 🔴 **已知的运维阻断点**：`@sigstore/verify` 已经支持 Rekor v2 的
      //    `hashedRekordV002`，但那种条目会在进库之前被这里挡下。
      //    Rekor v2 一旦成为签发侧的默认，本条会让**全量安装失败**。
      //    切换前必须先审 v2 的 spec 形状、把它加进白名单、并补上对应测试 ——
      //    这是一个需要提前排期的动作，不是等报错了再改。
      fail('E_TLOG_BODY_VERSION',
        `${where}.kindVersion.version 是 ${safe(version)}：本实现只审过 hashedrekord 0.0.1`);
    }
    let body;
    try {
      body = JSON.parse(Buffer.from(e.canonicalizedBody).toString('utf8'));
    } catch {
      fail('E_TLOG_BODY_MALFORMED', `${where}.canonicalizedBody 不是合法 JSON`);
    }
    const algo = body?.spec?.data?.hash?.algorithm;
    if (algo !== 'sha256') {
      fail('E_TLOG_BODY_DIGEST_ALGO',
        `${where} 的 tlog body 声明摘要算法是 ${safe(JSON.stringify(algo))}，只接受 sha256`);
    }
  });
}
