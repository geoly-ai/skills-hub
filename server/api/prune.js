// 保留期清理 —— 由 Vercel Cron 打（见 vercel.json 的 crons）。
//
// 🔴 **进程内的 setInterval 在 serverless 上完全不跑**，所以 §5.3 的 180 天
//    保留期在这个形态下**只能**靠外部触发。少了这个端点，保留期就是一句空话。
//
// 🔴 **必须校验 CRON_SECRET。** 这个路径会删数据；不校验的话任何人都能打它。
//    ⚠️ 没配 CRON_SECRET 时**拒绝服务**而不是放行 —— 「没配 = 不设防」是
//    最容易在部署时漏掉、又最没有迹象的一种失败。
export const config = { api: { bodyParser: false } };

import { runtime, guarded } from '../vercel-runtime.mjs';

// 🔴 **保留期读不出数就拒绝服务，不要回落到默认值。**
//    `Number('180 days')` 是 NaN，而 `NaN * 86_400_000` 也是 NaN ——
//    cutoff 成了 NaN，`received_at < to_timestamp(NaN)` 一行都删不掉：
//    保留期静默失效，数据无限期留着，而端点照样回 200 ok。
//    「配错 = 不清理」是最没有迹象的一种失败，所以配错就 503。
function identityRetentionDays() {
  const raw = process.env.GEOLY_TELEMETRY_IDENTITY_RETENTION_DAYS;
  if (raw === undefined || raw === '') return 90;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 3650) return null;
  return n;
}

export function retentionDays() {
  const raw = process.env.GEOLY_TELEMETRY_RETENTION_DAYS;
  if (raw === undefined || raw === '') return 180;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 3650) return null;
  return n;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'cron_secret_not_configured' }));
  }
  // Vercel Cron 会带 `Authorization: Bearer <CRON_SECRET>`。
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }
  const days = retentionDays();
  const idDays = identityRetentionDays();
  if (days === null || idDays === null) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'retention_days_invalid' }));
  }
  // 🔴 身份的保留期必须**短于**事件：反过来配的话，身份行会一直等到事件
  //    过期被 cascade 带走，「身份 90 天」就成了「身份跟事件一样久」。
  //    这种配置错误没有任何迹象，所以在这里挡住。
  if (idDays > days) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'identity_retention_longer_than_events' }));
  }
  await guarded(req, res, async () => {
    const { sql } = runtime();
    const { openPostgresStore } = await import('../store-postgres.mjs');
    const store = openPostgresStore(sql);
    // 🔴 **身份先清，再清事件。** 顺序反了的话，事件被 prune 掉时
    //    `on delete cascade` 会顺手把身份行也带走 —— 结果看起来一样，
    //    但那时「身份 90 天」这条线从来没有真正跑过，它是否有效无从验证。
    //    先跑身份这一条，日志里才会有它自己的删除条数。
    const idr = await store.pruneIdentity(idDays);
    const r = await store.prune(days);
    await sql`update telemetry_meta set pruned_at = now() where id = 1`;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: true, retentionDays: days, identityRetentionDays: idDays,
      identityDeleted: idr.deleted, ...r,
    }));
  });
}
