// 并发首次生成 install-id。等 barrier 出现再一起冲，尽量落在同一个瞬间。
import { readFileSync } from 'node:fs';
import { installId } from '../../src/telemetry.mjs';

const barrier = process.argv[2];
for (;;) { try { readFileSync(barrier); break; } catch { /* spin */ } }
process.stdout.write(installId() + '\n');
