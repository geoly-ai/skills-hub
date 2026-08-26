// timestamp / snapshot 的严格解析、验签契约与验证链顺序
// 规范：02-registry.md §2（snapshot schema）、§3（timestamp schema）、§6（验证链）、
//       §8（签名身份）、11-wire-contract.md、09-cli.md §6（退出码）
import {
  IntegrityError, MinCliVersionError, StaleError, WireError,
  REPO, CLOCK_SKEW_SECONDS, TIMESTAMP_MAX_VALIDITY_SECONDS,
  parseWireJson, assertCanonicalBytes, assertExactKeys, assertUint, assertString,
  assertStringArray, parseWireTime, assertAssetDigest, assertTreeDigest, sha256Of,
  checkAntiReplay, advanceTrustFloor, readTrustFloor, makeFloor,
} from './trust.mjs';

export const TIMESTAMP_SCHEMA = 'geoly.skills.timestamp/1';
export const SNAPSHOT_SCHEMA = 'geoly.skills.snapshot/2';

// ── 签名身份（02-registry.md §8） ───────────────────────────────────────────
// 🔴 **精确比对**，不做前缀匹配、不做通配。两个身份**不可互换**：
//    用 release.yml 身份签出来的 timestamp 必须被拒绝，反之亦然。
export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const RELEASE_IDENTITY = `https://github.com/${REPO}/.github/workflows/release.yml@refs/heads/main`;
export const TIMESTAMP_IDENTITY = `https://github.com/${REPO}/.github/workflows/timestamp.yml@refs/heads/main`;

// ── 验签契约 ────────────────────────────────────────────────────────────────

/**
 * 🔴 模块私有的 brand。只有 `verifySigned()` 能造出带这个 brand 的对象，
 * 而它只在把 verifier 的返回值**逐项独立核对过**之后才造。
 *
 * 为什么要 brand：留一个可注入的 verifier 是必要的（Sigstore 验签要网络与
 * TUF 根，不在本模块职责内），但「可注入」很容易滑成「假装验过」——
 * 一个返回 `undefined` 或 `true` 的桩子会被当成成功。加 brand 之后，
 * 下游 API 只认 `VerifiedBytes`，而它没有公开构造函数。
 */
const BRAND = Symbol('geoly.verified');

class VerifiedBytes {
  constructor(brand, bytes, identity, issuer) {
    if (brand !== BRAND) throw new Error('VerifiedBytes 不可从外部构造');
    this.bytes = bytes;
    this.identity = identity;
    this.issuer = issuer;
    Object.freeze(this);
  }
}
export { VerifiedBytes };

export function isVerified(v) { return v instanceof VerifiedBytes; }

export function assertVerified(v, where) {
  if (!isVerified(v)) {
    throw new IntegrityError('E_NOT_VERIFIED', `${where} 没有经过 verifySigned()，拒绝继续`);
  }
  return v;
}

/**
 * 默认 verifier：**永远抛错**（fail-closed）。
 * 不提供 `--no-verify` / `--insecure`（02-registry.md §6 末段），
 * 所以这里也不提供「跳过」的默认行为 —— 没接真验签就跑不起来，而不是静默放行。
 */
export function defaultVerifier() {
  throw new IntegrityError(
    'E_VERIFIER_MISSING',
    'Sigstore 验签器未接入：本构建无法验证签名，拒绝继续（不存在 --no-verify）',
  );
}

/**
 * 验签并 brand。verifier 的返回值**不被信任** —— identity / issuer / 字节摘要
 * 三项都在这里**独立重算并精确比对**，所以一个偷懒返回 `{ok:true}` 的 verifier
 * 过不去。
 *
 * @param {Buffer} bytes 被签的原始字节
 * @param {*} bundle Sigstore bundle
 * @param {string} expectIdentity §8 的两个身份之一，精确比对
 * @param {Function} verifier 必传；缺省即 `defaultVerifier`（抛错）
 */
export function verifySigned({ bytes, bundle, expectIdentity, verifier = defaultVerifier, where = 'object' }) {
  if (typeof verifier !== 'function') {
    throw new IntegrityError('E_VERIFIER_MISSING', `${where}：未提供验签器`);
  }
  if (expectIdentity !== RELEASE_IDENTITY && expectIdentity !== TIMESTAMP_IDENTITY) {
    throw new IntegrityError('E_UNKNOWN_IDENTITY', `${where}：期望身份不在 §8 的白名单里`);
  }
  const r = verifier({ bytes, bundle, expectIdentity, expectIssuer: OIDC_ISSUER });
  if (!r || typeof r !== 'object' || r.ok !== true) {
    throw new IntegrityError('E_SIGNATURE', `${where}：验签失败或验签器未返回 ok`);
  }
  // 🔴 精确比对，不做前缀匹配、不做通配（§8）
  if (r.identity !== expectIdentity) {
    throw new IntegrityError('E_IDENTITY_MISMATCH',
      `${where}：签名身份是 ${r.identity}，期望 ${expectIdentity}（两个身份不可互换）`);
  }
  if (r.issuer !== OIDC_ISSUER) {
    throw new IntegrityError('E_ISSUER_MISMATCH', `${where}：issuer 是 ${r.issuer}，期望 ${OIDC_ISSUER}`);
  }
  // verifier 说它验的是哪串字节 —— 必须就是我们手上这串
  if (r.sha256 !== sha256Of(bytes)) {
    throw new IntegrityError('E_SIGNED_BYTES_MISMATCH', `${where}：验签器验的不是我们手上的字节`);
  }
  return new VerifiedBytes(BRAND, bytes, r.identity, r.issuer);
}

// ── semver（禁 +build，D7） ─────────────────────────────────────────────────

const RE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(v, where) {
  assertString(v, where);
  if (v.includes('+')) throw new WireError('E_SEMVER_BUILD', `${where} 禁止 +build metadata（D7）：${v}`);
  const m = RE_SEMVER.exec(v);
  if (!m) throw new WireError('E_SEMVER', `${where} 不是合法 semver 2.0.0：${v}`);
  if (m[4] != null) {
    for (const id of m[4].split('.')) {
      // SemVer §9：数字标识符不得有前导零。`1.0.0-01` 形状像 semver 但不是。
      if (/^\d+$/.test(id) && id.length > 1 && id[0] === '0') {
        throw new WireError('E_SEMVER', `${where} 的预发布数字标识符有前导零：${id}`);
      }
      // 超过 2^53-1 的数字标识符转成 Number 会丢精度，比较结果就不可信了
      if (/^\d+$/.test(id) && !Number.isSafeInteger(Number(id))) {
        throw new WireError('E_SEMVER', `${where} 的预发布数字标识符超出安全整数范围：${id}`);
      }
    }
  }
  for (const part of [m[1], m[2], m[3]]) {
    if (!Number.isSafeInteger(Number(part))) throw new WireError('E_SEMVER', `${where} 的版本号分量超出安全整数范围：${part}`);
  }
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ?? null, raw: v };
}

export function compareSemver(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1; // 正式版 > 预发布
  if (b.prerelease === null) return -1;
  const ax = a.prerelease.split('.'), bx = b.prerelease.split('.');
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const x = ax[i], y = bx[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1; continue; }
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ── timestamp（02-registry.md §3） ──────────────────────────────────────────

const TIMESTAMP_KEYS = {
  required: ['schema', 'version', 'repo', 'latest_snapshot', 'snapshot_sha256', 'min_cli_version', 'created_at', 'valid_until'],
};

/**
 * 严格解析 timestamp。**不做** freshness 判定 —— 那一步要拿 `now`，
 * 由 `assertFresh()` 单独做，好让 `--offline` 能把「过期」降级成 stale 标记
 * 而不是硬失败（§6 第 3 步末段）。
 */
export function parseTimestamp(bytes) {
  const doc = parseWireJson(bytes, 'timestamp.json');
  assertExactKeys(doc, TIMESTAMP_KEYS, 'timestamp.json');
  if (doc.schema !== TIMESTAMP_SCHEMA) {
    throw new WireError('E_SCHEMA', `timestamp 的 schema 必须是 ${TIMESTAMP_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
  }
  assertUint(doc.version, 'timestamp.version');
  assertUint(doc.latest_snapshot, 'timestamp.latest_snapshot');
  if (doc.repo !== REPO) throw new IntegrityError('E_REPO', `timestamp.repo 必须等于内置常量 ${REPO}，得到 ${doc.repo}`);
  assertAssetDigest(doc.snapshot_sha256, 'timestamp.snapshot_sha256');
  parseSemver(doc.min_cli_version, 'timestamp.min_cli_version');
  const created = parseWireTime(doc.created_at, 'timestamp.created_at');
  const until = parseWireTime(doc.valid_until, 'timestamp.valid_until');

  // 🔴 完整时间规则（§3）：v3 只写了上界，允许负有效期与遥远未来的签发时间
  const span = until - created;
  if (span <= 0) throw new IntegrityError('E_TS_NEGATIVE_VALIDITY', `valid_until 不晚于 created_at（${span}s）`);
  if (span > TIMESTAMP_MAX_VALIDITY_SECONDS) {
    throw new IntegrityError('E_TS_VALIDITY_TOO_LONG', `有效期 ${span}s 超过 7 天上限`);
  }
  // 🔴 canonical 往返：timestamp 是需要逐字节复现的对象（§3 of 11-wire-contract）
  assertCanonicalBytes(bytes, doc, 'timestamp.json');
  return { ...doc, _created: created, _until: until, _sha256: sha256Of(bytes) };
}

/**
 * freshness。🔴 **本机时钟是 freshness 的输入**（07-threat-model.md 6f）——
 * 拨快 → 一切 timestamp 显得过期（fail-closed，可接受）；
 * 拨慢 → 过期的 timestamp 仍被接受，回放窗口被拉长。如实承认，不假装不存在。
 *
 * @returns {{stale:boolean}} `--offline` 时 stale 由调用方决定是否放行（需 --allow-stale）
 */
export function assertFresh(ts, { now = Date.now(), offline = false } = {}) {
  const nowS = Math.floor(now / 1000);
  if (ts._created > nowS + CLOCK_SKEW_SECONDS) {
    throw new IntegrityError('E_TS_FUTURE',
      `timestamp.created_at 在未来（超出 ${CLOCK_SKEW_SECONDS}s 时钟偏移容忍）`);
  }
  if (nowS >= ts._until) {
    if (offline) return { stale: true };
    throw new StaleError(`timestamp 已于 ${ts.valid_until} 过期（退出码 8；--offline 下可用 --allow-stale）`);
  }
  return { stale: false };
}

/**
 * `min_cli_version`（§3.1）：**止血提示，不是撤销机制**。
 * 它只对新版 CLI 有效 —— 已装的旧 CLI 那一版代码里根本没有这段逻辑。
 */
export function assertMinCliVersion(ts, cliVersion) {
  const need = parseSemver(ts.min_cli_version, 'timestamp.min_cli_version');
  const have = parseSemver(cliVersion, 'cliVersion');
  if (compareSemver(have, need) < 0) {
    throw new MinCliVersionError(`CLI ${cliVersion} 低于 timestamp 要求的 ${ts.min_cli_version}，请升级`);
  }
}

// ── snapshot（02-registry.md §2） ───────────────────────────────────────────

const RE_NAMESPACE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const RE_NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const RE_COMMIT = /^[0-9a-f]{40}$/;
const KINDS = new Set(['skill', 'pack']);
const STATUSES = new Set(['published', 'deprecated', 'yanked', 'degraded']);
/** 🔴 §2.3：submitted / in_review / approved / rejected 不进快照 */
const NON_SNAPSHOT_STATUSES = new Set(['submitted', 'in_review', 'approved', 'rejected']);

const SNAPSHOT_KEYS = { required: ['schema', 'snapshot', 'previous', 'created_at', 'repo', 'artifacts', 'yanked', 'latest'] };
const RECORD_KEYS = {
  required: ['id', 'kind', 'namespace', 'name', 'version', 'path', 'tree_digest', 'asset',
    'clients', 'capabilities', 'replaces', 'conflicts', 'license', 'owner', 'provenance', 'status', 'review'],
};
const ASSET_KEYS = { required: ['file', 'sha256', 'size'] };
const OWNER_KEYS = { required: ['kind', 'login', 'id'] };
const REVIEW_KEYS = { required: ['pr', 'approved_by', 'head_sha', 'capability_tier'] };
const YANK_KEYS = { required: ['id', 'at', 'reason'], optional: ['advisory', 'superseded_by'] };
const PROV_VENDORED = {
  required: ['kind', 'origin_repo', 'origin_ref', 'origin_commit', 'origin_subpath',
    'origin_tree_digest', 'license_evidence', 'imported_at', 'imported_by_pr', 'added_files'],
};
const PROV_ORIGINAL = { required: ['kind', 'author_github_id', 'submitted_by_pr'] };

function validateProvenance(p, where) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new WireError('E_WIRE_TYPE', `${where} 必须是对象`);
  if (p.kind === 'vendored') {
    assertExactKeys(p, PROV_VENDORED, where);
    assertString(p.origin_repo, `${where}.origin_repo`);
    assertString(p.origin_ref, `${where}.origin_ref`);
    // 🔴 origin_commit 必须是 40 位 commit SHA，不能只记 tag —— tag 可以被移动，
    //    那正是「审核后换内容」的攻击路径（05-lifecycle.md §6）。
    if (!RE_COMMIT.test(p.origin_commit ?? '')) {
      throw new WireError('E_PROV_COMMIT', `${where}.origin_commit 必须是 40 位小写 hex，得到 ${p.origin_commit}`);
    }
    assertString(p.origin_subpath, `${where}.origin_subpath`);
    assertAssetDigest(p.origin_tree_digest, `${where}.origin_tree_digest`);
    assertString(p.license_evidence, `${where}.license_evidence`);
    parseWireTime(p.imported_at, `${where}.imported_at`);
    assertUint(p.imported_by_pr, `${where}.imported_by_pr`);
    assertStringArray(p.added_files, `${where}.added_files`);
  } else if (p.kind === 'original') {
    assertExactKeys(p, PROV_ORIGINAL, where);
    assertString(p.author_github_id, `${where}.author_github_id`);
    assertUint(p.submitted_by_pr, `${where}.submitted_by_pr`);
  } else {
    throw new WireError('E_PROV_KIND', `${where}.kind 只能是 vendored / original，得到 ${JSON.stringify(p.kind)}`);
  }
  return p;
}

function validateRecord(r, i) {
  const where = `snapshot.artifacts[${i}]`;
  assertExactKeys(r, RECORD_KEYS, where);
  if (!KINDS.has(r.kind)) throw new WireError('E_KIND', `${where}.kind 只能是 skill / pack，得到 ${JSON.stringify(r.kind)}`);
  if (!RE_NAMESPACE.test(assertString(r.namespace, `${where}.namespace`))) {
    throw new WireError('E_NAMESPACE', `${where}.namespace 不合 grammar：${r.namespace}`);
  }
  if (!RE_NAME.test(assertString(r.name, `${where}.name`))) {
    throw new WireError('E_NAME', `${where}.name 不合 grammar：${r.name}`);
  }
  const sv = parseSemver(r.version, `${where}.version`);

  // ArtifactId 与各字段一致（01-artifacts.md §3、§5.3 的第 6 项）
  const wantId = `${r.kind}:${r.namespace}/${r.name}@${r.version}`;
  if (r.id !== wantId) throw new WireError('E_ID_MISMATCH', `${where}.id 应为 ${wantId}，得到 ${r.id}`);
  const wantPath = `artifacts/${r.kind}s/${r.namespace}/${r.name}/${r.version}`;
  if (r.path !== wantPath) throw new WireError('E_PATH_MISMATCH', `${where}.path 应为 ${wantPath}，得到 ${r.path}`);

  assertTreeDigest(r.tree_digest, `${where}.tree_digest`);

  assertExactKeys(r.asset, ASSET_KEYS, `${where}.asset`);
  assertString(r.asset.file, `${where}.asset.file`);
  assertAssetDigest(r.asset.sha256, `${where}.asset.sha256`);
  assertUint(r.asset.size, `${where}.asset.size`);

  assertStringArray(r.clients, `${where}.clients`);
  assertStringArray(r.capabilities, `${where}.capabilities`);
  assertStringArray(r.replaces, `${where}.replaces`);
  assertStringArray(r.conflicts, `${where}.conflicts`);
  assertString(r.license, `${where}.license`);

  assertExactKeys(r.owner, OWNER_KEYS, `${where}.owner`);
  assertString(r.owner.kind, `${where}.owner.kind`);
  assertString(r.owner.login, `${where}.owner.login`);
  assertString(r.owner.id, `${where}.owner.id`);

  validateProvenance(r.provenance, `${where}.provenance`);

  if (NON_SNAPSHOT_STATUSES.has(r.status)) {
    throw new WireError('E_STATUS_NOT_IN_SNAPSHOT', `${where}.status=${r.status} 不得进入快照（§2.3）`);
  }
  if (!STATUSES.has(r.status)) throw new WireError('E_STATUS', `${where}.status 不合法：${JSON.stringify(r.status)}`);

  assertExactKeys(r.review, REVIEW_KEYS, `${where}.review`);
  assertUint(r.review.pr, `${where}.review.pr`);
  assertStringArray(r.review.approved_by, `${where}.review.approved_by`);
  // review.head_sha 指向投稿 PR 的 head，早于本快照存在 → 允许（§2.1）
  if (!RE_COMMIT.test(assertString(r.review.head_sha, `${where}.review.head_sha`))) {
    throw new WireError('E_REVIEW_HEAD_SHA', `${where}.review.head_sha 必须是 40 位小写 hex`);
  }
  assertUint(r.review.capability_tier, `${where}.review.capability_tier`);

  return { ...r, _semver: sv };
}

/**
 * 严格解析 snapshot（§6 第 5 步）。
 * 🔴 **只校验 snapshot 自身可得的数据** —— 与载荷 manifest 的六/七项绑定在第 7 步做，
 *    manifest 在资产内部，这里根本拿不到（v3 在这里要求校验，顺序上不可能）。
 *
 * @param {Buffer} bytes
 * @param {{expectSnapshot:number}} opts N = timestamp.latest_snapshot
 */
export function parseSnapshot(bytes, { expectSnapshot } = {}) {
  const doc = parseWireJson(bytes, 'snapshot');
  assertExactKeys(doc, SNAPSHOT_KEYS, 'snapshot');
  if (doc.schema !== SNAPSHOT_SCHEMA) {
    throw new WireError('E_SCHEMA', `snapshot 的 schema 必须是 ${SNAPSHOT_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
  }
  assertUint(doc.snapshot, 'snapshot.snapshot');
  assertUint(doc.previous, 'snapshot.previous');
  if (doc.previous >= doc.snapshot && doc.snapshot !== 0) {
    throw new WireError('E_SNAPSHOT_PREV', `snapshot.previous(${doc.previous}) 必须小于 snapshot(${doc.snapshot})`);
  }
  parseWireTime(doc.created_at, 'snapshot.created_at');
  if (doc.repo !== REPO) throw new IntegrityError('E_REPO', `snapshot.repo 必须等于内置常量 ${REPO}`);
  if (expectSnapshot !== undefined && doc.snapshot !== expectSnapshot) {
    throw new IntegrityError('E_SNAPSHOT_N', `snapshot=${doc.snapshot}，但 timestamp.latest_snapshot=${expectSnapshot}`);
  }
  if (!Array.isArray(doc.artifacts)) throw new WireError('E_WIRE_TYPE', 'snapshot.artifacts 必须是数组');
  if (!Array.isArray(doc.yanked)) throw new WireError('E_WIRE_TYPE', 'snapshot.yanked 必须是数组');

  const records = doc.artifacts.map(validateRecord);

  // 🔴 artifacts 按 id 字节序**严格升序**（§2.3）——顺序参与确定性，不符即拒
  for (let i = 1; i < records.length; i++) {
    const a = Buffer.from(records[i - 1].id, 'utf8'), b = Buffer.from(records[i].id, 'utf8');
    const c = Buffer.compare(a, b);
    if (c === 0) throw new WireError('E_ID_DUPLICATE', `snapshot.artifacts 里 id 重复：${records[i].id}`);
    if (c > 0) throw new WireError('E_ARTIFACTS_ORDER', `snapshot.artifacts 未按 id 字节序升序：${records[i - 1].id} 之后是 ${records[i].id}`);
  }

  // yanked 列表
  const byId = new Map(records.map(r => [r.id, r]));
  const seenYank = new Set();
  doc.yanked.forEach((y, i) => {
    const where = `snapshot.yanked[${i}]`;
    if (typeof y?.id === 'string') {
      if (seenYank.has(y.id)) throw new WireError('E_YANK_DUPLICATE', `${where}：yanked 列表里 id 重复：${y.id}`);
      seenYank.add(y.id);
    }
    assertExactKeys(y, YANK_KEYS, where);
    assertString(y.id, `${where}.id`);
    parseWireTime(y.at, `${where}.at`);
    assertString(y.reason, `${where}.reason`);
    if (Object.hasOwn(y, 'advisory')) assertString(y.advisory, `${where}.advisory`);
    if (Object.hasOwn(y, 'superseded_by')) assertString(y.superseded_by, `${where}.superseded_by`);
    const rec = byId.get(y.id);
    if (!rec) throw new WireError('E_YANK_UNKNOWN', `${where}.id 不在 artifacts 里：${y.id}`);
    if (rec.status !== 'yanked') {
      throw new WireError('E_YANK_STATUS', `${where} 列出了 ${y.id}，但它的 status 是 ${rec.status}`);
    }
  });
  for (const r of records) {
    if (r.status === 'yanked' && !doc.yanked.some(y => y.id === r.id)) {
      throw new WireError('E_YANK_MISSING', `${r.id} 的 status 是 yanked，却不在 yanked 列表里`);
    }
  }

  // 🔴 latest 投影自洽（§2.3）：只列非 yank、非 prerelease、**非 degraded** 的最高版本。
  //    v2 会把 degraded 的最高版选成默认，然后安装必失败。
  const expected = new Map();
  for (const r of records) {
    if (r.status === 'yanked' || r.status === 'degraded') continue;
    if (r._semver.prerelease !== null) continue;
    const key = `${r.kind}:${r.namespace}/${r.name}`;
    const cur = expected.get(key);
    if (!cur || compareSemver(r._semver, cur._semver) > 0) expected.set(key, r);
  }
  if (doc.latest === null || typeof doc.latest !== 'object' || Array.isArray(doc.latest)) {
    throw new WireError('E_WIRE_TYPE', 'snapshot.latest 必须是对象');
  }
  const gotKeys = Object.keys(doc.latest).sort();
  const wantKeys = [...expected.keys()].sort();
  if (gotKeys.join('\n') !== wantKeys.join('\n')) {
    throw new WireError('E_LATEST_KEYS',
      `snapshot.latest 的键集不自洽：多了 ${gotKeys.filter(k => !expected.has(k)).join(',') || '(无)'}，` +
      `少了 ${wantKeys.filter(k => !gotKeys.includes(k)).join(',') || '(无)'}`);
  }
  for (const [k, r] of expected) {
    if (doc.latest[k] !== r.version) {
      throw new WireError('E_LATEST_VALUE', `snapshot.latest[${k}] 应为 ${r.version}，得到 ${doc.latest[k]}`);
    }
  }

  assertCanonicalBytes(bytes, doc, 'snapshot');
  return { ...doc, artifacts: records, _sha256: sha256Of(bytes) };
}

/** 逐字节验 snapshot 的 sha256 == timestamp.snapshot_sha256（§6 第 4 步的前半） */
export function assertSnapshotDigest(bytes, expected) {
  const got = sha256Of(bytes);
  if (got !== expected) {
    throw new IntegrityError('E_SNAPSHOT_SHA256', `snapshot 字节 sha256 是 ${got}，timestamp 说应为 ${expected}`);
  }
  return got;
}

// ── 验证链（02-registry.md §6 第 1–6 步） ───────────────────────────────────

/**
 * 🔴 顺序本身就是安全属性，所以把它写成一个函数而不是散在调用方：
 *
 *   1 验 timestamp 签名（identity = timestamp.yml）
 *   2 严格校验 + freshness + min_cli_version
 *   3 抗回滚三分支 + snapshot 单调性（对**本地 floor**）
 *   4 取 snapshot → 先逐字节验 sha256 == timestamp.snapshot_sha256 → **再独立验它自己的签名**
 *     （identity = release.yml。两个身份不可互换）
 *   5 严格解析 snapshot
 *   6 原子推进 trust floor —— **此后才允许下载**
 *
 * 🔴 第 6 步之后返回 `redo` 时调用方必须整个重来，不得沿用已验的旧 timestamp/旧 snapshot。
 * 🔴 `fetchTimestamp` / `fetchSnapshot` 命中缓存也**必须**走完同样的验签 ——
 *    缓存只省网络，不省任何一次密码学校验（§9.2；本机文件可被同权限进程改写）。
 */
export function resolveCurrent(opts) {
  const maxAttempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    const r = resolveCurrentOnce(opts);
    if (r.advanced.action !== 'redo') return r;
    // 🔴 磁盘 floor 在我们验证期间被别的进程推得更高。
    //    **不能把 redo 当成功返回** —— 调用方会拿着 `snapshot`（旧的那张）
    //    继续下载安装，floor 虽然没回退，本进程仍按旧快照装东西。
    //    唯一正确的动作是整个重来：重取 timestamp、重验签、重做 §6 第 3–5 步。
    if (attempt >= maxAttempts) {
      throw new IntegrityError('E_FLOOR_REDO',
        `trust floor 连续 ${maxAttempts} 次在验证期间被推进（磁盘已到 ` +
        `timestamp_version=${r.advanced.diskFloor.timestamp_version}）：放弃本次解析，请重跑`);
    }
  }
}

function resolveCurrentOnce({
  stateDir, fetchTimestamp, fetchSnapshot, verifier,
  cliVersion, now = Date.now(), offline = false, allowStale = false,
}) {
  // 1
  const { bytes: tsBytes, bundle: tsBundle } = fetchTimestamp();
  verifySigned({ bytes: tsBytes, bundle: tsBundle, expectIdentity: TIMESTAMP_IDENTITY, verifier, where: 'timestamp.json' });

  // 2
  const ts = parseTimestamp(tsBytes);
  const fresh = assertFresh(ts, { now, offline });
  if (fresh.stale && !allowStale) {
    throw new StaleError('缓存中的 timestamp 已过期；--offline 下需要 --allow-stale');
  }
  if (cliVersion !== undefined) assertMinCliVersion(ts, cliVersion);

  // 3
  const floor = readTrustFloor(stateDir);
  const candidate = makeFloor({
    timestamp_version: ts.version,
    timestamp_sha256: ts._sha256,
    latest_snapshot: ts.latest_snapshot,
    snapshot_sha256: ts.snapshot_sha256,
    now: new Date(now),
  });
  checkAntiReplay(floor, candidate);

  // 4
  const { bytes: snapBytes, bundle: snapBundle } = fetchSnapshot(ts.latest_snapshot);
  assertSnapshotDigest(snapBytes, ts.snapshot_sha256);
  verifySigned({ bytes: snapBytes, bundle: snapBundle, expectIdentity: RELEASE_IDENTITY, verifier, where: `hub-${ts.latest_snapshot}.json` });

  // 5
  const snapshot = parseSnapshot(snapBytes, { expectSnapshot: ts.latest_snapshot });

  // 6
  const advanced = advanceTrustFloor(stateDir, candidate);
  return { timestamp: ts, snapshot, floor: advanced.floor ?? candidate, advanced, stale: fresh.stale };
}

/**
 * 历史快照的读取路径（§6.1）。🔴 与「解析当前」是**两条不同的路径**：
 * 「N 小于本地 floor 即拒绝」只适用于解析当前；读历史快照 M 可以 < 当前。
 * 但它**只读**：可用于验字节、取证、`--snapshot` 复现，
 * ❌ 不得用它回答「现在还能不能用」——那必须查当前快照。
 */
export function readHistoricalSnapshot({ bytes, bundle, verifier, expectSnapshot }) {
  verifySigned({ bytes, bundle, expectIdentity: RELEASE_IDENTITY, verifier, where: `hub-${expectSnapshot}.json` });
  const snap = parseSnapshot(bytes, { expectSnapshot });
  return Object.freeze({ snapshot: snap, readOnly: true });
}
