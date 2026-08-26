// 并发争抢同一把全新的锁。等 barrier 文件出现再一起冲，尽量同一刻发起。
import { readFileSync } from 'node:fs';
import { acquire } from '../../src/lock.mjs';

const [dbPath, barrier] = process.argv.slice(2);
for (;;) { try { readFileSync(barrier); break; } catch { /* spin */ } }
try {
  acquire(dbPath);
  process.stdout.write('HELD\n');
} catch (e) {
  process.stdout.write(`${e.constructor.name}|${String(e.message).split('\n')[0]}\n`);
}
