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

const RETENTION_DAYS = Number(process.env.GEOLY_TELEMETRY_RETENTION_DAYS ?? 180);

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
  await guarded(req, res, async () => {
    const { sql } = runtime();
    const { openPostgresStore } = await import('../store-postgres.mjs');
    const r = await openPostgresStore(sql).prune(RETENTION_DAYS);
    await sql`update telemetry_meta set pruned_at = now() where id = 1`;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, retentionDays: RETENTION_DAYS, ...r }));
  });
}
