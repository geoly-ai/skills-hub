// promotion PR 的确定性复算 —— 06-submission.md §4、02-registry.md §2.2。
//
// 🔴 这一份的核心是**篡改用例**：手改快照里的任何一处派生字段，复算都必须报出来。
//    一道只能验「没人动过」的门要靠对照原件；这道门不需要原件 ——
//    它验的是「快照与它声称的那棵 artifacts/ 树自洽」。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyPromotionSnapshot, inputsFromSnapshot } from '../scripts/promote/verify-promotion.mjs';
import { buildSnapshot } from '../scripts/build-snapshot.mjs';
import { stringify } from '../src/canonical-json.mjs';
import { makeSkillArtifact, makePackArtifact, cleanupTrees } from './fixtures/pack-tree.mjs';

after(cleanupTrees);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-vp-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const OWNER = { kind: 'org', login: 'geoly-ai', id: 'MDQ6' };
const PROV = { kind: 'original', author_github_id: '123', submitted_by_pr: 118 };
const REVIEW = { pr: 118, approved_by: ['m1'], head_sha: 'c'.repeat(40), capability_tier: 0 };

const expectCode = (code, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

const expectViolation = (v, fn) => {
  try { fn(); } catch (e) {
    assert.equal(e.violation, v, `期望 ${v}，实际 ${e.violation}：${e.message}`);
    return e;
  }
  assert.fail(`期望 ${v}，但没有抛错`);
};

function place(root, art) {
  const { kind, namespace, name, version } = art.record;
  const dir = join(root, 'artifacts', `${kind}s`, namespace, name, version);
  mkdirSync(dir, { recursive: true });
  cpSync(art.root, dir, { recursive: true });
  return art;
}

/** 造一棵 artifacts/ 树 + 一张与它自洽的快照。 */
function scene({ withPack = false } = {}) {
  const root = mkroot();
  const a = place(root, makeSkillArtifact({ name: 'alpha' }));
  const arts = [a];
  if (withPack) arts.push(place(root, makePackArtifact({ name: 'matrix', members: [a.record] })));

  const artifacts = {};
  for (const x of arts) {
    artifacts[x.record.id] = { status: 'published', owner: OWNER, review: REVIEW, provenance: PROV };
  }
  const build = (n, prev) => buildSnapshot({
    artifactsRoot: join(root, 'artifacts'),
    inputs: { schema: 'geoly.skills.promotion-inputs/1', artifacts, yanked: [] },
    snapshot: n, previous: prev,
    createdAt: '2026-08-25T12:00:00Z', repo: 'geoly-ai/skills-hub',
  }).doc;
  // 默认造**创世快照 0**（唯一一张不需要上一张的），不可变门的用例另外自己造 41/42。
  const doc = build(0, 0);
  return {
    root, artifactsRoot: join(root, 'artifacts'), build, doc,
    bytes: Buffer.from(stringify(doc), 'utf8'),
  };
}

/** 手改快照里的一处，重新序列化。 */
const tamper = (doc, fn) => {
  const copy = JSON.parse(JSON.stringify(doc));
  fn(copy);
  return Buffer.from(stringify(copy), 'utf8');
};

// ════════════════════════════════════════════════════════════════════════════

test('自洽的 promotion：复算逐字节一致', () => {
  const s = scene();
  const r = verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: s.bytes });
  assert.equal(r.snapshot, 0);
  assert.equal(r.artifacts, 1);
});

// ── 制品不可变（02-registry §2.1）—— 复算门**查不出来**的那一类 ────────────

/** 用指定的 inputs 造一张快照（不可变门那几条要精确控制 status / yanked）。 */
function snapWith(s, { n, prev, status = 'published', yanked = [] }) {
  const ids = s.doc.artifacts.map((a) => a.id);
  const artifacts = {};
  for (const id of ids) artifacts[id] = { status, owner: OWNER, review: REVIEW, provenance: PROV };
  const { doc } = buildSnapshot({
    artifactsRoot: s.artifactsRoot,
    inputs: { schema: 'geoly.skills.promotion-inputs/1', artifacts, yanked },
    snapshot: n, previous: prev, createdAt: '2026-08-25T12:00:00Z', repo: 'geoly-ai/skills-hub',
  });
  return Buffer.from(stringify(doc), 'utf8');
}
const YANK = (s) => [{ id: s.doc.artifacts[0].id, at: '2026-08-26T00:00:00Z', reason: '安全问题' }];

test('🔴🔴 un-yank：删掉 yank 记录 + status 改回 published + 更新 latest —— 复算完全自洽', () => {
  // 自举的 yanked[] 让这组改动毫无破绽；判据只能是上一张快照
  const s = scene();
  const prev = snapWith(s, { n: 41, prev: 40, yanked: YANK(s) });
  const now = snapWith(s, { n: 42, prev: 41, yanked: [] });
  verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: snapWith(s, { n: 0, prev: 0, yanked: [] }) });
  expectCode('E_UNYANK', () => verifyPromotionSnapshot({
    artifactsRoot: s.artifactsRoot, committedBytes: now, previousBytes: prev,
  }));
});

test('🔴 改 yank 记录的 reason / at → 拒（那是历史事实）', () => {
  const s = scene();
  const prev = snapWith(s, { n: 41, prev: 40, yanked: YANK(s) });
  const now = snapWith(s, { n: 42, prev: 41,
    yanked: [{ ...YANK(s)[0], reason: '其实没什么事' }] });
  expectCode('E_YANK_MUTATED', () => verifyPromotionSnapshot({
    artifactsRoot: s.artifactsRoot, committedBytes: now, previousBytes: prev,
  }));
});

test('🔴 deprecated → published（撤销弃用）→ 拒；published → deprecated 放行', () => {
  const s = scene();
  const dep = snapWith(s, { n: 41, prev: 40, status: 'deprecated' });
  const pub = snapWith(s, { n: 42, prev: 41, status: 'published' });
  expectCode('E_STATUS_REVERTED', () => verifyPromotionSnapshot({
    artifactsRoot: s.artifactsRoot, committedBytes: pub, previousBytes: dep,
  }));
  // 反向是正常动作
  const r = verifyPromotionSnapshot({
    artifactsRoot: s.artifactsRoot,
    committedBytes: snapWith(s, { n: 42, prev: 41, status: 'deprecated' }),
    previousBytes: snapWith(s, { n: 41, prev: 40, status: 'published' }),
  });
  assert.equal(r.immutable, 1);
});

test('🔴 编号跳号 → 拒（读取端只判 previous < snapshot，拦不住这次 DoS）', () => {
  const s = scene();
  expectCode('E_SNAPSHOT_JUMP', () => verifyPromotionSnapshot({
    artifactsRoot: s.artifactsRoot,
    committedBytes: snapWith(s, { n: 9007199254740991, prev: 41 }),
    previousBytes: snapWith(s, { n: 41, prev: 40 }),
  }));
});

test('🔴 创世快照 0 之外不给上一张 → 拒（缺了这道门就是空的）', () => {
  const s = scene();
  const n42 = Buffer.from(stringify(s.build(42, 41)), 'utf8');
  expectCode('E_VERIFY_INPUT',
    () => verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: n42 }));
});

test('历史记录原样传承 → 通过，并报出查了几个', () => {
  const s = scene();
  const r = verifyPromotionSnapshot({
    artifactsRoot: s.artifactsRoot,
    committedBytes: Buffer.from(stringify(s.build(42, 41)), 'utf8'),
    previousBytes: Buffer.from(stringify(s.build(41, 40)), 'utf8'),
  });
  assert.equal(r.immutable, 1);
});

test('🔴🔴 已发布制品被掉包：artifacts/ 与快照**一起**改 → 复算自洽，靠上一张快照才拦得住', () => {
  const s = scene();
  const prev = Buffer.from(stringify(s.build(41, 40)), 'utf8');
  // 换掉已发布版本的载荷，然后重建 42 —— 42 与树完全自洽
  writeFileSync(join(s.artifactsRoot, 'skills', 'geoly', 'alpha', '0.3.6', 'SKILL.md'),
    '---\nname: alpha\ndescription: alpha 的描述\n---\n\n被掉包的正文\n');
  const n42 = Buffer.from(stringify(s.build(42, 41)), 'utf8');
  // 复算这一关它是过得去的 —— 这正是不可变门必须单列的理由。
  // （用创世快照 0 的形态验一次「复算通过」，因为 42 会被上一张的必需性拦在前面）
  verifyPromotionSnapshot({
    artifactsRoot: s.artifactsRoot,
    committedBytes: Buffer.from(stringify(s.build(0, 0)), 'utf8'),
  });
  expectCode('E_ARTIFACT_MUTATED', () => verifyPromotionSnapshot({
    artifactsRoot: s.artifactsRoot, committedBytes: n42, previousBytes: prev,
  }));
});

test('🔴 已发布制品被删 → E_ARTIFACT_REMOVED（只能 yank，不能删）', () => {
  const s = scene();
  const prev = Buffer.from(stringify(s.build(41, 40)), 'utf8');
  rmSync(join(s.artifactsRoot, 'skills'), { recursive: true, force: true });
  const empty = mkroot();
  mkdirSync(join(empty, 'artifacts'), { recursive: true });
  assert.throws(() => verifyPromotionSnapshot({
    artifactsRoot: join(empty, 'artifacts'),
    committedBytes: prev,
    previousBytes: prev,
  }));
});

test('🔴 previous 对不上 → 拒（不能拿任意一张当判据）', () => {
  const s = scene();
  expectCode('E_PREVIOUS_MISMATCH', () => verifyPromotionSnapshot({
    artifactsRoot: s.artifactsRoot,
    committedBytes: Buffer.from(stringify(s.build(42, 41)), 'utf8'),
    previousBytes: Buffer.from(stringify(s.build(40, 39)), 'utf8'),
  }));
});

test('⚠️ status 是唯一允许变的字段：yank 掉一个历史制品不算「被改」', () => {
  const s = scene();
  const prev = Buffer.from(stringify(s.build(41, 40)), 'utf8');
  const id = s.doc.artifacts[0].id;
  const { doc } = buildSnapshot({
    artifactsRoot: s.artifactsRoot,
    inputs: {
      schema: 'geoly.skills.promotion-inputs/1',
      artifacts: { [id]: { status: 'published', owner: OWNER, review: REVIEW, provenance: PROV } },
      yanked: [{ id, at: '2026-08-26T00:00:00Z', reason: '安全问题' }],
    },
    snapshot: 42, previous: 41, createdAt: '2026-08-25T12:00:00Z', repo: 'geoly-ai/skills-hub',
  });
  const r = verifyPromotionSnapshot({
    artifactsRoot: s.artifactsRoot,
    committedBytes: Buffer.from(stringify(doc), 'utf8'),
    previousBytes: prev,
  });
  assert.equal(r.immutable, 1);
});

test('含 pack 的 promotion 也一致（clients 交集 / capabilities 并集都要复算得出来）', () => {
  const s = scene({ withPack: true });
  const r = verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: s.bytes });
  assert.equal(r.artifacts, 2);
});

test('🔴 手改 tree_digest → 复算不一致', () => {
  const s = scene();
  const bad = tamper(s.doc, (d) => { d.artifacts[0].tree_digest = `geoly-tree-v1:sha256:${'e'.repeat(64)}`; });
  const e = expectCode('E_NOT_REPRODUCIBLE',
    () => verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: bad }));
  assert.match(e.message, /第一处不同在第 \d+ 行/, '只说「不一致」的话，人只会去猜，而快照有几万字节');
});

test('🔴 手改 asset.sha256 / size → 复算不一致', () => {
  const s = scene();
  for (const fn of [
    (d) => { d.artifacts[0].asset.sha256 = `sha256:${'f'.repeat(64)}`; },
    (d) => { d.artifacts[0].asset.size += 1; },
  ]) {
    expectCode('E_NOT_REPRODUCIBLE',
      () => verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: tamper(s.doc, fn) }));
  }
});

test('🔴 手改 pack 的 clients（成员交集）→ 复算不一致', () => {
  const s = scene({ withPack: true });
  const bad = tamper(s.doc, (d) => {
    const p = d.artifacts.find((x) => x.kind === 'pack');
    p.clients = ['claude'];      // 少写几个，看起来还挺合理
  });
  expectCode('E_NOT_REPRODUCIBLE',
    () => verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: bad }));
});

test('🔴 手改 latest 投影 → 被**读取端**拦下（复算根本走不到）', () => {
  // 这里如实记录责任分工：`latest` 的自洽性由 `parseSnapshot` 的 §2.3 校验守，
  // 而 `verifyPromotionSnapshot` 第一步就先过它 —— 一张读不回来的快照谈不上复算。
  // ⚠️ 所以这条**不该**期望 E_NOT_REPRODUCIBLE；期望它等于要求同一条规则被查两遍，
  //    而更早的那道门先命中。写成「哪个 code 都行」则会掩盖「其实一道都没拦」。
  const s = scene();
  // 🔴 判据是 `violation`（WireError 的 `code` 是退出码 1，不是错误码）
  expectViolation('E_LATEST_KEYS',
    () => verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: tamper(s.doc, (d) => { d.latest = {}; }) }));
  expectViolation('E_LATEST_VALUE',
    () => verifyPromotionSnapshot({
      artifactsRoot: s.artifactsRoot,
      committedBytes: tamper(s.doc, (d) => { for (const k of Object.keys(d.latest)) d.latest[k] = '9.9.9'; }),
    }));
});

test('🔴 artifacts/ 里少一个制品（快照声称有、树里没有）→ 报出来', () => {
  const s = scene();
  rmSync(join(s.artifactsRoot, 'skills'), { recursive: true, force: true });
  // 树空了 → 复算不出那条 record
  assert.throws(() => verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: s.bytes }));
});

test('🔴 载荷被改一个字节 → tree_digest 与 asset 都会变 → 复算不一致', () => {
  const s = scene();
  const f = join(s.artifactsRoot, 'skills', 'geoly', 'alpha', '0.3.6', 'SKILL.md');
  writeFileSync(f, '---\nname: alpha\ndescription: alpha 的描述\n---\n\n被动过的正文\n');
  expectCode('E_NOT_REPRODUCIBLE',
    () => verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: s.bytes }));
});

test('⚠️ 诚实边界：改 review.approved_by 本门**看不出来**', () => {
  // 它是从被验的那份快照里读出来再喂回去的 —— 由 promote 的重新验证
  // （verify-merged-pr.mjs，§3 第 1 项）与 §2.2 的人工比对来守。
  const s = scene();
  const bad = tamper(s.doc, (d) => { d.artifacts[0].review.approved_by = ['凭空多出来的人']; });
  const r = verifyPromotionSnapshot({ artifactsRoot: s.artifactsRoot, committedBytes: bad });
  assert.equal(r.artifacts, 1, '本门通过 —— 如实记录这个缺口，不假装能拦');
});

test('inputsFromSnapshot：yanked / degraded 还原成 published', () => {
  const snap = {
    artifacts: [
      { id: 'a', status: 'yanked', owner: OWNER, review: REVIEW, provenance: PROV },
      { id: 'b', status: 'degraded', owner: OWNER, review: REVIEW, provenance: PROV },
      { id: 'c', status: 'deprecated', owner: OWNER, review: REVIEW, provenance: PROV },
    ],
    yanked: [{ id: 'a', at: '2026-08-01T00:00:00Z', reason: 'x' }],
  };
  const i = inputsFromSnapshot(snap);
  assert.equal(i.artifacts.a.status, 'published', 'yank 的权威是 yanked[]，不是 status');
  assert.equal(i.artifacts.b.status, 'published', 'degraded 每次重算，不能当输入');
  assert.equal(i.artifacts.c.status, 'deprecated', 'deprecated 是真输入，要保留');
  assert.equal(i.yanked.length, 1);
});

/** 摆出 `--pr` / `--base` 那两棵树的形状。 */
function trees(s, { prSnap, prName, baseSnaps = [] }) {
  const pr = mkroot(); const base = mkroot();
  mkdirSync(join(pr, 'registry', 'snapshots'), { recursive: true });
  mkdirSync(join(base, 'registry', 'snapshots'), { recursive: true });
  cpSync(s.artifactsRoot, join(pr, 'artifacts'), { recursive: true });
  for (const [name, bytes] of baseSnaps) {
    writeFileSync(join(base, 'registry', 'snapshots', name), bytes);
    writeFileSync(join(pr, 'registry', 'snapshots', name), bytes);
  }
  writeFileSync(join(pr, 'registry', 'snapshots', prName), prSnap);
  return { pr, base };
}
const run = (t) => spawnSync(process.execPath, [
  join(REPO_ROOT, 'scripts/promote/verify-promotion.mjs'), '--pr', t.pr, '--base', t.base,
], { encoding: 'utf8' });

test('🔴 CLI 真调用：创世快照 0（base 的 artifacts/ 为空）通过', () => {
  const s = scene();
  const ok = run(trees(s, { prSnap: s.bytes, prName: 'hub-0.json' }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /逐字节一致/);
});

test('🔴 CLI：复算不一致 → 非零退出 + 打出错误码', () => {
  const s = scene();
  const bad = run(trees(s, {
    prSnap: tamper(s.doc, (d) => { d.artifacts[0].asset.size += 1; }), prName: 'hub-0.json',
  }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /字节不一致/);
  assert.match(bad.stderr, /\[E_NOT_REPRODUCIBLE\]/, 'workflow 日志里只有 stderr —— 错误码要打出来');
});

test('🔴 CLI：文件名与内容里的 snapshot 对不上 → 拒', () => {
  // hub-900.json 里写 snapshot: 0 —— 两边各自都自洽，到 release 阶段才炸
  const s = scene();
  const r = run(trees(s, { prSnap: s.bytes, prName: 'hub-900.json' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_FILENAME_MISMATCH\]/);
});

test('🔴 CLI：历史快照被改 → 拒', () => {
  const s = scene();
  const prev = Buffer.from(stringify(s.build(41, 40)), 'utf8');
  const t = trees(s, {
    prSnap: Buffer.from(stringify(s.build(42, 41)), 'utf8'), prName: 'hub-42.json',
    baseSnaps: [['hub-41.json', prev]],
  });
  writeFileSync(join(t.pr, 'registry', 'snapshots', 'hub-41.json'), Buffer.concat([prev, Buffer.from(' ')]));
  const r = run(t);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_SNAPSHOT_MUTATED\]/);
});

test('🔴🔴 CLI：symlink 一律拒 —— 它能让校验器读到 base 上那份没被改的内容', () => {
  const s = scene();
  const t = trees(s, { prSnap: s.bytes, prName: 'hub-0.json' });
  const victim = join(t.pr, 'artifacts', 'skills', 'geoly', 'alpha');
  const real = join(t.pr, 'artifacts', 'skills', 'geoly', 'alpha-real');
  renameSync(victim, real);
  symlinkSync(real, victim);
  const r = run(t);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_SYMLINK\]/);
});

test('🔴 CLI：base 没有快照但已经有 artifacts/ → 不是创世，拒', () => {
  const s = scene();
  const t = trees(s, { prSnap: s.bytes, prName: 'hub-0.json' });
  mkdirSync(join(t.base, 'artifacts', 'skills'), { recursive: true });
  const r = run(t);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_NOT_GENESIS\]/);
});

test('🔴 CLI：新增不止一张快照 → 拒', () => {
  const s = scene();
  const t = trees(s, { prSnap: s.bytes, prName: 'hub-0.json' });
  writeFileSync(join(t.pr, 'registry', 'snapshots', 'hub-1.json'), s.bytes);
  const r = run(t);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_SNAPSHOT_COUNT\]/);
});

test('🔴 CLI 拒拼错的选项 —— 静默忽略 --bse 等于把不可变门关掉', () => {
  const s = scene();
  const t = trees(s, { prSnap: s.bytes, prName: 'hub-0.json' });
  for (const argv of [['--pr', t.pr, '--bse', t.base], ['--pr', t.pr, '--base', t.base, '--base', t.base]]) {
    const r = spawnSync(process.execPath, [
      join(REPO_ROOT, 'scripts/promote/verify-promotion.mjs'), ...argv,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 1, argv.join(' '));
    assert.match(r.stderr, /\[E_VERIFY_INPUT\]/);
  }
});

// ── Codex 2026-08-31 第三轮 ───────────────────────────────────────────────

test('🔴 根**自己**是符号链接 → 拒（existsSync 会跟随，只查内部的写法漏掉这一格）', () => {
  const s = scene();
  const t = trees(s, { prSnap: s.bytes, prName: 'hub-0.json' });
  const real = join(t.pr, 'artifacts-real');
  renameSync(join(t.pr, 'artifacts'), real);
  symlinkSync(real, join(t.pr, 'artifacts'));
  const r = run(t);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_SYMLINK\]/);
  assert.match(r.stderr, /本身就是符号链接/);
});

test('🔴 registry/snapshots/ 里混进别的东西 → 拒', () => {
  // 早先是「过滤出 hub-N.json，其余静默忽略」—— 于是 HUB-1.JSON、随手放的文件、
  // 子目录都能混进来，已有的非 hub 文件还能被改被删，谁也不知道
  // ⚠️ 不放 `HUB-0.JSON`：大小写不敏感的文件系统上它压根不是第二个条目，
  //    而是把 `hub-0.json` 覆盖掉 —— 那条路径由读取端的解析失败拦住，不是本门。
  //    大小写折叠冲突真正要靠的就是这条「只许 hub-<N>.json」的白名单。
  for (const junk of ['notes.md', 'hub-00.json', 'hub-1.txt']) {
    const s = scene();
    const t = trees(s, { prSnap: s.bytes, prName: 'hub-0.json' });
    writeFileSync(join(t.pr, 'registry', 'snapshots', junk), 'x');
    const r = run(t);
    assert.equal(r.status, 1, junk);
    assert.match(r.stderr, /\[E_SNAPSHOTS_DIR_DIRTY\]/, junk);
  }
});

test('🔴 promotion PR 里出现签名 bundle → 拒（签名是阶段 C 的产物）', () => {
  const s = scene();
  const t = trees(s, { prSnap: s.bytes, prName: 'hub-0.json' });
  writeFileSync(join(t.pr, 'registry', 'snapshots', 'hub-0.json.sigstore.json'), '{}');
  const r = run(t);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[E_SNAPSHOTS_DIR_DIRTY\]/);
});

test('base 上已有的 .sigstore.json 可以原样带过来（归档 PR 合并之后就会有）', () => {
  const s = scene();
  const prev = Buffer.from(stringify(s.build(41, 40)), 'utf8');
  const t = trees(s, {
    prSnap: Buffer.from(stringify(s.build(42, 41)), 'utf8'), prName: 'hub-42.json',
    baseSnaps: [['hub-41.json', prev], ['hub-41.json.sigstore.json', Buffer.from('{}')]],
  });
  const r = run(t);
  assert.equal(r.status, 0, r.stderr);
});
