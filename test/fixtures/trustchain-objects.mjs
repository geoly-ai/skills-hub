// 测试夹具：合法的 snapshot / timestamp / attestation / 假验签器
import { createHash } from 'node:crypto';
import { stringify } from '../../src/canonical-json.mjs';
import { OIDC_ISSUER } from '../../src/snapshot.mjs';
import { pae, DSSE_PAYLOAD_TYPE, PREDICATE_TYPE, BUILD_TYPE, STATEMENT_TYPE } from '../../src/attestation.mjs';

export const REPO = 'geoly-ai/skills-hub';
export const hex = (seed) => String(seed).padStart(64, '0');
export const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
export const COMMIT = 'c1d2e3f405162738495a6b7c8d9e0f1122334455';

export function makeRecord(over = {}) {
  const kind = over.kind ?? 'skill';
  const namespace = over.namespace ?? 'geoly';
  const name = over.name ?? 'demo';
  const version = over.version ?? '0.1.0';
  const base = {
    id: `${kind}:${namespace}/${name}@${version}`,
    kind, namespace, name, version,
    path: `artifacts/${kind}s/${namespace}/${name}/${version}`,
    tree_digest: `geoly-tree-v1:sha256:${hex(1)}`,
    asset: { file: `${kind}_${namespace}_${name}_${version}.tar.gz`, sha256: `sha256:${hex(2)}`, size: 100 },
    clients: ['claude'],
    capabilities: ['none'],
    replaces: [], conflicts: [],
    license: 'MIT',
    owner: { kind: 'github-user', login: 'chovizzz', id: 'U_kgDODu4RvA' },
    provenance: { kind: 'original', author_github_id: '123', submitted_by_pr: 118 },
    status: 'published',
    review: { pr: 118, approved_by: ['chovizzz'], head_sha: COMMIT, capability_tier: 0 },
  };
  return { ...base, ...over };
}

const semverKey = (v) => v.split('-')[0].split('.').map(Number);
function higher(a, b) {
  const x = semverKey(a), y = semverKey(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export function makeSnapshotDoc(records, over = {}) {
  const artifacts = [...records].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  const latest = {};
  for (const r of artifacts) {
    if (r.status === 'yanked' || r.status === 'degraded') continue;
    if (r.version.includes('-')) continue;
    const k = `${r.kind}:${r.namespace}/${r.name}`;
    if (!latest[k] || higher(r.version, latest[k])) latest[k] = r.version;
  }
  const yanked = artifacts.filter(r => r.status === 'yanked')
    .map(r => ({ id: r.id, at: '2026-08-25T12:00:00Z', reason: 'test' }));
  return {
    schema: 'geoly.skills.snapshot/2',
    snapshot: over.snapshot ?? 42,
    previous: over.previous ?? 41,
    created_at: over.created_at ?? '2026-08-25T12:00:00Z',
    repo: over.repo ?? REPO,
    artifacts,
    yanked: over.yanked ?? yanked,
    latest: over.latest ?? latest,
  };
}

export const bytesOf = (doc) => Buffer.from(stringify(doc), 'utf8');

export function makeTimestampDoc(over = {}) {
  return {
    schema: 'geoly.skills.timestamp/1',
    version: over.version ?? 137,
    repo: over.repo ?? REPO,
    latest_snapshot: over.latest_snapshot ?? 42,
    snapshot_sha256: over.snapshot_sha256 ?? `sha256:${hex(3)}`,
    min_cli_version: over.min_cli_version ?? '1.2.0',
    created_at: over.created_at ?? '2026-08-25T12:00:00Z',
    valid_until: over.valid_until ?? '2026-09-01T12:00:00Z',
  };
}

/** 2026-08-25T12:00:00Z 之后一小时 —— 上面那份 timestamp 的「现在」 */
export const NOW = Date.parse('2026-08-25T13:00:00Z');

/**
 * 假验签器。🔴 它只在测试里存在，且**仍然要过 verifySigned 的三项独立核对**
 * （identity / issuer / 字节摘要），所以它没法把「没验」伪装成「验过」。
 */
export function fakeVerifier({ signAs = null, corruptSha = false } = {}) {
  return ({ bytes, expectIdentity }) => ({
    ok: true,
    identity: signAs ?? expectIdentity,
    issuer: OIDC_ISSUER,
    sha256: corruptSha ? `sha256:${hex(9)}` : 'sha256:' + sha256Hex(bytes),
  });
}

export function makeAttestationBytes(over = {}) {
  const stmt = {
    _type: over.statementType ?? STATEMENT_TYPE,
    subject: over.subject ?? [{ name: 'hub-42.json', digest: { sha256: hex(3) } }],
    predicateType: over.predicateType ?? PREDICATE_TYPE,
    predicate: {
      buildType: BUILD_TYPE,
      sourceRepo: REPO,
      sourceCommit: COMMIT,
      workflowRef: `.github/workflows/release.yml@${COMMIT}`,
      promotionPr: 214,
      ...(over.predicate ?? {}),
    },
  };
  const payload = Buffer.from(stringify(stmt), 'utf8');
  const env = {
    payload: payload.toString('base64'),
    payloadType: over.payloadType ?? DSSE_PAYLOAD_TYPE,
    signatures: over.signatures ?? [{ sig: Buffer.from('sig').toString('base64') }],
  };
  return { bytes: Buffer.from(stringify(env), 'utf8'), pae: pae(env.payloadType, payload), statement: stmt };
}
