// 测试夹具：一个**独立进程**的 trust floor 写入者。
// 抗回滚的竞态只有在真的两个进程里才成立 —— 同进程内 lock.mjs 直接拒绝重入，
// 测不出「P1 后写把 floor 拉回去」那一类。
//
// 用法：node trustchain-writer.mjs <stateDir> <tsVersion> <snapshotN> <holdMs>
import { advanceTrustFloor, makeFloor } from '../../src/trust.mjs';

const [stateDir, v, n, holdMs = '0'] = process.argv.slice(2);
const version = Number(v);
const snapshotN = Number(n);
const hex = (seed) => String(seed).padStart(64, '0');

const candidate = makeFloor({
  timestamp_version: version,
  timestamp_sha256: `sha256:${hex(version)}`,
  latest_snapshot: snapshotN,
  snapshot_sha256: `sha256:${hex(snapshotN)}`,
  now: new Date(0),
});

// 锁被别人占着时重试 —— busy_timeout=0，冲突即失败（04-install.md §5.1）
let last = null;
for (let i = 0; i < 400; i++) {
  try {
    last = advanceTrustFloor(stateDir, candidate);
    break;
  } catch (e) {
    // 🔴 `LockBusyError` 不是唯一形态：`metadata.lock.db` 还不存在时，
    //    `acquire()` 里 `openDb` 的 `CREATE TABLE IF NOT EXISTS` / `PRAGMA journal_mode=WAL`
    //    也要写盘，会抛**裸的** `Error: database is locked`（见交付汇报的 lock.mjs findings）。
    if (e.name === 'LockBusyError' || /database is locked|SQLITE_BUSY/i.test(e.message)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.random() * 15);
      continue;
    }
    process.stdout.write(JSON.stringify({ error: e.violation ?? e.name, message: e.message }) + '\n');
    process.exit(2);
  }
}
if (Number(holdMs) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
process.stdout.write(JSON.stringify({ version, ...last }) + '\n');
