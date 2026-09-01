// `PROMOTION.json` —— 决策 ②（R-19 的闭合方式）。
//
// 🔴 这一份钉的是**分工**：投稿者只能声明「只有他知道」的事；
//    凡是「只有 promote 能证明」的（node id、PR 号、导入时刻）由 promote 填。
//    让投稿者写它们，等于让他自称是谁。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readPromotionFile, fillFromPr, PROMOTION_SCHEMA, PROMOTION_FILE,
} from '../scripts/submission/promotion-file.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-promo-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const expectCode = (code, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

/** 写一个投稿目录，带上给定的 PROMOTION.json 内容。 */
function dirWith(doc) {
  const d = mkroot();
  if (doc !== undefined) writeFileSync(join(d, PROMOTION_FILE), JSON.stringify(doc));
  return d;
}

const PR = {
  number: 118, authorId: 'MDQ6User_alice', authorLogin: 'alice',
  createdAt: '2026-08-31T00:00:00Z',
};
const COMMIT = 'a'.repeat(40);
const TREE = `geoly-tree-v1:sha256:${'b'.repeat(64)}`;

// ════════════════════════════════════════════════════════════════════════════

test('没有这个文件 → null（已注册 namespace 下的 skill 续版本不需要它）', () => {
  assert.equal(readPromotionFile(mkroot()), null);
});

test('首次注册：声明 owner 的 kind 与 login', () => {
  const r = readPromotionFile(dirWith({
    schema: PROMOTION_SCHEMA, claim_owner: { kind: 'user', login: 'alice' },
  }));
  assert.deepEqual(r.owner, { kind: 'user', login: 'alice' });
  assert.equal(r.provenance, null);
});

test('pack：声明 provenance 是原创', () => {
  const r = readPromotionFile(dirWith({
    schema: PROMOTION_SCHEMA, provenance: { kind: 'original' },
  }));
  assert.deepEqual(r.provenance, { kind: 'original' });
});

test('pack：搬运的要写全 origin_* 与 license_evidence', () => {
  const v = {
    kind: 'vendored',
    origin_repo: 'someone/upstream',
    origin_ref: 'v1.2.3',
    origin_commit: COMMIT,
    origin_subpath: 'packs/matrix',
    origin_tree_digest: TREE,
    license_evidence: 'LICENSE (MIT)',
    added_files: [],
  };
  const r = readPromotionFile(dirWith({ schema: PROMOTION_SCHEMA, provenance: v }));
  assert.deepEqual(r.provenance, v);
});

// ── 🔴🔴 投稿者不能写 promote 才该填的字段 ────────────────────────────────

test('🔴🔴 写了 node id / PR 号 / 导入时刻 → **拒**，不是忽略', () => {
  // 忽略的话，一个想冒名的投稿看起来会像被接受了
  for (const [where, doc] of [
    ['owner.id', { claim_owner: { kind: 'user', login: 'alice', id: '别人的 id' } }],
    ['author_github_id', { provenance: { kind: 'original', author_github_id: '别人的 id' } }],
    ['submitted_by_pr', { provenance: { kind: 'original', submitted_by_pr: 1 } }],
    ['imported_by_pr', { provenance: { kind: 'vendored', imported_by_pr: 1 } }],
  ]) {
    const e = expectCode('E_PROMO_FORBIDDEN',
      () => readPromotionFile(dirWith({ schema: PROMOTION_SCHEMA, ...doc })), where);
    assert.match(e.message, /自称是谁/, where);
  }
});

test('🔴 kind: user 的 owner 必须就是 PR 作者', () => {
  // 允许写别人的 login，等于让 A 用一次投稿把 namespace 注册到 B 名下
  const declared = { owner: { kind: 'user', login: 'mallory' }, provenance: null };
  const e = expectCode('E_PROMO_OWNER', () => fillFromPr({ declared, kind: 'pack', pr: PR }));
  assert.match(e.message, /只能注册到\*\*投稿者自己\*\*名下/);

  // 自己就行
  const ok = fillFromPr({
    declared: { owner: { kind: 'user', login: 'alice' }, provenance: null }, kind: 'pack', pr: PR,
  });
  assert.deepEqual(ok.owner, { kind: 'user', login: 'alice', id: 'MDQ6User_alice' });
});

test('🔴 kind: org 记的必须是**组织自己**的 node id，不是投稿者的', () => {
  // 记成投稿者的 id，等于把 namespace 给了这个人却显示成组织的 ——
  // 05-lifecycle §1 说 id 才是身份本身
  const declared = { owner: { kind: 'org', login: 'some-org' }, provenance: null };
  expectCode('E_PROMO_ORG_ID', () => fillFromPr({ declared, kind: 'pack', pr: PR }));

  const ok = fillFromPr({
    declared, kind: 'pack', pr: PR, orgIds: { 'some-org': 'MDEyOk9yZ2FuaXph' },
  });
  assert.deepEqual(ok.owner, { kind: 'org', login: 'some-org', id: 'MDEyOk9yZ2FuaXph' });
  // ⚠️「这个人是不是该组织的成员」没有自动判据 —— 归人工门
});

test('🔴 added_files 有重复项 → 拒（它是「多了哪些文件」的权威列表）', () => {
  expectCode('E_PROMO_SHAPE', () => readPromotionFile(dirWith({
    schema: PROMOTION_SCHEMA,
    provenance: {
      kind: 'vendored', origin_repo: 'a/b', origin_ref: 'v1', origin_commit: COMMIT,
      origin_subpath: 'x', origin_tree_digest: TREE, license_evidence: 'MIT',
      added_files: ['a.md', 'a.md'],
    },
  })));
});

test('promote 填上身份与时间', () => {
  const orig = fillFromPr({
    declared: { owner: null, provenance: { kind: 'original' } }, kind: 'pack', pr: PR,
  });
  assert.deepEqual(orig.provenance,
    { kind: 'original', author_github_id: 'MDQ6User_alice', submitted_by_pr: 118 });

  const vend = fillFromPr({
    declared: {
      owner: null,
      provenance: {
        kind: 'vendored', origin_repo: 'a/b', origin_ref: 'v1', origin_commit: COMMIT,
        origin_subpath: 'x', origin_tree_digest: TREE, license_evidence: 'MIT', added_files: [],
      },
    },
    kind: 'pack',
    pr: PR,
  });
  assert.equal(vend.provenance.imported_by_pr, 118);
  assert.equal(vend.provenance.imported_at, '2026-08-31T00:00:00Z');
});

test('🔴 skill 不该在这里声明 provenance —— 它在 skill.json 里', () => {
  const e = expectCode('E_PROMO_SHAPE', () => fillFromPr({
    declared: { owner: null, provenance: { kind: 'original' } }, kind: 'skill', pr: PR,
  }));
  assert.match(e.message, /两个来源就会有两个真值/);
});

// ── 形状 ───────────────────────────────────────────────────────────────────

test('schema 不对 / 有不认识的键 → 拒', () => {
  expectCode('E_PROMO_SHAPE', () => readPromotionFile(dirWith({ schema: 'x' })));
  expectCode('E_PROMO_SHAPE',
    () => readPromotionFile(dirWith({ schema: PROMOTION_SCHEMA, 随手加的: 1 })));
});

test('读不出来 → 拒（不是当作没有）', () => {
  const d = mkroot();
  writeFileSync(join(d, PROMOTION_FILE), '不是 json');
  expectCode('E_PROMO_PARSE', () => readPromotionFile(d));
});

test('🔴 origin_commit 只记 tag 不行 —— tag 可以被移动', () => {
  const base = {
    kind: 'vendored', origin_repo: 'a/b', origin_ref: 'v1', origin_subpath: 'x',
    origin_tree_digest: TREE, license_evidence: 'MIT', added_files: [],
  };
  expectCode('E_PROMO_SHAPE',
    () => readPromotionFile(dirWith({ schema: PROMOTION_SCHEMA, provenance: { ...base, origin_commit: 'v1.2.3' } })));
});

test('🔴 origin_tree_digest 必须带 geoly-tree-v1: 前缀（裸 sha256 分不出算法）', () => {
  const base = {
    kind: 'vendored', origin_repo: 'a/b', origin_ref: 'v1', origin_commit: COMMIT,
    origin_subpath: 'x', license_evidence: 'MIT', added_files: [],
  };
  expectCode('E_PROMO_SHAPE', () => readPromotionFile(dirWith({
    schema: PROMOTION_SCHEMA, provenance: { ...base, origin_tree_digest: `sha256:${'b'.repeat(64)}` },
  })));
});

test('vendored 少一个字段就拒（键集是精确的）', () => {
  expectCode('E_PROMO_SHAPE', () => readPromotionFile(dirWith({
    schema: PROMOTION_SCHEMA,
    provenance: { kind: 'vendored', origin_repo: 'a/b' },
  })));
});

// ── CLI ────────────────────────────────────────────────────────────────────

test('🔴 CLI：形状不对时非零退出并打错误码', () => {
  const d = dirWith({ schema: PROMOTION_SCHEMA, claim_owner: { kind: 'user', login: 'a', id: 'x' } });
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/submission/promotion-file.mjs'), d,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_PROMO_FORBIDDEN\]/);
});

test('CLI：合规时 0，并说清楚「形状合规 ≠ 内容可信」', () => {
  const d = dirWith({ schema: PROMOTION_SCHEMA, provenance: { kind: 'original' } });
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/submission/promotion-file.mjs'), d,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /形状合规 ≠ 内容可信/);
});
