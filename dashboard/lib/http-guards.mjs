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
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;             // 老浏览器 / 无 Origin 的 form POST
  try {
    const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim();
    const self = new URL(req.url);
    if (proto) self.protocol = `${proto}:`;
    return new URL(origin).origin === self.origin;
  } catch {
    return false;
  }
}
