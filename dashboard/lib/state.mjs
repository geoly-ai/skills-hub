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
 *
 * 🔴 文案是**纯文本**（DESIGN.md §5.4 / §9.2，以 design-preview.html 为准）：
 *    - 不带 emoji、不带 Markdown 的 `**` —— 告示条不做任何解析，写了就会原样上屏；
 *      强调交给告示条的色带与标题。
 *    - 故障态（这四条 + 下面的 UNRECOGNIZED_ROWS）里**不写阿拉伯数字的 0**，
 *      引用这个概念时写汉字「零」：扫一眼的人只看得见数字的形状，
 *      红底格子里的一个 0 会被当成这一格的值（§9.3）。
 *    - 抑制态（SUPPRESSED / SUPPRESSED_QUANTILE）里**一个阿拉伯数字都不写**（§10.2）。
 *    `test/state.test.mjs` 对这三条逐条断言。
 */
export const SOURCE_COPY = Object.freeze({
  [SOURCE.UNCONFIGURED]: {
    title: '汇总端点还没接上。',
    body: '这里空着是因为没地方读数，不是因为没人用。'
      + '这个实例还没配 GEOLY_SUMMARY_URL 和 GEOLY_TELEMETRY_SUMMARY_TOKEN，一次都还没问过。',
    next: '把这两个环境变量配上再来看。在那之前，这页上任何一个「零」都只是「还没问」。',
  },
  [SOURCE.UNREACHABLE]: {
    title: '汇总端点不可用。',
    body: '配是配了，这一次没拿到回答：连不上、超时，或者服务端自己报错。'
      + '这不是「没人用」—— 我们根本没读到数。',
    next: '先看端点自己还活着没有。它恢复之前，这一页不代表任何真实用量。',
  },
  [SOURCE.DENIED]: {
    title: '汇总端点拒绝了我们。',
    body: '端点在，但它不认我们这把 token（401/403），或者它根本没开 /v1/summary（404）。'
      + '读接口默认是关的：服务端没配 summary token，这条路由就不存在 —— '
      + '所以 404 多半是那边忘了配，不是我们地址写错了。',
    next: '两边的 token 对一遍。服务端要设了 GEOLY_TELEMETRY_SUMMARY_TOKEN，这条路由才会开。',
  },
  [SOURCE.INVALID]: {
    title: '回了 200，但回来的东西不是汇总。',
    body: '这一格绝不能当成零：会回 200 的东西太多了 —— 登录墙、代理的错误页、换了形状的新版接口。'
      + '把它读成「零事件」，就是把一次故障当成了结论。',
    next: '看一眼端点这一版返回的形状。我们只按白名单取字段，形状一变就照实说不认得，不去猜。',
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
    body: '真的是 0，不是故障，也不是被筛掉了 —— 我们问到了，答案就是「一条都没有」。'
      + '眼下这个 0 说得通：还没有人装出过一条会被上报的事件。',
    next: '等第一个用户装成功一次，第一条事件就来了（自动上报每台机器每天最多一条）。',
  },
  [VIEW.DIMENSION_MISSING]: {
    title: '这个维度服务端还没算。',
    body: '不是没数据，是 /v1/summary 这一版不返回这一项。'
      + '我们不在这里自己补算 —— 那等于写第二份聚合，它会和 server/aggregate.mjs 慢慢对不上，'
      + '同一个问题出两个答案，比这张表空着更糟。',
    next: '缺哪些聚合列在第 99 段。服务端补上，这里自己就有了。',
  },
  [VIEW.NO_ROWS]: {
    title: '服务端算了这个维度，但一行都没有。',
    body: '有事件，服务端也算了这个维度 —— 它就是空的。最常见的原因是这批事件本来就不带这个字段：'
      + 'artifact / version / client / scope / ms / reason 都是选填，'
      + '比如 rollback / sync-lock 这类事件本来就没有 artifact。这不是故障，也不是「没人用」。',
    next: '想知道那批事件去哪了，看「按动作」那张表 —— 那个字段是必填的，一条都不会漏。',
  },
  [VIEW.UNRECOGNIZED_ROWS]: {
    title: '服务端回了行，但我们一行都不认得。',
    body: '不是空，是校验没过：这个维度里每一行的取值我们都没认出来，于是全被丢掉了。'
      + '两种可能 —— 服务端换了形状；或者有人往那个不需要鉴权的上报端点灌了脏数据。'
      + '顶栏不会因此变红：端点本身是通的，坏的是这一张表。千万别读成「没人用」。',
    next: '对一遍这个维度该有哪些取值；如果是脏数据，去看服务端那边的校验为什么放它进来了。',
  },
  [VIEW.FILTERED_EMPTY]: {
    title: '当前筛选条件下没有行。',
    body: '有事件，这个维度也算了、也有行 —— 只是当前这组筛选条件把它们全筛掉了。',
    next: '放宽或者清掉筛选条件就能看到。',
  },
  [VIEW.SUPPRESSED]: {
    title: '有数，但一行都发不出来。',
    body: '不是没有数据：行是存在的，只是发不出来。三种原因常常混在一起 —— '
      + '装了它的机器太少、服务端根本没告诉我们有几台（不知道就按不够处理）、'
      + '或者只藏一行会被人倒推出来，所以把另一行也一起收掉了。'
      + '别读成「没人用」：那句话只有「端点通了、一条都没有」那一格才配说。',
    next: '装的机器多起来，或者服务端补上台数，这张表自己就出来了。没有开关能临时把它放出来。',
  },
  [VIEW.SUPPRESSED_QUANTILE]: {
    title: '有数，但一行分位数都发不出来。',
    body: '这张表比别的表多一道门槛：除了机器台数，还要求事件条数够 —— '
      + '样本一少，分位数就正好等于某一条真实耗时。'
      + '所以别读成「机器不够」：也可能机器够多，只是每台才装过一两次。'
      + '哪一行卡在哪一道门槛不写出来，那本身也是信息。',
    next: '样本多起来这张表自己就出来了。想更早看到，正确做法是让服务端算分位数时就取整或分桶，而不是调低门槛。',
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
