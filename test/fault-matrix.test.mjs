// 故障注入矩阵 —— M0 §6 P0 第 3 项的正主。
//
// 「**对这个事务的每一个注入点，各跑一遍崩溃恢复**」，而不是手写几十个 case。
// 注入点是从 trace 里**发现**的，不是写死的；漏点靠 CATALOG 交叉核对暴露。
//
// 分层，因为不同层证明的东西不同、代价也差两个数量级：
//   T1  进程内 throw   全部注入点，全部场景。证明「时序」：恢复能从任意一格接上。
//   T2  子进程 SIGKILL 每个点名的首次命中。证明「进程内任何收尾代码都没跑」。
//   T3  子进程 powerfail 与持久性相关的点。证明 §5.2.1 的目录链 fsync 是必要的。
//   T4  进程内 errno    抽样。证明 §5.4 的 I/O fail-closed。
//   T5  双故障          抽样。证明「恢复过程中再崩一次」仍然收敛。
// 🔴 每一层各能证明什么、**不能**证明什么，见 src/fault-inject.mjs 的 MODES。
//
// FX_FULL=1 时 T2/T3 覆盖全部命中（而不是每个点名一次），CI 的夜间跑可以开。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arm, disarm, reset, setTrace } from '../src/fault-inject.mjs';
import { CATALOG, coverageByCategory, declaredPoints, pointsFor } from './harness/fault-points.mjs';
import { SCENARIOS, SCENARIO_NAMES } from './harness/scenarios.mjs';
import { checkAll } from './harness/invariants.mjs';
import { adjudicate } from './harness/oracle.mjs';
import {
  cleanupTarget, crashAndRecoverAsync, freshTarget, pool, sample, traceScenario,
  sandboxRoot,
} from './harness/crash-runner.mjs';
import { snapshot } from './harness/fake-tx.mjs';

// 深度：每个**点名**取前 FX_DEPTH 次命中。默认 1 —— 45 个点名 × 4 个场景 ≈ 120 组，
// 每组要跑一次 setup + 一次事务 + 两次恢复，fsync 密集，约 0.7 s/组。
// FX_FULL=1 时取**全部命中**（fake-tx 一个场景就有 387 次），夜间跑用。
const FULL = process.env.FX_FULL === '1';
const DEPTH = FULL ? Infinity : Number(process.env.FX_DEPTH ?? 1);

/** 每个点名取前 n 次命中 */
function byName(hits, n) {
  const c = new Map();
  return hits.filter((h) => {
    const k = (c.get(h.name) ?? 0) + 1;
    c.set(h.name, k);
    return k <= n;
  });
}

// 第 0 趟：一次性把四个场景的 trace 都取回来（子进程，无故障）
const TRACES = Object.fromEntries(SCENARIO_NAMES.map((s) => [s, traceScenario(s)]));

// ════════════════════════════════════════════════════════════════════════════
// 一、枚举本身的可信度：三向交叉核对
// ════════════════════════════════════════════════════════════════════════════

test('🔴 trace 里出现的每个注入点都必须在 CATALOG 里（防拼错、防偷偷加点）', () => {
  const unknown = new Set();
  for (const hits of Object.values(TRACES)) {
    for (const h of hits) if (!CATALOG[h.name]) unknown.add(h.name);
  }
  assert.deepEqual([...unknown], [], `这些点被打到了却没进 CATALOG：${[...unknown].join(', ')}`);
});

test('🔴 CATALOG 里标了 scenario 的点，必须真的被那个场景打到（防改名/失联）', () => {
  const missing = [];
  for (const s of SCENARIO_NAMES) {
    const hit = new Set(TRACES[s].map((h) => h.name));
    for (const name of pointsFor(s)) if (!hit.has(name)) missing.push(`${s} → ${name}`);
  }
  assert.deepEqual(missing, [],
    `CATALOG 说这些点属于该场景，实际一次都没打到（改名了？被优化掉了？）：\n  ${missing.join('\n  ')}`);
});

test('declared（尚未接线）的点必须是空的 —— 有 pending 就要在这里显式列出来', () => {
  const pending = declaredPoints();
  // 🔴 不能让「declared」变成一张永远不失败的免死金牌（Codex 第一轮第 4 条）。
  //    事务内核落地前允许有 pending，但必须**显式列在这里**，加新的会立刻失败。
  const ALLOWED_PENDING = [];
  assert.deepEqual(pending, ALLOWED_PENDING,
    `新增了未接线的注入点：${pending.filter((p) => !ALLOWED_PENDING.includes(p)).join(', ')}`);
});

test('M0 §6 点名的七类，逐类报告覆盖数', () => {
  const cov = coverageByCategory();
  const rows = Object.entries(cov).map(([k, v]) => `  ${k.padEnd(14)} live=${v.live} declared=${v.declared}`);
  console.log('M0 §6 覆盖：\n' + rows.join('\n'));
  for (const [k, v] of Object.entries(cov)) assert.ok(v.live > 0, `${k} 一个活的注入点都没有`);
});

test('每个场景都打到了足够多的点（trace 不该突然缩水）', () => {
  const summary = SCENARIO_NAMES.map((s) => {
    const uniq = new Set(TRACES[s].map((h) => h.name)).size;
    return `  ${s.padEnd(18)} 命中 ${String(TRACES[s].length).padStart(4)} 次 / ${uniq} 个不同的点`;
  });
  console.log('trace 概览：\n' + summary.join('\n'));
  for (const s of SCENARIO_NAMES) {
    assert.ok(TRACES[s].length >= 20, `${s} 只打到 ${TRACES[s].length} 次，太少了`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 二、T1：进程内 throw —— 全部注入点，全部场景
// ════════════════════════════════════════════════════════════════════════════

function runInProcess(scenarioName, point, mode) {
  const S = SCENARIOS[scenarioName];
  const target = freshTarget(`ip-${scenarioName}`);
  disarm(); setTrace(null); reset();
  S.setup(target);

  arm({ name: point.name, nth: point.nth, mode });
  let crashed = false;
  try { S.run(target); } catch (e) {
    if (e?.name === 'FaultInjected') crashed = true;
    else if (e?.corrupt) crashed = true;             // 注入引发的 corrupt 也算崩
    else { disarm(); reset(); throw e; }
  }
  disarm(); reset();

  // 第一次恢复
  let corrupt = false, corruptMessage = null, outcome = null;
  try { outcome = S.recover(target); } catch (e) {
    if (e?.corrupt) { corrupt = true; corruptMessage = e.message; } else throw e;
  }
  const snap1 = snapshot(target);

  // 🔴 I7 收敛：再跑一次恢复，状态必须逐字节不变
  let corrupt2 = false;
  try { S.recover(target); } catch (e) { if (e?.corrupt) corrupt2 = true; else throw e; }
  const snap2 = snapshot(target);

  return { target, crashed, corrupt, corrupt2, corruptMessage, outcome, snap1, snap2 };
}

function assertOne(scenarioName, point, r) {
  const S = SCENARIOS[scenarioName];
  const exp = S.expect();
  const where = `${scenarioName} @ ${point.name}#${point.nth}`;

  assert.equal(r.snap1, r.snap2, `I7 违反（${where}）：第二次恢复又动了状态，不收敛`);
  assert.equal(r.corrupt, r.corrupt2, `I9 违反（${where}）：两次恢复的判定不一致`);

  if (S.check) { S.check(r.target, exp); return; }

  if (!r.corrupt) {
    checkAll(r.target, exp, { afterSuccessfulRecovery: true });
  } else {
    // fail-closed 也要满足「旧树没丢」这条 —— 停机不是丢数据的借口
    checkAll(r.target, exp, { afterSuccessfulRecovery: false });
  }
  adjudicate({ target: r.target, expect: exp, corrupt: r.corrupt, corruptMessage: r.corruptMessage,
    rolledBack: exp.rolledBack });
}

for (const scenarioName of SCENARIO_NAMES) {
  test(`T1 进程内 throw：${scenarioName} 的每一个注入点各崩一次`, { timeout: 900_000 }, () => {
    const hits = byName(TRACES[scenarioName], DEPTH);
    let corruptCount = 0;
    for (const point of hits) {
      const r = runInProcess(scenarioName, point, 'throw');
      assert.ok(r.crashed, `${scenarioName} @ ${point.name}#${point.nth}：注入点没触发`);
      try { assertOne(scenarioName, point, r); } finally { cleanupTarget(r.target); }
      if (r.corrupt) corruptCount++;
    }
    console.log(`  ${scenarioName}: ${hits.length} 个注入点全部通过（其中 ${corruptCount} 个判 fail-closed）`);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 三、T2：子进程 SIGKILL —— 证明「进程内任何收尾代码都没跑」
// ════════════════════════════════════════════════════════════════════════════

/** 子进程 tier 比进程内贵得多；默认每个点名取首次命中，FX_FULL=1 时取全部 */
function subprocessPoints(scenarioName) {
  return byName(TRACES[scenarioName], FULL ? Infinity : 1);
}

for (const scenarioName of SCENARIO_NAMES) {
  test(`T2 子进程 SIGKILL：${scenarioName}`, { timeout: 600_000 }, async () => {
    const points = subprocessPoints(scenarioName);
    const S = SCENARIOS[scenarioName];
    const exp = S.expect();
    const results = await pool(points, 8, (p) => crashAndRecoverAsync(scenarioName, p, 'kill'));
    try {
    for (let i = 0; i < points.length; i++) {
      const { crash, recoverRun, recoverTwice, target } = results[i];
      const where = `${scenarioName} @ ${points[i].name}#${points[i].nth}`;
      try {
        assert.ok(crash.signal === 'SIGKILL' || crash.status === 97,
          `${where}：子进程没有被真的杀掉（status=${crash.status} signal=${crash.signal}）`);
        // 🔴 恢复只允许两种结局：成功（0）或 fail-closed 报 corrupt（91）
        assert.ok([0, 91].includes(recoverRun.status),
          `${where}：恢复既没成功也没 fail-closed（status=${recoverRun.status}）\n${recoverRun.stderr}`);
        assert.equal(recoverTwice.status, recoverRun.status,
          `${where}：I9 违反 —— 两次恢复的判定不一致`);
        if (S.check) S.check(target, exp);
        else {
          checkAll(target, exp, { afterSuccessfulRecovery: recoverRun.status === 0 });
          adjudicate({ target, expect: exp, corrupt: recoverRun.status === 91,
            corruptMessage: recoverRun.stderr, rolledBack: exp.rolledBack });
        }
      } finally { cleanupTarget(target); }
      results[i].target = null;                 // 已清，兜底时跳过
    }
    } finally {
      // 🔴 断言失败会中断上面的循环，剩下那些 target 就再也没人清。
      //    实测漏过 90 个 fx-c-fake-repair-* —— 统一兜底。
      for (const r of results) if (r?.target) cleanupTarget(r.target);
    }
    console.log(`  ${scenarioName}: ${points.length} 个点在真 SIGKILL 下通过`);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 四、T3：powerfail —— 唯一能打到 §5.2.1「两棵都丢」的模式
// ════════════════════════════════════════════════════════════════════════════

const DURABILITY_PREFIXES = ['atomic-write:', 'rename-dir:', 'mkdir-chain:', 'fsync-dir:', 'rmtree:'];

test('T3 powerfail（drop）：与持久性相关的注入点', { timeout: 600_000 }, async () => {
  const scenarioName = 'fake-tx';
  const S = SCENARIOS[scenarioName];
  const exp = S.expect();
  const seen = new Set();
  const points = TRACES[scenarioName].filter((h) => {
    if (!DURABILITY_PREFIXES.some((p) => h.name.startsWith(p))) return false;
    if (seen.has(h.name)) return false;
    seen.add(h.name); return true;
  });
  const results = await pool(points, 8, (p) => crashAndRecoverAsync(scenarioName, p, 'powerfail'));
  for (let i = 0; i < points.length; i++) {
    const { recoverRun, target } = results[i];
    const where = `${scenarioName} @ ${points[i].name}#${points[i].nth}`;
    try {
      assert.ok([0, 91].includes(recoverRun.status),
        `${where}：掉电后恢复既没成功也没 fail-closed（status=${recoverRun.status}）\n${recoverRun.stderr}`);
      // 🔴 掉电之后仍然要求「旧树至少有一份完整副本」
      checkAll(target, exp, { afterSuccessfulRecovery: false });
    } finally { cleanupTarget(target); }
  }
  console.log(`  powerfail(drop): ${points.length} 个持久性相关注入点通过`);
});

test('T3 powerfail（duplicate）：造出「两端都在」时必须 fail-closed，不得静默覆盖',
  { timeout: 600_000 }, async () => {
    const scenarioName = 'fake-tx';
    const S = SCENARIOS[scenarioName];
    const exp = S.expect();
    const points = sample(
      TRACES[scenarioName].filter((h) => h.name === 'rename-dir:post-rename'), 6,
    );
    assert.ok(points.length > 0, 'fake-tx 里应当有 rename-dir:post-rename 命中');
    const results = await pool(points, 6,
      (p) => crashAndRecoverAsync(scenarioName, p, 'powerfail', { powerfailStyle: 'duplicate' }));
    let failClosed = 0;
    for (let i = 0; i < points.length; i++) {
      const { recoverRun, target } = results[i];
      try {
        assert.ok([0, 91].includes(recoverRun.status),
          `重影场景下恢复必须要么成功要么 fail-closed，得到 ${recoverRun.status}\n${recoverRun.stderr}`);
        if (recoverRun.status === 91) failClosed++;
        checkAll(target, exp, { afterSuccessfulRecovery: false });
      } finally { cleanupTarget(target); }
    }
    // §5.4 幂等表分支 ②：至少要有一次真的被判成 corrupt，否则说明那条分支形同虚设
    assert.ok(failClosed > 0,
      '🔴 制造了「Y 正确而 X 也在」的重影，恢复却一次都没判 corrupt —— §5.4 分支 ② 没被执行');
    console.log(`  powerfail(duplicate): ${points.length} 个点，其中 ${failClosed} 个正确判成 corrupt`);
  });

// ════════════════════════════════════════════════════════════════════════════
// 五、T4：errno —— §5.4 的 I/O fail-closed
// ════════════════════════════════════════════════════════════════════════════

test('T4 errno：任何 I/O 失败都必须 fail-closed，不推进 journal、不当成功', () => {
  const scenarioName = 'fake-tx';
  const points = sample(byName(TRACES[scenarioName].filter(
    (h) => h.name.startsWith('fsync-dir:') || h.name.startsWith('atomic-write:')), 2), 12);
  for (const point of points) {
    const r = runInProcess(scenarioName, point, 'errno');
    try {
      assert.ok(r.crashed, `${point.name}#${point.nth}：errno 没打出来`);
      assertOne(scenarioName, point, r);
    } finally { cleanupTarget(r.target); }
  }
  console.log(`  errno: ${points.length} 个点通过`);
});

// ════════════════════════════════════════════════════════════════════════════
// 六、T5：双故障 —— 恢复过程中再崩一次
// ════════════════════════════════════════════════════════════════════════════

test('T5 双故障：崩一次 → 恢复到一半又崩 → 再恢复，仍要收敛', { timeout: 600_000 }, () => {
  const scenarioName = 'fake-tx';
  const S = SCENARIOS[scenarioName];
  const exp = S.expect();
  const firsts = sample(TRACES[scenarioName], 8);
  let combos = 0;

  for (const first of firsts) {
    // 第一次崩
    const target = freshTarget('dbl');
    disarm(); setTrace(null); reset();
    S.setup(target);
    arm({ name: first.name, nth: first.nth, mode: 'throw' });
    try { S.run(target); } catch (e) { if (e?.name !== 'FaultInjected' && !e?.corrupt) throw e; }
    disarm(); reset();

    // 恢复过程中再崩：挑恢复路径上的几个点
    for (const second of ['atomic-write:post-rename', 'fsync-dir:pre', 'rename-dir:post-rename']) {
      arm({ name: second, nth: 1, mode: 'throw' });
      try { S.recover(target); } catch (e) { if (e?.name !== 'FaultInjected' && !e?.corrupt) throw e; }
      disarm(); reset();
      combos++;
    }

    // 最后一次干净恢复
    let corrupt = false;
    try { S.recover(target); } catch (e) { if (e?.corrupt) corrupt = true; else throw e; }
    const s1 = snapshot(target);
    try { S.recover(target); } catch (e) { if (!e?.corrupt) throw e; }
    const s2 = snapshot(target);

    try {
      assert.equal(s1, s2, `双故障后不收敛（first=${first.name}#${first.nth}）`);
      checkAll(target, exp, { afterSuccessfulRecovery: !corrupt });
      adjudicate({ target, expect: exp, corrupt, rolledBack: exp.rolledBack });
    } finally { cleanupTarget(target); }
  }
  console.log(`  双故障: ${firsts.length} 个首崩点 × 3 个恢复中崩点 = ${combos} 组通过`);
});

// ════════════════════════════════════════════════════════════════════════════
// 七、框架的证伪能力：故意破坏协议，矩阵必须变红
// ════════════════════════════════════════════════════════════════════════════

test('🔴 反证：把清理的 B/C 顺序调换（先删 retired 再写 manifest），I6 必须抓到', async () => {
  const { checkAll: check } = await import('./harness/invariants.mjs');
  const target = freshTarget('anti');
  disarm(); reset();
  SCENARIOS['fake-tx'].setup(target);
  // 停在「manifest 还没 durable」，然后手工把 retired 删掉 —— 正是 v11 那个错误写法的效果
  arm({ name: 'cleanup:B:pre-manifest', nth: 1, mode: 'throw' });
  try { SCENARIOS['fake-tx'].run(target); } catch (e) { if (e?.name !== 'FaultInjected') throw e; }
  disarm(); reset();

  const { layout, readJournal, writeJournal } = await import('./harness/fake-tx.mjs');
  const P = layout(target, 7);
  const J = readJournal(P.journal);
  for (const v of Object.values(J.items)) v.cleanup = 'done';
  writeJournal(P, J);
  rmSync(P.retired, { recursive: true, force: true });

  assert.throws(
    () => check(target, SCENARIOS['fake-tx'].expect(), { afterSuccessfulRecovery: false }),
    /I3|I6/,
    '🔴 破坏了 B→C 顺序，不变式却没抓到 —— 那这套不变式是恒真的，等于没测',
  );
  cleanupTarget(target);
});

test('🔴 反证：旧树三处副本全毁时 I3 必须抓到', async () => {
  const target = freshTarget('anti2');
  disarm(); reset();
  SCENARIOS['fake-tx'].setup(target);
  arm({ name: 'tx:item:post-retire-rename', nth: 1, mode: 'throw' });
  try { SCENARIOS['fake-tx'].run(target); } catch (e) { if (e?.name !== 'FaultInjected') throw e; }
  disarm(); reset();
  const { layout } = await import('./harness/fake-tx.mjs');
  const P = layout(target, 7);
  rmSync(P.retired, { recursive: true, force: true });   // 把唯一那份旧树删掉
  assert.throws(
    () => checkAll(target, SCENARIOS['fake-tx'].expect(), { afterSuccessfulRecovery: false }),
    /I3/,
  );
  cleanupTarget(target);
});

test('🔴 框架产物不留垃圾：跑一轮之后临时目录数量不增长', () => {
  // Codex 第二轮指出上一版这条是恒真的 assert.ok(true)。改成真的数一遍：
  // 矩阵跑了上千个 target，若 cleanupTarget 失效，/tmp 下会堆成千上万个 fx-* 目录。
  // 🔴 只数**本进程自己的**沙箱根。早先在 tmpdir() 里数，那是共享命名空间，
  // 并行 worktree 会让这条测试在两个方向上都产出假红（多算别人的、或被别人删掉）。
  const before = readdirSync(sandboxRoot()).filter((n) => n.startsWith('fx-')).length;
  for (let i = 0; i < 20; i++) {
    const t = freshTarget('leak');
    SCENARIOS['fake-tx'].setup(t);
    cleanupTarget(t);
  }
  const after = readdirSync(sandboxRoot()).filter((n) => n.startsWith('fx-')).length;
  assert.ok(after <= before, `建了 20 个临时 target 又清掉，fx-* 目录数却从 ${before} 涨到 ${after}`);
});


test('🔴 反证：伪造 archive 的 tree_digest 字段，I3 不能被骗（Codex 第二轮 P0-3）', async () => {
  const { layout, verifyArchive } = await import('./harness/fake-tx.mjs');
  const { writeAtomic } = await import('../src/atomic-fs.mjs');
  const { stringify } = await import('../src/canonical-json.mjs');
  const target = freshTarget('forge');
  disarm(); reset();
  SCENARIOS['fake-tx'].setup(target);
  SCENARIOS['fake-tx'].run(target);                 // 跑完整事务，attic 里有真 tar
  const exp = SCENARIOS['fake-tx'].expect();
  const P = layout(target, exp.gen);
  const tar = join(P.attic, 'alpha.tar');

  // 内容换成别的树，但把 tree_digest 字段写成 old_digest —— 只看字段就会放行
  writeAtomic(tar, stringify({
    schema: 'geoly.fake.archive/1',
    files: { 'SKILL.md': '# 被掉包了\n' },
    tree_digest: exp.items[0].oldDigest,
  }));
  assert.throws(() => verifyArchive(tar, exp.items[0].oldDigest), /内容实算/,
    'verifyArchive 必须重算摘要，不能只信字段');
  assert.throws(
    () => checkAll(target, exp, { afterSuccessfulRecovery: false }),
    /I3/,
    '🔴 attic 里那份「唯一旧副本」内容已被掉包，I3 却没抓到 —— 它就只是在读字段',
  );
  cleanupTarget(target);
});

test('🔴 第二代事务能跑起来 —— completed 的 journal 是残留不是损坏（Codex 第二轮 P0-2）', async () => {
  const { makePlan, runForward, recover } = await import('./harness/fake-tx.mjs');
  const { OLD_A, NEW_A, NEW_B } = await import('./harness/scenarios.mjs');
  const target = freshTarget('gen2');
  disarm(); reset();
  SCENARIOS['fake-tx'].setup(target);
  SCENARIOS['fake-tx'].run(target);                       // 第 7 代，completed
  // 第 8 代：以前 recover 看到两份 journal 就直接判 corrupt
  runForward(target, makePlan(target, 8, [{ name: 'beta', op: 'swap', newFiles: OLD_A }]));
  const r = recover(target);
  assert.ok(['nothing', 'residue-cleared'].includes(r.outcome),
    `第二代事务之后恢复应当无事可做，实际 ${JSON.stringify(r)}`);
  cleanupTarget(target);
});
