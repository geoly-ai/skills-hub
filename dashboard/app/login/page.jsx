/*
 * 登录页。
 *
 * 🔴 **没有一行客户端 JS。** 原生 `<form method="post">` 就够了，
 *    于是「口令会不会被前端代码碰到」这个问题在结构上不存在。
 *    整个 dashboard 里没有一个 `'use client'` 文件 —— 这不是极简主义，
 *    是让「token 不进客户端 bundle」这条从「我们检查过了」变成「没有地方可进」。
 */

export const dynamic = 'force-dynamic';

const ERRORS = {
  bad: '口令不对。（只告诉你这一句 —— 「长度不对」「前几位对了」之类的提示是在教人怎么猜。）',
  rate: '试得太频繁，等一会儿再来。限速是全局的、不按来源分桶，因为我们不读访问者 IP —— '
    + '代价是有人狂试时会连带挡住别人。',
};

export default async function LoginPage({ searchParams }) {
  const sp = await searchParams;
  const err = ERRORS[sp?.e];
  const to = typeof sp?.to === 'string' && sp.to.startsWith('/') && !sp.to.startsWith('//') ? sp.to : '/';
  return (
    <div className="login">
      <p className="label">geoly-ai/skills-hub · telemetry</p>
      <h1>内部运营数据</h1>
      <p className="lede">
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
        <button type="submit">进入</button>
      </form>

      {err ? <p className="err">{err}</p> : null}

      <p className="note dim" style={{ marginTop: 'var(--sp-6)' }}>
        这把口令是<strong>共享</strong>的：它挡得住搜索引擎、被转发的链接和没有凭据的爬虫，
        但它<strong>没有个人身份</strong> —— 没法按人吊销，也没有「谁看了什么」的审计。
        有人离职就得换口令、所有人重登。要真正的审计与按人吊销得上 SSO，本版没做。
      </p>
    </div>
  );
}
