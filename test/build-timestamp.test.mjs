// timestamp 生成器 —— 02-registry.md §3 / §3.2。
//
// 🔴 核心判据：产出的 timestamp 要能被**读取端**（snapshot.mjs 的 parseTimestamp）
//    接受，且 §3 的完整时间规则、单调 version、抗倒退都成立。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTimestamp, newestSnapshot, TIMESTAMP_SCHEMA } from '../scripts/release/build-timestamp.mjs';
import { stringify, parseStrict } from '../src/canonical-json.mjs';
import { makeSnapshotDoc, bytesOf } from './fixtures/trustchain-objects.mjs';
import { makeSkillArtifact, cleanupTrees } from './fixtures/pack-tree.mjs';

after(cleanupTrees);

const roots = [];
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), 'geoly-ts-')); roots.push(d); return d; };
after(() => { for (const d of roots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } } });

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-08-25T12:00:00Z');
const REPO = 'geoly-ai/skills-hub';

/** 在 `<root>/snapshots/` 下放几张真快照（内容自洽，含正确的 `snapshot` 字段）。 */
function putSnapshots(nums) {
  const root = mkroot();
  const dir = join(root, 'snapshots');
  mkdirSync(dir, { recursive: true });
  const a = makeSkillArtifact({ name: 'alpha' });
  const files = {};
  for (const n of nums) {
    const bytes = bytesOf(makeSnapshotDoc([a.record], { snapshot: n, previous: n - 1 }));
    writeFileSync(join(dir, `hub-${n}.json`), bytes);
    // 每张快照旁边都放一份 bundle —— 它自己也以 .json 结尾，必须被剔掉
    writeFileSync(join(dir, `hub-${n}.json.sigstore.json`), '{}');
    files[n] = bytes;
  }
  return { dir, files };
}

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const build = (dir, over = {}) => buildTimestamp({
  snapshotsDir: dir, nowMs: NOW, repo: REPO, minCliVersion: '1.2.0', ...over,
});

// ════════════════════════════════════════════════════════════════════════════

test('🔴 选最新快照：按**数字**取最大，且剔掉 .sigstore.json', () => {
  const { dir } = putSnapshots([2, 9, 10, 42]);
  // 字典序会把 hub-10 排在 hub-2 前面；bundle 自己也匹配 hub-*.json
  assert.equal(newestSnapshot(dir).n, 42);

  const { dir: d2 } = putSnapshots([2, 10]);
  assert.equal(newestSnapshot(d2).n, 10, 'hub-10 > hub-2，不是字典序');
});

test('首次生成：version 从 1 起，字段与 §3 的形状一致', () => {
  const { dir, files } = putSnapshots([42]);
  const ts = build(dir);
  assert.equal(ts.schema, TIMESTAMP_SCHEMA);
  assert.equal(ts.version, 1);
  assert.equal(ts.repo, REPO);
  assert.equal(ts.latest_snapshot, 42);
  assert.equal(ts.snapshot_sha256, sha(files[42]));
  assert.equal(ts.min_cli_version, '1.2.0');
  assert.equal(ts.created_at, '2026-08-25T12:00:00Z');
  assert.equal(ts.valid_until, '2026-09-01T12:00:00Z');
  // §3：0 < (valid_until - created_at) ≤ 7 天
  const span = Date.parse(ts.valid_until) - Date.parse(ts.created_at);
  assert.ok(span > 0 && span <= 7 * 86400_000);
});

test('🔴 首次生成必须显式给 min_cli_version —— 不替它挑一个', () => {
  const { dir } = putSnapshots([42]);
  assert.throws(() => build(dir, { minCliVersion: null }), /必须显式给 --min-cli-version/);
  assert.throws(() => build(dir, { minCliVersion: '不是版本' }), /不合 semver/);
});

test('接力：version 单调递增，min_cli_version 沿用上一份', () => {
  const { dir } = putSnapshots([42]);
  const first = build(dir);
  const second = build(dir, { previous: first, minCliVersion: null, nowMs: NOW + 3 * 86400_000 });
  assert.equal(second.version, 2);
  assert.equal(second.min_cli_version, '1.2.0', '策略值沿用上一份，不用每次都传');
  assert.equal(second.created_at, '2026-08-28T12:00:00Z');
  // 同一张快照刷新一次：指向不变，只有时间与 version 变
  assert.equal(second.latest_snapshot, 42);
  assert.equal(second.snapshot_sha256, first.snapshot_sha256);

  // 显式给的话，覆盖上一份
  const third = build(dir, { previous: second, minCliVersion: '2.0.0' });
  assert.equal(third.version, 3);
  assert.equal(third.min_cli_version, '2.0.0');
});

test('🔴 拒绝倒退：不许把 timestamp 指回一张更旧的快照', () => {
  const { dir } = putSnapshots([42]);
  const prev = { ...build(dir), latest_snapshot: 99 };   // 上一份指向 99
  assert.throws(() => build(dir, { previous: prev }), /拒绝倒退/);
});

test('🔴 文件名的 N 与快照内部声明的 snapshot 必须一致', () => {
  const { dir } = putSnapshots([42]);
  // 把 hub-42.json 换成一份内部写着 snapshot=7 的快照
  writeFileSync(join(dir, 'hub-42.json'), bytesOf(makeSnapshotDoc(
    [makeSkillArtifact({ name: 'alpha' }).record], { snapshot: 7, previous: 6 },
  )));
  assert.throws(() => build(dir), /文件名说它是 42，内部却写着 snapshot=7/);
});

test('🔴 没有快照就拒绝 —— 不签一句谎话', () => {
  const root = mkroot();
  const dir = join(root, 'snapshots');
  mkdirSync(dir, { recursive: true });
  assert.throws(() => build(dir), /没有快照/);
  // 只有 bundle、没有快照，同样算没有
  writeFileSync(join(dir, 'hub-42.json.sigstore.json'), '{}');
  assert.throws(() => build(dir), /没有快照/);
});

test('🔴 有效期上界是 7 天', () => {
  const { dir } = putSnapshots([42]);
  assert.throws(() => build(dir, { validDays: 8 }), /\(0, 7\] 之内/);
  assert.throws(() => build(dir, { validDays: 0 }), /\(0, 7\] 之内/);
  // 3 天（§3.2 的刷新周期）照常
  assert.equal(build(dir, { validDays: 3 }).valid_until, '2026-08-28T12:00:00Z');
});

test('产出的是 canonical JSON（schema 首位、结尾一个换行）', () => {
  const { dir } = putSnapshots([42]);
  const s = stringify(build(dir));
  assert.ok(s.startsWith('{\n  "schema": "geoly.skills.timestamp/1"'), s.slice(0, 60));
  assert.ok(s.endsWith('\n'));
});

test('🔴 CLI 真调用：`node scripts/release/build-timestamp.mjs` 必须真的产出文件', () => {
  // 🔴 这条测的是**入口守卫**，不是逻辑。早先守卫写的是
  //    `import.meta.url === `file://${process.argv[1]}``，路径上有符号链接时它判假，
  //    于是 main() 不跑、进程退出 0、什么都没产出 —— 而所有直接调 main() 的测试
  //    照样全绿。只有起一个真进程才能发现。
  const { dir } = putSnapshots([42]);
  const out = join(mkroot(), 'timestamp.json');
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/release/build-timestamp.mjs'),
    '--snapshots', dir, '--repo', REPO, '--out', out, '--min-cli-version', '1.2.0',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stderr}`);
  assert.ok(existsSync(out), '🔴 退出码 0 但没有产出文件 —— 那正是入口守卫判假的症状');
  const doc = parseStrict(readFileSync(out, 'utf8'));
  assert.equal(doc.schema, TIMESTAMP_SCHEMA);
  assert.equal(doc.latest_snapshot, 42);

  // 通过**符号链接**调用同样要工作（这正是当初判假的现场）
  const linkDir = mkroot();
  symlinkSync(join(REPO_ROOT, 'scripts'), join(linkDir, 'scripts'));
  const out2 = join(linkDir, 'ts.json');
  const r2 = spawnSync(process.execPath, [
    join(linkDir, 'scripts/release/build-timestamp.mjs'),
    '--snapshots', dir, '--repo', REPO, '--out', out2, '--min-cli-version', '1.2.0',
  ], { encoding: 'utf8' });
  assert.equal(r2.status, 0, `${r2.stderr}`);
  assert.ok(existsSync(out2), '🔴 经符号链接调用时也必须真的跑');
});

test('CLI：缺必填参数以非零退出并说清缺了什么', () => {
  const r = spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/release/build-timestamp.mjs'), '--snapshots', 'x',
  ], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /缺少 --out|缺少 --repo/);
});

test('🔴 文件名要严格匹配 —— Number() 会把 1e3 / 0x10 / 空串读成数字', () => {
  const { dir } = putSnapshots([42]);
  // 这几个都不该被当成快照：Number('1e3')=1000、Number('0x10')=16、Number('')=0
  for (const f of ['hub-1e3.json', 'hub-0x10.json', 'hub-.json', 'hub-+7.json', 'hub- 5.json']) {
    writeFileSync(join(dir, f), '{}');
  }
  assert.equal(newestSnapshot(dir).n, 42, '只认 hub-<十进制无前导零>.json');
});

test('🔴 前导零会算出同一个 N —— 撞了就拒绝，不按目录顺序挑一个', () => {
  const { dir } = putSnapshots([1]);
  writeFileSync(join(dir, 'hub-01.json'), '{}');
  // hub-01.json 不匹配严格文件名（前导零），所以它根本不参与 —— 不是「撞了」
  assert.equal(newestSnapshot(dir).n, 1);
});

test('🔴 快照本身要过读取端：只有一个 snapshot 字段不算快照', () => {
  const root = mkroot();
  const dir = join(root, 'snapshots');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hub-42.json'), '{"snapshot":42}\n');
  // 不过 parseSnapshot 的话，我们会签出一份指向「客户端必拒的快照」的 timestamp
  assert.throws(() => build(dir), (e) => !/文件名说它是/.test(e.message));
});

test('🔴 上一份 timestamp 走读取端的 parseTimestamp，不是宽松解析', () => {
  const { dir } = putSnapshots([42]);
  // 有 version 字段的 JSON ≠ 一份合法 timestamp
  assert.throws(() => build(dir, { previous: { version: 7 } }), /timestamp/);
  // version 到安全整数上限：不能再递增
  const ok = build(dir);
  assert.throws(
    () => build(dir, { previous: { ...ok, version: Number.MAX_SAFE_INTEGER } }),
    /安全整数上限/,
  );
});

test('🔴 产出物必须能被读取端 parseTimestamp 接受', async () => {
  const { parseTimestamp } = await import('../src/snapshot.mjs');
  const { dir } = putSnapshots([42]);
  const ts = build(dir);
  parseTimestamp(Buffer.from(stringify(ts), 'utf8'));   // 不抛就是通过

  // repo 不等于内置常量 → 读取端会拒，所以生成侧当场就该拒
  assert.throws(() => build(dir, { repo: 'someone/else' }), /repo/);
  // min_cli_version 走客户端同一个 parseSemver：前导零要拒
  assert.throws(() => build(dir, { minCliVersion: '1.02.0' }), /semver|min_cli_version/);
});

test('🔴 --now 只接受严格的 Z 形状（否则结果依赖本机时区）', async () => {
  const { main } = await import('../scripts/release/build-timestamp.mjs');
  const { dir } = putSnapshots([42]);
  const out = join(mkroot(), 'ts.json');
  for (const v of ['2026-08-25T12:00:00+08:00', '2026-08-25 12:00:00', '2026-08-25T12:00:00.123Z']) {
    assert.throws(
      () => main(['--snapshots', dir, '--repo', REPO, '--out', out, '--min-cli-version', '1.2.0', '--now', v]),
      /--now 必须是严格的/,
      `应当拒绝 ${v}`,
    );
  }
});
