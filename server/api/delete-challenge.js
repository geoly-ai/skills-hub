// 删除通道端点。`/v1/delete/challenge` → 这里（见 vercel.json 的 rewrites）。
//
// 🔴 与 events.js 一样关掉平台的 body 解析：app.mjs 的 readBody 边读边数，
//    平台先读完塞进 `req.body` 的话体积闸就不成立了。
export const config = { api: { bodyParser: false } };

import { runtime, guarded } from '../vercel-runtime.mjs';

export default async function handler(req, res) {
  await guarded(req, res, async () => {
    const { handler: h } = runtime();
    // app.mjs 按 URL 分派；rewrite 之后 req.url 是 /api/delete-challenge，改回契约路径。
    req.url = '/v1/delete/challenge';
    await h(req, res);
  });
}
