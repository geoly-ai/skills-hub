import Link from 'next/link';
import { Archivo, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';

import './tokens.css';
import './base.css';
import './components.css';

import { getSiteData, getSearchIndex } from '../lib/site-data';
import { IconSprite } from '../components/icons';
import { ThemeToggle, THEME_BOOTSTRAP } from '../components/theme-toggle';
import { GlobalSearch } from '../components/global-search';

/**
 * 🔴 **用 `next/font/google`，不用 `<link href="fonts.googleapis.com">`。**
 *    DESIGN.md §4.2 给的是 `<link>`，但那会让每个访客的浏览器在**运行时**向 Google 发请求 ——
 *    而本站点页脚印着「不查任何后端，也不发任何请求」，那句话就得改成谎话。
 *    `next/font/google` 在**构建期**把字体下载下来自托管，产物里只有同源的 woff2，
 *    运行时零第三方请求。§4.2 自己也写了 Next 项目走这条路，两边不冲突。
 *
 * ⚠️ 代价：`next build` 需要能访问 Google Fonts。CI/Vercel 都有网；离线构建会失败，
 *    那是**应该失败**的 —— 悄悄退回系统字体会让线上排版与设计规格无声地对不上。
 */
const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],          // 标题靠 wdth 轴拉宽取得分量（§4.1），不是靠字号
  display: 'swap',
  variable: '--font-archivo',
});
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-sans',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-mono',
});

export const metadata = {
  title: 'skills-hub registry',
  description: 'geoly-ai/skills-hub 的制品台账：这东西是谁签的、谁审的、从哪来的、现在还能不能用。',
};

export default function RootLayout({ children }) {
  const data = getSiteData();
  const index = getSearchIndex();
  const fontVars = `${archivo.variable} ${plexSans.variable} ${plexMono.variable}`;
  return (
    <html lang="zh-CN" className={fontVars} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <IconSprite />
        <a className="skip-link" href="#main">跳到主内容</a>

        <header className="site-header">
          <div className="wrap">
            <Link className="site-header__brand" href="/">skills-hub</Link>
            <span className="label" aria-hidden="true">registry ledger</span>
            <nav className="site-header__nav" aria-label="主导航">
              {/* registry 为空时列表页没有内容，导航里也就不该有一个指向空页的链接 */}
              {data.empty ? null : <Link href="/artifacts/">artifacts</Link>}
            </nav>
            <span className="spacer" />
            {/* 🔴 全局搜索必须在每一页：人拿到一串摘要时往往正停在某个详情页上，
                不该被迫先跳回列表页才能反查。 */}
            {data.empty ? null : <GlobalSearch index={index} />}
            <ThemeToggle />
          </div>
        </header>

        <main id="main"><div className="wrap">{children}</div></main>

        <footer className="site-footer">
          <div className="wrap">
            <p className="label-cn">关于这个站点</p>
            <p>{data.no_usage_statement}</p>
            <p className="dim">{data.trust_statement}</p>
            <p className="dim">
              仓库 <code className="mono">{data.repo}</code>。
              页面在构建时就渲染好了，不查任何后端，也不发任何请求（字体在构建期自托管）。
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
