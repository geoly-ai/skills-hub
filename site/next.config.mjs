import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 站点数据由 `build.mjs` 在 `next build` 之前写好（package.json 的 `prebuild`）。
 * 这里读它只为了一件事：决定要不要开静态导出。
 *
 * 🔴 **文件不存在就让构建炸掉，不兜底。** 一个"读不到就当空"的兜底，会把
 *    「构建漏跑了一步」伪装成「registry 是空的」—— 而后者是本站点要如实说出口的
 *    一句有意义的话，不能被一个环境问题冒名顶替。
 */
const data = JSON.parse(readFileSync(fileURLToPath(new URL('./.generated/site-data.json', import.meta.url)), 'utf8'));

/**
 * 🔴 **有制品时用静态导出**（`output: 'export'`）：全部数据在构建时就定死进了 HTML，
 *    运行时不查后端、不发请求，页面上写的每个字都能追回到那一次构建读的那张快照。
 *
 * 🔴 **registry 为空时不能开 export**，这是 Next 的硬约束而不是我们的选择：
 *    `output: 'export'` 要求每个动态路由的 `generateStaticParams()` **至少产出一个页面**，
 *    否则 `next build` 直接失败。而现在一个制品都没有，制品详情页本就该是 0 个。
 *    要绕过它只有两条路：
 *      ① 造一个占位路由（`/artifact/none/none/none/none`）—— 那是**凭空发明一个
 *         不存在的制品 URL**，本站点整套设计的前提就是不做这种事；
 *      ② 空 registry 时退回 Next 的默认构建 —— 页面仍然全部在构建期预渲染、
 *         同样不查任何后端，只是产物不是一个纯静态目录。
 *    取 ②。代价：空状态下本地产物在 `.next/` 而不是 `out/`（Vercel 的 Next 预设两种都认，
 *    所以**不要**在 Vercel 上写死 Output Directory —— 写死了会在第一个制品发布的当天挂掉）。
 */
const nextConfig = {
  ...(data.empty ? {} : { output: 'export' }),
  // 导出成 `<路由>/index.html`，任何静态托管都能直接开。
  trailingSlash: true,
  // 站点没有位图资源；关掉优化器免得导出时报「需要运行时」。
  images: { unoptimized: true },
  // 仓库根与 site/ 各有一份 lockfile，不指定的话 Next 会猜工作区根并告警。
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
};

export default nextConfig;
