import { MIN_INSTALLS } from '../lib/suppress.mjs';
import { MIN_EVENTS_FOR_QUANTILE } from '../lib/publish.mjs';
import { VIEW, viewStateOf } from '../lib/state.mjs';
import { Nothing } from './nothing.jsx';

/**
 * 耗时分布（§1 的问题 3：一次安装要多久）。
 *
 * 🔴 **只有 P50 / P95，没有原始耗时。** 一串按时间排开的原始 `ms` 与一条
 *    install_id 时间线是同一类东西 —— 它能把「某台机器在某个时刻做了什么」
 *    重新拼出来。分位数是聚合值，拼不出个体。
 *
 * 🔴 **分位数有一条 K=5 之外的、更严的门槛，而且它是「抑制」不是「标注」。**
 *    分位数是**顺序统计量**：样本少的时候 p95 **就等于某一条原始耗时**。
 *    K=5 保护的是「这一组有几台机器」，它**不保护分位数本身**
 *    （Codex 2026-09-01 指出）。初稿只给小样本行标一句「估计不稳」——
 *    **标注不减少披露**，所以改成不发布。门槛与抑制都在 lib/publish.mjs 里做。
 *
 * 🔴 全表被挡住时用**专门的**那句文案（VIEW.SUPPRESSED_QUANTILE）：
 *    通用那句只说得出「装机数不够」，而这里的真实原因可能是
 *    「机器够多、但每台只装过一两次」—— 说错了会把人引去错误的方向。
 */

const ms = (v) => (v === null || v === undefined ? '—' : `${v} ms`);

export function Durations({ durations, totalEvents }) {
  const { visible = [], suppressed = { rows: 0 } } = durations ?? {};
  const state = viewStateOf({
    totalEvents,
    available: Boolean(durations?.available),
    candidates: durations?.candidates ?? 0,
    visible: visible.length,
    quantileGated: Boolean(durations?.quantileGated),
  });

  if (state !== VIEW.ROWS) {
    return (
      <div className="panel">
        <div className="head">
          <h3>安装耗时分位数</h3>
          <span className="label">ms · p50 / p95</span>
        </div>
        <div className="body"><Nothing state={state} /></div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="head">
        <h3>安装耗时分位数</h3>
        <span className="label">ms · p50 / p95</span>
        <span className="spacer" />
        <span className="label-cn">按版本分组看回归</span>
      </div>
      <div className="body record" style={{ padding: 0 }}>
        <div className="tablescroll" style={{ border: 0, borderRadius: 0 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">分组</th>
                <th scope="col">取值</th>
                <th scope="col" className="n">样本事件数</th>
                <th scope="col" className="n">装机数</th>
                <th scope="col" className="n">p50</th>
                <th scope="col" className="n">p95</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((g) => (
                <tr key={`${g.dim}:${g.key}`}>
                  <td>{g.label}</td>
                  <td className="v">{g.key}</td>
                  <td className="n">{g.events}</td>
                  <td className="n">{g.installs}</td>
                  <td className="n">{ms(g.p50)}</td>
                  <td className="n">{ms(g.p95)}</td>
                </tr>
              ))}
              {suppressed.rows > 0 ? (
                <tr className="suppressed">
                  <td colSpan={2} className="v">{suppressed.rows} 行 · 未发布</td>
                  <td className="n">—</td>
                  <td className="n">—</td>
                  <td className="n">—</td>
                  <td className="n">—</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      <div className="body" style={{ paddingTop: 'var(--sp-3)' }}>
        <p className="note dim">
          未发布的行连分位数一起不给。两道门槛：去重装机数至少 {MIN_INSTALLS}（隐私），
          样本事件数至少 {MIN_EVENTS_FOR_QUANTILE}（分位数是顺序统计量 ——
          样本少时 <strong>p95 就等于某一条原始耗时</strong>，那等于把一条原始记录印出来）。
          🔴 <strong>哪一行卡在哪一道门槛不公开</strong>：逐行成因本身也是信息。
        </p>
      </div>
    </div>
  );
}
