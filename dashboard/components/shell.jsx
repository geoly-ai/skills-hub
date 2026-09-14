import { cookies } from 'next/headers';

import { SOURCE } from '../lib/state.mjs';
import { THEME_COOKIE, themeLabel } from '../lib/theme.mjs';
import { CollectionBar } from './collection-bar.jsx';
import { Icon } from './icons.jsx';

/*
 * 页面骨架（DESIGN.md §8.1）：侧栏 + 顶栏 + 采集面契约条 + 主区。
 *
 * 🔴 **不设右侧栏**：一旦有右栏，状态与口径就会被塞进去变成脚注。
 * 🔴 登录页不用这个骨架 —— 那时我们还没问过任何东西，不该有契约条、侧栏、徽章（§15）。
 */

const NAV = [
  { key: 'overview', href: '/#s00', icon: 'n-overview', num: '00', text: '总览' },
  { key: 'usage', href: '/#s01', icon: 'n-usage', num: '01', text: '使用' },
  { key: 'failures', href: '/#s02', icon: 'n-failures', num: '02', text: '失败' },
  { key: 'latency', href: '/#s03', icon: 'n-latency', num: '03', text: '耗时' },
  { key: 'gaps', href: '/#s99', icon: 'n-gaps', num: '99', text: '服务端缺口' },
  { key: 'boundary', href: '/boundary', icon: 'n-boundary', num: null, text: '口径与边界' },
];

/**
 * 🔴 徽章的作用域**只有 SOURCE 五态**（§8.2）。`unrecognized-rows` 不许进来：
 *    那是某一张表的数据质量问题，端点本身是通的，升级成全局徽章就是一句假话。
 * 🔴 「已连通」不是绿色 —— 全站没有绿色。
 */
const CHIP = {
  [SOURCE.OK]: { text: '端点已连通', icon: 's-zero', fault: false },
  [SOURCE.UNCONFIGURED]: { text: '端点未接上', icon: 's-unconfigured', fault: true },
  [SOURCE.UNREACHABLE]: { text: '端点不可用', icon: 's-unreachable', fault: true },
  [SOURCE.DENIED]: { text: '端点拒绝了我们', icon: 's-denied', fault: true },
  [SOURCE.INVALID]: { text: '响应不是汇总', icon: 's-invalid', fault: true },
};

/**
 * 🔴 「本次读取」是**我们自己发这次请求的时刻**（本机时钟），不来自任何一条事件。
 *    文案不许简写成「更新于」；从 `at` 派生的任何时间都是 T-11 时间线的入口（§1.1 第 1 条）。
 */
function formatReadAt(d) {
  return `${d.toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/**
 * @param {{
 *   title: string, current: 'overview'|'boundary', path: string,
 *   source?: string, readAt?: Date, children: any,
 * }} props
 * `source` / `readAt` 只在这一页**真的问过上游**时传；没问过就不渲染徽章与「本次读取」
 * —— 没读就不说读了。
 */
export async function Shell({ title, current, path, source, readAt, children }) {
  const theme = (await cookies()).get(THEME_COOKIE)?.value;
  const chip = source ? CHIP[source] : null;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <p className="label">geoly-ai / skills-hub</p>
          <p className="nm">telemetry console</p>
        </div>
        <nav className="nav" aria-label="主导航">
          <ul>
            {NAV.map((n) => (
              <li key={n.key}>
                <a href={n.href} aria-current={n.key === current ? 'page' : undefined}>
                  <Icon name={n.icon} size={16} />
                  {n.num ? <span className="num">{n.num}</span> : null}
                  {n.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidefoot">
          {/* 规格 §5.3：摄入端点无鉴权、上报 at-least-once —— 这是给读数字的人的边界 */}
          <p className="cap">
            这里的计数是趋势信号，不是精确指标；禁止用于计费或任何信任判定。
          </p>
        </div>
      </aside>

      <div>
        <header className="topbar">
          <h1>{title}</h1>
          {chip ? (
            <span className={chip.fault ? 'statechip fault' : 'statechip'}>
              <Icon name={chip.icon} />
              {chip.text}
            </span>
          ) : null}
          <span className="spacer" />
          {readAt ? <span className="when">本次读取 {formatReadAt(readAt)}</span> : null}
          {/* 主题三态：原生表单，零客户端 JS（lib/theme.mjs） */}
          <form method="post" action="/api/theme">
            <input type="hidden" name="to" value={path} />
            <button className="btn" type="submit">
              <Icon name="u-theme" size={12} />
              主题：{themeLabel(theme)}
            </button>
          </form>
        </header>

        <CollectionBar />

        <main className="main" id="main">{children}</main>
        {/* 窄屏时侧栏底部隐藏，这句挪到这里；宽屏由 CSS 隐藏，避免同屏出现两遍（§5.3） */}
        <p className="cap mainfoot">
          这里的计数是趋势信号，不是精确指标；禁止用于计费或任何信任判定。
        </p>
      </div>
    </div>
  );
}
