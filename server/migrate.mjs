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
  // 到期清理按 received_at 扫，必须有索引；否则 90 天那条 delete 是全表扫描。
  await sql`create index if not exists telemetry_identity_received_at on telemetry_identity (received_at)`;
  // 归属页按人聚合，走这个索引。
  await sql`create index if not exists telemetry_identity_os_user on telemetry_identity (os_user)`;

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
    'telemetry_identity', 'telemetry_audit'];
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
