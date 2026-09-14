import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { cookies } from 'next/headers';

import { THEME_COOKIE, parseTheme } from '../lib/theme.mjs';

import './tokens.css';
import './base.css';
import './components.css';

/**
 * 🔴 **用 `next/font/google`，不用 `<link href="fonts.googleapis.com">`。**
 *    DESIGN.md §5.2 给的是 `<link>`（并注明 Next.js 可用 next/font 等价加载），
 *    但 `<link>` 会让每个访客的浏览器在**运行时**向 Google 发一次请求 ——
 *    把「谁在什么时候看了内部报表」这件事透给第三方，与本平台整套隐私立场相反。
 *    `next/font/google` 在**构建期**下载并自托管，运行时零第三方请求。
 *
 * ⚠️ 代价：`next build` 需要能访问 Google Fonts。离线构建会失败，
 *    那是**应该失败**的 —— 悄悄退回系统字体会让线上排版与设计规格无声地对不上。
 * 🔴 不 web 加载任何 CJK 字体（全量 5–10 MB），中文走 tokens.css 里的系统栈。
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin'], weight: ['400', '500', '600', '700'], display: 'swap', variable: '--font-plex-sans',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap', variable: '--font-plex-mono',
});

export const metadata = {
  title: 'skills-hub · 埋点数据平台',
  description: '内部运营数据：哪些 skill 在被用、装失败集中在哪、一次安装要多久。',
  // 🔴 门禁之外的第二层：别让搜索引擎索引。⚠️ 它**不是**访问控制。
  robots: { index: false, follow: false, nocache: true },
};

/**
 * 根布局只管 `<html>` / 字体 / 主题。骨架（侧栏、顶栏、契约条）在 components/shell.jsx，
 * 由各页自己套 —— 登录页不能有它们（DESIGN.md §15）。
 * 主题：cookie 里只有 light / dark；没有 = 跟随系统 = 不写 data-theme（lib/theme.mjs）。
 */
export default async function RootLayout({ children }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="zh-CN" className={`${sans.variable} ${mono.variable}`} data-theme={theme ?? undefined}>
      <body>
        <a className="skip-link" href="#main">跳到主内容</a>
        {children}
      </body>
    </html>
  );
}
