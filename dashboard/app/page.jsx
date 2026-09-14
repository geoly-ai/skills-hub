import { fetchSummary } from '../lib/summary-source.mjs';
import { SOURCE } from '../lib/state.mjs';
import { publish } from '../lib/publish.mjs';
import { Shell } from '../components/shell.jsx';
import { Section } from '../components/section.jsx';
import { Nothing } from '../components/nothing.jsx';
import { MeasureKpi, SourceNoteKpi } from '../components/kpi.jsx';
import { DimensionTable } from '../components/dimension-table.jsx';
import { Durations } from '../components/durations.jsx';
import { ServerGaps } from '../components/server-gaps.jsx';

/*
 * 总览页（值班台）。
 *
 * 🔴 **这是一个 server component，而且必须是。**
 *   ① summary token 只能在服务端读（lib/summary-source.mjs）；
 *   ② 小样本抑制必须在数据到达浏览器**之前**完成 —— 先发原始聚合再前端隐藏等于公开。
 *
 * 🔴 **三层版面，顺序即优先级**（DESIGN.md §3）：状态层（Shell 的徽章 + 契约条）→
 *    数字层（KPI、面板）→ 脚注层（deck、抽屉、口径与边界页）。
 *
 * 🔴 **页面按 docs/telemetry/00-spec.md §1 的三个问题组织**，段号就是问题号：
 *      01 哪些 skill 真的在被用 · 02 装失败集中在哪 · 03 一次安装要多久
 *
 * 🔴 **SOURCE 非 ok 时主区只有告示条**（§9.3）：KPI 与面板一并**不渲染**（不是渲染成 0）。
 *    判定顺序从外到内，版面顺序与它一致：数据源的告示条在主区第一块，
 *    维度级的在各自面板里，行级的在表格里（§9.4）。
 */

// 🔴 绝不静态化、绝不缓存：内部运营数据，每一层缓存都是一次泄漏面，
//    而且缓存住的「0」会在端点真的通了以后继续骗人。
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function Page() {
  // 🔴 「本次读取」= 我们发这次请求的时刻（本机时钟），不来自任何事件、不从 `at` 派生
  const readAt = new Date();
  const res = await fetchSummary();
  const ok = res.source === SOURCE.OK;

  return (
    <Shell title="总览" current="overview" path="/" source={res.source} readAt={readAt}>
      {ok ? <Overview data={res.data} /> : (
        <>
          <Nothing
            state={res.source} id="nt-source" wide level={2}
            // `url` 已经是 maskUrl() 过的；原因码没有时退回 HTTP 状态码（401/404/500…）
            where={res.url} why={res.why ?? (res.status ? String(res.status) : null)}
          />
          <ServerGaps data={null} />
        </>
      )}
    </Shell>
  );
}

function Overview({ data }) {
  // 🔴 抑制与「顶层标量要不要分桶」在**一个地方**决定（lib/publish.mjs）：
  //    只要任何一张表有行被抑制，精确的 total 就是一个减法锚点。
  //    下面只渲染 totalOut / installsOut，**不渲染 data.total 原值**。
  const view = publish(data);
  const t = data.total;

  return (
    <>
      <Section
        id="s00" num="00" title="总数" en="counted, not measured"
        deck="全站合计，不分维度。只要下面有哪张表的行没发布出来，这里就只给区间 —— 一个精确的总数减掉那张表看得见的行，剩下的就是没发布的那一组。"
      >
        <div className="kpirow">
          <MeasureKpi label="events" out={view.totalOut} />
          <MeasureKpi label="distinct installs" out={view.installsOut} />
          <SourceNoteKpi hasRolledUp={view.hasRolledUp} />
        </div>
      </Section>
      {view.total === 0 ? <Nothing state="no-events" id="nt-no-events" /> : null}

      <Section
        id="s01" num="01" title="哪些 skill 真的在被用" en="what is actually used"
        deck="这一段是用来决定下架的：一个半年没人装的 skill 该从矩阵包里拿掉。反过来不成立 —— 装的人多，不等于它更可信。"
      >
        <DimensionTable dim="artifact" icon="n-usage" bars table={view.tables.artifact} totalEvents={t} />
        <div className="grid2">
          <DimensionTable dim="kind" icon="n-usage" table={view.tables.kind} totalEvents={t} />
          <DimensionTable dim="scope" icon="n-usage" table={view.tables.scope} totalEvents={t} />
        </div>
      </Section>

      <Section
        id="s02" num="02" title="装失败集中在哪" en="where installs fail"
        deck="一眼看出是某个客户端的问题、某个版本的问题，还是某一类原因。reason 是一小组固定代码，不是自由填写的文本，所以聚合它不会带出别的东西。"
      >
        <DimensionTable dim="reason" icon="n-failures" bars table={view.tables.reason} totalEvents={t} />
        <div className="grid2">
          <DimensionTable dim="client" icon="n-failures" table={view.tables.client} totalEvents={t} />
          <DimensionTable dim="version" icon="n-failures" table={view.tables.version} totalEvents={t} />
        </div>
        <div className="grid2">
          <DimensionTable dim="os" icon="n-failures" table={view.tables.os} totalEvents={t} />
          <DimensionTable dim="cli" icon="n-failures" table={view.tables.cli} totalEvents={t} />
        </div>
      </Section>

      <Section
        id="s03" num="03" title="一次安装要多久" en="how long an install takes"
        deck="你要看的是同一个动作在新版本上有没有变慢，所以按版本分开比一个总平均有用。只给 P50 / P95，不给原始耗时 —— 一串按时间排开的毫秒数，本身就是一台机器的轨迹。"
      >
        <Durations durations={view.durations} totalEvents={t} />
      </Section>

      <ServerGaps data={data} />
    </>
  );
}
