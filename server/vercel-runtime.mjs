// Vercel 上的装配层 —— **故意放在 `api/` 外面**。
//
// ⚠️ 「下划线前缀的文件会被忽略」是一条**可能变的平台约定**，不值得赌：
//    赌错了这个文件会变成一个公开可访问的函数。放在 api/ 外面是结构性的。
import postgres from 'postgres';
import { createHandler } from './app.mjs';
import { openPostgresStore, StoreUnavailableError } from './store-postgres.mjs';

// ══════════════════════════════════════════════════════════════════════════
// 🔴 **serverless 下失效的闸 —— 诚实清单（规格 §5.3.1）**
//
// | 闸 | 状态 |
// |---|---|
// | 令牌桶 `ratePerSec` | 🔴 **失效**，下面显式关掉。实例内存计数，N 个实例
// |                     |    就是 N 倍，冷启动还重置成满。留着只会让人以为有闸 |
// | `inFlight` 并发上限  | 🔴 **基本失效**，全局并发由平台调度 |
// | 各种 timeout        | 🔴 **完全失效**，不再创建 http.Server |
// | 请求体字节闸         | ⚠️ 对到达应用的流仍有效，但超平台上限的请求平台先拒 |
// | 进程内保留期清理      | 🔴 **完全失效**，setInterval 不跑 → 改用 Vercel Cron |
// | 数据库连接           | ⚠️ **新增耗尽面**，会先于任何应用层闸打爆数据库 |
// | 平台请求日志里的 IP  | 🔴 **关不掉**，T-20，明确接受的残余风险，**不是「已缓解」** |
// ══════════════════════════════════════════════════════════════════════════

let cached = null;

/**
 * 🔴 **每个实例只造一次。** 早先的写法是每次请求重建 handler，于是 `inFlight`
 *    计数次次归零 —— 那让它连「按实例生效」都做不到。
 *    ⚠️ 这只是让它按实例生效，**不代表它又管用了**（见上表）。
 */
export function runtime() {
  if (cached) return cached;

  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('缺少 DATABASE_URL / POSTGRES_URL');
  // 🔴 运行时走**池化**连接；`POSTGRES_URL_NO_SSL` 一律不用（明文出网）。
  const sql = postgres(url, { max: 1, ssl: 'require', idle_timeout: 20 });

  const handler = createHandler({
    store: openPostgresStore(sql),
    // 🔴 显式关掉，而不是留个看起来在工作的数字。见上表第一行。
    ratePerSec: Infinity,
    summaryToken: process.env.GEOLY_TELEMETRY_SUMMARY_TOKEN ?? null,
  });
  cached = { sql, handler };
  return cached;
}

/** 数据库不可用时**不能**掉进「当成空库」——那会绕过全部准入控制。 */
export async function guarded(req, res, fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof StoreUnavailableError) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'store_unavailable' }));
      return;
    }
    // ⚠️ 内部错误只回一个 ref，细节留在平台日志里 —— 不要把栈回给调用方。
    const ref = Math.random().toString(36).slice(2, 10);
    console.error(`[${ref}] ${e?.name ?? 'Error'}`);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'internal', ref }));
  }
}
