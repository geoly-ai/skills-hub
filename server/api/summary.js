// 聚合读出面。**不配 `GEOLY_TELEMETRY_SUMMARY_TOKEN` 就返回 404** —— 这是对的默认：
// 读出面默认关闭，不是默认打开再靠鉴权兜。
export const config = { api: { bodyParser: false } };

import { runtime, guarded } from '../vercel-runtime.mjs';

export default async function handler(req, res) {
  await guarded(req, res, async () => {
    const { handler: h } = runtime();
    req.url = '/v1/summary';
    await h(req, res);
  });
}
