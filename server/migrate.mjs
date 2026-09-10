#!/usr/bin/env node
// 一次性建表 —— **运行时一条 DDL 都不发**。
//
//   vercel env pull .env.local && node --env-file=.env.local server/migrate.mjs
//
// 🔴 **为什么不在运行时 `CREATE TABLE IF NOT EXISTS`：幂等 ≠ 并发安全。**
//    serverless 冷启动是「同时起好几个实例」，并发的 CREATE TABLE IF NOT EXISTS
//    会撞在 `pg_type_typname_nsp_index` 上 —— 那不是「跳过」，是一次真的 500，
//    而且发生在摄入路径上。
//
// 🔴 迁移自己也加了 advisory lock：两条流水线同时跑迁移撞的还是同一个约束。
//    ⚠️ 用**直连**（DATABASE_URL_UNPOOLED）：advisory lock 是会话级的，
//    走连接池的话锁可能落在另一条物理连接上。
//
// ⚠️ 跑完再查一遍 information_schema：**「命令没报错」不等于「表在那儿」**。
import postgres from 'postgres';

const url = process.env.DATABASE_URL_UNPOOLED
  ?? process.env.POSTGRES_URL_NON_POOLING
  ?? process.env.DATABASE_URL;
if (!url) {
  console.error('✖ 需要 DATABASE_URL_UNPOOLED / POSTGRES_URL_NON_POOLING / DATABASE_URL 之一');
  process.exit(1);
}
// 🔴 `POSTGRES_URL_NO_SSL` 明确不用：那会让连接明文出网。
const sql = postgres(url, { max: 1, ssl: 'require' });

const LOCK_KEY = 0x5ea1_1c5b;   // 任意但固定 —— 只要两边用同一个数

try {
  await sql`select pg_advisory_lock(${LOCK_KEY})`;

  await sql`
    create table if not exists telemetry_events (
      eid         text primary key,
      received_at timestamptz not null,
      ev          jsonb not null
    )
  `;
  // 🔴 `all()` 按 received_at 排序取，没有索引时那是一次全表排序。
  await sql`create index if not exists telemetry_events_received_at on telemetry_events (received_at)`;
  await sql`
    create table if not exists telemetry_rollup (
      id  int primary key,
      doc jsonb not null
    )
  `;
  // ── 身份表（2026-09-09 用户拍板加采身份字段）────────────────────────────
  //
  // 🔴 **与事件分表，不塞进 telemetry_events.ev。** 两个理由，都不是洁癖：
  //    ① 保留期不同：身份 90 天、计数 180 天。同表就得改写 jsonb —— 写放大、
  //       建不了索引，而且**删不干净**（jsonb 里删一个键要整行重写）。
  //    ② 删除请求要能「只删这个人的身份，保留匿名计数」。分表是一条 delete，
  //       同表是一次全表 jsonb 改写。
  //
  // 🔴 `on delete cascade`：事件过了 180 天被 prune 掉时，挂在它上面的身份行
  //    必须跟着走。反过来不成立 —— 身份 90 天先到期，删身份行不影响事件。
  //
  // 🔴 `ip` 是**服务端观测**的，不是客户端字段（客户端拿不到自己的出口 IP，
  //    去查等于给 CLI 加一次额外出网）。它只在受信代理后面才有意义，
  //    没配信任跳数时**存 null**，见 server/app.mjs 的 clientIp()。
  await sql`
    create table if not exists telemetry_identity (
      eid         text primary key references telemetry_events(eid) on delete cascade,
      received_at timestamptz not null,
      os_user     text,
      host        text,
      notice      text,
      ip          inet
    )
  `;
  // 🔴 **已经存在的表不会被 `create table if not exists` 改一个字。**
  //    `telemetry_identity` 在 2026-09-09 那次迁移里就建到生产库了；
  //    这次要给它加 `pubkey_tag`，只改上面那段 DDL 是**一点效果都没有**的，
  //    而且没有任何迹象 —— 迁移照样打印「完成」（Codex 2026-09-10 指出，
  //    我当时确实只改了上面那段）。加列一律走显式 ALTER。
  await sql`alter table telemetry_identity add column if not exists pubkey_tag text`;

  // 到期清理按 received_at 扫，必须有索引；否则 90 天那条 delete 是全表扫描。
  await sql`create index if not exists telemetry_identity_received_at on telemetry_identity (received_at)`;
  // 删除按 pubkey_tag 找行，必须有索引。
  await sql`create index if not exists telemetry_identity_pubkey_tag on telemetry_identity (pubkey_tag)`;
  // 归属页按人聚合，走这个索引。
  await sql`create index if not exists telemetry_identity_os_user on telemetry_identity (os_user)`;

  // ── 删除挑战的一次性 nonce ────────────────────────────────────────────
  //
  // 🔴 **只存 tag，不存公钥原文**：这张表是无鉴权端点写的，任何人都能往里灌。
  //    存原文等于给攻击者一个「谁问过」的清单。
  // 🔴 5 分钟 TTL 的**正确性靠查询时比 `expires_at`**，不靠清理任务跑没跑。
  //    清理只是控制表大小 —— 把正确性押在一个定时任务上，那个任务停了就没人知道。
  await sql`
    create table if not exists telemetry_delete_nonce (
      nonce       text primary key,
      pubkey_tag  text not null,
      expires_at  timestamptz not null,
      used_at     timestamptz
    )
  `;
  await sql`create index if not exists telemetry_delete_nonce_expires on telemetry_delete_nonce (expires_at)`;

  // ── 删除墓碑 ──────────────────────────────────────────────────────────
  //
  // 🔴 它**不是匿名数据**，是一个「永久、可关联的删除抑制标识」（Codex 的措辞）。
  //    存在的理由是：删除之后客户端队列里可能还压着旧事件，
  //    下一次 flush 会把身份重新插回来。没有它，「删除」对还没发完的队列无效。
  // 🔴 所以它存 tag 而不是公钥原文 —— 墓碑永久保留，
  //    存原文等于把一个稳定标识符永久留下，那正是删除要消除的东西。
  await sql`
    create table if not exists telemetry_delete_tombstone (
      pubkey_tag text primary key,
      at         timestamptz not null default now()
    )
  `;

  // ── 访问审计（只增不改）──────────────────────────────────────────────
  //
  // 🔴 **被拒绝的访问也记**：一次「没权限的人试图打开归属页」正是最该留痕的事。
  // 🔴 谁都不能删自己的记录 —— 应用连接不给 delete 权限（部署时授权，不在这里）。
  await sql`
    create table if not exists telemetry_audit (
      id         bigserial primary key,
      at         timestamptz not null default now(),
      viewer     text not null,
      action     text not null,
      target     text,
      allowed    boolean not null,
      request_id text
    )
  `;
  await sql`create index if not exists telemetry_audit_at on telemetry_audit (at desc)`;

  await sql`
    create table if not exists telemetry_meta (
      id         int primary key,
      pruned_at  timestamptz
    )
  `;
  await sql`insert into telemetry_meta (id, pruned_at) values (1, null) on conflict (id) do nothing`;

  // ── 核验：命令没报错 ≠ 表真的在 ────────────────────────────────────────
  const want = ['telemetry_events', 'telemetry_rollup', 'telemetry_meta',
    'telemetry_identity', 'telemetry_audit',
    'telemetry_delete_nonce', 'telemetry_delete_tombstone'];
  const rows = await sql`
    select table_name from information_schema.tables
    where table_schema = current_schema() and table_name = any(${want})
  `;
  const got = rows.map((r) => r.table_name).sort();
  if (got.length !== want.length) {
    console.error(`✖ 迁移跑完了，但 current_schema() 里只找到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want.sort())}`);
    process.exit(1);
  }
  // 🔴 **表在 ≠ 列在。** ALTER 是这次迁移的重点，所以它也要被核验 ——
  //    否则「迁移完成」这句话只覆盖了建表那一半。
  const cols = await sql`
    select column_name from information_schema.columns
    where table_schema = current_schema() and table_name = 'telemetry_identity'
  `;
  const names = cols.map((c) => c.column_name);
  for (const c of ['pubkey_tag', 'os_user', 'host', 'notice', 'ip', 'eid', 'received_at']) {
    if (!names.includes(c)) {
      console.error(`✖ telemetry_identity 少了列 ${c}，实际：${names.join('、')}`);
      process.exit(1);
    }
  }

  const [meta] = await sql`select count(*)::int as n from telemetry_meta`;
  if (meta.n !== 1) {
    console.error(`✖ telemetry_meta 应恰好 1 行，实际 ${meta.n}`);
    process.exit(1);
  }
  console.error(`✔ 迁移完成：${got.join('、')}`);
} finally {
  try { await sql`select pg_advisory_unlock(${LOCK_KEY})`; } catch { /* 连接已断就无所谓 */ }
  await sql.end({ timeout: 5 });
}
