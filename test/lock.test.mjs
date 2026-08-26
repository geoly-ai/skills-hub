// Gate 2：Node/SQLite 锁行为实测（04-install.md §5.1）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquire, readHolder, LockBusyError } from '../src/lock.mjs';

const T = () => mkdtempSync(join('/private' + tmpdir().replace(/^\/private/, ''), 'lock-'));
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
