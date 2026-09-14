import { DIMENSIONS } from '../lib/whitelist.mjs';
import { MIN_INSTALLS } from '../lib/suppress.mjs';
import { VIEW, viewStateOf } from '../lib/state.mjs';
import { Icon } from './icons.jsx';
import { Nothing } from './nothing.jsx';

/*
 * 一个维度的细分表（DESIGN.md §8.5 / §8.6 / §10 / §11.1）。
 *
 * 🔴 **抑制发生在服务端，在数据到达浏览器之前**（lib/publish.mjs）。这个组件与 page.jsx
 *    都是 server component，浏览器拿到的 HTML 里只有抑制之后的行。
 *    ⚠️ 加筛选时也必须走「URL 参数 → 服务端重新取数 → 重新抑制」，不许前端筛一张完整的表。
 * 🔴 **没有总计行、没有百分比列、没有「展开更多」**；被抑制那一组也**不报事件合计**。
 * 🔴 **不渲染 `result` / `kind` 的嵌套分布**：viewmodel 里根本没有（normalize.mjs 连读都不读）。
 * 🔴 **抑制行是一整行 colspan 横条**：琥珀 + 斜纹 + 真实文本「未发布」三通道，
 *    横条上**没有数字、没有破折号、没有空白格**（§10.2）。
 */

/** 面板头右侧：只报「可见行数」或一个状态词，不报候选行数、不报总计（§8.5）。 */
const HEAD_WORD = {
  [VIEW.NO_EVENTS]: '零事件',
  [VIEW.NO_ROWS]: '一行都没有',
  [VIEW.DIMENSION_MISSING]: '服务端未算',
  [VIEW.UNRECOGNIZED_ROWS]: '一行都不认得',
  [VIEW.FILTERED_EMPTY]: '筛没了',
  [VIEW.SUPPRESSED]: '整表未发布',
  [VIEW.SUPPRESSED_QUANTILE]: '整表未发布',
};

export function PanelHead({ icon, title, code, right }) {
  return (
    <div className="head">
      <Icon name={icon} />
      <h3>{title}</h3>
      <span className="fieldcode">{code}</span>
      <span className="spacer" />
      <span className="rows">{right}</span>
    </div>
  );
}

/**
 * @param {{ dim: string, table: object|undefined, totalEvents: number, icon: string, bars?: boolean }} props
 * `bars`：整宽面板开条形列；grid2 半宽面板不开（窄了条形读不出东西）。
 */
export function DimensionTable({ dim, table, totalEvents, icon, bars = false }) {
  const spec = DIMENSIONS[dim];
  const { visible, suppressed } = table ?? { visible: [], suppressed: { rows: 0 } };
  const state = viewStateOf({
    totalEvents,
    available: Boolean(table?.available),
    candidates: table?.candidates ?? 0,
    dropped: table?.dropped ?? 0,
    visible: visible.length,
  });
  const title = `按${spec.label}`;

  if (state !== VIEW.ROWS) {
    return (
      <div className="panel">
        <PanelHead icon={icon} title={title} code={spec.field} right={HEAD_WORD[state]} />
        <div className="body"><Nothing state={state} id={`nt-${dim}`} /></div>
      </div>
    );
  }

  // 🔴 条长按「本表可见行的最大事件数」归一，不按总数：有抑制时总数是分桶发布的，
  //    按精确总数画条等于把刚分桶掉的那个精确值又漏回去（§11.1）。
  const max = Math.max(...visible.map((r) => r.events));
  const cols = bars ? 4 : 3;

  return (
    <div className="panel">
      <PanelHead icon={icon} title={title} code={spec.field} right={`${visible.length} 行可见`} />
      <div className="body table">
        <div className="tablewrap">
          <table className={bars ? undefined : 'compact'}>
            <thead>
              <tr>
                <th scope="col">{spec.field}</th>
                <th scope="col" className="n">events</th>
                <th scope="col" className="n">installs</th>
                {bars ? <th scope="col">events (relative)</th> : null}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.key}>
                  <td className="v">{r.key}</td>
                  <td className="n">{r.events}</td>
                  <td className="n">{r.installs}</td>
                  {bars ? (
                    <td className="barcell">
                      {/* 一个真实的 0 不画条：0 长的条读起来像一个被抹掉的值 */}
                      {r.events > 0 && max > 0 ? (
                        <span className="bar" style={{ '--w': `${(r.events / max) * 100}%` }}><i /></span>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
              {suppressed.rows > 0 ? <WithheldRow cols={cols} /> : null}
            </tbody>
          </table>
        </div>
      </div>
      {suppressed.rows > 0 || bars ? (
        <div className="body notes">
          {suppressed.rows > 0 ? <p className="cap">{suppressedCaption(suppressed)}</p> : null}
          {bars ? (
            <p className="cap">条长表示事件数，按本表可见行的最大值归一；它不表示占比，也不表示总量。</p>
          ) : null}
        </div>
      ) : null}
      {suppressed.rows > 0 ? <WhyDrawer /> : null}
    </div>
  );
}

/** 🔴 抑制横条：与 durations 共用。格子里一个数字都没有（§10.2 / §10.3）。 */
export function WithheldRow({ cols }) {
  return (
    <tr className="withheld-row">
      <td colSpan={cols}>
        <span className="withheld"><Icon name="s-withheld" />未发布</span>
        <span className="wr-note">这些行有数，只是显示不出来</span>
      </td>
    </tr>
  );
}

/**
 * 行数与成因放在**表格外**的 caption（§10.4），不在任何斜纹格里。
 * 🔴 「机器太少」与「不知道有几台」必须是两句话：把未知说成「太少」是在断言一件我们并不知道的事。
 * 🔴 只报每种成因各几行，不逐行说哪一行卡在哪一道门槛。
 */
function suppressedCaption(s) {
  const bits = [];
  if (s.small > 0) bits.push(`${s.small} 行装的机器不到 ${MIN_INSTALLS} 台`);
  if (s.unverifiable > 0) bits.push(`${s.unverifiable} 行服务端没告诉我们有几台机器（不知道就按不够处理）`);
  if (s.complementary > 0) bits.push(`${s.complementary} 行是为了不让人倒推而一起收掉的 —— 只藏一行，减一下就算回来了`);
  return `${s.rows} 行没发出来 · 其中 ${bits.join('，')}。它们一共有多少条事件不报，也不逐行说是卡在哪一条。`;
}

/** 抽屉：每一条都回答「为什么这个格子是这样」，不是装饰性长文（§3.3）。 */
function WhyDrawer() {
  return (
    <details className="foot">
      <summary><Icon name="u-chevron" />为什么这样算</summary>
      <div className="inner">
        <p>
          看的是<strong>装了它的机器有几台</strong>，不是事件有几条 ——
          一台机器一天就能产生几十条事件，按事件数算等于把 1 台当成 40 台。不到 {MIN_INSTALLS} 台就不发布。
        </p>
        <p>
          <strong>「机器太少」和「不知道有几台」是两回事，不能写成一句。</strong>
          前者是服务端给了台数、确实不够；后者是服务端压根没给台数，我们按不够处理。
          把后者说成「太少」，等于替它下了一个我们并没有的结论。
        </p>
        <p>
          <strong>只藏一行是白藏的</strong>：总数减掉其他行，就把它算回来了。
          所以这时会把事件数最小的那一行也一起收掉 —— 剩下的只是两行的和，拆不开。
        </p>
        <p>
          <strong>为什么没有总计行</strong>：有了精确的合计，就有了做减法的起点。
          首页这几张表切的是同一批事件，能互相减。
        </p>
      </div>
    </details>
  );
}
