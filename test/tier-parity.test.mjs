// 🔴🔴 **两个阶段必须算出同一个 capability tier。**
//
// 合并前是 `scripts/submission/tier-gate.mjs`，promote 侧是
// `scripts/promote/build-inputs.mjs`。2026-09-05 Codex 指出这两处分叉了：
// 前者算 `max(声明, 可执行证据 → 2)`，后者**只看声明**。
//
// 后果有两层，都不是「不好看」：
//   ① 快照里记的 `review.capability_tier` **比实际审的那一档低** ——
//      而快照是权威审计记录，读它的人会以为这份载荷只按那一档审过；
//   ② `assertApprovalsSatisfyTier` 正是拿这个值判审批人数够不够，
//      于是前置门万一被绕过，promote 这一侧也会按较低档放行。
//
// 📌 我给 Codex 的现状描述当时是**错的**（说成「只是告警」）——
//    它读了代码才纠正过来。**读校验器，别照着记忆猜。**
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputs } from '../scripts/promote/build-inputs.mjs';

const roots = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-tier-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const REVIEW = {
  pr: 42,
  author: 'MDQ6_alice',
  headSha: 'a'.repeat(40),
  approvedBy: ['MDQ6_bob', 'MDQ6_carol'],
};

/** 造一个声明 `none` 的 skill 制品；`payload` 决定载荷里放什么。 */
function artifact(payload) {
  const root = join(mk(), 'artifacts');
  const dir = join(root, 'skills', 'ns', 'demo', '1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n# demo\n');
  writeFileSync(join(dir, 'skill.json'), JSON.stringify({
    schema: 'geoly.skills.skill/1', kind: 'skill', namespace: 'ns', name: 'demo',
    version: '1.0.0', description: 'd', license: 'MIT',
    clients: ['claude'], capabilities: ['none'],     // 🔴 声明的是最低档
    replaces: [], conflicts: [],
    provenance: { kind: 'original', author_github_id: REVIEW.author, submitted_by_pr: REVIEW.pr },
  }));
  payload?.(dir);
  return root;
}

// 🔴 形状是 `namespaces`，不是 `owners` —— 我第一版照记忆猜了个键名，
//    `resolveOwner` 当场 TypeError。**读校验器，别照着猜。**
const owners = { namespaces: { ns: { kind: 'user', login: 'alice', id: REVIEW.author } } };
const run = (root) => buildInputs({
  artifactsRoot: root, newIds: ['skill:ns/demo@1.0.0'], owners, review: REVIEW,
});

test('声明 none 且载荷干净 → tier 保持 0', () => {
  const out = run(artifact(null));
  assert.equal(out.artifacts['skill:ns/demo@1.0.0'].review.capability_tier, 0);
});

test('🔴 载荷里有 .sh → promote 侧也必须抬到 Tier 2（声明压不住载荷）', () => {
  const out = run(artifact((dir) => writeFileSync(join(dir, 'run.sh'), 'echo hi\n')));
  assert.equal(out.artifacts['skill:ns/demo@1.0.0'].review.capability_tier, 2,
    'promote 只按声明算的话，快照会记 Tier 0 —— 比实际审的那一档低');
});

test('🔴 shebang 也算 —— 不靠扩展名', () => {
  const out = run(artifact((dir) => writeFileSync(join(dir, 'tool'), '#!/usr/bin/env node\n')));
  assert.equal(out.artifacts['skill:ns/demo@1.0.0'].review.capability_tier, 2);
});

test('🔴 可执行位也算 —— 连扩展名和 shebang 都没有', () => {
  const out = run(artifact((dir) => {
    const p = join(dir, 'opaque');
    writeFileSync(p, 'not a script by name\n');
    chmodSync(p, 0o755);
  }));
  assert.equal(out.artifacts['skill:ns/demo@1.0.0'].review.capability_tier, 2);
});

test('🔴 SKILL.md 里的 shell 代码块**不算** —— 否则这道门会被误报淹掉', () => {
  // ⚠️ 我一度以为这里会误报，因而不敢把它做成硬门。实测不会：
  //    `executableEvidence` 只看**文件条目**的执行位/扩展名/shebang，
  //    而 SKILL.md 既不匹配脚本扩展名、也不以 #! 开头。
  //    **一道经常误报的门两周内就会被关掉** —— 所以「会不会误报」
  //    决定的是这道门能不能活下来，不只是好不好用。
  const out = run(artifact((dir) => writeFileSync(join(dir, 'SKILL.md'),
    '---\nname: demo\ndescription: d\n---\n# demo\n\n```sh\nrm -rf /\n```\n')));
  assert.equal(out.artifacts['skill:ns/demo@1.0.0'].review.capability_tier, 0);
});
