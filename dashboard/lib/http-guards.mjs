/*
 * 登录口的两道输入守卫。
 *
 * 🔴 **抽成模块只有一个理由：让它们能被测试。** 写在 route handler 里的守卫
 *    只能靠「跑一次真请求」来验，于是实际上没人验 —— 而这两条错了都不会变红。
 */

/**
 * 只接受站内的相对路径。
 * 🔴 `//evil.com` 是一个合法的**协议相对**跳转，`/\evil.com` 在部分浏览器里同样能跳走。
 */
export function safeNext(raw) {
  if (typeof raw !== 'string') return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

/**
 * CSRF：只接受同源提交。
 *
 * ⚠️ SameSite=Lax 已经挡住了跨站 POST 带 cookie，但登录这一步**还没有 cookie**——
 *    它要防的是别人用一个恶意页面把用户「登进」一个攻击者控制的会话（login CSRF）。
 *
 * 🔴 比 `origin` 而不是 `host`：只比 host 会把同主机的 http 与 https 当成同源
 *    （Codex 2026-09-01 指出），于是一个能在 http 上落地页面的攻击者就能对
 *    https 的这一站发登录 CSRF。
 * ⚠️ Vercel 上运行时看到的是内部 http，所以用 `x-forwarded-proto` 还原对外协议；
 *    没有这个头时退回 URL 自己的协议。
 *
 * @param {{url:string, headers:{get(name:string):string|null}}} req
 */
export function sameOrigin(req) {
  // ── ① `Sec-Fetch-Site` 是**浏览器设的**，页面脚本改不了 —— 优先信它 ──────
  //
  // 🔴 2026-09-03 线上实测到一个**自己的两个安全头打架**的问题：
  //    本站每个响应都设 `referrer-policy: no-referrer`（为隐私，本身是对的），
  //    而规范规定：引荐来源策略为 `no-referrer` 时，请求的 `Origin` 被序列化成
  //    **字面字符串 `"null"`**。于是同源的表单提交带着 `Origin: null` 过来，
  //    下面那段 `new URL(origin)` 解析失败 → 一律拒 → **用户输对口令也进不去**。
  //    ⚠️ curl 复现不出来，因为 curl 不遵守引荐来源策略 ——
  //    我用四种 header 组合验过「都通」，而真实浏览器仍然被拒。
  //
  // 判据顺序有意如此：
  //   · `cross-site` → 拒。这是 login CSRF 的形状，且这个值伪造不了。
  //   · `same-origin` / `same-site` / `none` → 放行。浏览器已经断言了来源，
  //     再去比一个被策略抹成 `null` 的 Origin 只会误伤。
  //   · 没有这个头（老浏览器）→ 落到 ② 的 Origin 比对。
  const site = req.headers.get('sec-fetch-site');
  if (site === 'cross-site') return false;
  if (site) return true;

  // ── ② 老浏览器兜底：比 origin ────────────────────────────────────────────
  const origin = req.headers.get('origin');
  if (!origin || origin === 'null') return true;   // 无 Origin / 被策略抹成 null
  try {
    // 🔴 比 `origin` 而不是 `host`：只比 host 会把同主机的 http 与 https 当成同源
    //    （Codex 2026-09-01），于是能在 http 上落地页面的攻击者就能打 https 这一站。
    //    ⚠️ Vercel 上运行时看到的是内部 http，用 `x-forwarded-proto` 还原对外协议。
    const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim();
    const self = new URL(req.url);
    if (proto) self.protocol = `${proto}:`;
    return new URL(origin).origin === self.origin;
  } catch {
    return false;
  }
}

