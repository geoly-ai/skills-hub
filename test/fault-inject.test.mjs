// 故障注入内核自身的测试。
// 🔴 框架自己没被测过，用它跑出来的「全绿」不值钱 —— 这一份就是在测框架本身。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODES, arm, armFromEnv, disarm, fp, hitCount, observed, pendingEffects, reset,
  setTrace, state, applyPowerFailure,
} from '../src/fault-inject.mjs';
import {
  writeAtomic, mkdirChainFsync, renameDirFsync, rmtreeFsync,
} from '../src/atomic-fs.mjs';
import { CATALOG, coverageByCategory, livePoints, M0_S6_CATEGORIES } from './harness/fault-points.mjs';
import { crc32cHex } from './harness/crc32c.mjs';
import { readJournal, writeJournal, layout, sweepTmp } from './harness/fake-tx.mjs';

const tmp = (tag = 'fi') => mkdtempSync(join(tmpdir(), `${tag}-`));

function clean() { disarm(); setTrace(null); reset(); }

// ── 零开销守卫 ───────────────────────────────────────────────────────────────

test('未武装时 fp() 是 no-op —— 不计数、不 trace、不抛', () => {
  clean();
  for (let i = 0; i < 1000; i++) fp('atomic-write:pre-rename', { i });
  assert.equal(hitCount('atomic-write:pre-rename'), 0);
  assert.equal(state().ACTIVE, false);
});

// ── 具名注入，不按序号 ───────────────────────────────────────────────────────

test('按名字 + 第几次命中触发，别的点一律放行', () => {
  clean();
  arm({ name: 'fsync-dir:pre', nth: 3, mode: 'throw' });
  assert.doesNotThrow(() => fp('atomic-write:pre-rename'));
  assert.doesNotThrow(() => fp('fsync-dir:pre'));   // 1
  assert.doesNotThrow(() => fp('fsync-dir:pre'));   // 2
  assert.throws(() => fp('fsync-dir:pre'), /fsync-dir:pre #3/);  // 3
  assert.deepEqual(observed(), [{ name: 'fsync-dir:pre', nth: 3 }]);
  clean();
});

test('🔴 注入点是**名字**不是序号 —— 名字对不上就不该触发', () => {
  clean();
  arm({ name: 'atomic-write:post-rename', mode: 'throw' });
  // 就算它是本次运行的「第 1 个」写操作，名字不同也不触发
  assert.doesNotThrow(() => fp('atomic-write:pre-rename'));
  clean();
});

test('errno 模式带上 code，看起来就是一次 syscall 失败', () => {
  clean();
  arm({ name: 'x:y', mode: 'errno', errno: 'ENOSPC' });
  try { fp('x:y', { syscall: 'fsync' }); assert.fail('应抛'); } catch (e) {
    assert.equal(e.code, 'ENOSPC');
    assert.equal(e.syscall, 'fsync');
  }
  clean();
});

test('env 需要双钥匙：只设 GEOLY_FAULT 不生效', () => {
  clean();
  armFromEnv({ GEOLY_FAULT: 'fsync-dir:pre', GEOLY_FAULT_MODE: 'throw' });
  assert.equal(state().ARMED, false, '缺 GEOLY_FAULT_ENABLE 时必须不武装');
  armFromEnv({ GEOLY_FAULT_ENABLE: '1', GEOLY_FAULT: 'fsync-dir:pre', GEOLY_FAULT_MODE: 'throw' });
  assert.equal(state().ARMED, true);
  clean();
});

test('trace 写失败/ctx 不可序列化都不得改变被测语义', () => {
  clean();
  setTrace('/nonexistent-dir-xyz/trace.tsv');   // 追加必失败
  const circular = {}; circular.self = circular;
  assert.doesNotThrow(() => fp('atomic-write:pre-rename', circular));
  assert.equal(hitCount('atomic-write:pre-rename'), 1);
  clean();
});

// ── 模式说明必须诚实 ─────────────────────────────────────────────────────────

test('🔴 kill 模式的文档必须写明「不证明持久性」', () => {
  assert.match(MODES.kill.disproves_not, /不证明持久性/);
  assert.match(MODES.kill.disproves_not, /页缓存/);
  assert.match(MODES.powerfail.disproves_not, /API 边界上的仿真/);
  for (const m of Object.values(MODES)) {
    assert.ok(m.proves.length > 20 && m.disproves_not.length > 20, '每个模式都要写清两面');
  }
});

// ── 持久性影子 ───────────────────────────────────────────────────────────────

test('powerfail：未 fsync 的 .tmp 会消失，已 fsync 的 rename 结果留下', () => {
  clean();
  const d = tmp('pf');
  arm({ name: 'never', mode: 'throw' });   // 仅为了让 ACTIVE=true
  writeAtomic(join(d, 'a.json'), '{"a":1}\n');
  assert.deepEqual(pendingEffects(), [], '完整的 writeAtomic 之后不该有未持久效果');
  assert.ok(existsSync(join(d, 'a.json')));
  clean();
});

test('🔴 powerfail：mkdirChainFsync 只做到 mkdir 就断电 → 整条链消失', () => {
  clean();
  const d = tmp('pf2');
  arm({ name: 'mkdir-chain:post-mkdir', mode: 'throw' });
  const deep = join(d, 'x', 'y', 'z');
  assert.throws(() => mkdirChainFsync(deep));
  assert.ok(existsSync(deep), '进程内 throw 不会撤销任何东西');
  applyPowerFailure();
  assert.ok(!existsSync(join(d, 'x')), '掉电模型下未 fsync 的整条链应当消失（§5.2.1）');
  clean();
});

test('powerfail：目录 fsync 之后该目录项就不会再被撤销', () => {
  clean();
  const d = tmp('pf3');
  arm({ name: 'never', mode: 'throw' });
  mkdirChainFsync(join(d, 'kept'));
  applyPowerFailure();
  assert.ok(existsSync(join(d, 'kept')));
  clean();
});

test('powerfail=duplicate：rename 造出「两端都在」—— §5.4 幂等表的 corrupt 分支 ②', async () => {
  clean();
  const d = tmp('pf4');
  const { setPowerfailStyle } = await import('../src/fault-inject.mjs');
  setPowerfailStyle('duplicate');
  arm({ name: 'rename-dir:post-rename', mode: 'throw' });
  mkdirChainFsync(join(d, 'src'));
  writeAtomic(join(d, 'src', 'f'), 'x');
  assert.throws(() => renameDirFsync(join(d, 'src'), join(d, 'dst')));
  applyPowerFailure();
  assert.ok(existsSync(join(d, 'dst')) && existsSync(join(d, 'src')),
    'duplicate 风格下源与目标应当同时存在');
  setPowerfailStyle('drop');
  clean();
});

// ── 递归删除必须是多次操作 ───────────────────────────────────────────────────

test('🔴 rmtree 是逐项删的 —— 否则「删到一半崩」根本注入不进去', () => {
  clean();
  const d = tmp('rm');
  mkdirChainFsync(join(d, 't', 'sub'));
  writeFileSync(join(d, 't', 'a'), 'a');
  writeFileSync(join(d, 't', 'sub', 'b'), 'b');
  arm({ name: 'rmtree:mid', nth: 1, mode: 'throw' });
  assert.throws(() => rmtreeFsync(join(d, 't')));
  assert.ok(existsSync(join(d, 't')), '只删掉了一个子项，树还在');
  const left = readdirSync(join(d, 't'));
  assert.ok(left.length >= 1, `应还剩东西，实际 ${JSON.stringify(left)}`);
  clean();
});

// ── atomic-write 的探针位置 ──────────────────────────────────────────────────

test('post-open-tmp 上 throw 不会漏 fd（探针在 try 里）', () => {
  clean();
  const d = tmp('fd');
  arm({ name: 'atomic-write:post-open-tmp', mode: 'throw' });
  assert.throws(() => writeAtomic(join(d, 'a'), 'x'));
  clean();
  // 能再写一次就说明上一次的 fd 已释放、.tmp 名字也没占死
  writeAtomic(join(d, 'a'), 'y');
  assert.equal(readFileSync(join(d, 'a'), 'utf8'), 'y');
});

test('🔴 pre-rename vs post-rename 区分两种失败语义（§11 §5）', () => {
  clean();
  const d = tmp('sem');
  writeAtomic(join(d, 'f'), 'old\n');

  clean();
  arm({ name: 'atomic-write:pre-rename', mode: 'errno' });
  assert.throws(() => writeAtomic(join(d, 'f'), 'new\n'), /EIO|fault-inject/);
  assert.equal(readFileSync(join(d, 'f'), 'utf8'), 'old\n', 'pre-rename 失败 = 目标未变');

  clean();
  arm({ name: 'atomic-write:post-rename', mode: 'errno' });
  assert.throws(() => writeAtomic(join(d, 'f'), 'new\n'));
  assert.equal(readFileSync(join(d, 'f'), 'utf8'), 'new\n',
    '🔴 post-rename 失败 = rename 已生效 —— 规范禁止说「磁盘未变」');
  clean();
});

// ── journal 自校验不是恒真（打掉 I1 的同义反复） ─────────────────────────────

test('🔴 crc32c 真的能抓到篡改 —— 逐字节变异都要被拒', () => {
  const d = tmp('crc');
  const P = layout(d, 7);
  mkdirChainFsync(P.journalDir);
  writeJournal(P, { schema: 'geoly.skills.journal/1', generation: 7, phase: 'prepared' });
  const good = readFileSync(P.journal);
  assert.doesNotThrow(() => readJournal(P.journal));

  let caught = 0, tried = 0;
  for (let i = 0; i < good.length; i++) {
    const b = Buffer.from(good);
    b[i] = b[i] === 0x41 ? 0x42 : 0x41;   // 换一个字节
    writeFileSync(P.journal, b);
    tried++;
    try { readJournal(P.journal); } catch { caught++; }
  }
  assert.equal(caught, tried, `${tried} 处单字节变异必须全部被拒，实际只抓到 ${caught}`);
  writeFileSync(P.journal, good);
});

test('crc32c 是 8 字符固定宽度小写 hex（§11 §5）', () => {
  assert.equal(crc32cHex(Buffer.from('')), '00000000');
  assert.match(crc32cHex(Buffer.from('123456789')), /^[0-9a-f]{8}$/);
  assert.equal(crc32cHex(Buffer.from('123456789')), 'e3069283'); // 标准测试向量
});

test('journal 的 .tmp 残留一律忽略并删除（§5.4）', () => {
  const d = tmp('tmpsweep');
  const P = layout(d, 7);
  mkdirChainFsync(P.journalDir);
  writeFileSync(join(P.journalDir, '.abc.tmp'), 'garbage');
  const gone = sweepTmp(P.journalDir);
  assert.deepEqual(gone, ['.abc.tmp']);
  assert.ok(!existsSync(join(P.journalDir, '.abc.tmp')));
});

// ── CATALOG 自身的健康 ───────────────────────────────────────────────────────

test('CATALOG：每个点都有 covers / owner / why，covers 落在 M0 §6 的七类里', () => {
  for (const [name, v] of Object.entries(CATALOG)) {
    assert.match(name, /^[a-z][a-z0-9-]*(:[A-Za-z0-9][A-Za-z0-9-]*)+$/, `注入点名不合规范：${name}`);
    assert.ok(v.covers?.length, `${name} 缺 covers`);
    for (const c of v.covers) assert.ok(M0_S6_CATEGORIES.includes(c), `${name} 的 covers ${c} 不在七类里`);
    assert.ok(v.owner, `${name} 缺 owner`);
    assert.ok(v.why && v.why.length > 8, `${name} 的 why 太短 —— 说不清为什么值得崩一次就别加`);
    assert.ok(['live', 'declared'].includes(v.status), `${name} 的 status 非法`);
  }
});

test('🔴 M0 §6 点名的七类**每一类都必须有 live 注入点** —— 否则等于没覆盖', () => {
  const cov = coverageByCategory();
  const empty = M0_S6_CATEGORIES.filter((c) => cov[c].live === 0);
  assert.deepEqual(empty, [], `这些类只有声明、没有活的注入点：${empty.join(', ')}`);
});

test('live 注入点数量有下界 —— 防止有人把点删光让测试变快', () => {
  assert.ok(livePoints().length >= 45, `live 点只剩 ${livePoints().length} 个`);
});

test('🔴 每个 live 点都必须声明 scenario —— 否则它永远不会进矩阵', () => {
  // Codex 第二轮：删掉 scenario 字段就能让一个点静悄悄退出反向核对（测试照样绿）。
  const orphan = Object.entries(CATALOG)
    .filter(([, v]) => v.status === 'live' && !(v.scenario?.length))
    .map(([k]) => k);
  assert.deepEqual(orphan, [], `这些 live 点没有 scenario，反向核对覆盖不到：${orphan.join(', ')}`);
});
