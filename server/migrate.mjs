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
  await sql`
    create table if not exists telemetry_meta (
      id         int primary key,
      pruned_at  timestamptz
    )
  `;
  await sql`insert into telemetry_meta (id, pruned_at) values (1, null) on conflict (id) do nothing`;

  // ── 核验：命令没报错 ≠ 表真的在 ────────────────────────────────────────
  const want = ['telemetry_events', 'telemetry_rollup', 'telemetry_meta'];
  const rows = await sql`
    select table_name from information_schema.tables
    where table_schema = current_schema() and table_name = any(${want})
  `;
  const got = rows.map((r) => r.table_name).sort();
  if (got.length !== want.length) {
    console.error(`✖ 迁移跑完了，但 current_schema() 里只找到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want.sort())}`);
    process.exit(1);
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
