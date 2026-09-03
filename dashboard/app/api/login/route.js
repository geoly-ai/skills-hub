import { NextResponse } from 'next/server';

import {
  COOKIE_NAME, SESSION_MS, createLimiter, issueTicket, secretMatches,
} from '../../../lib/auth.mjs';
import { safeNext, sameOrigin } from '../../../lib/http-guards.mjs';

/*
 * 登录口。
 *
 * 🔴 **用原生 `<form method="post">`，不用前端 JS。**
 *    这不是复古趣味：登录页因此**不需要一个 client component**，
 *    于是「口令会不会被前端代码碰到」这个问题在结构上就不存在。
 *    整个 dashboard 里没有一个 `'use client'` 文件读 `process.env`，
 *    因为整个 dashboard 里根本没有需要读它的客户端代码。
 */

// 🔴 route handler 必须是动态的：它读 cookie/header，且**绝不能被缓存**
export const dynamic = 'force-dynamic';

const take = createLimiter();

function back(req, code, to) {
  const url = new URL('/login', req.url);
  url.searchParams.set('e', code);
  if (to && to !== '/') url.searchParams.set('to', to);
  return NextResponse.redirect(url, 303);
}

export async function POST(req) {
  const secret = (process.env.DASHBOARD_ACCESS_SECRET ?? '').trim();
  // proxy 已经在没配口令时整站 503 了；这里再挡一次，
  // 因为「proxy 的 matcher 哪天被改窄」是一件会悄悄发生的事。
  if (!secret) return NextResponse.json({ error: 'closed' }, { status: 503 });

  if (!sameOrigin(req)) return NextResponse.json({ error: 'bad-origin' }, { status: 403 });

  if (!take()) return back(req, 'rate', '/');

  const form = await req.formData().catch(() => null);
  const to = safeNext(form?.get('to'));
  const candidate = form?.get('secret');

  if (!(await secretMatches(secret, typeof candidate === 'string' ? candidate : ''))) {
    // ⚠️ 只回一个码，不回「口令长度不对」之类 —— 那是在教人怎么猜。
    return back(req, 'bad', to);
  }

  const res = NextResponse.redirect(new URL(to, req.url), 303);
  res.cookies.set({
    name: COOKIE_NAME,
    value: await issueTicket(secret),
    httpOnly: true,          // 脚本读不到
    secure: true,            // `__Host-` 前缀强制要求；localhost 上浏览器也接受
    sameSite: 'lax',         // 跨站请求不带它
    path: '/',               // `__Host-` 前缀强制要求
    maxAge: Math.floor(SESSION_MS / 1000),
  });
  return res;
}
