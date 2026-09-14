import { MIN_INSTALLS } from '../lib/suppress.mjs';
import { Icon } from './icons.jsx';

/*
 * KPI 卡（DESIGN.md §8.4 / §10.5）。
 *
 * 🔴 **形态本身是信息**：exact / bucketed / floored / unknown 四种，caption 不许省。
 * 🔴 **精确值不带图标**；m-* 只挂在非精确的量度上 —— 给每个数字都挂一个图标，
 *    「有图标 = 有异常」这个信号就失效了。
 * 🔴 数值槽固定宽度、tabular-nums、**不许按内容缩字号**：
 *    缩字号会让「区间」看起来比「精确值」小一号，读者会以为它次要。
 * 🔴 这里只渲染 publish() 给出的 `totalOut` / `installsOut`，**永远不碰 data.total 原值**。
 */

const FORM = {
  exact: { cls: 'kpi', icon: null },
  bucketed: { cls: 'kpi withheld-kpi', icon: 'm-bucket' },
  floored: { cls: 'kpi withheld-kpi', icon: 'm-floored' },
  unknown: { cls: 'kpi unknown-kpi', icon: 'm-unknown' },
};

function captionOf(out) {
  switch (out.kind) {
    case 'exact':
      return out.text === '0'
        ? '真的是 0 · 我们问到了，答案就是一条都没有'
        : '没有哪张表有行没发出来，所以这个数是精确的';
    case 'bucketed':
      // 🔴 必须写出因果：只写「区间」，读者会以为服务端就只给了一个区间
      return '只给区间：下面有表没发出来，给精确数就能倒推';
    case 'floored':
      return `不到 ${MIN_INSTALLS}，具体几个不写 · 写出来就能对上人`;
    default:
      return '服务端这一版没给这个数 · 不是 0，是我们不知道';
  }
}

/** @param {{ label: string, out: {kind:'exact'|'bucketed'|'floored'|'unknown', text:string} }} props */
export function MeasureKpi({ label, out }) {
  const form = FORM[out.kind] ?? FORM.unknown;
  return (
    <div className={form.cls}>
      <div className="top">
        <span className="label">{label}</span>
        <span className="spacer" />
        {form.icon ? <Icon name={form.icon} size={12} /> : null}
      </div>
      {/* 🔴 未提供 = 冷灰 + 虚线下划，不是 0，也不是 <5 */}
      <span className="v">{out.kind === 'unknown' ? <span className="t">{out.text}</span> : out.text}</span>
      <span className="cap">{captionOf(out)}</span>
    </div>
  );
}

/**
 * 🔴 **第三张卡不是 KPI**：`hasRolledUp` 来自 `rolled_up_before`，不在采集面白名单里。
 *    做成和 events 一样大的数字，就等于宣称它也是一个采集指标。
 * 🔴 **只给布尔，绝不显示那个水位时间戳**。
 */
export function SourceNoteKpi({ hasRolledUp }) {
  return (
    <div className="kpi sourcenote">
      <div className="top"><span className="label-cn">关于数据本身 · 不是指标</span></div>
      <span className="v">{hasRolledUp ? '早的那段只剩计数' : '原始事件都还在'}</span>
      <span className="cap">
        {hasRolledUp
          ? '太旧的原始事件已经删了，只留下计数 · 具体从哪天起，我们不写出来'
          : '还没有哪一段历史被折算成只剩计数'}
      </span>
    </div>
  );
}
