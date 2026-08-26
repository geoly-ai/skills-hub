import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  V,
  precheckTarget,
  precheckTargets,
  assertPrecheckOk,
  hasGeolyState,
  findNestedTargets,
  scanStatePaths,
  checkGeolyMountPoints,
  DEFAULT_DEPS,
  TEST_DEPS,
  missingGitignorePatterns,
  renderGitignoreBlock,
  gitignoreHint,
} from '../src/target.mjs';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'tgt-')));
const codes = (r) => r.violations.map((v) => v.code).sort();

/** 造一个「可用的空 target」：base/skills，什么都没有。 */
function fresh() {
  const base = tmp();
  const target = join(base, 'skills');
  mkdirSync(target);
  return { base, target };
}

/** 在 dir 下造出「带有效 .geoly 状态」的形状。 */
function makeState(dir, marker = 'ledger.json') {
  const s = join(dir, '.geoly');
  mkdirSync(s, { recursive: true });
  if (marker.endsWith('/')) mkdirSync(join(s, marker.slice(0, -1)), { recursive: true });
  else writeFileSync(join(s, marker), '{}');
  return s;
}

// ── 干净路径 ─────────────────────────────────────────────────────────────────

test('干净的 target 一条违规都没有', () => {
  const { base, target } = fresh();
  const r = precheckTarget(target, { base, targetSet: [target] });
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations, null, 2));
  assert.equal(r.ok, true);
  assert.equal(assertPrecheckOk(r), r);
});

test('还不存在的 target 也能预检（--create-missing 会建它）', () => {
  const base = tmp();
  const target = join(base, 'skills');
  const r = precheckTarget(target, { base });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('🔴 预检结论只是快照，API 上明说不保证世界不变', () => {
  const { base, target } = fresh();
  const r = precheckTarget(target, { base });
  assert.equal(r.snapshotOnly, true);
  assert.equal(r.depsOverridden, false, '生产路径不得用注入缝');
  assert.ok(Date.parse(r.checkedAt) > 0);
  // 🔴 不得存在任何暗示原子性的组合 API
  return import('../src/target.mjs').then((m) => {
    for (const k of Object.keys(m)) {
      assert.ok(!/precheckAnd/i.test(k), `不该导出暗示原子性的 API：${k}`);
    }
  });
});

// ── §2.2 文件系统 ────────────────────────────────────────────────────────────

test('§2.2 拒绝的 fstype 必须报出实际类型（注入缝：CI 里造不出 sshfs）', () => {
  const { base, target } = fresh();
  const deps = {
    ...DEFAULT_DEPS,
    assertSupportedFilesystem() {
      throw new Error('不支持在 fuse.sshfs 上安装（挂载点 /mnt/remote）：该文件系统不保证 rename 原子性');
    },
  };
  const r = precheckTarget(target, { base, [TEST_DEPS]: deps });
  // 🔴 注入缝用过就必须显形，调用方能断言生产路径没用它
  assert.equal(r.depsOverridden, true);
  assert.deepEqual(codes(r), [V.UNSUPPORTED_FSTYPE]);
  assert.match(r.violations[0].message, /fuse\.sshfs/);
  assert.match(r.violations[0].message, /挂载点 \/mnt\/remote/);
});

test('本地临时目录不触发 fstype 违规', () => {
  const { base, target } = fresh();
  assert.ok(!codes(precheckTarget(target, { base })).includes(V.UNSUPPORTED_FSTYPE));
});

// ── §3.4 symlink ─────────────────────────────────────────────────────────────

test('§3.4 target 路径链上有 symlink → target.symlink-in-chain', () => {
  const base = tmp();
  mkdirSync(join(base, 'real', 'skills'), { recursive: true });
  symlinkSync(join(base, 'real'), join(base, 'link'));
  const r = precheckTarget(join(base, 'link', 'skills'), { base });
  assert.ok(codes(r).includes(V.SYMLINK_IN_CHAIN), JSON.stringify(codes(r)));
  assert.match(r.violations.find((v) => v.code === V.SYMLINK_IN_CHAIN).message, /符号链接/);
});

test('🔴 base 之上的 OS 级 symlink 不算问题（macOS 的 /var）', () => {
  const { base, target } = fresh();
  assert.ok(!codes(precheckTarget(target, { base })).includes(V.SYMLINK_IN_CHAIN));
});

test('target 不在 base 之下 → target.outside-base（不静默跳过 symlink 检查）', () => {
  const { target } = fresh();
  const r = precheckTarget(target, { base: tmp() });
  assert.ok(codes(r).includes(V.OUTSIDE_BASE));
});

test('§3.4 状态路径是 symlink → geoly.symlink-state-path，逐条报出是哪一个', () => {
  const { base, target } = fresh();
  const s = makeState(target);
  const elsewhere = join(base, 'elsewhere.json');
  writeFileSync(elsewhere, '{}');
  symlinkSync(elsewhere, join(s, 'generation'));
  mkdirSync(join(s, 'quarantine'));
  symlinkSync(base, join(s, 'quarantine', '7'));

  const r = precheckTarget(target, { base });
  const hits = r.violations.filter((v) => v.code === V.STATE_SYMLINK).map((v) => v.path).sort();
  assert.deepEqual(hits, [join(s, 'generation'), join(s, 'quarantine', '7')].sort());
});

test('🔴 .geoly 本身是 symlink 也要抓（否则整套状态被重定向）', () => {
  const { base, target } = fresh();
  const other = join(base, 'other');
  mkdirSync(other);
  symlinkSync(other, join(target, '.geoly'));
  const r = precheckTarget(target, { base });
  assert.ok(codes(r).includes(V.STATE_SYMLINK));
  // 🔴 而且不能跟过去把 other 当成有效状态
  assert.equal(hasGeolyState(target), false);
});

test('scanStatePaths：.geoly 不存在时不报任何东西', () => {
  const { target } = fresh();
  assert.deepEqual(scanStatePaths(join(target, '.geoly')), {
    symlinks: [], notPlain: [], complete: true,
  });
});

// ── §3.4 挂载点 ──────────────────────────────────────────────────────────────

test('§3.4 .geoly 是挂载点 / 其下有挂载点 → 两条独立违规码', () => {
  // `/` 一定是挂载点，且其下一定还有挂载点 —— 不需要 root 就能造出这个形状
  const hits = checkGeolyMountPoints('/');
  assert.deepEqual(hits.map((h) => h.code).sort(), [V.GEOLY_IS_MOUNT, V.GEOLY_MOUNT_UNDER].sort());
  assert.match(hits.find((h) => h.code === V.GEOLY_IS_MOUNT).message, /挂载点/);
});

test('🔴 .geoly 不存在时不做挂载点判定 —— 否则 target 是挂载点会被误报成 .geoly 是', () => {
  // 回归：assertNotMountPoint 内部会往上找第一个存在的祖先
  assert.deepEqual(checkGeolyMountPoints(join('/', '.geoly-does-not-exist')), []);
  const { base, target } = fresh();
  const r = precheckTarget(target, { base });
  assert.ok(!codes(r).includes(V.GEOLY_IS_MOUNT));
});

test('挂载点检查经由 precheckTarget 接线（注入缝）', () => {
  const { base, target } = fresh();
  makeState(target);
  const deps = {
    ...DEFAULT_DEPS,
    assertNotMountPoint(p) { throw new Error(`${p} 本身是挂载点（nullfs），拒绝`); },
    assertNoMountPointsUnder(p) { throw new Error(`${p} 之下存在挂载点 ${p}/tx-1（tmpfs），拒绝`); },
  };
  const r = precheckTarget(target, { base, [TEST_DEPS]: deps });
  assert.ok(codes(r).includes(V.GEOLY_IS_MOUNT));
  assert.ok(codes(r).includes(V.GEOLY_MOUNT_UNDER));
  assert.match(r.violations.find((v) => v.code === V.GEOLY_IS_MOUNT).message, /nullfs/);
});

// ── §3.4 类型 ────────────────────────────────────────────────────────────────

test('target 是普通文件 → target.not-plain-dir', () => {
  const base = tmp();
  const target = join(base, 'skills');
  writeFileSync(target, 'x');
  const r = precheckTarget(target, { base });
  assert.ok(codes(r).includes(V.NOT_PLAIN_DIR));
});

test('.geoly 下出现真 FIFO → geoly.not-plain', () => {
  const { base, target } = fresh();
  const s = makeState(target);
  mkdirSync(join(s, 'journal'));
  writeFileSync(join(s, 'journal', '1.json'), '{}');
  // 正常形状不报
  assert.deepEqual(scanStatePaths(s).notPlain, []);
  assert.ok(!codes(precheckTarget(target, { base })).includes(V.STATE_NOT_PLAIN));

  // 造一个**真的** FIFO（Node 没有 mkfifo，借系统的）
  const fifo = join(s, 'journal', 'evil');
  execFileSync('mkfifo', [fifo]);
  assert.deepEqual(scanStatePaths(s).notPlain, [fifo]);
  const r = precheckTarget(target, { base });
  assert.ok(codes(r).includes(V.STATE_NOT_PLAIN), JSON.stringify(codes(r)));
  assert.equal(r.violations.find((v) => v.code === V.STATE_NOT_PLAIN).path, fifo);
});

test('§2.2 .geoly 自己的 fstype 也要预检（不能只查 target）', () => {
  const { base, target } = fresh();
  const stateDir = makeState(target);
  const seen = [];
  const deps = {
    ...DEFAULT_DEPS,
    assertSupportedFilesystem(p) {
      seen.push(p);
      if (p === stateDir) throw new Error('不支持在 nfs4 上安装（挂载点 /net）');
      return null;
    },
  };
  const r = precheckTarget(target, { base, [TEST_DEPS]: deps });
  assert.deepEqual(seen, [target, stateDir]);
  const hit = r.violations.find((v) => v.code === V.UNSUPPORTED_FSTYPE);
  assert.equal(hit.path, stateDir);
  assert.match(hit.message, /nfs4/);
});

test('§2.2 .geoly 与 target 不同设备 → fs.cross-device（rename 会 EXDEV）', () => {
  const { base, target } = fresh();
  const stateDir = makeState(target);
  const deps = { ...DEFAULT_DEPS, targetDev: () => 100, stateDev: () => 200 };
  const r = precheckTarget(target, { base, [TEST_DEPS]: deps });
  const hit = r.violations.find((v) => v.code === V.CROSS_DEVICE);
  assert.ok(hit, JSON.stringify(codes(r)));
  assert.equal(hit.path, stateDir);
  assert.match(hit.message, /EXDEV/);
  // 同设备就不报
  const same = { ...DEFAULT_DEPS, targetDev: () => 7, stateDev: () => 7 };
  assert.ok(!codes(precheckTarget(target, { base, [TEST_DEPS]: same })).includes(V.CROSS_DEVICE));
});

// ── §3.5 嵌套 target ─────────────────────────────────────────────────────────

test('§3.5 ① 本次命令目标集合里的嵌套 —— 双向都要抓', () => {
  const base = tmp();
  const outer = join(base, 'skills');
  const inner = join(outer, 'someskill', '.claude', 'skills');
  mkdirSync(inner, { recursive: true });

  const rs = precheckTargets([outer, inner], () => ({ base }));
  const outerHit = rs[0].violations.filter((v) => v.code === V.NESTED_TARGET);
  const innerHit = rs[1].violations.filter((v) => v.code === V.NESTED_TARGET);
  assert.equal(outerHit.length, 1);
  assert.equal(outerHit[0].detail.relation, 'descendant');
  assert.equal(outerHit[0].detail.via, 'target-set');
  assert.equal(innerHit[0].detail.relation, 'ancestor');
});

test('§3.5 ② 后代实际带有效 .geoly 状态 → 判为嵌套 target', () => {
  const { base, target } = fresh();
  const innerDir = join(target, 'someskill', '.claude', 'skills');
  mkdirSync(innerDir, { recursive: true });
  makeState(innerDir, 'lock.db');
  const r = precheckTarget(target, { base, targetSet: [target] });
  const hit = r.violations.find((v) => v.code === V.NESTED_TARGET);
  assert.ok(hit, JSON.stringify(codes(r)));
  assert.equal(hit.path, innerDir);
  assert.equal(hit.detail.via, 'geoly-state');
});

test('🔴 §3.5 收窄：按名字扫到的 .claude/skills 但没有状态 → 不算嵌套（不得误伤）', () => {
  const { base, target } = fresh();
  // 一个普通 skill 恰好带了 .claude/skills 目录，里面什么状态都没有
  mkdirSync(join(target, 'someskill', '.claude', 'skills'), { recursive: true });
  // 甚至还有一个空的 .geoly 目录 —— 空目录不是「有效状态」
  mkdirSync(join(target, 'someskill', '.claude', 'skills', '.geoly'));
  const r = precheckTarget(target, { base, targetSet: [target] });
  assert.ok(!codes(r).includes(V.NESTED_TARGET), JSON.stringify(r.violations));
});

test('§3.5 ② 祖先带有效状态 → 我们在别人的 target 里面', () => {
  const base = tmp();
  const outer = join(base, 'skills');
  mkdirSync(outer);
  makeState(outer, 'generation');
  const inner = join(outer, 'someskill', '.claude', 'skills');
  mkdirSync(inner, { recursive: true });
  const r = precheckTarget(inner, { base, targetSet: [inner] });
  const hit = r.violations.find((v) => v.code === V.NESTED_TARGET);
  assert.ok(hit);
  assert.equal(hit.path, outer);
  assert.equal(hit.detail.relation, 'ancestor');
});

test('🔴 audit-seq 单独存在也算有效状态（§4：没有 ledger 但 seq 存在是合法的）', () => {
  const d = tmp();
  makeState(d, 'audit-seq');
  assert.equal(hasGeolyState(d), true);
});

test('hasGeolyState 的判据清单', () => {
  for (const m of ['ledger.json', 'lock.db', 'generation', 'audit-seq',
    'journal/', 'attic/', 'quarantine/', 'audit-archive/', 'tx-7/']) {
    const d = tmp();
    makeState(d, m);
    assert.equal(hasGeolyState(d), true, `${m} 应算有效状态`);
  }
  const empty = tmp();
  mkdirSync(join(empty, '.geoly'));
  assert.equal(hasGeolyState(empty), false, '空 .geoly 不算');
  assert.equal(hasGeolyState(tmp()), false, '没有 .geoly 不算');
  const asFile = tmp();
  writeFileSync(join(asFile, '.geoly'), 'x');
  assert.equal(hasGeolyState(asFile), false, '.geoly 是普通文件不算');
});

test('🔴 扫不完就不能宣称没有嵌套 → target.nested-scan-incomplete', () => {
  const { base, target } = fresh();
  mkdirSync(join(target, 'a', 'b', 'c'), { recursive: true });
  const r = precheckTarget(target, { base, scan: { maxDepth: 1, maxDirs: 5000 } });
  assert.ok(codes(r).includes(V.SCAN_INCOMPLETE), JSON.stringify(codes(r)));
  assert.match(r.violations.find((v) => v.code === V.SCAN_INCOMPLETE).message, /无法证明/);
  // 目录数上限同理
  const r2 = precheckTarget(target, { base, scan: { maxDepth: 8, maxDirs: 2 } });
  assert.ok(codes(r2).includes(V.SCAN_INCOMPLETE));
  // 扫得完就不报
  const r3 = precheckTarget(target, { base });
  assert.ok(!codes(r3).includes(V.SCAN_INCOMPLETE));
});

test('嵌套扫描不跟随 symlink（否则一个环就把 CLI 转死）', () => {
  const { base, target } = fresh();
  mkdirSync(join(target, 'a'));
  symlinkSync(target, join(target, 'a', 'loop'));
  const r = findNestedTargets(target, { targetSet: [] });
  assert.equal(r.complete, true);
  assert.deepEqual(r.nested, []);
});

test('target 自己的 .geoly 不把自己判成嵌套', () => {
  const { base, target } = fresh();
  makeState(target);
  const r = precheckTarget(target, { base, targetSet: [target] });
  assert.ok(!codes(r).includes(V.NESTED_TARGET), JSON.stringify(r.violations));
});

// ── §3.6 只读 ────────────────────────────────────────────────────────────────

test('§3.6 只读 target → target.not-writable，且报明要在其中创建 .geoly/', () => {
  const { base, target } = fresh();
  chmodSync(target, 0o500);
  try {
    const r = precheckTarget(target, { base });
    const hit = r.violations.find((v) => v.code === V.NOT_WRITABLE);
    assert.ok(hit, JSON.stringify(codes(r)));
    // 🔴 §3.6 要的是**具体路径**，不是笼统的「在其中」
    assert.ok(hit.message.includes(`安装需要在 ${target} 内创建 .geoly/`), hit.message);
  } finally {
    chmodSync(target, 0o755);
  }
});

test('target 还不存在时，检查最近的已存在祖先可不可写', () => {
  const base = tmp();
  chmodSync(base, 0o500);
  try {
    const r = precheckTarget(join(base, 'skills'), { base });
    assert.ok(codes(r).includes(V.NOT_WRITABLE));
  } finally {
    chmodSync(base, 0o755);
  }
});

test('requireWritable 关掉就不查（dry-run / list 用）', () => {
  const { base, target } = fresh();
  chmodSync(target, 0o500);
  try {
    const r = precheckTarget(target, { base, requireWritable: false });
    assert.ok(!codes(r).includes(V.NOT_WRITABLE));
  } finally {
    chmodSync(target, 0o755);
  }
});

// ── 🔴 一次报出多项 ──────────────────────────────────────────────────────────

test('🔴 一次报出全部违规项，不是遇到第一个就退出', () => {
  const base = tmp();
  mkdirSync(join(base, 'real', 'skills'), { recursive: true });
  symlinkSync(join(base, 'real'), join(base, 'link'));
  const target = join(base, 'link', 'skills');
  const realTarget = join(base, 'real', 'skills');
  // 🔴 全部用**真实形状**，一个注入都不用 —— 注入过的结果 assertPrecheckOk 会拒绝，
  // 而这条测试要证的正是「真实预检能一次报出多项」。
  // ① 路径链 symlink ② 状态路径 symlink ③ 嵌套 target ④ 扫不完 ⑤ 状态目录扫不完 ⑥ 只读
  const s = makeState(realTarget);
  symlinkSync(base, join(s, 'attic'));
  const blindState = join(s, 'quarantine');
  mkdirSync(blindState);
  chmodSync(blindState, 0o000);
  const innerDir = join(realTarget, 'x');
  mkdirSync(innerDir, { recursive: true });
  makeState(innerDir, 'lock.db');
  mkdirSync(join(realTarget, 'y', 'z'), { recursive: true }); // 制造「扫不完」
  chmodSync(realTarget, 0o500); // 只读

  let r;
  try {
    r = precheckTarget(target, { base, scan: { maxDepth: 1, maxDirs: 5000 } });
  } finally {
    chmodSync(realTarget, 0o755);
    chmodSync(blindState, 0o755);
  }

  const got = new Set(codes(r));
  for (const c of [V.SYMLINK_IN_CHAIN, V.STATE_SYMLINK, V.NESTED_TARGET,
    V.SCAN_INCOMPLETE, V.STATE_SCAN_INCOMPLETE, V.NOT_WRITABLE]) {
    assert.ok(got.has(c), `应报出 ${c}，实际 ${[...got].join(', ')}`);
  }
  assert.ok(r.violations.length >= 6);
  assert.equal(r.depsOverridden, false);

  // assertPrecheckOk 要把**全部**违规拼进错误里
  let err;
  try { assertPrecheckOk(r); } catch (e) { err = e; }
  assert.ok(err, 'assertPrecheckOk 应该抛');
  assert.ok(err.message.includes(`预检不通过（${r.violations.length} 项）`), err.message);
  for (const c of got) assert.ok(err.message.includes(`[${c}]`), `错误文本缺 ${c}`);
});

test('precheckTargets 自动串起 targetSet —— 单个个预检判不出集合内嵌套', () => {
  const base = tmp();
  const outer = join(base, 'skills');
  const inner = join(outer, 's', '.claude', 'skills');
  mkdirSync(inner, { recursive: true });
  // 单独预检：判不到（inner 没有状态）
  assert.ok(!codes(precheckTarget(outer, { base })).includes(V.NESTED_TARGET));
  // 放进同一批：判得到
  assert.ok(codes(precheckTargets([outer, inner], () => ({ base }))[0]).includes(V.NESTED_TARGET));
});

test('targetPath 必须是绝对路径', () => {
  assert.throws(() => precheckTarget('skills'), /绝对路径/);
});

test('🔴 注入缝有运行期边界：注入过的结果不得用来放行安装', () => {
  const { base, target } = fresh();
  const noop = () => null;
  const blind = {
    assertSupportedFilesystem: noop, assertNotMountPoint: noop, assertNoMountPointsUnder: noop,
    assertNoSymlinkInChain: noop, assertPlainFileOrDir: () => ({ isDirectory: () => true }),
    assertWritableDir: noop, targetDev: () => 1, stateDev: () => 1,
  };
  const r = precheckTarget(target, { base, [TEST_DEPS]: blind });
  assert.equal(r.ok, true, '注入 no-op 后当然全绿 —— 正因如此才需要下面这道边界');
  assert.throws(() => assertPrecheckOk(r), /不得用来放行安装/);
});

test('🔴 篡改 depsOverridden 不能放行 —— 判据不在对象字段里', () => {
  const { base, target } = fresh();
  const noop = () => null;
  const blind = {
    assertSupportedFilesystem: noop, assertNotMountPoint: noop, assertNoMountPointsUnder: noop,
    assertNoSymlinkInChain: noop, assertPlainFileOrDir: () => ({ isDirectory: () => true }),
    assertWritableDir: noop, targetDev: () => 1, stateDev: () => 1,
  };
  const r = precheckTarget(target, { base, [TEST_DEPS]: blind });
  // 结果冻结，改不了
  assert.throws(() => { r.depsOverridden = false; }, TypeError);
  assert.throws(() => { r.ok = true; }, TypeError);
  assert.throws(() => { r.violations.push({}); }, TypeError);
  // 另造一个一模一样的对象也进不了白名单
  assert.throws(() => assertPrecheckOk({ ...r, depsOverridden: false }), /不得用来放行安装/);
  assert.throws(() => assertPrecheckOk({ ok: true, violations: [] }), /不得用来放行安装/);
});

test('🔴 违规项也冻结 —— 不能改完 code 再拿去放行', () => {
  const { base, target } = fresh();
  makeState(target);
  symlinkSync(base, join(target, '.geoly', 'attic'));
  const r = precheckTarget(target, { base });
  assert.throws(() => { r.violations[0].code = 'x'; }, TypeError);
});

test('🔴 violation 的 detail 也冻结 —— 机器可读诊断不能被改', () => {
  const { base, target } = fresh();
  const inner = join(target, 'x');
  mkdirSync(inner);
  makeState(inner, 'lock.db');
  const r = precheckTarget(target, { base });
  const hit = r.violations.find((v) => v.code === V.NESTED_TARGET);
  assert.throws(() => { hit.detail.relation = 'forged'; }, TypeError);
  assert.equal(hit.detail.relation, 'descendant');
});

test('🔴 扫描上限非法直接抛 —— NaN 会让有界遍历悄悄变无界', () => {
  const { base, target } = fresh();
  for (const bad of [NaN, Infinity, -1, '8', null]) {
    assert.throws(
      () => precheckTarget(target, { base, scan: { maxDirs: bad } }),
      /必须是有限的非负数/,
      `maxDirs=${String(bad)}`,
    );
    assert.throws(
      () => precheckTarget(target, { base, scan: { maxDepth: bad } }),
      /必须是有限的非负数/,
      `maxDepth=${String(bad)}`,
    );
  }
  // 合法值照常
  assert.equal(precheckTarget(target, { base, scan: { maxDepth: 2, maxDirs: 10 } }).ok, true);
  // 🔴 两个直接入口也各自校验，不能只靠 precheckTarget 挡在前面
  assert.throws(() => findNestedTargets(target, { scan: { maxDirs: NaN } }), /必须是有限的非负数/);
  assert.throws(() => scanStatePaths(join(target, '.geoly'), { maxDepth: NaN }), /必须是有限的非负数/);
});

test('🔴 读不到设备号 fail-closed，不给出 clean 结果', () => {
  const { base, target } = fresh();
  makeState(target);
  const deps = {
    ...DEFAULT_DEPS,
    stateDev() { const e = new Error('boom'); e.code = 'EIO'; throw e; },
  };
  const r = precheckTarget(target, { base, [TEST_DEPS]: deps });
  const hit = r.violations.find((v) => v.code === V.CROSS_DEVICE);
  assert.ok(hit, JSON.stringify(codes(r)));
  assert.match(hit.message, /读不到.*设备号（EIO）/);
});

test('🔴 base 读不了（EACCES）不能归成 base-missing', () => {
  const outer = tmp();
  const base = join(outer, 'b');
  mkdirSync(join(base, 'skills'), { recursive: true });
  chmodSync(outer, 0o000); // 让对 base 的 lstat 吃 EACCES
  try {
    const r = precheckTarget(join(base, 'skills'), { base });
    assert.ok(!codes(r).includes(V.BASE_MISSING), '「看不了」不是「不存在」');
    const hit = r.violations.find((v) => v.code === V.SYMLINK_IN_CHAIN);
    assert.ok(hit, JSON.stringify(codes(r)));
    assert.match(hit.message, /读不了（EACCES）/);
  } finally {
    chmodSync(outer, 0o755);
  }
});

test('🔴 checkGeolyMountPoints 对 EACCES fail-closed，不伪装成「不存在」', () => {
  const d = tmp();
  const s = join(d, '.geoly');
  mkdirSync(s);
  chmodSync(d, 0o000);
  try {
    const hits = checkGeolyMountPoints(s);
    assert.deepEqual(hits.map((h) => h.code), [V.STATE_SCAN_INCOMPLETE]);
    assert.match(hits[0].message, /读不了（EACCES）/);
  } finally {
    chmodSync(d, 0o755);
  }
  // 真不存在时才返回空
  assert.deepEqual(checkGeolyMountPoints(join(tmp(), '.geoly')), []);
});

test('🔴 注入缝是 Symbol key —— 普通对象展开带不上它', () => {
  const { base, target } = fresh();
  // 从 CLI/JSON 拼出来的字符串 key 不生效
  const r = precheckTarget(target, { base, deps: { assertSupportedFilesystem() { throw new Error('x'); } } });
  assert.equal(r.depsOverridden, false);
  assert.equal(r.ok, true);
});

test('🔴 optsFor 覆盖不了 precheckTargets 强制注入的 targetSet', () => {
  const base = tmp();
  const outer = join(base, 'skills');
  const inner = join(outer, 's', '.claude', 'skills');
  mkdirSync(inner, { recursive: true });
  // 试图把 targetSet 清空来关掉 §3.5 第①类判定
  const rs = precheckTargets([outer, inner], () => ({ base, targetSet: [], refreshMounts: true }));
  assert.ok(codes(rs[0]).includes(V.NESTED_TARGET), '强制项必须赢过 optsFor');
});

test('🔴 不传 base 不是静默跳过 §3.4，而是报 target.base-missing', () => {
  const { target } = fresh();
  const r = precheckTarget(target, {});
  assert.ok(codes(r).includes(V.BASE_MISSING), JSON.stringify(codes(r)));
  assert.match(r.violations.find((v) => v.code === V.BASE_MISSING).message, /未提供可信 base/);
});

test('可信 base 不存在 → target.base-missing，不是误报 symlink', () => {
  const base = join(tmp(), 'never-created');
  const r = precheckTarget(join(base, 'skills'), { base });
  assert.ok(codes(r).includes(V.BASE_MISSING), JSON.stringify(codes(r)));
  assert.ok(!codes(r).includes(V.SYMLINK_IN_CHAIN), 'ENOENT 不该被说成路径链有 symlink');
});

test('assertPrecheckOk 抛出的 Error 挂 .violations（机器可读，不必 regex 解析文本）', () => {
  const { base, target } = fresh();
  makeState(target);
  symlinkSync(base, join(target, '.geoly', 'attic'));
  let err;
  try { assertPrecheckOk(precheckTarget(target, { base })); } catch (e) { err = e; }
  assert.ok(Array.isArray(err.violations));
  assert.equal(err.targetPath, target);
  assert.ok(err.violations.some((v) => v.code === V.STATE_SYMLINK));
});

test('🔴 .geoly 是普通文件 → geoly.not-plain（不是只查 symlink 就完事）', () => {
  const { base, target } = fresh();
  writeFileSync(join(target, '.geoly'), 'x');
  const r = precheckTarget(target, { base });
  assert.ok(codes(r).includes(V.STATE_NOT_PLAIN), JSON.stringify(codes(r)));
});

test('🔴 读不进去的子树 fail-closed：报 nested-scan-incomplete，不静默宣称没有嵌套', () => {
  const { base, target } = fresh();
  const blind = join(target, 'blind');
  mkdirSync(blind);
  chmodSync(blind, 0o000);
  try {
    const r = precheckTarget(target, { base });
    assert.ok(codes(r).includes(V.SCAN_INCOMPLETE), JSON.stringify(codes(r)));
  } finally {
    chmodSync(blind, 0o755);
  }
});

test('🔴 .geoly 里读不进去的子目录 → geoly.state-scan-incomplete', () => {
  const { base, target } = fresh();
  const s = makeState(target);
  const blind = join(s, 'quarantine');
  mkdirSync(blind);
  chmodSync(blind, 0o000);
  try {
    const r = precheckTarget(target, { base });
    assert.ok(codes(r).includes(V.STATE_SCAN_INCOMPLETE), JSON.stringify(codes(r)));
    assert.match(
      r.violations.find((v) => v.code === V.STATE_SCAN_INCOMPLETE).message,
      /无法证明/,
    );
  } finally {
    chmodSync(blind, 0o755);
  }
});

test('🔴 .geoly 读不进去时 fail-closed，当作「有状态」而不是「普通目录」', () => {
  const d = tmp();
  const s = join(d, '.geoly');
  mkdirSync(s);
  chmodSync(s, 0o000);
  try {
    assert.equal(hasGeolyState(d), true, '读不了不等于没有状态');
  } finally {
    chmodSync(s, 0o755);
  }
});

// ── §3.3 gitignore ──────────────────────────────────────────────────────────

test('🔴 项目级 gitignore 忽略 adapter 派生的实际路径', () => {
  const repo = tmp();
  assert.deepEqual(missingGitignorePatterns(repo, ['claude', 'cursor']), [
    '/.claude/skills/.geoly/',
    '/.cursor/skills/.geoly/',
  ]);
  writeFileSync(join(repo, '.gitignore'), '# c\nnode_modules\n/.claude/skills/.geoly/\n');
  assert.deepEqual(missingGitignorePatterns(repo, ['claude', 'cursor']), ['/.cursor/skills/.geoly/']);
});

test('🔴 根上的 /.geoly/ 顶不了事 —— 它不覆盖 adapter 派生的实际路径', () => {
  const repo = tmp();
  writeFileSync(join(repo, '.gitignore'), '/.geoly/\n');
  assert.deepEqual(missingGitignorePatterns(repo, ['claude']), ['/.claude/skills/.geoly/']);
});

test('🔴 后面的否定规则会把前面的忽略取消掉 —— 不能算成已覆盖', () => {
  const repo = tmp();
  writeFileSync(repo + '/.gitignore', '/.claude/skills/.geoly/\n!/.claude/skills/.geoly/\n');
  assert.deepEqual(missingGitignorePatterns(repo, ['claude']), ['/.claude/skills/.geoly/']);
  // 反过来（先否定后忽略）最后一条赢
  writeFileSync(repo + '/.gitignore', '!/.claude/skills/.geoly/\n/.claude/skills/.geoly/\n');
  assert.deepEqual(missingGitignorePatterns(repo, ['claude']), []);
});

test('CRLF 的 .gitignore 也要认', () => {
  const repo = tmp();
  writeFileSync(repo + '/.gitignore', '/.claude/skills/.geoly/\r\nnode_modules\r\n');
  assert.deepEqual(missingGitignorePatterns(repo, ['claude']), []);
});

test('尾斜杠可有可无，注释与空行不算数', () => {
  const repo = tmp();
  writeFileSync(join(repo, '.gitignore'), '\n#/.claude/skills/.geoly/\n  /.claude/skills/.geoly  \n');
  assert.deepEqual(missingGitignorePatterns(repo, ['claude']), []);
});

test('gitignoreHint 带上 git clean -xfd 的后果', () => {
  const repo = tmp();
  const h = gitignoreHint(repo, ['claude']);
  assert.equal(h.ok, false);
  assert.match(h.warning, /git clean -xfd/);
  assert.match(h.warning, /审计历史/);
  assert.ok(renderGitignoreBlock(['claude']).includes('/.claude/skills/.geoly/'));
  assert.ok(!renderGitignoreBlock(['claude']).split('\n').includes('/.geoly/'));
});
