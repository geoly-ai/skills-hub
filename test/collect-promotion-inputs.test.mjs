// 把 PROMOTION.json 收成 build-inputs 的入参 —— 决策 ②。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectPromotionInputs } from '../scripts/promote/collect-promotion-inputs.mjs';

const roots = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-cpi-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const expectCode = (code, fn) => {
  try { fn(); } catch (e) { assert.equal(e.code, code, `实际 ${e.code}：${e.message}`); return e; }
  assert.fail(`期望 ${code}，但没有抛错`);
};

const PR = { number: 118, authorId: 'MDQ6_alice', authorLogin: 'alice', createdAt: '2026-08-31T00:00:00Z' };
const SCHEMA = 'geoly.skills.promotion-file/1';

function submissions(specs) {
  const root = join(mk(), 'submissions');
  for (const { ns = 'geoly', name, version = '1.0.0', kind = 'skill', promo } of specs) {
    const dir = join(root, ns, `${name}@${version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# x\n');
    writeFileSync(join(dir, kind === 'pack' ? 'pack.json' : 'skill.json'), '{}');
    if (promo !== undefined) writeFileSync(join(dir, 'PROMOTION.json'), JSON.stringify(promo));
  }
  return root;
}
const quiet = (fn) => fn();

test('已注册 namespace 下的 skill 续版本：什么都不需要', () => {
  const r = collectPromotionInputs({
    submissionsRoot: submissions([{ name: 'alpha' }]),
    pr: PR, registeredNamespaces: new Set(['geoly']),
  });
  assert.deepEqual(r.claimOwner, {});
  assert.deepEqual(r.provenanceOf, {});
});

test('首次注册：claimOwner 由声明 + PR 作者的 node id 合成', () => {
  const r = collectPromotionInputs({
    submissionsRoot: submissions([{
      ns: 'newns', name: 'alpha',
      promo: { schema: SCHEMA, claim_owner: { kind: 'user', login: 'alice' } },
    }]),
    pr: PR, registeredNamespaces: new Set(),
  });
  // 🔴 按 namespace 索引 —— 标量会被套到**每一个**未注册 namespace 上
  assert.deepEqual(r.claimOwner, { newns: { kind: 'user', login: 'alice', id: 'MDQ6_alice' } });
});

test('pack 的 provenance 按 ArtifactId 收', () => {
  const r = collectPromotionInputs({
    submissionsRoot: submissions([{
      name: 'matrix', kind: 'pack', promo: { schema: SCHEMA, provenance: { kind: 'original' } },
    }]),
    pr: PR, registeredNamespaces: new Set(['geoly']),
  });
  assert.deepEqual(r.provenanceOf, {
    'pack:geoly/matrix@1.0.0': { kind: 'original', author_github_id: 'MDQ6_alice', submitted_by_pr: 118 },
  });
});

test('两个未注册 namespace 各自声明 → 各自记，不再互相污染', () => {
  // 早先这里是 E_MULTI_CLAIM（因为 --claim-owner 是标量）。
  // 改成按 namespace 索引之后，这个限制没有必要了 —— 而且原来的模型有个 P0：
  // 一个**没声明**的 namespace 会被套上另一个 namespace 的 owner。
  const root = submissions([
    { ns: 'ns1', name: 'a', promo: { schema: SCHEMA, claim_owner: { kind: 'user', login: 'alice' } } },
    { ns: 'ns2', name: 'b', promo: { schema: SCHEMA, claim_owner: { kind: 'user', login: 'alice' } } },
  ]);
  const r = collectPromotionInputs({ submissionsRoot: root, pr: PR, registeredNamespaces: new Set() });
  assert.deepEqual(Object.keys(r.claimOwner).sort(), ['ns1', 'ns2']);
});

test('🔴🔴 有未注册 namespace **没**声明 claim → 拒（不能让它套上别人的 owner）', () => {
  const root = submissions([
    { ns: 'a', name: 'x' },                                        // 没声明
    { ns: 'b', name: 'y', promo: { schema: SCHEMA, claim_owner: { kind: 'user', login: 'alice' } } },
  ]);
  const e = expectCode('E_PROMO_MISSING',
    () => collectPromotionInputs({ submissionsRoot: root, pr: PR, registeredNamespaces: new Set() }));
  assert.match(e.message, /namespace a 尚未注册/);
});

test('🔴 同一个 namespace 声明了两个不同 owner → 拒', () => {
  const root = submissions([
    { ns: 'ns1', name: 'a', promo: { schema: SCHEMA, claim_owner: { kind: 'user', login: 'alice' } } },
    { ns: 'ns1', name: 'b', promo: { schema: SCHEMA, claim_owner: { kind: 'org', login: 'some-org' } } },
  ]);
  expectCode('E_CLAIM_CONFLICT', () => collectPromotionInputs({
    submissionsRoot: root, pr: PR, registeredNamespaces: new Set(),
    orgIds: { 'some-org': 'MDEyOk9yZw==' },
  }));
});

test('🔴 该有却没有 PROMOTION.json → **拒**，不是记一条 note', () => {
  // 记 note 然后放过等于把问题推到 build-inputs，而那时报的是另一个错，
  // 人要绕一圈才找得到真因
  const e = expectCode('E_PROMO_MISSING', () => collectPromotionInputs({
    submissionsRoot: submissions([{ ns: 'newns', name: 'a' }, { name: 'm', kind: 'pack' }]),
    pr: PR, registeredNamespaces: new Set(['geoly']),
  }));
  assert.match(e.message, /尚未注册/);
  assert.match(e.message, /pack 必须有/);
});

test('🔴 声明成别人的 login → 拒（A 不能把 namespace 注册到 B 名下）', () => {
  expectCode('E_PROMO_OWNER', () => collectPromotionInputs({
    submissionsRoot: submissions([{
      ns: 'newns', name: 'a',
      promo: { schema: SCHEMA, claim_owner: { kind: 'user', login: 'mallory' } },
    }]),
    pr: PR, registeredNamespaces: new Set(),
  }));
});
