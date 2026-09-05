// 并发争抢同一把全新的锁。
//
// 🔴 **先报到，再等发令。** 早先是「起来就自旋等 barrier」，父进程 sleep 800ms
//    后放行 —— 机器一忙，800ms 内没起齐，**争抢根本没发生**，
//    于是「争抢者应拿到 LockBusyError」那条断言假红。
//    2026-09-04 它在 CI 上卡住了一次 registry 发布（1426 里就红这一个），
//    而它与那次改动毫无关系。
//    ⚠️ 假红的代价不是「重跑一次」——它当时让线上处在「指针指向空气」的状态。
//
//    现在：每个子进程先写一个 ready 文件，父进程**等齐**再放行。
//    争抢因此与机器快慢无关。
import { readFileSync, writeFileSync } from 'node:fs';
import { acquire } from '../../src/lock.mjs';

const [dbPath, barrier, readyPath] = process.argv.slice(2);
if (readyPath) writeFileSync(readyPath, 'ready');
for (;;) { try { readFileSync(barrier); break; } catch { /* spin */ } }
try {
  acquire(dbPath);
  process.stdout.write('HELD\n');
} catch (e) {
  process.stdout.write(`${e.constructor.name}|${String(e.message).split('\n')[0]}\n`);
}
