// 聚合读出面。**不配 `GEOLY_TELEMETRY_SUMMARY_TOKEN` 就返回 404** —— 这是对的默认：
// 读出面默认关闭，不是默认打开再靠鉴权兜。
export const config = { api: { bodyParser: false } };

import { runtime, guarded } from '../vercel-runtime.mjs';

export default async function handler(req, res) {
  await guarded(req, res, async () => {
    // 🔴 **显式钉死缓存策略。** 不设的话 Vercel 默认回
    //    `public, max-age=0, must-revalidate` —— 今天不会被缓存
    //    （max-age=0 + BYPASS），但 `public` 挂在一个 **token 门后的内部聚合**上
    //    是松的：中间任何一层缓存都被告知「这东西可以公共缓存」。
    //    这类默认值出问题时不会报错，只会安静地多存一份。
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
    const { handler: h } = runtime();
    req.url = '/v1/summary';
    await h(req, res);
  });
}
