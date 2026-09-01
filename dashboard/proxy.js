import { NextResponse } from 'next/server';

import { COOKIE_NAME, verifyTicket } from './lib/auth.mjs';

/*
 * 门禁。**在这里，不在页面里。**
 *
 * 🔴 放在 proxy（Next 16 之前叫 middleware）的理由不是「方便」：它跑在**任何一次数据读取之前**。
 *    如果门禁写在页面组件里，未登录的请求已经先去问过一次 `/v1/summary` 了 ——
 *    上游被白白敲一次，而且那次请求带着 token。
 *
 * 🔴 matcher 必须**同时**盖住页面、RSC payload 与 route handler。
 *    Next 的 RSC 请求走的是同一个 pathname（带 `?_rsc=`），所以只要不按扩展名放行，
 *    它天然被盖住 —— 但别加「只匹配 HTML」之类的条件，那会开一个只对
 *    `fetch('/xxx?_rsc=')` 敞开的后门。
 */

/** 两个不需要凭据就能到的路径：登录页本身与它的提交口。 */
const PUBLIC = new Set(['/login', '/api/login']);

/**
 * 每个响应都要带的头。
 * · X-Robots-Tag  —— ⚠️ **它不是访问控制**，只是别让内容进搜索引擎索引；
 *                     真正挡人的是下面那把 cookie。
 * · Cache-Control —— 🔴 内部运营数据不许被任何一层缓存留下（CDN、浏览器、
 *                     共享代理）。少了它，一个 CDN 节点就可能把某个人的
 *                     已登录页面发给下一个未登录的人。
 * · Referrer-Policy —— 页面上有制品坐标，别让它随 Referer 漏到外站去。
 */
function harden(res) {
  res.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  res.headers.set('cache-control', 'private, no-store, max-age=0, must-revalidate');
  res.headers.set('referrer-policy', 'no-referrer');
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('x-frame-options', 'DENY');
  return res;
}

export default async function proxy(req) {
  const secret = (process.env.DASHBOARD_ACCESS_SECRET ?? '').trim();

  // 🔴 **没配口令 = 整站关闭**，不是「没配就放行」。
  //    「忘了配」在部署里是最常见的一种事故，而它的两种后果差别极大：
  //    fail-closed 是「没人能看，很快就有人来报修」；
  //    fail-open 是「所有人都能看，而且没有人会发现」。
  //    规格 §5.3 对读出面定的也是这一条：没配 token 就不开那个路由。
  if (!secret) {
    return harden(new NextResponse(
      JSON.stringify({
        error: 'closed',
        detail: 'DASHBOARD_ACCESS_SECRET 没配。这个平台展示内部运营数据，未配口令时整站关闭。',
      }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } },
    ));
  }

  const { pathname } = req.nextUrl;
  if (PUBLIC.has(pathname)) return harden(NextResponse.next());

  const ok = await verifyTicket(secret, req.cookies.get(COOKIE_NAME)?.value, Date.now());
  if (ok) return harden(NextResponse.next());

  const to = req.nextUrl.clone();
  to.pathname = '/login';
  // ⚠️ 只回传 pathname，**不回传 query**：query 里可能有筛选条件，
  //    而登录页的 URL 会被打进浏览器历史、可能被截图分享。
  to.search = pathname === '/' ? '' : `?to=${encodeURIComponent(pathname)}`;
  return harden(NextResponse.redirect(to));
}

export const config = {
  // 放行的只有 Next 自己的静态产物与 favicon —— 它们不含数据。
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
