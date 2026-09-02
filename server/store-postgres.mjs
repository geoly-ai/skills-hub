// Postgres 版的 store —— 与 `openFileStore` 实现同一个接口（put / all / rollup）。
//
// ══════════════════════════════════════════════════════════════════════════
// 🔴 **与文件版的实质差别：去重从「进程内存」变成「数据库唯一索引」。**
//
// `openFileStore` 的去重是一个进程内的 Set + 一把文件锁 —— Set 是进程私有的，
// 所以「单实例独占」是它唯一能正确的前提，它自己也在错误信息里这么说。
// serverless 上那个前提**根本不成立**：平台会同时起好几个实例。
//
// 这里换成 `eid` 上的唯一索引 + `INSERT … ON CONFLICT (eid) DO NOTHING
// RETURNING eid`：索引跨连接、跨实例、跨进程都成立，并发插同一个 eid
// 只有一个能拿到 RETURNING 那一行。
//
// 🔴 **它与「先 durable 再 ACK」是同一次操作**：那些行在同一个事务里插入，
//    COMMIT 返回之后既已落库、去重也同刻定死，然后才回 accepted。
//
// ⚠️ 措辞要收住：COMMIT 返回表示**数据库已按 PostgreSQL 与托管服务各自的
//    持久性契约接受了该事务**，不承诺跨区域灾难恢复级别的绝对不丢失。
//    我们能钉死的只有这一侧 —— 每个写事务 `set local synchronous_commit = on`。
// ══════════════════════════════════════════════════════════════════════════
import { foldInto, emptyRollup } from './aggregate.mjs';

/** 一次 `all()` 最多取多少行 —— 见下面的长注释。 */
export const MAX_SCAN_ROWS = 200_000;

export class StoreUnavailableError extends Error {
  constructor(cause) {
    super('telemetry-store: 数据库不可用', { cause });
    this.name = 'StoreUnavailableError';
  }
}

/**
 * @param {object} sql  `postgres` 客户端（模板标签函数）
 */
export function openPostgresStore(sql) {
  return {
    /**
     * 🔴 **先 durable，再 ACK。** COMMIT 返回之后才算收下。
     *    反过来（先回 2xx 再落库）时客户端已经按 §5.2 把本地队列消费掉了 ——
     *    事件两边都不存在，静默丢失。
     */
    async put(events, receivedAtMs) {
      if (events.length === 0) return { accepted: 0, duplicate: 0 };
      let inserted;
      try {
        inserted = await sql.begin(async (tx) => {
          // 每个写事务显式钉死 —— 连接级默认值可能被别处改掉。
          await tx`set local synchronous_commit = on`;
          // ⚠️ **不要用 `unnest` 把 JS 数组直接铺开**：那条路上参数类型推断会出错，
          //    非空 put() 通常直接 500（Codex 2026-09-01 在上一版里发现，
          //    而 fakeSql 直接消费 JS 数组、测不出来）。
          //    改成传**一个 JSON 字符串**，由 `jsonb_array_elements` 展开。
          // 🔴 **必须是 `::text::jsonb`，不能只写 `::jsonb`。** 实测（真库，
          //    2026-09-02）：`${json}::jsonb` 会被当成 **JSON 字符串标量**，
          //    报 `cannot extract elements from a scalar`；先过 `::text` 才对。
          //    ⚠️ 这一条**假 sql 测不出来** —— 它只看得见「参数是不是字符串」，
          //    看不见 cast 写没写对。所以下面那条测试改成断言 SQL 文本里
          //    真的有 `::text::jsonb`。
          const payload = JSON.stringify(events.map((e) => ({ eid: e.eid, ev: e })));
          return tx`
            insert into telemetry_events (eid, received_at, ev)
            select x->>'eid', to_timestamp(${receivedAtMs}::bigint / 1000.0), x->'ev'
            from jsonb_array_elements(${payload}::text::jsonb) as x
            on conflict (eid) do nothing
            returning eid
          `;
        });
      } catch (e) {
        throw new StoreUnavailableError(e);
      }
      return { accepted: inserted.length, duplicate: events.length - inserted.length };
    },

    /**
     * 🔴 **有硬上界。** 文件版的 `all()` 是把内存里的数组切一份；这里是全表扫描，
     *    没有上界的话它会先于任何应用层闸打爆函数内存。
     * ⚠️ 截断时**说出来**：静默截断会让聚合面给出一个看起来正常、实际少算的数字，
     *    而那种错误没有任何迹象。
     */
    async all() {
      let rows;
      try {
        rows = await sql`
          select ev from telemetry_events
          order by received_at asc
          limit ${MAX_SCAN_ROWS + 1}
        `;
      } catch (e) {
        throw new StoreUnavailableError(e);
      }
      if (rows.length > MAX_SCAN_ROWS) {
        const err = new Error(
          `telemetry-store: 事件数超过 ${MAX_SCAN_ROWS} 行，all() 拒绝返回截断的结果。`
          + ' 🔴 截断的聚合看起来正常但少算，且没有任何迹象 —— 请改用服务端聚合。');
        err.code = 'E_STORE_TOO_MANY_ROWS';
        throw err;
      }
      return rows.map((r) => r.ev);
    },

    /** 保留期外的事件已被折进 rollup（见 migrate.mjs 里 telemetry_rollup 表）。 */
    async rollup() {
      try {
        const [row] = await sql`select doc from telemetry_rollup where id = 1`;
        return row?.doc ?? emptyRollup();
      } catch (e) {
        throw new StoreUnavailableError(e);
      }
    },

    /**
     * 保留期清理 —— §5.3 的 180 天。
     *
     * 🔴 顺序：**先把要删的折进 rollup 并推水位、再删**。
     *    倒过来（先删再折算）时崩在中间，那批事件**没折算就没了**。
     *    这个方向崩在中间只会「已折算但还没删」，下一次 prune 按水位跳过它们，
     *    不会重复计数。与文件版同一个道理，见 store.mjs 里那段注释。
     */
    async prune(retentionDays, nowMs = Date.now()) {
      const cutoffMs = nowMs - retentionDays * 86_400_000;
      return sql.begin(async (tx) => {
        await tx`set local synchronous_commit = on`;
        const [meta] = await tx`select doc from telemetry_rollup where id = 1 for update`;
        const roll = meta?.doc ?? emptyRollup();
        const since = Number(roll.cutoff ?? 0);
        const doomed = await tx`
          select ev from telemetry_events
          where received_at >= to_timestamp(${since}::bigint / 1000.0)
            and received_at <  to_timestamp(${cutoffMs}::bigint / 1000.0)
        `;
        foldInto(roll, doomed.map((r) => r.ev));
        roll.cutoff = cutoffMs;
        await tx`
          insert into telemetry_rollup (id, doc) values (1, ${JSON.stringify(roll)}::jsonb)
          on conflict (id) do update set doc = excluded.doc
        `;
        const del = await tx`
          delete from telemetry_events
          where received_at < to_timestamp(${cutoffMs}::bigint / 1000.0)
          returning 1
        `;
        return { folded: doomed.length, deleted: del.length };
      });
    },
  };
}
