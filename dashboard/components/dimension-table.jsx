import { DIMENSIONS } from '../lib/whitelist.mjs';
import { MIN_INSTALLS } from '../lib/suppress.mjs';
import { VIEW, viewStateOf } from '../lib/state.mjs';
import { Nothing } from './nothing.jsx';

/*
 * 一个维度的细分表。
 *
 * 🔴 **抑制发生在服务端，在数据到达浏览器之前。**
 *    这是 Codex 2026-09-01 挡下的一条：把未抑制的聚合先发给浏览器、
 *    再靠前端隐藏，等于把它公开了 —— 打开 devtools 就能看见。
 *    所以这整个组件（以及 page.jsx）都是 **server component**，
 *    没有一行 `'use client'`，浏览器拿到的 HTML 里只有抑制之后的行。
 *    ⚠️ 加筛选功能时也必须走这条路：URL 参数 → 服务端重新取数 → 重新抑制，
 *    **不许**在客户端对一张完整的表做筛选。
 *
 * 🔴 **表里没有「总计」行，被抑制的那一组也不报事件合计。**
 *    任何精确的合计都是一个减法锚点（suppress.mjs 里有长注释）。
 *
 * 🔴 **不渲染 `result` / `kind` 的嵌套分布。**
 *    父行达标不代表 `artifact × result` 这个交叉子组也达标 ——
 *    `installs=5, results={ failed: 1 }` 会直接披露那一次失败。
 *    viewmodel 里根本没有这两个字段（normalize.mjs 连读都不读）。
 */

export function DimensionTable({ dim, table, totalEvents }) {
  const spec = DIMENSIONS[dim];
  // 🔴 抑制**已经在 lib/publish.mjs 里做过了**，这里只负责渲染。
  //    抑制不能逐表独立地做 —— 只要任何一张表有抑制，顶层标量也得跟着分桶，
  //    而那是一个只有「把所有表一起看」才回答得了的问题。
  const { visible, suppressed } = table ?? { visible: [], suppressed: { rows: 0 } };
  const state = viewStateOf({
    totalEvents,
    available: Boolean(table?.available),
    candidates: table?.candidates ?? 0,
    dropped: table?.dropped ?? 0,
    visible: visible.length,
  });

  if (state !== VIEW.ROWS) {
    return (
      <div className="panel">
        <div className="head">
          <h3>按{spec.label}</h3>
          <span className="label">{spec.field}</span>
        </div>
        <div className="body"><Nothing state={state} /></div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="head">
        <h3>按{spec.label}</h3>
        <span className="label">{spec.field}</span>
        <span className="spacer" />
        <span className="label-cn">{spec.hint}</span>
      </div>
      <div className="body record" style={{ padding: 0 }}>
        <div className="tablescroll" style={{ border: 0, borderRadius: 0 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">{spec.field}</th>
                <th scope="col" className="n">事件数</th>
                <th scope="col" className="n">装机数</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.key}>
                  {/* 🔴 值不做 uppercase：制品坐标与版本号区分大小写，改了就是改数据 */}
                  <td className="v">{r.key}</td>
                  <td className="n">{r.events}</td>
                  <td className="n">{r.installs}</td>
                </tr>
              ))}
              {suppressed.rows > 0 ? (
                <tr className="suppressed">
                  <td className="v">{suppressedLabel(suppressed)}</td>
                  {/* 🔴 不给事件合计：那是最便宜的一个减法锚点 */}
                  <td className="n">—</td>
                  <td className="n">—</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      {suppressed.rows > 0 ? (
        <div className="body" style={{ paddingTop: 'var(--sp-3)' }}>
          <p className="note dim">{suppressedExplainer(suppressed)}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ⚠️ 「样本太少」与「无法核实」**必须分开说**（Codex 2026-09-01 指出）：
 *    把未知说成「太少」是在断言一件我们并不知道的事，
 *    读的人会以为「服务端算过了，就是没人用」。
 */
function suppressedLabel(s) {
  if (s.unverifiable > 0 && s.small === 0 && s.complementary === 0) return `${s.rows} 行 · 无法核实门槛`;
  if (s.unverifiable === 0 && s.complementary === 0) return `${s.rows} 行 · 样本太少`;
  return `${s.rows} 行 · 未发布`;
}

function suppressedExplainer(s) {
  const bits = [];
  if (s.small > 0) bits.push(`${s.small} 行的去重装机数不足 ${MIN_INSTALLS}`);
  if (s.unverifiable > 0) bits.push(`${s.unverifiable} 行服务端没给去重装机数，无法核实门槛（按不达标处理）`);
  if (s.complementary > 0) {
    bits.push(
      `${s.complementary} 行是被「互补抑制」拉进来的 —— `
      + '只抑制一行时，把它单独拎出来减一下就还原了，抑制等于没做；'
      + '所以恰好抑制一行时，会把事件数最小的那个可见行也一并抑制',
    );
  }
  return `未发布的行连行名带数字一起不给，也不报它们的合计（精确合计是一个减法锚点）：${bits.join('；')}。`;
}
