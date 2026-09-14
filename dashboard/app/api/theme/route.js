import { NextResponse } from 'next/server';

import { safeNext, sameOrigin } from '../../../lib/http-guards.mjs';
import { THEME_COOKIE, THEME_MAX_AGE_S, nextTheme } from '../../../lib/theme.mjs';

/*
 * 主题切换口（原生 form POST，零客户端 JS —— 理由见 lib/theme.mjs 顶部）。
 *
 * 🔴 **它不在 proxy 的 PUBLIC 里**：未登录的人碰不到它，门禁照常先跑。
 * 🔴 与登录口同一套护栏：同源检查（挡 CSRF）+ safeNext（挡开放重定向）。
 *    改的只是一个外观偏好，但「这个口子无害所以少一道检查」正是护栏被一处处拆掉的方式。
 * 🔴 响应头的 no-store / noindex 由 proxy 统一加（matcher 盖住 route handler）。
 */

export const dynamic = 'force-dynamic';

export async function POST(req) {
  if (!sameOrigin(req)) return NextResponse.json({ error: 'bad-origin' }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const to = safeNext(form?.get('to'));
  const next = nextTheme(req.cookies.get(THEME_COOKIE)?.value);

  const res = NextResponse.redirect(new URL(to, req.url), 303);
  res.cookies.set({
    name: THEME_COOKIE,
    value: next ?? '',
    httpOnly: true,          // 只有服务端读它（layout），脚本不需要碰
    secure: true,            // `__Host-` 前缀强制要求
    sameSite: 'lax',
    path: '/',               // `__Host-` 前缀强制要求
    maxAge: next ? THEME_MAX_AGE_S : 0,   // 回到「跟随系统」= 删掉 cookie
  });
  return res;
}
