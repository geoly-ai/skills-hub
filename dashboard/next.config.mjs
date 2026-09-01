import { fileURLToPath } from 'node:url';

/**
 * 🔴 **这个项目不能静态导出**（与 `site/` 相反）。
 *    `site/` 是把签名快照渲染成 HTML、运行时不查任何后端，所以能 `output: 'export'`。
 *    这里每一次访问都要去问一次 `/v1/summary`，还要跑门禁 middleware ——
 *    静态导出会把「某一次构建时的数据」冻进 HTML，而那份 HTML 是**不带门禁的**。
 *
 * 🔴 也**不开任何 ISR / 全页缓存**：内部运营数据，每一层缓存都是一次泄漏面；
 *    而且缓存住的那个「0」会在端点真的通了以后继续骗人。
 *    页面自己写了 `export const dynamic = 'force-dynamic'`，这里不再叠加配置 ——
 *    两处配缓存会让「到底哪一处生效」变成一个需要试出来的问题。
 */
const nextConfig = {
  // 仓库根、site/、dashboard/ 各有 lockfile，不指定的话 Next 会猜工作区根并告警
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
  images: { unoptimized: true },   // 本站没有位图资源
  poweredByHeader: false,
};

export default nextConfig;
