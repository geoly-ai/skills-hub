// Gate 2：Node/SQLite 锁行为实测（04-install.md §5.1）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquire, readHolder, LockBusyError } from '../src/lock.mjs';

// 🔴 用 realpathSync 而不是手拼 `/private` 前缀。
// 原先写的是 `'/private' + tmpdir().replace(/^\/private/, '')` —— 那是把 macOS 的
// 布局（`/tmp` 是指向 `/private/tmp` 的符号链接）硬编码进了测试。
// Linux 上 `tmpdir()` 是 `/tmp`，拼出来就是**不存在的** `/private/tmp` → ENOENT，
// 6 条锁测试全红。本机永远测不出来，是 CI 的 Linux runner 抓到的。
// ⚠️ 平台差异要用可移植 API 消化，不要用「在我的机器上等价」的字符串变换。
const T = () => mkdtempSync(join(realpathSync(tmpdir()), 'lock-'));
const HOLDER = new URL('./fixtures/holder.mjs', import.meta.url).pathname;

test('取锁后同进程重入被拒', () => {
  const d = T(), p = join(d, 'l.db');
  const rel = acquire(p);
  try { assert.throws(() => acquire(p), /禁止重入/); } finally { rel(); }
});

test('活持有者阻塞第二个进程，且报出上一次持有者', async () => {
  const d = T(), p = join(d, 'l.db');
  const child = spawn(process.execPath, [HOLDER, p], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));       // 等它宣布已持锁
  try {
    assert.throws(() => acquire(p), LockBusyError);
  } finally { child.kill('SIGKILL'); }
});

test('SIGKILL 持锁者后，锁由内核释放', async () => {
  const d = T(), p = join(d, 'l.db');
  const child = spawn(process.execPath, [HOLDER, p], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
  await sleep(50);
  const rel = acquire(p);                                     // 不需要任何人工干预
  rel();
});

test('持锁期间可读到上一次已提交的 holder（必然陈旧）', async () => {
  const d = T(), p = join(d, 'l.db');
  const r1 = acquire(p); r1();                                 // 提交一次，holder 落盘
  const first = readHolder(p);
  assert.equal(first.pid, process.pid);
  const child = spawn(process.execPath, [HOLDER, p], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  try {
    const during = readHolder(p);                              // WAL 下读者不被阻塞
    assert.equal(during.pid, process.pid, '读到的是上一次完成者，不是当前持有者');
  } finally { child.kill('SIGKILL'); }
});

test('协议里没有任何 unlink：释放后 db 文件仍在', () => {
  const d = T(), p = join(d, 'l.db');
  acquire(p)();
  assert.ok(existsSync(p), 'lock.db 不应被删除');
});

test('busy_timeout=0：冲突立即失败，不挂起', async () => {
  const d = T(), p = join(d, 'l.db');
  const child = spawn(process.execPath, [HOLDER, p], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  const t0 = Date.now();
  try { acquire(p); assert.fail('本应抛错'); } catch (e) { assert.ok(e instanceof LockBusyError); }
  const dt = Date.now() - t0;
  child.kill('SIGKILL');
  assert.ok(dt < 1000, `应立即失败，实际耗时 ${dt}ms`);
});

test('🔴 全新 db 上的并发争抢也要给 LockBusyError，不能漏裸 Error', async (t) => {
  // PRAGMA journal_mode=WAL 与 CREATE TABLE 都是写操作，在 busy_timeout=0 下
  // 遇到并发写者会在 BEGIN EXCLUSIVE **之前**抛 database is locked。
  // 早先只在 BEGIN 处兜，实测 16 进程 × 5 轮里 80 次有 69 次拿到裸 Error，
  // 退出码 5 与持有者信息全部失效。
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { spawn } = await import('node:child_process');

  const here = dirname(fileURLToPath(import.meta.url));
  const d = mkdtempSync(join(tmpdir(), 'lockrace-'));
  const dbPath = join(d, 'fresh.db');
  const barrier = join(d, 'go');

  const kid = () =>
    new Promise((res) => {
      const c = spawn(process.execPath, [join(here, 'fixtures/lock-racer.mjs'), dbPath, barrier], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let o = '';
      c.stdout.on('data', (x) => (o += x));
      c.once('exit', () => res(o.trim()));
    });

  const all = Promise.all(Array.from({ length: 12 }, kid));
  await new Promise((r) => setTimeout(r, 800));
  writeFileSync(barrier, 'go');
  const results = await all;

  const bare = results.filter((r) => r.startsWith('Error|'));
  assert.deepEqual(bare, [], `不该出现裸 Error：${bare.slice(0, 3)}`);
  assert.ok(results.some((r) => r === 'HELD'), '应有进程拿到锁');
  assert.ok(results.some((r) => r.startsWith('LockBusyError|')), '争抢者应拿到 LockBusyError');
});
