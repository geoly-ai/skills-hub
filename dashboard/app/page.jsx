import { fetchSummary } from '../lib/summary-source.mjs';
import { SOURCE } from '../lib/state.mjs';
import { MIN_INSTALLS } from '../lib/suppress.mjs';
import { publish } from '../lib/publish.mjs';
import { PrivacyNotice } from '../components/privacy.jsx';
import { Nothing } from '../components/nothing.jsx';
import { DimensionTable } from '../components/dimension-table.jsx';
import { Durations } from '../components/durations.jsx';
import { ServerGaps } from '../components/server-gaps.jsx';

/*
 * 主页。
 *
 * 🔴 **这是一个 server component，而且必须是。** 两条理由，都不是风格问题：
 *   ① summary token 只能在服务端读（lib/summary-source.mjs 顶部有长注释）；
 *   ② 小样本抑制必须在数据到达浏览器**之前**完成 —— 先发原始聚合再前端隐藏
 *      等于把它公开了（打开 devtools 就能看见）。
 *
 * 🔴 **页面按 docs/telemetry/00-spec.md §1 的三个问题组织**，不是一堆图表：
 *      01 哪些 skill 真的在被用（决定谁进矩阵包、谁下架）
 *      02 装失败集中在哪（哪个客户端、哪个版本、什么原因）
 *      03 一次安装要多久（性能回归）
 *    段号与问句原样写在区段标题上 —— 一个没有问题意识的看板，
 *    读的人会开始按「哪张图好看」而不是「哪个问题该答」去用它。
 */

// 🔴 绝不静态化、绝不缓存：内部运营数据，每一层缓存都是一次泄漏面，
//    而且缓存住的「0」会在端点真的通了以后继续骗人。
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function Page() {
  const res = await fetchSummary();
  // 🔴 抑制与「顶层标量要不要分桶」在**一个地方**决定（lib/publish.mjs 顶部有长注释）：
  //    只要任何一张表有行被抑制，精确的 total 就是一个减法锚点。
  const d = res.data;
  const view = publish(d);

  return (
    <div className="page">
      <header>
        <p className="label">geoly-ai/skills-hub · telemetry</p>
        <h1>装了多少、用得怎么样、失败在哪</h1>
        <p className="lede">
          这一页只回答三个问题，它们写在 <code className="mono">docs/telemetry/00-spec.md §1</code> 里，
          也是这套埋点存在的全部理由：
          <strong>哪些 skill 真的在被用</strong>（决定谁进矩阵包、谁下架）、
          <strong>装失败集中在哪</strong>、<strong>一次安装要多久</strong>。
          三个问题各占一段，段号就是问题号。
        </p>
      </header>

      <PrivacyNotice />

      {res.source !== SOURCE.OK
        ? <Nothing state={res.source} where={res.url} why={res.why} />
        : <Overview view={view} url={res.url} />}

      <Question
        n="01"
        title="哪些 skill 真的在被用"
        en="what is actually used"
        why="这一段的用途是下架决策：一个半年没人装的 skill 应该从矩阵包里拿掉。
             ⚠️ 反过来不成立 —— 装的人多不代表它更可信，规格 §5.3 明令禁止把埋点用于任何信任判定。"
        source={res}
      >
        <DimensionTable dim="artifact" table={view?.tables.artifact} totalEvents={d?.total} />
        <div className="grid2">
          <DimensionTable dim="kind" table={view?.tables.kind} totalEvents={d?.total} />
          <DimensionTable dim="scope" table={view?.tables.scope} totalEvents={d?.total} />
        </div>
      </Question>

      <Question
        n="02"
        title="装失败集中在哪"
        en="where installs fail"
        why="要能一眼看出「是某个客户端的问题、某个版本的问题，还是某一类原因」。
             reason 是有限代码表（不是自由文本），所以它能被安全地聚合 —— 这一条是规格 §2.2 收紧过两次换来的。"
        source={res}
      >
        <DimensionTable dim="reason" table={view?.tables.reason} totalEvents={d?.total} />
        <div className="grid2">
          <DimensionTable dim="client" table={view?.tables.client} totalEvents={d?.total} />
          <DimensionTable dim="version" table={view?.tables.version} totalEvents={d?.total} />
        </div>
        <div className="grid2">
          <DimensionTable dim="os" table={view?.tables.os} totalEvents={d?.total} />
          <DimensionTable dim="cli" table={view?.tables.cli} totalEvents={d?.total} />
        </div>
      </Question>

      <Question
        n="03"
        title="一次安装要多久"
        en="how long an install takes"
        why="性能回归看的是「同一个动作在新版本上是不是变慢了」，所以按版本分组比看一个全局平均值有用得多。
             ⚠️ 只有 P50 / P95，没有原始耗时列表 —— 一串按时间排开的原始 ms 同样是一条机器轨迹。"
        source={res}
      >
        <Durations durations={view?.durations} totalEvents={d?.total} />
      </Question>

      <ServerGaps data={d} />
    </div>
  );
}

/**
 * 总览：**全局标量**。
 *
 * 🔴 **有任何一张表被抑制时，这里的数字必须分桶发布。**
 *    一个精确的 `total` 配上某张表的可见行，一减就是那张表被抑制组的合计
 *    ——「HTML 里搜不到那个数」不等于「那个数推不出来」（Codex 2026-09-01 把
 *    上一版「已经没有精确锚点了」这句话就是这么证伪的）。
 *    判断在 lib/publish.mjs 里做，因为它要把所有表一起看。
 */
function Overview({ view, url }) {
  const { totalOut, installsOut, anySuppressed, hasRolledUp, total } = view;
  return (
    <section className="section" aria-labelledby="overview-h">
      <div className="sechead">
        <span className="label">00</span>
        <h2 id="overview-h">总数</h2>
        <span className="label">counted, not measured</span>
      </div>

      {total === 0 ? <Nothing state="no-events" where={url} /> : null}

      <div className="facts">
        <div className="fact">
          <span className="k">events</span>
          <span className={totalOut.kind === 'exact' ? 'v' : 'v unknown'}>{totalOut.text}</span>
        </div>
        <div className="fact">
          <span className="k">distinct installs</span>
          <span className={installsOut.kind === 'exact' ? 'v' : 'v unknown'}>{installsOut.text}</span>
        </div>
        <div className="fact">
          {/* 🔴 只给一个布尔，不给那个水位时间戳：它是服务端的 received_at 水位，
              既不在 §2 的采集字段表里，也不回答 §1 的三个问题 —— 属于多余的运行元数据。
              这里要说的只有「有一段历史只剩计数」，那句话不需要精确到毫秒。 */}
          <span className="k">历史折算</span>
          <span className="v unknown">
            {hasRolledUp ? '有一段只剩计数' : '原始事件都还在'}
          </span>
        </div>
      </div>

      <p className="note dim">
        {installsOut.kind === 'unknown' ? (
          <>
            🔴 <strong>顶层</strong>装机数显示「未提供」而不是 0 —— 服务端这一版没返回它。
            <strong>「不知道」不能写成「知道且是 0」。</strong>
            ⚠️ 这只说明<strong>顶层</strong>那个数没给；抑制判的是<strong>每一行自己的</strong>
            装机数，两者是两个字段。行级给了的话，下面的表照样能正常展示。
            两处都没给时，细分表才会整表走「无法核实门槛」——
            因为抑制的判据就是它（用事件数代替会把 1 台机器的 40 条事件读成 40 台）。
          </>
        ) : (
          <>
            装机数低于 {MIN_INSTALLS} 时只显示 <code className="mono">&lt;{MIN_INSTALLS}</code>，
            不显示精确值 ——「全世界只有 2 台机器装过」本身就是信息。
          </>
        )}
        {' '}
        「历史折算」说的是：按规格 §5.3 的 180 天保留期，早于某个水位的原始事件已经被丢弃、
        只剩计数，所以那一段没有细分维度可看。
      </p>

      <p className="note dim">
        🔴 <strong>一条已知的残余风险，写在这里而不是藏起来。</strong>
        下面几段并列发布的是<strong>同一批事件的不同切法</strong>（按制品 / 按客户端 / 按 OS…）。
        配合一点外部知识，理论上可以拿几张表互相相减，把某一张里被抑制的行推出来。
        {anySuppressed ? (
          <>
            {' '}这一次<strong>确实有行被抑制</strong>，所以上面的总数是
            <strong>分桶</strong>发布的（区间，不是精确值），每张表也不发布总计行、
            被抑制的那一组不报事件合计 —— 减法能得到的只是一个区间。
          </>
        ) : (
          <>{' '}这一次没有任何一行被抑制，所以上面的总数是精确值。</>
        )}
        {' '}但<strong>这不是一个硬保证</strong>：行数、枚举里缺席的取值、跨表的行数差
        都还是约束条件。真正闭合要对「整套固定发布的表」做联合抑制，
        而那件事只能在服务端做（列在下面第 99 段）。
      </p>
    </section>
  );
}

/** 一个问题一段。`why` 说清这一段是拿来做什么决策的 —— 没有问题意识的图表不该存在。 */
function Question({ n, title, en, why, source, children }) {
  return (
    <section className="section" aria-labelledby={`q${n}`}>
      <div className="sechead">
        <span className="label">{n}</span>
        <h2 id={`q${n}`}>{title}</h2>
        <span className="label">{en}</span>
      </div>
      <p className="note">{why}</p>
      {source.source !== SOURCE.OK
        ? <Nothing state={source.source} where={source.url} why={source.why} />
        : children}
    </section>
  );
}
