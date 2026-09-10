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
    async put(events, receivedAtMs, identities = [], ip = null) {
      if (events.length === 0) return { accepted: 0, duplicate: 0, identities: 0 };
      let inserted;
      let identitiesWritten = 0;
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
          const rows = await tx`
            insert into telemetry_events (eid, received_at, ev)
            select x->>'eid', to_timestamp(${receivedAtMs}::bigint / 1000.0), x->'ev'
            from jsonb_array_elements(${payload}::text::jsonb) as x
            on conflict (eid) do nothing
            returning eid
          `;
          // 🔴 **身份行与事件在同一个事务里写。** 分成两个事务的话，
          //    崩在中间会留下「事件在、身份不在」或者更糟的「身份在、事件不在」——
          //    后者连 FK 都挂不住，而 FK 正是保留期清理的依据。
          //
          // 🔴 **只给这一批真的插进去的事件写身份行。**（Codex 2026-09-09 指出：
          //    上一版把整个 identities 都插了，只靠 `on conflict (eid) do nothing`
          //    兜底 —— 那句只挡「身份行已存在」，挡不住「事件是旧的、身份行还没有」。
          //    后者恰恰是要挡的那一种：一台机器今天开了身份、重发了半年前的队列，
          //    半年前那些事件就会被**补上**今天观测到的 IP 与用户名。
          //    注释当时写的是「跟着事件走」，实现并没有做到 —— 现在做到了。)
          const freshIds = new Set(rows.map((r) => r.eid));
          let idRows = identities.filter((x) => freshIds.has(x.eid));
          // 🔴 **写身份行之前先按 tag 上事务锁，再查墓碑。**（Codex 2026-09-10 的第一条）
          //    没有这把锁时的竞态是：
          //      ① 摄入查墓碑 → 没命中
          //      ② 删除请求写墓碑、删身份、提交
          //      ③ 摄入接着把身份行插进去
          //    结果是**删完之后身份又回来了**，而两边各自看都没错。
          //    `WHERE NOT EXISTS` 挡不住它：那只保证单条语句内的原子性，
          //    挡不住「我插完了、你才提交墓碑」这个顺序。
          //    两条路径按**同一个** tag 取同一把 advisory lock，才真的串行。
          //    ⚠️ 用 `pg_advisory_xact_lock`（事务级）而不是会话级：
          //    serverless 下连接会被复用，会话级锁忘了释放就是永久死锁。
          const tags = [...new Set(idRows.map((x) => x.pubkey_tag).filter(Boolean))];
          for (const t of tags) {
            await tx`select pg_advisory_xact_lock(hashtext(${t}))`;
          }
          if (tags.length > 0) {
            const dead = await tx`
              select pubkey_tag from telemetry_delete_tombstone
              where pubkey_tag = any(${tags})
            `;
            const buried = new Set(dead.map((r) => r.pubkey_tag));
            if (buried.size > 0) {
              // 🔴 命中墓碑 = 这台机器已经要求删除过。**身份丢掉，匿名事件照收** ——
              //    删除的语义是「不要认出我」，不是「不要数我」。
              idRows = idRows.filter((x) => !buried.has(x.pubkey_tag));
            }
          }
          identitiesWritten = idRows.length;
          if (idRows.length > 0) {
            const idPayload = JSON.stringify(idRows);
            await tx`
              insert into telemetry_identity (eid, received_at, os_user, host, notice, ip, pubkey_tag)
              select x->>'eid', to_timestamp(${receivedAtMs}::bigint / 1000.0),
                     x->>'os_user', x->>'host', x->>'notice', ${ip}::inet, x->>'pubkey_tag'
              from jsonb_array_elements(${idPayload}::text::jsonb) as x
              on conflict (eid) do nothing
            `;
          }
          return rows;
        });
      } catch (e) {
        throw new StoreUnavailableError(e);
      }
      return {
        accepted: inserted.length,
        duplicate: events.length - inserted.length,
        // 报的是**真的写进去的**条数，不是收到的条数
        identities: identitiesWritten,
      };
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
          select ev, (extract(epoch from received_at) * 1000)::bigint as received_ms
          from telemetry_events
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
      // 🔴 **契约是 `Array<{ received_at, event }>`，不是裸事件。**
      //    见 store.mjs 顶部的 interface 注释。第一版这里 `return rows.map(r => r.ev)`,
      //    于是 app.mjs 的 `records.filter(r => r.received_at >= cutoff)` 里
      //    `undefined >= 0` 恒假 —— **每一行都被滤掉，/v1/summary 永远回 total: 0**。
      //    ⚠️ 而我的单测断言的是**错的契约**（`deepEqual(all(), [{eid:'x'}])`），
      //    所以它一路绿着。测试写错契约时，它守的就是那个错的契约。
      return rows.map((r) => ({ received_at: Number(r.received_ms), event: r.ev }));
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
     * 身份字段的保留期清理 —— 90 天，**比事件的 180 天短**。
     *
     * 🔴 与 prune() 是两条独立的到期线，不能合成一条：身份先到期，
     *    到期后那条事件仍然要以匿名形态活满 180 天。
     * 🔴 这里**只删不折算**：身份不进 rollup。一个「按人的历史计数」正是
     *    我们不想留下的东西 —— 留了它，删身份就成了一句空话。
     * 🔴 同样要 NaN 闸：水位是 NaN 时 `received_at < to_timestamp(NaN)` 一行都不删，
     *    保留期静默失效。
     */
    async pruneIdentity(retentionDays, nowMs = Date.now()) {
      const cutoffMs = nowMs - retentionDays * 86_400_000;
      if (!Number.isFinite(cutoffMs)) {
        throw new Error(`telemetry-server: pruneIdentity 的水位不是有限数值：${cutoffMs}`);
      }
      try {
        const del = await sql`
          delete from telemetry_identity
          where received_at < to_timestamp(${cutoffMs}::bigint / 1000.0)
          returning 1
        `;
        return { deleted: del.length };
      } catch (e) {
        throw new StoreUnavailableError(e);
      }
    },

    /**
     * 到期剥掉 `install_id` —— 与身份三项同一条 90 天到期线（用户 2026-09-09 选 1A）。
     *
     * 🔴 **为什么它属于身份而不属于计数。** 身份行 90 天后删了，但 `install_id`
     *    还在事件 JSON 里躺到 180 天：它配上时间线仍然能把同一台机器的行为串起来，
     *    再与新数据一关联就重新指回人（Codex 2026-09-09 指出）。
     *    留着它，「身份 90 天」这句话是假的。
     *
     * 🔴 **代价写在这里，别让后来的人自己撞上：** 90 天之后那批事件**算不出
     *    去重装机数**。今天没有影响 —— `aggregate.mjs` 压根没用过 `install_id`，
     *    服务端的 `installs` 聚合至今是个缺口。但**将来写那个聚合时，它只能覆盖
     *    90 天以内的窗口**；跨过这条线去算，得到的是一个偏小且无声偏小的数，
     *    而 K=5 抑制正是拿它当判据的。
     *
     * 🔴 用 `jsonb_exists(ev, 'install_id')` 而不是 `ev ? 'install_id'`：
     *    `?` 在很多驱动里是参数占位符，写进模板字符串是自找的歧义。
     *
     * 🔴 **每轮有上限。** 第一次跑可能撞上一大批历史；不封顶的话这条 UPDATE
     *    会把一次定时任务拖成长事务。撞上限时**说出来**（`capped`），
     *    下一轮接着剥 —— 悄悄剥一半是最糟的形态。
     */
    async pruneInstallIds(retentionDays, nowMs = Date.now(), cap = 50_000) {
      const cutoffMs = nowMs - retentionDays * 86_400_000;
      if (!Number.isFinite(cutoffMs)) {
        throw new Error(`telemetry-server: pruneInstallIds 的水位不是有限数值：${cutoffMs}`);
      }
      try {
        const rows = await sql`
          with doomed as (
            select eid from telemetry_events
            where received_at < to_timestamp(${cutoffMs}::bigint / 1000.0)
              and jsonb_exists(ev, 'install_id')
            limit ${cap}
          )
          update telemetry_events e set ev = e.ev - 'install_id'
          from doomed d where e.eid = d.eid
          returning 1
        `;
        return { stripped: rows.length, capped: rows.length >= cap };
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
      // 🔴 与文件版 store.mjs:151 同一道闸，早先只有那边有。
      //    NaN 进来时后果不是「删多了」而是**折算水位被写坏**：
      //    `JSON.stringify({cutoff: NaN})` 出的是 `null`，下一轮读回来当 0，
      //    于是**同一批历史被反复折算进 rollup**，计数只涨不停，且全程不报错。
      if (!Number.isFinite(cutoffMs)) {
        throw new Error(`telemetry-server: prune 的水位不是有限数值：${cutoffMs}`);
      }
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
        // 🔴 `foldInto` 是**纯函数**：它返回一份新的 rollup，不就地改入参
        //    （aggregate.mjs 顶部那段注释说的正是这件事 —— 入参可能是 store 里
        //    正在用的那一份）。这里早先写成 `foldInto(roll, …)` 丢掉返回值、
        //    再把**没折算过**的 `roll` 写回去：水位照推、计数一条不涨，
        //    于是每一次 prune 删掉的事件都从历史里彻底消失，而且**不报错**。
        //    文件版 store.mjs:154 一直是 `const next = foldInto(…)`，只有这里漏了。
        const folded = foldInto(roll, doomed.map((r) => r.ev));
        folded.cutoff = cutoffMs;
        await tx`
          insert into telemetry_rollup (id, doc) values (1, ${JSON.stringify(folded)}::jsonb)
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
