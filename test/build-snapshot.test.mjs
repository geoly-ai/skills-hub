// promotion（scripts/build-snapshot.mjs）—— 02-registry.md §2/§2.2/§2.3、
// 03-packs.md §2.1（clients 交集 / capabilities 并集）、§5（degraded 闭包）。
//
// 🔴 这一份的核心判据只有一条：**产出的快照要能被自己的读取端 `parseSnapshot()`
//    接受**。写入端接受的每一个输入，读取端都必须接受（R-11 的判据）。
//    一张读不回来的快照比没有快照更糟。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { buildSnapshot, readInputs, INPUTS_SCHEMA } from '../scripts/build-snapshot.mjs';
import { stringify } from '../src/canonical-json.mjs';
import { parseSnapshot } from '../src/snapshot.mjs';
import { packArtifact } from '../src/packer.mjs';

const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-promo-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const OWNER = { kind: 'org', login: 'geoly-ai', id: 'MDQ6' };
const REVIEW = { pr: 118, approved_by: ['chovizzz'], head_sha: 'c'.repeat(40), capability_tier: 0 };
const PROV = { kind: 'original', author_github_id: '123', submitted_by_pr: 118 };

/** 在 `<root>/artifacts/skills/<ns>/<name>/<ver>/` 下写一个真 skill 载荷。 */
function putSkill(root, { ns = 'geoly', name, version = '1.0.0', clients = ['claude', 'codex'], capabilities = ['none'], files = {} } = {}) {
  const dir = join(root, 'artifacts', 'skills', ns, name, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 的描述\n---\n\n正文\n`);
  writeFileSync(join(dir, 'skill.json'), stringify({
    schema: 'geoly.skills.skill/1', kind: 'skill', namespace: ns, name, version,
    description: `${name} 的描述`, license: 'MIT', clients, capabilities,
    replaces: [], conflicts: [], provenance: PROV,
  }));
  for (const [rel, data] of Object.entries(files)) writeFileSync(join(dir, rel), data);
  return { id: `skill:${ns}/${name}@${version}`, dir };
}

/** 算一个载荷目录的 tree_digest（pack.json 要冗余记成员摘要）。 */
function digestOf(dir, kind = 'skill') {
  return packArtifact({ root: dir, kind }).tree_digest;
}

function putPack(root, { ns = 'geoly', name = 'matrix', version = '1.0.0', members = [], bundled = [] } = {}) {
  const dir = join(root, 'artifacts', 'packs', ns, name, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MATRIX.md'), '# 矩阵\n');
  writeFileSync(join(dir, 'pack.json'), stringify({
    schema: 'geoly.skills.pack/1', kind: 'pack', namespace: ns, name, version,
    description: '矩阵', license: 'MIT',
    members: members.map((m, i) => ({ id: m.id, tree_digest: m.tree_digest, role: 'matrix', order: i })),
    bundled: bundled.map((m) => ({ id: m.id, tree_digest: m.tree_digest, role: 'tool' })),
    conflicts: [], contract_paths: [],
    compatibility: { previous: null, kind: 'breaking', breaking_reasons: ['首版'] },
  }));
  return { id: `pack:${ns}/${name}@${version}`, dir };
}

function inputsFor(ids, over = {}) {
  const artifacts = {};
  for (const id of ids) {
    // pack 的 provenance 只能由 inputs 给 —— pack.json 里没有这个字段
    const extra = id.startsWith('pack:') ? { provenance: PROV } : {};
    artifacts[id] = { status: 'published', owner: OWNER, review: REVIEW, ...extra, ...(over[id] ?? {}) };
  }
  return { artifacts, yanked: over.__yanked ?? [] };
}

const build = (root, inputs, o = {}) => buildSnapshot({
  artifactsRoot: join(root, 'artifacts'),
  inputs,
  snapshot: o.snapshot ?? 42,
  previous: o.previous ?? 41,
  createdAt: o.createdAt ?? '2026-08-25T12:00:00Z',
  repo: o.repo ?? 'geoly-ai/skills-hub',
});

// ════════════════════════════════════════════════════════════════════════════

test('🔴 产出的快照能被自己的读取端 parseSnapshot() 接受', () => {
  const root = mkroot();
  const a = putSkill(root, { name: 'alpha' });
  const b = putSkill(root, { name: 'beta' });
  const { doc } = build(root, inputsFor([a.id, b.id]));

  const bytes = Buffer.from(stringify(doc), 'utf8');
  const snap = parseSnapshot(bytes, { expectSnapshot: 42 });   // 不抛就是通过
  assert.equal(snap.artifacts.length, 2);
  assert.deepEqual(snap.artifacts.map((r) => r.id), [a.id, b.id]);
  // ⚠️ parseStrict 产出的是 **null 原型**对象，deepStrictEqual 会因原型不同而失败
  assert.deepEqual({ ...snap.latest }, { 'skill:geoly/alpha': '1.0.0', 'skill:geoly/beta': '1.0.0' });
});

test('🔴 确定性：同一棵树 + 同一个 --created-at → 逐字节相同', () => {
  const root = mkroot();
  const a = putSkill(root, { name: 'alpha' });
  const inputs = inputsFor([a.id]);
  const one = stringify(build(root, inputs).doc);
  const two = stringify(build(root, inputs).doc);
  assert.equal(one, two);
  // created_at 是**输入**，不是 Date.now()
  const three = stringify(build(root, inputs, { createdAt: '2026-09-01T00:00:00Z' }).doc);
  assert.notEqual(one, three);
  assert.match(three, /2026-09-01T00:00:00Z/);
});

test('pack 的 clients 是成员**交集**、capabilities 是成员+bundled 的**并集**', () => {
  const root = mkroot();
  const s1 = putSkill(root, { name: 'alpha', clients: ['claude', 'codex', 'agents'], capabilities: ['none'] });
  const s2 = putSkill(root, { name: 'beta', clients: ['claude', 'codex'], capabilities: ['network'] });
  const tool = putSkill(root, { name: 'tool', clients: ['claude'], capabilities: ['exec'] });
  const p = putPack(root, {
    members: [{ id: s1.id, tree_digest: digestOf(s1.dir) }, { id: s2.id, tree_digest: digestOf(s2.dir) }],
    bundled: [{ id: tool.id, tree_digest: digestOf(tool.dir) }],
  });
  const { doc } = build(root, inputsFor([s1.id, s2.id, tool.id, p.id]));
  const rec = doc.artifacts.find((r) => r.id === p.id);

  // 🔴 交集**不含** bundled（它可以被 --no-bundled 跳过）
  assert.deepEqual(rec.clients, ['claude', 'codex']);
  // 🔴 并集**含** bundled（capability 并集决定 pack 自己的审查 Tier）
  assert.deepEqual([...rec.capabilities].sort(), ['exec', 'network', 'none']);
  parseSnapshot(Buffer.from(stringify(doc), 'utf8'), { expectSnapshot: 42 });
});

test('🔴 clients 交集为空 → promotion 阶段直接拒绝，不进快照', () => {
  const root = mkroot();
  const s1 = putSkill(root, { name: 'alpha', clients: ['claude'] });
  const s2 = putSkill(root, { name: 'beta', clients: ['codex'] });
  const p = putPack(root, {
    members: [{ id: s1.id, tree_digest: digestOf(s1.dir) }, { id: s2.id, tree_digest: digestOf(s2.dir) }],
  });
  assert.throws(
    () => build(root, inputsFor([s1.id, s2.id, p.id])),
    /clients 交集为空/,
  );
});

test('🔴 pack.json 冗余记的 tree_digest 与实际打出来的不符 → 完整性事件', () => {
  const root = mkroot();
  const s1 = putSkill(root, { name: 'alpha' });
  const p = putPack(root, {
    members: [{ id: s1.id, tree_digest: `geoly-tree-v1:sha256:${'e'.repeat(64)}` }],
  });
  assert.throws(
    () => build(root, inputsFor([s1.id, p.id])),
    /完整性事件/,
  );
});

test('🔴 必装成员被 yank → 该 pack 重算为 degraded，且 latest 不选它', () => {
  const root = mkroot();
  const s1 = putSkill(root, { name: 'alpha' });
  const s2 = putSkill(root, { name: 'beta' });
  const p = putPack(root, {
    members: [{ id: s1.id, tree_digest: digestOf(s1.dir) }, { id: s2.id, tree_digest: digestOf(s2.dir) }],
  });
  const inputs = inputsFor([s1.id, s2.id, p.id], {
    __yanked: [{ id: s2.id, at: '2026-08-25T11:00:00Z', reason: '有问题' }],
  });
  const { doc } = build(root, inputs);

  assert.equal(doc.artifacts.find((r) => r.id === s2.id).status, 'yanked');
  // 🔴 degraded 是 promotion **每次重算**并写进快照的派生状态
  assert.equal(doc.artifacts.find((r) => r.id === p.id).status, 'degraded');
  // §5 末段 / §2.3：latest 排除 degraded 与 yanked
  assert.equal(doc.latest[`pack:geoly/matrix`], undefined);
  assert.equal(doc.latest['skill:geoly/beta'], undefined);
  assert.equal(doc.latest['skill:geoly/alpha'], '1.0.0');
  parseSnapshot(Buffer.from(stringify(doc), 'utf8'), { expectSnapshot: 42 });
});

test('只有 bundled 成员被 yank → pack 仍是 published（§5 的表）', () => {
  const root = mkroot();
  const s1 = putSkill(root, { name: 'alpha' });
  const tool = putSkill(root, { name: 'tool' });
  const p = putPack(root, {
    members: [{ id: s1.id, tree_digest: digestOf(s1.dir) }],
    bundled: [{ id: tool.id, tree_digest: digestOf(tool.dir) }],
  });
  const { doc } = build(root, inputsFor([s1.id, tool.id, p.id], {
    __yanked: [{ id: tool.id, at: '2026-08-25T11:00:00Z', reason: '有问题' }],
  }));
  assert.equal(doc.artifacts.find((r) => r.id === p.id).status, 'published');
  assert.equal(doc.latest['pack:geoly/matrix'], '1.0.0');
});

test('latest 排除 prerelease，但制品本身照常进快照', () => {
  const root = mkroot();
  const a = putSkill(root, { name: 'alpha', version: '1.0.0' });
  const rc = putSkill(root, { name: 'alpha', version: '2.0.0-rc.1' });
  const { doc } = build(root, inputsFor([a.id, rc.id]));
  assert.equal(doc.artifacts.length, 2);
  assert.equal(doc.latest['skill:geoly/alpha'], '1.0.0');
  parseSnapshot(Buffer.from(stringify(doc), 'utf8'), { expectSnapshot: 42 });
});

test('🔴 inputs 缺 owner / review → 拒绝（本脚本不发明投稿事实）', () => {
  const root = mkroot();
  const a = putSkill(root, { name: 'alpha' });
  assert.throws(() => build(root, { artifacts: { [a.id]: { status: 'published' } }, yanked: [] }),
    /缺 owner \/ review/);
  assert.throws(() => build(root, { artifacts: {}, yanked: [] }),
    /--inputs 里没有 skill:geoly\/alpha@1\.0\.0/);
});

test('🔴 artifacts/ 下出现 skills/ packs/ 之外的目录 → 拒绝，不「宽松跳过」', () => {
  const root = mkroot();
  putSkill(root, { name: 'alpha' });
  mkdirSync(join(root, 'artifacts', 'junk'), { recursive: true });
  assert.throws(() => build(root, inputsFor([])), /只允许 skills\/ 与 packs\//);
});

test('readInputs：schema 不对就拒', () => {
  const root = mkroot();
  const p = join(root, 'in.json');
  writeFileSync(p, stringify({ schema: 'nope/1', artifacts: {} }));
  assert.throws(() => readInputs(p), new RegExp(INPUTS_SCHEMA.replace(/\//g, '\\/')));
});

test('🔴 degraded 不是可以输入的状态 —— 上一轮的结论不许伪装成事实', () => {
  const root = mkroot();
  const s1 = putSkill(root, { name: 'alpha' });
  const p = putPack(root, { members: [{ id: s1.id, tree_digest: digestOf(s1.dir) }] });
  // computePackStatus 自己就写死了「selfStatus 不接受 degraded —— 它是本函数的输出，
  // 不是输入」；promotion 这一侧必须守同一条线。
  assert.throws(
    () => build(root, inputsFor([s1.id, p.id], { [p.id]: { status: 'degraded', owner: OWNER, review: REVIEW, provenance: PROV } })),
    /是 promotion 每次\*\*重算\*\*的派生状态/,
  );
  // yanked 同理：权威是 yanked[]，那里才有 at / reason / advisory
  assert.throws(
    () => build(root, inputsFor([s1.id, p.id], { [s1.id]: { status: 'yanked', owner: OWNER, review: REVIEW } })),
    /yank 的权威是快照的 yanked\[\]/,
  );
  assert.throws(
    () => build(root, inputsFor([s1.id, p.id], { [s1.id]: { status: '在审', owner: OWNER, review: REVIEW } })),
    /status 不认识/,
  );
});

test('🔴 成员修好之后，pack 必须被重算回 published（不能粘住上一轮的 degraded）', () => {
  const root = mkroot();
  const s1 = putSkill(root, { name: 'alpha' });
  const s2 = putSkill(root, { name: 'beta' });
  const members = [{ id: s1.id, tree_digest: digestOf(s1.dir) }, { id: s2.id, tree_digest: digestOf(s2.dir) }];
  const p = putPack(root, { members });

  // 第一轮：beta 被 yank → pack degraded
  const one = build(root, inputsFor([s1.id, s2.id, p.id], {
    __yanked: [{ id: s2.id, at: '2026-08-25T11:00:00Z', reason: '有问题' }],
  }));
  assert.equal(one.doc.artifacts.find((r) => r.id === p.id).status, 'degraded');

  // 第二轮：advisory 撤销，beta 不再在 yanked 里 → pack 必须回到 published
  const two = build(root, inputsFor([s1.id, s2.id, p.id]));
  assert.equal(two.doc.artifacts.find((r) => r.id === p.id).status, 'published',
    'degraded 是每次重算的派生状态，不是会粘住的标记');
  assert.equal(two.doc.latest['pack:geoly/matrix'], '1.0.0');
});

test('🔴 写盘顺序：先资产、后快照；且都是原子写', async () => {
  const { main } = await import('../scripts/build-snapshot.mjs');
  const root = mkroot();
  const a = putSkill(root, { name: 'alpha' });
  const inFile = join(root, 'in.json');
  writeFileSync(inFile, stringify({ schema: INPUTS_SCHEMA, artifacts: inputsFor([a.id]).artifacts, yanked: [] }));
  const out = join(root, 'registry', 'snapshots', 'hub-42.json');
  const assetsOut = join(root, 'dist', 'assets');

  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    await main(['--artifacts', join(root, 'artifacts'), '--inputs', inFile, '--snapshot', '42',
      '--previous', '41', '--created-at', '2026-08-25T12:00:00Z',
      '--repo', 'geoly-ai/skills-hub', '--out', out, '--assets-out', assetsOut]);
  } finally { process.stderr.write = origWrite; }

  const snap = parseSnapshot(readFileSync(out), { expectSnapshot: 42 });
  const file = snap.artifacts[0].asset.file;
  assert.ok(existsSync(join(assetsOut, file)), '快照声明的资产必须已经在盘上');
  // 原子写不留临时文件
  assert.deepEqual(readdirSync(dirname(out)).filter((n) => n.startsWith('.')), []);
  assert.deepEqual(readdirSync(assetsOut).filter((n) => n.startsWith('.')), []);
});
