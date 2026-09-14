import { DIMENSIONS } from '../lib/whitelist.mjs';
import { MIN_EVENTS_FOR_QUANTILE } from '../lib/publish.mjs';
import { Icon } from './icons.jsx';
import { Notice } from './nothing.jsx';
import { Section } from './section.jsx';
import { PanelHead } from './dimension-table.jsx';

/**
 * 第 99 段「服务端待补的聚合」（DESIGN.md §9.5）。
 *
 * 🔴 **这一段存在的理由**：dashboard 不许自己写第二份聚合（会与 `server/aggregate.mjs` 分叉，
 *    而分叉不会让任何东西变红）。缺维度时正确的动作是**把缺口列出来**，
 *    而这张清单是**从实际返回里对出来的** —— 服务端补上一项，这里就少一行。
 * 🔴 上游不可用时**不许**端出「所有维度都待补」：那是一句我们并不知道的话。
 *    改用故障族告示条，说清「既不是没有缺口，也不是全都缺」。
 */

const SHAPE = '{ "<取值>": { "n": <事件数>, "installs": <去重装机数> } }';
const DECK = '这里不写第二份聚合：写了就会和 server/aggregate.mjs 慢慢对不上，而对不上不会让任何东西报错。'
  + '缺什么就列什么 —— 这张清单是拿实际返回对出来的，服务端补一项，这里就少一行。';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function ServerGaps({ data }) {
  if (!data) {
    return (
      <Section id="s99" num="99" title="服务端待补的聚合" en="server-side work">
        <Notice look="n-fault" icon="s-unreachable" id="nt-gaps" title="这张清单算不出来。">
          <p>
            这张清单要拿<strong>实际返回</strong>来对。这次没拿到返回（原因见最上面那条），就给不出清单 ——
            <strong>既不是「没有缺口」，也不是「全都缺」</strong>。
          </p>
          <p className="next">先把上面那一环修好，这张清单会自己出现。</p>
        </Notice>
      </Section>
    );
  }

  const items = [];
  if (!Number.isInteger(data.installs)) {
    items.push({ k: 'installs', v: '{ "installs": <去重 install_id 数> } —— 最要紧的一项：小样本抑制的判据就是它' });
  }
  for (const d of Object.keys(DIMENSIONS)) {
    if (!data.dimensions[d]?.available) {
      items.push({ k: `by${cap(d)}`, v: `${SHAPE} · ${DIMENSIONS[d].label}` });
    }
  }
  if (!data.durations?.available) {
    items.push({ k: 'durations', v: '[{ "version": "…", "n": …, "installs": …, "p50": …, "p95": … }]' });
  }

  return (
    <Section id="s99" num="99" title="服务端待补的聚合" en="server-side work" deck={DECK}>
      <div className="panel">
        <PanelHead icon="n-gaps" title="缺口清单" code="/v1/summary" right={`${items.length} 项`} />
        {items.length > 0 ? (
          <div className="body table">
            <div className="tablewrap">
              <table>
                <thead><tr><th scope="col">key</th><th scope="col">expected shape</th></tr></thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.k}><td className="v">{it.k}</td><td className="v">{it.v}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="body"><p>没有缺口：服务端已经返回了全部需要的维度。</p></div>
        )}
        <div className="body notes">
          <p className="cap">
            键名必须是 <code className="mono">installs</code>，也就是一个计数。任何长得像
            <code className="mono"> install_id</code> / <code className="mono">installIds</code> /
            <code className="mono"> byInstallId</code> 的键都会被剥掉，到不了页面。
          </p>
        </div>
        <details className="foot">
          <summary><Icon name="u-chevron" />给服务端实现者的五条硬约束</summary>
          <div className="inner">
            <p>
              <strong>一、去重数的键名必须叫 installs，是一个计数。</strong>
              「我们只要数、不要 ID」这件事由键名本身兑现，比靠谁记得强。
            </p>
            <p>
              <strong>二、每一个细分行都要带自己的 installs。</strong>
              抑制判的是「这一行背后有几台机器」，只给顶层一个总数没用。
            </p>
            <p>
              <strong>三、分位数在服务端算，不要把原始 ms 列表发过来。</strong>
              样本少时 p95 就等于某一条原始耗时；这里加了「样本至少 {MIN_EVENTS_FOR_QUANTILE} 条」的门槛，
              但真要给硬保证，服务端该在算的时候就取整或分桶。
            </p>
            <p>
              <strong>四、交叉子组（artifact × result 这类）每一格都要自己带 installs，否则不要发。</strong>
              父行达标不代表子组达标；这里现在连读都不读嵌套分布。
            </p>
            <p>
              <strong>五、【尚未解决】联合抑制。</strong>
              首页并列发布同一批事件的多种切法，理论上能跨表相减。这里只能去掉精确的减法锚点，
              硬保证要对整套表做联合抑制，只能在服务端做。
            </p>
          </div>
        </details>
      </div>
    </Section>
  );
}
