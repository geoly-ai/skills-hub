// 上报端点的存储层 —— **接口 + 一个本地文件实现**。
//
// 🔴 部署在哪还没定，所以这里只保证「可替换」：端点只依赖下面这个接口，
//    不依赖 FileStore 的任何细节。换成 SQLite / Postgres / 对象存储时，
//    照着 TelemetryStore 实现一遍即可，app.mjs 一个字都不用改。
//
// 为什么不用 node:sqlite：仓库的 Node 下限是 22.13，那上面 `node:sqlite` 还是
// experimental（会打 warning，且 API 仍在动）。埋点端点没有复杂查询需求，
// 一个 append-only 的 NDJSON 足够，而且它的失败模式我们已经在客户端那边研究透了。
//
// ─────────────────────────────────────────────────────────────────────────────
// interface TelemetryStore {
//   put(events, receivedAtMs): { accepted, duplicate }   // 去重在 store 内完成
//   all(): Array<{ received_at: number, event: Event }>
//   rollup(): Rollup                                     // 保留期外的聚合计数
//   prune(cutoffMs): number                              // 返回丢弃的原始事件条数
//   close(): void
// }
// 调用方一律 `await` 返回值 —— 同步实现照样能用，异步实现（数据库）也塞得进去。
// ─────────────────────────────────────────────────────────────────────────────
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquire } from '../src/lock.mjs';
import { writeAtomic, fsyncDir, mkdirChainFsync } from '../src/atomic-fs.mjs';
import { parseStrict, stringify } from '../src/canonical-json.mjs';
import { isValidEvent, serializeEvent } from '../src/telemetry.mjs';
import { foldInto, emptyRollup } from './aggregate.mjs';

/** 存储满了。端点据此回 503，让客户端把这一批**留在本地**下次再发。 */
export class StoreFullError extends Error {
  constructor() { super('telemetry-server: 存储已达上限'); this.name = 'StoreFullError'; }
}

/**
 * 本地文件实现。
 *
 * 🔴 **单实例独占。** 打开时拿一把文件锁（复用 src/lock.mjs，内核释放，进程猝死
 *    不留死锁）。为什么必须独占：去重靠内存里的 eid 集合，而两个 worker 各持一份
 *    旧集合会各自接受同一个 eid；`prune()` 的重写更会把另一个进程刚追加的行直接盖掉。
 *    要横向扩展就换一个真数据库实现，**不要**给这个实现加 worker。
 */
export function openFileStore(dir, { maxRecords = 2_000_000 } = {}) {
  // 建目录也要持久化目录项：ACK 承诺的是「收下了」，而目录项丢了就等于没收下
  mkdirChainFsync(dir);
  let release;
  try {
    release = acquire(join(dir, 'store.lock.db'));
  } catch (e) {
    // 别的进程持有 → LockBusyError；同进程重入 → lock.mjs 直接抛普通 Error。
    // 两种都是「有人已经在用这个目录」，对调用方是同一件事，给同一句话。
    throw new Error(
      `telemetry-server: ${dir} 已被占用 —— FileStore 只允许单实例（去重索引在内存里，两个实例会各自收下同一个 eid）`,
      { cause: e },
    );
  }

  const logPath = join(dir, 'events.ndjson');
  const rollupPath = join(dir, 'rollup.json');

  /** 内存索引：eid → 已收。**只在字节 durable 之后才更新**（见 put）。 */
  const seen = new Set();
  /** 内存副本，供聚合查询。本地实现的规模上界就是这块内存，见 maxRecords。 */
  const records = [];

  // 🔴 读回来也要重新校验：磁盘上的文件是可以被改的，
  //    「我们自己写的」不是信任它的理由（客户端那边同一条教训，见 telemetry.mjs readFiles）。
  let truncatedOnLoad = false;
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      if (!line) continue;
      // 🔴 上限对**读回来的**同样有效：一个被篡改（或历史遗留）的超大日志
      //    否则可以绕过 maxRecords 把内存撑爆 —— 上界只在写路径上设等于没设。
      if (records.length >= maxRecords) { truncatedOnLoad = true; break; }
      let rec;
      try { rec = parseStrict(line); } catch { continue; }
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
      if (!Number.isFinite(rec.received_at) || !isValidEvent(rec.event)) continue;
      if (seen.has(rec.event.eid)) continue;
      seen.add(rec.event.eid);
      records.push({ received_at: rec.received_at, event: rec.event });
    }
  }
  if (truncatedOnLoad) {
    // 说出来。静默截断会让聚合数字莫名其妙地少一截，而没人知道为什么。
    console.error(`[telemetry-server] ${logPath} 超过 maxRecords=${maxRecords}，只载入了前 ${records.length} 条`);
  }

  let rollupState = emptyRollup();
  if (existsSync(rollupPath)) {
    try {
      const r = parseStrict(readFileSync(rollupPath, 'utf8'));
      if (r && typeof r === 'object' && Number.isFinite(r.cutoff)) rollupState = r;
    } catch { /* 读不出来就从空的起算：聚合是趋势信号，不是账本 */ }
  }

  const line = (rec) => `{"received_at":${rec.received_at},"event":${serializeEvent(rec.event)}}\n`;

  return {
    /**
     * 🔴 **先 durable，再 ACK。** 顺序是：拼字节 → append → fsync → 才更新内存索引、
     * 才返回 accepted。反过来（先记内存再落盘）时，端点回了 2xx 而机器随即断电，
     * 客户端已经按 §5.2 把本地队列**消费掉**了 —— 事件两边都不存在，静默丢失。
     *
     * ⚠️ 这与客户端「埋点不是账本、不 fsync」的取舍不冲突：客户端丢的是自己的一条
     * 埋点，而端点这一次 fsync 兑现的是「我 ACK 了就是我收下了」这句承诺。
     */
    put(events, receivedAtMs) {
      const fresh = [];
      // 批内也要去重，且用 Set 而不是「在 fresh 里线性找」：一批上限 10000 条，
      // 线性找就是 O(n²)，而 n 完全由攻击者决定 —— 校验通过的输入也能拿来烧 CPU。
      const inBatch = new Set();
      let duplicate = 0;
      for (const ev of events) {
        if (seen.has(ev.eid) || inBatch.has(ev.eid)) { duplicate++; continue; }
        inBatch.add(ev.eid);
        fresh.push({ received_at: receivedAtMs, event: ev });
      }
      if (records.length + fresh.length > maxRecords) throw new StoreFullError();
      if (fresh.length) {
        // 🔴 第一次写要连**目录项**一起持久化：只 fsync 文件，断电后可能文件内容在、
        //    但目录里没有这个名字 —— 那和没收到一样，而我们已经 ACK 过了。
        const isNew = !existsSync(logPath);
        const fd = openSync(logPath, 'a', 0o644);
        try {
          appendFileSync(fd, fresh.map(line).join(''));
          fsyncSync(fd);
        } finally { closeSync(fd); }
        if (isNew) fsyncDir(dir);
        for (const r of fresh) { seen.add(r.event.eid); records.push(r); }
      }
      return { accepted: fresh.length, duplicate };
    },

    all() { return records.slice(); },
    rollup() { return rollupState; },

    /**
     * 保留期到点（§5.3：180 天）后丢掉原始事件，**但先把它们折进聚合计数**。
     *
     * 🔴 顺序与幂等：rollup 里记一个 `cutoff` 水位，只折算
     * `[上一次 cutoff, 本次 cutoff)` 区间的事件。先原子写 rollup、再重写日志：
     * 崩在两者之间时，日志里那些事件还在，但它们已经在 rollup 里且水位已推过去，
     * 下一次 prune 只会把它们**丢掉**而不会再折算一次 —— 不会重复计数。
     * 倒过来（先重写日志）则会在崩溃时把它们**没折算就丢掉**。
     */
    prune(cutoffMs) {
      // 🔴 非有限值会让下面每一个比较都是 false —— 折算不进 rollup，却把全部记录
      //    判成「该丢」。一个 NaN 就能清空所有数据，所以在门口挡掉。
      if (!Number.isFinite(cutoffMs)) throw new Error(`telemetry-server: prune 的水位不是有限数值：${cutoffMs}`);
      const prev =Number.isFinite(rollupState.cutoff) ? rollupState.cutoff : 0;
      if (cutoffMs > prev) {
        const next = foldInto(rollupState, records.filter(
          (r) => r.received_at >= prev && r.received_at < cutoffMs,
        ).map((r) => r.event));
        next.cutoff = cutoffMs;
        writeAtomic(rollupPath, stringify(next));
        rollupState = next;
      }
      const keep = records.filter((r) => r.received_at >= cutoffMs);
      const dropped = records.length - keep.length;
      if (dropped) {
        // 重写日志是安全的：FileStore 单实例独占，没有别的追加者
        // （客户端那条「只 rename 不重写」的教训针对的是并发 O_APPEND 场景）。
        writeAtomic(logPath, keep.map(line).join(''));
        records.length = 0;
        seen.clear();
        for (const r of keep) { records.push(r); seen.add(r.event.eid); }
      }
      return dropped;
    },

    close() { try { release(); } catch { /* 释放失败不该盖掉调用方的返回值 */ } },
  };
}
