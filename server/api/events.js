// 摄入端点。`/v1/events` → 这里（见 vercel.json 的 rewrites）。
//
// 🔴 **必须关掉平台的 body 解析。** `app.mjs` 的 `readBody` 是**边读边数**的：
//    它在流上累计字节、超限就停止缓冲并回 413。平台若先把 body 读完并塞进
//    `req.body`，那条内存上界就不成立了，只剩一个可被伪造的 Content-Length。
export const config = { api: { bodyParser: false } };

import { runtime, guarded } from '../vercel-runtime.mjs';

export default async function handler(req, res) {
  await guarded(req, res, async () => {
    const { handler: h } = runtime();
    // app.mjs 按 URL 分派；rewrite 之后 req.url 是 /api/events，改回契约路径。
    req.url = '/v1/events';
    await h(req, res);
  });
}
