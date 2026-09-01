// 到处都用的小件。规格：DESIGN.md §7.6（警示条）、§8（宽内容）、§10（可访问性）。

import { Icon } from './icons';

/** 宽内容（表格、命令）的横向滚动容器。`tabIndex` 让键盘也能滚。 */
export function ScrollX({ children, label }) {
  return <div className="scroll-x" tabIndex={0} role="group" aria-label={label}>{children}</div>;
}

/**
 * 警示条。
 *
 * 🔴 **用 `role="group" + aria-labelledby`，不要用 `role="alert"` / `role="status"`。**
 *    后两个是 live region，会让页面一加载就把这些内容朗读成"刚刚发生的事" ——
 *    而它们是页面既有的**静态事实**（这个版本三天前就被 yank 了），不是通知。
 *
 * 形态统一：顶边 3px 语义色 + 极淡底 + 16px 图标 + 标题 + 说明。
 * 没有大图标、没有满色实心条、没有惊叹号轰炸 —— 这些是事实，不是错误。
 */
export function Notice({ tone = 'neutral', icon = 'bang', title, id, children, actions }) {
  const headingId = id ?? `notice-${tone}`;
  return (
    <div className={`notice n-${tone}`} role="group" aria-labelledby={headingId}>
      <span className="ic"><Icon name={icon} /></span>
      <div>
        <h4 id={headingId}>{title}</h4>
        {children}
        {actions ? <div className="acts">{actions}</div> : null}
      </div>
    </div>
  );
}

/** 可复核命令块：虚线框 = 「这是可以拿走执行的东西」。`$` 不可选中。 */
export function Recheck({ children }) {
  return <div className="recheck"><span className="prompt">$</span>{children}</div>;
}

/** 空数组要显示成「快照里这一项是空的」，不是什么都不画 —— 两者含义不同。 */
export function StringList({ values, empty = '空数组' }) {
  if (!values || values.length === 0) return <span className="dim">{empty}</span>;
  return <span className="mono">{values.join(' · ')}</span>;
}

/**
 * 分布条。`count` 是**数出来的 record 条数**，没有任何使用情况含义。
 * 条形用中性色（`--c-text-dim`）：分布不是状态，不该占用语义色。
 */
export function Distribution({ rows, caption }) {
  if (rows.length === 0) return <p className="dim">（没有数据）</p>;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <div className="dist" role="table" aria-label={caption}>
      {rows.map((r) => (
        <div key={r.value} style={{ display: 'contents' }} role="row">
          <span className="k" role="cell">{r.value}</span>
          <span className="bar" role="cell" aria-hidden="true">
            <span className="fill" style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
          <span className="n" role="cell">{r.count}</span>
        </div>
      ))}
    </div>
  );
}
