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

  // 🔴 **tag 为 NULL 的身份行：删掉，然后让它再也出现不了。**（2026-09-13）
  //    摄入层早先从没把 pubkey 换成 tag（validate.mjs parseBatch 那段注释），
  //    所以在修复之前落库的身份行 tag 全是 NULL —— 删除通道按所有权**永远**找不到它们，
  //    而它们仍然是登录名、主机名与 IP。等 90 天到期不是答案：那 90 天里用户申请删除
  //    会得到「删除成功」，数据却还在。隐私优先，直接删（Codex 2026-09-13 的 P0）。
  //    ⚠️ 身份摄入的 kill switch 默认关，正常部署里这里应当删 0 行；删了非 0 行要说出来。
  const orphans = await sql`delete from telemetry_identity where pubkey_tag is null returning 1`;
  if (orphans.length > 0) {
    console.error(`⚠️ 删掉了 ${orphans.length} 行没有 pubkey_tag 的身份数据（无法按所有权删除的历史行）`);
  }
  // 然后从结构上禁止：同类缺陷再出现时，插入当场失败，而不是静默攒下删不掉的数据。
  // `alter … set not null` 对已经是 not null 的列是幂等的。
  await sql`alter table telemetry_identity alter column pubkey_tag set not null`;
  const [chk] = await sql`
    select 1 as ok from pg_constraint
    where conname = 'telemetry_identity_pubkey_tag_hex' and conrelid = 'telemetry_identity'::regclass
  `;
  if (!chk) {
    await sql`
      alter table telemetry_identity add constraint telemetry_identity_pubkey_tag_hex
      check (pubkey_tag ~ '^[0-9a-f]{64}$')
    `;
  }
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

  // ── tag 密钥指纹（2026-09-13）────────────────────────────────────────────
  //
  // 🔴 运行时的删除与身份摄入都要求「库里记的指纹 == 当前 GEOLY_TELEMETRY_TAG_SECRET 的指纹」，
  //    对不上就拒绝（server/delete.mjs tagKeyId 的长注释：换了密钥，删除会回
  //    `deleted: true` 却一行没删）。指纹只在这里写，**运行时从不写** ——
  //    否则第一个带着错密钥冷启动的实例就把指纹改成它自己的了。
  // 🔴 库里已有指纹且与当前环境不同：**迁移失败**，不覆盖。换密钥意味着历史 tag 全部作废，
  //    那是一个要人拍板的决定，不是迁移脚本顺手做的事。
  await sql`alter table telemetry_meta add column if not exists tag_key_id text`;
  const { tagKeyId } = await import('./delete.mjs');
  const envKeyId = tagKeyId();
  const [km] = await sql`select tag_key_id from telemetry_meta where id = 1`;
  if (envKeyId === null) {
    console.error('⚠️ 没有 GEOLY_TELEMETRY_TAG_SECRET：不写 tag 密钥指纹 —— 删除通道与身份摄入会一直回 503 / 丢身份');
  } else if (km?.tag_key_id == null) {
    await sql`update telemetry_meta set tag_key_id = ${envKeyId} where id = 1 and tag_key_id is null`;
  } else if (km.tag_key_id !== envKeyId) {
    console.error('✖ 库里的 tag 密钥指纹与当前 GEOLY_TELEMETRY_TAG_SECRET 不一致 —— 密钥被换过？');
    console.error('  历史 pubkey_tag 与墓碑都是用旧密钥算的，换密钥会让它们全部失效。不覆盖，迁移中止。');
    process.exit(1);
  }

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
  //    删除通道依赖的每张表都核一遍，不只是 telemetry_identity（Codex 2026-09-13 P2）。
  const wantCols = {
    telemetry_identity: ['pubkey_tag', 'os_user', 'host', 'notice', 'ip', 'eid', 'received_at'],
    telemetry_delete_nonce: ['nonce', 'pubkey_tag', 'expires_at', 'used_at'],
    telemetry_delete_tombstone: ['pubkey_tag', 'at'],
    telemetry_audit: ['id', 'at', 'viewer', 'action', 'target', 'allowed', 'request_id'],
    telemetry_meta: ['id', 'pruned_at', 'tag_key_id'],
  };
  const cols = await sql`
    select table_name, column_name, is_nullable from information_schema.columns
    where table_schema = current_schema() and table_name = any(${Object.keys(wantCols)})
  `;
  for (const [table, need] of Object.entries(wantCols)) {
    const names = cols.filter((c) => c.table_name === table).map((c) => c.column_name);
    for (const c of need) {
      if (!names.includes(c)) {
        console.error(`✖ ${table} 少了列 ${c}，实际：${names.join('、')}`);
        process.exit(1);
      }
    }
  }
  const tagCol = cols.find((c) => c.table_name === 'telemetry_identity' && c.column_name === 'pubkey_tag');
  if (tagCol?.is_nullable !== 'NO') {
    console.error('✖ telemetry_identity.pubkey_tag 仍可为 NULL —— 删不掉的身份行还会被静默写进来');
    process.exit(1);
  }
  // 主键就是去重与防重放的依据：nonce 表没有主键，「一次性」就不成立
  const pks = await sql`
    select tc.table_name, kcu.column_name from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    where tc.table_schema = current_schema() and tc.constraint_type = 'PRIMARY KEY'
      and tc.table_name = any(${['telemetry_delete_nonce', 'telemetry_delete_tombstone']})
  `;
  for (const [table, col] of [['telemetry_delete_nonce', 'nonce'], ['telemetry_delete_tombstone', 'pubkey_tag']]) {
    if (!pks.some((p) => p.table_name === table && p.column_name === col)) {
      console.error(`✖ ${table} 的主键不是 ${col} —— 防重放 / 墓碑去重不成立`);
      process.exit(1);
    }
  }
  // 🔴 「如果约束名不存在就创建」之后要**反查**：创建语句没报错 ≠ 约束在那儿（Codex 2026-09-13 P2）
  const [hex] = await sql`
    select 1 as ok from pg_constraint
    where conname = 'telemetry_identity_pubkey_tag_hex' and conrelid = 'telemetry_identity'::regclass
      and contype = 'c'
  `;
  if (!hex) {
    console.error('✖ telemetry_identity_pubkey_tag_hex 约束不存在 —— 非 tag 形状的值能写进 pubkey_tag');
    process.exit(1);
  }
  // 删除与到期清理都按这些索引走；缺了不是错，是全表扫描 —— 在公开端点上等于可被放大的 DoS
  const wantIdx = ['telemetry_identity_pubkey_tag', 'telemetry_identity_received_at',
    'telemetry_delete_nonce_expires', 'telemetry_audit_at', 'telemetry_events_received_at'];
  const idx = await sql`
    select indexname from pg_indexes
    where schemaname = current_schema() and indexname = any(${wantIdx})
  `;
  const haveIdx = new Set(idx.map((r) => r.indexname));
  const missingIdx = wantIdx.filter((n) => !haveIdx.has(n));
  if (missingIdx.length > 0) {
    console.error(`✖ 缺索引：${missingIdx.join('、')}`);
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
