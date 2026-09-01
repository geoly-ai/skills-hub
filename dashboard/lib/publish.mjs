/*
 * 发布层 —— **在一个地方**决定「这一次到底把哪些数字放出去」。
 *
 * 🔴 为什么要有这一层，而不是让每个组件各自调 `suppressRows()`：
 *    抑制的强度**不是逐表独立**的。首页并列发布的是同一批事件的不同切法，
 *    只要**任何一张**表有行被抑制，顶层那些精确标量就变成了减法锚点：
 *
 *        被抑制组的事件数 = total − 该表所有可见行之和
 *
 *    Codex 2026-09-01 拿这条直接把上一版的「已经没有精确锚点了」证伪了：
 *    页面上还挂着一个精确的 `total=137`，而 artifact 表可见行只有 `pr-draft=90`，
 *    一减就是 47。**「HTML 里搜不到 47」不等于「47 推不出来」。**
 *
 *    所以顶层标量要不要精确发布，取决于**全局**有没有抑制 —— 那是一个
 *    只有「把所有表一起看」才能回答的问题，于是有了这一层。
 *
 * ⚠️ **这仍然不是硬保证。** 分桶只是把减法的结果从一个数变成一个区间；
 *    行数、枚举里缺席的取值、跨表的行数差都还是约束条件。
 *    真正闭合要对「整套固定发布的表」做联合抑制 / 可解性校验，
 *    那必须在服务端做（列在页面第 99 段）。这里做的是**止血**，写在明处。
 */
import { DIMENSIONS } from './whitelist.mjs';
import { MIN_INSTALLS, suppressRows } from './suppress.mjs';

/**
 * 分位数门槛。**分位数是顺序统计量**：样本少时 p95 就等于某一条原始耗时，
 * 等于把一条原始记录印出来。K=5 保护的是「这一组有几台机器」，不保护分位数本身。
 * ⚠️ 20 不是被证明过的隐私边界，只是「p95 不再等于最大那一条」的保守起点。
 *    硬保证要服务端在算的时候就取整/分桶。
 */
export const MIN_EVENTS_FOR_QUANTILE = 20;

/**
 * 计数分桶。有抑制时顶层标量走它，把精确减法降级成区间减法。
 * 桶按数量级走 —— 对「趋势信号」（规格 T-13）足够，对减法足够钝。
 */
const BUCKETS = [0, 1, 10, 50, 100, 500, 1000, 5000, 10_000, 50_000, 100_000];

export function bucketCount(n) {
  if (!Number.isInteger(n) || n < 0) return { kind: 'unknown', text: '未提供' };
  if (n === 0) return { kind: 'exact', text: '0' };
  for (let i = BUCKETS.length - 1; i >= 0; i--) {
    if (n >= BUCKETS[i]) {
      const hi = BUCKETS[i + 1];
      return { kind: 'bucketed', text: hi ? `${BUCKETS[i]}–${hi - 1}` : `≥${BUCKETS[i]}` };
    }
  }
  return { kind: 'unknown', text: '未提供' };
}

/** durations 的行要先过事件数门槛，再走与小样本抑制**同一条**路径。 */
function gateQuantiles(groups) {
  // 做法是把不达标行的 installs 抹成 null。为什么不另起一套抑制：
  // 两套并行会有先后顺序问题，而**互补抑制必须看见全部被抑制的行**才算得对。
  return groups.map((g) => (g.events >= MIN_EVENTS_FOR_QUANTILE ? g : {
    dim: g.dim, key: g.key, label: g.label, events: g.events, installs: null, p50: g.p50, p95: g.p95,
  }));
}

/**
 * 把 viewmodel 变成「可以直接渲染的东西」。
 * @param {object|null} data normalizeSummary() 的结果，或 null（上游不可用）
 */
export function publish(data) {
  if (!data) return null;

  const tables = Object.create(null);
  let anySuppressed = false;
  for (const dim of Object.keys(DIMENSIONS)) {
    const block = data.dimensions[dim];
    const r = suppressRows(block?.rows ?? []);
    tables[dim] = {
      available: Boolean(block?.available),
      candidates: block?.rows?.length ?? 0,
      // 🔴 「解析时丢了几行」要一路传到文案层：丢完剩 0 行 ≠ 服务端本来就是 0 行
      dropped: block?.dropped ?? 0,
      visible: r.visible,
      suppressed: r.suppressed,
    };
    if (r.suppressed.rows > 0) anySuppressed = true;
  }

  const allGroups = data.durations?.groups ?? [];
  const dq = suppressRows(gateQuantiles(allGroups));
  const durations = {
    available: Boolean(data.durations?.available),
    candidates: allGroups.length,
    visible: dq.visible,
    suppressed: dq.suppressed,
    /**
     * 🔴 这一格是给状态层用的：全被挡住时，文案必须能说出**分位数门槛**这条原因，
     *    否则页面会说「装机数长上去就会出现」——而实际原因可能是样本事件数不够
     *    （Codex 2026-09-01 指出，上一版就是这么错的）。
     *    ⚠️ 只给一个「这张表里有行卡在分位数门槛上」的布尔，
     *    **不逐行公开成因**：哪一行卡在哪道门槛本身也是信息。
     */
    quantileGated: allGroups.some((g) => g.events < MIN_EVENTS_FOR_QUANTILE),
  };
  if (dq.suppressed.rows > 0) anySuppressed = true;

  return {
    total: data.total,
    installs: data.installs,
    hasRolledUp: data.hasRolledUp,
    tables,
    durations,
    /** 🔴 有任何一张表被抑制 → 顶层标量必须分桶发布，见本文件顶部。 */
    anySuppressed,
    /** 顶层标量的最终发布形态。 */
    totalOut: anySuppressed ? bucketCount(data.total) : { kind: 'exact', text: String(data.total) },
    installsOut: anySuppressed ? bucketCount(data.installs) : exactOrFloored(data.installs),
  };
}

/**
 * 没有抑制时的装机数：`< K` 仍然压成 `<K`
 * （「全世界只有 2 台机器装过」本身就是信息），缺失是「未提供」而不是 0。
 */
function exactOrFloored(v) {
  if (!Number.isInteger(v) || v < 0) return { kind: 'unknown', text: '未提供' };
  if (v < MIN_INSTALLS) return { kind: 'floored', text: `<${MIN_INSTALLS}` };
  return { kind: 'exact', text: String(v) };
}
