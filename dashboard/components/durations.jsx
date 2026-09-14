import { MIN_INSTALLS } from '../lib/suppress.mjs';
import { MIN_EVENTS_FOR_QUANTILE } from '../lib/publish.mjs';
import { VIEW, viewStateOf } from '../lib/state.mjs';
import { Icon } from './icons.jsx';
import { Nothing } from './nothing.jsx';
import { HEAD_WORD, PanelHead, WithheldRow } from './dimension-table.jsx';

/**
 * 耗时分位数（§1 的问题 3：一次安装要多久）。DESIGN.md §10.6 / §11.2。
 *
 * 🔴 **只有 P50 / P95，没有原始耗时。** 一串按时间排开的原始 `ms` 同样是一条机器轨迹。
 * 🔴 **分位数另有一道门槛，而且它是「抑制」不是「标注」**（lib/publish.mjs）：
 *    样本少时 p95 就等于某一条原始耗时。
 * 🔴 耗时表的两种「缺」**不许混**：
 *    · 行被挡住 → 琥珀斜纹横条「未发布」（我们知道，但不能给）
 *    · 服务端没给 p50/p95 → 冷灰虚线「未提供」（我们不知道）—— 绝不画成斜纹，也不画成 —
 * 🔴 全表被挡住用专门那句文案（SUPPRESSED_QUANTILE）：原因可能是「机器够多、每台只装过一两次」。
 */

function Unknown() {
  return (
    <span className="unk"><Icon name="m-unknown" size={12} /><span className="t">未提供</span></span>
  );
}

export function Durations({ durations, totalEvents }) {
  const { visible = [], suppressed = { rows: 0 } } = durations ?? {};
  const state = viewStateOf({
    totalEvents,
    available: Boolean(durations?.available),
    candidates: durations?.candidates ?? 0,
    visible: visible.length,
    quantileGated: Boolean(durations?.quantileGated),
  });
  const head = { icon: 'n-latency', title: '安装耗时分位数', code: 'ms · p50 / p95' };

  if (state !== VIEW.ROWS) {
    return (
      <div className="panel">
        {/* 🔴 与维度表共用状态词表：NO_ROWS 是「一行都没有」，不是「未发布」（§10.1） */}
        <PanelHead {...head} right={HEAD_WORD[state]} />
        <div className="body"><Nothing state={state} id="nt-durations" /></div>
        {state === VIEW.SUPPRESSED_QUANTILE || state === VIEW.SUPPRESSED ? <QuantileDrawer /> : null}
      </div>
    );
  }

  // 区间条按「本表可见行最大的 p95」归一，只在本表内比较
  const scale = Math.max(0, ...visible.map((g) => g.p95 ?? 0));

  return (
    <div className="panel">
      <PanelHead {...head} right={`${visible.length} 行可见`} />
      <div className="body table">
        <div className="tablewrap">
          <table className="wide">
            <thead>
              <tr>
                <th scope="col">group</th>
                <th scope="col">value</th>
                <th scope="col" className="n">events</th>
                <th scope="col" className="n">installs</th>
                <th scope="col" className="n">p50</th>
                <th scope="col" className="n">p95</th>
                <th scope="col">p50 → p95</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((g) => (
                <tr key={`${g.dim}:${g.key}`}>
                  <td>{g.label}</td>
                  <td className="v">{g.key}</td>
                  <td className="n">{g.events}</td>
                  <td className="n">{g.installs}</td>
                  <td className="n">{g.p50 === null ? <Unknown /> : g.p50}</td>
                  <td className="n">{g.p95 === null ? <Unknown /> : g.p95}</td>
                  <td className="dumbcell">
                    {/* 🔴 任一端缺失不画轨；端点旁不重复写数字（§11.2） */}
                    {g.p50 === null || g.p95 === null || !(scale > 0) ? (
                      g.p50 === null || g.p95 === null ? <Unknown /> : null
                    ) : (
                      <Dumbbell a={(g.p50 / scale) * 100} b={(g.p95 / scale) * 100} />
                    )}
                  </td>
                </tr>
              ))}
              {suppressed.rows > 0 ? <WithheldRow cols={7} /> : null}
            </tbody>
          </table>
        </div>
      </div>
      <div className="body notes">
        {suppressed.rows > 0 ? (
          // 🔴 **不按成因分句**：分位数门槛是把 installs 抹成 null 实现的，
          //    按成因说会把它说成「服务端没给台数」—— 一句假话。也不逐行说卡在哪一道。
          <p className="cap">
            {suppressed.rows} 行没发出来 · 哪一行卡在哪一道门槛不写出来：逐行的原因本身也是信息。
          </p>
        ) : null}
        <p className="cap">区间条按本表可见行最大的 p95 归一，只在本表内相互比较；数字单位是毫秒。</p>
      </div>
      <QuantileDrawer />
    </div>
  );
}

function Dumbbell({ a, b }) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return (
    <span className="dumb">
      <i className="track" />
      {hi - lo > 0 ? <i className="seg" style={{ '--a': `${lo}%`, '--b': `${hi}%` }} /> : null}
      <i className="p50" style={{ '--a': `${a}%` }} />
      <i className="p95" style={{ '--b': `${b}%` }} />
    </span>
  );
}

function QuantileDrawer() {
  return (
    <details className="foot">
      <summary><Icon name="u-chevron" />为什么这张表比别的表多一道门槛</summary>
      <div className="inner">
        <p>
          分位数是从样本里挑出来的一个数：样本一少，p95 <strong>正好就等于某一条真实耗时</strong>，
          发布它等于把那一条原始记录印出来。「至少 {MIN_INSTALLS} 台机器」管的是人数，
          <strong>管不住这件事</strong>。所以这里另加一道：样本至少 {MIN_EVENTS_FOR_QUANTILE} 条。
        </p>
        <p>
          {MIN_EVENTS_FOR_QUANTILE} 不是什么证明过的安全线，只是「p95 不再等于最大那一条」的一个保守起点。
          要真正稳妥，得让服务端在算的时候就取整或分桶（比如按 50ms 向上取整）。
        </p>
      </div>
    </details>
  );
}
