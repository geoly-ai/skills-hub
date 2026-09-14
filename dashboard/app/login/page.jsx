import { Icon } from '../../components/icons.jsx';
import { Notice } from '../../components/nothing.jsx';
import { safeNext } from '../../lib/http-guards.mjs';

/*
 * 登录页（DESIGN.md §15）。
 *
 * 🔴 **没有一行客户端 JS。** 原生 `<form method="post">` 就够了，
 *    于是「口令会不会被前端代码碰到」这个问题在结构上不存在。
 *    整个 dashboard 里没有一个 `'use client'` 文件 —— 这不是极简主义，
 *    是让「token 不进客户端 bundle」这条从「我们检查过了」变成「没有地方可进」。
 * 🔴 **没有采集面契约条、没有侧栏、没有数据源徽章** —— 那时我们还没问过任何东西。
 * 🔴 错误提示**复用告示条的形态**，「拒绝」在登录页与主页是同一种视觉语言。
 *    只回一句，不回「长度不对」「前几位对了」—— 那是在教人怎么猜。
 */

export const dynamic = 'force-dynamic';

const ERRORS = {
  bad: {
    icon: 's-denied',
    title: '口令不对。',
    body: '只告诉你这一句 ——「长度不对」「前几位对了」之类的提示是在教人怎么猜。',
  },
  rate: {
    icon: 's-unreachable',
    title: '试得太频繁，等一会儿再来。',
    body: '限速是全局的、不按来源分桶，因为我们不读访问者 IP —— 代价是有人狂试时会连带挡住别人。',
  },
};

export default async function LoginPage({ searchParams }) {
  const sp = await searchParams;
  const err = ERRORS[sp?.e];
  // 与登录口同一个守卫 —— 这里原先是一份更弱的手写检查（漏了 `/\` 与控制字符）
  const to = safeNext(sp?.to);
  return (
    <main className="loginframe" id="main">
      <div className="logincard">
        <div className="brandrow">
          <Icon name="n-boundary" />
          <span className="label">geoly-ai / skills-hub</span>
        </div>
        <h1>内部运营数据</h1>
        <p className="dim">
          这个平台展示的是「哪些 skill 没人用」「装失败集中在哪个版本」——
          还没对外说的话，和一份现成的攻击面清单。所以它不公开。
        </p>

        <form method="post" action="/api/login">
          <input type="hidden" name="to" value={to} />
          <label className="label-cn" htmlFor="secret">共享口令</label>
          <input
            id="secret" name="secret" type="password" autoComplete="current-password"
            required autoFocus spellCheck="false"
          />
          <button className="btn primary" type="submit">进入</button>
        </form>

        {err ? (
          <Notice look="n-fault" icon={err.icon} id="login-err" title={err.title} level={2}>
            <p>{err.body}</p>
          </Notice>
        ) : null}
      </div>
      <p className="cap">
        这把口令是<strong>共享</strong>的：它挡得住搜索引擎、被转发的链接和没有凭据的爬虫，
        但它<strong>没有个人身份</strong> —— 没法按人吊销，也没有「谁看了什么」的审计。
        有人离职就得换口令、所有人重登。
      </p>
    </main>
  );
}
