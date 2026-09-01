import { Source_Serif_4, Inter, JetBrains_Mono } from 'next/font/google';

import './tokens.css';
import './base.css';
import './components.css';

/**
 * 🔴 **用 `next/font/google`，不用 `<link href="fonts.googleapis.com">`。**
 *    DESIGN.md §5.2 给的是 `<link>`，但那会让每个访客的浏览器在**运行时**向
 *    Google 发一次请求。这个页面只有内部同事看，那次请求会把
 *    「谁在什么时候看了内部报表」这件事透给第三方 —— 与本平台整套隐私立场相反。
 *    `next/font/google` 在**构建期**下载并自托管，运行时零第三方请求。
 *
 * ⚠️ 代价：`next build` 需要能访问 Google Fonts。离线构建会失败，
 *    那是**应该失败**的 —— 悄悄退回系统字体会让线上排版与设计规格无声地对不上。
 */
const serif = Source_Serif_4({
  subsets: ['latin'], axes: ['opsz'], display: 'swap', variable: '--font-serif',
});
const sans = Inter({
  subsets: ['latin'], weight: ['400', '500', '600', '700'], display: 'swap', variable: '--font-sans',
});
const mono = JetBrains_Mono({
  subsets: ['latin'], weight: ['400', '500', '700'], display: 'swap', variable: '--font-mono',
});

export const metadata = {
  title: 'skills-hub · 埋点数据平台',
  description: '内部运营数据：哪些 skill 在被用、装失败集中在哪、一次安装要多久。',
  // 🔴 门禁之外的第二层：别让搜索引擎索引。⚠️ 它**不是**访问控制。
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({ children }) {
  const fontVars = `${serif.variable} ${sans.variable} ${mono.variable}`;
  return (
    <html lang="zh-CN" className={fontVars}>
      <body>
        <a className="skip-link" href="#main">跳到主内容</a>

        <header className="site-header">
          <div className="wrap">
            <a className="brand" href="/">skills-hub</a>
            <span className="label" aria-hidden="true">telemetry</span>
            <span className="spacer" />
            <span className="label-cn">内部运营数据 · 不公开</span>
          </div>
        </header>

        <main id="main"><div className="wrap">{children}</div></main>

        <footer className="site-footer">
          <div className="wrap">
            <p className="label-cn">关于这个平台</p>
            <p>
              这里的每一个数字都来自 <code className="mono">/v1/summary</code> 的聚合返回。
              dashboard 自己<strong>不做任何聚合</strong> —— 聚合逻辑只有一份，在
              <code className="mono"> server/aggregate.mjs</code>。
              需要新维度就去那边加，不在这里补算：两份聚合必然分叉，而分叉不会让任何东西变红。
            </p>
            <p className="dim">
              上报是 at-least-once，摄入端点按规格 §5.3 无鉴权。
              🔴 这里的计数是**趋势信号，不是精确指标**，
              并且<strong>禁止用于计费或任何信任判定</strong>
              （「这个 skill 装的人多所以更可信」正是把一个无鉴权端点变成攻击面的做法）。
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
