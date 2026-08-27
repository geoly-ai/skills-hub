// 真事务内核的故障注入矩阵。
//
// 🔴 为什么不复用 test/fault-matrix.test.mjs：那一份由 test/harness/scenarios.mjs 驱动，
//    而 scenarios 导入的是 **假事务**（fake-tx / fake-intents）。把 CATALOG 的 owner
//    翻成真模块只是把「谁负责这个点」写对，**并不会**让那套矩阵去跑真内核。
//    因此真内核必须有自己的一套等价强度的崩溃矩阵 —— 就是本文件。
//
// 与那一份的关系：
//   · 注入点名字完全相同（CATALOG 是唯一权威清单）；
//   · 不变式独立实现（不导入 harness/invariants.mjs）—— 期望值从**不可变的 fixture**
//     算出来，不从被测模块生成的产物里读，否则就是自证。
//
// 分层同 src/fault-inject.mjs 的 MODES：
//   T1 进程内 throw（全部命中点）· T2 子进程 SIGKILL · T3 powerfail · T4 errno · T5 双故障

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { arm, disarm, observed, reset, setTrace } from '../src/fault-inject.mjs';
import { CATALOG } from './harness/fault-points.mjs';
import {
  KSCENARIOS, kFreshTarget, kCleanup, snapshotTree, KFX_ROOT,
} from './kernel-scenarios.test.mjs';

const FULL = process.env.FX_FULL === '1';
const DEPTH = FULL ? Infinity : Number(process.env.FX_DEPTH ?? 1);
const NAMES = Object.keys(KSCENARIOS);

// ── 子进程 runner（写到临时目录 —— 文件边界只允许我新建 test/*.test.mjs）────────
const CHILD_DIR = mkdtempSync(join(tmpdir(), 'kfx-child-'));
const CHILD = join(CHILD_DIR, 'child.mjs');
const REPO = dirname(new URL('.', import.meta.url).pathname);
writeFileSync(CHILD, `
import { arm, armFromEnv, disarm, setTrace } from ${JSON.stringify(join(REPO, 'src/fault-inject.mjs'))};
const { KSCENARIOS } = await import(${JSON.stringify(join(REPO, 'test/kernel-scenarios.test.mjs'))});
const target = process.env.FX_TARGET;
const S = KSCENARIOS[process.env.FX_SCENARIO];
const phase = process.env.FX_PHASE ?? 'run';
if (!target || !S) { console.error('child: 缺 FX_TARGET / FX_SCENARIO'); process.exit(93); }
disarm(); setTrace(null);
try { if (phase !== 'recover') S.setup(target); }
catch (e) { console.error('child setup: ' + (e?.stack ?? e)); process.exit(94); }
armFromEnv();
if (process.env.FX_ARM_NAME) {
  arm({ name: process.env.FX_ARM_NAME, nth: Number(process.env.FX_ARM_NTH ?? 1),
        mode: process.env.FX_ARM_MODE ?? 'throw' });
}
try {
  if (phase === 'run' || phase === 'both') S.run(target);
  if (phase === 'recover' || phase === 'both') S.recover(target);
} catch (e) {
  if (e?.name === 'FaultInjected') process.exit(90);
  if (e?.corrupt) { console.error('CORRUPT ' + e.message); process.exit(91); }
  if (e?.needsRecover) { console.error('NEEDS-RECOVER ' + e.message); process.exit(5); }
  console.error('child: ' + (e?.stack ?? e));
  process.exit(92);
}
process.exit(0);
`);

function spawnChild(env, timeoutMs = 90_000) {
  const r = spawnSync(process.execPath, [CHILD], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, signal: r.signal, stderr: r.stderr ?? '' };
}

function spawnChildAsync(env, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CHILD], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d; });
    c.stdout.resume();
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('close', (status, signal) => { clearTimeout(t); resolve({ status, signal, stderr }); });
  });
}

function traceScenario(name) {
  const target = kFreshTarget(`trace-${name}`);
  const tracePath = join(tmpdir(), `kfx-trace-${process.pid}-${Math.random().toString(36).slice(2)}.tsv`);
  const r = spawnChild({
    FX_TARGET: target, FX_SCENARIO: name, FX_PHASE: 'run',
    GEOLY_FAULT_ENABLE: '1', GEOLY_FAULT_TRACE: tracePath, GEOLY_FAULT: '', FX_ARM_NAME: '',
  });
  if (r.status !== 0) throw new Error(`trace 趟本身失败（${name}）：status=${r.status}\n${r.stderr}`);
  const lines = existsSync(tracePath) ? readFileSync(tracePath, 'utf8').split('\n').filter(Boolean) : [];
  try { unlinkSync(tracePath); } catch { /* 无所谓 */ }
  kCleanup(target);
  return lines.map((l) => { const [n, nth] = l.split('\t'); return { name: n, nth: Number(nth) }; });
}

function byName(hits, n) {
  const c = new Map();
  return hits.filter((h) => { const k = (c.get(h.name) ?? 0) + 1; c.set(h.name, k); return k <= n; });
}
function sample(list, k) {
  if (list.length <= k) return [...list];
  const step = list.length / k;
  return Array.from({ length: k }, (_, i) => list[Math.floor(i * step)]);
}
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]); }
  }));
  return out;
}

const TRACES = Object.fromEntries(NAMES.map((s) => [s, traceScenario(s)]));

// ════════════════════════════════════════════════════════════════════════════
// 一、枚举可信度
// ════════════════════════════════════════════════════════════════════════════

test('🔴 真内核打出来的注入点必须全在 CATALOG 里（防拼错、防偷偷加点）', () => {
  const unknown = new Set();
  for (const hits of Object.values(TRACES)) for (const h of hits) if (!CATALOG[h.name]) unknown.add(h.name);
  assert.deepEqual([...unknown], [], `真内核打了 CATALOG 里没有的点：${[...unknown].join(', ')}`);
});

/**
 * 🔴 **反向覆盖**：CATALOG 里 tx / cleanup / rollback / repair / audit-archive 五组的
 *    **每一个**点，都必须真的被真内核打到。
 *    只统计「打到了几个」是不够的 —— 删掉或改名一个 CATALOG 点，只要总数还够就会全绿
 *    （Codex 第二轮 #20）。
 */
const KERNEL_GROUPS = ['tx:', 'cleanup:', 'rollback:', 'repair:', 'audit-archive:'];

test('🔴 CATALOG 里属于事务内核的每一个点，都必须被真场景打到（反向覆盖）', () => {
  const hit = new Set();
  for (const hits of Object.values(TRACES)) for (const h of hits) hit.add(h.name);
  const want = Object.keys(CATALOG).filter((n) => KERNEL_GROUPS.some((g) => n.startsWith(g)));
  const missing = want.filter((n) => !hit.has(n));
  assert.deepEqual(missing, [],
    `真内核一次都没打到这些 CATALOG 点（改名了？没接线？）：\n  ${missing.join('\n  ')}`);
  console.log(`真内核反向覆盖：${want.length} 个内核注入点全部命中`);
  for (const s of NAMES) {
    assert.ok(TRACES[s].length >= 20, `${s} 只打到 ${TRACES[s].length} 次，太少了`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 二、T1 进程内 throw
// ════════════════════════════════════════════════════════════════════════════

function runInProcess(sname, point, mode) {
  const S = KSCENARIOS[sname];
  const target = kFreshTarget(`ip-${sname}`);
  disarm(); setTrace(null); reset();
  S.setup(target);
  arm({ name: point.name, nth: point.nth, mode });
  let crashed = false;
  try { S.run(target); } catch (e) {
    if (e?.name === 'FaultInjected' || e?.corrupt || e?.needsRecover) crashed = true;
    else { disarm(); reset(); kCleanup(target); throw e; }
  }
  // 🔴 「抛了异常」不等于「注入点命中了」—— 自然抛出的 corrupt 也会让 crashed=true，
  //    那样这一格其实**什么都没测**（Codex 第二轮 #21）。判据是注入器自己记的命中。
  const detonated = observed().some((h) => h.name === point.name && h.nth === point.nth);
  disarm(); reset();

  let corrupt = false, msg = null;
  try { S.recover(target); } catch (e) {
    if (e?.corrupt || e?.needsRecover) { corrupt = true; msg = e.message; } else { kCleanup(target); throw e; }
  }
  const snap1 = snapshotTree(target);
  let corrupt2 = false;
  try { S.recover(target); } catch (e) {
    if (e?.corrupt || e?.needsRecover) corrupt2 = true; else { kCleanup(target); throw e; }
  }
  const snap2 = snapshotTree(target);
  return { target, crashed, detonated, corrupt, corrupt2, msg, snap1, snap2 };
}

function assertOne(sname, point, r) {
  const S = KSCENARIOS[sname];
  const where = `${sname} @ ${point.name}#${point.nth}`;
  assert.equal(r.snap1, r.snap2, `I7 违反（${where}）：第二次恢复又动了状态，不收敛`);
  assert.equal(r.corrupt, r.corrupt2, `I9 违反（${where}）：两次恢复的判定不一致`);
  S.check(r.target, { recovered: !r.corrupt, where, message: r.msg });
}

for (const sname of NAMES) {
  test(`T1 进程内 throw：${sname} 的每一个注入点各崩一次`, { timeout: 1_800_000 }, () => {
    const hits = byName(TRACES[sname], DEPTH);
    let failClosed = 0;
    for (const point of hits) {
      const r = runInProcess(sname, point, 'throw');
      try {
        assert.ok(r.detonated, `${sname} @ ${point.name}#${point.nth}：注入点没真的命中（这一格等于没测）`);
        assertOne(sname, point, r);
      } finally { kCleanup(r.target); }
      if (r.corrupt) failClosed++;
    }
    console.log(`  ${sname}: ${hits.length} 个注入点全部通过（其中 ${failClosed} 个 fail-closed）`);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 三、T2 子进程 SIGKILL —— 证明「进程内任何收尾代码都没跑」
// ════════════════════════════════════════════════════════════════════════════

for (const sname of NAMES) {
  test(`T2 子进程 SIGKILL：${sname}`, { timeout: 1_800_000 }, async () => {
    const points = byName(TRACES[sname], FULL ? Infinity : 1);
    const results = await pool(points, 8, async (p) => {
      const target = kFreshTarget(`c-${sname}`);
      const base = { FX_TARGET: target, FX_SCENARIO: sname, GEOLY_FAULT_ENABLE: '1' };
      const crash = await spawnChildAsync({
        ...base, FX_PHASE: 'run', FX_ARM_NAME: p.name, FX_ARM_NTH: String(p.nth), FX_ARM_MODE: 'kill',
      });
      const rec1 = await spawnChildAsync({ ...base, FX_PHASE: 'recover', FX_ARM_NAME: '' });
      const snapAfter1 = snapshotTree(target);
      const rec2 = await spawnChildAsync({ ...base, FX_PHASE: 'recover', FX_ARM_NAME: '' });
      const snap2 = snapshotTree(target);
      return { crash, rec1, rec2, snapAfter1, snap2, target };
    });
    try {
      for (let i = 0; i < points.length; i++) {
        const { crash, rec1, rec2, snapAfter1, snap2, target } = results[i];
        const where = `${sname} @ ${points[i].name}#${points[i].nth}`;
        try {
          assert.ok(crash.signal === 'SIGKILL' || crash.status === 97,
            `${where}：子进程没被真的杀掉（status=${crash.status} signal=${crash.signal}）`);
          // 🔴 恢复只允许两种结局：成功（0）或 fail-closed（91 corrupt / 5 needs-recover）
          assert.ok([0, 91, 5].includes(rec1.status),
            `${where}：恢复既没成功也没 fail-closed（status=${rec1.status}）\n${rec1.stderr}`);
          assert.equal(rec2.status, rec1.status, `${where}：I9 违反 —— 两次恢复判定不一致\n${rec2.stderr}`);
          // 🔴 退出码相同还不够：两次恢复之后的**状态**也必须逐字节相同（I7）
          assert.equal(snap2, snapAfter1, `${where}：I7 违反 —— 第二次恢复又动了状态`);
          KSCENARIOS[sname].check(target, { recovered: rec1.status === 0, where, message: rec1.stderr });
        } finally { kCleanup(target); }
        results[i].target = null;
      }
    } finally { for (const r of results) if (r?.target) kCleanup(r.target); }
    console.log(`  ${sname}: ${points.length} 个点在真 SIGKILL 下通过`);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 四、T3 powerfail
// ════════════════════════════════════════════════════════════════════════════

const DUR = ['atomic-write:', 'rename-dir:', 'mkdir-chain:', 'fsync-dir:', 'rmtree:'];

for (const sname of NAMES) {
test(`T3 powerfail（drop）：与持久性相关的注入点 · ${sname}`, { timeout: 1_800_000 }, async () => {
  const seen = new Set();
  const points = TRACES[sname].filter((h) => {
    if (!DUR.some((p) => h.name.startsWith(p))) return false;
    if (seen.has(h.name)) return false;
    seen.add(h.name); return true;
  });
  const results = await pool(points, 8, async (p) => {
    const target = kFreshTarget(`pf-${sname}`);
    const base = {
      FX_TARGET: target, FX_SCENARIO: sname, GEOLY_FAULT_ENABLE: '1',
      GEOLY_FAULT_POWERFAIL_STYLE: 'drop',
    };
    await spawnChildAsync({ ...base, FX_PHASE: 'run', FX_ARM_NAME: p.name, FX_ARM_NTH: String(p.nth), FX_ARM_MODE: 'powerfail' });
    const rec = await spawnChildAsync({ ...base, FX_PHASE: 'recover', FX_ARM_NAME: '' });
    const s1 = snapshotTree(target);
    const rec2 = await spawnChildAsync({ ...base, FX_PHASE: 'recover', FX_ARM_NAME: '' });
    const s2 = snapshotTree(target);
    return { rec, rec2, s1, s2, target };
  });
  for (let i = 0; i < points.length; i++) {
    const { rec, rec2, s1, s2, target } = results[i];
    const where = `${sname} @ ${points[i].name}#${points[i].nth}`;
    try {
      assert.ok([0, 91, 5].includes(rec.status),
        `${where}：掉电后恢复既没成功也没 fail-closed（status=${rec.status}）\n${rec.stderr}`);
      assert.equal(rec2.status, rec.status, `${where}：掉电后两次恢复判定不一致`);
      assert.equal(s2, s1, `${where}：掉电后恢复不收敛`);
      KSCENARIOS[sname].check(target, { recovered: rec.status === 0, where, message: rec.stderr });
    } finally { kCleanup(target); }
  }
  console.log(`  powerfail(drop) ${sname}: ${points.length} 个点通过`);
});
}

test('T3 powerfail（duplicate）：造出「两端都在」时必须 fail-closed，不得静默覆盖',
  { timeout: 900_000 }, async () => {
    const sname = 'kernel-tx';
    const points = sample(TRACES[sname].filter((h) => h.name === 'rename-dir:post-rename'), 6);
    assert.ok(points.length > 0, 'kernel-tx 里应当有 rename-dir:post-rename 命中');
    const results = await pool(points, 6, async (p) => {
      const target = kFreshTarget(`dup-${sname}`);
      const base = {
        FX_TARGET: target, FX_SCENARIO: sname, GEOLY_FAULT_ENABLE: '1',
        GEOLY_FAULT_POWERFAIL_STYLE: 'duplicate',
      };
      await spawnChildAsync({ ...base, FX_PHASE: 'run', FX_ARM_NAME: p.name, FX_ARM_NTH: String(p.nth), FX_ARM_MODE: 'powerfail' });
      const rec = await spawnChildAsync({ ...base, FX_PHASE: 'recover', FX_ARM_NAME: '' });
      return { rec, target };
    });
    let failClosed = 0;
    for (let i = 0; i < points.length; i++) {
      const { rec, target } = results[i];
      try {
        assert.ok([0, 91, 5].includes(rec.status),
          `重影场景下恢复必须要么成功要么 fail-closed，得到 ${rec.status}\n${rec.stderr}`);
        if (rec.status !== 0) failClosed++;
        KSCENARIOS[sname].check(target, { recovered: rec.status === 0, where: 'dup', message: rec.stderr });
      } finally { kCleanup(target); }
    }
    // §5.4 幂等表分支 ②：至少要有一次真的被判 corrupt，否则那条分支形同虚设
    assert.ok(failClosed > 0,
      '🔴 制造了「Y 正确而 X 也在」的重影，真内核却一次都没 fail-closed —— §5.4 分支 ② 没被执行');
    console.log(`  powerfail(duplicate): ${points.length} 个点，其中 ${failClosed} 个 fail-closed`);
  });

// ════════════════════════════════════════════════════════════════════════════
// 五、T4 errno
// ════════════════════════════════════════════════════════════════════════════

for (const sname of NAMES) {
test(`T4 errno：任何 I/O 失败都必须 fail-closed · ${sname}`, { timeout: 900_000 }, () => {
  const points = sample(byName(TRACES[sname].filter(
    (h) => h.name.startsWith('fsync-dir:') || h.name.startsWith('atomic-write:')), 2), 12);
  for (const point of points) {
    const r = runInProcess(sname, point, 'errno');
    try {
      assert.ok(r.detonated, `${point.name}#${point.nth}：errno 注入点没真的命中`);
      assertOne(sname, point, r);
    } finally { kCleanup(r.target); }
  }
  console.log(`  errno ${sname}: ${points.length} 个点通过`);
});
}

// ════════════════════════════════════════════════════════════════════════════
// 六、T5 双故障
// ════════════════════════════════════════════════════════════════════════════

for (const sname of NAMES) {
test(`T5 双故障：崩一次 → 恢复到一半又崩 → 再恢复，仍要收敛 · ${sname}`, { timeout: 900_000 }, () => {
  const S = KSCENARIOS[sname];
  const firsts = sample(TRACES[sname], 8);
  let combos = 0;
  for (const first of firsts) {
    const target = kFreshTarget('dbl');
    disarm(); setTrace(null); reset();
    S.setup(target);
    arm({ name: first.name, nth: first.nth, mode: 'throw' });
    try { S.run(target); } catch (e) { if (e?.name !== 'FaultInjected' && !e?.corrupt && !e?.needsRecover) throw e; }
    disarm(); reset();
    for (const second of ['atomic-write:post-rename', 'fsync-dir:pre', 'rename-dir:post-rename']) {
      arm({ name: second, nth: 1, mode: 'throw' });
      try { S.recover(target); } catch (e) { if (e?.name !== 'FaultInjected' && !e?.corrupt && !e?.needsRecover) throw e; }
      disarm(); reset();
      combos++;
    }
    let corrupt = false;
    try { S.recover(target); } catch (e) { if (e?.corrupt || e?.needsRecover) corrupt = true; else throw e; }
    const s1 = snapshotTree(target);
    try { S.recover(target); } catch (e) { if (!e?.corrupt && !e?.needsRecover) throw e; }
    const s2 = snapshotTree(target);
    try {
      assert.equal(s1, s2, `双故障后不收敛（first=${first.name}#${first.nth}）`);
      S.check(target, { recovered: !corrupt, where: `dbl@${first.name}`, message: null });
    } finally { kCleanup(target); }
  }
  console.log(`  双故障 ${sname}: ${firsts.length} × 3 = ${combos} 组通过`);
});
}

// ════════════════════════════════════════════════════════════════════════════
// 七、证伪：把保护拿掉，矩阵必须变红
// ════════════════════════════════════════════════════════════════════════════

test('🔴 证伪：手工删掉唯一那份旧副本，I3 必须抓到', () => {
  const S = KSCENARIOS['kernel-tx'];
  const target = kFreshTarget('anti-i3');
  disarm(); reset();
  S.setup(target);
  arm({ name: 'tx:item:post-retire-rename', nth: 1, mode: 'throw' });
  try { S.run(target); } catch (e) { if (e?.name !== 'FaultInjected') throw e; }
  disarm(); reset();
  // 此刻 alpha 的旧树只在 retired/ 里，attic 还没有 —— 删掉它就是「三处副本全毁」
  rmSync(join(target, '.geoly', 'tx-1', 'retired'), { recursive: true, force: true });
  assert.throws(
    () => S.check(target, { recovered: false, where: 'anti', message: null }),
    /I3/,
    '🔴 唯一那份旧树被删了，不变式却没抓到 —— 那它是恒真的，等于没测',
  );
  kCleanup(target);
});

test('🔴 证伪：把 manifest 删掉但把 cleanup 标成 done，I6 必须抓到', async () => {
  const S = KSCENARIOS['kernel-tx'];
  const target = kFreshTarget('anti-i6');
  disarm(); reset();
  S.setup(target);
  arm({ name: 'cleanup:B:pre-manifest', nth: 1, mode: 'throw' });
  try { S.run(target); } catch (e) { if (e?.name !== 'FaultInjected') throw e; }
  disarm(); reset();
  // 正是 v11 那个错误写法的效果：manifest 未 durable 就把 retired 删了、还标成 done
  const { readJournal, writeJournal } = await import('../src/journal.mjs');
  const jp = join(target, '.geoly', 'journal', '1.json');
  const J = readJournal(jp);
  for (const it of Object.values(J.items)) it.cleanup = 'done';
  writeJournal(jp, J);
  rmSync(join(target, '.geoly', 'tx-1', 'retired'), { recursive: true, force: true });
  // 🔴 此刻两份 tar 都已 durable（崩点就在 B 之前），所以 I3 是满足的 ——
  //    能抓到这一格的**只有 I6**。用 /I3|I6/ 会让 I3 顺手兜住，证不出 I6（Codex 第二轮 #24）。
  assert.throws(
    () => S.check(target, { recovered: false, where: 'anti', message: null }),
    /I6/,
    '🔴 破坏了 B→C 顺序，I6 却没抓到',
  );
  kCleanup(target);
});

test('🔴 证伪：把 attic 里那份 tar 的内容掉包，I3 不能被字段骗过', async () => {
  const { writeCanonicalTar } = await import('../src/install.mjs');
  const { writeAtomic } = await import('../src/atomic-fs.mjs');
  const S = KSCENARIOS['kernel-tx'];
  const target = kFreshTarget('anti-forge');
  disarm(); reset();
  S.setup(target);
  S.run(target);                     // 跑完整事务：attic 里有真 tar，retired 已删
  const tar = join(target, '.geoly', 'attic', '1', 'alpha.tar');
  assert.ok(existsSync(tar));
  writeAtomic(tar, writeCanonicalTar([{ path: 'SKILL.md', mode: 0o644, data: Buffer.from('# 被掉包了\n') }]));
  assert.throws(
    () => S.check(target, { recovered: true, where: 'forge', message: null }),
    /I3/,
    '🔴 attic 那份「唯一旧副本」内容已被掉包，I3 却没抓到 —— 它只是在看文件在不在',
  );
  kCleanup(target);
});

test('🔴 框架产物不留垃圾：跑一轮之后临时目录数量不增长', () => {
  const before = readdirSync(KFX_ROOT).filter((n) => n.startsWith('kfx-t-')).length;
  for (let i = 0; i < 10; i++) { const t = kFreshTarget('leak'); KSCENARIOS['kernel-tx'].setup(t); kCleanup(t); }
  const after = readdirSync(KFX_ROOT).filter((n) => n.startsWith('kfx-t-')).length;
  assert.ok(after <= before, `临时目录从 ${before} 涨到 ${after}`);
});

test('清理子进程 runner 的临时目录', () => {
  rmSync(CHILD_DIR, { recursive: true, force: true });
  assert.ok(!existsSync(CHILD_DIR));
});

