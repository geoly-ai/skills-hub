import { DIMENSIONS } from '../lib/whitelist.mjs';

/**
 * 「服务端待补的聚合」。
 *
 * 🔴 **这一节存在的理由**：dashboard 不许自己写第二份聚合
 *    （会与 `server/aggregate.mjs` 分叉，而分叉不会让任何东西变红，
 *    只会让人某天发现两张表对不上、不知道该信哪张）。
 *    所以缺维度时正确的动作不是「在前端补算」，而是**把缺口列出来**，
 *    让它成为服务端的一条待办。这一节就是那张清单，而且它是**从数据里长出来的**
 *    ——服务端补上哪一项，这里就少一行，不需要有人记得回来改文案。
 */

/** 服务端返回的键名契约。⚠️ 名字必须是**计数**（`installs`），不能是 id 列表。 */
const SHAPE = '{ "<取值>": { "n": <事件数>, "installs": <去重装机数> } }';

export function ServerGaps({ data }) {
  // 🔴 上游不可用时**不许**把「所有维度都待补」端出来 —— 那是一句我们并不知道的话
  //    （Codex 2026-09-01 指出：那会把一次故障说成一份服务端待办清单）。
  //    清单是从**实际返回**里算出来的，没有返回就没有清单。
  if (!data) {
    return (
      <section className="section" aria-labelledby="gaps-h">
        <div className="sechead">
          <span className="label">99</span>
          <h2 id="gaps-h">服务端待补的聚合</h2>
          <span className="label">server-side work</span>
        </div>
        <div className="nothing n-source">
          <h3>算不出这张清单。</h3>
          <p>
            缺口清单是拿<strong>实际返回</strong>和 dashboard 需要的维度对出来的。
            这一次没拿到返回（原因见上面那条），所以这里没有清单可给 ——
            <strong>不是「没有缺口」，也不是「全都缺」</strong>。
          </p>
          <p className="next">先把上面那一环修好，这张清单会自己出现。</p>
        </div>
      </section>
    );
  }

  const missing = Object.keys(DIMENSIONS).filter((d) => !data.dimensions[d]?.available);
  const needInstalls = !Number.isInteger(data.installs);
  const needDurations = !data.durations?.available;

  return (
    <section className="section" aria-labelledby="gaps-h">
      <div className="sechead">
        <span className="label">99</span>
        <h2 id="gaps-h">服务端待补的聚合</h2>
        <span className="label">server-side work</span>
      </div>
      <p className="note">
        下面这些是 dashboard 需要、但 <code className="mono">/v1/summary</code> 这一版还没返回的。
        它们要加在 <code className="mono">server/aggregate.mjs</code>，<strong>不在这里补算</strong>。
        清单是按实际返回算出来的：服务端补上一项，这里就少一行。
      </p>

      <div className="panel">
        <div className="head"><h3>缺口清单</h3></div>
        <div className="body record">
          <dl className="ledger">
            {needInstalls ? (
              <>
                <dt>顶层 distinct installs</dt>
                <dd>
                  {'{ "installs": <去重 install_id 数> }'} —— 🔴 最要紧的一项：
                  小样本抑制的判据就是它，没有它所有细分表整表不可见
                </dd>
              </>
            ) : null}
            {missing.map((d) => (
              <Row key={d} k={`by${cap(d)}`} v={`${DIMENSIONS[d].label}（字段 ${DIMENSIONS[d].field}）· ${SHAPE}`} />
            ))}
            {needDurations ? (
              <Row
                k="durations"
                v={'[{ "version": "<制品版本>", "n": <样本数>, "installs": <去重装机数>, "p50": <ms>, "p95": <ms> }]'}
              />
            ) : null}
            {missing.length === 0 && !needInstalls && !needDurations ? (
              <Row k="—" v="没有缺口：服务端已经返回了全部需要的维度" />
            ) : null}
          </dl>
        </div>
      </div>

      <div className="panel">
        <div className="head"><h3>给服务端实现者的五条硬约束</h3></div>
        <div className="body">
          <p className="note">
            <strong>① 去重数的键名必须叫 <code className="mono">installs</code>，是一个计数。</strong>
            任何 <code className="mono">install_id</code> / <code className="mono">installIds</code> /
            <code className="mono"> byInstallId</code> 形态的键都会被 dashboard 在归一化时
            <strong>递归剥掉</strong>，到不了页面。这不是挑剔命名 ——
            「我们只要数、不要 ID」这件事由键名本身兑现，比靠谁记得强。
          </p>
          <p className="note">
            <strong>② 每一个细分行都要带自己的 <code className="mono">installs</code>。</strong>
            只给顶层一个总数没用：抑制的判据是「<em>这一行</em>背后有几台机器」，
            用事件数代替会把 1 台机器的 40 条事件读成 40 台。
          </p>
          <p className="note">
            <strong>③ 分位数在服务端算，不要把原始 <code className="mono">ms</code> 列表发过来。</strong>
            一串按时间排开的原始耗时与一条 install_id 时间线是同一类东西。
            ⚠️ 而且分位数是<strong>顺序统计量</strong>：样本少时 p95 就等于某一条原始耗时。
            dashboard 这一侧加了一道「样本事件数 ≥ 20 才发布」的门槛，但那只是保守起点 ——
            真要给硬保证，服务端该在算的时候就<strong>取整或分桶</strong>（比如按 50ms 向上取整）。
          </p>

          <p className="note">
            <strong>④ 交叉子组（<code className="mono">artifact × result</code> 这类）每一格都要自己带
            <code className="mono"> installs</code>，否则不要发。</strong>
            父行达标不代表子组达标：<code className="mono">installs=5, results={'{ failed: 1 }'}</code>
            会直接披露那一次失败，而它背后可能只有 1 台机器。
            dashboard 现在<strong>连读都不读</strong>嵌套分布 —— 读进来就迟早会有人渲染它。
          </p>

          <p className="note">
            <strong>⑤ 【尚未解决】联合抑制。</strong>
            首页并列发布同一批事件的多种切法，理论上能跨表相减把被抑制的行推出来。
            dashboard 这一侧只能做到「有抑制时把顶层标量分桶发布、不发布表内总计、不报被抑制组的合计」，
            <strong>去掉精确的减法锚点，但给不了硬保证</strong> ——
            那要对「整套固定发布的表」做联合抑制/可解性校验，只能在服务端做。
            这是一条<strong>已知的残余风险</strong>，不是遗漏。
          </p>
        </div>
      </div>
    </section>
  );
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function Row({ k, v }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
