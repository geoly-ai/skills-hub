/*
 * 小样本抑制 —— 这个平台不变成再识别工具的第三道（前两道见 whitelist.mjs）。
 *
 * 🔴 **要挡的是什么**：即使界面上一个 install_id 都不出现，
 *    一行「`skill:geoly/foo@1.2.0` · client=cursor · os=linux · 1 台机器」
 *    本身就是识别信息 —— 它说的是「有且仅有一台特定配置的机器装了这个」。
 *    规格 §6 T-11 的风险不需要下钻界面就能成立，聚合值窄到极致时它自己就是轨迹。
 *
 * 🔴 **判据是去重装机数（distinct install_id），不是事件数。**
 *    一台机器可以在一天里制造几十条事件，用 `n` 当样本量是把 1 台读成 40 台。
 *    服务端必须给出 distinct installs；给不出就按「无法核实」处理（见下）。
 */

/**
 * 阈值 K。低于它的细分不展示明细。
 *
 * 为什么是 5：这是「小样本抑制」在统计披露控制里的惯用起点，
 * 也和任务书给的建议值一致。它不是一个被证明过的安全边界 ——
 * 它是**一个必须被显式选择的数**，写在这里是为了让改它的人知道自己在改什么。
 * ⚠️ 调低它要过评审：K=2 时「两台机器」和「一台机器」的区分度并不比 1 强多少。
 */
export const MIN_INSTALLS = 5;

/** 一行的抑制归类。 */
export const CAUSE = Object.freeze({
  /** 服务端给了数，但 < K。「样本太少」。 */
  SMALL: 'small',
  /** 服务端**没给** distinct installs（或给了非法值）。「无法核实门槛」。 */
  UNVERIFIABLE: 'unverifiable',
  /** 为了不让「只抑制了一行」被减出来，额外拉进来的一行。见下面的互补抑制。 */
  COMPLEMENTARY: 'complementary',
});

/**
 * 🔴 **`installs` 缺失 = 不达标（fail-closed）**，不是「先展示着，以后再说」。
 *
 * 这一条的直接后果要写在明处：**服务端补上 distinct installs 之前，
 * 所有细分表都会整表走「无法核实」这条路，页面上只剩总数。**
 * 这是有意的 —— 反过来（缺 installs 就当达标）等于把抑制器关掉，
 * 而它恰恰在数据最少、最容易被识别的那段时间里最需要开着。
 *
 * ⚠️ 文案上「无法核实」与「样本太少」**必须分开**（Codex 2026-09-01 指出）：
 *    把未知说成「太少」是在断言一件我们并不知道的事，
 *    读的人会以为「服务端算过了，就是没人用」。
 */
function classify(row) {
  const v = row?.installs;
  if (!Number.isInteger(v) || v < 0) return CAUSE.UNVERIFIABLE;
  return v >= MIN_INSTALLS ? null : CAUSE.SMALL;
}

const eventsOf = (row) => (Number.isInteger(row?.events) && row.events >= 0 ? row.events : 0);

/**
 * 对一组细分行做抑制。
 *
 * @param {Array<{key:string, events:number, installs?:number}>} rows
 * @returns {{
 *   visible: Array<object>,
 *   suppressed: { rows: number, small: number, unverifiable: number, complementary: number },
 *   tableSuppressed: boolean,
 * }}
 *
 * 🔴 **返回值里没有「被抑制那一组的事件合计」，是故意的。**
 *    初稿返回过它（本意是透明），但**任何精确的合计都是一个减法锚点**：
 *    首页同时发布 byArtifact / byClient / byOs 等好几张对同一批事件的不同切法，
 *    有了精确合计，配合一点外部知识就能跨表相减把某一行还原出来
 *    （Codex 2026-09-01 判为 P0）。所以：
 *      · 被抑制的组只报**行数**，不报事件合计；
 *      · 每张表也**不发布自己的总计行**。
 *    ⚠️ **这不是一个硬保证**，只是把最便宜的那条路堵掉 ——
 *    真正闭合要对「整套固定发布的表」做联合抑制/可解性校验，那要在服务端做。
 *    残余风险写在 README 与页面上，不假装它不存在。
 *
 * 🔴 **互补抑制**（complementary suppression，Codex 2026-09-01 挡下的一条）：
 *    如果只有**一行**被抑制，那么
 *        被抑制那行的事件数 = 表内总数 − 所有可见行之和
 *    这一减就把它还原了，抑制等于没做。所以恰好抑制一行时，
 *    **再把事件数最小的那一个可见行也抑制掉**，让被抑制的那一组至少有两行 ——
 *    两行以后就只剩「它们的和」，拆不开了。
 *    ⚠️ 挑「最小的那一行」是因为它信息量最低；挑最大的会让表的主结论也消失。
 */
export function suppressRows(rows) {
  const all = Array.isArray(rows) ? rows.slice() : [];
  const causes = new Map();
  for (const r of all) {
    const c = classify(r);
    if (c) causes.set(r, c);
  }

  let visible = all.filter((r) => !causes.has(r));

  // 互补抑制：被抑制的只有一行时，把最小的可见行也拉进来
  if (causes.size === 1 && visible.length > 0) {
    const victim = visible.reduce((a, b) => (eventsOf(b) < eventsOf(a) ? b : a));
    causes.set(victim, CAUSE.COMPLEMENTARY);
    visible = visible.filter((r) => r !== victim);
  }

  const tally = { rows: 0, small: 0, unverifiable: 0, complementary: 0 };
  for (const cause of causes.values()) {
    tally.rows += 1;
    tally[cause] += 1;
  }

  // 一行都没剩下时，整表按「被抑制」渲染 —— 画一张只有一条「样本太少」的空表
  // 比一句话更难读，也更容易被当成「加载失败」。
  const tableSuppressed = visible.length === 0 && tally.rows > 0;

  return { visible, suppressed: tally, tableSuppressed };
}

/**
 * 全局装机数怎么显示。
 *
 * 全局标量是**所有维度的并集**，K 对它没有「哪一个组合只有一台」的含义，
 * 所以不整体隐藏。但 `installs < K` 时精确值本身还是信息
 * （「全世界只有 2 台机器装过」），所以压成 `<5`。
 *
 * 🔴 缺失**不当成 `<5`，更不当成 0**（Codex 2026-09-01 指出）：
 *    那是把「不知道」说成「知道且很小」。
 */
export function formatInstalls(v) {
  if (!Number.isInteger(v) || v < 0) return { kind: 'unknown', text: '未提供' };
  if (v < MIN_INSTALLS) return { kind: 'floored', text: `<${MIN_INSTALLS}` };
  return { kind: 'exact', text: String(v) };
}
