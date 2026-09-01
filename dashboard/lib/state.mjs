/*
 * 「没有」有很多种，它们**必须长得不一样**。
 *
 * 🔴 这是本平台的第一等公民，不是边角料：三条前提（端点部署、CLI 发版、registry 有制品）
 *    一条都没满足，所以上线之后**每个数字都会是 0，而且会持续一段时间**。
 *    这段时间里页面唯一的职责就是**说清是链路的哪一环还没通**。
 *
 * 🔴 **把不同的「没有」混成一句话，会让「服务挂了」看起来像「没人用」** ——
 *    那是这个平台能犯的最贵的错：它会让人据此下架一个其实很好用的 skill。
 *
 * 判定顺序是**从外到内**（Codex 2026-09-01 给的顺序，照抄）：
 *    数据源 → 响应合法性 → 有没有事件 → 维度有没有 → 筛选 → 抑制。
 *    倒过来判会把外层故障说成内层空 —— 例如端点 500 时说「当前筛选条件下没有行」。
 */

/** 数据源层的状态码。**每一个都有自己的文案**，见 SOURCE_COPY。 */
export const SOURCE = Object.freeze({
  /** 环境变量没配全（端点 URL / token 缺一）。上线前的默认状态。 */
  UNCONFIGURED: 'unconfigured',
  /** 连不上、超时、5xx。端点部署了但此刻不健康。 */
  UNREACHABLE: 'unreachable',
  /** 401/403：token 不对。或 404：`/v1/summary` 没开（服务端没配 summary token）。 */
  DENIED: 'denied',
  /** HTTP 200，但 body 不是合法 JSON / schema 对不上 / 类型不对。 */
  INVALID: 'invalid',
  /** 一切正常，拿到了合法 summary。 */
  OK: 'ok',
});

/**
 * 🔴 每一条都独立成句，**不许合并**。
 * 每条都回答同一个问题：「空的原因在链路的哪一环？」
 */
export const SOURCE_COPY = Object.freeze({
  [SOURCE.UNCONFIGURED]: {
    title: '汇总端点还没接上。',
    body: '这里是空的，因为 dashboard 没有数据源可读 —— 不是因为没人用。'
      + '本实例还没有配 GEOLY_SUMMARY_URL / GEOLY_TELEMETRY_SUMMARY_TOKEN，'
      + '一次请求都还没发出去过。',
    next: '配好这两个环境变量再来看；在那之前这一页说的每一句「0」都只是「我们还没问过」。',
  },
  [SOURCE.UNREACHABLE]: {
    title: '汇总端点不可用。',
    body: '端点配了，但这一次没拿到回答（连不上 / 超时 / 服务端 5xx）。'
      + '🔴 这**不是**「没人用」—— 我们根本没有读到数。',
    next: '先看端点自身是不是活着；它恢复之前，这一页不代表任何真实用量。',
  },
  [SOURCE.DENIED]: {
    title: '汇总端点拒绝了我们。',
    body: '端点在，但它不认这把 token（401/403），或者它压根没打开 /v1/summary（404）。'
      + '按规格 §5.3，读出面**默认关闭**：服务端没配 summary token 时这个路由不存在，'
      + '所以 404 的常见含义是「服务端那边忘了配」，不是「路径写错了」。',
    next: '对一遍两边的 token；服务端要设 GEOLY_TELEMETRY_SUMMARY_TOKEN 才会开这个路由。',
  },
  [SOURCE.INVALID]: {
    title: '端点回了 200，但内容不是我们认得的汇总。',
    body: '🔴 这一格**绝不当成 0**：能回 200 的东西太多了 —— 登录墙、代理错误页、'
      + '换了形状的新版接口。把它读成「零事件」就是把一次故障说成一个结论。',
    next: '看一眼端点这一版的响应形状；dashboard 只按白名单取字段，形状变了它会如实说不认得。',
  },
});

/** 维度层 / 行层的状态。数据源已经 OK 之后才可能出现。 */
export const VIEW = Object.freeze({
  /** 合法 summary，但 total === 0：真实的 0。 */
  NO_EVENTS: 'no-events',
  /** 有事件，但服务端这一版不返回这个维度的聚合。 */
  DIMENSION_MISSING: 'dimension-missing',
  /** 维度算了，但一行都没有（例如全部事件都没带 `artifact`）。**没有筛选器时是这一格。** */
  NO_ROWS: 'no-rows',
  /** 维度算了、也回了行，但**一行都没通过校验** —— 是数据质量问题，不是「空」。 */
  UNRECOGNIZED_ROWS: 'unrecognized-rows',
  /** 维度在、也有行，但**当前筛选条件**把它们全筛掉了。只有真的加了筛选才用。 */
  FILTERED_EMPTY: 'filtered-empty',
  /** 有候选行，但全部被小样本抑制掉了。 */
  SUPPRESSED: 'suppressed',
  /** 同上，但这张表还有一道**分位数门槛**（durations 专用）。 */
  SUPPRESSED_QUANTILE: 'suppressed-quantile',
  /** 有行可看。 */
  ROWS: 'rows',
});

export const VIEW_COPY = Object.freeze({
  [VIEW.NO_EVENTS]: {
    title: '端点通了，回来的是 0 条事件。',
    body: '这是**真实的 0**，不是故障，也不是筛没了 —— 我们问到了，答案就是「一条都没有」。'
      + '当前这个 0 是有解释的：CLI 还没发版、registry 里 0 个制品，所以没有人能装出一条 install 事件来。',
    next: '第一条事件会在第一个用户跑成功一次 install 之后出现（自动上报每台机器每天最多一次，规格 §5.1.1）。',
  },
  [VIEW.DIMENSION_MISSING]: {
    title: '这个维度服务端还没算。',
    body: '不是没数据，是 /v1/summary 这一版不返回这一项。'
      + '🔴 dashboard **不自己补算** —— 自己写一份聚合就会和 server/aggregate.mjs 分叉，'
      + '两边对同一个问题给出两个答案，那比没有这张表糟得多。',
    next: '需要的聚合列在页面底部「服务端待补的聚合」一节，加在服务端，这里自动就有了。',
  },
  [VIEW.NO_ROWS]: {
    title: '这个维度服务端算了，但一行都没有。',
    body: '有事件，服务端也返回了这个维度 —— 它就是空的。'
      + '最常见的原因是这批事件根本不带这个字段：'
      + '规格 §2 里 artifact / version / client / scope / ms / reason 都是**选填**，'
      + '例如 rollback / sync-lock 这类事件本来就没有 artifact。'
      + '⚠️ 这既不是故障，也不是「没人用」。',
    next: '想知道那批事件去哪了，看「按动作」那张表 —— 它是必填字段，一条都不会漏。',
  },
  [VIEW.UNRECOGNIZED_ROWS]: {
    title: '服务端回了行，但我们一行都不认得。',
    body: '这不是「空」，是**校验没过**：这个维度的每一行取值都没通过白名单校验，'
      + '于是全被丢掉了。两种可能 —— ① 服务端换了形状（比如键名或取值口径变了）；'
      + '② 有人往那个**无鉴权**的摄入端点里灌了脏数据（规格 §5.3 明示接受这一点，'
      + '所以 dashboard 这一侧照样逐值校验，不把攻击者控制的字符串渲染出去）。'
      + '⚠️ 千万不要读成「没人用」。',
    next: '对一遍这个维度的取值口径；脏数据的话，看服务端那一侧的校验为什么放它进来了。',
  },
  [VIEW.FILTERED_EMPTY]: {
    title: '当前筛选条件下没有行。',
    body: '有事件，这个维度服务端也算了、也有行 —— 只是**这一组筛选**把它们全筛掉了。'
      + '这一格与上面几种「没有」无关：数据在，条件太窄。',
    next: '放宽或清掉筛选条件就能看到。',
  },
  [VIEW.SUPPRESSED]: {
    title: '有行，但一行都发布不出来。',
    body: '这不是「没有数据」：候选行是存在的。它们没能发布出来有三种可能，'
      + '而且常常是混在一起的 —— 去重装机数没到门槛（样本太少）、'
      + '服务端根本没给去重装机数（无法核实门槛，按不达标处理）、'
      + '或者为了不让「只抑制一行」被减出来而被互补抑制连带拿掉。'
      + '⚠️ 不要把它读成「没人用」：那是上面「0 条事件」那一格才说的话。',
    next: '装机数长上去、或服务端补上 distinct installs 之后这张表自己会出现；'
      + '不提供「临时关掉抑制」的开关。',
  },
  [VIEW.SUPPRESSED_QUANTILE]: {
    title: '有行，但一行分位数都发布不出来。',
    body: '候选行是存在的。这张表比别的表多一道门槛：'
      + '除了去重装机数，还要求**样本事件数**足够 —— 分位数是顺序统计量，'
      + '样本少的时候 p95 就等于某一条原始耗时，发布它等于把一条原始记录印出来。'
      + '⚠️ 所以不要读成「装机数不够」：也可能是机器够多、但每台只装过一两次。'
      + '哪一行卡在哪一道门槛不公开 —— 那本身也是信息。',
    next: '样本量长上去之后这张表自己会出现。'
      + '想更早看到，正确的做法是让服务端在算分位数时就取整/分桶，而不是调低门槛。',
  },
});

/**
 * 把一次 fetch 的结局映射成 SOURCE。
 * ⚠️ **顺序有意义**：先判配置、再判传输、再判授权、最后才判内容。
 */
export function sourceStateOf({ configured, transportError, status, bodyOk }) {
  if (!configured) return SOURCE.UNCONFIGURED;
  if (transportError) return SOURCE.UNREACHABLE;
  if (status === 401 || status === 403 || status === 404) return SOURCE.DENIED;
  if (status >= 500 || status === 429 || status === 408) return SOURCE.UNREACHABLE;
  if (status !== 200) return SOURCE.INVALID;
  return bodyOk ? SOURCE.OK : SOURCE.INVALID;
}

/**
 * 一个维度块该显示哪一种「没有」。
 *
 * ⚠️ `filtered` 默认 **false**：页面上目前**没有筛选器**，所以「候选行为 0」
 *    只可能是「这个维度本来就是空的」，不可能是「筛没了」。
 *    上一版把它一律说成「当前筛选条件下没有行」——一句在当前页面里
 *    **不可能为真**的话（Codex 2026-09-01 指出）。将来真加了筛选器，
 *    把 `filtered` 传进来即可，那时两种说法都能成立、也仍然分得开。
 * ⚠️ `dropped` 是解析时被丢掉的行数：它把「一行都不认得」与「本来就是空的」分开。
 * ⚠️ `quantileGated` 只给 durations 用：它比别的表多一道分位数门槛，
 *    全被挡住时不能沿用「装机数长上去就会出现」那句话。
 */
export function viewStateOf({
  totalEvents, available, candidates, visible,
  filtered = false, quantileGated = false, dropped = 0,
}) {
  if (!(totalEvents > 0)) return VIEW.NO_EVENTS;
  if (!available) return VIEW.DIMENSION_MISSING;
  // 🔴 丢完剩 0 行 ≠ 服务端本来就是 0 行（Codex 2026-09-01 指出的旁路）。
  //    前者是「回来的东西我们一行都不认得」，后者是一个结论。
  if (!(candidates > 0) && dropped > 0) return VIEW.UNRECOGNIZED_ROWS;
  if (!(candidates > 0)) return filtered ? VIEW.FILTERED_EMPTY : VIEW.NO_ROWS;
  if (!(visible > 0)) return quantileGated ? VIEW.SUPPRESSED_QUANTILE : VIEW.SUPPRESSED;
  return VIEW.ROWS;
}
