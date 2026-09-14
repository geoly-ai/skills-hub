/*
 * 主题三态：跟随系统 → 亮 → 暗 → 跟随系统（DESIGN.md §14）。
 *
 * 🔴 **不用客户端 JS 做**。整个 dashboard 没有一个 client component、登录页没有一行 JS ——
 *    这两条是「抑制发生在服务端」「口令碰不到前端代码」的结构性保证，
 *    不值得为一个主题按钮破例。所以切换是一个原生 `<form method="post">`：
 *    服务端改 cookie、303 回原页，layout 读 cookie 把 `data-theme` 写进 `<html>`。
 *    代价：切一次主题整页往返一次（上游也会被多问一次）。
 *
 * cookie 里只放 `light` / `dark`；「跟随系统」= 没有 cookie = 不写 data-theme，
 * 于是 `@media (prefers-color-scheme)` 生效。
 */

/** `__Host-` 前缀：强制 Secure + Path=/ + 无 Domain，与登录 cookie 同一条纪律。 */
export const THEME_COOKIE = '__Host-dashboard-theme';

export const THEME_MAX_AGE_S = 365 * 24 * 60 * 60;

/** 只认两个值；其余（含缺失、篡改）一律当「跟随系统」。返回 null 表示跟随系统。 */
export function parseTheme(raw) {
  return raw === 'light' || raw === 'dark' ? raw : null;
}

/** 下一个主题。null = 跟随系统（应删除 cookie）。 */
export function nextTheme(raw) {
  const t = parseTheme(raw);
  if (t === null) return 'light';
  if (t === 'light') return 'dark';
  return null;
}

/** 按钮上直接写出**当前**值（§14）。 */
export function themeLabel(raw) {
  const t = parseTheme(raw);
  return t === 'light' ? '亮' : t === 'dark' ? '暗' : '跟随系统';
}
